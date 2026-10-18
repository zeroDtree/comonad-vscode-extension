import { isComonadBlockId } from '@comonad/lib/blocks';
import { DEFAULT_ORDER, ST_PROMPTS } from './prompts';
import { normalisePrompt } from './preset';
import { sanitisePromptLibrary } from './library';
import { TALKATIVENESS_DEFAULT } from './card';
import { WI_ENTRY_DEFAULTS, WI_LOGIC, WI_POSITION } from './lore';
import type { Character, Persona, PersonaConnection, PromptItem, TavernPreset, WorldBook, WorldEntry } from './types';

/**
 * Authoring: blank items and the on-disk writers, all in SillyTavern's own formats so a file made
 * here can be dropped into a SillyTavern installation and read back unchanged. Everything is pure —
 * the service owns the paths and the writes.
 */

/** Where a persona description goes, verbatim from SillyTavern's `persona_description_positions`. */
export const PERSONA_POSITION = {
	inPrompt: 0,
	/** Deprecated upstream; still accepted on load. */
	afterChar: 1,
	anTop: 2,
	anBottom: 3,
	atDepth: 4,
	/**
	 * Sent nowhere: the persona still supplies the user's name, but its description is left out of the
	 * request entirely. Upstream spells this position `NONE`.
	 */
	none: 9,
} as const;

/** Upstream's own default for a fresh persona: two messages from the end, in the system role. */
export const PERSONA_DEPTH_DEFAULT = 2;

/** A file-safe id from a title: `My Preset!` becomes `My-Preset`. */
export function slugId(name: string, fallback = 'item'): string {
	return (
		name
			.trim()
			.replace(/[^\w.-]+/g, '-')
			.replace(/^[-.]+|[-.]+$/g, '') || fallback
	);
}

/* ------------------------------------------------------------------ adopting edits */

/**
 * The four `adopt*` functions turn what a webview sent back into the domain object a writer
 * expects. A webview is untrusted input, and a bad value here becomes a corrupt file, so every
 * string, number, flag and list is coerced — and every key the item arrived with is kept.
 */

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
const asNumber = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const asFlag = (value: unknown): boolean => value === true;
const asList = (value: unknown): string[] =>
	Array.isArray(value)
		? value.map((entry) => String(entry).trim()).filter(Boolean)
		: typeof value === 'string'
			? value
					.split(/[\n,]/)
					.map((entry) => entry.trim())
					.filter(Boolean)
			: [];
const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
/** A field that may be genuinely absent: a three-state setting, or a turn count with no value. */
const asNumberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const asBoolOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

export function adoptCharacter(raw: unknown): Character {
	const value = asObject(raw);
	const id = asText(value.id).trim() || slugId(asText(value.name), 'character');
	const depth = value.depthPrompt ? asObject(value.depthPrompt) : null;
	const role = depth?.role === 'user' || depth?.role === 'assistant' ? depth.role : 'system';
	return {
		id,
		name: asText(value.name).trim() || id,
		description: asText(value.description),
		personality: asText(value.personality),
		scenario: asText(value.scenario),
		greeting: asText(value.greeting),
		alternateGreetings: asList(value.alternateGreetings),
		examples: asText(value.examples),
		systemPrompt: asText(value.systemPrompt),
		postHistoryInstructions: asText(value.postHistoryInstructions),
		creatorNotes: asText(value.creatorNotes),
		creator: asText(value.creator),
		version: asText(value.version),
		tags: asList(value.tags),
		favourite: value.favourite === true,
		talkativeness: asNumber(value.talkativeness, TALKATIVENESS_DEFAULT),
		createdAt: asText(value.createdAt),
		sourceLink: asText(value.sourceLink),
		// An empty prompt is not a prompt: the card has none, which is a state of its own.
		depthPrompt: depth && asText(depth.prompt).trim() ? { prompt: asText(depth.prompt), depth: asNumber(depth.depth, 4), role } : null,
		world: asText(value.world).trim(),
		book: (value.book as Character['book']) ?? null,
		regex: Array.isArray(value.regex) ? (value.regex as Character['regex']) : [],
		source: asText(value.source),
		raw: asObject(value.raw) as Character['raw'],
	};
}

