// SPDX-License-Identifier: AGPL-3.0-only
import type { FileChange } from './journal';
import { hunkKey, type LineHunk } from './line-diff';
import type { FileHunkView, FileReviewState } from './file-review-protocol';

/**
 * The File Review tab's view model. `review-model.ts` cuts a file down to the rows worth reading;
 * this surface shows the file whole, so it needs only the hunk anchors the guest cannot compute:
 * where each block's Keep/Undo bar sits, and why the actions are off when they are.
 *
 * Pure: no `vscode`, no node built-in — the browser bundle imports the same helpers.
 */

/**
 * The 0-based line just below a block, the anchor a block's controls sit under: a block that adds
 * lines ends after its last new line, and a pure deletion sits before the line that followed it.
 * The result may equal the file's line count, meaning "after the last line"; the guest clamps.
 */
export function hunkAnchorLine(hunk: LineHunk): number {
	return hunk.newLines > 0 ? hunk.newStart - 1 + hunk.newLines : hunk.newStart;
}

/** Every block as the guest draws it, keyed the way the journal revalidates it. */
export function hunkViews(hunks: LineHunk[]): FileHunkView[] {
	return hunks.map((hunk) => {
		let additions = 0;
		let deletions = 0;
		for (const line of hunk.lines) {
			if (line.type === 'add') {
				additions += 1;
			} else {
				deletions += 1;
			}
		}
		return {
			key: hunkKey(hunk),
			anchorLine: hunkAnchorLine(hunk),
			oldStart: hunk.oldStart,
			oldLines: hunk.oldLines,
			newStart: hunk.newStart,
			newLines: hunk.newLines,
			additions,
			deletions,
		};
	});
}

/** Why a block cannot be acted on, in the same order and words the Review tab uses. */
export function fileReviewBlocked(change: FileChange, dirty: boolean): string {
	if (dirty) {
		return 'Save the file first';
	}
	if (change.binary) {
		return 'Binary file';
	}
	if (change.truncated) {
		return 'Too large for block actions';
	}
	return '';
}

/**
 * One pending file as the tab draws it. The document's text is not part of the state: the host's
 * `TextDocument` is the buffer. Binary content never reaches the guest as text.
 */
export function fileReviewState(change: FileChange, dirty: boolean): FileReviewState {
	const truncated = change.truncated;
	if (change.binary) {
		return {
			path: change.path,
			reason: 'binary',
			message: 'Binary file — use Open in Editor, Open Diff, Keep File or Undo File.',
			baseline: '',
			hunks: [],
			created: change.created,
			deleted: change.deleted,
			changedOutside: change.changedOutside,
			dirty,
			truncated,
			blockedReason: fileReviewBlocked(change, dirty),
		};
	}
	return {
		path: change.path,
		reason: 'ready',
		message: '',
		// A truncated diff falls back to the whole file; there is nothing to compare against.
		baseline: truncated ? '' : change.baseline,
		hunks: truncated ? [] : hunkViews(change.hunks),
		created: change.created,
		deleted: change.deleted,
		changedOutside: change.changedOutside,
		dirty,
		truncated,
		blockedReason: fileReviewBlocked(change, dirty),
	};
}

/** The tab with no diff to draw: no session, nothing pending, a read failure or an oversized file. */
export function fileReviewIdle(path: string, reason: 'no-pending' | 'too-large' | 'error', message: string): FileReviewState {
	return {
		path,
		reason,
		message,
		baseline: '',
		hunks: [],
		created: false,
		deleted: false,
		changedOutside: false,
		dirty: false,
		truncated: false,
		blockedReason: reason === 'no-pending' ? 'Nothing pending' : reason === 'too-large' ? 'Too large' : 'Unavailable',
	};
}
