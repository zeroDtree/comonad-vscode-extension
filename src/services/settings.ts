// SPDX-License-Identifier: AGPL-3.0-only
import { Service, type Context } from 'cordis';
import type { EffortTop } from '../lib/effort';
import { asApproval, asApprovalResponse, asWorkMode, parseRules, type RuleSet } from '../lib/policy';
import type { ContextForm } from '../lib/prompt';
import { parsePromptLayout, parseToolLayout, type PromptBlockSetting, type ToolPromptSetting } from '../lib/prompt-layout';
import { asSandboxMode, DEFAULT_SANDBOX_MODE } from '../lib/sandbox';
import type { Approval, ApprovalResponse, Capability, ReasoningEffort, SandboxMode, WorkMode } from '../lib/types';
import type { Host } from './host';

/** Typed view over the `comonad.*` settings section. */

/** How a tool card starts out: folded to its header, folded with a preview, or open. */
export type ToolCardMode = 'collapsed' | 'preview' | 'open';
export const TOOL_CARD_MODES: readonly ToolCardMode[] = ['collapsed', 'preview', 'open'];

/** Where a subagent's step budget comes from: the turn's own `maxSteps`, or a budget of its own. */
export type SubagentStepsMode = 'inherit' | 'custom';
export const SUBAGENT_STEPS_MODES: readonly SubagentStepsMode[] = ['inherit', 'custom'];

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
	/** The deepest thinking level the endpoint accepts; a pick above it runs at this level. */
	topEffort?: EffortTop;
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
		topEffort: 'max',
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
		topEffort: 'max',
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
		// Gemini 3's ladder stops at high: minimal/low/medium/high, and some probes only low/high.
		topEffort: 'high',
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

/** What a subagent may be granted. Read-only tools are always available; these add the write paths. */
export interface SubagentGrant {
	/** The tracked file-write tools (`write_file`, `apply_patch`, `apply_edits`). */
	files: boolean;
	/** The scratch-only test shell (`run_shell_test`). */
	test: boolean;
}

export type SubagentGrants = Record<string, SubagentGrant>;

export const READ_ONLY_GRANT: Readonly<SubagentGrant> = { files: false, test: false };

/**
 * The shipped subagent grants. Only the built-in implementer may write by default; every other
 * built-in and every custom agent stays read-only until the user grants it in Settings → Subagents.
 * The lookup is gated on `AgentDefinition.builtin`, so a project file that shadows a built-in name
 * does not inherit the default.
 */
export const DEFAULT_SUBAGENT_GRANTS: Readonly<Record<string, SubagentGrant>> = {
	implement: { files: true, test: true },
};

const SUBAGENT_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_SUBAGENT_GRANTS = 64;

/** A user's `comonad.subagents` object, sanitised: names are slugs, values are booleans. */
export function sanitizeSubagentGrants(value: unknown): SubagentGrants {
	const out: SubagentGrants = {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return out;
	}
	for (const [rawName, rawGrant] of Object.entries(value as Record<string, unknown>).slice(0, MAX_SUBAGENT_GRANTS)) {
		const name = rawName.trim().toLowerCase();
		if (!SUBAGENT_NAME.test(name) || name.length > 64) {
			continue;
		}
		if (name === '__proto__' || name === 'prototype' || name === 'constructor') {
			continue;
		}
		if (!rawGrant || typeof rawGrant !== 'object' || Array.isArray(rawGrant)) {
			continue;
		}
		const grant = rawGrant as Record<string, unknown>;
		out[name] = { files: grant.files === true, test: grant.test === true };
	}
	return out;
}

/**
 * The effective grant of one agent: an explicit entry wins outright, then the built-in default for a
 * genuine built-in, then read-only. A custom agent that reuses a built-in name gets nothing.
 */