export function adoptBook(raw: unknown): WorldBook & { source: string; raw: Record<string, unknown> } {
	const value = asObject(raw);
	const book: WorldBook = { name: asText(value.name).trim() || 'Lorebook', entries: {} };
	for (const [key, rawEntry] of Object.entries(asObject(value.entries))) {
		const entry = asObject(rawEntry);
		const uid = asNumber(entry.uid, Number.parseInt(key, 10) || 0);
		book.entries[String(uid)] = {
			...WI_ENTRY_DEFAULTS,
			...entry,
			uid,
			key: asList(entry.key),
			keysecondary: asList(entry.keysecondary),
			comment: asText(entry.comment),
			content: asText(entry.content),
			position: asNumber(entry.position, WI_POSITION.before),
			order: asNumber(entry.order, 100),
			depth: asNumber(entry.depth, 4),
			probability: asNumber(entry.probability, 100),
			groupWeight: asNumber(entry.groupWeight, 100),
			delayUntilRecursion: asNumber(entry.delayUntilRecursion, 0),
			selectiveLogic: asNumber(entry.selectiveLogic, WI_LOGIC.andAny),
			// The optional fields keep their empty state instead of collapsing to zero.
			sticky: asNumberOrNull(entry.sticky),
			cooldown: asNumberOrNull(entry.cooldown),
			delay: asNumberOrNull(entry.delay),
			scanDepth: asNumberOrNull(entry.scanDepth),
			role: asNumberOrNull(entry.role),
			caseSensitive: asBoolOrNull(entry.caseSensitive),
			matchWholeWords: asBoolOrNull(entry.matchWholeWords),
			useGroupScoring: asBoolOrNull(entry.useGroupScoring),
			constant: asFlag(entry.constant),
			disable: asFlag(entry.disable),
			selective: entry.selective !== false,
			ignoreBudget: asFlag(entry.ignoreBudget),
			excludeRecursion: asFlag(entry.excludeRecursion),
			preventRecursion: asFlag(entry.preventRecursion),
			useProbability: entry.useProbability !== false,
			groupOverride: asFlag(entry.groupOverride),
			vectorized: asFlag(entry.vectorized),
			addMemo: asFlag(entry.addMemo),
			triggers: asList(entry.triggers),
		} as WorldEntry;
	}
	return { ...book, source: asText(value.source), raw: asObject(value.raw) };
}

export function adoptPersona(raw: unknown): Persona {
	const value = asObject(raw);
	const id = asText(value.id).trim() || slugId(asText(value.name), 'persona');
	const avatar = asText(value.avatar).trim();
	return {
		id,
		name: asText(value.name).trim() || id,
		title: asText(value.title),
		description: asText(value.description),
		position: asNumber(value.position, PERSONA_POSITION.inPrompt),
		depth: asNumber(value.depth, PERSONA_DEPTH_DEFAULT),
		role: asNumber(value.role, 0),
		lorebook: asText(value.lorebook),
		connections: readPersonaConnections(value.connections),
		source: asText(value.source),
		...(avatar ? { avatar } : {}),
		raw: asObject(value.raw) as Persona['raw'],
	};
}

/** The sampler fields a preset carries under their SillyTavern names. */
const SAMPLER_FIELDS = [
	'temperature',
	'top_p',
	'top_k',
	'top_a',
	'min_p',
	'frequency_penalty',
	'presence_penalty',
	'repetition_penalty',
	'maxContext',
	'maxTokens',
] as const;

export function adoptPreset(raw: unknown): TavernPreset {
	const value = asObject(raw) as unknown as TavernPreset;
	const id = asText((raw as { id?: unknown })?.id).trim() || slugId(asText((raw as { name?: unknown })?.name), 'preset');
	// The editor sends the whole collection in send order, Comonad's generated blocks included. Only
	// their place and switch are stored (`promptOrder`); a definition is never written for them,
	// because the agent supplies its text again every turn.
	const entries = Array.isArray(value.prompts)
		? (value.prompts as (PromptItem & { enabled?: boolean })[]).filter((prompt) => prompt && typeof prompt.identifier === 'string')
		: [];
	const prompts = entries
		.filter((prompt) => !isComonadBlockId(prompt.identifier))
		.map((prompt) => normalisePrompt(prompt))
		.filter((prompt): prompt is PromptItem => prompt !== null);
	const incomingOrder = Array.isArray(value.promptOrder)
		? value.promptOrder
				.filter((entry) => entry && typeof entry.identifier === 'string' && entry.identifier.length > 0)
				.map((entry) => ({ identifier: entry.identifier, enabled: entry.enabled !== false }))
		: [];
	// This preset's own prompt library: what the pane saved for this preset alone. An empty library
	// leaves the key out entirely, so a preset that never used one keeps its file as it arrived.
	const promptLibrary = sanitisePromptLibrary((value as { promptLibrary?: unknown }).promptLibrary);
	const preset: TavernPreset = {
		...(value as TavernPreset),
		id,
		name: asText(value.name).trim() || id,
		prompts,
		promptLibrary: promptLibrary.length ? promptLibrary : undefined,
		promptOrder: entries.length ? entries.map((prompt) => ({ identifier: prompt.identifier, enabled: prompt.enabled !== false })) : incomingOrder,
		raw: asObject(value.raw),
	};
	for (const field of SAMPLER_FIELDS) {
		const number = (raw as Record<string, unknown>)?.[field];
		if (typeof number === 'number' && Number.isFinite(number)) {
			preset[field] = number;
		} else {
			delete preset[field];
		}
	}
	return preset;
}

