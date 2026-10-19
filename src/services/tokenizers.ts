// SPDX-License-Identifier: AGPL-3.0-only
import { Service, type Context } from 'cordis';
import { encodingForModel, estimateMessages, estimateTokens, setEncoder, type TikEncoding } from '../lib/tokens';
import type { ImagePart } from '../lib/types';
import { describe } from '../lib/util';
import { webTokenizers } from './web-tokenizers';

/**
 * Token counting for the configured model. The kernel owns two ends of it and leaves the middle to
 * whoever knows the files:
 *
 * 1. **The OpenAI family** — `tiktoken`'s encodings, which the rank tables in `gpt-tokenizer`
 *    reproduce exactly (a pure-JS BPE: no wasm file to ship, no request to make).
 * 2. **A provider a feature installs** (`ctx.tokenizers.use`) — a plugin that owns tokenizer files of
 *    its own claims the models they cover and loads them; the tavern layer installs SillyTavern's
 *    collection this way. A provider that downloads answers at once and hands its encoder over when
 *    it lands, so a turn never waits on the network.
 * 3. **Anything else** — upstream's own fallback, `ceil(bytes / 3.35)`, and one log line saying
 *    which tokenizer was missing.
 *
 * Nothing here is on the hot path in a way that can fail it: `warm()` is awaited once per turn, and
 * until it resolves the counter keeps answering with the estimate.
 */

/** The installed encoder: text in, token count out. */
type Encoder = (text: string) => number;

/** What a provider answers with: the encoder it loaded, or the reason there is none. */
export type EncoderLoad = { encoder: Encoder; label: string } | { why: string };

/**
 * A source of exact encoders a feature can install: `ctx.tokenizers.use(...)`. A provider owns the
 * models whose tokenizer files it knows and writes the status line for them; the kernel asks the
 * first one that claims a model, and counts with tiktoken or the estimate when none does.
 */
export interface EncoderProvider {
	/** Whether this provider owns the model's tokenizer. */
	owns(model: string): boolean;
	/** Whether the load is worth starting in the background: a download, so nothing waits on it. */
	background?(model: string): boolean;
	/** How the status line reads while the model is being prepared. */
	preparing(model: string): string;
	/** Loads the model's tokenizer: the encoder and its label, or why the estimate stands. */
	load(model: string): Promise<EncoderLoad>;
}

/** What the counter is currently backed by, for the settings tab and the log. */
export interface TokenizerStatus {
	/** The model the plan was made for. */
	model: string;
	/** `tiktoken`, `web` (a provider's file), or `estimate` while nothing is loaded. */
	kind: 'tiktoken' | 'web' | 'estimate';
	/** What it says on the tin: the encoding, the tokenizer file, or why it fell back. */
	label: string;
}

export class Tokenizers extends Service {
	static inject = ['host', 'log', 'settings'];

	/** What is settled, failures included: a model's tokenizer is only looked for once per session. */
	private readonly ready = new Map<string, { status: TokenizerStatus; encoder: Encoder | null }>();
	/** The models being prepared in the background. */
	private readonly pending = new Set<string>();
	private status: TokenizerStatus = { model: '', kind: 'estimate', label: 'bytes / 3.35 (nothing loaded yet)' };
	private readonly providers = new Set<EncoderProvider>();
	private warned = false;

	constructor(ctx: Context) {
		super(ctx, 'tokenizers');
		// The web-tokenizer files are this counter's own provider, installed with the kernel: counting
		// is not a feature that may go missing with a plugin row — a budget must not move because the
		// content layer is off.
		this.use(webTokenizers(ctx));
	}

	/** Installs a provider, so its models count exactly. Returns the remover. */
	use(provider: EncoderProvider): () => void {
		this.providers.add(provider);
		return () => void this.providers.delete(provider);
	}

	/** The diagnostics line the settings tab shows. */
	describe(): TokenizerStatus {
		return { ...this.status };
	}

	/**
	 * Counts one string the way upstream shows it. A plugin's bundle carries its own copy of the pure
	 * estimator, and `setEncoder` only ever reaches the kernel's — so anything outside the kernel that
	 * wants a real count asks here, through the one process-wide counter.
	 */
	count(text: string): number {
		return estimateTokens(text);
	}

