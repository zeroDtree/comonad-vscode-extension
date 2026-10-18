/**
 * Explicit @ references: the token grammar, its canonical formatter, and the ordering the mention
 * picker uses. Pure — no `vscode`, no `cordis`. Resolution lives in `ui/references`, which knows the
 * workspace and the session policy.
 *
 * Grammar:
 *   @path                     whole file
 *   @path:9 / @path:9-13      1-based inclusive line range
 *   @path/                    folder
 *   @symbol:path:Name         code symbol (the last colon outside quotes splits path/name)
 *   @"path with spaces"       quoted paths, CJK included
 *   \@literal                 escaped, not a reference
 */

export type ReferenceKind = 'file' | 'folder' | 'symbol';

export interface LineRange {
	start: number;
	end: number;
}

export interface ParsedReference {
	kind: ReferenceKind;
	/** Workspace-relative or absolute, unquoted, with the trailing slash removed for folders. */
	path: string;
	lines?: LineRange;
	/** Symbol name, dotted through its containers (`Auth.method`). */
	name?: string;
	/** Offset of the `@`. */
	start: number;
	/** Offset just past the trimmed token. */
	end: number;
}

export interface PositionLike {
	line: number;
	character: number;
}

export interface RangeLike {
	start: PositionLike;
	end: PositionLike;
}

/** The structural part of a `vscode.DocumentSymbol` this module needs. */
export interface SymbolLike {
	name: string;
	range: RangeLike;
	children?: readonly SymbolLike[];
}

const WORD_BEFORE = /[A-Za-z0-9_.@/\\-]/;
const SYMBOL_TAIL = /[.,;:!?，。；：！？]+$/;
const OTHER_TAIL = /[.,;:!?，。；：！？)\]}）】》」』]+$/;
const MAX_LIMIT = 200;

/** Whether a reference may start after this character. Emails, URLs and `\@` stay literal. */
export function canStartReference(previous: string | undefined): boolean {
	return previous === undefined || !WORD_BEFORE.test(previous);
}

/** Every reference occurrence in the text, in order. Never throws; malformed tokens are skipped. */
export function parseReferences(text: string): ParsedReference[] {
	const found: ParsedReference[] = [];
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== '@' || !canStartReference(index === 0 ? undefined : text[index - 1])) {
			continue;
		}
		const scanned = scanToken(text, index);
		if (!scanned) {
			continue;
		}
		const parsed = parseToken(scanned.raw);
		if (!parsed) {
			continue;
		}
		found.push({ ...parsed, start: index, end: scanned.end });
		index = scanned.end - 1;
	}
	return found;
}

/** The token that represents one reference, including the leading `@`. */
export function formatReference(reference: Omit<ParsedReference, 'start' | 'end'>): string {
	const path = quotePath(reference.path);
	if (reference.kind === 'symbol') {
		return `@symbol:${path}:${reference.name ?? ''}`;
	}
	const slash = reference.kind === 'folder' ? '/' : '';
	const lines = reference.lines
		? `:${reference.lines.start}${reference.lines.end === reference.lines.start ? '' : `-${reference.lines.end}`}`
		: '';
	return `@${path}${slash}${lines}`;
}

/** Whether a failed reference is worth reporting (a decorator or prose mention is not). */
export function looksLikePath(reference: ParsedReference): boolean {
	return (
		reference.kind !== 'file' ||
		reference.path.includes('/') ||
		reference.path.includes('.') ||
		reference.path.includes(':')
	);
}

/**
 * Query-ranked paths for the mention picker. Case-insensitive; a basename prefix beats a path
 * substring, which beats a subsequence. Empty queries stay in a stable path order.
 */
export function rankPaths(query: string, paths: readonly string[], limit = 25): string[] {
	const needle = query.trim().toLowerCase();
	const scored: { path: string; score: number[] }[] = [];
	for (const path of paths) {
		const lower = path.toLowerCase();
		const base = lower.split('/').pop() ?? lower;
		let score: number[] | null = null;
		if (!needle) {
			score = [lower.split('/').length, lower.length];
		} else if (base === needle) {
			score = [0, lower.length];
		} else if (base.startsWith(needle)) {
			score = [1, base.length, lower.length];
		} else {
			const at = lower.indexOf(needle);
			if (at >= 0) {
				score = [2, at, lower.length];
			} else {
				let matched = 0;
				let gaps = 0;
				for (let index = 0; index < lower.length && matched < needle.length; index += 1) {
					if (lower[index] === needle[matched]) {
						matched += 1;
					} else {
						gaps += 1;
					}
				}
				if (matched === needle.length) {
					score = [3, gaps, lower.length];
				}
			}
		}
		if (score) {
			scored.push({ path, score });
		}
	}
	scored.sort((left, right) => {
		const length = Math.min(left.score.length, right.score.length);
		for (let index = 0; index < length; index += 1) {
			if (left.score[index] !== right.score[index]) {
				return left.score[index]! - right.score[index]!;
			}
		}
		return left.path.localeCompare(right.path);
	});
	return scored.slice(0, Math.max(1, Math.min(limit, MAX_LIMIT))).map((entry) => entry.path);
}

/**
 * The smallest symbol range whose dotted name ends with `name` — a method inside a class beats the
 * class when both match the leaf name. Returns `undefined` when nothing matches.
 */
export function findSymbolRange(entries: readonly SymbolLike[], name: string): RangeLike | undefined {
	const wanted = name.split('.').filter(Boolean);
	if (!wanted.length) {
		return undefined;
	}
	let found: RangeLike | undefined;
	const visit = (symbols: readonly SymbolLike[], trail: readonly string[]): void => {
		for (const symbol of symbols) {
			const here = [...trail, symbol.name];
			if (here.length >= wanted.length && here.slice(here.length - wanted.length).join('.') === wanted.join('.')) {
				found = found ? smaller(symbol.range, found) : symbol.range;
			}
			if (symbol.children?.length) {
				visit(symbol.children, here);
			}
		}
	};
	visit(entries, []);
	return found;
}

