// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { Service, type Context } from 'cordis';
import { limitEffort } from '../lib/effort';
import { normalizeEndpoint } from '../lib/endpoint';
import type { Completion } from '../lib/openai';
import type { CompletionUsage, Message, ReasoningEffort, ToolCall, ToolSpec } from '../lib/types';
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
	/** No key resolves for the profile behind this row; picking it would fail on the next turn. */
	needsKey: boolean;
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

/**
 * The secret id for one provider endpoint. A stored key belongs to the endpoint, not to a profile:
 * the shipped DeepSeek block has two profiles on `https://api.deepseek.com`, and a key entered for
 * one of them must open both. Hashed so a URL with a query does not become a huge keychain label.
 */
function providerSecretKey(base: string | undefined): string {
	const identity = normalizeEndpoint(base);
	return identity ? `comonad.key.provider.${createHash('sha256').update(identity).digest('hex')}` : '';
}

/** A short fingerprint of a key, used to invalidate cached model lists when the key changes. */
function keyHash(key: string): string {
	return key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : '';
}

interface KeyInfo {
	key: string;
	/** Where the key came from, for the one log line per profile. */
	source: string;
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
	/** The inputs the list was fetched with; a change makes the entry a miss, not a stale answer. */
	base: string;
	provider: string;
	modelPrefix: string;
	modelSkip: string;
	keyEnv: string;
	keyHash: string;
}

function cacheInputs(profile: Profile, key: string): Omit<ModelCache, 'at' | 'ids'> {
	return {
		base: normalizeEndpoint(profile.base),
		provider: profile.provider ?? 'openai',
		modelPrefix: profile.modelPrefix ?? '',
		modelSkip: profile.modelSkip ?? '',
		keyEnv: profileKeyEnvs(profile).join(','),
		keyHash: keyHash(key),
	};
}

function sameInputs(cached: ModelCache, inputs: ReturnType<typeof cacheInputs>): boolean {
	return (
		cached.base === inputs.base &&
		cached.provider === inputs.provider &&
		cached.modelPrefix === inputs.modelPrefix &&
		cached.modelSkip === inputs.modelSkip &&
		cached.keyEnv === inputs.keyEnv &&
		cached.keyHash === inputs.keyHash
	);
}

/** The keyEnv names that can serve a profile: its own, then those of siblings on the same endpoint. */
function providerKeyEnvs(profile: Profile, profiles: Profile[]): string[] {
	const names = [...profileKeyEnvs(profile)];
	const identity = normalizeEndpoint(profile.base);
	if (!identity) {
		return names;
	}
	for (const other of profiles) {
		if (other.id === profile.id || normalizeEndpoint(other.base) !== identity) {
			continue;
		}
		for (const name of profileKeyEnvs(other)) {
			if (!names.includes(name)) {
				names.push(name);
			}
		}
	}
	return names;
}

export class Llm extends Service {
	static inject = ['settings', 'host', 'log', 'attachments'];

