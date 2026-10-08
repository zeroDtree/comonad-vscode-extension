import { estimateTokens } from '../prompt';
import { WI_LOGIC, WI_POSITION, WI_ROLE, WI_STRATEGY, worldEntry, type GenerationTrigger, type WiRole, type WorldBook, type WorldEntry, type WorldInfoSettings } from './types';

/**
 * The world-info engine: which entries a message activates, and where they go in the prompt.
 *
 * The shape follows SillyTavern's scan closely — books are ordered chat → persona → character and
 * global, entries inside a book by descending `order`, a scan text built from the last few messages
 * (plus the card and persona fields an entry asks for), primary keys then secondary keys under the
 * entry's logic, timed effects, recursion, groups, and a token budget as a percentage of the
 * context. Results come back bucketed by position so the assembler only has to place them.
 */

export type LoreBookKind = 'chat' | 'persona' | 'character' | 'global';

export interface LoreBook {
	name: string;
	kind: LoreBookKind;
	book: WorldBook;
}

/** One scanned message. `speaker` is used when the settings ask for names in the scan text. */
export interface LoreMessage {
	speaker?: string;
	text: string;
}

/** The card and persona fields an entry may ask to be matched against. */
export interface LoreFields {
	persona?: string;
	description?: string;
	personality?: string;
	depthPrompt?: string;
	scenario?: string;
	creatorNotes?: string;
}

/**
 * How long an entry stays active, remembered per chat across scans. The bounds are half-open, as
 * SillyTavern's are: a window stored at turn `T` for length `N` holds while `turn < T + N`.
 */
export interface TimedEffect {
	activatedAt: number;
	stickyUntil?: number;
	cooldownUntil?: number;
}

export type TimedEffects = Record<string, TimedEffect>;

export interface LoreInput {
	books: readonly LoreBook[];
	/** Newest first, as SillyTavern passes them. */
	messages: readonly LoreMessage[];
	fields?: LoreFields;
	/**
	 * The character the chat speaks as, for an entry's own character/tag filter. `name` is the card's
	 * id — the file name it was read from, which is SillyTavern's avatar name, the value its own
	 * character filter compares against.
	 */
	character?: { name?: string; tags?: string[] };
	settings: WorldInfoSettings;
	/** The model's context size in tokens: `settings.budget` is a percentage of it. */
	contextSize: number;
	/** The scan index: the chat length in messages, which is what upstream's windows count in. */
	turn: number;
	/** What started this generation, for an entry tied to one of upstream's generation types. */
	trigger?: GenerationTrigger;
	/**
	 * Entries the vector search found, as `<book>.<uid>`. Upstream keeps these in the same scan buffer
	 * and consults them where `@@dont_activate` is honoured, so a vectorized entry is activated without
	 * its keys being read. Key matching still applies to it, exactly as upstream does it.
	 */
	external?: ReadonlySet<string>;
	effects?: TimedEffects;
	/** Resolves macros in keys, fields and content before they are used. */
	substitute?: (text: string) => string;
	/** Resolves a regex script for activated content; the identity when absent. */
	transform?: (content: string, entry: WorldEntry) => string;
	random?: () => number;
}

export interface LoreHit {
	book: string;
	entry: WorldEntry;
	/** Why it activated, for the chat's readout and for tests. */
	reason: string;
}

export interface LoreResult {
	before: string[];
	after: string[];
	/** In-chat injections, deepest first, already grouped by depth and role. */
	atDepth: Array<{ depth: number; role: WiRole; content: string }>;
	anTop: string[];
	anBottom: string[];
	examplesBefore: string[];
	examplesAfter: string[];
	outlets: Record<string, string[]>;
	activated: LoreHit[];
	effects: TimedEffects;
	/** True when an entry was dropped because the budget was spent. */
	overflowed: boolean;
}

const DEFAULT_ORDER = 100;
const DEFAULT_DEPTH = 4;

/** Splits the `@@activate` / `@@dont_activate` decorators off an entry's content. */
export function parseDecorators(content: string): { decorators: string[]; content: string } {
	const decorators: string[] = [];
	const body = (content || '').replace(/@@(activate|dont_activate)\b/gi, (whole) => {
		decorators.push(whole.toLowerCase());
		return '';
	});
	return { decorators, content: body };
}

/** One entry of one book, ready to scan. */
interface ScanEntry {
	book: string;
	kind: LoreBookKind;
	entry: WorldEntry;
	/** Position in the flattened list, used to keep SillyTavern's ordering stable. */
	index: number;
}

