// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SillyTavern-compatible content types. Field names mirror the on-disk formats exactly — v1/v2/v3
 * character cards, world books, OpenAI presets, personas, regex scripts — so a file written by one
 * tool can be read by the other. Types only: the values that read the formats live with the tavern
 * plugin, and this module must not import `vscode` or `cordis`.
 */

export type { GenerationTrigger } from '@comonad/lib/generations';

/* ------------------------------------------------------------------ world books */

/** Where an activated entry is injected, verbatim from SillyTavern's `world_info_position`. */
export type WiPosition =
	| 0 // before
	| 1 // after
	| 2 // anTop — before the author's note
	| 3 // anBottom — after the author's note
	| 4 // atDepth
	| 5 // emTop — before the dialogue examples
	| 6 // emBottom — after the dialogue examples
	| 7; // outlet

/** How secondary keys combine with the primary match, verbatim from `world_info_logic`. */
export type WiLogic =
	| 0 // andAny — at least one secondary key matches
	| 1 // notAll — at least one secondary key does not match
	| 2 // notAny — no secondary key matches
	| 3; // andAll — every secondary key matches

/** How character books and global books are interleaved, verbatim from `world_info_insertion_strategy`. */
export type WiStrategy =
	| 0 // evenly
	| 1 // characterFirst
	| 2; // globalFirst

export type WiRole =
	| 0 // system
	| 1 // user
	| 2; // assistant

/** One `entries[uid]` record of a world book, plus the fields Comonad adds while loading. */
export interface WorldEntry {
	uid: number;
	key: string[];
	keysecondary?: string[];
	/** A one-line title, shown in the editor and returned by `lore_lookup`. */
	comment?: string;
	content: string;
	/** Always injected, whatever the scan text says. */
	constant?: boolean;
	selective?: boolean;
	selectiveLogic?: number;
	order?: number;
	position?: number;
	disable?: boolean;
	/** Exempt from the world-info token budget. */
	ignoreBudget?: boolean;
	/** Not scanned while following a recursive activation. */
	excludeRecursion?: boolean;
	/** Excluded from recursive scans, and does not activate them. */
	preventRecursion?: boolean;
	/** `false`/`0` = scan immediately; a number = only from that recursion level. */
	delayUntilRecursion?: number | boolean;
	probability?: number;
	useProbability?: boolean;
	/** In-chat injection depth, for `position: atDepth`. */
	depth?: number;
	/** Required when `position: outlet`. */
	outletName?: string;
	group?: string;
	groupOverride?: boolean;
	groupWeight?: number;
	/** Per-entry override of the global scan depth. */
	scanDepth?: number | null;
	caseSensitive?: boolean | null;
	matchWholeWords?: boolean | null;
	useGroupScoring?: boolean | null;
	role?: number | null;
	/** Stays active for this many messages after it activates. */
	sticky?: number | null;
	/** Cannot reactivate until this many messages passed. */
	cooldown?: number | null;
	/** Cannot activate on the message that is this many back. */
	delay?: number | null;
	/** Reserved: embedding-based activation is not implemented. */
	vectorized?: boolean;
	addMemo?: boolean;
	automationId?: string;
	displayIndex?: number;
	/** Match the scan text against the card and persona fields too, not only the chat. */
	matchPersonaDescription?: boolean;
	matchCharacterDescription?: boolean;
	matchCharacterPersonality?: boolean;
	matchCharacterDepthPrompt?: boolean;
	matchScenario?: boolean;
	matchCreatorNotes?: boolean;
	/** Generation types this entry is limited to; empty means every type. */
	triggers?: string[];
	characterFilter?: { names?: string[]; tags?: string[]; isExclude?: boolean };
	/** The book this entry came from, so a hit can name its source. */
	world?: string;
}

export interface WorldBook {
	name: string;
	/** Keyed by uid as a string, exactly as SillyTavern stores it. */
	entries: Record<string, WorldEntry>;
}

/**
 * The character-book format a card carries (V2 spec): a flat array with snake_case keys and the
 * SillyTavern-specific knobs under `extensions`. Cards are stored as written; this is what a world
 * book looks like before `toWorldBook()` normalises it.
 */
export interface CharacterBookEntry {
	keys?: string[];
	secondary_keys?: string[];
	content?: string;
	comment?: string;
	name?: string;
	enabled?: boolean;
	insertion_order?: number;
	case_sensitive?: boolean;
	use_regex?: boolean;
	constant?: boolean;
	selective?: boolean;
	position?: string;
	priority?: number;
	id?: number;
	extensions?: Record<string, unknown>;
}

export interface CharacterBook {
	name?: string;
	description?: string;
	scan_depth?: number;
	token_budget?: number;
	recursive_scanning?: boolean;
	extensions?: Record<string, unknown>;
	entries?: CharacterBookEntry[];
}

