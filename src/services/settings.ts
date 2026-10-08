import { Service, type Context } from 'cordis';
import { DEFAULT_GRAPH_SOURCE } from '../lib/mermaid';
import { parseRules, type RuleSet } from '../lib/policy';
import type { ContextForm } from '../lib/prompt';
import { WI_SETTINGS_DEFAULTS, type RegexScript } from '../lib/tavern/types';
import type { Approval, Capability, ReasoningEffort, WorkMode } from '../lib/types';
import type { Host } from './host';

/** Typed view over the `comonad.*` settings section. */

export interface Profile {
	id: string;
	label?: string;
	/** Which model adapter runs this profile; the built-in one is `openai`. */
	provider?: string;
	base?: string;
	/** The model a bare profile id selects; the model menu lists what the endpoint itself reports. */
	model: string;
	/**
	 * Prefix the endpoint puts on the ids it reports (`GET /models`), stripped so the menu and the
	 * requests use the plain name — Gemini answers `models/gemini-3.8-flash`, chats as `gemini-3.8-flash`.
	 */
	modelPrefix?: string;
	/** Regex of reported model ids to leave out of the menu — providers list non-chat models too. */
	modelSkip?: string;
	/** Environment variable(s) holding the key when none is stored in the OS keychain, tried in order. */
	keyEnv?: string | string[];
	/** How this endpoint turns thinking off for the `none` effort (`thinking` = DeepSeek's field). */
	thinkingOff?: 'thinking' | 'effort';
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	includeUsage?: boolean;
	/** USD per million input tokens (cache miss), for /cost estimates. */
	pricingIn?: number;
	/** USD per million input tokens served from the prompt cache. */
	pricingCachedIn?: number;
	/** USD per million output tokens. */
	pricingOut?: number;
}

/** The variable names a profile would read its key from, in order. */
export function profileKeyEnvs(profile: Profile): string[] {
	if (!profile.keyEnv) {
		return [];
	}
	return Array.isArray(profile.keyEnv) ? profile.keyEnv : [profile.keyEnv];
}

/**
 * The shipped defaults, and the only place in the code that knows a provider's name. Everything the
 * adapters need is data on the profile: the endpoint, the default model, the variables the key is
 * read from (`keyEnv`), how to switch thinking off (`thinkingOff`) and what the tokens cost.
 *
 * DeepSeek Flash comes first, so `Auto` runs on it. Prices are DeepSeek's list rates in USD per
 * million tokens from https://api-docs.deepseek.com/quick_start/pricing — **peak** hours, cache-miss
 * input, so `/cost` is an upper bound (off-peak is half) while `pricingCachedIn` keeps long agent
 * loops honest, since a cached prompt costs 2 % of a fresh one.
 */
export const DEFAULT_PROFILES: Profile[] = [
	{
		id: 'deepseek',
		label: 'DeepSeek Flash',
		base: 'https://api.deepseek.com',
		model: 'deepseek-flash',
		keyEnv: 'DEEPSEEK_API_KEY',
		thinkingOff: 'thinking',
		includeUsage: true,
		pricingIn: 0.3,
		pricingCachedIn: 0.006,
		pricingOut: 1.2,
	},
	{
		id: 'deepseek-pro',
		label: 'DeepSeek V4 Pro',
		base: 'https://api.deepseek.com',
		model: 'deepseek-v4-pro',
		keyEnv: 'DEEPSEEK_API_KEY',
		thinkingOff: 'thinking',
		includeUsage: true,
		pricingIn: 1.32,
		pricingCachedIn: 0.044,
		pricingOut: 3.96,
	},
	{
		id: 'gemini',
		label: 'Gemini 3.8 Flash',
		base: 'https://generativelanguage.googleapis.com/v1beta/openai',
		model: 'gemini-3.8-flash',
		// Gemini reports its native `models/<id>` form, and lists image, computer-use, research and
		// embedding models that cannot run a chat turn — both are data, so edit them freely.
		modelPrefix: 'models/',
		modelSkip: 'computer-use|deep-research|antigravity|aqa|-image|imagen|veo|embedding|-tts|live',
		keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
		thinkingOff: 'effort',
		includeUsage: true,
	},
];

export interface PermissionsConfig {
	allow: string[];
	ask: string[];
	deny: string[];
}

export interface McpServerSettings {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	enabled?: boolean;
	capability?: Capability;
	writeTools?: string[];
	exclude?: string[];
	overrides?: Record<string, { capability?: Capability; needsNetwork?: boolean }>;
	timeoutMs?: number;
}

export interface Config {
	mode: WorkMode;
	approval: Approval;
	network: boolean;
	workingDirectory: string;
	commandTimeout: number;
	denyReadPaths: string[];
	/** Workspace-relative folder for plan files; empty uses `.comonad/plans`. */
	planDirectory: string;
	maxSteps: number;
	graph: string;
	model: string;
	profiles: Profile[];
	mcpServers: Record<string, McpServerSettings>;
	permissions: PermissionsConfig;
	instructions: boolean;
	skills: boolean;
	memory: boolean;
	checkpoints: boolean;
	chatWindow: boolean;
	contextForm: ContextForm;
	displayForm: ContextForm;
	reasoningEffort: ReasoningEffort;
	contextLimit: number;
	autoCompactChars: number;
	budgetUsd: number;
	filterSensitiveEnv: boolean;
	allowFullAccess: boolean;
	// Tavern content: a character, a persona, world books and a preset, layered on top of the agent.
	/** Master switch. With it off nothing from the tavern layer reaches a request. */
	tavernEnabled: boolean;
	/** Character id used by new chats; a chat can pick its own. */
	tavernCharacter: string;
	tavernPersona: string;
	/** The name `{{user}}` resolves to when the persona has none. */
	tavernUserName: string;
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
}

