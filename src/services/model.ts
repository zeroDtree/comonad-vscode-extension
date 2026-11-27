// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { Service, type Context } from 'cordis';
import {
	HttpTransport,
	ModelRuntime,
	anthropicBrand,
	anthropicMessagesProtocol,
	costFor,
	customBrand,
	deepseekBrand,
	geminiProtocol,
	googleBrand,
	normalizeEndpoint,
	openaiBrand,
	openaiChatProtocol,
	opencodeGoBrand,
	parseModelRef,
	type BrandDefinition,
	type ChatOptions,
	type ChatRequest,
	type ChatResult,
	type Disposable,
	type InvocationContext,
	type KeyProvider,
	type ModelInfo,
	type ProtocolDefinition,
	type ProviderInstanceConfig,
	type UsageRecord,
} from '@comonad/model';
import { limitEffort, type EffortTop } from '../lib/effort';
import { providersOf } from './settings';

/** Model access: provider-instance resolution plus the Model Runtime that runs them. */

export interface ModelChoice {
	id: string;
	label: string;
	description: string;
	/** No key resolves for the instance behind this row; picking it would fail on the next turn. */
	needsKey: boolean;
}

export interface CompleteCall {
	model: string;
	system: string;
	prompt: string;
	ctx: InvocationContext;
	options?: { reasoningEffort?: string; maxTokens?: number };
	timeoutMs?: number;
	rejectReasoningOnly?: boolean;
	onUsage?(usage: UsageRecord): void;
}

/**
 * The secret id for one provider endpoint. A stored key belongs to the endpoint, not to a profile:
 * two instances on `https://api.deepseek.com` share one key. Hashed so a URL with a query does not
 * become a huge keychain label. This formula predates the Model Runtime and must not change —
 * existing SecretStorage entries key by it.
 */
export function providerSecretKey(base: string | undefined): string {
	const identity = normalizeEndpoint(base ?? '');
	return identity ? `comonad.key.provider.${createHash('sha256').update(identity).digest('hex')}` : '';
}

declare module 'cordis' {
	interface Context {
		model: Model;
	}
}

export class Model extends Service {
	static inject = ['settings', 'host', 'log'];

	private readonly runtime: ModelRuntime;
	private readonly keyLogged = new Set<string>();

	constructor(ctx: Context) {
		super(ctx, 'model');
		const keys: KeyProvider = {
			keyFor: async (baseURL) => {
				const stored = await this.ctx.host.secret(providerSecretKey(baseURL));
				return stored || undefined;
			},
			env: (name) => this.ctx.host.env(name) || undefined,
		};
		this.runtime = new ModelRuntime({
			transport: new HttpTransport(),
			keys,
			instances: () => providersOf(this.ctx.settings.get()),
		});
		for (const protocol of [openaiChatProtocol, anthropicMessagesProtocol, geminiProtocol]) {
			this.runtime.registerProtocol(protocol);
		}
		for (const brand of [deepseekBrand, openaiBrand, opencodeGoBrand, googleBrand, anthropicBrand, customBrand]) {
			this.runtime.registerBrand(brand);
		}
	}

	/** The test seam: a protocol definition (often a fake) the runtime will run. */
	registerProtocol(def: ProtocolDefinition): Disposable {
		return this.runtime.registerProtocol(def);
	}

	registerBrand(def: BrandDefinition): Disposable {
		return this.runtime.registerBrand(def);
	}

	/** One attempt over one provider: the conformance primitive. */
	stream(request: ChatRequest): Promise<ChatResult> {
		return this.runtime.stream(request);
	}

	/** The full pipeline: resolve → retry → fallback → usage. */
	chat(request: ChatRequest): Promise<ChatResult> {
		return this.runtime.chat(this.withKnownRef(request));
	}

	/** One-shot text: a stopped or timed-out call throws instead of returning a partial. */
	complete(call: CompleteCall): Promise<string> {
		return this.runtime.complete({
			model: this.knownModel(call.model),
			system: call.system,
			prompt: call.prompt,
			ctx: call.ctx,
			options: call.options,
			timeoutMs: call.timeoutMs,
			rejectReasoningOnly: call.rejectReasoningOnly,
			onUsage: call.onUsage,
		});
	}