/* ------------------------------------------------------------------ character cards */

export interface RegexScript {
	id: string;
	scriptName: string;
	findRegex: string;
	replaceString: string;
	trimStrings?: string[];
	/** Any of `REGEX_PLACEMENT`; a script runs when the placement is in this list. */
	placement?: number[];
	disabled?: boolean;
	markdownOnly?: boolean;
	promptOnly?: boolean;
	runOnEdit?: boolean;
	substituteRegex?: number;
	minDepth?: number | null;
	maxDepth?: number | null;
}

export interface DepthPrompt {
	depth: number;
	prompt: string;
	role: 'system' | 'user' | 'assistant';
}

/** The `extensions` block of a V2 card, plus the keys other tools add. */
export interface CharacterExtensions {
	talkativeness?: number;
	fav?: boolean;
	world?: string;
	depth_prompt?: Partial<DepthPrompt>;
	regex_scripts?: RegexScript[];
	[key: string]: unknown;
}

/** The `data` block of a V2/V3 card — also what a standalone JSON card holds under `data`. */
export interface CharacterData {
	name?: string;
	description?: string;
	personality?: string;
	scenario?: string;
	first_mes?: string;
	mes_example?: string;
	creator_notes?: string;
	system_prompt?: string;
	post_history_instructions?: string;
	alternate_greetings?: string[];
	character_book?: CharacterBook;
	tags?: string[];
	creator?: string;
	character_version?: string;
	extensions?: CharacterExtensions;
	/** Unknown fields survive a load/save round trip. */
	[key: string]: unknown;
}

/**
 * A character card as it sits on disk: a V2/V3 document with a `data` block, or a V1 document with
 * its fields at the root. Nothing is normalised here — that is `normaliseCard`'s job.
 */
export interface CharacterCard {
	spec?: string;
	spec_version?: string;
	/** V1 fields, kept so a V1 card can be written back unchanged. */
	name?: string;
	description?: string;
	personality?: string;
	scenario?: string;
	first_mes?: string;
	mes_example?: string;
	creatorcomment?: string;
	tags?: string[];
	avatar?: string;
	data?: CharacterData;
	[key: string]: unknown;
}

/**
 * A card as Comonad uses it: one flat view plus the untouched document for a lossless export. A
 * PNG card is its own picture, which is how upstream stores the two together; a JSON card has none.
 */
export interface Character {
	id: string;
	name: string;
	description: string;
	personality: string;
	scenario: string;
	/** `first_mes`: what is inserted as the opening turn. */
	greeting: string;
	alternateGreetings: string[];
	/** `mes_example`: the `<START>`-separated dialogue examples. */
	examples: string;
	systemPrompt: string;
	postHistoryInstructions: string;
	creatorNotes: string;
	creator: string;
	version: string;
	tags: string[];
	/** `extensions.fav`, and the V1 root `fav` beside it: upstream's favourite, which its list filters on. */
	favourite: boolean;
	/** `extensions.talkativeness`: how much this character speaks in a group chat. */
	talkativeness: number;
	/** The root `create_date` upstream stamps on a card; empty for a card that never had one. */
	createdAt: string;
	/** `extensions.source_url`: where the card came from, shown by upstream's *Link to Source*. */
	sourceLink: string;
	depthPrompt: DepthPrompt | null;
	/** `extensions.world`: a world book the card binds, scanned without being listed. */
	world: string;
	/** The card's own world book, unconverted. */
	book: CharacterBook | null;
	regex: RegexScript[];
	/** Where it was loaded from, so the picker can say so. */
	source: string;
	/** The document as read, so writing it back never loses a field we do not model. */
	raw: CharacterCard;
}

/* ------------------------------------------------------------------ personas */

/**
 * One end of a persona connection, in upstream's own shape. A `character` id is the card's avatar
 * name, which is the id Comonad gives a card; a `group` connection is kept and compared like any
 * other, though Comonad has no group chats that could create one.
 */
export interface PersonaConnection {
	type: 'character' | 'group';
	id: string;
}

export interface PersonaDescription {
	description?: string;
	title?: string;
	position?: number;
	depth?: number;
	role?: number;
	/** Name of a world book bound to this persona. */
	lorebook?: string;
	/** The characters and groups this persona is bound to; empty means it is available anywhere. */
	connections?: PersonaConnection[];
	[key: string]: unknown;
}

/** One persona: the user's own name and description for a chat. */
export interface Persona {
	id: string;
	name: string;
	description: string;
	title: string;
	position: number;
	depth: number;
	role: number;
	lorebook: string;
	/** Chats whose character is in this list use the persona automatically. */
	connections: PersonaConnection[];
	source: string;
	/** The picture beside the file, when there is one, as an absolute path. */
	avatar?: string;
	raw: PersonaDescription;
}

/* ------------------------------------------------------------------ prompts and presets */