/* ------------------------------------------------------------------ world books */

/** A fresh entry, every default filled, matching SillyTavern's own template. */
export function blankEntry(uid: number, position = WI_POSITION.before): WorldEntry {
	return { ...WI_ENTRY_DEFAULTS, uid, key: [], keysecondary: [], content: '', position } as WorldEntry;
}

export function blankBook(name: string): WorldBook {
	return { name: name.trim() || 'Lorebook', entries: {} };
}

/** The first free uid, which is what SillyTavern looks for when it adds an entry. */
export function nextUid(book: WorldBook): number {
	const used = new Set(Object.values(book.entries).map((entry) => entry.uid));
	let uid = 0;
	while (used.has(uid)) {
		uid += 1;
	}
	return uid;
}

/** The `extensions` mirror SillyTavern writes beside the top-level names. */
const MIRROR: [keyof WorldEntry, string][] = [
	['position', 'position'],
	['excludeRecursion', 'exclude_recursion'],
	['displayIndex', 'display_index'],
	['probability', 'probability'],
	['useProbability', 'useProbability'],
	['depth', 'depth'],
	['selectiveLogic', 'selectiveLogic'],
	['group', 'group'],
	['groupOverride', 'group_override'],
	['groupWeight', 'group_weight'],
	['preventRecursion', 'prevent_recursion'],
	['delayUntilRecursion', 'delay_until_recursion'],
	['scanDepth', 'scan_depth'],
	['matchWholeWords', 'match_whole_words'],
	['useGroupScoring', 'use_group_scoring'],
	['caseSensitive', 'case_sensitive'],
	['automationId', 'automation_id'],
	['role', 'role'],
	['vectorized', 'vectorized'],
	['sticky', 'sticky'],
	['cooldown', 'cooldown'],
	['delay', 'delay'],
	['ignoreBudget', 'ignore_budget'],
	['matchPersonaDescription', 'match_persona_description'],
	['matchCharacterDescription', 'match_character_description'],
	['matchCharacterPersonality', 'match_character_personality'],
	['matchCharacterDepthPrompt', 'match_character_depth_prompt'],
	['matchScenario', 'match_scenario'],
	['matchCreatorNotes', 'match_creator_notes'],
	['triggers', 'triggers'],
];

/** One entry as SillyTavern stores it: the camelCase names at the root, mirrored under `extensions`. */
export function entryToJson(entry: WorldEntry, raw: Record<string, unknown> = {}): Record<string, unknown> {
	const json: Record<string, unknown> = { ...raw };
	const set = (key: string, value: unknown): void => {
		if (value === undefined) {
			delete json[key];
		} else {
			json[key] = value;
		}
	};
	set('uid', entry.uid);
	set('key', entry.key ?? []);
	set('keysecondary', entry.keysecondary ?? []);
	set('comment', entry.comment ?? '');
	set('content', entry.content ?? '');
	set('constant', entry.constant === true);
	set('selective', entry.selective !== false);
	set('selectiveLogic', entry.selectiveLogic ?? WI_LOGIC.andAny);
	set('order', entry.order ?? 100);
	set('position', entry.position ?? WI_POSITION.before);
	set('disable', entry.disable === true);
	// Upstream keeps the display order at the root of the entry, not only in the `extensions` mirror.
	set('displayIndex', entry.displayIndex ?? entry.uid);
	set('vectorized', entry.vectorized === true);
	set('addMemo', entry.addMemo === true);
	set('ignoreBudget', entry.ignoreBudget === true);
	set('excludeRecursion', entry.excludeRecursion === true);
	set('preventRecursion', entry.preventRecursion === true);
	set('delayUntilRecursion', entry.delayUntilRecursion ?? 0);
	set('probability', entry.probability ?? 100);
	set('useProbability', entry.useProbability !== false);
	set('depth', entry.depth ?? 4);
	set('outletName', entry.outletName ?? '');
	set('group', entry.group ?? '');
	set('groupOverride', entry.groupOverride === true);
	set('groupWeight', entry.groupWeight ?? 100);
	set('scanDepth', entry.scanDepth ?? null);
	set('caseSensitive', entry.caseSensitive ?? null);
	set('matchWholeWords', entry.matchWholeWords ?? null);
	set('useGroupScoring', entry.useGroupScoring ?? null);
	set('automationId', entry.automationId ?? '');
	set('role', entry.role ?? 0);
	set('sticky', entry.sticky ?? null);
	set('cooldown', entry.cooldown ?? null);
	set('delay', entry.delay ?? null);
	set('matchPersonaDescription', entry.matchPersonaDescription === true);
	set('matchCharacterDescription', entry.matchCharacterDescription === true);
	set('matchCharacterPersonality', entry.matchCharacterPersonality === true);
	set('matchCharacterDepthPrompt', entry.matchCharacterDepthPrompt === true);
	set('matchScenario', entry.matchScenario === true);
	set('matchCreatorNotes', entry.matchCreatorNotes === true);
	// Upstream keeps the filter as one object at the root, under the name its editor writes, and the
	// tag list holds registry ids. The three flat keys are what early Comonad files carry; they are
	// dropped here so a file written once is SillyTavern's own shape.
	set('character_filter', {
		isExclude: entry.characterFilter?.isExclude === true,
		names: entry.characterFilter?.names ?? [],
		tags: entry.characterFilter?.tags ?? [],
	});
	delete json.characterFilterNames;
	delete json.characterFilterTags;
	delete json.characterFilterExclude;
	set('triggers', entry.triggers ?? []);
	const extensions = { ...((raw.extensions as Record<string, unknown>) ?? {}) };
	for (const [field, name] of MIRROR) {
		const value = entry[field];
		if (value === undefined || value === null) {
			delete extensions[name];
		} else {
			extensions[name] = value;
		}
	}
	set('extensions', extensions);
	return json;
}

