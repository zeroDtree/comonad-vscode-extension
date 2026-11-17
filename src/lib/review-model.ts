// SPDX-License-Identifier: AGPL-3.0-only
import type { FileChange, JournalFile } from './journal';
import { hunkKey, splitLines, stripEol, type LineHunk } from './line-diff';
import type { ReviewBlock, ReviewFileSummary, ReviewFileView, ReviewRow, ReviewState } from './review-protocol';

/**
 * The Review tab's view model. It turns the journal's two shapes — the per-file listing and one
 * file's line change — into the plain rows a webview can draw. Pure: no `vscode`, no `node:*`.
 *
 * Context is three lines, with a `gap` block where more was omitted. The algorithm walks both sides
 * by line number instead of trusting array positions, so CRLF, a missing final newline, a pure
 * insertion and a pure deletion all read the same way the unified diff would.
 */

export const REVIEW_CONTEXT = 3;
/** More blocks than this are left to the file's own diff tab: a page nobody can scan. */
export const MAX_REVIEW_HUNKS = 400;

/** The sidebar's view of a pending file. */
export function fileSummary(file: JournalFile): ReviewFileSummary {
	return {
		path: file.path,
		additions: file.additions,
		deletions: file.deletions,
		created: file.created,
		deleted: file.deleted,
		changedOutside: file.changedOutside,
		dirty: file.dirty,
	};
}

/** The hunk a key names, or `undefined` when the file no longer has that block. */
export function findHunk(change: FileChange | undefined, key: string): LineHunk | undefined {
	return change?.hunks.find((hunk) => hunkKey(hunk) === key);
}

/** One file's rows: context, gaps and actionable hunk blocks. */
export function reviewBlocks(change: FileChange, context = REVIEW_CONTEXT): { blocks: ReviewBlock[]; more: number } {
	if (change.binary || change.truncated) {
		return { blocks: [], more: 0 };
	}
	const lines = splitLines(change.current);
	const hunks = change.hunks.slice(0, MAX_REVIEW_HUNKS);
	if (!hunks.length) {
		return { blocks: [], more: 0 };
	}
	const blocks: ReviewBlock[] = [];
	let oldCursor = 1;
	let newCursor = 1;

	const contextRows = (fromNew: number, toNew: number, delta: number): ReviewRow[] => {
		const rows: ReviewRow[] = [];
		const last = Math.min(toNew, lines.length);
		for (let newLine = Math.max(1, fromNew); newLine <= last; newLine += 1) {
			rows.push({
				kind: 'context',
				text: stripEol(lines[newLine - 1] ?? ''),
				oldLine: newLine + delta,
				newLine,
				targetLine: newLine,
			});
		}
		return rows;
	};

	const region = (fromNew: number, toNew: number, placement: 'leading' | 'middle' | 'trailing', delta: number): void => {
		const count = Math.min(toNew, lines.length) - fromNew + 1;
		if (count <= 0) {
			return;
		}
		// A leading or trailing region needs only the lines nearest the change; between two changes
		// both edges are near one, so twice the budget is still all context.
		const shown = placement === 'middle' ? context * 2 : context;
		if (count <= shown) {
			const rows = contextRows(fromNew, toNew, delta);
			if (rows.length) {
				blocks.push({ kind: 'context', rows });
			}
			return;
		}
		if (placement === 'leading') {
			blocks.push({ kind: 'gap', omitted: count - context });
			const rows = contextRows(toNew - context + 1, toNew, delta);
			if (rows.length) {
				blocks.push({ kind: 'context', rows });
			}
			return;
		}
		if (placement === 'trailing') {
			const rows = contextRows(fromNew, fromNew + context - 1, delta);
			if (rows.length) {
				blocks.push({ kind: 'context', rows });
			}
			blocks.push({ kind: 'gap', omitted: count - context });
			return;
		}
		const before = contextRows(fromNew, fromNew + context - 1, delta);
		if (before.length) {
			blocks.push({ kind: 'context', rows: before });
		}
		blocks.push({ kind: 'gap', omitted: count - context * 2 });
		const after = contextRows(toNew - context + 1, toNew, delta);
		if (after.length) {
			blocks.push({ kind: 'context', rows: after });
		}
	};

	for (const [index, hunk] of hunks.entries()) {
		const firstNew = hunk.newLines > 0 ? hunk.newStart : hunk.newStart + 1;
		region(newCursor, firstNew - 1, index === 0 ? 'leading' : 'middle', oldCursor - newCursor);
		const anchor = hunk.newLines > 0 ? hunk.newStart : Math.max(1, hunk.newStart);
		const rows: ReviewRow[] = hunk.lines.map((line) =>
			line.type === 'del'
				? { kind: 'del', text: stripEol(line.text), oldLine: line.line, newLine: null, targetLine: anchor }
				: { kind: 'add', text: stripEol(line.text), oldLine: null, newLine: line.line, targetLine: line.line },
		);
		blocks.push({
			kind: 'hunk',
			key: hunkKey(hunk),
			header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
			targetLine: anchor,
			rows,
		});
		oldCursor = hunk.oldLines ? hunk.oldStart + hunk.oldLines : hunk.oldStart + 1;
		newCursor = hunk.newLines ? hunk.newStart + hunk.newLines : hunk.newStart + 1;
	}
	region(newCursor, lines.length, 'trailing', oldCursor - newCursor);
	return { blocks, more: change.hunks.length - hunks.length };
}

/** The selected file's view, with its summary when the listing still has one. */
export function fileView(change: FileChange, summary: ReviewFileSummary | undefined): ReviewFileView {
	const { blocks, more } = reviewBlocks(change);
	return {
		...(summary ?? {
			path: change.path,
			additions: 0,
			deletions: 0,
			created: change.created,
			deleted: change.deleted,
			changedOutside: change.changedOutside,
			dirty: false,
		}),
		binary: change.binary,
		truncated: change.truncated,
		blocks,
		more,
	};
}

export interface ReviewStateInput {
	sessionId: string | null;
	workspace: string | null;
	available: boolean;
	files: ReviewFileSummary[];
	activePath: string | null;
	active: FileChange | null;
	activeError?: string | null;
	/** The listing itself could not be read. */
	error?: string | null;
	note: string;
}

/** The whole state the guest draws, with a selection that always names a file that still exists. */
export function reviewState(input: ReviewStateInput): ReviewState {
	const paths = new Set(input.files.map((file) => file.path));
	const activePath = input.activePath && paths.has(input.activePath) ? input.activePath : (input.files[0]?.path ?? null);
	const summary = activePath ? input.files.find((file) => file.path === activePath) : undefined;
	const active = activePath && summary && input.active?.path === activePath ? fileView(input.active, summary) : null;
	const totals = input.files.reduce(
		(total, file) => ({
			files: total.files + 1,
			additions: total.additions + file.additions,
			deletions: total.deletions + file.deletions,
		}),
		{ files: 0, additions: 0, deletions: 0 },
	);
	const reason: ReviewState['reason'] = input.error
		? 'error'
		: !input.sessionId || !input.workspace
			? 'no-session'
			: input.files.length
				? 'ready'
				: 'no-changes';
	const message = input.error
		? input.error
		: reason === 'no-session'
			? 'Open a Comonad chat to review the files it writes.'
			: reason === 'no-changes'
				? input.available
					? 'No pending changes.'
					: 'This chat has not written any files.'
				: '';
	return {
		reason,
		message,
		sessionId: input.sessionId,
		workspace: input.workspace,
		files: input.files,
		activePath,
		active,
		activeError: input.activeError ?? null,
		totals,
		note: input.note,
	};
}