/** Every entry of every book, in the order SillyTavern would scan them. */
export function flattenBooks(books: readonly LoreBook[], strategy: number): ScanEntry[] {
	// `index` is the position in the finished list: it is what keeps ties stable and lets a group
	// restore the scan order after picking its winner, so it must be assigned last.
	const collect = (kind: LoreBookKind): Array<Omit<ScanEntry, 'index'>> =>
		books
			.filter((book) => book.kind === kind)
			.flatMap((book) =>
				Object.entries(book.book.entries).map(([key, value]) => ({
					book: book.name,
					kind,
					entry: worldEntry({ ...value, uid: value.uid ?? (Number.parseInt(key, 10) || 0), content: value.content ?? '' }),
				})),
			);
	// Inside a book the highest `order` is scanned first; equal orders keep their file order.
	const byOrder = (list: Array<Omit<ScanEntry, 'index'>>): Array<Omit<ScanEntry, 'index'>> =>
		[...list].sort((left, right) => (right.entry.order ?? DEFAULT_ORDER) - (left.entry.order ?? DEFAULT_ORDER));
	const character = byOrder(collect('character'));
	const global = byOrder(collect('global'));
	let main: Array<Omit<ScanEntry, 'index'>>;
	if (strategy === WI_STRATEGY.evenly) {
		main = byOrder([...character, ...global]);
	} else if (strategy === WI_STRATEGY.globalFirst) {
		main = [...global, ...character];
	} else {
		main = [...character, ...global];
	}
	// Chat lore always leads, then persona lore, then the characters' own books.
	const ordered = [...byOrder(collect('chat')), ...byOrder(collect('persona')), ...main];
	return ordered.map((scan, index) => ({ ...scan, index }));
}

const REGEX_KEY = /^\/(.+?)\/([a-z]*)$/is;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether one key matches the scan text. A key written as `/…/flags` is a regular expression, the
 * rest are plain substrings — matched whole-word or case-insensitively when the entry or the
 * settings say so.
 */
export function matchKey(text: string, key: string, entry: WorldEntry, settings: WorldInfoSettings): boolean {
	const needle = key.trim();
	if (!needle || !text) {
		return false;
	}
	const caseSensitive = entry.caseSensitive ?? settings.caseSensitive;
	const wholeWords = entry.matchWholeWords ?? settings.matchWholeWords;
	const regex = REGEX_KEY.exec(needle);
	if (regex) {
		try {
			const flags = caseSensitive && regex[2].includes('i') ? regex[2] : mergeFlags(regex[2], caseSensitive ? '' : 'i');
			return new RegExp(regex[1], flags).test(text);
		} catch {
			// A key that is not a valid pattern falls back to a plain substring, never an exception.
			return contains(text, needle, caseSensitive, wholeWords);
		}
	}
	return contains(text, needle, caseSensitive, wholeWords);
}

/** Flags without duplicates, so `/x/i` and a case-insensitive setting cannot collide. */
function mergeFlags(first: string, second: string): string {
	return [...new Set(`${first}${second}`.split(''))].join('');
}

function contains(text: string, needle: string, caseSensitive: boolean, wholeWords: boolean): boolean {
	if (!wholeWords) {
		return caseSensitive ? text.includes(needle) : text.toLowerCase().includes(needle.toLowerCase());
	}
	const flags = caseSensitive ? '' : 'i';
	try {
		return new RegExp(`(?<![\\w])${escapeRegExp(needle)}(?![\\w])`, flags).test(text);
	} catch {
		return false;
	}
}

/** The keys an entry watches, before substitution. */
function primaryKeys(entry: WorldEntry): string[] {
	return Array.isArray(entry.key) ? entry.key : [];
}

/**
 * Whether an entry's character/tag filter lets it through, the way SillyTavern decides it: the name
 * list first, then the tag list. The tags are the registry's **ids**, and upstream only skips this
 * check when there is no character at all — its tag map answers for every character it has drawn, so
 * an entry tied to tags is not injected for a character that carries none of them either.
 * `isExclude` turns each check around instead of dropping the entry.
 */
