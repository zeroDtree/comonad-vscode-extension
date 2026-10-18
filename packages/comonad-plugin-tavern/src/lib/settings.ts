import type { Context } from 'cordis';
import type { RegexScript, WorldInfoSettings } from './types';

/**
 * The tavern layer's own settings: its keys, their defaults, and the typed view over the raw
 * `comonad.*` values the host reports. The kernel's `Config` knows nothing about these — a plugin's
 * settings are the plugin's own — and the manifest declares them only so a value the panel writes
 * is a value that comes back. Writes go through `ctx.settings.update`, like every other key.
 */

/** The world-info scan knobs, at the defaults SillyTavern sets them to. */
export const WI_SETTINGS_DEFAULTS: WorldInfoSettings = {
	scanDepth: 2,
	budget: 25,
	budgetCap: 0,
	recursive: false,
	maxRecursionSteps: 0,
	minActivations: 0,
	maxActivationsDepth: 0,
	caseSensitive: false,
	matchWholeWords: false,
	includeNames: true,
	characterStrategy: 1, // WI_STRATEGY.characterFirst
	useGroupScoring: false,
};

export interface TavernSettings {
	/** Master switch. With it off nothing from the tavern layer reaches a request. */
	tavernEnabled: boolean;
	/** Character id used by new chats; a chat can pick its own. */
	tavernCharacter: string;
	tavernPersona: string;
	/** The name `{{user}}` resolves to when the persona has none. */
	tavernUserName: string;
	/** Picking a persona locks it to the chat straight away — upstream's `persona_auto_lock`. */
	personaAutoLock: boolean;
	/** Allow more than one persona to be connected to the same character, as upstream does. */
	personaAllowMultiConnections: boolean;
	/** Say so when the chat's persona changes. */
	personaShowNotifications: boolean;
	tavernLorebooks: string[];
	tavernPreset: string;
	/** Standing text injected into the chat at `tavernNoteDepth`, like an author's note. */
	tavernAuthorNote: string;
	tavernNoteDepth: number;
	tavernWiFormat: string;
	tavernScenarioFormat: string;
	tavernPersonalityFormat: string;
	tavernRegex: RegexScript[];
	wiScanDepth: number;
	wiBudget: number;
	wiBudgetCap: number;
	wiRecursive: boolean;
	wiMaxRecursionSteps: number;
	wiMinActivations: number;
	wiMaxActivationsDepth: number;
	wiCaseSensitive: boolean;
	wiMatchWholeWords: boolean;
	wiIncludeNames: boolean;
	wiCharacterStrategy: number;
	wiGroupScoring: boolean;
	/** Warn when the scan ran out of world-info budget and dropped entries. */
	wiOverflowAlert: boolean;
	/**
	 * Run the automation an activated entry names (upstream's *Automation ID*): a hook event and a
	 * slash command of that name. Off by default, because a name is enough to run it.
	 */
	wiAutomation: boolean;
	/**
	 * The vector side of a world book (SillyTavern's Vectors extension for World Info): an entry that
	 * says `vectorized` is found by meaning instead of by keys, and an embedding endpoint does the
	 * finding. Off by default, because it needs an endpoint that embeds.
	 */
	wiVectorEnabled: boolean;
	/** The profile whose endpoint embeds. Empty means the chat's own model profile. */
	wiVectorProfile: string;
	wiVectorModel: string;
	/** The lowest cosine similarity an entry needs to be injected. */
	wiVectorThreshold: number;
	/** How many entries one book may contribute to a turn. */
	wiVectorMaxEntries: number;
	/** How many of the newest messages form the query. */
	wiVectorQuery: number;
	/**
	 * What to do with the tags a character card ships in its own `tags` field: upstream's
	 * `tag_import_setting` — `ASK` (1), `NONE` (2), `ALL` (3) or `ONLY_EXISTING` (4).
	 */
	tagImportSetting: number;
}

