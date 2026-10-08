import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Tokenizer } from '@agnai/web-tokenizers';
import { Service, type Context } from 'cordis';
import { encodingForModel, setEncoder, type TikEncoding } from '../lib/tokens';
import { describe } from '../lib/util';

/**
 * Token counting for the configured model, following SillyTavern's own chain:
 *
 * 1. **OpenAI family** — `tiktoken`'s encodings, which is what upstream asks its server for. The
 *    rank tables come from `gpt-tokenizer` (a pure-JS BPE with the same ranks as `tiktoken`), so
 *    there is no wasm file to ship and no request to make.
 * 2. **The models with a published tokenizer** — DeepSeek, Qwen2, Command R/A, Nemo, GLM: upstream
 *    downloads the very same files from the `SillyTavern-Tokenizers` repository on first use and
 *    caches them; so does this, into the extension's storage.
 * 3. **The models upstream ships in its own tree** — Gemma/Gemini, Llama3, Claude, Llama, Mistral,
 *    Yi, Jamba. Those files are part of SillyTavern, not of a public release, so they are read from
 *    a SillyTavern checkout the user points at with `comonad.tokenizerDir` (never guessed, never
 *    copied): the user's own copy of `src/tokenizers/<name>.json`.
 * 4. **Anything else** — upstream's own fallback, `ceil(bytes / 3.35)`, and one log line saying
 *    which tokenizer was missing.
 *
 * Nothing here is on the hot path in a way that can fail it: `warm()` is awaited once per turn, and
 * until it resolves the counter keeps answering with the estimate.
 */

/** Where upstream publishes the tokenizers it does not ship itself. */
const PUBLIC_BASE = 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main';

/** The files upstream downloads, in its own order of checks (`getWebTokenizer`). */
const DOWNLOADED: Array<{ pattern: RegExp; file: string }> = [
	{ pattern: /deepseek/, file: 'deepseek.json.gz' },
	{ pattern: /qwen2/, file: 'qwen2.json.gz' },
	{ pattern: /command-r/, file: 'command-r.json.gz' },
	{ pattern: /command-a/, file: 'command-a.json.gz' },
	{ pattern: /nemo/, file: 'nemo.json.gz' },
	{ pattern: /\bglm\b|glm-/, file: 'glm-4.6.json.gz' },
];

/** The files upstream keeps in its own tree, read from a SillyTavern checkout the user owns. */
const LOCAL: Array<{ pattern: RegExp; file: string }> = [
	{ pattern: /claude/, file: 'claude.json' },
	{ pattern: /llama-?3/, file: 'llama3.json' },
	{ pattern: /gemma|gemini|learnlm/, file: 'gemma.model' },
	{ pattern: /llama/, file: 'llama.model' },
	{ pattern: /mistral|mixtral/, file: 'mistral.model' },
	{ pattern: /\byi\b|-yi/, file: 'yi.model' },
	{ pattern: /jamba/, file: 'jamba.model' },
];

/** What the counter is currently backed by, for the settings tab and the log. */
export interface TokenizerStatus {
	/** The model the plan was made for. */
	model: string;
	/** `tiktoken`, `web`, or `estimate` while nothing is loaded. */
	kind: 'tiktoken' | 'web' | 'estimate';
	/** What it says on the tin: the encoding, the tokenizer file, or why it fell back. */
	label: string;
}

/** One plan: which encoder a model name maps onto. */
type Plan =
	| { kind: 'tiktoken'; encoding: TikEncoding }
	| { kind: 'download'; file: string }
	| { kind: 'local'; file: string }
	| { kind: 'none'; why: string };

/** The installed encoder: text in, token count out. */
type Encoder = (text: string) => number;

/** How a plan reads in the status line while it is still being prepared. */
function describePlan(plan: Plan): string {
	if (plan.kind === 'download') {
		return `fetching ${plan.file} from SillyTavern's tokenizer repository`;
	}
	if (plan.kind === 'local') {
		return `looking for ${plan.file} in the SillyTavern folder`;
	}
	return plan.kind === 'none' ? plan.why : 'preparing the tokenizer';
}

/** Upstream's `getTokenizerModel`, as a plan: model name in, encoder out. */
export function planFor(model: string): Plan {
	const name = (model ?? '').toLowerCase();
	if (!name) {
		return { kind: 'none', why: 'no model configured' };
	}
	for (const entry of DOWNLOADED) {
		if (entry.pattern.test(name)) {
			return { kind: 'download', file: entry.file };
		}
	}
	for (const entry of LOCAL) {
		if (entry.pattern.test(name)) {
			return { kind: 'local', file: entry.file };
		}
	}
	// Everything else is an OpenAI-compatible model as far as counting goes, which is upstream's own
	// default too: an unknown name ends at `gpt-3.5-turbo`, i.e. cl100k_base.
	return { kind: 'tiktoken', encoding: encodingForModel(name) };
}

