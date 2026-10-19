// SPDX-License-Identifier: AGPL-3.0-only
import { Service, type Context } from 'cordis';
import { DEFAULT_GRAPH_SOURCE } from '../lib/mermaid';
import { asApproval, asWorkMode, parseRules, type RuleSet } from '../lib/policy';
import type { ContextForm } from '../lib/prompt';
import { parsePromptLayout, parseToolLayout, type PromptBlockSetting, type ToolPromptSetting } from '../lib/prompt-layout';
import type { Approval, Capability, Confinement, ReasoningEffort, WorkMode } from '../lib/types';
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
	/**
	 * The model's input window in tokens. This is what `Auto` resolves the chat's budget from, so a
	 * model missing here counts against `DEFAULT_CONTEXT_WINDOW` and the panel says so rather than
	 * guessing silently. Values come from the provider's own documentation.
	 */
	contextWindow?: number;
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
 *
 * `contextWindow` is the provider's **input** window, not its maximum output: DeepSeek documents a
 * 1M context for V4 Flash and V4 Pro on that same pricing page, and Google documents 1,048,576 input
 * tokens for Gemini 3.8 Flash. A model added later needs the same figure from its own provider.
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
		contextWindow: 1_048_576,
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
		contextWindow: 1_048_576,
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
		contextWindow: 1_048_576,
	},
];

/**
 * What a model with no configured window is assumed to hold. 128K is the floor every current
 * frontier model clears, so a wrong guess costs an occasional unnecessary summary instead of a
 * rejected request — and the panel says the number is a guess, so it can be corrected.
 */
export const DEFAULT_CONTEXT_WINDOW = 131_072;

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
	/** Refuse reads outside the working directory, in the file tools and in the shell sandbox. */
	confineRead: boolean;
	/** Refuse writes outside the working directory, in the file tools and in the shell sandbox. */
	confineWrite: boolean;
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
	/** Window override in tokens for new chats; `0` resolves from the model profile. */
	contextWindow: number;
	budgetUsd: number;
	filterSensitiveEnv: boolean;
	allowFullAccess: boolean;
	/** Let shell tools run without the extra confirmation when no OS sandbox is available. */
	allowUnsandboxedShell: boolean;
	/** A SillyTavern folder whose `src/tokenizers` holds the tokenizer files it ships itself. */
	tokenizerDir: string;
	/** Show the agent's changes inline in the editor, with Keep/Undo on each block and each file. */
	inlineDiff: boolean;
	/** Comonad's own prompt blocks: order, switches and the editable static prefix of each. */
	prompts: PromptBlockSetting[];
	/** Tool order and per-tool switches; definitions themselves stay with their plugins. */
	toolPrompts: ToolPromptSetting[];
}

/**
 * Every settings key the kernel reads, in one place. `Host.config()` reports the keys the manifest
 * declares, so a setting nothing lists is a setting nothing reads back. `as const`
 * makes a typo a compile error; a test compares the lists with `contributes.configuration` to catch a
 * setting added on one side only.
 */
