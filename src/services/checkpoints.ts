import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { Service, type Context } from 'cordis';
import { parseDiffs, type JournalHunk } from '../lib/diff';
import { applyHunk, diffLines, hunkKey, type LineHunk } from '../lib/line-diff';
import {
	ChangedOutsideError,
	DirtyEditorError,
	type Blob,
	type FileChange,
	type JournalApi,
	type JournalEntry,
	type KeepHunkOptions,
	type Overwrite,
	type Pending,
	type RevertReport,
} from '../lib/journal';
import { inlineDiff } from '../ui/inline-diff';
import { review } from '../ui/review';

/**
 * Per-file edit journal. Comonad never snapshots the workspace: every write the agent makes goes
 * through `ToolContext.edit`, which stores the file's content before and after the change.
 *
 * Storage: one shadow git repository per session and workspace, outside the project (`GIT_DIR`). It
 * only holds blobs (file contents) and a temporary index for diffs; it never commits, and the user's
 * own `.git` is never touched. `journal.json` lists the writes in order. Nothing is pruned.
 *
 * Accepting a file (Keep) or undoing it sets `accepted` on its latest entry. Entries are never
 * removed, except by a restore, so the positions stored in restore points stay valid. The vocabulary
 * — entries, listings, the seam itself — lives in `lib/journal`, so the review surface that draws
 * this and the service that runs it never import each other.
 */

interface Repo {
	dir: string;
	work: string;
}

/** One accepted baseline for a path, and when the user accepted it. */
interface BaselineRecord {
	blob: Blob;
	at: number;
}

/** journal.json as the service reads and writes it. Older files have no `baselines`. */
interface JournalDoc {
	entries: JournalEntry[];
	/**
	 * The accepted baselines of a path, oldest first. A restore needs the baseline as it stood at the
	 * mark, so each keepHunk appends instead of replacing; the last one is what the diff uses.
	 */
	baselines: Record<string, BaselineRecord[]>;
}

