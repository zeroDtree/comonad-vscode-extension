import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Service, type Context } from 'cordis';

/**
 * Per-file edit journal. Comonad never snapshots the workspace: every write the agent makes goes
 * through `ToolContext.edit`, which stores the file's content before and after the change.
 *
 * Storage: one shadow git repository per session and workspace, outside the project (`GIT_DIR`). It
 * only holds blobs (file contents) and a temporary index for diffs; it never commits, and the user's
 * own `.git` is never touched. `journal.json` lists the writes in order. Nothing is pruned.
 *
 * Accepting a file (Keep) or undoing it sets `accepted` on its latest entry. Entries are never
 * removed, except by a rewind, so the positions stored in rewind points stay valid.
 */

/** A file's content at one moment: a blob hash, or `null` when the file did not exist. */
export type Blob = string | null;

export interface JournalEntry {
	/** Workspace-relative path with forward slashes. */
	path: string;
	/** The turn that made the write. */
	turn: number;
	/** Content before the first write of this path in the turn. */
	before: Blob;
	/** Content after the latest write of this path in the turn. */
	after: Blob;
	at: number;
	/** The user accepted the file or undid it: entries before this one no longer count. */
	accepted?: boolean;
}

export interface JournalHunk {
	header: string;
	lines: { type: 'add' | 'del' | 'ctx'; text: string }[];
}

export interface JournalFile {
	path: string;
	additions: number;
	deletions: number;
	/** The agent created the file. */
	created: boolean;
	/** The file is gone from disk, though it had content before the agent's writes. */
	deleted: boolean;
	/** The disk no longer matches what the agent last wrote: the user changed it since. */
	changedOutside: boolean;
	/** Unsaved in an editor. Undo and revert refuse until it is saved. */
	dirty: boolean;
	hunks: JournalHunk[];
}

export interface Pending {
	available: boolean;
	files: JournalFile[];
}

export interface RevertReport {
	restored: string[];
	skipped: string[];
}

/** How to treat files changed outside the agent: `'all'`, or the named ones. Anything else refuses. */
export type Overwrite = 'all' | string[];

/** Unsaved editor text would be overwritten. Nothing was written. */
export class DirtyEditorError extends Error {
	constructor(readonly paths: string[]) {
		super(`Save these files in the editor first: ${paths.join(', ')}`);
	}
}

/** Files changed outside the agent would be overwritten. Nothing was written. */
export class ChangedOutsideError extends Error {
	constructor(readonly paths: string[]) {
		super(`Changed outside the agent since it last wrote them: ${paths.join(', ')}`);
	}
}

/**
 * What the rest of the extension asks of the journal — the seam a feature plugin fills.
 *
 * The agent, the chat panel and the workspace watcher treat this as *optional*: they look it up with
 * `ctx.get('checkpoints')` rather than injecting it, so turning the row off leaves a working extension
 * that simply records nothing. The review webview is the journal's own surface and injects it, so it
 * follows the feature in and out on its own.
 */
export interface JournalApi {
	/** Records one write: `before` is kept for the first write of a path in a turn, `after` moves. */
	record(workspace: string, sessionId: string, turn: number, path: string, before: Blob, after: Blob): Promise<void>;
	/** The content hash of a file right now — what a write's `before`/`after` are taken from. */
	store(workspace: string, sessionId: string, path: string): Promise<Blob>;
	/** Every entry the journal holds for a session, oldest first. */
	entries(workspace: string, sessionId: string): Promise<JournalEntry[]>;
	/** What the agent wrote and the user has not accepted or undone. */
	pending(workspace: string, sessionId: string, dirty?: (path: string) => boolean): Promise<Pending>;
	/** Accepts the current content of these paths as the baseline. */
	keep(workspace: string, sessionId: string, paths: string[]): Promise<void>;
	/** Puts the file back to what it held before the agent first wrote it. */
	undo(workspace: string, sessionId: string, paths: string[], options?: { overwrite?: Overwrite; isDirty?: (path: string) => boolean }): Promise<string[]>;
	/** The content the agent found, for a diff view. */
	baselineContent(workspace: string, sessionId: string, path: string): Promise<string | null>;
	/** Whether anything was ever journaled for this session. */
	hasSession(workspace: string, sessionId: string): Promise<boolean>;
	/** Removes shadow repositories left by an older design of this feature. */
	purgeLegacy(): Promise<number>;
}

