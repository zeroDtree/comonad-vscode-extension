// SPDX-License-Identifier: AGPL-3.0-only
import { Service, type Context } from 'cordis';
import { SHIPPED_INSTANCES, type ModelInfo, type ProviderInstanceConfig } from '@comonad/model';
import { BUILTIN_ROLES, READ_ONLY_GRANT, type AgentRole, type SubagentGrant } from '../lib/agents';
import { normalizeBudget, type BudgetLimits, type SubagentBudgetMode } from '../lib/budget';
import { asApproval, asApprovalResponse, asWorkMode, parseRules, type RuleSet } from '../lib/policy';
import {
	DEFAULT_COMPACTION_HEADROOM,
	DEFAULT_COMPACTION_RETAIN_PERCENT,
	MAX_COMPACTION_HEADROOM,
	MAX_COMPACTION_RETAIN_PERCENT,
	MIN_COMPACTION_RETAIN_PERCENT,
	type ContextForm,
} from '../lib/prompt';
import { parsePromptLayout, parseToolLayout, type PromptBlockSetting, type ToolPromptSetting } from '../lib/prompt-layout';
import { asSandboxMode, DEFAULT_SANDBOX_MODE } from '../lib/sandbox';
import type { Approval, ApprovalResponse, Capability, ReasoningEffort, SandboxMode, WorkMode } from '../lib/types';
import type { Host, SettingsScope } from './host';

/** Typed view over the `comonad.*` settings section. */

/** How a tool card starts out: folded to its header, folded with a preview, or open. */
export type ToolCardMode = 'collapsed' | 'preview' | 'open';
export const TOOL_CARD_MODES: readonly ToolCardMode[] = ['collapsed', 'preview', 'open'];

/** The root agent is unlimited unless the user sets a budget; a child gets a focused default. */
export const DEFAULT_ROOT_BUDGET: BudgetLimits = { turns: 0, tools: 0, tokens: 0, milliseconds: 0 };
export const DEFAULT_SUBAGENT_BUDGET: BudgetLimits = { turns: 24, tools: 100, tokens: 0, milliseconds: 0 };
export const SUBAGENT_BUDGET_MODES: readonly SubagentBudgetMode[] = ['inherit', 'custom'];
export const DEFAULT_SUBAGENT_BUDGET_MODE: SubagentBudgetMode = 'inherit';

/**
 * A user's `comonad.providers` map: one provider instance per entry — the connection, its brand,
 * and whatever the user overrides. Empty (or absent) means "use SHIPPED_INSTANCES". Model facts
 * (windows, prices, thinking quirks) are not configured here: the brand carries them and the
 * merge engine layers them under the instance at resolve time.
 */
export type ProviderMap = Record<string, ProviderInstanceConfig>;

const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_PROVIDER_INSTANCES = 64;