function smaller(candidate: RangeLike, current: RangeLike): RangeLike {
	if (candidate.start.line !== current.start.line) {
		return candidate.start.line > current.start.line ? candidate : current;
	}
	if (candidate.start.character !== current.start.character) {
		return candidate.start.character > current.start.character ? candidate : current;
	}
	if (candidate.end.line !== current.end.line) {
		return candidate.end.line < current.end.line ? candidate : current;
	}
	return candidate.end.character <= current.end.character ? candidate : current;
}

interface Scanned {
	raw: string;
	end: number;
}

function scanToken(text: string, at: number): Scanned | null {
	const to = tokenEnd(text, at + 1);
	if (to <= at + 1) {
		return null;
	}
	const symbol = text.startsWith('symbol:', at + 1);
	const end = trimTokenEnd(text, at + 1, to, symbol);
	if (end <= at + 1) {
		return null;
	}
	return { raw: text.slice(at + 1, end), end };
}

function tokenEnd(text: string, from: number): number {
	const quote = quoteStart(text, from);
	if (quote !== undefined) {
		const read = readQuoted(text, quote);
		if (!read) {
			return from;
		}
		let index = read.end;
		while (index < text.length && !/\s/.test(text[index]!)) {
			index += 1;
		}
		return index;
	}
	let index = from;
	while (index < text.length && !/\s/.test(text[index]!)) {
		index += 1;
	}
	return index;
}

function trimTokenEnd(text: string, from: number, to: number, symbol: boolean): number {
	const quote = quoteStart(text, from);
	if (quote !== undefined) {
		const read = readQuoted(text, quote);
		if (!read) {
			return from;
		}
		const suffix = text.slice(read.end, to);
		const trimmed = symbol ? suffix.replace(SYMBOL_TAIL, '') : suffix.replace(OTHER_TAIL, '');
		return read.end + trimmed.length;
	}
	const raw = text.slice(from, to);
	const trimmed = symbol ? raw.replace(SYMBOL_TAIL, '') : raw.replace(OTHER_TAIL, '');
	return from + trimmed.length;
}

/** Where a quoted path starts, accounting for the `symbol:` prefix. */
function quoteStart(text: string, from: number): number | undefined {
	if (text[from] === '"') {
		return from;
	}
	if (text.startsWith('symbol:', from) && text[from + 7] === '"') {
		return from + 7;
	}
	return undefined;
}

function readQuoted(text: string, start: number): { value: string; end: number } | null {
	let value = '';
	let index = start + 1;
	while (index < text.length) {
		const char = text[index]!;
		if (char === '\\' && index + 1 < text.length) {
			const next = text[index + 1]!;
			if (next === '"' || next === '\\') {
				value += next;
				index += 2;
				continue;
			}
			value += '\\';
			index += 1;
			continue;
		}
		if (char === '"') {
			return { value, end: index + 1 };
		}
		value += char;
		index += 1;
	}
	return null;
}

function parseToken(raw: string): Omit<ParsedReference, 'start' | 'end'> | null {
	if (raw.startsWith('symbol:')) {
		const rest = raw.slice('symbol:'.length);
		if (!rest) {
			return null;
		}
		if (rest.startsWith('"')) {
			const read = readQuoted(rest, 0);
			if (!read || !read.value) {
				return null;
			}
			const after = rest.slice(read.end);
			if (!after.startsWith(':') || after.length === 1) {
				return null;
			}
			return { kind: 'symbol', path: read.value, name: after.slice(1) };
		}
		const split = rest.lastIndexOf(':');
		if (split <= 0 || split === rest.length - 1) {
			return null;
		}
		const path = rest.slice(0, split);
		const name = rest.slice(split + 1);
		return path && name ? { kind: 'symbol', path, name } : null;
	}
	if (raw.startsWith('"')) {
		const read = readQuoted(raw, 0);
		if (!read || !read.value) {
			return null;
		}
		let after = raw.slice(read.end);
		let folder = read.value.endsWith('/');
		if (after.startsWith('/')) {
			folder = true;
			after = after.slice(1);
		}
		if (folder) {
			if (after) {
				return null;
			}
			const path = read.value.replace(/\/+$/, '');
			return path ? { kind: 'folder', path } : null;
		}
		if (!after) {
			return { kind: 'file', path: read.value };
		}
		if (!after.startsWith(':')) {
			return null;
		}
		const lines = parseRange(after.slice(1));
		return lines ? { kind: 'file', path: read.value, lines } : null;
	}
	let path = raw;
	let lines: LineRange | undefined;
	const range = /:(\d+)(?:-(\d+))?$/.exec(raw);
	if (range) {
		lines = parseRange(`${range[1]}${range[2] ? `-${range[2]}` : ''}`);
		if (!lines) {
			return null;
		}
		path = raw.slice(0, range.index);
	}
	if (path.endsWith('/')) {
		if (lines) {
			return null;
		}
		path = path.replace(/\/+$/, '');
		return path ? { kind: 'folder', path } : null;
	}
	return path ? { kind: 'file', path, lines } : null;
}

function parseRange(text: string): LineRange | undefined {
	const match = /^(\d+)(?:-(\d+))?$/.exec(text);
	if (!match) {
		return undefined;
	}
	const start = Number(match[1]);
	const end = match[2] ? Number(match[2]) : start;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
		return undefined;
	}
	return { start, end };
}

function quotePath(path: string): string {
	if (!/[\s":]/.test(path) && !path.startsWith('symbol:')) {
		return path;
	}
	return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