interface Repo {
	dir: string;
	work: string;
}

interface GitResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

declare module 'cordis' {
	interface Context {
		checkpoints: Checkpoints;
	}
}

export class Checkpoints extends Service implements JournalApi {
	static inject = ['host'];

	constructor(ctx: Context) {
		super(ctx, 'checkpoints');
	}

	private get root(): string {
		return this.ctx.host.storage.checkpoints;
	}

	/**
	 * Records one write. The first write of a path in a turn keeps its `before`; later writes of the
	 * same path in that turn only move `after`. After the user accepted the file, a write starts over.
	 */
	async record(workspace: string, sessionId: string, turn: number, path: string, before: Blob, after: Blob): Promise<void> {
		const repo = await this.open(workspace, sessionId);
		const rel = relativePath(path);
		const entries = await this.load(repo);
		const last = lastFor(entries, rel);
		if (last && last.turn === turn && !last.accepted) {
			last.after = after;
			last.at = Date.now();
		} else {
			entries.push({ path: rel, turn, before, after, at: Date.now() });
		}
		await this.save(repo, entries);
		this.ctx.emit('checkpoints/changed');
	}

	/**
	 * Removes shadow repositories left by the snapshot-per-turn design. They are not kept: a legacy
	 * repository is identified by its `marks/` folder, which the journal never creates.
	 */
	async purgeLegacy(): Promise<number> {
		let removed = 0;
		let sessions: string[] = [];
		try {
			sessions = await readdir(this.root);
		} catch {
			return 0;
		}
		for (const session of sessions) {
			const sessionDir = join(this.root, session);
			let paths: string[] = [];
			try {
				paths = await readdir(sessionDir);
			} catch {
				continue;
			}
			for (const path of paths) {
				const dir = join(sessionDir, path);
				if (await exists(join(dir, 'marks'))) {
					await rm(dir, { recursive: true, force: true });
					removed += 1;
				}
			}
		}
		return removed;
	}

	/** Stores a file's current bytes and returns their hash, or `null` if the file does not exist. */
	async store(workspace: string, sessionId: string, path: string): Promise<Blob> {
		const repo = await this.open(workspace, sessionId);
		const [hash] = await this.hashFiles(repo, [join(repo.work, relativePath(path))]);
		return hash ?? null;
	}

	/** The journal in write order. A rewind point stores a position in it. */
	async entries(workspace: string, sessionId: string): Promise<JournalEntry[]> {
		if (!(await this.hasSession(workspace, sessionId))) {
			return [];
		}
		return this.load(await this.open(workspace, sessionId));
	}

	/**
	 * What the agent wrote and the user has not accepted yet. Only journaled paths are examined: their
	 * current bytes are hashed in one process, and their diffs come from one `git diff` against a
	 * temporary index that lists only them.
	 */
	async pending(workspace: string, sessionId: string, dirty: (path: string) => boolean = () => false): Promise<Pending> {
		if (!(await this.hasSession(workspace, sessionId))) {
			return { available: false, files: [] };
		}
		const repo = await this.open(workspace, sessionId);
		const entries = await this.load(repo);
		const paths = [...new Set(entries.map((entry) => entry.path))].filter((path) => working(entries, path).length > 0);
		if (paths.length === 0) {
			return { available: true, files: [] };
		}
		const nows = await this.currentBlobs(repo, paths);
		const changed = paths
			.map((path, index) => ({ path, now: nows[index] ?? null, first: working(entries, path)[0]! }))
			// Back at the baseline: nothing left to review, whatever was written in between.
			.filter((item) => item.now !== item.first.before);
		if (changed.length === 0) {
			return { available: true, files: [] };
		}
		const diffs = await this.diffs(
			repo,
			changed.map((item) => ({ path: item.path, baseline: item.first.before })),
		);
		return {
			available: true,
			files: changed.map((item) => {
				const last = lastFor(entries, item.path)!;
				const diff = diffs.get(item.path);
				return {
					path: item.path,
					additions: diff?.additions ?? 0,
					deletions: diff?.deletions ?? 0,
					created: item.first.before === null,
					deleted: item.now === null,
					changedOutside: item.now !== last.after,
					dirty: dirty(item.path),
					hunks: diff?.hunks ?? [],
				};
			}),
		};
	}

