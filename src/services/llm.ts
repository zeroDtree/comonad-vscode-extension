import { Service, type Context } from 'cordis';
import type { Completion } from '../lib/openai';
import type { CompletionUsage, Message, ToolCall, ToolSpec } from '../lib/types';
import { profileKeyEnvs, type Profile } from './settings';

/** Model access: profile resolution plus the OpenAI-compatible adapter that runs them. */

export interface StreamSink {
	onToken?(text: string): void;
	onReasoning?(text: string): void;
	onToolDelta?(call: ToolCall): void;
}

export interface ModelChoice {
	id: string;
	label: string;
	description: string;
}

export interface AdapterRequest {
	profile: Profile;
	/** Resolved API key for the profile. */
	key?: string;
	/** Model id to send to the provider. */
	model: string;
	messages: Message[];
	tools: ToolSpec[];
	signal: AbortSignal;
	sink: StreamSink;
	/** Thinking effort for models that support it (`auto` leaves it to the provider). */
	reasoningEffort?: string;
	/** Samplers a preset sets; they win over the profile's own. */
	temperature?: number;
	topP?: number;
	maxTokens?: number;
}

export interface LlmAdapter {
	name: string;
	chat(request: AdapterRequest): Promise<Completion>;
	/** The model ids this endpoint offers, for the model menu. */
	listModels?(request: { profile: Profile; key: string; signal: AbortSignal }): Promise<string[]>;
}

/** How long an endpoint's model list is reused before it is fetched again. */
const MODEL_TTL = 10 * 60_000;

function secretKey(profileId: string): string {
	return `comonad.key.${profileId}`;
}

/** A model selection: the profile alone (its default model) or `profile:model`. */
export function parseModelId(id: string): { profile: string; model?: string } {
	const cut = id.indexOf(':');
	return cut < 0 ? { profile: id } : { profile: id.slice(0, cut), model: id.slice(cut + 1) || undefined };
}

/** `profile` or `profile:model`, the form `comonad.model` and the menu use. */
export function formatModelId(profile: string, model?: string): string {
	return model ? `${profile}:${model}` : profile;
}

/**
 * The models to offer for a profile: the endpoint's own list, stripped of the prefix the provider
 * puts on ids and of the models its address space carries that cannot run a chat turn. Both rules
 * are profile data, never provider knowledge in code.
 */
export function shapeModels(reported: string[], profile: Profile): string[] {
	const prefix = profile.modelPrefix ?? '';
	let skip: RegExp | undefined;
	if (profile.modelSkip) {
		try {
			skip = new RegExp(profile.modelSkip, 'i');
		} catch {
			// A broken pattern hides nothing rather than hiding everything.
			skip = undefined;
		}
	}
	const ids = reported
		.map((id) => (prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id))
		.filter((id) => Boolean(id) && !skip?.test(id));
	return [...new Set(ids)];
}

declare module 'cordis' {
	interface Context {
		llm: Llm;
	}
}

interface ModelCache {
	at: number;
	ids: string[];
}

export class Llm extends Service {
	static inject = ['settings', 'host', 'log'];

	private readonly adapters = new Map<string, LlmAdapter>();
	private readonly modelCache = new Map<string, ModelCache>();

	constructor(ctx: Context) {
		super(ctx, 'llm');
	}

	/** Registers an adapter for the lifetime of the calling plugin. */
	use(adapter: LlmAdapter): void {
		this.ctx.effect(
			() => {
				this.adapters.set(adapter.name, adapter);
				return () => {
					this.adapters.delete(adapter.name);
				};
			},
			`ctx.llm.use(${JSON.stringify(adapter.name)})`,
		);
	}

	async chat(
		policyModel: string,
		messages: Message[],
		tools: ToolSpec[],
		sink: StreamSink,
		signal: AbortSignal,
		options: { reasoningEffort?: string; temperature?: number; topP?: number; maxTokens?: number } = {},
	): Promise<Completion> {
		const { adapter, profile, model } = this.resolve(policyModel);
		const key = await this.resolveKey(profile);
		this.ctx.log.message(`model ${profile.id} → ${model || '(default)'}`);
		return adapter.chat({
			profile,
			key,
			model,
			messages,
			tools,
			signal,
			sink,
			reasoningEffort: options.reasoningEffort,
			temperature: options.temperature,
			topP: options.topP,
			maxTokens: options.maxTokens,
		});
	}

