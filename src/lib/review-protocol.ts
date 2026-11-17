// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Review tab's message vocabulary: plain data shared by the extension host and the guest
 * script. Nothing here imports `vscode` or a node built-in, so the browser bundle takes the types
 * without dragging the host along.
 *
 * A hunk is named by its `hunkKey` string, never by an index: indices shift after every keep or
 * undo, while the key is what the journal itself revalidates before it acts.
 */

/** One rendered line of a file. `text` is display text, its line terminator removed. */
export interface ReviewRow {
	kind: 'context' | 'add' | 'del';
	text: string;
	/** 1-based line in the accepted baseline; `null` for an added line. */
	oldLine: number | null;
	/** 1-based line in the file on disk; `null` for a deleted line. */
	newLine: number | null;
	/** The line the real editor should reveal when this row is clicked; `null` for a gap. */
	targetLine: number | null;
}

/** A run of rows: unchanged context, an omitted gap, or one actionable change block. */
export type ReviewBlock =
	| { kind: 'context'; rows: ReviewRow[] }
	| { kind: 'gap'; omitted: number }
	| { kind: 'hunk'; key: string; header: string; targetLine: number; rows: ReviewRow[] };

/** One pending file as the sidebar sees it. */
export interface ReviewFileSummary {
	path: string;
	additions: number;
	deletions: number;
	created: boolean;
	deleted: boolean;
	changedOutside: boolean;
	dirty: boolean;
}

/** The selected file, with the rows the main pane draws. */
export interface ReviewFileView extends ReviewFileSummary {
	binary: boolean;
	truncated: boolean;
	blocks: ReviewBlock[];
	/** Hunks the page did not render because the file had too many. */
	more: number;
}

export interface ReviewState {
	reason: 'ready' | 'no-session' | 'no-changes' | 'error';
	message: string;
	sessionId: string | null;
	workspace: string | null;
	files: ReviewFileSummary[];
	activePath: string | null;
	active: ReviewFileView | null;
	/** Why the selected file could not be read, while the rest of the list stays usable. */
	activeError: string | null;
	totals: { files: number; additions: number; deletions: number };
	note: string;
}

export type ReviewHostMessage =
	| { type: 'state'; state: ReviewState }
	| { type: 'dirty'; paths: string[] }
	| { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export type ReviewGuestMessage =
	| { type: 'ready' }
	| { type: 'selectFile'; path: string }
	| { type: 'keepFile'; path: string }
	| { type: 'undoFile'; path: string }
	| { type: 'keepHunk'; path: string; hunk: string }
	| { type: 'undoHunk'; path: string; hunk: string }
	| { type: 'keepAll' }
	| { type: 'undoAll' }
	| { type: 'openFile'; path: string; line?: number }
	| { type: 'openDiff'; path: string };