	/** Accepts files as they are now: they become the baseline and leave the pending list. */
	async keep(workspace: string, sessionId: string, paths: string[]): Promise<void> {
		const repo = await this.open(workspace, sessionId);
		const entries = await this.load(repo);
		for (const path of unique(paths.map(relativePath))) {
			const last = lastOf(working(entries, path));
			if (!last) {
				throw new Error(`${path} is not pending review`);
			}
			last.accepted = true;
		}
		await this.save(repo, entries);
		this.ctx.emit('checkpoints/changed');
	}

	/**
	 * Restores files to their content before the agent first wrote them. Every check runs before the
	 * first write: unsaved editor text refuses, and a file changed outside the agent refuses unless
	 * `overwrite` allows it. Returns the paths restored.
	 */
	async undo(workspace: string, sessionId: string, paths: string[], options: { overwrite?: Overwrite; isDirty?: (path: string) => boolean } = {}): Promise<string[]> {
		const repo = await this.open(workspace, sessionId);
		const entries = await this.load(repo);
		const targets = unique(paths.map(relativePath))
			.map((path) => ({ path, work: working(entries, path) }))
			.filter((target) => target.work.length > 0);
		if (targets.length === 0) {
			throw new Error('no pending changes to undo');
		}
		const unsaved = targets.filter((target) => options.isDirty?.(target.path)).map((target) => target.path);
		if (unsaved.length > 0) {
			throw new DirtyEditorError(unsaved);
		}
		const nows = await this.currentBlobs(
			repo,
			targets.map((target) => target.path),
		);
		const conflicts = targets
			.filter((target, index) => !allowed(options.overwrite, target.path) && (nows[index] ?? null) !== lastOf(target.work)!.after)
			.map((target) => target.path);
		if (conflicts.length > 0) {
			throw new ChangedOutsideError(conflicts);
		}
		for (const target of targets) {
			await this.restore(repo, target.path, target.work[0]!.before);
			lastOf(target.work)!.accepted = true;
		}
		await this.save(repo, entries);
		this.ctx.emit('checkpoints/changed');
		return targets.map((target) => target.path);
	}

	/**
	 * Rewinds files to a rewind point: each path the journal changed after it goes back to its content
	 * at that point. `skip` leaves named paths alone and keeps their later entries. Like `undo`, every
	 * check runs before the first write.
	 */
	async revert(
		workspace: string,
		sessionId: string,
		mark: { entryCount: number },
		options: { overwrite?: Overwrite; skip?: string[]; isDirty?: (path: string) => boolean } = {},
	): Promise<RevertReport> {
		const repo = await this.open(workspace, sessionId);
		const entries = await this.load(repo);
		const later = entries.slice(mark.entryCount);
		const skip = new Set(options.skip ?? []);
		const touched = unique(later.map((entry) => entry.path));
		const paths = touched.filter((path) => !skip.has(path));
		const unsaved = paths.filter((path) => options.isDirty?.(path));
		if (unsaved.length > 0) {
			throw new DirtyEditorError(unsaved);
		}
		const nows = await this.currentBlobs(repo, paths);
		const conflicts = paths.filter((path, index) => !allowed(options.overwrite, path) && (nows[index] ?? null) !== lastFor(entries, path)!.after);
		if (conflicts.length > 0) {
			throw new ChangedOutsideError(conflicts);
		}
		for (const path of paths) {
			// The earliest later entry of a path holds its content at the rewind point.
			await this.restore(repo, path, later.find((entry) => entry.path === path)!.before);
		}
		// Entries past the point go with the writes they describe; skipped files keep theirs.
		await this.save(repo, [...entries.slice(0, mark.entryCount), ...later.filter((entry) => skip.has(entry.path))]);
		this.ctx.emit('checkpoints/changed');
		return { restored: paths, skipped: touched.filter((path) => skip.has(path)) };
	}

	/** The baseline text of a file, for a diff editor. `null` when the agent created it. */
	async baselineContent(workspace: string, sessionId: string, path: string): Promise<string | null> {
		if (!(await this.hasSession(workspace, sessionId))) {
			return null;
		}
		const repo = await this.open(workspace, sessionId);
		const first = working(await this.load(repo), relativePath(path))[0];
		if (!first?.before) {
			return null;
		}
		const bytes = await gitBytes(repo, ['cat-file', 'blob', first.before]);
		return bytes?.toString('utf8') ?? null;
	}