/** A settings file is untrusted input: bad entries drop out, good ones survive. */
export function sanitizeProviders(value: unknown): ProviderMap {
	const out: ProviderMap = {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return out;
	}
	for (const [rawName, rawInstance] of Object.entries(value as Record<string, unknown>).slice(0, MAX_PROVIDER_INSTANCES)) {
		const name = rawName.trim().toLowerCase();
		if (!PROVIDER_NAME.test(name) || name.length > 64 || UNSAFE_PROVIDER_KEYS.has(name)) {
			continue;
		}
		if (!rawInstance || typeof rawInstance !== 'object' || Array.isArray(rawInstance)) {
			continue;
		}
		const entry = rawInstance as Record<string, unknown>;
		const brand = typeof entry.brand === 'string' ? entry.brand.trim() : '';
		const base = typeof entry.base === 'string' ? entry.base.trim() : '';
		const model = typeof entry.model === 'string' ? entry.model.trim() : '';
		if (!brand || !base || !model) {
			continue;
		}
		const instance: ProviderInstanceConfig = { id: name, brand, base, model };
		if (typeof entry.protocol === 'string' && entry.protocol.trim()) {
			instance.protocol = entry.protocol.trim();
		}
		const keyEnv = Array.isArray(entry.keyEnv)
			? entry.keyEnv.map((item) => String(item).trim()).filter(Boolean)
			: typeof entry.keyEnv === 'string' && entry.keyEnv.trim()
				? entry.keyEnv.trim()
				: undefined;
		if (keyEnv !== undefined && (!Array.isArray(keyEnv) || keyEnv.length > 0)) {
			instance.keyEnv = keyEnv;
		}
		if (typeof entry.chatPath === 'string' && entry.chatPath.trim()) {
			instance.chatPath = entry.chatPath.trim();
		}
		if (typeof entry.modelsPath === 'string' && entry.modelsPath.trim()) {
			instance.modelsPath = entry.modelsPath.trim();
		}
		const auth = sanitizeAuth(entry.auth);
		if (auth) {
			instance.auth = auth;
		}
		const headers = sanitizeStringMap(entry.headers);
		if (headers) {
			instance.headers = headers;
		}
		const options = sanitizeRecord(entry.options);
		if (options) {
			instance.options = options;
		}
		const models = sanitizeModelFacts(entry.models);
		if (models) {
			instance.models = models;
		}
		const rules = entry.modelRules;
		if (rules && typeof rules === 'object' && !Array.isArray(rules)) {
			const rule = rules as Record<string, unknown>;
			const modelRules: { prefix?: string; skip?: string } = {};
			if (typeof rule.prefix === 'string') {
				modelRules.prefix = rule.prefix;
			}
			if (typeof rule.skip === 'string') {
				try {
					new RegExp(rule.skip);
					modelRules.skip = rule.skip;
				} catch {
					// A skip that is not a regex drops out; the listing just stays unfiltered.
				}
			}
			if (modelRules.prefix !== undefined || modelRules.skip !== undefined) {
				instance.modelRules = modelRules;
			}
		}
		const retry = sanitizeRetry(entry.retry);
		if (retry) {
			instance.retry = retry;
		}
		if (Array.isArray(entry.fallback)) {
			const fallback = entry.fallback.map((item) => String(item).trim()).filter(Boolean);
			if (fallback.length > 0) {
				instance.fallback = [...new Set(fallback)];
			}
		}
		out[name] = instance;
	}
	return out;
}

const UNSAFE_PROVIDER_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function sanitizeAuth(value: unknown): ProviderInstanceConfig['auth'] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const auth = value as Record<string, unknown>;
	if (auth.kind === 'bearer') {
		return { kind: 'bearer' };
	}
	if (auth.kind === 'header' || auth.kind === 'query') {
		const name = typeof auth.name === 'string' ? auth.name.trim() : '';
		if (name) {
			return { kind: auth.kind, name };
		}
	}
	return undefined;
}

function sanitizeStringMap(value: unknown): Record<string, string> | undefined {
	const map = sanitizeRecord(value);
	if (!map) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(map)) {
		if (typeof entry === 'string') {
			out[key] = entry;
		}
	}
	return Object.keys(out).length ? out : undefined;
}

function sanitizeRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!UNSAFE_PROVIDER_KEYS.has(key) && entry !== undefined) {
			out[key] = entry;
		}
	}
	return Object.keys(out).length ? out : undefined;
}

function sanitizeModelFacts(value: unknown): ProviderInstanceConfig['models'] {
	const map = sanitizeRecord(value);
	if (!map) {
		return undefined;
	}
	const out: NonNullable<ProviderInstanceConfig['models']> = {};
	for (const [id, rawFacts] of Object.entries(map)) {
		if (!rawFacts || typeof rawFacts !== 'object' || Array.isArray(rawFacts)) {
			continue;
		}
		const facts = rawFacts as Record<string, unknown>;
		const entry: Record<string, unknown> = {};
		if (typeof facts.label === 'string') {
			entry.label = facts.label;
		}
		for (const key of ['contextWindow', 'maxOutput'] as const) {
			const count = Number(facts[key]);
			if (Number.isFinite(count) && count > 0) {
				entry[key] = count;
			}
		}
		const pricing = facts.pricing;
		if (pricing && typeof pricing === 'object' && !Array.isArray(pricing)) {
			const priced: Record<string, number> = {};
			for (const key of ['inPerM', 'cachedInPerM', 'cacheWritePerM', 'outPerM'] as const) {
				const price = Number((pricing as Record<string, unknown>)[key]);
				if (Number.isFinite(price) && price >= 0) {
					priced[key] = price;
				}
			}
			if (Object.keys(priced).length) {
				entry.pricing = priced;
			}
		}
		if (Object.keys(entry).length) {
			out[id] = entry as Partial<ModelInfo>;
		}
	}
	return Object.keys(out).length ? out : undefined;
}

