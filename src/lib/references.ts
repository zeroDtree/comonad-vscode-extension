// SPDX-License-Identifier: AGPL-3.0-only
import { pinyinOfPath, type PinyinMatch } from './pinyin';

/**
 * Explicit @ references: the token grammar, its canonical formatter, and the ordering the mention
 * picker uses. Pure — no `vscode`, no `cordis`. Resolution lives in `services/references`, which
 * knows the workspace and the session policy; the picker lives in `ui/mentions`.
 *
 * Grammar:
 *   @path                     whole file
 *   @path:9 / @path:9-13      1-based inclusive line range
 *   @path/                    folder
 *   @symbol:path:Name         code symbol (the last colon outside quotes splits path/name)
 *   @"path with spaces"       quoted paths, CJK included
 *   ＠path                    a Chinese IME's full-width at sign is the same reference
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
	/** Numeric range: lines for text, pages for a document; the resolver decides. */
	range?: LineRange;
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
const SYMBOL_TAIL = /[.,;:!?，。；：！？、…]+$/;
const OTHER_TAIL = /[.,;:!?，。；：！？、…)\]}）】》」』]+$/;
/** The first prose mark ends a picker query; brackets are not included so paths keep them. */
const QUERY_END = /[，。；：！？、,;!?…]/;
/** A CJK mark also ends an unquoted token in running prose; ASCII marks stay in the path. */
const TOKEN_END = /[，。；：！？、…]/;
const MAX_LIMIT = 200;

/** Whether a reference may start after this character. Emails, URLs and `\@` stay literal. */
export function canStartReference(previous: string | undefined): boolean {
	return previous === undefined || !WORD_BEFORE.test(previous);
}

/** A full-width `＠` is what several Chinese IMEs insert; it opens the same reference. */
function isAtSign(char: string | undefined): boolean {
	return char === '@' || char === '＠';
}

/** Every reference occurrence in the text, in order. Never throws; malformed tokens are skipped. */
export function parseReferences(text: string): ParsedReference[] {
	const found: ParsedReference[] = [];
	for (let index = 0; index < text.length; index += 1) {
		if (!isAtSign(text[index]) || !canStartReference(index === 0 ? undefined : text[index - 1])) {
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
	const range = reference.range
		? `:${reference.range.start}${reference.range.end === reference.range.start ? '' : `-${reference.range.end}`}`
		: '';
	return `@${path}${slash}${range}`;
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
 * NFC plus the width folding a Chinese IME forces on a user: `＠`, `／`, full-width Latin and
 * digits become their ASCII forms, and one ideographic space becomes a normal space. Lowercased.
 */
export function fold(text: string): string {
	return text
		.normalize('NFC')
		.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
		.replace(/　/g, ' ')
		.toLowerCase();
}

/**
 * The picker's query: trimmed, cut at the first prose mark, then folded. The cut comes first
 * because folding turns `：` into `:`, after which it could no longer be told apart from a real
 * line-range or `symbol:` colon.
 */
export function normalizeQuery(text: string): string {
	const trimmed = text.trim();
	const cut = trimmed.search(QUERY_END);
	return fold(cut < 0 ? trimmed : trimmed.slice(0, cut)).trim();
}

/** One picker candidate, pre-folded (and with pinyin when its name has Han) for repeated queries. */
export interface PathEntry {
	/** The path exactly as it is written into the composer. */
	path: string;
	/** Folded path, used for literal matching. */
	lower: string;
	/** Folded basename, used for the stronger literal tiers. */
	base: string;
	/** Pinyin haystacks; `undefined` when the path has no Han character. */
	pinyin?: PinyinMatch;
}

/** Build the reusable form of one path. */
export function pathEntry(path: string): PathEntry {
	const lower = fold(path);
	return {
		path,
		lower,
		base: lower.slice(lower.lastIndexOf('/') + 1),
		pinyin: pinyinOfPath(path),
	};
}

/**
 * Query-ranked entries for the mention picker. Literal matches always outrank pinyin ones: exact
 * basename, basename prefix, path substring, then pinyin (exact/full prefix, basename initials,
 * initials at a path-segment boundary, full substring), and the character subsequence last.
 * Initials sit above a full substring because short ASCII queries otherwise hit syllable
 * boundaries inside unrelated names (`gy` inside `yongyou`). Empty queries stay in path order.
 */
export function rankEntries(query: string, entries: readonly PathEntry[], limit = 25): PathEntry[] {
	const needle = normalizeQuery(query);
	// A pinyin haystack is ASCII, so only a pure ASCII query with a letter can use one, and a
	// single letter is too noisy to be worth it.
	const withPinyin = needle.length >= 2 && /^[a-z0-9]+$/.test(needle) && /[a-z]/.test(needle);
	const scored: { entry: PathEntry; score: number[] }[] = [];
	for (const entry of entries) {
		const lower = entry.lower;
		const base = entry.base;
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
				if (withPinyin && entry.pinyin) {
					score = rankPinyin(needle, entry);
				}
				if (!score) {
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
						score = [8, gaps, lower.length];
					}
				}
			}
		}
		if (score) {
			scored.push({ entry, score });
		}
	}
	scored.sort((left, right) => {
		const length = Math.min(left.score.length, right.score.length);
		for (let index = 0; index < length; index += 1) {
			if (left.score[index] !== right.score[index]) {
				return left.score[index]! - right.score[index]!;
			}
		}
		return left.entry.path.localeCompare(right.entry.path);
	});
	return scored.slice(0, Math.max(1, Math.min(limit, MAX_LIMIT))).map((entry) => entry.entry);
}

