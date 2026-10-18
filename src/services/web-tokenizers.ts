import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Tokenizer } from '@agnai/web-tokenizers';
import type { Context } from 'cordis';
import type { EncoderLoad, EncoderProvider } from './tokenizers';
import { describe } from '../lib/util';

/**
 * The web-tokenizer files: the kernel's own provider for the models tiktoken does not cover.
 *
 * The collection is SillyTavern's, in exactly the shapes it reads them, and counting is the kernel's
 * business — a budget or a compaction point must not move because the content layer is not installed.
 * Three kinds of files, in upstream's own order of checks (`getWebTokenizer`):
 *
 * 1. **The models with a published tokenizer** — DeepSeek, Qwen2, Command R/A, Nemo, GLM: upstream
 *    downloads the very same files from the `SillyTavern-Tokenizers` repository on first use and
 *    caches them; so does this, into the extension's storage.
 * 2. **The models upstream ships in its own tree** — Gemma/Gemini, Llama3, Claude, Llama, Mistral,
 *    Yi, Jamba. Those files are part of SillyTavern, not of a public release, so they are read from
 *    a SillyTavern checkout the `tokenizerDir` setting points at (never guessed, never copied): the
 *    user's own copy of `src/tokenizers/<name>.json`.
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

/** One plan: which tokenizer file a model name maps onto, and where the file comes from. */
export interface WebPlan {
	file: string;
	download: boolean;
}

/** Upstream's `getTokenizerModel`, as a plan: model name in, tokenizer file out — or `null`. */
export function webPlan(model: string): WebPlan | null {
	const name = (model ?? '').toLowerCase();
	if (!name) {
		return null;
	}
	for (const entry of DOWNLOADED) {
		if (entry.pattern.test(name)) {
			return { file: entry.file, download: true };
		}
	}
	for (const entry of LOCAL) {
		if (entry.pattern.test(name)) {
			return { file: entry.file, download: false };
		}
	}
	return null;
}

/** The provider the counter installs: the web-tokenizer files, from the repository or a checkout. */
export function webTokenizers(ctx: Context): EncoderProvider {
	const web = new Map<string, Tokenizer>();

	/** The cache upstream keeps under `data/_cache`: one uncompressed file per tokenizer. */
	const cacheDir = (): string => join(ctx.host.storage.root, 'tokenizers');

	const download = async (file: string): Promise<string | null> => {
		const dir = cacheDir();
		const plain = join(dir, file.replace(/\.gz$/, ''));
		if (existsSync(plain)) {
			return plain;
		}
		if (!ctx.settings.get().network) {
			// Comonad does not reach the internet unless the session allows network at all; upstream has
			// the same switch (`enableDownloadableTokenizers`).
			ctx.log.message(`tokenizers: ${file} is not cached and network is off, counting with the estimate`);
			return null;
		}
		mkdirSync(dir, { recursive: true });
		try {
			const response = await fetch(`${PUBLIC_BASE}/${file}`);
			if (!response.ok) {
				ctx.log.message(`tokenizers: ${file} download failed (${response.status})`);
				return null;
			}
			const compressed = Buffer.from(await response.arrayBuffer());
			writeFileSync(plain, gunzipSync(compressed));
			return plain;
		} catch (error) {
			ctx.log.message(`tokenizers: ${file} download failed (${describe(error)})`);
			return null;
		}
	};

	/** A tokenizer out of the SillyTavern checkout `tokenizerDir` points at. */
	const localFile = (file: string): string | null => {
		const dir = ctx.settings.get().tokenizerDir ?? '';
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
	};

	const webTokenizer = async (path: string): Promise<Tokenizer | null> => {
		const cached = web.get(path);
		if (cached) {
			return cached;
		}
		try {
			// The binding reads bytes: its declaration says `ArrayBuffer`, but a `Buffer` — what
			// `readFileSync` returns and what upstream passes — is what it actually consumes.
			const bytes = readFileSync(path);
			const tokenizer = await Tokenizer.fromJSON(bytes as unknown as ArrayBuffer);
			web.set(path, tokenizer);
			return tokenizer;
		} catch (error) {
			ctx.log.message(`tokenizers: ${path} could not be loaded (${describe(error)})`);
			return null;
		}
	};

	return {
		owns: (model) => webPlan(model) !== null,
		background: (model) => webPlan(model)?.download === true,
		preparing: (model) => {
			const plan = webPlan(model);
			return plan?.download
				? `fetching ${plan.file} from SillyTavern's tokenizer repository`
				: `looking for ${plan?.file ?? 'a tokenizer'} in the SillyTavern folder`;
		},
		load: async (model): Promise<EncoderLoad> => {
			const plan = webPlan(model);
			if (!plan) {
				return { why: 'no tokenizer for this model' };
			}
			const path = plan.download ? await download(plan.file) : localFile(plan.file);
			if (!path) {
				return { why: plan.download ? `${plan.file} could not be downloaded` : `${plan.file} is not in the SillyTavern folder` };
			}
			const tokenizer = await webTokenizer(path);
			if (!tokenizer) {
				return { why: `${plan.file} could not be loaded` };
			}
			return { encoder: (text) => tokenizer.encode(text).length, label: plan.file };
		},
	};
}