/** A world book as its own file: the shape SillyTavern's `worlds/` folder holds. */
export function worldInfoJson(book: WorldBook, raw: Record<string, unknown> = {}): string {
	const entries: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(book.entries)) {
		const original = (raw.entries as Record<string, unknown> | undefined)?.[key];
		entries[key] = entryToJson(entry, original && typeof original === 'object' ? (original as Record<string, unknown>) : {});
	}
	return JSON.stringify({ ...raw, name: book.name, entries }, null, 4);
}

/* ------------------------------------------------------------------ characters */

/** A new card: the fields a fresh SillyTavern character starts with, and nothing else. */
export function blankCharacter(name: string, id: string): Character {
	return {
		id,
		name: name.trim() || id,
		description: '',
		personality: '',
		scenario: '',
		greeting: '',
		alternateGreetings: [],
		examples: '',
		systemPrompt: '',
		postHistoryInstructions: '',
		creatorNotes: '',
		creator: '',
		version: '',
		tags: [],
		favourite: false,
		talkativeness: TALKATIVENESS_DEFAULT,
		// Upstream stamps a card the moment it is created; the date rides along in the file.
		createdAt: new Date().toISOString(),
		sourceLink: '',
		depthPrompt: null,
		world: '',
		book: null,
		regex: [],
		source: '',
		raw: {},
	};
}

/* ------------------------------------------------------------------ personas */

export function blankPersona(name: string, id: string): Persona {
	return {
		id,
		name: name.trim() || id,
		description: '',
		// Upstream leaves the picker's label empty and shows the name until the user sets one.
		title: '',
		position: PERSONA_POSITION.inPrompt,
		depth: PERSONA_DEPTH_DEFAULT,
		role: 0,
		lorebook: '',
		connections: [],
		source: '',
		raw: {},
	};
}

/**
 * Reads a persona's connections: upstream's `{type, id}` objects, and the bare names older Comonad
 * files carry — a name can only have meant a character, so those become character connections. A
 * malformed entry is dropped rather than making the whole persona unreadable.
 */
export function readPersonaConnections(value: unknown): PersonaConnection[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const connections: PersonaConnection[] = [];
	const seen = new Set<string>();
	const add = (type: PersonaConnection['type'], id: string): void => {
		const key = `${type}\u0000${id}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		connections.push({ type, id });
	};
	for (const entry of value) {
		if (typeof entry === 'string') {
			const id = entry.trim();
			if (id) {
				add('character', id);
			}
			continue;
		}
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const id = asText(record.id).trim();
		if (id) {
			add(record.type === 'group' ? 'group' : 'character', id);
		}
	}
	return connections;
}

/** A persona as a file: SillyTavern's own `persona_descriptions` block, plus the name. */
export function personaJson(persona: Persona, raw: Record<string, unknown> = {}): string {
	return JSON.stringify(
		{
			...raw,
			name: persona.name,
			title: persona.title,
			description: persona.description,
			position: persona.position,
			depth: persona.depth,
			role: persona.role,
			lorebook: persona.lorebook,
			connections: persona.connections.map((connection) => ({ type: connection.type, id: connection.id })),
		},
		null,
		4,
	);
}

/* ------------------------------------------------------------------ presets */

/** A new preset: SillyTavern's shipped prompts, Comonad's blocks and order, no sampler overrides. */
export function blankPreset(name: string, id: string): TavernPreset {
	return {
		id,
		name: name.trim() || id,
		prompts: ST_PROMPTS.map((prompt) => ({ ...prompt }) as PromptItem),
		promptOrder: DEFAULT_ORDER.map((entry) => ({ ...entry })),
		raw: {},
	};
}