/** One of upstream's named logit-bias sets: a map of token id to bias, with a name to pick it by. */
export interface LogitBiasSet {
	id: string;
	name: string;
	value: Record<string, number>;
}

/** One entry of the prompt manager: a block, where it goes, and whether it is on. */
export interface PromptItem {
	identifier: string;
	name?: string;
	role: 'system' | 'user' | 'assistant';
	/** Literal text for non-marker blocks; markers are filled from the chat and the card. */
	content?: string;
	system_prompt?: boolean;
	/** A placeholder that another step fills in (chat history, examples, world info, the card). */
	marker?: boolean;
	position?: 'start' | 'end';
	injection_position?: number;
	injection_depth?: number;
	injection_order?: number;
	/**
	 * The generation types this block is sent for — upstream's *Triggers*. An empty list, or no list at
	 * all, means every type.
	 */
	injection_trigger?: string[];
	forbid_overrides?: boolean;
	extension?: boolean;
}

/**
 * A prompt saved in one of the two prompt libraries rather than in the ordered list. A *system*
 * entry lives in the shared `.comonad/prompt-library.json` and every preset can use it; a *preset*
 * entry lives in the preset's own file under {@link PROMPT_LIBRARY_KEY}, and only that preset can.
 * `description` is Comonad's own — SillyTavern's `PromptItem` has no such field — and rides only in
 * the shared file, where it is shown beside the name.
 */
export interface PromptLibraryEntry extends PromptItem {
	description?: string;
}

/** The per-character order: which prompts, in which order, enabled or not. */
export interface PromptOrderEntry {
	identifier: string;
	enabled: boolean;
}

/** A preset as on disk, with the sampler fields kept under their SillyTavern names. */
export interface TavernPreset {
	id: string;
	name: string;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	top_a?: number;
	min_p?: number;
	frequency_penalty?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
	maxContext?: number;
	maxTokens?: number;
	wi_format?: string;
	scenario_format?: string;
	personality_format?: string;
	impersonation_prompt?: string;
	names_behavior?: number;
	assistant_prefill?: string;
	squash_system_messages?: boolean;
	/**
	 * The nudge prompts. Upstream sends one when there is otherwise nothing to send: at the head of
	 * the chat history, when a reply is continued, or when the user sends nothing at all.
	 */
	new_chat_prompt?: string;
	new_group_chat_prompt?: string;
	new_example_chat_prompt?: string;
	continue_nudge_prompt?: string;
	group_nudge_prompt?: string;
	send_if_empty?: string;
	/** `seed`, when the endpoint accepts one. */
	seed?: number;
	/** `logit_bias`: the set in use, and every set the preset carries. */
	logitBiasSelected?: string;
	logitBias?: LogitBiasSet[];
	/** `stream_openai`: off asks for the whole reply at once instead of a stream of tokens. */
	stream?: boolean;
	/** `max_context_unlocked`: send the full context size even when the model is thought to be smaller. */
	maxContextUnlocked?: boolean;
	/** `use_sysprompt`: fold the system prompt into the first user message, for backends that want that. */
	useSysprompt?: boolean;
	/** Prompts as the user arranged them; the shipped order applies when absent. */
	prompts?: PromptItem[];
	/**
	 * This preset's own prompt library: entries saved for this preset alone, ready to be inserted
	 * into `prompts`. Stored in the file under {@link PROMPT_LIBRARY_KEY}, which SillyTavern ignores.
	 */
	promptLibrary?: PromptLibraryEntry[];
	/** The order the default character uses. */
	promptOrder?: PromptOrderEntry[];
	/** Per-character orders, keyed by character, the way upstream keys its blocks by character id. */
	promptOrders?: Record<string, PromptOrderEntry[]>;
	/** Where it was loaded from, so a save writes back to the same file. */
	source?: string;
	/** The file as read, so a save round-trips unknown keys. */
	raw: Record<string, unknown>;
}

/* ------------------------------------------------------------------ world-info settings */

/** The scan knobs, named as SillyTavern names them. */
export interface WorldInfoSettings {
	/** How many messages back the scan text reaches. */
	scanDepth: number;
	/** Percentage of the context the injected entries may use. */
	budget: number;
	/** Hard cap in tokens; `0` disables it. */
	budgetCap: number;
	/** Scan the text of just-activated entries again, up to `maxRecursionSteps`. */
	recursive: boolean;
	maxRecursionSteps: number;
	/** Keep scanning back until at least this many entries activated; `0` disables it. */
	minActivations: number;
	/** How far back the minimum-activations search may go. */
	maxActivationsDepth: number;
	caseSensitive: boolean;
	matchWholeWords: boolean;
	/** Prefix each entry with its primary key, as SillyTavern's `world_info_include_names` does. */
	includeNames: boolean;
	characterStrategy: number;
	useGroupScoring: boolean;
}
