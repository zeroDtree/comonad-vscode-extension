// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { Service, type Context } from 'cordis';
import {
	definitionIdOf,
	HttpTransport,
	ModelRuntime,
	anthropicProvider,
	anthropicMessagesProtocol,
	costFor,
	customProvider,
	deepseekProvider,
	geminiProtocol,
	googleProvider,
	normalizeEndpoint,
	openaiProvider,
	openaiChatProtocol,
	opencodeGoProvider,
	parseModelRef,
	type ProviderDefinition,
	type ChatOptions,
	type ChatRequest,
	type ChatResult,
	type Disposable,
	type InvocationContext,
	type KeyProvider,
	type ModelInfo,
	type ProtocolDefinition,
	type ProviderEntry,
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
	/** The definition this row's provider speaks for; '' on the Auto row. */
	definitionId: string;
	/** Display name for `definitionId`, shipped from the host so webviews carry no label map. */
	providerLabel: string;
}

/** A provider not configured yet, offered as a setup row rather than a resolvable ref. */
export interface ModelSetupChoice {
	/** `__setup:<providerId>[:<model>]` — never stored; picking it opens the setup flow. */
	id: string;
	providerId: string;
	providerLabel: string;
	/** The model id, or '' for a whole-provider setup row. */
	label: string;
	description: string;
}

/** Choices of one definition, in menu order, for grouped pickers. Auto is excluded. */
export interface ModelGroup {
	definitionId: string;
	providerLabel: string;
	choices: ModelChoice[];
}

/** Group rows by definition, first-appearance order; the Auto row (`id === 'auto'`) is not grouped. */
export function groupModelChoices(choices: readonly ModelChoice[]): ModelGroup[] {
	const groups: ModelGroup[] = [];
	const byDefinition = new Map<string, ModelGroup>();
	for (const choice of choices) {
		if (choice.id === 'auto' || !choice.definitionId) {
			continue;
		}
		let group = byDefinition.get(choice.definitionId);
		if (!group) {
			group = { definitionId: choice.definitionId, providerLabel: choice.providerLabel, choices: [] };
			byDefinition.set(choice.definitionId, group);
			groups.push(group);
		}
		group.choices.push(choice);
	}
	return groups;
}

const PROVIDER_LABELS: Record<string, string> = {
	anthropic: 'Anthropic',
	custom: 'Custom',
	deepseek: 'DeepSeek',
	google: 'Google',
	openai: 'OpenAI',
	'opencode-go': 'OpenCode Go',
};