	async hasSession(workspace: string, sessionId: string): Promise<boolean> {
		if (!workspace.trim() || !sessionId.trim()) {
			return false;
		}
		return exists(repoDir(this.root, workspace, sessionId));
	}

	private async load(repo: Repo): Promise<JournalEntry[]> {
		try {
			const parsed = JSON.parse(await readFile(join(repo.dir, 'journal.json'), 'utf8')) as { entries?: JournalEntry[] };
			return Array.isArray(parsed.entries) ? parsed.entries : [];
		} catch {
			return [];
		}
	}

	private async save(repo: Repo, entries: JournalEntry[]): Promise<void> {
		await mkdir(repo.dir, { recursive: true });
		await writeFile(join(repo.dir, 'journal.json'), JSON.stringify({ entries }), 'utf8');
	}

	private async currentBlobs(repo: Repo, paths: string[]): Promise<Blob[]> {
		return this.hashFiles(
			repo,
			paths.map((path) => join(repo.work, relativePath(path))),
		);
	}

	/** Stores the bytes of the existing files among `files` as blobs, in one `git hash-object` call. */
	private async hashFiles(repo: Repo, files: string[]): Promise<Blob[]> {
		const present = await Promise.all(files.map((file) => exists(file)));
		const list = files.filter((_, index) => present[index]);
		const result: Blob[] = files.map(() => null);
		if (list.length === 0) {
			return result;
		}
		const hashed = await gitInput(repo, ['hash-object', '-w', '--no-filters', '--stdin-paths'], `${list.join('\n')}\n`);
		if (hashed.code !== 0) {
			throw new Error(hashed.stderr || 'could not store the files');
		}
		const hashes = hashed.stdout.trim().split('\n');
		let next = 0;
		files.forEach((_, index) => {
			if (present[index]) {
				result[index] = hashes[next++]?.trim() || null;
			}
		});
		return result;
	}

	/**
	 * Diffs of the given files against their baselines: a temporary index holds only those baselines,
	 * so `git diff` compares exactly them with the working tree. A created file's baseline is the
	 * empty blob, so all of it counts as added.
	 */
	private async diffs(repo: Repo, items: { path: string; baseline: Blob }[]): Promise<Map<string, { additions: number; deletions: number; hunks: JournalHunk[] }>> {
		const empty = (await gitInput(repo, ['hash-object', '-w', '--stdin'], '')).stdout.trim();
		const index = join(repo.dir, 'review.index');
		await unlink(index).catch(() => undefined);
		const info = items.map((item) => `100644 ${item.baseline ?? empty}\t${item.path}\n`).join('');
		try {
			const built = await gitInput(repo, ['update-index', '--index-info'], info, index);
			if (built.code !== 0) {
				throw new Error(built.stderr || 'could not build the review index');
			}
			const diff = await gitInput(repo, ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--unified=2'], '', index);
			if (diff.code !== 0) {
				throw new Error(diff.stderr || 'could not diff the workspace');
			}
			return parseDiffs(diff.stdout);
		} finally {
			await unlink(index).catch(() => undefined);
		}
	}

	private async restore(repo: Repo, path: string, blob: Blob): Promise<void> {
		const target = join(repo.work, relativePath(path));
		if (blob === null) {
			await unlink(target).catch(() => undefined);
			return;
		}
		const bytes = await gitBytes(repo, ['cat-file', 'blob', blob]);
		if (!bytes) {
			throw new Error(`could not read the stored version of ${path}`);
		}
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, bytes);
	}

	private async open(workspace: string, sessionId: string): Promise<Repo> {
		const work = resolve(workspace);
		const dir = repoDir(this.root, work, sessionId);
		const repo = { dir, work };
		if (await exists(join(dir, 'HEAD'))) {
			return repo;
		}
		await mkdir(dir, { recursive: true });
		const init = await git(repo, ['init', '--quiet']);
		if (init.code !== 0) {
			throw new Error(init.stderr || 'could not initialize the shadow repository');
		}
		return repo;
	}
}

export const checkpointsPlugin = Checkpoints;