export function passesCharacterFilter(
	entry: WorldEntry,
	character: { name?: string; tags?: string[] } | undefined,
): boolean {
	const filter = entry.characterFilter;
	if (!filter) {
		return true;
	}
	const names = filter.names ?? [];
	if (names.length > 0) {
		const included = Boolean(character?.name && names.includes(character.name));
		if (filter.isExclude ? included : !included) {
			return false;
		}
	}
	const tags = filter.tags ?? [];
	if (tags.length > 0 && character) {
		const includesTag = (character.tags ?? []).some((tag) => tags.includes(tag));
		if (filter.isExclude ? includesTag : !includesTag) {
			return false;
		}
	}
	return true;
}

function secondaryKeys(entry: WorldEntry): string[] {
	return Array.isArray(entry.keysecondary) ? entry.keysecondary : [];
}

/**
 * Whether a full secondary-key set is satisfied, under the entry's logic: any match, not all
 * matched, no match at all, or every match.
 */
export function matchSecondary(text: string, entry: WorldEntry, settings: WorldInfoSettings): boolean {
	const logic = entry.selectiveLogic ?? WI_LOGIC.andAny;
	let any = false;
	let all = true;
	for (const key of secondaryKeys(entry)) {
		const hit = matchKey(text, key, entry, settings);
		any = any || hit;
		all = all && hit;
		switch (logic) {
			case WI_LOGIC.andAny:
				if (hit) {
					return true;
				}
				break;
			case WI_LOGIC.notAll:
				if (!hit) {
					return true;
				}
				break;
			default:
				break;
		}
	}
	if (logic === WI_LOGIC.notAny) {
		return !any;
	}
	if (logic === WI_LOGIC.andAll) {
		return all && secondaryKeys(entry).length > 0;
	}
	return false;
}

/** The text one entry is matched against: the last `scanDepth` messages plus the fields it asks for. */
export function scanTextFor(scan: ScanEntry, input: LoreInput, depthBonus = 0): string {
	const settings = input.settings;
	const substitute = input.substitute ?? ((text: string) => text);
	const depth = (scan.entry.scanDepth ?? settings.scanDepth) + depthBonus;
	const parts: string[] = [];
	for (const message of input.messages.slice(0, Math.max(0, depth))) {
		parts.push(settings.includeNames && message.speaker ? `${message.speaker}: ${message.text}` : message.text);
	}
	const fields = input.fields ?? {};
	const requested: Array<[boolean | undefined, string | undefined]> = [
		[scan.entry.matchPersonaDescription, fields.persona],
		[scan.entry.matchCharacterDescription, fields.description],
		[scan.entry.matchCharacterPersonality, fields.personality],
		[scan.entry.matchCharacterDepthPrompt, fields.depthPrompt],
		[scan.entry.matchScenario, fields.scenario],
		[scan.entry.matchCreatorNotes, fields.creatorNotes],
	];
	for (const [wanted, value] of requested) {
		if (wanted && value) {
			parts.push(value);
		}
	}
	return substitute(parts.join('\n'));
}

function effectKey(scan: ScanEntry): string {
	return `${scan.book}.${scan.entry.uid}`;
}

function isActive(effect: TimedEffect | undefined, field: 'stickyUntil' | 'cooldownUntil', turn: number): boolean {
	const until = effect?.[field];
	return typeof until === 'number' && turn < until;
}

/** Why an entry activated, and the text it contributes. */
interface Placed extends LoreHit {
	content: string;
}

/** Everything one scan attempt carries: it survives a deeper minimum-activations retry. */
interface ScanState {
	activated: Map<string, Placed>;
	failed: Set<string>;
	effects: TimedEffects;
	overflowed: boolean;
	budget: number;
	text: string;
}

/**
 * Scans the books and returns every entry that activates, bucketed by where it belongs.
 *
 * The scan runs once; with `minActivations` set it runs again from a deeper window until enough
 * entries activated or `maxActivationsDepth` is reached — entries found by an earlier attempt stay
 * activated, exactly as SillyTavern keeps them.
 */
export function activateLore(input: LoreInput): LoreResult {
	const settings = input.settings;
	const sorted = flattenBooks(input.books, settings.characterStrategy);
	// An unknown context size (0) means "no budget": starving every entry because the caller had no
	// context figure would silently drop lore the user configured.
	let budget =
		input.contextSize > 0 ? Math.round((settings.budget * input.contextSize) / 100) || 1 : Number.POSITIVE_INFINITY;
	if (settings.budgetCap > 0 && budget > settings.budgetCap) {
		budget = settings.budgetCap;
	}
	const state: ScanState = {
		activated: new Map(),
		failed: new Set(),
		effects: { ...(input.effects ?? {}) },
		overflowed: false,
		budget,
		text: '',
	};
	let depthBonus = 0;
	for (;;) {
		scanBooks(sorted, input, state, depthBonus);
		if (settings.minActivations > 0 && state.activated.size < settings.minActivations && depthBonus < settings.maxActivationsDepth) {
			depthBonus += 1;
			continue;
		}
		break;
	}
	const hits = [...state.activated.values()];
	return { ...bucket(hits, input, state.overflowed), effects: prune(state.effects, input.turn) };
}