/** The accepted baseline of a path: the latest record, else the first write's content before the agent. */
function baselineOf(doc: JournalDoc, path: string): Blob {
	const history = doc.baselines[path];
	if (history?.length) {
		return history[history.length - 1]!.blob;
	}
	const work = working(doc.entries, path);
	if (work.length) {
		return work[0]!.before;
	}
	// Every entry accepted: the baseline is what the agent's last write left.
	return lastFor(doc.entries, path)?.after ?? null;
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
		// Shadow repositories from the earlier snapshot-per-turn design are this feature's own leftovers,
		// and this is the one place that knows what they look like: cleaned up when the journal is mounted.
		// Fire and forget: a leftover that cannot be removed must not keep the journal from starting.
		void this.purgeLegacy().catch((error) => this.ctx.log.message(`checkpoints: legacy purge failed: ${error}`));
	}

	private get root(): string {
		return this.ctx.host.storage.checkpoints;
	}

	/** The journal file is read, changed and written back: two of those at once lose one of the
	 *  changes. Every reader-and-writer runs after the one before it. */
	private lock: Promise<unknown> = Promise.resolve();

	/**
	 * Blob contents by hash. A blob never changes, so a baseline read once is read no more: the
	 * inline review asks for the same baseline on every click, and a `git cat-file` per click is the
	 * difference between an instant button and a slow one.
	 */
	private readonly blobs = new Map<string, Buffer>();
	/** The empty blob's hash, by repository: it is the same blob in every one, but hashed once each. */
	private readonly empties = new Map<string, string>();
	/** A fresh name for each temporary review index, so two diffs at once cannot share one. */
	private reviewIndex = 0;

	private queued<T>(work: () => Promise<T>): Promise<T> {
		const next = this.lock.then(work, work);
		this.lock = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/**
	 * Records one write. The first write of a path in a turn keeps its `before`; later writes of the
	 * same path in that turn only move `after`. After the user accepted the file, a write starts over.
	 */
	async record(workspace: string, sessionId: string, turn: number, path: string, before: Blob, after: Blob): Promise<void> {
		await this.queued(async () => {
			const repo = await this.open(workspace, sessionId);
			const rel = relativePath(path);
			const doc = await this.load(repo);
			const last = lastFor(doc.entries, rel);
			if (last && last.turn === turn && !last.accepted) {
				last.after = after;
				last.at = Date.now();
			} else {
				doc.entries.push({ path: rel, turn, before, after, at: Date.now() });
			}
			await this.save(repo, doc);
			this.ctx.emit('checkpoints/changed');
		});
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

	/** The journal in write order. A restore point stores a position in it. */
	async entries(workspace: string, sessionId: string): Promise<JournalEntry[]> {
		if (!(await this.hasSession(workspace, sessionId))) {
			return [];
		}
		return (await this.load(await this.open(workspace, sessionId))).entries;
	}

	/**
	 * What the agent wrote and the user has not accepted yet. Only journaled paths are examined: their
	 * current bytes are hashed in one process, and their diffs come from one `git diff` against a
	 * temporary index that lists only them.
	 */
	async pending(workspace: string, sessionId: string, dirty: (path: string) => boolean = () => false, options: { diff?: boolean } = {}): Promise<Pending> {
		if (!(await this.hasSession(workspace, sessionId))) {
			return { available: false, files: [] };
		}
		const repo = await this.open(workspace, sessionId);
		const doc = await this.load(repo);
		const paths = [...new Set(doc.entries.map((entry) => entry.path))].filter((path) => working(doc.entries, path).length > 0);
		if (paths.length === 0) {
			return { available: true, files: [] };
		}
		const empty = await this.emptyBlob(repo);
		const nows = await this.currentBlobs(repo, paths);
		const changed = paths
			.map((path, index) => ({
				path,
				now: nows[index] ?? null,
				first: working(doc.entries, path)[0]!,
				baseline: baselineOf(doc, path),
			}))
			// Back at the accepted baseline: nothing left to review, whatever was written in between.
			// A missing file and an empty one are the same absence of content.
			.filter((item) => (item.now ?? empty) !== (item.baseline ?? empty));
		if (changed.length === 0) {
			return { available: true, files: [] };
		}
		// The counts and hunks cost a temp index and a `git diff`; the inline review only needs the
		// list, and asks for each open file's blocks separately.
		const diffs =
			options.diff === false
				? new Map<string, { additions: number; deletions: number; hunks: JournalHunk[] }>()
				: await this.diffs(
						repo,
						changed.map((item) => ({ path: item.path, baseline: item.baseline })),
					);
		return {
			available: true,
			files: changed.map((item) => {
				const last = lastFor(doc.entries, item.path)!;
				const diff = diffs.get(item.path);
				return {
					path: item.path,
					additions: diff?.additions ?? 0,
					deletions: diff?.deletions ?? 0,
					// "New" is the agent's doing, not the baseline override's: a partly kept new file is
					// still new.
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
		await this.queued(async () => {
			const repo = await this.open(workspace, sessionId);
			const doc = await this.load(repo);
			for (const path of unique(paths.map(relativePath))) {
				const last = lastOf(working(doc.entries, path));
				if (!last) {
					throw new Error(`${path} is not pending review`);
				}
				last.accepted = true;
				last.acceptedAt = Date.now();
				// The accepted content is what the file holds now; one record keeps baselineContent
				// truthful and the history bounded. When the file is still exactly what the agent wrote,
				// the entry's own `after` already is that baseline and no hash is needed.
				const bytes = await this.workBytes(repo, path);
				const after = last.after ? await this.blobBytes(repo, last.after) : null;
				if (sameBytes(bytes, after)) {
					delete doc.baselines[path];
				} else {
					doc.baselines[path] = [{ blob: bytes ? await this.hashBytes(repo, bytes) : null, at: Date.now() }];
				}
			}
			await this.save(repo, doc);
			this.ctx.emit('checkpoints/changed');
		});
	}

	/**
	 * Restores files to their content before the agent first wrote them. Every check runs before the
	 * first write: unsaved editor text refuses, and a file changed outside the agent refuses unless
	 * `overwrite` allows it. Returns the paths restored.
	 */
	async undo(workspace: string, sessionId: string, paths: string[], options: { overwrite?: Overwrite; isDirty?: (path: string) => boolean } = {}): Promise<string[]> {
		return this.queued(async () => {
			const repo = await this.open(workspace, sessionId);
			const doc = await this.load(repo);
			const targets = unique(paths.map(relativePath))
				.map((path) => ({ path, work: working(doc.entries, path), baseline: baselineOf(doc, path) }))
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
				// The accepted baseline, not the pre-agent content: a block the user kept is theirs.
				await this.restore(repo, target.path, target.baseline);
				const last = lastOf(target.work)!;
				last.accepted = true;
				last.acceptedAt = Date.now();
				doc.baselines[target.path] = [{ blob: target.baseline, at: Date.now() }];
			}
			await this.save(repo, doc);
			this.ctx.emit('checkpoints/changed');
			return targets.map((target) => target.path);
		});
	}

	/**
	 * Restores files to a restore point: each path the journal changed after it goes back to its
	 * content at that point. `skip` leaves named paths alone and keeps their later entries. Like
	 * `undo`, every check runs before the first write.
	 */
	async revert(
		workspace: string,
		sessionId: string,
		mark: { entryCount: number; at?: number },
		options: { overwrite?: Overwrite; skip?: string[]; isDirty?: (path: string) => boolean } = {},
	): Promise<RevertReport> {
		return this.queued(async () => {
			const repo = await this.open(workspace, sessionId);
			const doc = await this.load(repo);
			const later = doc.entries.slice(mark.entryCount);
			const skip = new Set(options.skip ?? []);
			const touched = unique(later.map((entry) => entry.path));
			const paths = touched.filter((path) => !skip.has(path));
			const unsaved = paths.filter((path) => options.isDirty?.(path));
			if (unsaved.length > 0) {
				throw new DirtyEditorError(unsaved);
			}
			const nows = await this.currentBlobs(repo, paths);
			const conflicts = paths.filter((path, index) => !allowed(options.overwrite, path) && (nows[index] ?? null) !== lastFor(doc.entries, path)!.after);
			if (conflicts.length > 0) {
				throw new ChangedOutsideError(conflicts);
			}
			const at = mark.at;
			for (const path of paths) {
				// The earliest later entry of a path holds its content at the restore point.
				await this.restore(repo, path, later.find((entry) => entry.path === path)!.before);
				// The baseline as it stood at the restore point: keeps after it are exactly what the
				// restore takes back, and keeps before it are the user's earlier decision.
				const history = doc.baselines[path];
				if (history) {
					const kept = at === undefined ? [] : history.filter((record) => record.at <= at);
					if (kept.length) {
						doc.baselines[path] = kept;
					} else {
						delete doc.baselines[path];
					}
				}
			}
			// Entries past the point go with the writes they describe; skipped files keep theirs.
			doc.entries = [...doc.entries.slice(0, mark.entryCount), ...later.filter((entry) => skip.has(entry.path))];
			await this.save(repo, doc);
			this.ctx.emit('checkpoints/changed');
			return { restored: paths, skipped: touched.filter((path) => skip.has(path)) };
		});
	}

	/**
	 * One path's change, block by block: the accepted baseline against the file on disk. The blocks
	 * are computed here, not read from `git diff`, so `Keep`/`Undo` act on exactly what the editor
	 * shows — the git hunks carry context and no per-line numbers.
	 */
	async change(workspace: string, sessionId: string, path: string): Promise<FileChange> {
		const repo = await this.open(workspace, sessionId);
		const rel = relativePath(path);
		const doc = await this.load(repo);
		const work = working(doc.entries, rel);
		if (!work.length) {
			throw new Error(`${rel} is not pending review`);
		}
		const baseline = baselineOf(doc, rel);
		const now = (await this.currentBlobs(repo, [rel]))[0] ?? null;
		const baselineBytes = baseline ? ((await this.blobBytes(repo, baseline)) ?? Buffer.alloc(0)) : Buffer.alloc(0);
		// The current side is the file itself; reading it beats a `git cat-file` process.
		const currentBytes = now ? ((await this.workBytes(repo, rel)) ?? Buffer.alloc(0)) : Buffer.alloc(0);
		const binary = isBinary(baselineBytes) || isBinary(currentBytes);
		const diff = binary ? { hunks: [], truncated: false } : diffLines(baselineBytes.toString('utf8'), currentBytes.toString('utf8'));
		return {
			path: rel,
			baseline: baselineBytes.toString('utf8'),
			current: currentBytes.toString('utf8'),
			hunks: diff.hunks,
			created: work[0]!.before === null,
			deleted: now === null,
			changedOutside: now !== lastOf(work)!.after,
			truncated: diff.truncated,
			binary,
		};
	}

	/**
	 * Accepts one block: the baseline advances by exactly that change and the rest stays pending.
	 * The same checks as `undo` run first — unsaved text, a file someone changed outside the agent,
	 * and a block whose lines are no longer where the caller saw them.
	 */
	async keepHunk(workspace: string, sessionId: string, path: string, hunk: LineHunk, options: KeepHunkOptions = {}): Promise<void> {
		await this.queued(async () => {
			const repo = await this.open(workspace, sessionId);
			const rel = relativePath(path);
			const doc = await this.load(repo);
			const work = working(doc.entries, rel);
			if (!work.length) {
				throw new Error(`${rel} is not pending review`);
			}
			if (options.isDirty?.(rel)) {
				throw new DirtyEditorError([rel]);
			}
			const baseline = baselineOf(doc, rel);
			const now = (await this.currentBlobs(repo, [rel]))[0] ?? null;
			if (!allowed(options.overwrite, rel) && now !== lastOf(work)!.after) {
				throw new ChangedOutsideError([rel]);
			}
			const baselineBytes = baseline ? ((await this.blobBytes(repo, baseline)) ?? Buffer.alloc(0)) : Buffer.alloc(0);
			const currentBytes = now ? ((await this.workBytes(repo, rel)) ?? Buffer.alloc(0)) : Buffer.alloc(0);
			if (isBinary(baselineBytes) || isBinary(currentBytes)) {
				throw new Error(`${rel} is not text`);
			}
			const baselineText = baselineBytes.toString('utf8');
			const result = diffLines(baselineText, currentBytes.toString('utf8'));
			if (result.truncated) {
				throw new Error(`${rel} is too large to keep one block at a time`);
			}
			const located = result.hunks.find((candidate) => hunkKey(candidate) === hunkKey(hunk));
			if (!located) {
				throw new Error('the file changed since this change was shown');
			}
			const nextBlob = await this.storeText(repo, applyHunk(baselineText, located));
			if (nextBlob === now) {
				// The whole file is accepted now: the file-level keep, without the second command.
				const last = lastOf(work)!;
				last.accepted = true;
				last.acceptedAt = Date.now();
				delete doc.baselines[rel];
			} else {
				doc.baselines[rel] = [...(doc.baselines[rel] ?? []), { blob: nextBlob, at: Date.now() }];
			}
			await this.save(repo, doc);
			this.ctx.emit('checkpoints/changed');
		});
	}

	/**
	 * Notes a change the review UI itself made (a block undone in the editor): the latest write is
	 * no longer what is on disk, and that is not "changed outside the agent".
	 */
	async amend(workspace: string, sessionId: string, path: string): Promise<void> {
		await this.queued(async () => {
			const repo = await this.open(workspace, sessionId);
			const rel = relativePath(path);
			const doc = await this.load(repo);
			const last = lastOf(working(doc.entries, rel));
			if (!last) {
				return;
			}
			last.after = (await this.currentBlobs(repo, [rel]))[0] ?? null;
			last.at = Date.now();
			await this.save(repo, doc);
			this.ctx.emit('checkpoints/changed');
		});
	}

	/** The accepted baseline text of a file, for a diff view. `null` when the file did not exist. */
	async baselineContent(workspace: string, sessionId: string, path: string): Promise<string | null> {
		if (!(await this.hasSession(workspace, sessionId))) {
			return null;
		}
		const repo = await this.open(workspace, sessionId);
		const baseline = baselineOf(await this.load(repo), relativePath(path));
		if (!baseline) {
			return null;
		}
		const bytes = await this.blobBytes(repo, baseline);
		return bytes?.toString('utf8') ?? null;
	}

	async hasSession(workspace: string, sessionId: string): Promise<boolean> {
		if (!workspace.trim() || !sessionId.trim()) {
			return false;
		}
		return exists(repoDir(this.root, workspace, sessionId));
	}

	private async load(repo: Repo): Promise<JournalDoc> {
		try {
			const parsed = JSON.parse(await readFile(join(repo.dir, 'journal.json'), 'utf8')) as { entries?: unknown; baselines?: unknown };
			const entries = Array.isArray(parsed.entries) ? (parsed.entries as JournalEntry[]) : [];
			const baselines: Record<string, BaselineRecord[]> = {};
			if (parsed.baselines && typeof parsed.baselines === 'object') {
				for (const [path, value] of Object.entries(parsed.baselines as Record<string, unknown>)) {
					if (!Array.isArray(value)) {
						continue;
					}
					const records = value.filter(
						(record): record is BaselineRecord =>
							Boolean(record) && typeof record === 'object' && (typeof record.blob === 'string' || record.blob === null) && typeof record.at === 'number',
					);
					if (records.length) {
						baselines[path] = records;
					}
				}
			}
			return { entries, baselines };
		} catch {
			return { entries: [], baselines: {} };
		}
	}

	/**
	 * Writes the journal as one replace: a plain `writeFile` that is cut short leaves unparseable
	 * JSON, and the read side would then start the session's history over from nothing. The temp file
	 * and the rename are beside each other, so the swap is atomic.
	 */
	private async save(repo: Repo, doc: JournalDoc): Promise<void> {
		await mkdir(repo.dir, { recursive: true });
		const file = join(repo.dir, 'journal.json');
		const temp = `${file}.tmp`;
		await writeFile(temp, JSON.stringify({ entries: doc.entries, baselines: doc.baselines }), 'utf8');
		await rename(temp, file);
	}

	/** Hashes text as a blob — the baseline a kept block advances to. */
	private async storeText(repo: Repo, text: string): Promise<string> {
		return this.hashBytes(repo, Buffer.from(text, 'utf8'));
	}

	/** Hashes bytes as a stored blob. */
	private async hashBytes(repo: Repo, bytes: Buffer): Promise<string> {
		const result = await gitInput(repo, ['hash-object', '-w', '--no-filters', '--stdin'], bytes);
		if (result.code !== 0 || !result.stdout.trim()) {
			throw new Error(result.stderr || 'could not store the new baseline');
		}
		return result.stdout.trim();
	}

	/** The bytes of a stored blob, cached: a blob never changes, and the review reads it every click. */
	private async blobBytes(repo: Repo, blob: string): Promise<Buffer | null> {
		const cached = this.blobs.get(blob);
		if (cached) {
			return cached;
		}
		const bytes = await gitBytes(repo, ['cat-file', 'blob', blob]);
		if (bytes) {
			if (this.blobs.size >= 128) {
				this.blobs.clear();
			}
			this.blobs.set(blob, bytes);
		}
		return bytes;
	}

	/** The file as it is on disk right now, or `null` when it is gone. */
	private async workBytes(repo: Repo, rel: string): Promise<Buffer | null> {
		try {
			return await readFile(join(repo.work, relativePath(rel)));
		} catch {
			return null;
		}
	}

	/** The empty blob: an absent file and an empty one are the same absence of content. */
	private async emptyBlob(repo: Repo): Promise<string> {
		const cached = this.empties.get(repo.dir);
		if (cached) {
			return cached;
		}
		const result = await gitInput(repo, ['hash-object', '-w', '--no-filters', '--stdin'], '');
		const hash = result.stdout.trim();
		if (result.code !== 0 || !hash) {
			throw new Error(result.stderr || 'could not hash the empty blob');
		}
		this.empties.set(repo.dir, hash);
		return hash;
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
		const empty = await this.emptyBlob(repo);
		const index = join(repo.dir, `review-${this.reviewIndex++}.index`);
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
		const bytes = await this.blobBytes(repo, blob);
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

/**
 * The row as the tree mounts it: the journal, and the review surface that goes with it. The review is
 * a plugin of its own so its handlers *inject* the journal — the commands read `ctx.checkpoints`, and
 * `review.inject` is what declares it — and the whole row is one toggle: off, and writes are simply
 * writes again.
 */
export async function checkpointsPlugin(ctx: Context): Promise<void> {
	await ctx.plugin(Checkpoints);
	ctx.plugin(review);
	// The same journal, reviewed in the editor: decorations and a Keep/Undo at every block.
	ctx.plugin(inlineDiff);
	// The commands this row answers are declared in Comonad's manifest with an `enablement` of
	// `comonad.checkpoints`: the palette and the keybinding show them while the row is loaded, and have
	// nothing to offer (and nothing that fails) while it is not.
	void vscode.commands.executeCommand('setContext', 'comonad.checkpoints', true);
	ctx.effect(() => () => void vscode.commands.executeCommand('setContext', 'comonad.checkpoints', false));
}
checkpointsPlugin.inject = ['log', 'host', 'sessions'];

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

/** A NUL byte: the file is not text, so a line-level review cannot show it. */
function isBinary(bytes: Buffer): boolean {
	return bytes.includes(0);
}

/** Whether two file contents are the same one, with a missing file equal only to another missing one. */
function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
	return left === null || right === null ? left === right : left.equals(right);
}

function unique(paths: string[]): string[] {
	return [...new Set(paths)];
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

function gitInput(repo: Repo, args: string[], input: string | Buffer, index?: string): Promise<GitResult> {
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
