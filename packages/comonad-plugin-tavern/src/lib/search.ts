import Fuse, { type IFuseOptions } from 'fuse.js';
import type { WorldEntry } from './types';

/**
 * Searching and ordering the entry list of a world book, the way SillyTavern's own panel does it.
 *
 * The rules are upstream's: searching scores the entries and shows only the hits, the sort select
 * offers the same choices, and every rule that does not say otherwise falls back to descending
 * `order` and then ascending `uid`, so the list never reshuffles between two equal sorts. Scoring
 * itself is Fuse.js with upstream's options and field weights, so the same query ranks an entry the
 * same way in both panels. Pure module: no `vscode`, no `cordis`.
 */

/** One choice of the sort select. `rule` names the special cases; `field`/`order` the plain ones. */
export interface SortRule {
	value: string;
	label: string;
	rule?: 'priority' | 'custom' | 'search' | 'length';
	field?: keyof WorldEntry;
	order?: 'asc' | 'desc';
}

export const DEFAULT_SORT: SortRule = { value: 'priority', label: 'Priority', rule: 'priority' };

/** The sort select, in SillyTavern's order and with its labels. */
export const SORT_RULES: readonly SortRule[] = [
	DEFAULT_SORT,
	{ value: 'custom', label: 'Custom', rule: 'custom' },
	{ value: 'comment-asc', label: 'Title A-Z', field: 'comment', order: 'asc' },
	{ value: 'comment-desc', label: 'Title Z-A', field: 'comment', order: 'desc' },
	// Upstream labels these "Tokens" but compares the content length: no tokenizer is needed there.
	{ value: 'tokens-asc', label: 'Tokens ↗', rule: 'length', field: 'content', order: 'asc' },
	{ value: 'tokens-desc', label: 'Tokens ↘', rule: 'length', field: 'content', order: 'desc' },
	{ value: 'depth-asc', label: 'Depth ↗', field: 'depth', order: 'asc' },
	{ value: 'depth-desc', label: 'Depth ↘', field: 'depth', order: 'desc' },
	{ value: 'order-asc', label: 'Order ↗', field: 'order', order: 'asc' },
	{ value: 'order-desc', label: 'Order ↘', field: 'order', order: 'desc' },
	{ value: 'uid-asc', label: 'UID ↗', field: 'uid', order: 'asc' },
	{ value: 'uid-desc', label: 'UID ↘', field: 'uid', order: 'desc' },
	{ value: 'probability-asc', label: 'Trigger% ↗', field: 'probability', order: 'asc' },
	{ value: 'probability-desc', label: 'Trigger% ↘', field: 'probability', order: 'desc' },
];

/** The rule the search box forces while a query is typed, as upstream switches the select over. */
export const SEARCH_SORT: SortRule = { value: 'search', label: 'Search', rule: 'search' };

export function ruleOf(value: string): SortRule {
	return SORT_RULES.find((rule) => rule.value === value) ?? DEFAULT_SORT;
}

/**
 * The fields a query is matched against and their weights — upstream's own list, verbatim, so that a
 * search here and a search in SillyTavern's panel rank an entry the same way. `uid` and `automationId`
 * are not prose, but Fuse stringifies whatever it finds.
 */
const WI_KEYS: Array<{ name: keyof WorldEntry; weight: number }> = [
	{ name: 'key', weight: 20 },
	{ name: 'group', weight: 15 },
	{ name: 'comment', weight: 10 },
	{ name: 'keysecondary', weight: 10 },
	{ name: 'content', weight: 3 },
	{ name: 'uid', weight: 1 },
	{ name: 'automationId', weight: 1 },
];

/**
 * Upstream's own options, verbatim. `useExtendedSearch` is what makes the box understand `'exact`,
 * `!not` and `^prefix`, and `threshold` is how far a fuzzy match may stray before it is dropped.
 */
const WI_FUSE: IFuseOptions<WorldEntry> = {
	keys: WI_KEYS,
	includeScore: true,
	ignoreLocation: true,
	useExtendedSearch: true,
	threshold: 0.2,
};

/**
 * The hits for a query, as `uid → score`, with Fuse's own sense of a score: **lower is better**, and
 * `0` is an exact hit. An entry that is not a hit at all is simply absent from the map.
 */
export function searchEntries(entries: readonly WorldEntry[], query: string): Map<number, number> {
	const scores = new Map<number, number>();
	const text = query.trim();
	if (!text || !entries.length) {
		return scores;
	}
	const fuse = new Fuse([...entries], WI_FUSE);
	for (const result of fuse.search(text)) {
		scores.set(result.item.uid, result.score ?? 1);
	}
	return scores;
}

/** Constant first, then ordinary entries, then the disabled ones — upstream's "Priority". */
function priorityRank(entry: WorldEntry): number {
	return entry.disable ? 2 : entry.constant ? 0 : 1;
}

function compare(rule: SortRule, scores: Map<number, number> | undefined): (left: WorldEntry, right: WorldEntry) => number {
	if (rule.rule === 'search') {
		// Fuse's score is a distance, so the smallest is the best hit; an entry with no score at all
		// sorts last, which is all a negated term can leave behind.
		return (left, right) => (scores?.get(left.uid) ?? 1) - (scores?.get(right.uid) ?? 1);
	}
	if (rule.rule === 'priority') {
		return (left, right) => priorityRank(left) - priorityRank(right);
	}
	if (rule.rule === 'custom') {
		return (left, right) => (left.displayIndex ?? left.uid) - (right.displayIndex ?? right.uid);
	}
	const field = rule.field ?? 'uid';
	const sign = rule.order === 'asc' ? 1 : -1;
	return (left, right) => {
		const first = left[field];
		const second = right[field];
		if (rule.rule === 'length') {
			return sign * (String(first ?? '').length - String(second ?? '').length);
		}
		if (typeof first === 'string' && typeof second === 'string') {
			return sign * first.localeCompare(second);
		}
		return sign * (Number(first ?? 0) - Number(second ?? 0));
	};
}

/**
 * The entries in display order. `scores` is what `searchEntries` returned, and only the search rule
 * needs it; every rule keeps SillyTavern's fallbacks (descending `order`, then ascending `uid`).
 */
export function sortEntries(
	entries: readonly WorldEntry[],
	rule: SortRule,
	scores?: Map<number, number>,
): WorldEntry[] {
	const primary = compare(rule, scores);
	return [...entries].sort(
		(left, right) =>
			primary(left, right) || (right.order ?? 100) - (left.order ?? 100) || left.uid - right.uid,
	);
}

/** The uids the pane should show, which is the search hits or everything. */
export function visibleEntries(entries: readonly WorldEntry[], query: string, sort: string): WorldEntry[] {
	const text = query.trim();
	const scores = text ? searchEntries(entries, text) : undefined;
	const rule = text ? SEARCH_SORT : ruleOf(sort);
	const pool = scores ? entries.filter((entry) => scores.has(entry.uid)) : [...entries];
	return sortEntries(pool, rule, scores);
}