export function subagentGrant(config: Pick<Config, 'subagents'>, name: string, builtin: boolean): SubagentGrant {
	const key = name.trim().toLowerCase();
	if (Object.hasOwn(config.subagents, key)) {
		return { ...config.subagents[key]! };
	}
	const shipped = builtin ? DEFAULT_SUBAGENT_GRANTS[key] : undefined;
	return shipped ? { ...shipped } : { ...READ_ONLY_GRANT };
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
	/** Who answers the requests the tool approval policy raised. */
	approvalResponse: ApprovalResponse;
	network: boolean;
	/** The OS-enforced read and write range for every call. */
	sandboxMode: SandboxMode;
	workingDirectory: string;
	commandTimeout: number;
	/** Pin every foreground shell call to `commandTimeout` instead of letting the model choose. */
	commandTimeoutOverride: boolean;
	denyReadPaths: string[];
	/** Workspace-relative folder for plan files; empty uses `.comonad/plans`. */
	planDirectory: string;
	maxSteps: number;
	/** Whether a subagent shares the turn's `maxSteps` or spends `subagentSteps`. */
	subagentStepsMode: SubagentStepsMode;
	/** A subagent's own step budget when the mode is `custom`; `0` means no limit. */
	subagentSteps: number;
	model: string;
	profiles: Profile[];
	mcpServers: Record<string, McpServerSettings>;
	permissions: PermissionsConfig;
	/** Per-agent capability grants for subagents; see `SubagentGrant`. */
	subagents: SubagentGrants;
	instructions: boolean;
	skills: boolean;
	memory: boolean;
	checkpoints: boolean;
	chatWindow: boolean;
	contextForm: ContextForm;
	displayForm: ContextForm;
	/** How a tool call is drawn when it first appears: preview, header only, or open. */
	toolCard: ToolCardMode;
	reasoningEffort: ReasoningEffort;
	/** Window override in tokens for new chats; `0` resolves from the model profile. */
	contextWindow: number;
	budgetUsd: number;
	filterSensitiveEnv: boolean;
	allowFullAccess: boolean;
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
	'approvalResponse',
	'network',
	'sandboxMode',
	'workingDirectory',
	'commandTimeout',
	'commandTimeoutOverride',
	'denyReadPaths',
	'planDirectory',
	'maxSteps',
	'subagentStepsMode',
	'subagentSteps',
	'model',
	'profiles',
	'mcpServers',
	'permissions',
	'subagents',
	'instructions',
	'skills',
	'memory',
	'checkpoints',
	'chatWindow',
	'contextForm',
	'displayForm',
	'toolCard',
	'reasoningEffort',
	'contextWindow',
	'budgetUsd',
	'filterSensitiveEnv',
	'allowFullAccess',
	'tokenizerDir',
	'inlineDiff',
	'prompts',
	'toolPrompts',
] as const satisfies readonly (keyof Config)[];

/** The Agent tab's keys: the settings a turn's policy is built from. */
export const AGENT_KEYS = [
	'model',
	'mode',
	'approval',
	'approvalResponse',
	'displayForm',
	'toolCard',
	'contextForm',
	'network',
	'sandboxMode',
	'workingDirectory',
	'commandTimeout',
	'commandTimeoutOverride',
	'planDirectory',
	'denyReadPaths',
] as const satisfies readonly (keyof Config)[];

/** A textarea (one entry per line) or an array, trimmed and without blanks. */
export function asList(value: unknown): string[] {
	return Array.isArray(value)
		? value.map((item) => String(item).trim()).filter(Boolean)
		: String(value ?? '')
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean);
}

/**
 * The Agent tab's share of a settings patch. Only the keys the patch actually carries are returned:
 * a partial patch must never turn an absent `network` into `false`. This is what lets the webview
 * save a single control and leaves every other setting exactly as it was.
 */
export type AgentConfig = Pick<Config, (typeof AGENT_KEYS)[number]>;

export function normalizeAgentPatch(
	patch: Record<string, unknown>,
	current: AgentConfig & Partial<Pick<Config, 'maxSteps' | 'subagentStepsMode' | 'subagentSteps'>>,
): Partial<Config> {
	const next: Partial<Config> = {};
	const has = (key: keyof Config): boolean => Object.hasOwn(patch, key);
	const form = (key: 'displayForm' | 'contextForm'): ContextForm => {
		const value = patch[key];
		return typeof value === 'string' && (CONTEXT_FORMS as readonly string[]).includes(value)
			? (value as ContextForm)
			: current[key];
	};
	if (has('model')) {
		next.model = typeof patch.model === 'string' ? patch.model : current.model;
	}
	if (has('mode')) {
		next.mode = asWorkMode(patch.mode, current.mode);
	}
	if (has('approval')) {
		next.approval = asApproval(patch.approval, current.approval);
	}
	if (has('approvalResponse')) {
		next.approvalResponse = asApprovalResponse(patch.approvalResponse, current.approvalResponse);
	}
	if (has('sandboxMode')) {
		next.sandboxMode = asSandboxMode(patch.sandboxMode, current.sandboxMode);
	}
	if (has('displayForm')) {
		next.displayForm = form('displayForm');
	}
	if (has('contextForm')) {
		next.contextForm = form('contextForm');
	}
	if (has('toolCard')) {
		const value = patch.toolCard;
		next.toolCard =
			typeof value === 'string' && (TOOL_CARD_MODES as readonly string[]).includes(value)
				? (value as ToolCardMode)
				: current.toolCard;
	}
	if (has('network')) {
		next.network = Boolean(patch.network);
	}
	if (has('workingDirectory')) {
		next.workingDirectory = String(patch.workingDirectory ?? '').trim();
	}
	if (has('commandTimeout')) {
		next.commandTimeout = Math.max(1, Number(patch.commandTimeout) || current.commandTimeout);
	}
	if (has('commandTimeoutOverride')) {
		next.commandTimeoutOverride = Boolean(patch.commandTimeoutOverride);
	}
	if (has('planDirectory')) {
		next.planDirectory = String(patch.planDirectory ?? '').trim();
	}
	if (has('denyReadPaths')) {
		next.denyReadPaths = asList(patch.denyReadPaths);
	}
	if (has('maxSteps')) {
		const value = Number(patch.maxSteps);
		next.maxSteps = Number.isFinite(value) ? Math.max(0, Math.round(value)) : (current.maxSteps ?? 0);
	}
	if (has('subagentSteps')) {
		const value = Number(patch.subagentSteps);
		next.subagentSteps = Number.isFinite(value) ? Math.max(0, Math.round(value)) : (current.subagentSteps ?? 40);
	}
	if (has('subagentStepsMode')) {
		next.subagentStepsMode =
			typeof patch.subagentStepsMode === 'string' && (SUBAGENT_STEPS_MODES as readonly string[]).includes(patch.subagentStepsMode)
				? (patch.subagentStepsMode as SubagentStepsMode)
				: (current.subagentStepsMode ?? 'custom');
	}
	return next;
}