declare module 'cordis' {
	interface Context {
		settings: Settings;
	}
}

export class Settings extends Service {
	static inject = ['host'];

	constructor(ctx: Context) {
		super(ctx, 'settings');
	}

	private get host(): Host {
		return this.ctx.host;
	}

	get(): Config {
		const raw = this.host.config();
		const folder = this.workspace();
		const value = <T>(key: keyof Config, fallback: T): T => {
			const found = raw[key];
			return found === undefined ? fallback : (found as T);
		};
		return {
			mode: value('mode', 'sw' as WorkMode),
			approval: value('approval', 'manual' as Approval),
			network: value('network', false),
			workingDirectory: value('workingDirectory', '') || folder,
			commandTimeout: value('commandTimeout', 60),
			denyReadPaths: value('denyReadPaths', ['.env', '**/.env']),
			planDirectory: value('planDirectory', ''),
			maxSteps: value('maxSteps', 48),
			graph: value('graph', DEFAULT_GRAPH_SOURCE),
			model: value('model', 'auto'),
			// An empty list means "nothing configured", which would leave the chat without a model, so
			// the built-in DeepSeek profiles stand in for it.
			profiles: withDefaults(value('profiles', [] as Profile[])),
			mcpServers: value('mcpServers', {} as Record<string, McpServerSettings>),
			permissions: value('permissions', { allow: [], ask: [], deny: [] } as PermissionsConfig),
			instructions: value('instructions', true),
			skills: value('skills', true),
			memory: value('memory', true),
			checkpoints: value('checkpoints', true),
			chatWindow: value('chatWindow', false),
			contextForm: value('contextForm', 'rendered' as ContextForm),
			displayForm: value('displayForm', 'rendered' as ContextForm),
			reasoningEffort: value('reasoningEffort', 'auto' as ReasoningEffort),
			contextLimit: value('contextLimit', 0),
			autoCompactChars: value('autoCompactChars', 400_000),
			budgetUsd: value('budgetUsd', 0),
			filterSensitiveEnv: value('filterSensitiveEnv', true),
			allowFullAccess: value('allowFullAccess', true),
			tavernEnabled: value('tavernEnabled', true),
			tavernCharacter: value('tavernCharacter', ''),
			tavernPersona: value('tavernPersona', ''),
			tavernUserName: value('tavernUserName', 'User'),
			tavernLorebooks: value('tavernLorebooks', [] as string[]),
			tavernPreset: value('tavernPreset', ''),
			tavernAuthorNote: value('tavernAuthorNote', ''),
			tavernNoteDepth: value('tavernNoteDepth', 4),
			tavernWiFormat: value('tavernWiFormat', '{0}'),
			tavernScenarioFormat: value('tavernScenarioFormat', '{{scenario}}'),
			tavernPersonalityFormat: value('tavernPersonalityFormat', '{{personality}}'),
			tavernRegex: value('tavernRegex', [] as RegexScript[]),
			wiScanDepth: value('wiScanDepth', WI_SETTINGS_DEFAULTS.scanDepth),
			wiBudget: value('wiBudget', WI_SETTINGS_DEFAULTS.budget),
			wiBudgetCap: value('wiBudgetCap', WI_SETTINGS_DEFAULTS.budgetCap),
			wiRecursive: value('wiRecursive', WI_SETTINGS_DEFAULTS.recursive),
			wiMaxRecursionSteps: value('wiMaxRecursionSteps', WI_SETTINGS_DEFAULTS.maxRecursionSteps),
			wiMinActivations: value('wiMinActivations', WI_SETTINGS_DEFAULTS.minActivations),
			wiMaxActivationsDepth: value('wiMaxActivationsDepth', WI_SETTINGS_DEFAULTS.maxActivationsDepth),
			wiCaseSensitive: value('wiCaseSensitive', WI_SETTINGS_DEFAULTS.caseSensitive),
			wiMatchWholeWords: value('wiMatchWholeWords', WI_SETTINGS_DEFAULTS.matchWholeWords),
			wiIncludeNames: value('wiIncludeNames', WI_SETTINGS_DEFAULTS.includeNames),
			wiCharacterStrategy: value('wiCharacterStrategy', WI_SETTINGS_DEFAULTS.characterStrategy),
			wiGroupScoring: value('wiGroupScoring', WI_SETTINGS_DEFAULTS.useGroupScoring),
		};
	}

	rules(): RuleSet {
		return parseRules(this.get().permissions);
	}

	workspace(): string {
		return this.host.workspace();
	}

	home(): string {
		return this.host.home();
	}

	trusted(): boolean {
		return this.host.trusted();
	}

	async update(key: keyof Config, value: unknown): Promise<void> {
		await this.host.update(key, value);
		this.ctx.emit('settings/changed');
	}

	/** Applies a preset or partial policy to the workspace settings. */
	async applyPolicy(patch: { mode?: WorkMode; approval?: Approval; network?: boolean }): Promise<void> {
		if (patch.mode) {
			await this.host.update('mode', patch.mode);
		}
		if (patch.approval) {
			await this.host.update('approval', patch.approval);
		}
		if (patch.network !== undefined) {
			await this.host.update('network', patch.network);
		}
		this.ctx.emit('settings/changed');
	}

	async addAllowRule(rule: string): Promise<void> {
		const current = this.get().permissions;
		if (current.allow.includes(rule)) {
			return;
		}
		await this.update('permissions', { allow: [...current.allow, rule], ask: [...current.ask], deny: [...current.deny] });
	}
}

export const settingsPlugin = Settings;

/** Configured profiles, or the built-in DeepSeek ones when nothing is configured. */
function withDefaults(profiles: Profile[]): Profile[] {
	return profiles.length ? profiles : DEFAULT_PROFILES;
}
