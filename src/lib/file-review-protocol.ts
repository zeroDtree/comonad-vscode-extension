// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The File Review tab's message vocabulary: plain data shared by the extension host and the guest
 * script. Nothing here imports `vscode` or a node built-in, so the browser bundle takes the types
 * without dragging the host along.
 *
 * Unlike the Review tab's rows, this surface draws the whole file as an editor would: the host
 * sends both texts and the guest's merge view renders deleted lines as real, wrapping rows. A block
 * is still named by its `hunkKey` string, never by a position: the journal revalidates the key
 * before it acts, and a stale key is a refresh rather than an overwrite.
 */

/** One change block, as the guest places its Keep/Undo bar. */
export interface FileHunkView {
	key: string;
	/**
	 * 0-based line in the current text just below the block. When it equals the line count the bar
	 * belongs after the last line; the guest clamps.
	 */
	anchorLine: number;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	additions: number;
	deletions: number;
}

export type FileReviewReason = 'ready' | 'no-pending' | 'binary' | 'too-large' | 'error';

export interface FileReviewState {
	/** Workspace-relative path, with forward slashes. */
	path: string;
	reason: FileReviewReason;
	/** Why the tab is not showing a diff, for the empty state. */
	message: string;
	/** The accepted baseline text; `''` when the file did not exist. */
	baseline: string;
	/** The file on disk; `''` when it is gone or unreadable. */
	current: string;
	hunks: FileHunkView[];
	created: boolean;
	deleted: boolean;
	changedOutside: boolean;
	dirty: boolean;
	/** Too large or too different to diff block by block: view the file, but no block actions. */
	truncated: boolean;
	/** Why block actions are off, or `''` when they are available. */
	blockedReason: string;
}

export type FileReviewHostMessage =
	| { type: 'state'; state: FileReviewState }
	| { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export type FileReviewGuestMessage =
	| { type: 'ready' }
	| { type: 'keepHunk'; hunk: string }
	| { type: 'undoHunk'; hunk: string }
	| { type: 'keepFile' }
	| { type: 'undoFile' }
	| { type: 'openFile' }
	| { type: 'openDiff' };