/** The entries of a path after its last accepted one: what is still pending, oldest first. */
function working(entries: JournalEntry[], path: string): JournalEntry[] {
	let start = 0;
	entries.forEach((entry, index) => {
		if (entry.path === path && entry.accepted) {
			start = index + 1;
		}
	});
	return entries.slice(start).filter((entry) => entry.path === path);
}

function lastOf(list: JournalEntry[]): JournalEntry | undefined {
	return list[list.length - 1];
}

function lastFor(entries: JournalEntry[], path: string): JournalEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index]!.path === path) {
			return entries[index];
		}
	}
	return undefined;
}

function allowed(overwrite: Overwrite | undefined, path: string): boolean {
	return overwrite === 'all' || (overwrite?.includes(path) ?? false);
}

function unique(paths: string[]): string[] {
	return [...new Set(paths)];
}

/** Parses a `git diff` over several files into per-path counts and hunks. */
export function parseDiffs(text: string): Map<string, { additions: number; deletions: number; hunks: JournalHunk[] }> {
	const out = new Map<string, { additions: number; deletions: number; hunks: JournalHunk[] }>();
	let current: { additions: number; deletions: number; hunks: JournalHunk[] } | null = null;
	let hunk: JournalHunk | null = null;
	for (const line of text.split('\n')) {
		if (line.startsWith('diff --git ')) {
			const at = line.lastIndexOf(' b/');
			const path = unquote(at === -1 ? '' : line.slice(at + 1).slice(2));
			current = { additions: 0, deletions: 0, hunks: [] };
			hunk = null;
			out.set(path, current);
			continue;
		}
		if (!current) {
			continue;
		}
		if (line.startsWith('@@')) {
			hunk = { header: line, lines: [] };
			current.hunks.push(hunk);
			continue;
		}
		// `---` and `+++` header lines come before the first hunk, so they are never counted.
		if (!hunk) {
			continue;
		}
		if (line.startsWith('+')) {
			current.additions += 1;
			hunk.lines.push({ type: 'add', text: line.slice(1) });
		} else if (line.startsWith('-')) {
			current.deletions += 1;
			hunk.lines.push({ type: 'del', text: line.slice(1) });
		} else if (line.startsWith(' ')) {
			hunk.lines.push({ type: 'ctx', text: line.slice(1) });
		}
	}
	return out;
}

function unquote(path: string): string {
	if (path.startsWith('"') && path.endsWith('"')) {
		try {
			return JSON.parse(path) as string;
		} catch {
			return path;
		}
	}
	return path;
}

function repoDir(root: string, workspace: string, sessionId: string): string {
	const session = createHash('sha1').update(sessionId).digest('hex').slice(0, 20);
	const path = createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 16);
	return join(root, session, path);
}

function relativePath(file: string): string {
	const clean = file.replaceAll('\\', '/').replace(/^\.\//, '');
	if (!clean || clean.includes('\0') || clean.startsWith('/') || clean.split('/').includes('..')) {
		throw new Error('invalid path');
	}
	return clean;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function git(repo: Repo, args: string[]): Promise<GitResult> {
	return gitInput(repo, args, '');
}

function gitInput(repo: Repo, args: string[], input: string, index?: string): Promise<GitResult> {
	return new Promise((resolvePromise) => {
		const child = spawn('git', args, {
			cwd: repo.work,
			env: {
				...process.env,
				GIT_DIR: repo.dir,
				GIT_WORK_TREE: repo.work,
				...(index ? { GIT_INDEX_FILE: index } : {}),
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => child.kill(), 15_000);
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('error', () => {
			clearTimeout(timer);
			resolvePromise({ code: 1, stdout: '', stderr: '' });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolvePromise({ code, stdout, stderr });
		});
		child.stdin.end(input);
	});
}

/** Raw bytes of a git command's output: a binary file must come back unchanged. */
function gitBytes(repo: Repo, args: string[]): Promise<Buffer | null> {
	return new Promise((resolvePromise) => {
		const child = spawn('git', args, {
			cwd: repo.work,
			env: { ...process.env, GIT_DIR: repo.dir, GIT_WORK_TREE: repo.work },
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const chunks: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
		child.on('error', () => resolvePromise(null));
		child.on('close', (code) => resolvePromise(code === 0 ? Buffer.concat(chunks) : null));
	});
}