/** The name a provider is shown under; unknown ids humanize (capitalize, `-` → space). */
export function providerLabelFor(id: string): string {
	const known = PROVIDER_LABELS[id];
	if (known) {
		return known;
	}
	if (!id) {
		return '';
	}
	const humanized = id.replace(/-/g, ' ');
	return humanized.charAt(0).toUpperCase() + humanized.slice(1);
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
	private readonly definitionMap = new Map<string, ProviderDefinition>();

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
			entries: () => providersOf(this.ctx.settings.get()),
		});
		for (const protocol of [openaiChatProtocol, anthropicMessagesProtocol, geminiProtocol]) {
			this.runtime.registerProtocol(protocol);
		}
		for (const definition of [deepseekProvider, openaiProvider, opencodeGoProvider, googleProvider, anthropicProvider, customProvider]) {
			this.runtime.registerDefinition(definition);
			this.definitionMap.set(definition.id, definition);
		}
	}

	/** The test seam: a protocol definition (often a fake) the runtime will run. */
	registerProtocol(def: ProtocolDefinition): Disposable {
		return this.runtime.registerProtocol(def);
	}

	registerDefinition(def: ProviderDefinition): Disposable {
		this.definitionMap.set(def.id, def);
		return this.runtime.registerDefinition(def);
	}

	/** Every registered provider definition, for setup rows and the setup flow. */
	definitions(): ProviderDefinition[] {
		return [...this.definitionMap.values()];
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
		// A definition with several entries needs the entry id on each row to tell them apart;
		// a single-entry provider shows the base alone.
		const entriesByDefinition = new Map<string, number>();
		for (const entry of instances) {
			const defId = definitionIdOf(entry);
			entriesByDefinition.set(defId, (entriesByDefinition.get(defId) ?? 0) + 1);
		}
		interface Candidate {
			choice: ModelChoice;
			position: number;
			declared: boolean;
			hasKey: boolean;
			base: string;
		}
		const candidates: Candidate[] = [];
		let position = 0;
		for (const instance of instances) {
			const resolved = await this.resolveCall(instance.id);
			const where = resolved.provider.key
				? ''
				: resolved.provider.keyEnvNames.length
					? ` · no key — set ${resolved.provider.keyEnvNames.join(' or ')}`
					: ' · no key — run "Comonad: Configure Model Provider"';
			const hint = (entriesByDefinition.get(definitionIdOf(instance)) ?? 0) > 1 ? `${instance.id} · ` : '';
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
						description: `${hint}${instance.base}${failed ? ' · models not listed' : ''}${where}`,
						needsKey: !resolved.provider.key,
						definitionId: definitionIdOf(instance),
						providerLabel: providerLabelFor(definitionIdOf(instance)),
					},
					position: position++,
					declared: instance.model === model,
					hasKey: Boolean(resolved.provider.key),
					base: normalizeEndpoint(instance.base),
				});
			}
		}
		// Two endpoints on one physical base can report the same model. Show it once, bound to the
		// instance that can run it: a keyed instance beats a keyless one, and the one that declares
		// the model beats one that merely discovered it. Different bases never collapse — those are
		// genuinely different endpoints (official API vs a proxy) and each row must stay pickable.
		const byKey = new Map<string, Candidate>();
		for (const candidate of candidates) {
			const key = `${candidate.base} ${candidate.choice.label.toLowerCase()}`;
			const current = byKey.get(key);
			if (!current) {
				byKey.set(key, candidate);
				continue;
			}
			const better =
				(candidate.hasKey && !current.hasKey) ||
				(candidate.hasKey === current.hasKey && candidate.declared && !current.declared);
			if (better) {
				byKey.set(key, { ...candidate, position: current.position });
			}
		}
		const choices = [...byKey.values()]
			.sort((a, b) => a.position - b.position)
			.map((candidate) => candidate.choice);
		if (first) {
			const resolved = await this.resolveCall(first.id).catch(() => undefined);
			choices.push({
				id: 'auto',
				label: 'Auto',
				description: `${first.id} — the first provider, model ${first.model ?? ''}`,
				needsKey: !resolved?.provider.key,
				definitionId: '',
				providerLabel: '',
			});
		}
		return choices;
	}

	/**
	 * Providers not configured yet, as setup rows. Eligible: a registered definition with a default
	 * base, no configured entry, and not `custom` (its base comes only from the full wizard). These
	 * are never resolvable refs — picking one opens the setup flow, which stores the final id itself.
	 */
	setupChoices(): ModelSetupChoice[] {
		const configured = providersOf(this.ctx.settings.get());
		const rows: ModelSetupChoice[] = [];
		for (const def of this.definitions()) {
			if (def.id === 'custom') {
				continue;
			}
			if (configured.some((entry) => definitionIdOf(entry) === def.id)) {
				continue;
			}
			const base = def.defaults?.baseURL?.trim();
			if (!base) {
				continue;
			}
			const providerLabel = providerLabelFor(def.id);
			const models = def.modelCatalog?.map((model) => model.id) ?? [];
			if (models.length) {
				for (const model of models) {
					rows.push({
						id: `__setup:${def.id}:${model}`,
						providerId: def.id,
						providerLabel,
						label: model,
						description: `Set up ${providerLabel} — ${base}`,
					});
				}
			} else {
				rows.push({
					id: `__setup:${def.id}`,
					providerId: def.id,
					providerLabel,
					label: `Set up ${providerLabel}…`,
					description: base,
				});
			}
		}
		return rows;
	}

	/**
	 * The same read, with the failure kept: the wizard says why a list is missing instead of silently
	 * offering the one model the instance declares.
	 */
	async probeModels(providerId: string): Promise<{ ids: string[]; error?: string }> {
		try {
			const models = await this.runtime.listModels(providerId, this.ctxOf());
			return { ids: models.map((model) => model.id) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ids: [], error: message };
		}
	}

	/** The wizard's probe of an endpoint before its instance is saved. `key` is used once, never stored. */
	async probeProvider(instance: ProviderEntry, key?: string): Promise<{ ids: string[]; error?: string }> {
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
	async setSecret(providerId: string, key: string, base?: string): Promise<void> {
		const entry = this.provider(providerId);
		const endpoint = base ?? entry?.base;
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
		const resolved = await this.resolveCallFor(policyModel);
		this.noteKey(resolved.provider.providerId, resolved.provider.keySource, resolved.provider.key);
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
	 * Where an instance's key comes from — and what it could come from. `source` is the effective
	 * one (what a turn will use, honoring the endpoint's `keySource` preference); `stored`/`env`
	 * say which sources are available so the UI can offer the choice when both are.
	 */
	async keyInfo(providerId: string): Promise<{
		source: 'stored' | 'env' | 'none';
		envName?: string;
		stored: boolean;
		env: boolean;
		preferred: 'keychain' | 'env';
	}> {
		const entry = this.provider(providerId);
		const resolved = await this.resolveCall(providerId).catch(() => undefined);
		const stored = entry ? Boolean((await this.storedKeyFor(entry.base)).trim()) : false;
		const envName = resolved?.provider.keyEnvNames.find((name) => this.ctx.host.env(name)?.trim());
		return {
			source: resolved?.provider.keySource ?? 'none',
			envName,
			stored,
			env: Boolean(envName),
			preferred: entry?.keySource === 'env' ? 'env' : 'keychain',
		};
	}

	provider(id: string): ProviderEntry | undefined {
		return providersOf(this.ctx.settings.get()).find((entry) => entry.id === id);
	}

	/** Whether a model id names an instance (the ids `auto` and empty always do). */
	known(policyModel: string): boolean {
		const wanted = policyModel.trim();
		if (!wanted || wanted === 'auto') {
			return true;
		}
		return Boolean(this.provider(parseModelRef(wanted).providerId ?? ''));
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
	providerFor(policyModel: string): ProviderEntry | undefined {
		const wanted = policyModel.trim();
		if (wanted && wanted !== 'auto') {
			const named = this.provider(parseModelRef(wanted).providerId ?? '');
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

	invalidateCatalog(providerId?: string): void {
		this.runtime.invalidateCatalog(providerId);
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
		this.ctx.log.message(`unknown provider in "${wanted}"; using ${first.id}`);
		return first.id;
	}

	private preview(policyModel: string) {
		return this.runtime.previewCall(this.refFor(policyModel));
	}

	private async resolveCall(providerId: string) {
		return this.runtime.resolveCall({ providerId });
	}

	private async resolveCallFor(policyModel: string) {
		return this.runtime.resolveCall(this.refFor(policyModel));
	}

	private refFor(policyModel: string) {
		const wanted = policyModel.trim();
		if (!wanted || wanted === 'auto') {
			return {};
		}
		const parsed = parseModelRef(wanted);
		return this.provider(parsed.providerId ?? '') ? parsed : {};
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
	private noteKey(providerId: string, source: string, key?: string): void {
		if (this.keyLogged.has(providerId)) {
			return;
		}
		this.keyLogged.add(providerId);
		const fingerprint = key ? ` sha256:${createHash('sha256').update(key).digest('hex').slice(0, 10)}` : '';
		this.ctx.log.message(`key ${providerId}: ${source}${fingerprint}`);
	}
}

/** `instance` or `instance:model`, the form `comonad.model` and the menu use. */
export function formatModelId(providerId: string, model?: string): string {
	return model ? `${providerId}:${model}` : providerId;
}

export const modelPlugin = Model;
