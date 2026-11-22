// SPDX-License-Identifier: AGPL-3.0-only
import { relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { formatReference, pathEntry, rankEntries, type PathEntry } from '../lib/references';
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

/** The picker's prebuilt list: folded file entries, derived folders, and whether it was capped. */
export interface MentionIndex {
	files: PathEntry[];
	folders: PathEntry[];
	truncated: boolean;
}

const EMPTY_INDEX: MentionIndex = { files: [], folders: [], truncated: false };

/** Folders a mention list excludes; the same names filter the watcher, so the two cannot drift. */
const EXCLUDED_DIRS = ['node_modules', '.git', 'bower_components', '.next', 'dist', 'out', 'build', 'vendor'] as const;
const EXCLUDED_GLOB = `**/{${EXCLUDED_DIRS.join(',')}}/**`;
const EXCLUDED_PATH = new RegExp(`(^|/)(?:${EXCLUDED_DIRS.map(escapeRegExp).join('|')})(/|$)`);

/**
 * The pure part of the picker: rank files, or rank the folders derived from them. A
 * `MentionIndex` carries the lists prebuilt by the cache; a plain array is the cheap form the
 * tests and one-off callers use.
 */
export function mentionItems(
	kind: 'file' | 'folder',
	query: string,
	source: readonly string[] | MentionIndex,
): MentionItem[] {
	const entries = isPathList(source)
		? (kind === 'file' ? source : foldersOf(source)).map(pathEntry)
		: kind === 'file'
			? source.files
			: source.folders;
	return rankEntries(query, entries, REFERENCE_LIMITS.mentionItems).map((entry) =>
		kind === 'file' ? fileItem(entry.path) : folderItem(entry.path),
	);
}

/** A plain path list is the legacy form; the index is an object. */
function isPathList(source: readonly string[] | MentionIndex): source is readonly string[] {
	return Array.isArray(source);
}

/** All ancestor folders of a path list, sorted; computed once per index build, not per keystroke. */
export function foldersOf(paths: readonly string[]): string[] {
	const folders = new Set<string>();
	for (const path of paths) {
		const parts = path.split('/');
		for (let index = 1; index < parts.length; index += 1) {
			folders.add(parts.slice(0, index).join('/'));
		}
	}
	return [...folders].sort((left, right) => left.localeCompare(right));
}

function fileItem(path: string): MentionItem {
	return {
		kind: 'file',
		label: path.split('/').pop() ?? path,
		description: parentOf(path),
		token: formatReference({ kind: 'file', path }),
		badge: badgeOf(path),
	};
}

function folderItem(path: string): MentionItem {
	return {
		kind: 'folder',
		label: path.split('/').pop() ?? path,
		description: parentOf(path),
		token: formatReference({ kind: 'folder', path }),
	};
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
		const index = await files.index(scope);
		const items = mentionItems(kind, needle, index);
		const hint =
			!items.length && index.truncated
				? `Only the first ${REFERENCE_LIMITS.indexFiles.toLocaleString()} files are indexed — add a path segment to narrow it.`
				: undefined;
		return { items, hint };
	} catch {
		return { items: [], hint: 'Could not list workspace files.' };
	}
}

/**
 * A per-working-directory file list for the picker, with a short TTL, one load in flight, and a
 * watcher that drops the list when a file appears or disappears. Rebuilt lists carry folded
 * entries and pinyin, so a keystroke only ranks.
 */
export class WorkspaceFileCache implements vscode.Disposable {
	private cached: { root: string; at: number; index: MentionIndex } | undefined;
	private loading: { root: string; generation: number; promise: Promise<MentionIndex> } | undefined;
	/** Bumped by `clear()`; a load that started under an older value never writes the cache. */
	private generation = 0;
	private watcher: vscode.FileSystemWatcher | undefined;
	private watcherRoot: string | undefined;
	private timer: NodeJS.Timeout | undefined;
	private disposed = false;

	async index(scope: ReferenceScope): Promise<MentionIndex> {
		const root = scope.workingDirectory;
		if (!root || this.disposed) {
			return EMPTY_INDEX;
		}
		const now = Date.now();
		if (this.cached?.root === root && now - this.cached.at < 30_000) {
			return this.cached.index;
		}
		const generation = this.generation;
		if (this.loading?.root === root && this.loading.generation === generation) {
			return this.loading.promise;
		}
		const promise = this.load(root, scope).then((index) => {
			if (!this.disposed && this.generation === generation) {
				this.cached = { root, at: Date.now(), index };
				try {
					this.watch(root);
				} catch {
					// A watcher is best-effort; the 30 s TTL still refreshes a root it cannot watch.
				}
			}
			return index;
		});
		this.loading = { root, generation, promise };
		void promise
			.finally(() => {
				if (this.loading?.promise === promise) {
					this.loading = undefined;
				}
			})
			.catch(() => undefined);
		return promise;
	}

	/** The path list on its own, for callers that do not need the folded form or pinyin. */
	async list(scope: ReferenceScope): Promise<string[]> {
		return (await this.index(scope)).files.map((entry) => entry.path);
	}

	clear(): void {
		this.generation += 1;
		this.cached = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.clear();
		clearTimeout(this.timer);
		this.timer = undefined;
		this.watcher?.dispose();
		this.watcher = undefined;
		this.watcherRoot = undefined;
	}

	private async load(root: string, scope: ReferenceScope): Promise<MentionIndex> {
		const cap = REFERENCE_LIMITS.indexFiles;
		const pattern = new vscode.RelativePattern(vscode.Uri.file(root), '**/*');
		// One past the cap tells a full list from a truncated one without counting twice.
		const uris = await vscode.workspace.findFiles(pattern, EXCLUDED_GLOB, cap + 1);
		const truncated = uris.length > cap;
		const seen = new Set<string>();
		const files: string[] = [];
		const add = (uri: vscode.Uri): void => {
			if (uri.scheme !== 'file' || !isInside(root, uri.fsPath) || isDeniedRead(root, uri.fsPath, scope.denyReadPaths)) {
				return;
			}
			const path = relativePath(root, uri.fsPath);
			if (path && !seen.has(path)) {
				seen.add(path);
				files.push(path);
			}
		};
		// An open editor is always referenceable, even when the index hit its cap or the file is
		// younger than the next watcher event.
		for (const document of vscode.workspace.textDocuments) {
			add(document.uri);
		}
		for (const uri of truncated ? uris.slice(0, cap) : uris) {
			add(uri);
		}
		files.sort((left, right) => left.localeCompare(right));
		return {
			files: files.map((path) => pathEntry(path)),
			folders: foldersOf(files).map((path) => pathEntry(path)),
			truncated,
		};
	}

	/** Watch the folders the index covers; a name change makes the next query rebuild it. */
	private watch(root: string): void {
		if (this.disposed || this.watcherRoot === root) {
			return;
		}
		this.watcher?.dispose();
		clearTimeout(this.timer);
		this.timer = undefined;
		this.watcherRoot = root;
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(root), '**/*'),
			false,
			true,
			false,
		);
		const changed = (uri: vscode.Uri): void => {
			const path = relativePath(root, uri.fsPath);
			if (!path || EXCLUDED_PATH.test(path)) {
				return;
			}
			clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				this.clear();
			}, 1_000);
		};
		watcher.onDidCreate(changed);
		watcher.onDidDelete(changed);
		this.watcher = watcher;
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

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