/** The pass loop: immediate activations, then recursion levels, until nothing new activates. */
function scanBooks(sorted: readonly ScanEntry[], input: LoreInput, state: ScanState, depthBonus: number): void {
	const settings = input.settings;
	const substitute = input.substitute ?? ((text: string) => text);
	const random = input.random ?? Math.random;
	const delayed = new Set<number>();
	for (const scan of sorted) {
		const level = delayLevel(scan.entry);
		if (level > 0) {
			delayed.add(level);
		}
	}
	const levels = [...delayed].sort((left, right) => left - right);
	let recursion = false;
	let level = 0;
	let steps = 0;

	for (;;) {
		if (settings.maxRecursionSteps > 0 && steps >= settings.maxRecursionSteps) {
			break;
		}
		steps += 1;
		const hits: ScanEntry[] = [];
		// The matching score per entry, so a group can keep only its strongest members.
		const scores = new Map<ScanEntry, number>();
		for (const scan of sorted) {
			const key = effectKey(scan);
			if (state.activated.has(key) || state.failed.has(key)) {
				continue;
			}
			const entry = scan.entry;
			if (entry.disable) {
				continue;
			}
			// Generation type triggers: an entry that names types belongs only to those, and one that names
			// none belongs to every type — upstream checks this before the character filter.
			if (entry.triggers?.length && !entry.triggers.includes(input.trigger ?? 'normal')) {
				continue;
			}
			if (!passesCharacterFilter(entry, input.character)) {
				continue;
			}
			const { decorators } = parseDecorators(entry.content);
			const effect = state.effects[key];
			const sticky = isActive(effect, 'stickyUntil', input.turn);
			const cooldown = isActive(effect, 'cooldownUntil', input.turn);
			// `delay` is not an activation window: the entry simply waits until the chat is that long.
			if ((entry.delay ?? 0) > input.turn && !sticky) {
				continue;
			}
			if (cooldown && !sticky) {
				continue;
			}
			const delayedUntil = delayLevel(entry);
			if (!recursion && delayedUntil > 0 && !sticky) {
				continue;
			}
			if (recursion && delayedUntil > level && !sticky) {
				continue;
			}
			if (recursion && settings.recursive && entry.excludeRecursion && !sticky) {
				continue;
			}
			if (decorators.includes('@@dont_activate')) {
				continue;
			}
			// A vectorized entry arrives already chosen: the search decided it belongs to this chat.
			if (input.external?.has(key)) {
				hits.push(scan);
				scores.set(scan, 0);
				continue;
			}
			if (decorators.includes('@@activate') || entry.constant || sticky) {
				hits.push(scan);
				scores.set(scan, primaryKeys(entry).length);
				continue;
			}
			if (!primaryKeys(entry).length) {
				continue;
			}
			const base = scanTextFor(scan, input, depthBonus);
			const text = recursion ? `${base}\n${state.text}` : base;
			const matched = primaryKeys(entry).filter((raw) => matchKey(text, substitute(raw), entry, settings));
			if (!matched.length) {
				continue;
			}
			if (entry.selective !== false && secondaryKeys(entry).length > 0) {
				const patched: WorldEntry = { ...entry, keysecondary: secondaryKeys(entry).map((raw) => substitute(raw)) };
				if (!matchSecondary(text, patched, settings)) {
					continue;
				}
			}
			hits.push(scan);
			scores.set(scan, matched.length);
		}

		const contenders = groupWinner(hits, sorted, scores, settings);
		// Sticky entries keep their place ahead of the newcomers, as SillyTavern orders them.
		const ordered = contenders.sort((left, right) => {
			const leftSticky = isActive(state.effects[effectKey(left)], 'stickyUntil', input.turn) ? 1 : 0;
			const rightSticky = isActive(state.effects[effectKey(right)], 'stickyUntil', input.turn) ? 1 : 0;
			return rightSticky - leftSticky || left.index - right.index;
		});

		let kept = 0;
		for (const scan of ordered) {
			const entry = scan.entry;
			const key = effectKey(scan);
			const probability = entry.useProbability === false ? 100 : (entry.probability ?? 100);
			if (probability < 100 && random() * 100 > probability) {
				state.failed.add(key);
				continue;
			}
			const content = (input.transform ?? ((text: string) => text))(substitute(parseDecorators(entry.content).content.trim()), entry);
			if (!content) {
				continue;
			}
			if (!entry.ignoreBudget) {
				const tokens = estimateTokens(content);
				// The first entry is always allowed through; after that the budget wins.
				if (state.budget - tokens < 0 && state.activated.size > 0) {
					state.overflowed = true;
					continue;
				}
				state.budget -= tokens;
			}
			// An existing window is never extended: a sticky entry stays for as long as it was set for.
			const current = state.effects[key];
			if (!isActive(current, 'stickyUntil', input.turn) && !isActive(current, 'cooldownUntil', input.turn)) {
				state.effects[key] = {
					activatedAt: input.turn,
					stickyUntil: typeof entry.sticky === 'number' && entry.sticky > 0 ? input.turn + entry.sticky : undefined,
					cooldownUntil: typeof entry.cooldown === 'number' && entry.cooldown > 0 ? input.turn + entry.cooldown : undefined,
				};
			}
			state.activated.set(key, { book: scan.book, entry, reason: reasonFor(scan, state.effects[key], input.turn, input), content });
			state.text += `\n${content}`;
			kept += 1;
		}

		if (!settings.recursive || kept === 0) {
			break;
		}
		if (!recursion) {
			recursion = true;
			level = levels[0] ?? 0;
		} else {
			const next = levels.find((candidate) => candidate > level);
			if (next === undefined) {
				break;
			}
			level = next;
		}
	}
}