export const CONFIG_KEYS = [
	'mode',
	'approval',
	'network',
	'workingDirectory',
	'commandTimeout',
	'denyReadPaths',
	'confineRead',
	'confineWrite',
	'planDirectory',
	'maxSteps',
	'graph',
	'model',
	'profiles',
	'mcpServers',
	'permissions',
	'instructions',
	'skills',
	'memory',
	'checkpoints',
	'chatWindow',
	'contextForm',
	'displayForm',
	'reasoningEffort',
	'contextWindow',
	'budgetUsd',
	'filterSensitiveEnv',
	'allowFullAccess',
	'allowUnsandboxedShell',
	'tokenizerDir',
	'inlineDiff',
	'prompts',
	'toolPrompts',
] as const satisfies readonly (keyof Config)[];

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
		// A hand-edited settings file can hold anything. A bad value is read as its fallback rather
		// than carried into a gate or a lookup that crashes on it — a wrong `mode` used to take the
		// whole policy path down (`MODE_CAPS[mode]`).
		const oneOf = <T extends string>(key: keyof Config, allowed: readonly T[], fallback: T): T => {
			const found = raw[key];
			return typeof found === 'string' && (allowed as readonly string[]).includes(found) ? (found as T) : fallback;
		};
		const count = (key: keyof Config, fallback: number, minimum: number): number => {
			const found = Number(raw[key]);
			return Number.isFinite(found) && found >= minimum ? found : fallback;
		};
		const flag = (key: keyof Config, fallback: boolean): boolean => {
			const found = raw[key];
			return typeof found === 'boolean' ? found : fallback;
		};
		const lines = (key: keyof Config, fallback: string[]): string[] =>
			Array.isArray(raw[key]) ? (raw[key] as unknown[]).map(String) : fallback;
		const permissions = value('permissions', undefined as unknown as PermissionsConfig);
		const profiles = value('profiles', undefined as unknown as Profile[]);
		return {
			mode: asWorkMode(raw.mode),
			approval: asApproval(raw.approval),
			network: flag('network', false),
			workingDirectory: (typeof raw.workingDirectory === 'string' ? raw.workingDirectory : '') || folder,
			commandTimeout: count('commandTimeout', 60, 1),
			denyReadPaths: lines('denyReadPaths', ['.env', '**/.env']),
			confineRead: flag('confineRead', false),
			confineWrite: flag('confineWrite', true),
			planDirectory: typeof raw.planDirectory === 'string' ? raw.planDirectory : '',
			maxSteps: count('maxSteps', 48, 1),
			graph: typeof raw.graph === 'string' ? raw.graph : DEFAULT_GRAPH_SOURCE,
			model: typeof raw.model === 'string' ? raw.model : 'auto',
			// An empty list means "nothing configured", which would leave the chat without a model, so
			// the built-in DeepSeek profiles stand in for it.
			profiles: withDefaults(Array.isArray(profiles) ? profiles : []),
			mcpServers: raw.mcpServers && typeof raw.mcpServers === 'object' ? (raw.mcpServers as Record<string, McpServerSettings>) : {},
			permissions:
				permissions && typeof permissions === 'object'
					? {
							allow: Array.isArray(permissions.allow) ? permissions.allow.map(String) : [],
							ask: Array.isArray(permissions.ask) ? permissions.ask.map(String) : [],
							deny: Array.isArray(permissions.deny) ? permissions.deny.map(String) : [],
						}
					: { allow: [], ask: [], deny: [] },
			instructions: flag('instructions', true),
			skills: flag('skills', true),
			memory: flag('memory', true),
			checkpoints: flag('checkpoints', true),
			chatWindow: flag('chatWindow', false),
			contextForm: oneOf('contextForm', CONTEXT_FORMS, 'rendered'),
			displayForm: oneOf('displayForm', CONTEXT_FORMS, 'rendered'),
			reasoningEffort: oneOf('reasoningEffort', REASONING_EFFORTS, 'auto'),
			contextWindow: count('contextWindow', 0, 0),
			budgetUsd: count('budgetUsd', 0, 0),
			filterSensitiveEnv: flag('filterSensitiveEnv', true),
			allowFullAccess: flag('allowFullAccess', true),
			allowUnsandboxedShell: flag('allowUnsandboxedShell', false),
			tokenizerDir: typeof raw.tokenizerDir === 'string' ? raw.tokenizerDir : '',
			inlineDiff: flag('inlineDiff', true),
			// Both are untrusted arrays: a webview save, a hand-edited settings file or a value from an
			// older build is sanitized into the canonical shape before it reaches the prompt builder.
			prompts: parsePromptLayout(raw.prompts),
			toolPrompts: parseToolLayout(raw.toolPrompts),
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

	/** Writes one key through to the host store — the kernel's own, or a plugin's. */
	async update(key: string, value: unknown): Promise<void> {
		await this.host.update(key, value);
		this.ctx.emit('settings/changed');
	}

	/** Applies a preset or partial policy to the workspace settings. */
	async applyPolicy(patch: {
		mode?: WorkMode;
		approval?: Approval;
		network?: boolean;
		confinement?: Confinement;
	}): Promise<void> {
		if (patch.mode) {
			await this.host.update('mode', patch.mode);
		}
		if (patch.approval) {
			await this.host.update('approval', patch.approval);
		}
		if (patch.network !== undefined) {
			await this.host.update('network', patch.network);
		}
		if (patch.confinement) {
			await this.host.update('confineRead', patch.confinement.read);
			await this.host.update('confineWrite', patch.confinement.write);
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

/** The remaining value sets a `get()` may fall back within — a settings file is untrusted input. */
const CONTEXT_FORMS: readonly ContextForm[] = ['rendered', 'token', 'raw'];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['auto', 'none', 'low', 'medium', 'high'];
