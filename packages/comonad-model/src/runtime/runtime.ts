// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Model Runtime: resolve · stream · retry · fallback · usage · cost.
 *
 * `stream` is one attempt over one resolved provider — the conformance primitive.
 * `chat` is the pipeline around it: resolve, retry with the pre-stream guard, walk the
 * fallback chain while nothing has been shown, and report every hop as a `notice` on
 * the event stream. Semantic retries that rewrite the transcript stay with the host.
 */
import { assertApiVersion } from '../api-version';
import { ModelError } from '../errors';
import { mergeWire, protocolIdFor } from '../config/merge';
import { definitionIdOf } from '../config/schema';
import { resolveProvider } from '../config/resolve';
import type {
	ProviderDefinition,
	KeyProvider,
	OptionValues,
	ProtocolDefinition,
	ProtocolImpl,
	ProviderEntry,
	ResolvedProvider,
	ResolvedWire,
} from '../config/schema';
import type { Transport } from '../transport/transport';
import type {
	AttemptRecord,
	ChatOptions,
	ChatRequest,
	ChatResult,
	InvocationContext,
	ModelInfo,
	ProviderStreamEvent,
	RuntimeStreamEvent,
	UsageRecord,
} from '../types';
import { ModelCatalog } from './catalog';
import { fallbackChain } from './fallback';
import { planRetry, sleep } from './retry';

/** `auto` picks the first provider; a bare id its default model; `id:model` names one. */
export interface ModelRef {
	providerId?: string;
	model?: string;
}

export function parseModelRef(ref: string): ModelRef {
	const trimmed = ref.trim();
	if (!trimmed || trimmed === 'auto') {
		return {};
	}
	const colon = trimmed.indexOf(':');
	if (colon === -1) {
		return { providerId: trimmed };
	}
	return { providerId: trimmed.slice(0, colon), model: trimmed.slice(colon + 1) || undefined };
}

export interface ModelRuntimeDeps {
	transport: Transport;
	keys: KeyProvider;
	/** The configured providers, in menu order; the first one is `auto`. */
	entries: () => ProviderEntry[];
	catalogTtlMs?: number;
}

export interface ResolvedCall {
	provider: ResolvedProvider;
	impl: ProtocolImpl;
	model: string;
}

export interface CompleteRequest {
	model: string;
	system: string;
	prompt: string;
	ctx: InvocationContext;
	options?: ChatOptions;
	/** The call gets this long before its own signal fires; absent waits on the context alone. */
	timeoutMs?: number;
	/** Throw instead of returning '' when the model spent the reply reasoning and emitted no text. */
	rejectReasoningOnly?: boolean;
	onUsage?(usage: UsageRecord): void;
}

export interface Disposable {
	dispose(): void;
}

export class ModelRuntime {
	private readonly protocols = new Map<string, ProtocolDefinition>();
	private readonly definitions = new Map<string, ProviderDefinition>();
	private readonly catalog: ModelCatalog;

	constructor(private readonly deps: ModelRuntimeDeps) {
		this.catalog = new ModelCatalog(deps.catalogTtlMs);
	}

	/** Registers a wire protocol. The definition's apiVersion is checked against this build. */
	registerProtocol(def: ProtocolDefinition): Disposable {
		assertApiVersion(def.apiVersion, `protocol "${def.id}"`);
		this.protocols.set(def.id, def);
		return { dispose: () => this.protocols.delete(def.id) };
	}

	/** Registers a provider definition. The definition's apiVersion is checked against this build. */
	registerDefinition(def: ProviderDefinition): Disposable {
		assertApiVersion(def.apiVersion, `provider "${def.id}"`);
		this.definitions.set(def.id, def);
		return { dispose: () => this.definitions.delete(def.id) };
	}

	/** One attempt over one provider: the conformance primitive and the retry engine's body. */
	async stream(request: ChatRequest): Promise<ChatResult> {
		const call = await this.resolveCall(parseModelRef(request.model));
		const result = await this.attemptOne(call, request);
		return {
			...result,
			attempts: [{ requestId: request.ctx.requestId, providerId: call.provider.providerId, ok: true }],
		};
	}

