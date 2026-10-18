// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Line-level diffs, for the editor's inline review.
 *
 * `git diff` tells the journal what changed in a file; this module turns two texts into the blocks a
 * person accepts or undoes one at a time. Pure: no `vscode`, no `cordis`.
 *
 * Line numbers follow unified-diff conventions so a hunk reads like the `git diff` output it will be
 * compared with: `oldStart` is 1-based when `oldLines > 0`, and the number of lines *before* the
 * insertion when `oldLines === 0` (`0` means "before the first line"). The same for the new side.
 * Line texts keep their terminators, so `applyHunk`/`revertHunk` reproduce a file byte for byte —
 * including CRLF and a missing final newline.
 */

/** One line of a hunk, with the line number it carries on its own side. */
export interface HunkLine {
	type: 'add' | 'del';
	/** The line as it reads in its own file, terminator included. */
	text: string;
	/** 1-based line number in the old file (for `del`) or the new one (for `add`). */
	line: number;
}

/** One contiguous block of changes: what a single Keep/Undo acts on. */
export interface LineHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: HunkLine[];
}

export interface DiffOptions {
	/** Above this edit distance the result is one whole-file hunk and `truncated` is set. */
	maxEditDistance?: number;
	/** Above this many lines on either side the same fallback applies. */
	maxLines?: number;
	/** Above this many bytes across both texts the same fallback applies. */
	maxBytes?: number;
}

export interface DiffResult {
	hunks: LineHunk[];
	/** The texts were too large or too different to diff block by block. */
	truncated: boolean;
}

const DEFAULT_MAX_EDIT_DISTANCE = 2_000;
const DEFAULT_MAX_LINES = 20_000;
const DEFAULT_MAX_BYTES = 1_500_000;

/**
 * Splits text into lines that keep their terminators. `''` is no lines, `'a\n'` is one line, `'a'` is
 * one line — and joining the result always returns the original string exactly.
 */
export function splitLines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** A line without its terminator, for text that is joined with an editor's own EOL. */
export function stripEol(line: string): string {
	return line.replace(/\r?\n$/, '');
}

/** The text a hunk removes from the old file, and the text it puts there instead. */
function sides(hunk: LineHunk): { old: string[]; new: string[] } {
	const old: string[] = [];
	const added: string[] = [];
	for (const line of hunk.lines) {
		(line.type === 'del' ? old : added).push(line.text);
	}
	return { old, new: added };
}

/** A stable identity for a hunk, used to refuse acting on a block the file no longer has. */
export function hunkKey(hunk: LineHunk): string {
	return JSON.stringify([hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines, sides(hunk)]);
}

/**
 * The change blocks between two texts. A hunk is a maximal run of additions and deletions, so two
 * edits separated by even one unchanged line are two blocks — which is the granularity the inline
 * review offers.
 */
export function diffLines(oldText: string, newText: string, options: DiffOptions = {}): DiffResult {
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	if (oldLines.length > maxLines || newLines.length > maxLines || oldText.length + newText.length > maxBytes) {
		return { hunks: wholeFile(oldLines, newLines), truncated: true };
	}
	const ops = shortestEdit(oldLines, newLines, options.maxEditDistance ?? DEFAULT_MAX_EDIT_DISTANCE);
	if (!ops) {
		return { hunks: wholeFile(oldLines, newLines), truncated: true };
	}
	return { hunks: group(ops), truncated: false };
}

/** Patches the old side of a hunk with its new side — keeping a block moves the baseline forward. */
export function applyHunk(oldText: string, hunk: LineHunk): string {
	const lines = splitLines(oldText);
	const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
	verify(lines, start, hunk.oldLines, sides(hunk).old, hunk);
	lines.splice(start, hunk.oldLines, ...sides(hunk).new);
	return lines.join('');
}

/** Patches the new side back to the old one — undoing a block restores it on disk. */
export function revertHunk(newText: string, hunk: LineHunk): string {
	const lines = splitLines(newText);
	const start = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
	verify(lines, start, hunk.newLines, sides(hunk).new, hunk);
	lines.splice(start, hunk.newLines, ...sides(hunk).old);
	return lines.join('');
}

/**
 * The edit that reverts one hunk in an open document, as text offsets. Offsets rather than positions
 * because the last line and a missing final newline are exactly where line arithmetic goes wrong.
 */
export function editForHunk(documentText: string, eol: string, hunk: LineHunk): { start: number; end: number; text: string } {
	const lines = splitLines(documentText);
	const startLine = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
	let start = 0;
	for (let index = 0; index < startLine; index += 1) {
		start += lines[index]?.length ?? 0;
	}
	let end = start;
	for (let index = startLine; index < startLine + hunk.newLines; index += 1) {
		end += lines[index]?.length ?? 0;
	}
	const removed = documentText.slice(start, end);
	const raw = sides(hunk).old;
	const insert = raw.map(stripEol);
	let text = insert.join(eol);
	if (insert.length) {
		if (end < documentText.length) {
			// Content follows: the restored block must end its last line.
			text += eol;
		} else if (raw[raw.length - 1]?.endsWith('\n')) {
			// At the end of the file: the restored line's own final-newline state decides.
			text += eol;
		}
	}
	if (!removed && insert.length && start > 0 && !documentText.slice(0, start).endsWith('\n')) {
		// Inserting at the end of a file whose last line has no newline: the new line needs one before it.
		text = eol + text;
	}
	return { start, end, text };
}