/** Every settings key the layer reads — what the manifest declares and the panel writes. */
export const TAVERN_SETTING_KEYS: readonly (keyof TavernSettings)[] = [
	'tavernEnabled',
	'tavernCharacter',
	'tavernPersona',
	'tavernUserName',
	'personaAutoLock',
	'personaAllowMultiConnections',
	'personaShowNotifications',
	'tavernLorebooks',
	'tavernPreset',
	'tavernAuthorNote',
	'tavernNoteDepth',
	'tavernWiFormat',
	'tavernScenarioFormat',
	'tavernPersonalityFormat',
	'tavernRegex',
	'wiScanDepth',
	'wiBudget',
	'wiBudgetCap',
	'wiRecursive',
	'wiMaxRecursionSteps',
	'wiMinActivations',
	'wiMaxActivationsDepth',
	'wiCaseSensitive',
	'wiMatchWholeWords',
	'wiIncludeNames',
	'wiCharacterStrategy',
	'wiGroupScoring',
	'wiOverflowAlert',
	'wiAutomation',
	'wiVectorEnabled',
	'wiVectorProfile',
	'wiVectorModel',
	'wiVectorThreshold',
	'wiVectorMaxEntries',
	'wiVectorQuery',
	'tagImportSetting',
];

function defaults(): TavernSettings {
	return {
		tavernEnabled: true,
		tavernCharacter: '',
		tavernPersona: '',
		tavernUserName: 'User',
		personaAutoLock: false,
		personaAllowMultiConnections: false,
		personaShowNotifications: true,
		tavernLorebooks: [],
		tavernPreset: '',
		tavernAuthorNote: '',
		tavernNoteDepth: 4,
		tavernWiFormat: '{0}',
		tavernScenarioFormat: '{{scenario}}',
		tavernPersonalityFormat: '{{personality}}',
		tavernRegex: [],
		wiScanDepth: WI_SETTINGS_DEFAULTS.scanDepth,
		wiBudget: WI_SETTINGS_DEFAULTS.budget,
		wiBudgetCap: WI_SETTINGS_DEFAULTS.budgetCap,
		wiRecursive: WI_SETTINGS_DEFAULTS.recursive,
		wiMaxRecursionSteps: WI_SETTINGS_DEFAULTS.maxRecursionSteps,
		wiMinActivations: WI_SETTINGS_DEFAULTS.minActivations,
		wiMaxActivationsDepth: WI_SETTINGS_DEFAULTS.maxActivationsDepth,
		wiCaseSensitive: WI_SETTINGS_DEFAULTS.caseSensitive,
		wiMatchWholeWords: WI_SETTINGS_DEFAULTS.matchWholeWords,
		wiIncludeNames: WI_SETTINGS_DEFAULTS.includeNames,
		wiCharacterStrategy: WI_SETTINGS_DEFAULTS.characterStrategy,
		wiGroupScoring: WI_SETTINGS_DEFAULTS.useGroupScoring,
		wiOverflowAlert: false,
		wiAutomation: false,
		wiVectorEnabled: false,
		wiVectorProfile: '',
		wiVectorModel: 'text-embedding-3-small',
		wiVectorThreshold: 0.25,
		wiVectorMaxEntries: 5,
		wiVectorQuery: 2,
		tagImportSetting: TAG_IMPORT.ASK,
	};
}

/** The settings as they stand: the stored values over the defaults, freshly built every read. */
export function tavernSettings(ctx: Context): TavernSettings {
	const raw = ctx.host.config();
	const settings = defaults();
	for (const key of TAVERN_SETTING_KEYS) {
		if (raw[key] !== undefined) {
			(settings as Record<keyof TavernSettings, unknown>)[key] = raw[key];
		}
	}
	return settings;
}

/** The vector side of a world book, gathered the way the vectors service wants them. */
export interface VectorSettings {
	enabled: boolean;
	profile: string;
	model: string;
	threshold: number;
	maxEntries: number;
	queryMessages: number;
}

export function vectorSettings(ctx: Context): VectorSettings {
	const config = tavernSettings(ctx);
	return {
		enabled: config.wiVectorEnabled,
		profile: config.wiVectorProfile,
		model: config.wiVectorModel.trim() || 'text-embedding-3-small',
		threshold: Number.isFinite(config.wiVectorThreshold) ? config.wiVectorThreshold : 0.25,
		maxEntries: Number.isFinite(config.wiVectorMaxEntries) ? config.wiVectorMaxEntries : 5,
		queryMessages: Number.isFinite(config.wiVectorQuery) ? config.wiVectorQuery : 2,
	};
}

/** What a card import does with the card's tags: ask, keep none, keep all, or keep the known ones. */
export const TAG_IMPORT = { ASK: 1, NONE: 2, ALL: 3, ONLY_EXISTING: 4 } as const;
