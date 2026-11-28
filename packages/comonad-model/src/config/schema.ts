// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The declarative layering vocabulary: what a protocol declares, what a provider declares,
 * what a user's provider entry configures — and the merged wire they produce.
 *
 * There is no class inheritance between providers: every field's merge semantics are
 * spelled out in `merge.ts`, and the layers never see each other's internals.
 */
import type { AuthScheme } from '../transport/auth';
import type { Transport } from '../transport/transport';
import type {
	FinishReason,
	InvocationContext,
	Message,
	ModelInfo,
	ProviderStreamEvent,
	ToolCall,
	ToolDeclaration,
	UsageRecord,
} from '../types';
import type { ModelErrorCode } from '../errors';

/** Wire knobs and samplers, protocol-validated. */
export type OptionValues = Record<string, unknown>;

/** How one option key is validated by a protocol's schema. */
export interface OptionField {
	type: 'string' | 'number' | 'boolean' | 'object' | 'any';
	enum?: readonly string[];
}

/** A protocol's known option keys; anything else is rejected at merge time. */
export type OptionSchema = Record<string, OptionField>;

/** A header mutation that sees the invocation context (e.g. a session header). */
export type HeaderHook = (headers: Record<string, string>, ctx: InvocationContext) => void;

/** A body mutation a provider applies after the protocol built the wire body. */
export type RequestHook = (body: Record<string, unknown>, wire: ResolvedWire, ctx: InvocationContext) => void;

/** When and how a runtime retry may re-attempt a logical call. */
export interface RetryPolicy {
	/** Total attempts per logical call, including the first. */
	maxAttempts: number;
	/** Codes a retry may fix; a `ModelError.retryable` flag can still veto. */
	retryableCodes: readonly ModelErrorCode[];
	baseDelayMs: number;
	maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 2,
	retryableCodes: ['transport', 'timeout', 'rate_limited', 'server'],
	baseDelayMs: 250,
	maxDelayMs: 4_000,
};

/**
 * A wire protocol: how to talk to a family of endpoints. `create()` is the protocol's
 * alone — definitions and entries customize the wire through data and hooks, never by
 * swapping the transport or the conversation encoder.
 */
export interface ProtocolDefinition {
	apiVersion: number;
	id: string;
	defaults: {
		chatPath: string;
		modelsPath: string;
		headers: Record<string, string>;
		auth?: AuthScheme;
		options?: OptionValues;
		optionsSchema: OptionSchema;
	};
	headerHooks?: HeaderHook[];
	requestHooks?: RequestHook[];
	create(transport: Transport, provider: ResolvedProvider): ProtocolImpl;
}

/** What a protocol implementation must do; the runtime only ever sees this. */
export interface ProtocolImpl {
	chat(
		request: {
			model: string;
			messages: Message[];
			tools: ToolDeclaration[];
			options: OptionValues;
			ctx: InvocationContext;
		},
		emit: (event: ProviderStreamEvent) => void,
	): Promise<{ message: Message; toolCalls: ToolCall[]; usage?: UsageRecord; finish: FinishReason }>;
	listModels(ctx: InvocationContext): Promise<string[]>;
}

/** A provider definition: everything one vendor does differently, as data and hooks. */
export interface ProviderDefinition {
	apiVersion: number;
	id: string;
	/** The protocol this provider speaks by default; an entry may re-point it. */
	protocol: string;
	/** Environment variable(s) holding the key; an entry's `keyEnv` replaces this list wholesale. */
	keyEnv?: string | string[];
	defaults: ProviderDefaults;
	/** Catalog filtering rules, kept data-driven (prefix stripping, id skip-list). */
	modelRules?: { prefix?: string; skip?: string };
	/** Shipped model facts (pricing, windows), merged by model id. */
	modelCatalog?: ModelInfo[];
	headerHooks?: HeaderHook[];
	requestHooks?: RequestHook[];
	/** Maps a provider's raw usage payload quirks onto UsageRecord fields. */
	usageMap?(raw: unknown): Partial<UsageRecord>;
}

/** The provider's default wire shape. Every field is optional; entries may override. */
export interface ProviderDefaults {
	baseURL?: string;
	chatPath?: string;
	modelsPath?: string;
	auth?: AuthScheme;
	headers?: Record<string, string>;
	options?: OptionValues;
}

/** One configured provider: the settings JSON shape. Pure data, no hooks. */
export interface ProviderEntry {
	id: string;
	/** The `ProviderDefinition` this entry speaks for. Defaults to the map key (`id`). */
	provider?: string;
	/** Re-points the provider's protocol (e.g. google via openai-chat vs native gemini). */
	protocol?: string;
	base: string;
	/** The model a bare `providerId` ref runs; `providerId:model` names one explicitly. */
	model?: string;
	/** Overrides the definition's `keyEnv` list. */
	keyEnv?: string | string[];
	chatPath?: string;
	modelsPath?: string;
	auth?: AuthScheme;
	headers?: Record<string, string>;
	options?: OptionValues;
	/** Per-model fact overrides, merged over the provider's catalog. */
	models?: Record<string, Partial<ModelInfo>>;
	modelRules?: { prefix?: string; skip?: string };
	retry?: Partial<RetryPolicy>;
	/** Provider ids to walk when this one fails for good; empty = none. */
	fallback?: string[];
	/** Which credential wins when both a stored key and `keyEnv` hold one. Default: keychain. */
	keySource?: 'keychain' | 'env';
}

/** Which `ProviderDefinition` an entry speaks for: the explicit field, else the map key. */
export function definitionIdOf(entry: Pick<ProviderEntry, 'id' | 'provider'>): string {
	return entry.provider ?? entry.id;
}

/**
 * The merged wire every request runs against: Protocol → Provider → Entry folded by
 * `mergeWire`. Paths stay as configured here; `resolveProvider` locks them to the
 * base origin and fills the key.
 */
export interface ResolvedWire {
	baseURL: string;
	chatPath: string;
	modelsPath: string;
	auth: AuthScheme;
	headers: Record<string, string>;
	headerHooks: HeaderHook[];
	requestHooks: RequestHook[];
	options: OptionValues;
	models: Map<string, ModelInfo>;
	modelRules: { prefix: string; skip?: RegExp };
	retry: RetryPolicy;
	fallback: string[];
}

/** The runtime's resolved provider: merged wire plus identity and credentials. What a protocol implementation sends against. */
export interface ResolvedProvider extends ResolvedWire {
	providerId: string;
	definitionId: string;
	protocolId: string;
	/** Absolute, origin-locked request URLs. */
	chatURL: string;
	modelsURL: string;
	key?: string;
	keySource: 'stored' | 'env' | 'none';
	keyEnvNames: string[];
}

/** The credential seam: the package never touches SecretStorage or process.env itself. */
export interface KeyProvider {
	/** The stored secret for this endpoint identity, when the user configured one. */
	keyFor(baseURL: string, providerId: string): Promise<string | undefined>;
	/** An environment variable's value, or undefined when unset. */
	env(name: string): string | undefined;
}