function delayLevel(entry: WorldEntry): number {
	if (typeof entry.delayUntilRecursion === 'number') {
		return Math.max(0, entry.delayUntilRecursion);
	}
	return entry.delayUntilRecursion ? 1 : 0;
}

/**
 * Keeps the strongest member(s) of every group: a `groupOverride` entry wins outright, otherwise
 * the highest weight (or key-match score, when group scoring is on) survives.
 */
function groupWinner(hits: ScanEntry[], sorted: readonly ScanEntry[], scores: Map<ScanEntry, number>, settings: WorldInfoSettings): ScanEntry[] {
	const groups = new Map<string, ScanEntry[]>();
	for (const hit of hits) {
		const group = hit.entry.group?.trim();
		if (!group) {
			continue;
		}
		groups.set(group, [...(groups.get(group) ?? []), hit]);
	}
	const dropped = new Set<ScanEntry>();
	for (const members of groups.values()) {
		if (members.length < 2) {
			continue;
		}
		const override = members.find((member) => member.entry.groupOverride);
		if (override) {
			for (const member of members) {
				if (member !== override) {
					dropped.add(member);
				}
			}
			continue;
		}
		const weightOf = (member: ScanEntry): number => {
			const scoring = member.entry.useGroupScoring ?? settings.useGroupScoring;
			return scoring ? (scores.get(member) ?? 0) : (member.entry.groupWeight ?? 100);
		};
		const best = Math.max(...members.map(weightOf));
		for (const member of members) {
			if (weightOf(member) < best) {
				dropped.add(member);
			}
		}
	}
	const order = new Map(sorted.map((scan) => [scan, scan.index]));
	return hits.filter((hit) => !dropped.has(hit)).sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
}

function reasonFor(scan: ScanEntry, effect: TimedEffect | undefined, turn: number, input: LoreInput): string {
	if (input.external?.has(effectKey(scan))) {
		return 'vector';
	}
	if (effect && isActive(effect, 'stickyUntil', turn)) {
		return 'sticky';
	}
	if (scan.entry.constant) {
		return 'constant';
	}
	if (parseDecorators(scan.entry.content).decorators.includes('@@activate')) {
		return '@@activate';
	}
	return 'key';
}

/** Drops timed effects that can no longer do anything, so the stored state stays small. */
function prune(effects: TimedEffects, turn: number): TimedEffects {
	const kept: TimedEffects = {};
	for (const [key, effect] of Object.entries(effects)) {
		if (isActive(effect, 'stickyUntil', turn) || isActive(effect, 'cooldownUntil', turn)) {
			kept[key] = effect;
		}
	}
	return kept;
}