/** One hunk that replaces the whole file: the fallback when a per-block diff would be too costly. */
function wholeFile(oldLines: string[], newLines: string[]): LineHunk[] {
	const oldText = oldLines.join('');
	const newText = newLines.join('');
	if (oldText === newText) {
		return [];
	}
	const lines: HunkLine[] = [
		...oldLines.map((text, index) => ({ type: 'del' as const, text, line: index + 1 })),
		...newLines.map((text, index) => ({ type: 'add' as const, text, line: index + 1 })),
	];
	return [
		{
			oldStart: oldLines.length ? 1 : 0,
			oldLines: oldLines.length,
			newStart: newLines.length ? 1 : 0,
			newLines: newLines.length,
			lines,
		},
	];
}

/** Groups consecutive non-equal operations into hunks, numbering both sides as it goes. */
function group(ops: Op[]): LineHunk[] {
	const hunks: LineHunk[] = [];
	let oldLine = 1;
	let newLine = 1;
	let index = 0;
	while (index < ops.length) {
		const op = ops[index]!;
		if (op.type === 'equal') {
			oldLine += 1;
			newLine += 1;
			index += 1;
			continue;
		}
		const oldStart = oldLine;
		const newStart = newLine;
		const lines: HunkLine[] = [];
		let oldLines = 0;
		let newLines = 0;
		while (index < ops.length && ops[index]!.type !== 'equal') {
			const changed = ops[index]!;
			if (changed.type === 'del') {
				lines.push({ type: 'del', text: changed.text, line: oldLine });
				oldLine += 1;
				oldLines += 1;
			} else {
				lines.push({ type: 'add', text: changed.text, line: newLine });
				newLine += 1;
				newLines += 1;
			}
			index += 1;
		}
		hunks.push({
			// Unified-diff convention: a side with no lines names the line before the insertion.
			oldStart: oldLines ? oldStart : oldStart - 1,
			oldLines,
			newStart: newLines ? newStart : newStart - 1,
			newLines,
			lines,
		});
	}
	return hunks;
}

type Op = { type: 'equal' | 'del' | 'add'; text: string };

/**
 * Myers' shortest edit script, with the trace kept so it can be walked backwards. `null` when the
 * distance passes `cap`: the caller then treats the file as one block instead of paying for a diff
 * it cannot show block by block anyway.
 */
function shortestEdit(a: string[], b: string[], cap: number): Op[] | null {
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, cap);
	const offset = n + m + 1;
	const v = new Int32Array(2 * (n + m) + 3);
	v[offset + 1] = 0;
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d += 1) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
				x = v[offset + k + 1]!;
			} else {
				x = v[offset + k - 1]! + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x += 1;
				y += 1;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				return backtrack(trace, a, b, d, offset);
			}
		}
	}
	return null;
}

/** Walks the trace from the end of both texts back to the start. */
function backtrack(trace: Int32Array[], a: string[], b: string[], distance: number, offset: number): Op[] {
	const ops: Op[] = [];
	let x = a.length;
	let y = b.length;
	for (let d = distance; d > 0; d -= 1) {
		const v = trace[d]!;
		const k = x - y;
		const previous = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
		const previousX = v[offset + previous]!;
		const previousY = previousX - previous;
		while (x > previousX && y > previousY) {
			ops.push({ type: 'equal', text: a[x - 1]! });
			x -= 1;
			y -= 1;
		}
		if (x === previousX) {
			ops.push({ type: 'add', text: b[y - 1]! });
			y -= 1;
		} else {
			ops.push({ type: 'del', text: a[x - 1]! });
			x -= 1;
		}
	}
	while (x > 0 && y > 0) {
		ops.push({ type: 'equal', text: a[x - 1]! });
		x -= 1;
		y -= 1;
	}
	while (x > 0) {
		ops.push({ type: 'del', text: a[x - 1]! });
		x -= 1;
	}
	while (y > 0) {
		ops.push({ type: 'add', text: b[y - 1]! });
		y -= 1;
	}
	return ops.reverse();
}

/** Refuses a hunk whose lines are not where it says they are — a stale block, or the wrong file. */
function verify(lines: string[], start: number, count: number, expected: string[], hunk: LineHunk): void {
	const actual = lines.slice(start, start + count);
	if (actual.length !== count || actual.some((line, index) => line !== expected[index])) {
		throw new Error(`the file no longer matches this change (${hunk.oldLines}→${hunk.newLines} lines)`);
	}
}