	/**
	 * The soft-router's pick: a JSON `{"id": …}` answer, two attempts, then the first choice.
	 * Prompt formatting is host policy, so the helper lives here, not in the runtime.
	 */
	async choose(
		policyModel: string,
		request: { instruct: string; choices: { id: string; description: string }[] },
		ctx: InvocationContext,
		onUsage?: (usage: UsageRecord) => void,
	): Promise<string> {
		const ids = request.choices.map((choice) => choice.id);
		const system = [
			request.instruct,
			`Reply with JSON: {"id": "<one of: ${ids.join(', ')}>"}.`,
			...request.choices.map((choice) => `- ${choice.id}: ${choice.description}`),
		].join('\n');
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const text = await this.complete({ model: policyModel, system, prompt: 'Choose the next node.', ctx, onUsage });
				const match = text.match(/\{[\s\S]*?\}/);
				if (match) {
					const parsed = JSON.parse(match[0]) as { id?: string };
					if (parsed.id && ids.includes(parsed.id)) {
						return parsed.id;
					}
				}
			} catch (error) {
				ctx.signal.throwIfAborted();
				this.ctx.log.message(`choose failed: ${error instanceof Error ? error.message : String(error)}`);
				break;
			}
			ctx.signal.throwIfAborted();
		}
		ctx.signal.throwIfAborted();
		return ids[0]!;
	}

	/**
	 * The models to offer: every instance contributes the models its endpoint lists, so a new model
	 * shows up without touching settings. An instance whose list cannot be fetched (no key, offline)
	 * still offers the default model it declares.
	 */
	async availableModels(options: { refresh?: boolean } = {}): Promise<ModelChoice[]> {
		const instances = providersOf(this.ctx.settings.get());
		const first = instances[0];
		interface Candidate {
			choice: ModelChoice;
			position: number;
			declared: boolean;
			hasKey: boolean;
		}
		const candidates: Candidate[] = [];
		let position = 0;
		for (const instance of instances) {
			const resolved = await this.resolveInstance(instance.id);
			const where = resolved.provider.key
				? ''
				: resolved.provider.keyEnvNames.length
					? ` · no key — set ${resolved.provider.keyEnvNames.join(' or ')}`
					: ' · no key — run "Comonad: Configure Model Provider"';
			let listed: ModelInfo[] = [];
			let failed = false;
			try {
				if (options.refresh) {
					this.runtime.invalidateCatalog(instance.id);
				}
				listed = await this.runtime.listModels(instance.id, this.ctxOf());
			} catch (error) {
				failed = true;
				this.ctx.log.message(`model list of ${instance.id} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			const models = listed.length ? listed.map((model) => model.id) : instance.model ? [instance.model] : [];
			for (const model of models) {
				candidates.push({
					choice: {
						id: formatModelId(instance.id, model),
						label: model,
						description: `${instance.id} · ${instance.base}${failed ? ' · models not listed' : ''}${where}`,
						needsKey: !resolved.provider.key,
					},
					position: position++,
					declared: instance.model === model,
					hasKey: Boolean(resolved.provider.key),
				});
			}
		}
		// Two instances on one endpoint can report the same model. Show it once, bound to the instance
		// that can run it: a keyed instance beats a keyless one, and the one that declares the model
		// beats one that merely discovered it (its pricing and context window are the right ones).
		const byLabel = new Map<string, Candidate>();
		for (const candidate of candidates) {
			const label = candidate.choice.label.toLowerCase();
			const current = byLabel.get(label);
			if (!current) {
				byLabel.set(label, candidate);
				continue;
			}
			const better =
				(candidate.hasKey && !current.hasKey) ||
				(candidate.hasKey === current.hasKey && candidate.declared && !current.declared);
			if (better) {
				byLabel.set(label, { ...candidate, position: current.position });
			}
		}
		const choices = [...byLabel.values()]
			.sort((a, b) => a.position - b.position)
			.map((candidate) => candidate.choice);
		if (first) {
			const resolved = await this.resolveInstance(first.id).catch(() => undefined);
			choices.push({
				id: 'auto',
				label: 'Auto',
				description: `${first.id} — the first provider, model ${first.model ?? ''}`,
				needsKey: !resolved?.provider.key,
			});
		}
		return choices;
	}

	/**
	 * The same read, with the failure kept: the wizard says why a list is missing instead of silently
	 * offering the one model the instance declares.
	 */
	async probeModels(instanceId: string): Promise<{ ids: string[]; error?: string }> {
		try {
			const models = await this.runtime.listModels(instanceId, this.ctxOf());
			return { ids: models.map((model) => model.id) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ids: [], error: message };
		}
	}

	/** The wizard's probe of an endpoint before its instance is saved. `key` is used once, never stored. */
	async probeInstance(instance: ProviderInstanceConfig, key?: string): Promise<{ ids: string[]; error?: string }> {
		try {
			const models = await this.runtime.listModelsOf(instance, this.ctxOf(), key || undefined);
			return { ids: models.map((model) => model.id) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ids: [], error: message };
		}
	}

	/** The key already stored for an endpoint, or ''. */
	async storedKeyFor(base: string): Promise<string> {
		return (await this.ctx.host.secret(providerSecretKey(base))) ?? '';
	}

	/**
	 * Store a key for an endpoint. A key belongs to the provider, not to the instance that was on
	 * screen: every instance with the same normalized base resolves the same secret. An empty key
	 * clears the stored one, letting the environment fallback take over.
	 */
	async setSecret(instanceId: string, key: string, base?: string): Promise<void> {
		const instance = this.instance(instanceId);
		const endpoint = base ?? instance?.base;
		const id = providerSecretKey(endpoint);
		if (key) {
			await this.ctx.host.setSecret(id, key);
		} else {
			await this.ctx.host.deleteSecret(id);
		}
		this.runtime.invalidateCatalog();
		this.keyLogged.clear();
		this.ctx.emit('llm/keys-changed');
	}

	/** The key of an instance and where it came from, for the menu and the once-per-instance log. */
	async resolveKey(policyModel: string): Promise<string> {
		const resolved = await this.resolveInstanceFor(policyModel);
		this.noteKey(resolved.provider.instanceId, resolved.provider.keySource, resolved.provider.key);
		return resolved.provider.key ?? '';
	}

	/** Whether the model the policy names has a key; the UI asks before switching to a dead row. */
	async keyReady(policyModel: string): Promise<boolean> {
		try {
			return Boolean(await this.resolveKey(policyModel));
		} catch {
			return false;
		}
	}

	/**
	 * Where an instance's key comes from: the endpoint's keychain entry, one of its
	 * `keyEnv` variables (the first one set), or nowhere. A key the wizard saved and a
	 * key the shell exports are not the same thing, and the status table shows which.
	 */
	async keyInfo(instanceId: string): Promise<{ source: 'stored' | 'env' | 'none'; envName?: string }> {
		const resolved = await this.resolveInstance(instanceId).catch(() => undefined);
		if (!resolved) {
			return { source: 'none' };
		}
		if (resolved.provider.keySource === 'stored') {
			return { source: 'stored' };
		}
		for (const name of resolved.provider.keyEnvNames) {
			if (this.ctx.host.env(name)) {
				return { source: 'env', envName: name };
			}
		}
		return { source: 'none' };
	}

	instance(id: string): ProviderInstanceConfig | undefined {
		return providersOf(this.ctx.settings.get()).find((entry) => entry.id === id);
	}

	/** Whether a model id names an instance (the ids `auto` and empty always do). */
	known(policyModel: string): boolean {
		const wanted = policyModel.trim();
		if (!wanted || wanted === 'auto') {
			return true;
		}
		return Boolean(this.instance(parseModelRef(wanted).instanceId ?? ''));
	}

	/** The concrete model a chat's model id resolves to; the tokenizer keys off this. */
	modelName(policyModel: string): string {
		try {
			return this.preview(policyModel).model;
		} catch {
			return '';
		}
	}

	/** The merged facts (window, prices) behind a chat's model id. */
	modelInfo(policyModel: string): ModelInfo | undefined {
		try {
			const { wire, model } = this.preview(policyModel);
			return wire.models.get(model);
		} catch {
			return undefined;
		}
	}

	/**
	 * The instance a chat's model id resolves to, falling back to the first the way a turn does for
	 * an id whose instance is gone. Reads settings only: a panel drawing its state must not need a
	 * key to exist yet.
	 */
	instanceFor(policyModel: string): ProviderInstanceConfig | undefined {
		const wanted = policyModel.trim();
		if (wanted && wanted !== 'auto') {
			const named = this.instance(parseModelRef(wanted).instanceId ?? '');
			if (named) {
				return named;
			}
		}
		return providersOf(this.ctx.settings.get())[0];
	}

	/** The reply-share sampler a request runs with, from the merged options. */
	maxTokensFor(policyModel: string): number | undefined {
		try {
			const value = this.preview(policyModel).wire.options.maxTokens;
			return typeof value === 'number' ? value : undefined;
		} catch {
			return undefined;
		}
	}

	/** The level the endpoint will actually run: the pick, capped at the instance's ceiling. */
	effortFor(policyModel: string, effort: string): string {
		let top: EffortTop | undefined;
		try {
			const value = this.preview(policyModel).wire.options.topEffort;
			top = typeof value === 'string' ? (value as EffortTop) : undefined;
		} catch {
			top = undefined;
		}
		return limitEffort(effort, top);
	}

	/** What one completion cost, or null when the model has no price — the UI shows "—". */
	costFor(policyModel: string, usage: UsageRecord): number | null {
		return costFor(usage, this.modelInfo(policyModel)?.pricing);
	}

	/** What to call a selection: always the model it resolves to, which is what a turn will run. */
	describe(policyModel: string): string {
		try {
			const { wire, model } = this.preview(policyModel);
			return model ? (wire.models.get(model)?.label ?? model) : 'no model';
		} catch {
			return 'no model';
		}
	}

	invalidateCatalog(instanceId?: string): void {
		this.runtime.invalidateCatalog(instanceId);
	}

	/** A chat can remember an instance that is gone; its intent is "my model", so it runs on the first. */
	private withKnownRef(request: ChatRequest): ChatRequest {
		const model = this.knownModel(request.model);
		return model === request.model ? request : { ...request, model };
	}

	private knownModel(policyModel: string): string {
		const wanted = policyModel.trim();
		if (this.known(wanted)) {
			return wanted;
		}
		const first = providersOf(this.ctx.settings.get())[0];
		if (!first) {
			return wanted;
		}
		this.ctx.log.message(`unknown provider instance in "${wanted}"; using ${first.id}`);
		return first.id;
	}

	private preview(policyModel: string) {
		return this.runtime.previewCall(this.refFor(policyModel));
	}

	private async resolveInstance(instanceId: string) {
		return this.runtime.resolveCall({ instanceId });
	}

	private async resolveInstanceFor(policyModel: string) {
		return this.runtime.resolveCall(this.refFor(policyModel));
	}

	private refFor(policyModel: string) {
		const wanted = policyModel.trim();
		if (!wanted || wanted === 'auto') {
			return {};
		}
		const parsed = parseModelRef(wanted);
		return this.instance(parsed.instanceId ?? '') ? parsed : {};
	}

	private ctxOf(): InvocationContext {
		return {
			conversationId: 'model-menu',
			turnId: 'model-menu:0',
			requestId: `menu-${Date.now().toString(36)}`,
			signal: AbortSignal.timeout(8_000),
		};
	}

	/** One line per instance saying where its key came from, and a fingerprint to tell keys apart. */
	private noteKey(instanceId: string, source: string, key?: string): void {
		if (this.keyLogged.has(instanceId)) {
			return;
		}
		this.keyLogged.add(instanceId);
		const fingerprint = key ? ` sha256:${createHash('sha256').update(key).digest('hex').slice(0, 10)}` : '';
		this.ctx.log.message(`key ${instanceId}: ${source}${fingerprint}`);
	}
}

/** `instance` or `instance:model`, the form `comonad.model` and the menu use. */
export function formatModelId(instanceId: string, model?: string): string {
	return model ? `${instanceId}:${model}` : instanceId;
}

export const modelPlugin = Model;