function sanitizeRetry(value: unknown): ProviderInstanceConfig['retry'] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const retry = value as Record<string, unknown>;
	const out: NonNullable<ProviderInstanceConfig['retry']> = {};
	const attempts = Number(retry.maxAttempts);
	if (Number.isInteger(attempts) && attempts >= 1 && attempts <= 10) {
		out.maxAttempts = attempts;
	}
	if (Array.isArray(retry.retryableCodes) && retry.retryableCodes.length) {
		out.retryableCodes = retry.retryableCodes.map(String).filter(Boolean).slice(0, 16) as NonNullable<
			ProviderInstanceConfig['retry']
		>['retryableCodes'];
	}
	for (const key of ['baseDelayMs', 'maxDelayMs'] as const) {
		const delay = Number(retry[key]);
		if (Number.isFinite(delay) && delay >= 0) {
			out[key] = delay;
		}
	}
	return Object.keys(out).length ? out : undefined;
}

/**
 * Per-purpose model overrides: a summary or a policy hook can run on a different model
 * than the chat it serves. Absent means "the chat's own model".
 */
export interface ModelRoutes {
	compaction?: string;
	softRoute?: string;
	hook?: string;
}

function sanitizeRoutes(value: unknown): ModelRoutes {
	const out: ModelRoutes = {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return out;
	}
	const routes = value as Record<string, unknown>;
	for (const key of ['compaction', 'softRoute', 'hook'] as const) {
		const model = routes[key];
		if (typeof model === 'string' && model.trim()) {
			out[key] = model.trim();
		}
	}
	return out;
}

/** The configured instances, in menu order; the first one is `auto`. */
export function providersOf(config: Pick<Config, 'providers'>): ProviderInstanceConfig[] {
	const entries = Object.values(config.providers);
	return entries.length ? entries : [...SHIPPED_INSTANCES];
}

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

export type { SubagentGrant } from '../lib/agents';
export { READ_ONLY_GRANT } from '../lib/agents';

export type SubagentGrants = Record<string, SubagentGrant>;

/**
 * The shipped subagent grants, derived from the role table so a role's default and its Settings
 * checkbox can never disagree. A project file that shadows a built-in name loses the default.
 */
export const DEFAULT_SUBAGENT_GRANTS: Readonly<Record<string, SubagentGrant>> = Object.fromEntries(
	BUILTIN_ROLES.filter((role) => role.grant.files || role.grant.test).map((role) => [role.id, { ...role.grant }]),
);

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
 * The effective grant of one role: an explicit entry wins outright, then the built-in role's own
 * default, then read-only. A custom role that reuses a built-in id gets nothing.
 */