/** The pinyin tiers for one entry, or `null` when its haystacks do not contain the query. */
function rankPinyin(needle: string, entry: PathEntry): number[] | null {
	const pinyin = entry.pinyin;
	if (!pinyin) {
		return null;
	}
	const baseFull = pinyin.full.slice(pinyin.full.lastIndexOf('/') + 1);
	const baseInitials = pinyin.initials.slice(pinyin.initials.lastIndexOf('/') + 1);
	if (baseFull === needle) {
		return [3, pinyin.full.length];
	}
	if (baseFull.startsWith(needle)) {
		return [4, baseFull.length, entry.lower.length];
	}
	if (baseInitials.startsWith(needle)) {
		return [5, baseInitials.length, entry.lower.length];
	}
	const segment = pinyin.initials.split('/').find((part) => part.startsWith(needle));
	if (segment !== undefined) {
		return [6, pinyin.initials.indexOf(segment), entry.lower.length];
	}
	const at = pinyin.full.indexOf(needle);
	return at < 0 ? null : [7, at, entry.lower.length];
}

/**
 * Query-ranked paths for the mention picker; the path-string form of {@link rankEntries}. The
 * picker itself ranks pre-built entries so a keystroke does not refold every path.
 */
export function rankPaths(query: string, paths: readonly string[], limit = 25): string[] {
	return rankEntries(query, paths.map(pathEntry), limit).map((entry) => entry.path);
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
		while (index < text.length && !/\s/.test(text[index]!) && !TOKEN_END.test(text[index]!)) {
			index += 1;
		}
		return index;
	}
	// Chinese prose puts "，接下来" right after a name with no space, so an unquoted token also
	// ends at a CJK prose mark. ASCII marks keep their old tail-only rule (a quoted name can carry
	// any of them), and `:` / `.` stay inside the path for ranges and extensions.
	let index = from;
	while (index < text.length && !/\s/.test(text[index]!) && !TOKEN_END.test(text[index]!)) {
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
		const parsedRange = parseRange(after.slice(1));
		return parsedRange ? { kind: 'file', path: read.value, range: parsedRange } : null;
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
	return path ? { kind: 'file', path, range: lines } : null;
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