/** Places the activated entries in the buckets the assembler fills the prompt from. */
function bucket(hits: readonly Placed[], input: LoreInput, overflowed: boolean): Omit<LoreResult, 'effects'> {
	const before: string[] = [];
	const after: string[] = [];
	const anTop: string[] = [];
	const anBottom: string[] = [];
	const examplesBefore: string[] = [];
	const examplesAfter: string[] = [];
	const depth = new Map<string, { depth: number; role: WiRole; content: string }>();
	const outlets: Record<string, string[]> = {};

	// Ascending `order`: SillyTavern appends each activation to the front, which reverses its sort.
	const ordered = [...hits].sort((left, right) => (left.entry.order ?? DEFAULT_ORDER) - (right.entry.order ?? DEFAULT_ORDER));
	for (const hit of ordered) {
		const entry = hit.entry;
		const content = hit.content;
		if (!content) {
			continue;
		}
		switch (entry.position ?? WI_POSITION.before) {
			case WI_POSITION.after:
				after.push(content);
				break;
			case WI_POSITION.anTop:
				anTop.push(content);
				break;
			case WI_POSITION.anBottom:
				anBottom.push(content);
				break;
			case WI_POSITION.emTop:
				examplesBefore.push(content);
				break;
			case WI_POSITION.emBottom:
				examplesAfter.push(content);
				break;
			case WI_POSITION.atDepth: {
				const entryDepth = entry.depth ?? DEFAULT_DEPTH;
				const role = (entry.role ?? WI_ROLE.system) as WiRole;
				const key = `${entryDepth}:${role}`;
				const existing = depth.get(key);
				if (existing) {
					existing.content = `${content}\n${existing.content}`;
				} else {
					depth.set(key, { depth: entryDepth, role, content });
				}
				break;
			}
			case WI_POSITION.outlet: {
				const name = entry.outletName?.trim();
				if (!name) {
					break;
				}
				outlets[name] = [...(outlets[name] ?? []), content];
				break;
			}
			default:
				before.push(content);
				break;
		}
	}
	const atDepth = [...depth.values()].sort((left, right) => right.depth - left.depth);
	return {
		before,
		after,
		atDepth,
		anTop,
		anBottom,
		examplesBefore,
		examplesAfter,
		outlets,
		activated: hits.map(({ book, entry, reason }) => ({ book, entry, reason })),
		overflowed,
	};
}

/** The keys an entry watches, for the index the model reads before calling `lore_lookup`. */
export function entrySummary(entry: WorldEntry): string {
	const comment = (entry.comment ?? '').trim();
	const keys = primaryKeys(entry)
		.map((key) => key.trim())
		.filter(Boolean)
		.join(', ');
	if (comment && keys) {
		return `${comment} (${keys})`;
	}
	return comment || keys || `entry ${entry.uid}`;
}

export interface LoreSearchHit {
	book: string;
	entry: WorldEntry;
	/** Why it matched: a key, its comment, or its body. */
	matched: string;
	/** Higher is a better match, so the caller can cut off the tail. */
	score: number;
}

/** A book the caller can search: the name it is known by and its entries. */
export interface SearchableBook {
	name: string;
	book: WorldBook;
}

/**
 * Looks an entry up on demand, which is what `lore_lookup` is for: the automatic pass decides what
 * the model already sees, and this lets it ask for more. A term that matches a key counts for more
 * than one that only appears in the body, so a query about a name finds that entry first.
 */
export function searchLore(
	books: readonly LoreBook[],
	query: string,
	settings: WorldInfoSettings,
	limit = 10,
): LoreSearchHit[] {
	const terms = query
		.split(/[\s,]+/)
		.map((term) => term.trim())
		.filter((term) => term.length > 1);
	if (!terms.length) {
		return [];
	}
	const hits: LoreSearchHit[] = [];
	for (const book of books) {
		for (const [key, raw] of Object.entries(book.book.entries)) {
			const entry = worldEntry({ ...raw, uid: raw.uid ?? (Number.parseInt(key, 10) || 0), content: raw.content ?? '' });
			if (entry.disable) {
				continue;
			}
			let score = 0;
			let matched = '';
			for (const term of terms) {
				if ([...primaryKeys(entry), ...secondaryKeys(entry)].some((key2) => matchKey(term, key2, entry, settings))) {
					score += 3;
					matched ||= 'key';
					continue;
				}
				if (entry.comment && matchKey(entry.comment, term, entry, settings)) {
					score += 2;
					matched ||= 'comment';
					continue;
				}
				if (matchKey(entry.content, term, entry, settings)) {
					score += 1;
					matched ||= 'body';
				}
			}
			if (score > 0) {
				hits.push({ book: book.name, entry, matched, score });
			}
		}
	}
	return hits.sort((left, right) => right.score - left.score || left.entry.uid - right.entry.uid).slice(0, Math.max(1, limit));
}

