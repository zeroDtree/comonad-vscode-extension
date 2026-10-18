import type { JournalHunk } from './diff';
import type { LineHunk } from './line-diff';

/**
 * The journal's vocabulary: what a recorded write looks like, what a review listing carries, and the
 * seam the rest of the extension talks to. Pure module — the service that implements the seam lives
 * in `services/checkpoints`, and the review surface that draws it in `ui/review`; both speak this so
 * neither has to import the other.
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
	/** When that review decision was made, so the reviewed list can read newest first. */
	acceptedAt?: number;
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

/**
 * One path's change as the inline review reads it: the accepted baseline against the file on disk.
 * `hunks` are line diff blocks, so `Keep`/`Undo` can act on one block at a time.
 */
export interface FileChange {
	path: string;
	/** The accepted baseline as text — `''` for a file that did not exist. */
	baseline: string;
	/** The file on disk as text — `''` when it is gone. */
	current: string;
	hunks: LineHunk[];
	/** The agent created the file (its first write found nothing). */
	created: boolean;
	/** The file is gone from disk. */
	deleted: boolean;
	/** The disk no longer matches what the agent last wrote: the user changed it since. */
	changedOutside: boolean;
	/** Too large or too different to diff block by block. */
	truncated: boolean;
	/** Not text: line-level review does not apply. */
	binary: boolean;
}

/** How a per-block Keep treats a file someone changed outside the agent. */
export interface KeepHunkOptions {
	overwrite?: Overwrite;
	isDirty?: (path: string) => boolean;
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
 * What the rest of the extension asks of the journal.
 *
 * The agent, the chat panel and the workspace watcher treat this as *optional*: they look it up with
 * `ctx.get('checkpoints')` rather than injecting it, so turning the row off leaves a working extension
 * that simply records nothing. The review surface is the journal's own and injects it, so it follows
 * the row in and out on its own.
 */
export interface JournalApi {
	/** Records one write: `before` is kept for the first write of a path in a turn, `after` moves. */
	record(workspace: string, sessionId: string, turn: number, path: string, before: Blob, after: Blob): Promise<void>;
	/** The content hash of a file right now — what a write's `before`/`after` are taken from. */
	store(workspace: string, sessionId: string, path: string): Promise<Blob>;
	/** Every entry the journal holds for a session, oldest first. */
	entries(workspace: string, sessionId: string): Promise<JournalEntry[]>;
	/** What the agent wrote and the user has not accepted or undone. `diff: false` skips the counts
	 *  and hunks — the inline review only needs to know which files are pending. */
	pending(workspace: string, sessionId: string, dirty?: (path: string) => boolean, options?: { diff?: boolean }): Promise<Pending>;
	/** Accepts the current content of these paths as the baseline. */
	keep(workspace: string, sessionId: string, paths: string[]): Promise<void>;
	/** One path's change, block by block, against the accepted baseline. */
	change(workspace: string, sessionId: string, path: string): Promise<FileChange>;
	/** Accepts one block: the baseline advances by that block and the rest stays pending. */
	keepHunk(workspace: string, sessionId: string, path: string, hunk: LineHunk, options?: KeepHunkOptions): Promise<void>;
	/** Notes that the file changed by the review UI itself, so it is not "changed outside". */
	amend(workspace: string, sessionId: string, path: string): Promise<void>;
	/** Undoes the remaining changes: the file goes back to the accepted baseline (what Keep left). */
	undo(workspace: string, sessionId: string, paths: string[], options?: { overwrite?: Overwrite; isDirty?: (path: string) => boolean }): Promise<string[]>;
	/** The accepted baseline text — what the pending diff shows before its changes; `null` when absent. */
	baselineContent(workspace: string, sessionId: string, path: string): Promise<string | null>;
	/** Restore files to a journal position — an edited prompt's restore point. */
	revert(
		workspace: string,
		sessionId: string,
		mark: { entryCount: number; at?: number },
		options?: { overwrite?: Overwrite; skip?: string[]; isDirty?: (path: string) => boolean },
	): Promise<RevertReport>;
	/** Whether anything was ever journaled for this session. */
	hasSession(workspace: string, sessionId: string): Promise<boolean>;
	/** Removes shadow repositories left by an older design of this feature. */
	purgeLegacy(): Promise<number>;
}