	async complete(policyModel: string, system: string, user: string, timeoutMs = 180_000): Promise<string> {
		const result = await this.chat(
			policyModel,
			[
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			[],
			{},
			AbortSignal.timeout(timeoutMs),
		);
		return result.message.content.trim();
	}

	async choose(
		policyModel: string,
		request: { instruct: string; choices: { id: string; description: string }[] },
		signal: AbortSignal,
	): Promise<string> {
		const ids = request.choices.map((choice) => choice.id);
		const system = [
			request.instruct,
			`Reply with JSON: {"id": "<one of: ${ids.join(', ')}>"}.`,
			...request.choices.map((choice) => `- ${choice.id}: ${choice.description}`),
		].join('\n');
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const text = await this.complete(policyModel, system, 'Choose the next node.');
				const match = text.match(/\{[\s\S]*?\}/);
				if (match) {
					const parsed = JSON.parse(match[0]) as { id?: string };
					if (parsed.id && ids.includes(parsed.id)) {
						return parsed.id;
					}
				}
			} catch (error) {
				this.ctx.log.message(`choose failed: ${error instanceof Error ? error.message : String(error)}`);
				break;
			}
			if (signal.aborted) {
				break;
			}
		}
		return ids[0]!;
	}

	/** What to call a selection: the model when one is named, else the profile's label. */
	describe(policyModel: string): string {
		try {
			const { profile, model } = this.resolve(policyModel);
			return model && model !== profile.model ? model : profile.label || profile.id;
		} catch {
			return 'no model';
		}
	}

	/** Estimated USD cost for one completion, when the profile declares per-million-token pricing. */
	costFor(policyModel: string, usage: CompletionUsage): number {
		let profile: Profile;
		try {
			profile = this.resolve(policyModel).profile;
		} catch {
			return 0;
		}
		const pricingIn = profile.pricingIn ?? 0;
		const pricingOut = profile.pricingOut ?? 0;
		if (!pricingIn && !pricingOut) {
			return 0;
		}
		// Cached input is billed at its own (much lower) rate when the provider reports the split and
		// the profile prices it; everything else counts as a cache miss.
		const cached = profile.pricingCachedIn === undefined ? 0 : Math.min(usage.cached ?? 0, usage.input);
		const fresh = usage.input - cached;
		const cachedIn = profile.pricingCachedIn ?? pricingIn;
		return (fresh / 1_000_000) * pricingIn + (cached / 1_000_000) * cachedIn + (usage.output / 1_000_000) * pricingOut;
	}

	/** The model menu: the configured profiles and nothing else, each saying where its key comes from. */
	/**
	 * The model menu, read from the endpoints themselves: every profile contributes the models its
	 * provider lists, so a new model shows up without touching settings. A profile whose list cannot
	 * be fetched (no key, offline) still offers the default model it declares.
	 */
	async availableModels(options: { refresh?: boolean } = {}): Promise<ModelChoice[]> {
		const profiles = this.ctx.settings.get().profiles;
		const first = profiles[0]!;
		const choices: ModelChoice[] = [];
		for (const profile of profiles) {
			const key = await this.resolveKey(profile);
			const envs = profileKeyEnvs(profile);
			const where = key ? '' : envs.length ? ` · no key — set ${envs.join(' or ')}` : ' · no key — run "Comonad: Configure Model Provider"';
			const listed = await this.endpointModels(profile, key, Boolean(options.refresh));
			const models = listed.length ? listed : profile.model ? [profile.model] : [];
			for (const model of models) {
				choices.push({
					id: formatModelId(profile.id, model),
					label: model,
					description: `${profile.label || profile.id} · ${profile.base ?? 'no base URL'}${listed.length ? '' : ' · models not listed'}${where}`,
				});
			}
		}
		choices.push({
			id: 'auto',
			label: 'Auto',
			description: `${first.label || first.id} — the first profile, model ${first.model}`,
		});
		// Two endpoints can offer the same model id; the picker shows each label once, first wins.
		const seen = new Set<string>();
		return choices.filter((choice) => {
			const key = choice.label.toLowerCase();
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
	}

	/** Model ids of one endpoint, shaped by the profile and cached, so opening the menu is not a storm. */
	async endpointModels(profile: Profile, key: string, refresh = false): Promise<string[]> {
		const cached = this.modelCache.get(profile.id);
		if (!refresh && cached && Date.now() - cached.at < MODEL_TTL) {
			return cached.ids;
		}
		const adapter = this.findAdapter(profile.provider);
		if (!adapter?.listModels) {
			return [];
		}
		try {
			const reported = await adapter.listModels({ profile, key, signal: AbortSignal.timeout(8_000) });
			const ids = shapeModels(reported, profile);
			this.modelCache.set(profile.id, { at: Date.now(), ids });
			return ids;
		} catch (error) {
			this.ctx.log.message(`model list of ${profile.id} failed: ${error instanceof Error ? error.message : String(error)}`);
			return cached?.ids ?? [];
		}
	}

	async setSecret(profileId: string, key: string): Promise<void> {
		await this.ctx.host.setSecret(secretKey(profileId), key);
	}

	profile(id: string): Profile | undefined {
		return this.ctx.settings.get().profiles.find((profile) => profile.id === id);
	}

	/**
	 * The key of a profile: what the user stored, else the first variable the profile names that is
	 * set. Which variables those are is data on the profile (`keyEnv`), never a code-level choice.
	 */
	async resolveKey(profile: Profile): Promise<string> {
		const stored = await this.ctx.host.secret(secretKey(profile.id));
		if (stored) {
			return stored;
		}
		for (const name of profileKeyEnvs(profile)) {
			const value = this.ctx.host.env(name);
			if (value) {
				return value;
			}
		}
		return '';
	}

	private resolve(policyModel: string): { adapter: LlmAdapter; profile: Profile; model: string } {
		const profiles = this.ctx.settings.get().profiles;
		const wanted = policyModel.trim();
		const selected = parseModelId(wanted);
		const named = wanted && wanted !== 'auto' ? profiles.find((profile) => profile.id === selected.profile) : undefined;
		const profile = named ?? (wanted === 'auto' || !wanted ? profiles[0] : undefined);
		if (profile) {
			// A bare profile id uses the model that profile declares; `profile:model` picks one of the
			// models the endpoint lists.
			return { adapter: this.adapter(profile.provider), profile, model: selected.model ?? profile.model };
		}
		// A chat can still remember a profile that is gone (a removed provider, a renamed id). Its
		// intent is "my model", so it runs on the first profile and says so — see `Agent.runTurn`.
		const first = profiles[0];
		if (!first) {
			throw new Error('no model profile is configured; run "Comonad: Configure Model Provider"');
		}
		this.ctx.log.message(`unknown model profile "${wanted}"; using ${first.id}`);
		return { adapter: this.adapter(first.provider), profile: first, model: first.model };
	}

	/** Whether a model id names a profile (the ids `auto` and empty always do). */
	known(policyModel: string): boolean {
		const wanted = policyModel.trim();
		return !wanted || wanted === 'auto' || Boolean(this.profile(parseModelId(wanted).profile));
	}

	/**
	 * The model name a chat's model id resolves to, after the fallbacks above. The tokenizer keys off
	 * this: a chat that remembers a removed profile still counts tokens for the model it will run.
	 */
	modelName(policyModel: string): string {
		try {
			return this.resolve(policyModel).model;
		} catch {
			return '';
		}
	}

	/** The profile a chat's model id resolves to, for the settings the request itself needs. */
	profileFor(policyModel: string): Profile | undefined {
		try {
			return this.resolve(policyModel).profile;
		} catch {
			return undefined;
		}
	}

	/** The adapter a profile names, or the only loaded one. */
	private adapter(name: string | undefined): LlmAdapter {
		const adapter = this.findAdapter(name);
		if (!adapter) {
			throw new Error('no model adapter is loaded');
		}
		return adapter;
	}

	private findAdapter(name: string | undefined): LlmAdapter | undefined {
		return this.adapters.get(name ?? 'openai') ?? [...this.adapters.values()][0];
	}
}

export const llmPlugin = Llm;