/** The one-line index of a book the model reads before it decides to look anything up. */
export function loreIndex(books: readonly SearchableBook[]): string {
	const lines: string[] = [];
	for (const book of books.slice(0, 20)) {
		const summaries = Object.values(book.book.entries)
			.filter((entry) => !entry.disable)
			.slice(0, 12)
			.map((entry) => entry.comment?.trim() || primaryKeys(entry).slice(0, 2).join('/'))
			.filter(Boolean);
		if (summaries.length) {
			lines.push(`- ${book.name}: ${summaries.join('; ')}`);
		}
	}
	if (!lines.length) {
		return '';
	}
	return `World books (look one up with the lore_lookup tool when the user mentions something here):\n${lines.join('\n')}`;
}

/**
 * Converts a card's `character_book` into a world book: `entries` is an array whose `id` is the uid.
 */
export function toWorldBook(source: { name?: string; entries?: unknown[] } | null | undefined, fallback: string): WorldBook {
	const book: WorldBook = { name: source?.name?.trim() || fallback, entries: {} };
	const list = Array.isArray(source?.entries) ? source.entries : [];
	list.forEach((raw, index) => {
		const uid = raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'number' ? (raw as { id: number }).id : index;
		const entry = worldEntryFromJson(raw, uid);
		if (entry) {
			book.entries[String(uid)] = entry;
		}
	});
	return book;
}

/** Converts SillyTavern's own world-book file, where `entries` is an object keyed by uid. */export function worldInfoToBook(name: string, entries: Record<string, unknown>): WorldBook {
	const book: WorldBook = { name: name.trim() || 'Lorebook', entries: {} };
	let index = 0;
	for (const [key, raw] of Object.entries(entries)) {
		const parsed = Number.parseInt(key, 10);
		const entry = worldEntryFromJson(raw, Number.isFinite(parsed) ? parsed : index);
		if (entry) {
			book.entries[String(entry.uid)] = entry;
		}
		index += 1;
	}
	return book;
}

/**
 * One entry of a foreign book. Two shapes arrive: a card's `character_book` (V2 spec, snake_case,
 * `id`/`keys`/`secondary_keys`) and SillyTavern's own file, which writes the camelCase names at the
 * top level and mirrors some of them under `extensions`. A field is read from wherever it is, so
 * either shape round-trips.
 */
