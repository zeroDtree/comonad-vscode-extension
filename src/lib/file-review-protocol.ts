// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The File Review editor's message vocabulary: plain data shared by the extension host and the
 * guest script. The host owns a real `TextDocument`; the guest is a CodeMirror view of it. Nothing
 * here imports `vscode` or a node built-in, so the browser bundle takes the types without dragging
 * the host along.
 *
 * A block is named by its `hunkKey` string, never by a position: the journal revalidates the key
 * before it acts, and a stale key is a refresh rather than an overwrite.
 */

/** One change a guest edit made, in pre-transaction line/character coordinates. */
export interface FileReviewChange {
	fromLine: number;
	fromCh: number;
	toLine: number;
	toCh: number;
	/** The text the range held before the edit, with `\n` line endings; `''` for an insertion. */
	removed: string;
	/** The inserted text, with `\n` line endings. */
	text: string;
}

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

/**
 * The diff around the open document. The document's own text never travels in this message: the
 * `TextDocument` is the buffer, and the guest learns its content once and from replacement events.
 */
export interface FileReviewState {
	/** Display path: workspace-relative with forward slashes when it is inside the workspace. */
	path: string;
	reason: FileReviewReason;
	/** Why there is no diff, for the banner or empty state. */
	message: string;
	/** The accepted baseline; `''` when no diff can be drawn. */
	baseline: string;
	hunks: FileHunkView[];
	created: boolean;
	deleted: boolean;
	changedOutside: boolean;
	dirty: boolean;
	/** Too large or too different to diff block by block: the file is shown without a merge view. */
	truncated: boolean;
	/** Why block actions are off, or `''` when they are available. */
	blockedReason: string;
}

export type FileReviewHostMessage =
	| { type: 'document'; text: string; languageId: string; tabSize: number }
	| { type: 'state'; state: FileReviewState }
	| { type: 'dirty'; dirty: boolean }
	/** The document changed outside this editor: replace the buffer (history is reset on purpose). */
	| { type: 'replace'; text: string }
	| { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export type FileReviewGuestMessage =
	| { type: 'ready' }
	| { type: 'edit'; changes: FileReviewChange[]; length: number }
	| { type: 'save' }
	| { type: 'keepHunk'; hunk: string }
	| { type: 'undoHunk'; hunk: string }
	| { type: 'keepFile' }
	| { type: 'undoFile' }
	| { type: 'openText' }
	| { type: 'openDiff' };