	/** The full pipeline: resolve → retry → fallback → usage, notices on the event stream. */
	async chat(request: ChatRequest): Promise<ChatResult> {
		const parsed = parseModelRef(request.model);
		const start = await this.resolveCall(parsed);
		const attempts: AttemptRecord[] = [];
		let visible = 0;
		const counting: ChatRequest = {
			...request,
			onEvent: (event: RuntimeStreamEvent) => {
				if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool-call') {
					visible += 1;
				}
				request.onEvent?.(event);
			},
		};
		const chain = fallbackChain(start.provider.providerId, start.provider.fallback);
		let lastError: unknown;
		let hop: ResolvedCall;
		for (const [index, providerId] of chain.entries()) {
			try {
				hop = index === 0 ? start : await this.resolveCall({ providerId, model: parsed.model });
			} catch (error) {
				lastError = error;
				continue;
			}
			if (index > 0) {
				request.onEvent?.({
					type: 'notice',
					kind: 'fallback',
					message: `falling back to provider "${providerId}"`,
				});
			}
			for (let attempt = 1; ; attempt += 1) {
				try {
					const result = await this.attemptOne(hop, counting);
					attempts.push({ requestId: request.ctx.requestId, providerId, ok: true });
					return { ...result, attempts };
				} catch (error) {
					attempts.push({ requestId: request.ctx.requestId, providerId, ok: false });
					lastError = error;
					const plan = planRetry(error, attempt, hop.provider.retry, visible > 0);
					if (!plan.retry) {
						// Once the stream showed output nothing is safe to retry or fall back to:
						// the consumer would see the answer twice.
						if (visible > 0) {
							throw error;
						}
						break;
					}
					request.onEvent?.({
						type: 'notice',
						kind: 'retry',
						message: `retrying ${providerId}: ${plan.reason}`,
						attempt,
					});
					await sleep(plan.delayMs ?? 0, request.ctx.signal);
				}
			}
		}
		throw lastError ?? new ModelError('invalid_request', `no provider for "${request.model}"`);
	}

	/** One-shot text: a stopped or timed-out call throws rather than returning a partial. */
	async complete(request: CompleteRequest): Promise<string> {
		const timeout = request.timeoutMs === undefined ? undefined : AbortSignal.timeout(request.timeoutMs);
		const signal = timeout ? AbortSignal.any([request.ctx.signal, timeout]) : request.ctx.signal;
		const ctx: InvocationContext = { ...request.ctx, signal };
		const result = await this.chat({
			model: request.model,
			messages: [
				{ role: 'system', content: request.system },
				{ role: 'user', content: request.prompt },
			],
			tools: [],
			ctx,
			options: request.options,
		});
		if (signal.aborted) {
			throw signal.reason ?? new ModelError('aborted', 'the request was stopped');
		}
		if (result.usage) {
			request.onUsage?.(result.usage);
		}
		const text = result.message.content.trim();
		// A provider that cannot turn thinking off may spend the whole reply reasoning. Returning ''
		// would make that look like an empty answer; name the cause while usage is still counted.
		if (!text && request.rejectReasoningOnly && result.message.reasoning?.trim()) {
			throw new ModelError('empty_response', 'the model produced only reasoning; the provider cannot turn thinking off (set thinkingOff on it)');
		}
		return text;
	}

/** The shaped, fact-merged models a provider offers, cached briefly. */
	async listModels(modelRef: string, ctx: InvocationContext): Promise<ModelInfo[]> {
		const call = await this.resolveCall(parseModelRef(modelRef));
		return this.catalog.list(call.provider.providerId, call.provider, () => call.impl.listModels(ctx));
	}

	/**
	 * The models an entry's provider offers, without it being configured anywhere — what a
	 * configure wizard probes before it saves. `keyOverride` is used for this call only.
	 */
	async listModelsOf(
		entry: ProviderEntry,
		ctx: InvocationContext,
		keyOverride?: string,
	): Promise<ModelInfo[]> {
		const definition = this.definitions.get(definitionIdOf(entry));
		if (!definition) {
			throw new ModelError('invalid_request', `provider "${entry.id}" names unknown definition "${definitionIdOf(entry)}"`);
		}
		const protocolId = protocolIdFor(entry, definition);
		const protocol = this.protocols.get(protocolId);
		if (!protocol) {
			throw new ModelError('invalid_request', `provider "${entry.id}" names unknown protocol "${protocolId}"`);
		}
		const keys: KeyProvider =
			keyOverride === undefined
				? this.deps.keys
				: { keyFor: async () => keyOverride, env: () => undefined };
		const provider = await resolveProvider(protocol, definition, entry, keys);
		const impl = protocol.create(this.deps.transport, provider);
		return this.catalog.list(`${entry.id}#probe`, provider, () => impl.listModels(ctx));
	}

	invalidateCatalog(providerId?: string): void {
		this.catalog.invalidate(providerId);
	}

	/** Resolves a model ref to a runnable call: provider, protocol impl, and concrete model id. */
	async resolveCall(ref: ModelRef): Promise<ResolvedCall> {
		const preview = this.previewCall(ref);
		const provider = await resolveProvider(preview.protocol, preview.definition, preview.entry, this.deps.keys);
		return {
			provider,
			impl: preview.protocol.create(this.deps.transport, provider),
			model: preview.model,
		};
	}

	/**
	 * The merged wire and concrete model for a ref, without touching credentials. Sync: the
	 * host's effort ceiling and context-window reads must not wait on a key lookup.
	 */
	previewCall(ref: ModelRef): {
		wire: ResolvedWire;
		model: string;
		entry: ProviderEntry;
		definition: ProviderDefinition;
		protocol: ProtocolDefinition;
	} {
		const entries = this.deps.entries();
		const entry = ref.providerId ? entries.find((row) => row.id === ref.providerId) : entries[0];
		if (!entry) {
			throw new ModelError('invalid_request', `unknown provider "${ref.providerId ?? ''}"`);
		}
		const definition = this.definitions.get(definitionIdOf(entry));
		if (!definition) {
			throw new ModelError('invalid_request', `provider "${entry.id}" names unknown definition "${definitionIdOf(entry)}"`);
		}
		const protocolId = protocolIdFor(entry, definition);
		const protocol = this.protocols.get(protocolId);
		if (!protocol) {
			throw new ModelError('invalid_request', `provider "${entry.id}" names unknown protocol "${protocolId}"`);
		}
		const model = ref.model ?? entry.model;
		if (!model) {
			throw new ModelError('invalid_request', `provider "${entry.id}" names no model`);
		}
		return { wire: mergeWire(protocol, definition, entry), model, entry, definition, protocol };
	}

	/** One attempt. Failures throw; an aborted stream returns its partial with finish `aborted`. */
	private async attemptOne(call: ResolvedCall, request: ChatRequest): Promise<ChatResult> {
		const options: OptionValues = { ...call.provider.options, ...(request.options as OptionValues | undefined) };
		const outcome = await call.impl.chat(
			{ model: call.model, messages: request.messages, tools: request.tools, options, ctx: request.ctx },
			(event: ProviderStreamEvent) => request.onEvent?.(event),
		);
		return {
			message: outcome.message,
			toolCalls: outcome.toolCalls,
			usage: outcome.usage,
			finish: outcome.finish,
			attempts: [],
		};
	}
}