/**
 * The step budget for one subagent run. `inherit` shares the turn's `maxSteps`; `custom` spends
 * `subagentSteps`. A definition's `maxTurns` counts turns rather than graph steps, so it keeps its
 * old two-steps-per-turn reading — and it can only tighten the chosen budget, never loosen it.
 * `0` means no limit, on either side of the comparison.
 */
export function subagentStepBudget(
	config: Pick<Config, 'subagentStepsMode' | 'subagentSteps'>,
	inherited: number,
	maxTurns?: number,
): number {
	const own = config.subagentStepsMode === 'inherit' ? inherited : config.subagentSteps;
	const definition = maxTurns === undefined ? 0 : Math.max(4, maxTurns * 2);
	if (own <= 0) {
		return definition;
	}
	return definition <= 0 ? own : Math.min(own, definition);
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
			approvalResponse: oneOf('approvalResponse', APPROVAL_RESPONSES, 'ask'),
			network: flag('network', false),
			sandboxMode: asSandboxMode(raw.sandboxMode, DEFAULT_SANDBOX_MODE),
			workingDirectory: (typeof raw.workingDirectory === 'string' ? raw.workingDirectory : '') || folder,
			commandTimeout: count('commandTimeout', 60, 1),
			commandTimeoutOverride: flag('commandTimeoutOverride', false),
			denyReadPaths: lines('denyReadPaths', ['.env', '**/.env']),
			planDirectory: typeof raw.planDirectory === 'string' ? raw.planDirectory : '',
			maxSteps: count('maxSteps', 0, 0),
			// Kept apart so a hand-edited file can carry one without the other; `custom` with the
			// shipped 40 matches the old budget every subagent got (`maxTurns` 20 × 2 steps).
			subagentStepsMode: oneOf('subagentStepsMode', SUBAGENT_STEPS_MODES, 'custom'),
			subagentSteps: count('subagentSteps', 40, 0),
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
			subagents: sanitizeSubagentGrants(raw.subagents),
			instructions: flag('instructions', true),
			skills: flag('skills', true),
			memory: flag('memory', true),
			checkpoints: flag('checkpoints', true),
			chatWindow: flag('chatWindow', false),
			contextForm: oneOf('contextForm', CONTEXT_FORMS, 'rendered'),
			displayForm: oneOf('displayForm', CONTEXT_FORMS, 'rendered'),
			toolCard: oneOf('toolCard', TOOL_CARD_MODES, 'collapsed'),
			reasoningEffort: oneOf('reasoningEffort', REASONING_EFFORTS, 'auto'),
			contextWindow: count('contextWindow', 0, 0),
			budgetUsd: count('budgetUsd', 0, 0),
			filterSensitiveEnv: flag('filterSensitiveEnv', true),
			allowFullAccess: flag('allowFullAccess', true),
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

	/** Applies a preset or partial policy through the host's scope-aware update. */
	async applyPolicy(patch: {
		mode?: WorkMode;
		approval?: Approval;
		approvalResponse?: ApprovalResponse;
		network?: boolean;
		sandboxMode?: SandboxMode;
	}): Promise<void> {
		if (patch.mode) {
			await this.host.update('mode', patch.mode);
		}
		if (patch.approval) {
			await this.host.update('approval', patch.approval);
		}
		if (patch.approvalResponse) {
			await this.host.update('approvalResponse', patch.approvalResponse);
		}
		if (patch.network !== undefined) {
			await this.host.update('network', patch.network);
		}
		if (patch.sandboxMode) {
			await this.host.update('sandboxMode', patch.sandboxMode);
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
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['auto', 'none', 'low', 'medium', 'high', 'max'];
const APPROVAL_RESPONSES: readonly ApprovalResponse[] = ['ask', 'never'];