	private readonly adapters = new Map<string, LlmAdapter>();
	private readonly modelCache = new Map<string, ModelCache>();
	private readonly keyLogged = new Set<string>();

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
		// Every adapter receives the same fully resolved shape; the transcript itself never holds base64.
		const resolved = this.ctx.attachments.resolveMessages(messages);
		this.ctx.log.message(`model ${profile.id} → ${model || '(default)'}`);
		return adapter.chat({
			profile,
			key,
			model,
			messages: resolved,
			tools,
			signal,
			sink,
			// A level the endpoint does not go up to runs at the endpoint's ceiling instead.
			reasoningEffort: options.reasoningEffort === undefined ? undefined : limitEffort(options.reasoningEffort, profile.topEffort),
			temperature: options.temperature,
			topP: options.topP,
			maxTokens: options.maxTokens,
		});
	}

	async complete(
		policyModel: string,
		system: string,
		user: string,
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<string> {
		const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		const result = await this.chat(
			policyModel,
			[
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			[],
			{},
			signal,
		);
		// A stopped or timed-out request leaves a partial stream. Returning it would let a fragment be
		// read as the whole answer — a summary replacing the conversation with half a sentence.
		if (signal.aborted) {
			throw signal.reason ?? new DOMException('The request was stopped.', 'AbortError');
		}
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
				const text = await this.complete(policyModel, system, 'Choose the next node.', { signal });
				const match = text.match(/\{[\s\S]*?\}/);
				if (match) {
					const parsed = JSON.parse(match[0]) as { id?: string };
					if (parsed.id && ids.includes(parsed.id)) {
						return parsed.id;
					}
				}
			} catch (error) {
				signal.throwIfAborted();
				this.ctx.log.message(`choose failed: ${error instanceof Error ? error.message : String(error)}`);
				break;
			}
			signal.throwIfAborted();
		}
		signal.throwIfAborted();
		return ids[0]!;
	}

	/** What to call a selection: always the model it resolves to, which is what a turn will run. */
	describe(policyModel: string): string {
		try {
			const { profile, model } = this.resolve(policyModel);
			return model || profile.label || profile.id;
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

	/**
	 * The model menu, read from the endpoints themselves: every profile contributes the models its
	 * provider lists, so a new model shows up without touching settings. A profile whose list cannot
	 * be fetched (no key, offline) still offers the default model it declares.
	 */
	async availableModels(options: { refresh?: boolean } = {}): Promise<ModelChoice[]> {
		const profiles = this.ctx.settings.get().profiles;
		const first = profiles[0]!;
		interface Candidate {
			choice: ModelChoice;
			position: number;
			declared: boolean;
			hasKey: boolean;
		}
		const candidates: Candidate[] = [];
		let position = 0;
		for (const profile of profiles) {
			const info = await this.keyInfo(profile, profiles);
			const envs = providerKeyEnvs(profile, profiles);
			const where = info.key
				? ''
				: envs.length
					? ` · no key — set ${envs.join(' or ')}`
					: ' · no key — run "Comonad: Configure Model Provider"';
			const listed = await this.endpointModels(profile, info.key, Boolean(options.refresh));
			const models = listed.length ? listed : profile.model ? [profile.model] : [];
			for (const model of models) {
				candidates.push({
					choice: {
						id: formatModelId(profile.id, model),
						label: model,
						description: `${profile.label || profile.id} · ${profile.base ?? 'no base URL'}${listed.length ? '' : ' · models not listed'}${where}`,
						needsKey: !info.key,
					},
					position: position++,
					declared: profile.model === model,
					hasKey: Boolean(info.key),
				});
			}
		}
		// Two profiles on one endpoint can report the same model. Show it once, bound to the profile
		// that can run it: a keyed profile beats a keyless one, and the profile that declares the model
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
		choices.push({
			id: 'auto',
			label: 'Auto',
			description: `${first.label || first.id} — the first profile, model ${first.model}`,
			needsKey: !(await this.keyInfo(first, profiles)).key,
		});
		return choices;
	}

	/** Model ids of one endpoint, shaped by the profile and cached, so opening the menu is not a storm. */
	async endpointModels(profile: Profile, key: string, refresh = false): Promise<string[]> {
		return (await this.probeModels(profile, key, refresh)).ids;
	}

	/**
	 * The same read, with the failure kept: the wizard needs to say why a list is missing instead of
	 * silently offering the one model the profile declares.
	 */
	async probeModels(profile: Profile, key: string, refresh = false): Promise<{ ids: string[]; error?: string }> {
		const inputs = cacheInputs(profile, key);
		const cached = this.modelCache.get(profile.id);
		const usable = cached && sameInputs(cached, inputs) ? cached : undefined;
		if (!refresh && usable && Date.now() - usable.at < MODEL_TTL) {
			return { ids: usable.ids };
		}
		const adapter = this.findAdapter(profile.provider);
		if (!adapter?.listModels) {
			return { ids: usable?.ids ?? [] };
		}
		try {
			const reported = await adapter.listModels({ profile, key, signal: AbortSignal.timeout(8_000) });
			const ids = shapeModels(reported, profile);
			this.modelCache.set(profile.id, { at: Date.now(), ids, ...inputs });
			return { ids };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.ctx.log.message(`model list of ${profile.id} failed: ${message}`);
			return { ids: usable?.ids ?? [], error: message };
		}
	}

	/**
	 * Store a key for an endpoint. A key belongs to the provider, not to the profile that was on
	 * screen: every profile with the same normalized base resolves the same secret. An empty key
	 * clears the stored one, letting the legacy/sibling/environment fallbacks take over.
	 */
	async setSecret(profileId: string, key: string, base?: string): Promise<void> {
		const profile = this.profile(profileId);
		const endpoint = base ?? profile?.base;
		const id = providerSecretKey(endpoint) || secretKey(profileId);
		if (key) {
			await this.ctx.host.setSecret(id, key);
		} else {
			await this.ctx.host.deleteSecret(id);
		}
		this.invalidateModels(endpoint, profileId);
		this.ctx.emit('llm/keys-changed');
	}

	/** Drop cached lists (and the once-per-profile key log) for a profile and its provider siblings. */
	private invalidateModels(base: string | undefined, profileId: string): void {
		const identity = normalizeEndpoint(base);
		for (const profile of this.ctx.settings.get().profiles) {
			if (profile.id === profileId || (identity && normalizeEndpoint(profile.base) === identity)) {
				this.modelCache.delete(profile.id);
				this.keyLogged.delete(profile.id);
			}
		}
		this.keyLogged.delete(profileId);
	}

	profile(id: string): Profile | undefined {
		return this.ctx.settings.get().profiles.find((profile) => profile.id === id);
	}

	/**
	 * The key of a profile and where it came from. A key is a credential for the endpoint, not for a
	 * profile: a stored provider key outranks everything, then the profile's own legacy secret, then
	 * a sibling's secret on the same base (keys saved before provider scoping keep working), then the
	 * environment. Which variables those are is data on the profile (`keyEnv`), never a code choice.
	 */
	private async keyInfo(profile: Profile, profiles = this.ctx.settings.get().profiles): Promise<KeyInfo> {
		const identity = normalizeEndpoint(profile.base);
		if (identity) {
			const stored = await this.ctx.host.secret(providerSecretKey(profile.base));
			if (stored) {
				return { key: stored, source: 'provider' };
			}
		}
		const own = await this.ctx.host.secret(secretKey(profile.id));
		if (own) {
			return { key: own, source: 'stored' };
		}
		if (identity) {
			for (const other of profiles) {
				if (other.id === profile.id || normalizeEndpoint(other.base) !== identity) {
					continue;
				}
				const sibling = await this.ctx.host.secret(secretKey(other.id));
				if (sibling) {
					return { key: sibling, source: `stored ${other.id}` };
				}
			}
		}
		for (const name of profileKeyEnvs(profile)) {
			const value = this.ctx.host.env(name);
			if (value) {
				return { key: value, source: `env ${name}` };
			}
		}
		if (identity) {
			for (const other of profiles) {
				if (other.id === profile.id || normalizeEndpoint(other.base) !== identity) {
					continue;
				}
				for (const name of profileKeyEnvs(other)) {
					const value = this.ctx.host.env(name);
					if (value) {
						return { key: value, source: `env ${name} (${other.id})` };
					}
				}
			}
		}
		return { key: '', source: 'none' };
	}

	async resolveKey(profile: Profile): Promise<string> {
		const info = await this.keyInfo(profile);
		this.noteKey(profile, info.source, info.key);
		return info.key;
	}

	/** Whether the model the policy names has a key; the UI asks before switching to a dead row. */
	async keyReady(policyModel: string): Promise<boolean> {
		try {
			return Boolean(await this.resolveKey(this.resolve(policyModel).profile));
		} catch {
			return false;
		}
	}

	/** One line per profile saying where its key came from, and a fingerprint to tell keys apart. */
	private noteKey(profile: Profile, source: string, key?: string): void {
		if (this.keyLogged.has(profile.id)) {
			return;
		}
		this.keyLogged.add(profile.id);
		const fingerprint = key ? ` sha256:${createHash('sha256').update(key).digest('hex').slice(0, 10)}` : '';
		this.ctx.log.message(`key ${profile.id}: ${source}${fingerprint}`);
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

	/**
	 * The profile a chat's model id names, falling back to the first profile the way a turn does for
	 * an id whose profile is gone. Reads settings only: a panel drawing its state must not need an
	 * adapter to exist yet.
	 */
	private profileForModel(policyModel: string): Profile | undefined {
		const profiles = this.ctx.settings.get().profiles;
		const wanted = policyModel.trim();
		const selected = parseModelId(wanted);
		const named = wanted && wanted !== 'auto' ? profiles.find((profile) => profile.id === selected.profile) : undefined;
		return named ?? profiles[0];
	}

	/** The profile a chat's model id resolves to, for the settings the request itself needs. */
	profileFor(policyModel: string): Profile | undefined {
		return this.profileForModel(policyModel);
	}

	/** The level the endpoint will actually run: the pick, capped at the profile's ceiling. */
	effortFor(policyModel: string, effort: ReasoningEffort): string {
		return limitEffort(effort, this.profileForModel(policyModel)?.topEffort);
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