export function worldEntryFromJson(raw: unknown, uid: number): WorldEntry | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const entry = raw as Record<string, unknown>;
	const ext = (entry.extensions ?? {}) as Record<string, unknown>;
	// `extensions` wins where it exists (that is the block SillyTavern itself mirrors), else the
	// top-level name, else the snake_case name a character book uses.
	const pick = (...names: [Record<string, unknown>, string][]): unknown => {
		for (const [from, name] of names) {
			if (from[name] !== undefined && from[name] !== null) {
				return from[name];
			}
		}
		return undefined;
	};
	return worldEntry({
		uid,
		key: stringList(pick([entry, 'keys'], [entry, 'key'])),
		keysecondary: stringList(pick([entry, 'secondary_keys'], [entry, 'keysecondary'])),
		comment: String(pick([entry, 'comment'], [entry, 'name']) ?? ''),
		content: String(entry.content ?? ''),
		constant: entry.constant === true,
		selective: entry.selective !== false,
		selectiveLogic: numberOr(pick([ext, 'selectiveLogic'], [ext, 'selective_logic'], [entry, 'selectiveLogic']), WI_LOGIC.andAny),
		order: numberOr(pick([ext, 'order'], [entry, 'insertion_order'], [entry, 'order']), DEFAULT_ORDER),
		position: positionFrom(pick([entry, 'position']), numberOr(pick([ext, 'position']), WI_POSITION.before)),
		disable: entry.enabled === false || entry.disable === true,
		ignoreBudget: pick([ext, 'ignore_budget'], [entry, 'ignoreBudget']) === true,
		excludeRecursion: pick([ext, 'exclude_recursion'], [entry, 'excludeRecursion']) === true,
		preventRecursion: pick([ext, 'prevent_recursion'], [entry, 'preventRecursion']) === true,
		delayUntilRecursion: (pick([ext, 'delay_until_recursion'], [entry, 'delayUntilRecursion']) as number | boolean) ?? 0,
		probability: numberOr(pick([ext, 'probability'], [entry, 'probability']), 100),
		useProbability: pick([ext, 'useProbability'], [entry, 'useProbability']) !== false,
		depth: numberOr(pick([ext, 'depth'], [entry, 'depth']), DEFAULT_DEPTH),
		outletName: String(pick([entry, 'outletName']) ?? ''),
		group: String(pick([ext, 'group'], [entry, 'group']) ?? ''),
		groupOverride: pick([ext, 'group_override'], [entry, 'groupOverride']) === true,
		groupWeight: numberOr(pick([ext, 'group_weight'], [entry, 'groupWeight']), 100),
		scanDepth: numberOrNull(pick([ext, 'scan_depth'], [entry, 'scanDepth'])),
		caseSensitive: boolOrNull(pick([ext, 'case_sensitive'], [entry, 'caseSensitive'])),
		matchWholeWords: boolOrNull(pick([ext, 'match_whole_words'], [entry, 'matchWholeWords'])),
		useGroupScoring: boolOrNull(pick([ext, 'use_group_scoring'], [entry, 'useGroupScoring'])),
		role: numberOrNull(pick([ext, 'role'], [entry, 'role'])),
		vectorized: pick([ext, 'vectorized'], [entry, 'vectorized']) === true,
		sticky: numberOrNull(pick([ext, 'sticky'], [entry, 'sticky'])),
		cooldown: numberOrNull(pick([ext, 'cooldown'], [entry, 'cooldown'])),
		delay: numberOrNull(pick([ext, 'delay'], [entry, 'delay'])),
		addMemo: entry.addMemo === true,
		automationId: String(pick([ext, 'automation_id'], [entry, 'automationId']) ?? ''),
		displayIndex: numberOrNull(pick([ext, 'display_index'], [entry, 'displayIndex'])) ?? undefined,
		triggers: stringList(pick([ext, 'triggers'], [entry, 'triggers'])),
		matchPersonaDescription: pick([ext, 'match_persona_description'], [entry, 'matchPersonaDescription']) === true,
		matchCharacterDescription: pick([ext, 'match_character_description'], [entry, 'matchCharacterDescription']) === true,
		matchCharacterPersonality: pick([ext, 'match_character_personality'], [entry, 'matchCharacterPersonality']) === true,
		matchCharacterDepthPrompt: pick([ext, 'match_character_depth_prompt'], [entry, 'matchCharacterDepthPrompt']) === true,
		matchScenario: pick([ext, 'match_scenario'], [entry, 'matchScenario']) === true,
		matchCreatorNotes: pick([ext, 'match_creator_notes'], [entry, 'matchCreatorNotes']) === true,
		characterFilter: readCharacterFilter(pick([entry, 'character_filter'], [ext, 'character_filter']), entry),
	});
}

/**
 * The character/tag filter, from `character_filter` — the name SillyTavern's own editor writes, with
 * the tag list holding registry ids — or from the three flat keys an early Comonad file carries.
 */
function readCharacterFilter(object: unknown, entry: Record<string, unknown>): WorldEntry['characterFilter'] {
	if (object && typeof object === 'object' && !Array.isArray(object)) {
		const filter = object as { names?: unknown; tags?: unknown; isExclude?: unknown };
		return {
			names: stringList(filter.names),
			tags: stringList(filter.tags),
			isExclude: filter.isExclude === true,
		};
	}
	return Array.isArray(entry.characterFilterNames) || Array.isArray(entry.characterFilterTags) || entry.characterFilterExclude !== undefined
		? {
				names: stringList(entry.characterFilterNames),
				tags: stringList(entry.characterFilterTags),
				isExclude: entry.characterFilterExclude === true,
			}
		: undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
	return typeof value === 'boolean' ? value : null;
}

/** The V2 spec writes positions as words; older books wrote numbers. */
function positionFrom(word: unknown, fallback: number): number {
	switch (word) {
		case 'before_char':
			return WI_POSITION.before;
		case 'after_char':
			return WI_POSITION.after;
		case 'before_an':
			return WI_POSITION.anTop;
		case 'after_an':
			return WI_POSITION.anBottom;
		default:
			return fallback;
	}
}
