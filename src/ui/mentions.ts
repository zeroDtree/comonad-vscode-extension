// SPDX-License-Identifier: AGPL-3.0-only
import { relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { formatReference, rankPaths } from '../lib/references';
import { isDeniedRead, isInside } from '../lib/sandbox';
import { REFERENCE_LIMITS, type ReferenceScope } from '../services/references';

/**
 * The composer's mention picker: file and folder ranking, VS Code symbol search, and the current
 * editor selection. Resolution itself lives in `ctx.references`; this module only builds tokens.
 */

export interface MentionItem {
	kind: 'file' | 'folder' | 'symbol' | 'selection';
	label: string;
	description: string;
	/** The exact text inserted into the composer. */
	token: string;
	/** What the UI may show beside the label; the file picker already lists every type. */
	badge?: 'image' | 'pdf' | 'text';
}

export interface MentionAnswer {
	items: MentionItem[];
	hint?: string;
}

/** The pure part of the picker: rank files or derive/rank folders from relative file paths. */
export function mentionItems(kind: 'file' | 'folder', query: string, paths: readonly string[]): MentionItem[] {
	if (kind === 'file') {
		return rankPaths(query, paths, REFERENCE_LIMITS.mentionItems).map((path) => ({
			kind: 'file',
			label: path.split('/').pop() ?? path,
			description: parentOf(path),
			token: formatReference({ kind: 'file', path }),
			badge: badgeOf(path),
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
		token: formatReference({ kind: 'file', path, range: { start, end } }),
		badge: badgeOf(path),
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
					badge: badgeOf(path),
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

function badgeOf(path: string): MentionItem['badge'] {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
		return 'image';
	}
	if (ext === 'pdf') {
		return 'pdf';
	}
	return 'text';
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

function relativePath(root: string, file: string): string | undefined {
	const path = relative(root, file).split(sep).join('/');
	return !path || path.startsWith('../') || path === '..' ? undefined : path;
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? 'workspace root' : path.slice(0, slash);
}
