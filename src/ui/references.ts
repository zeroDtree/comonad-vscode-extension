// SPDX-License-Identifier: AGPL-3.0-only
import { relative, sep } from 'node:path';
import { stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
	findSymbolRange,
	formatReference,
	looksLikePath,
	parseReferences,
	rankPaths,
	type ParsedReference,
	type SymbolLike,
} from '../lib/references';
import { guardPath, isDeniedRead, isInside } from '../lib/sandbox';
import type { Confinement, SessionPolicy } from '../lib/types';

/**
 * Explicit references for the chat: resolve `@` tokens from a prompt into a bounded Context block,
 * and answer the composer's mention queries. The token grammar lives in `lib/references`; this module
 * is the only place that touches the workspace, the sandbox and VS Code's symbol providers.
 */

export interface ReferenceScope {
	workingDirectory: string;
	confinement: Confinement;
	denyReadPaths: readonly string[];
}

export interface MentionItem {
	kind: 'file' | 'folder' | 'symbol' | 'selection';
	label: string;
	description: string;
	/** The exact text inserted into the composer. */
	token: string;
}

export interface MentionAnswer {
	items: MentionItem[];
	hint?: string;
}

export const REFERENCE_LIMITS = {
	perReference: 20_000,
	total: 60_000,
	references: 20,
	folderEntries: 200,
	mentionItems: 25,
	maxReadBytes: 2_000_000,
	queryChars: 256,
} as const;

const IGNORED = new Set(['node_modules', '.git', 'bower_components', '.next', 'dist', 'out', 'build', 'vendor']);

export function scopeOf(policy: Pick<SessionPolicy, 'workingDirectory' | 'confinement' | 'denyReadPaths'>): ReferenceScope {
	return {
		workingDirectory: policy.workingDirectory,
		confinement: policy.confinement,
		denyReadPaths: policy.denyReadPaths,
	};
}