	/** The same for a message list, framed the way upstream's `countTokensOpenAI(…, full)` does. */
	countMessages(messages: readonly { content?: string; toolCalls?: unknown; images?: readonly ImagePart[] }[]): number {
		return estimateMessages(messages);
	}

	/**
	 * Points the counter at the model's tokenizer and answers with what it is right now.
	 *
	 * A tokenizer that is already here, comes from a local file, or comes from the ranks that ship
	 * with the extension is installed before this resolves, so the turn's budget is exact. One that
	 * has to be *downloaded* is fetched in the background: a turn must never wait on the network, so
	 * it counts with the estimate and the next one is exact — which is how upstream degrades too, it
	 * counts with whatever tokenizer happens to be loaded.
	 */
	async warm(model: string): Promise<TokenizerStatus> {
		const cached = this.ready.get(model);
		if (cached) {
			setEncoder(cached.encoder);
			this.status = cached.status;
			return this.describe();
		}
		const provider = this.providerFor(model);
		if (provider?.background?.(model) || this.pending.has(model)) {
			this.status = {
				model,
				kind: 'estimate',
				label: `${provider ? provider.preparing(model) : 'preparing the tokenizer'} — counting as bytes / 3.35 until it lands`,
			};
			if (!this.pending.has(model)) {
				this.pending.add(model);
				void this.load(model).finally(() => this.pending.delete(model));
			}
			return this.describe();
		}
		return await this.load(model);
	}

	private providerFor(model: string): EncoderProvider | undefined {
		for (const provider of this.providers) {
			if (provider.owns(model)) {
				return provider;
			}
		}
		return undefined;
	}

	private async load(model: string): Promise<TokenizerStatus> {
		const provider = this.providerFor(model);
		try {
			if (provider) {
				const loaded = await provider.load(model);
				if ('why' in loaded) {
					return this.fallback(model, loaded.why);
				}
				return this.settle(model, { model, kind: 'web', label: loaded.label }, loaded.encoder);
			}
			// Everything else is an OpenAI-compatible model as far as counting goes, which is upstream's
			// own default too: an unknown name ends at `gpt-3.5-turbo`, i.e. cl100k_base.
			const name = (model ?? '').toLowerCase();
			if (!name) {
				return this.fallback(model, 'no model configured');
			}
			const encoding = encodingForModel(name);
			const encoder = await tiktokenEncoder(encoding);
			return this.settle(model, { model, kind: 'tiktoken', label: encoding }, encoder);
		} catch (error) {
			return this.fallback(model, describe(error));
		}
	}

	/** A tokenizer is in place: remember it, so switching back to this model is free, and install it. */
	private settle(model: string, status: TokenizerStatus, encoder: Encoder | null): TokenizerStatus {
		this.ready.set(model, { status, encoder });
		setEncoder(encoder);
		this.status = status;
		return this.describe();
	}

	/** Nothing could be loaded: the estimate stands, and the reason is said once. */
	private fallback(model: string, why: string): TokenizerStatus {
		const status: TokenizerStatus = { model, kind: 'estimate', label: `${why} — counting as bytes / 3.35` };
		this.ready.set(model, { status, encoder: null });
		setEncoder(null);
		this.status = status;
		if (!this.warned) {
			this.warned = true;
			this.ctx.log.message(`tokenizers: no tokenizer for ${model} (${why}); counts are estimates, as SillyTavern's fallback is`);
		}
		return this.describe();
	}
}

/**
 * The tiktoken encoding, imported lazily: the rank tables are megabytes of literals, and paying for
 * them at activation time would slow down every window that never counts a token.
 */
async function tiktokenEncoder(encoding: TikEncoding): Promise<(text: string) => number> {
	if (encoding === 'o200k_base') {
		const mod = await import('gpt-tokenizer/encoding/o200k_base');
		return (text) => mod.encode(text).length;
	}
	if (encoding === 'r50k_base') {
		const mod = await import('gpt-tokenizer/encoding/gpt2');
		return (text) => mod.encode(text).length;
	}
	const mod = await import('gpt-tokenizer/encoding/cl100k_base');
	return (text) => mod.encode(text).length;
}

export const tokenizersPlugin = Tokenizers;

declare module 'cordis' {
	interface Context {
		tokenizers: Tokenizers;
	}
}