export function subagentGrant(config: Pick<Config, 'subagents'>, role: AgentRole | undefined): SubagentGrant {
	const key = role?.id.trim().toLowerCase() ?? '';
	if (key && Object.hasOwn(config.subagents, key)) {
		return { ...config.subagents[key]! };
	}
	const shipped = role?.builtin ? role.grant : undefined;
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
	/** Native run budget for the root agent; `0` fields mean unlimited. */
	budget: BudgetLimits;
	/** Default native budget for a child agent; a role or task can only tighten it. */
	subagentBudget: BudgetLimits;
	/** `inherit` copies the parent's four limits; `custom` spends `subagentBudget`. */
	subagentBudgetMode: SubagentBudgetMode;
	model: string;
	/** One provider instance per entry; empty means the shipped instances. */
	providers: ProviderMap;
	/** Per-purpose model overrides; absent falls back to the chat's own model. */
	modelRoutes: ModelRoutes;
	mcpServers: Record<string, McpServerSettings>;
	permissions: PermissionsConfig;
	/** Per-agent capability grants for subagents; see `SubagentGrant`. */
	subagents: SubagentGrants;
	instructions: boolean;
	skills: boolean;
	memory: boolean;
	checkpoints: boolean;
	/** Leave files under the workspace's `.comonad` folder out of the review listings. */
	excludeComonadFromReview: boolean;
	chatWindow: boolean;
	/** Show a VS Code notification when a question waits and no chat webview is attached. */
	questionNotification: boolean;
	contextForm: ContextForm;
	displayForm: ContextForm;
	/** How a tool call is drawn when it first appears: preview, header only, or open. */
	toolCard: ToolCardMode;
	reasoningEffort: ReasoningEffort;
	/** Window override in tokens for new chats; `0` resolves from the model profile. */
	contextWindow: number;
	/** Tokens left before the window fills at which a request triggers a summary; `0` disables it. */
	compactionHeadroom: number;
	/** Percent of the window kept verbatim after a summary. */
	compactionRetainPercent: number;
	budgetUsd: number;
	filterSensitiveEnv: boolean;
	allowFullAccess: boolean;
	/** A local tokenizer folder whose `src/tokenizers` holds the tokenizer files it ships. */
	tokenizerDir: string;
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
	'budget',
	'subagentBudget',
	'subagentBudgetMode',
	'model',
	'providers',
	'modelRoutes',
	'mcpServers',
	'permissions',
	'subagents',
	'instructions',
	'skills',
	'memory',
	'checkpoints',
	'excludeComonadFromReview',
	'chatWindow',
	'questionNotification',
	'contextForm',
	'displayForm',
	'toolCard',
	'reasoningEffort',
	'contextWindow',
	'compactionHeadroom',
	'compactionRetainPercent',
	'budgetUsd',
	'filterSensitiveEnv',
	'allowFullAccess',
	'tokenizerDir',
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
	'compactionHeadroom',
	'compactionRetainPercent',
	'questionNotification',
	'excludeComonadFromReview',
	'network',
	'sandboxMode',
	'workingDirectory',
	'commandTimeout',
	'commandTimeoutOverride',
	'planDirectory',
	'denyReadPaths',
	'budget',
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
	current: AgentConfig & Partial<Pick<Config, 'budget' | 'subagentBudget' | 'subagentBudgetMode'>>,
): Partial<Config> {
	const next: Partial<Config> = {};
	const budgetOf = (value: unknown, fallback: BudgetLimits): BudgetLimits =>
		value && typeof value === 'object' && !Array.isArray(value)
			? normalizeBudget({ ...fallback, ...(value as Record<keyof BudgetLimits, number>) })
			: fallback;
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
	if (has('compactionHeadroom')) {
		const value = Number(patch.compactionHeadroom);
		next.compactionHeadroom = Number.isFinite(value)
			? Math.min(MAX_COMPACTION_HEADROOM, Math.max(0, Math.round(value)))
			: current.compactionHeadroom;
	}
	if (has('compactionRetainPercent')) {
		const value = Number(patch.compactionRetainPercent);
		next.compactionRetainPercent = Number.isFinite(value)
			? Math.min(MAX_COMPACTION_RETAIN_PERCENT, Math.max(MIN_COMPACTION_RETAIN_PERCENT, Math.round(value)))
			: current.compactionRetainPercent;
	}
	if (has('toolCard')) {
		const value = patch.toolCard;
		next.toolCard =
			typeof value === 'string' && (TOOL_CARD_MODES as readonly string[]).includes(value)
				? (value as ToolCardMode)
				: current.toolCard;
	}
	if (has('questionNotification')) {
		next.questionNotification = Boolean(patch.questionNotification);
	}
	if (has('excludeComonadFromReview')) {
		next.excludeComonadFromReview = Boolean(patch.excludeComonadFromReview);
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
	if (has('budget')) {
		next.budget = budgetOf(patch.budget, current.budget ?? DEFAULT_ROOT_BUDGET);
	}
	if (has('subagentBudget')) {
		next.subagentBudget = budgetOf(patch.subagentBudget, current.subagentBudget ?? DEFAULT_SUBAGENT_BUDGET);
	}
	if (has('subagentBudgetMode')) {
		const mode = patch.subagentBudgetMode;
		next.subagentBudgetMode =
			typeof mode === 'string' && (SUBAGENT_BUDGET_MODES as readonly string[]).includes(mode)
				? (mode as SubagentBudgetMode)
				: (current.subagentBudgetMode ?? DEFAULT_SUBAGENT_BUDGET_MODE);
	}
	return next;
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
		const range = (key: keyof Config, fallback: number, minimum: number, maximum: number): number => {
			const found = Number(raw[key]);
			return Number.isFinite(found) ? Math.min(maximum, Math.max(minimum, Math.round(found))) : fallback;
		};
		const flag = (key: keyof Config, fallback: boolean): boolean => {
			const found = raw[key];
			return typeof found === 'boolean' ? found : fallback;
		};
		const lines = (key: keyof Config, fallback: string[]): string[] =>
			Array.isArray(raw[key]) ? (raw[key] as unknown[]).map(String) : fallback;
		const budget = (key: 'budget' | 'subagentBudget', fallback: BudgetLimits): BudgetLimits => {
			const found = raw[key];
			return found && typeof found === 'object' && !Array.isArray(found)
				? normalizeBudget({ ...fallback, ...(found as Record<keyof BudgetLimits, number>) })
				: fallback;
		};
		const permissions = value('permissions', undefined as unknown as PermissionsConfig);
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
			budget: budget('budget', DEFAULT_ROOT_BUDGET),
			subagentBudget: budget('subagentBudget', DEFAULT_SUBAGENT_BUDGET),
			subagentBudgetMode: oneOf('subagentBudgetMode', SUBAGENT_BUDGET_MODES, DEFAULT_SUBAGENT_BUDGET_MODE),
			model: typeof raw.model === 'string' ? raw.model : 'auto',
			// A settings file is untrusted input; bad entries drop out. An empty map means "nothing
			// configured", and `providersOf` stands the shipped instances in for it.
			providers: sanitizeProviders(raw.providers),
			modelRoutes: sanitizeRoutes(raw.modelRoutes),
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
			excludeComonadFromReview: flag('excludeComonadFromReview', true),
			chatWindow: flag('chatWindow', false),
			questionNotification: flag('questionNotification', true),
			contextForm: oneOf('contextForm', CONTEXT_FORMS, 'rendered'),
			displayForm: oneOf('displayForm', CONTEXT_FORMS, 'rendered'),
			toolCard: oneOf('toolCard', TOOL_CARD_MODES, 'collapsed'),
			reasoningEffort: oneOf('reasoningEffort', REASONING_EFFORTS, 'auto'),
			contextWindow: count('contextWindow', 0, 0),
			compactionHeadroom: range('compactionHeadroom', DEFAULT_COMPACTION_HEADROOM, 0, MAX_COMPACTION_HEADROOM),
			compactionRetainPercent: range(
				'compactionRetainPercent',
				DEFAULT_COMPACTION_RETAIN_PERCENT,
				MIN_COMPACTION_RETAIN_PERCENT,
				MAX_COMPACTION_RETAIN_PERCENT,
			),
			budgetUsd: count('budgetUsd', 0, 0),
			filterSensitiveEnv: flag('filterSensitiveEnv', true),
			allowFullAccess: flag('allowFullAccess', true),
			tokenizerDir: typeof raw.tokenizerDir === 'string' ? raw.tokenizerDir : '',
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
	async update(key: string, value: unknown, scope?: SettingsScope): Promise<void> {
		await this.host.update(key, value, scope);
		this.ctx.emit('settings/changed');
	}

	/** Applies a preset or partial policy through the host's scope-aware update. A `scope` (the chat
	 *  composer) pins every key to that file; without one each key follows `defaultWriteScope`. */
	async applyPolicy(
		patch: {
			mode?: WorkMode;
			approval?: Approval;
			approvalResponse?: ApprovalResponse;
			network?: boolean;
			sandboxMode?: SandboxMode;
		},
		scope?: SettingsScope,
	): Promise<void> {
		if (patch.mode) {
			await this.host.update('mode', patch.mode, scope);
		}
		if (patch.approval) {
			await this.host.update('approval', patch.approval, scope);
		}
		if (patch.approvalResponse) {
			await this.host.update('approvalResponse', patch.approvalResponse, scope);
		}
		if (patch.network !== undefined) {
			await this.host.update('network', patch.network, scope);
		}
		if (patch.sandboxMode) {
			await this.host.update('sandboxMode', patch.sandboxMode, scope);
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

/** The remaining value sets a `get()` may fall back within — a settings file is untrusted input. */
const CONTEXT_FORMS: readonly ContextForm[] = ['rendered', 'token', 'raw'];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['auto', 'none', 'low', 'medium', 'high', 'max'];
const APPROVAL_RESPONSES: readonly ApprovalResponse[] = ['ask', 'never'];