/** Turn every `@` reference in the prompt into a Context block; `undefined` when there is none. */
export async function resolveReferences(text: string, scope: ReferenceScope): Promise<string | undefined> {
	if (!scope.workingDirectory.trim()) {
		return undefined;
	}
	const references = parseReferences(text);
	if (references.length === 0) {
		return undefined;
	}
	const blocks: string[] = [];
	const seen = new Set<string>();
	let total = 0;
	for (const reference of references) {
		const key = `${reference.kind}|${reference.path}|${reference.lines?.start ?? ''}-${reference.lines?.end ?? ''}|${reference.name ?? ''}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		if (blocks.length >= REFERENCE_LIMITS.references || total >= REFERENCE_LIMITS.total) {
			blocks.push(`<reference token="${escapeAttribute(formatReference(reference))}" error="omitted: reference budget reached"/>`);
			continue;
		}
		try {
			const file = await guardPath(scope.workingDirectory, reference.path, {
				access: 'read',
				confinement: scope.confinement,
				denyReadPaths: scope.denyReadPaths,
			});
			const block =
				reference.kind === 'folder'
					? await folderBlock(file, reference.path, scope)
					: reference.kind === 'symbol'
						? await symbolBlock(file, reference.path, reference)
						: await fileBlock(file, reference.path, reference);
			total += block.length;
			blocks.push(block);
		} catch (error) {
			if (!looksLikePath(reference)) {
				continue;
			}
			const block = `<reference token="${escapeAttribute(formatReference(reference))}" error="${escapeAttribute(describeError(error))}"/>`;
			total += block.length;
			blocks.push(block);
		}
	}
	return blocks.length ? `Explicit references from the user:\n${blocks.join('\n')}` : undefined;
}

/** The pure part of the picker: rank files or derive/rank folders from relative file paths. */
export function mentionItems(kind: 'file' | 'folder', query: string, paths: readonly string[]): MentionItem[] {
	if (kind === 'file') {
		return rankPaths(query, paths, REFERENCE_LIMITS.mentionItems).map((path) => ({
			kind: 'file',
			label: path.split('/').pop() ?? path,
			description: parentOf(path),
			token: formatReference({ kind: 'file', path }),
		}));
	}
	const folders = new Set<string>();
	for (const path of paths) {
		const parts = path.split('/');
		for (let index = 1; index < parts.length; index += 1) {
			folders.add(parts.slice(0, index).join('/'));
		}
	}
	return rankPaths(query, [...folders], REFERENCE_LIMITS.mentionItems).map((path) => ({
		kind: 'folder',
		label: path.split('/').pop() ?? path,
		description: parentOf(path),
		token: formatReference({ kind: 'folder', path }),
	}));
}

/** The current editor selection as a range token, when it belongs to this workspace. */
export function selectionItem(editor: vscode.TextEditor | undefined, scope: ReferenceScope): MentionItem | undefined {
	if (!editor || !scope.workingDirectory || editor.document.uri.scheme !== 'file') {
		return undefined;
	}
	const selection = editor.selection;
	if (!selection || selection.isEmpty) {
		return undefined;
	}
	const absolute = editor.document.uri.fsPath;
	if (!isInside(scope.workingDirectory, absolute) || isDeniedRead(scope.workingDirectory, absolute, scope.denyReadPaths)) {
		return undefined;
	}
	const path = relativePath(scope.workingDirectory, absolute);
	if (!path) {
		return undefined;
	}
	const start = selection.start.line + 1;
	let end = selection.end.line + 1;
	if (selection.end.character === 0 && selection.end.line > selection.start.line) {
		end -= 1;
	}
	if (end < start) {
		return undefined;
	}
	return {
		kind: 'selection',
		label: path.split('/').pop() ?? path,
		description: `${path}:${start}${end === start ? '' : `-${end}`}`,
		token: formatReference({ kind: 'file', path, lines: { start, end } }),
	};
}

/** Answer one mention query. Every failure becomes a hint; the picker never rejects. */
export async function mentionResults(
	kind: 'file' | 'folder' | 'symbol' | 'selection',
	query: string,
	scope: ReferenceScope,
	files: WorkspaceFileCache,
): Promise<MentionAnswer> {
	const needle = query.slice(0, REFERENCE_LIMITS.queryChars).trim();
	if (!scope.workingDirectory) {
		return { items: [], hint: 'This chat has no working directory.' };
	}
	if (kind === 'selection') {
		const item = selectionItem(vscode.window.activeTextEditor, scope);
		return item ? { items: [item] } : { items: [], hint: 'Select code in the editor first.' };
	}
	if (kind === 'symbol') {
		if (!needle) {
			return { items: [], hint: 'Type to search symbols' };
		}
		try {
			const infos = await withTimeout(
				vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', needle),
				1_500,
			);
			if (!infos) {
				return { items: [], hint: 'Symbol search is not available here.' };
			}
			const items: MentionItem[] = [];
			const seen = new Set<string>();
			for (const info of infos) {
				if (info.location.uri.scheme !== 'file') {
					continue;
				}
				const absolute = info.location.uri.fsPath;
				if (!isInside(scope.workingDirectory, absolute) || isDeniedRead(scope.workingDirectory, absolute, scope.denyReadPaths)) {
					continue;
				}
				const path = relativePath(scope.workingDirectory, absolute);
				const name = info.containerName ? `${info.containerName}.${info.name}` : info.name;
				if (!path || /\s|"/.test(name)) {
					continue;
				}
				const token = formatReference({ kind: 'symbol', path, name });
				if (seen.has(token)) {
					continue;
				}
				seen.add(token);
				items.push({
					kind: 'symbol',
					label: info.name,
					description: `${vscode.SymbolKind[info.kind] || 'Symbol'} · ${path}:${info.location.range.start.line + 1}`,
					token,
				});
				if (items.length >= REFERENCE_LIMITS.mentionItems) {
					break;
				}
			}
			return { items };
		} catch {
			return { items: [], hint: 'Symbol search failed.' };
		}
	}
	try {
		return { items: mentionItems(kind, needle, await files.list(scope)) };
	} catch {
		return { items: [], hint: 'Could not list workspace files.' };
	}
}

/** A per-working-directory file list for the picker, with a short TTL and one load in flight. */
export class WorkspaceFileCache {
	private cached: { root: string; at: number; files: string[] } | undefined;
	private loading: { root: string; promise: Promise<string[]> } | undefined;

	async list(scope: ReferenceScope): Promise<string[]> {
		const root = scope.workingDirectory;
		if (!root) {
			return [];
		}
		const now = Date.now();
		if (this.cached?.root === root && now - this.cached.at < 30_000) {
			return this.cached.files;
		}
		if (this.loading?.root === root) {
			return this.loading.promise;
		}
		const promise = this.load(root, scope);
		this.loading = { root, promise };
		void promise
			.finally(() => {
				if (this.loading?.promise === promise) {
					this.loading = undefined;
				}
			})
			.catch(() => undefined);
		return promise;
	}

	clear(): void {
		this.cached = undefined;
	}

	private async load(root: string, scope: ReferenceScope): Promise<string[]> {
		const pattern = new vscode.RelativePattern(vscode.Uri.file(root), '**/*');
		const uris = await vscode.workspace.findFiles(
			pattern,
			'**/{node_modules,.git,bower_components,.next,dist,out,build,vendor}/**',
			5_000,
		);
		const files = uris
			.filter((uri) => uri.scheme === 'file' && isInside(root, uri.fsPath) && !isDeniedRead(root, uri.fsPath, scope.denyReadPaths))
			.map((uri) => relativePath(root, uri.fsPath))
			.filter((path): path is string => Boolean(path))
			.sort((left, right) => left.localeCompare(right));
		this.cached = { root, at: Date.now(), files };
		return files;
	}
}

async function fileBlock(absolute: string, displayPath: string, reference: ParsedReference): Promise<string> {
	const info = await stat(absolute);
	if (info.isDirectory()) {
		throw new Error('it is a folder; add a trailing / to reference the folder');
	}
	if (info.size > REFERENCE_LIMITS.maxReadBytes) {
		throw new Error(`it is larger than ${Math.round(REFERENCE_LIMITS.maxReadBytes / 1_000_000)} MB`);
	}
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
	const head = document.getText().slice(0, 8_192);
	if (head.includes('\u0000')) {
		throw new Error('it is not a text file');
	}
	const start = reference.lines?.start ?? 1;
	if (start > document.lineCount) {
		throw new Error(`line ${start} is past the end (${document.lineCount} lines)`);
	}
	const end = Math.min(reference.lines?.end ?? document.lineCount, document.lineCount);
	if (end < start) {
		throw new Error('the line range is empty');
	}
	const lines: string[] = [];
	for (let line = start; line <= end; line += 1) {
		lines.push(document.lineAt(line - 1).text);
	}
	const linesAttribute = reference.lines ? ` lines="${start}${end === start ? '' : `-${end}`}"` : '';
	return `<file path="${escapeAttribute(displayPath)}"${linesAttribute}>\n${clip(numbered(lines, start))}\n</file>`;
}

async function folderBlock(absolute: string, displayPath: string, scope: ReferenceScope): Promise<string> {
	const info = await stat(absolute);
	if (!info.isDirectory()) {
		throw new Error('not a folder');
	}
	const entries: string[] = [];
	let omitted = 0;
	const walk = async (directory: vscode.Uri, prefix: string): Promise<void> => {
		const children = await vscode.workspace.fs.readDirectory(directory);
		children.sort((left, right) => left[0].localeCompare(right[0]));
		for (const [name, type] of children) {
			if (IGNORED.has(name)) {
				continue;
			}
			const child = vscode.Uri.joinPath(directory, name);
			const path = prefix ? `${prefix}/${name}` : name;
			if (isDeniedRead(scope.workingDirectory, child.fsPath, scope.denyReadPaths)) {
				continue;
			}
			if (type & vscode.FileType.SymbolicLink) {
				continue;
			}
			if (entries.length >= REFERENCE_LIMITS.folderEntries) {
				omitted += 1;
				continue;
			}
			if (type & vscode.FileType.Directory) {
				entries.push(`${path}/`);
				await walk(child, path);
			} else if (type & vscode.FileType.File) {
				entries.push(path);
			}
		}
	};
	await walk(vscode.Uri.file(absolute), '');
	const body = entries.length ? entries.join('\n') : '(empty)';
	const more = omitted ? `\n[+${omitted} more]` : '';
	return `<folder path="${escapeAttribute(displayPath)}">\n${clip(body)}${more}\n</folder>`;
}

async function symbolBlock(absolute: string, displayPath: string, reference: ParsedReference): Promise<string> {
	const uri = vscode.Uri.file(absolute);
	const document = await vscode.workspace.openTextDocument(uri);
	if (document.getText().slice(0, 8_192).includes('\u0000')) {
		throw new Error('it is not a text file');
	}
	const range = await symbolRange(uri, reference.name ?? '');
	if (!range) {
		throw new Error(`symbol ${reference.name ?? ''} was not found`);
	}
	const start = range.start.line + 1;
	let end = range.end.line + 1;
	if (range.end.character === 0 && range.end.line > range.start.line) {
		end -= 1;
	}
	end = Math.min(end, document.lineCount);
	const lines: string[] = [];
	for (let line = start; line <= end; line += 1) {
		lines.push(document.lineAt(line - 1).text);
	}
	return `<symbol name="${escapeAttribute(reference.name ?? '')}" path="${escapeAttribute(displayPath)}" lines="${start}${end === start ? '' : `-${end}`}">\n${clip(numbered(lines, start))}\n</symbol>`;
}

async function symbolRange(uri: vscode.Uri, name: string): Promise<vscode.Range | undefined> {
	const symbols = await withTimeout(
		vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri),
		3_000,
	);
	if (symbols?.length) {
		const found = findSymbolRange(symbols as unknown as SymbolLike[], name);
		if (found) {
			return new vscode.Range(found.start.line, found.start.character, found.end.line, found.end.character);
		}
	}
	const infos = await withTimeout(
		vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name),
		3_000,
	);
	if (!infos) {
		return undefined;
	}
	const leaf = name.split('.').pop() ?? name;
	const match = infos.find(
		(info) =>
			info.location.uri.fsPath === uri.fsPath &&
			(info.name === leaf || (info.containerName ? `${info.containerName}.${info.name}` : info.name) === name),
	);
	return match?.location.range;
}

function withTimeout<T>(value: Thenable<T> | undefined, milliseconds: number): Promise<T | undefined> {
	if (!value) {
		return Promise.resolve(undefined);
	}
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), milliseconds);
	});
	return Promise.race([Promise.resolve(value), timeout]).finally(() => {
		if (timer) {
			clearTimeout(timer);
		}
	});
}

function numbered(lines: readonly string[], start: number): string {
	return lines.map((line, index) => `${start + index}\t${line}`).join('\n');
}

function clip(text: string): string {
	if (text.length <= REFERENCE_LIMITS.perReference) {
		return text;
	}
	return `${text.slice(0, REFERENCE_LIMITS.perReference)}\n[... truncated, ${text.length - REFERENCE_LIMITS.perReference} chars]`;
}

function relativePath(root: string, file: string): string | undefined {
	const path = relative(root, file).split(sep).join('/');
	return !path || path.startsWith('../') || path === '..' ? undefined : path;
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? 'workspace root' : path.slice(0, slash);
}

function escapeAttribute(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