export class Tokenizers extends Service {
	static inject = ['host', 'log', 'settings'];

	/** What is settled, failures included: a model's tokenizer is only looked for once per session. */
	private readonly ready = new Map<string, { status: TokenizerStatus; encoder: Encoder | null }>();
	/** The models being prepared in the background. */
	private readonly pending = new Set<string>();
	private status: TokenizerStatus = { model: '', kind: 'estimate', label: 'bytes / 3.35 (nothing loaded yet)' };
	private readonly web = new Map<string, Tokenizer>();
	private warned = false;

	constructor(ctx: Context) {
		super(ctx, 'tokenizers');
	}

	/** The diagnostics line the settings tab shows. */
	describe(): TokenizerStatus {
		return { ...this.status };
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
		const plan = planFor(model);
		if (plan.kind === 'download' || this.pending.has(model)) {
			this.status = { model, kind: 'estimate', label: `${describePlan(plan)} — counting as bytes / 3.35 until it lands` };
			if (!this.pending.has(model)) {
				this.pending.add(model);
				void this.load(model).finally(() => this.pending.delete(model));
			}
			return this.describe();
		}
		return await this.load(model);
	}

	private async load(model: string): Promise<TokenizerStatus> {
		const plan = planFor(model);
		try {
			if (plan.kind === 'tiktoken') {
				const encoder = await tiktokenEncoder(plan.encoding);
				return this.settle(model, { model, kind: 'tiktoken', label: plan.encoding }, encoder);
			}
			if (plan.kind === 'download' || plan.kind === 'local') {
				const path = plan.kind === 'download' ? await this.download(plan.file) : this.localFile(plan.file);
				if (!path) {
					return this.fallback(
						model,
						plan.kind === 'download' ? `${plan.file} could not be downloaded` : `${plan.file} is not in the SillyTavern folder`,
					);
				}
				const tokenizer = await this.webTokenizer(path);
				if (!tokenizer) {
					return this.fallback(model, `${plan.file} could not be loaded`);
				}
				return this.settle(model, { model, kind: 'web', label: plan.file }, (text) => tokenizer.encode(text).length);
			}
			return this.fallback(model, plan.kind === 'none' ? plan.why : 'no tokenizer for this model');
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

	/** The cache upstream keeps under `data/_cache`: one uncompressed file per tokenizer. */
	private cacheDir(): string {
		return join(this.ctx.host.storage.root, 'tokenizers');
	}

	private async download(file: string): Promise<string | null> {
		const dir = this.cacheDir();
		const plain = join(dir, file.replace(/\.gz$/, ''));
		if (existsSync(plain)) {
			return plain;
		}
		if (!this.ctx.settings.get().network) {
			// Comonad does not reach the internet unless the session allows network at all; upstream has
			// the same switch (`enableDownloadableTokenizers`).
			this.ctx.log.message(`tokenizers: ${file} is not cached and network is off, counting with the estimate`);
			return null;
		}
		mkdirSync(dir, { recursive: true });
		try {
			const response = await fetch(`${PUBLIC_BASE}/${file}`);
			if (!response.ok) {
				this.ctx.log.message(`tokenizers: ${file} download failed (${response.status})`);
				return null;
			}
			const compressed = Buffer.from(await response.arrayBuffer());
			writeFileSync(plain, gunzipSync(compressed));
			return plain;
		} catch (error) {
			this.ctx.log.message(`tokenizers: ${file} download failed (${describe(error)})`);
			return null;
		}
	}

	/** A tokenizer out of the SillyTavern checkout `comonad.tokenizerDir` points at. */
	private localFile(file: string): string | null {
		const dir = this.ctx.settings.get().tokenizerDir ?? '';
		if (!dir) {
			return null;
		}
		for (const candidate of [join(dir, file), join(dir, 'src', 'tokenizers', file)]) {
			try {
				if (existsSync(candidate) && statSync(candidate).isFile()) {
					return candidate;
				}
			} catch {
				// A path we cannot look at is simply not the file we wanted.
			}
		}
		return null;
	}

	private async webTokenizer(path: string): Promise<Tokenizer | null> {
		const cached = this.web.get(path);
		if (cached) {
			return cached;
		}
		try {
			// The binding reads bytes: its declaration says `ArrayBuffer`, but a `Buffer` — what
			// `readFileSync` returns and what upstream passes — is what it actually consumes.
			const bytes = readFileSync(path);
			const tokenizer = await Tokenizer.fromJSON(bytes as unknown as ArrayBuffer);
			this.web.set(path, tokenizer);
			return tokenizer;
		} catch (error) {
			this.ctx.log.message(`tokenizers: ${path} could not be loaded (${describe(error)})`);
			return null;
		}
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
