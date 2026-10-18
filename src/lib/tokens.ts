// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Token counting, in SillyTavern's own shape.
 *
 * Upstream counts *messages*, not strings: `countTokensOpenAI` adds 3 tokens per message plus a
 * 3-token padding, and counting a single string wraps it in one message — so the "Tokens:" a world
 * book entry shows is `encode(text) + 6`, not the length of the encoding. That is copied on purpose:
 * the number this module produces is meant to be the number SillyTavern prints.
 *
 * The encoder itself is installed by `ctx.tokenizers` once it has warmed up (a real BPE for the
 * configured model). Until then — and for a model with no tokenizer at all — the count falls back to
 * upstream's own estimate, `ceil(bytes / 3.35)`, so a cold start is a number rather than a missing
 * one, exactly as SillyTavern degrades.
 *
 * Pure module: no `vscode`, no `cordis`.
 */

/** Upstream's `BYTES_PER_TOKEN`, used by its `guesstimate` fallback. */
export const BYTES_PER_TOKEN = 3.35;
/** Upstream's `tokensPerMessage` (3; an older GPT-3.5 framing used 4, which nothing sends anymore). */
export const TOKENS_PER_MESSAGE = 3;
/** Upstream's `tokensPadding`, added once per count. */
export const TOKENS_PADDING = 3;
/** What one string costs counted on its own, which is how a single field is shown. */
export const MESSAGE_OVERHEAD = TOKENS_PER_MESSAGE + TOKENS_PADDING;

/** The encodings the OpenAI-compatible path can use. */
export type TikEncoding = 'o200k_base' | 'cl100k_base' | 'r50k_base';

/** Upstream's `guesstimate`: bytes over `BYTES_PER_TOKEN`, rounded up. */
export function guesstimate(text: string): number {
	return Math.ceil(Buffer.byteLength(text ?? '', 'utf8') / BYTES_PER_TOKEN);
}

type Encoder = (text: string) => number;

let encoder: Encoder | null = null;

/**
 * What the encoder last answered for a string. A panel that draws token counts re-counts the same
 * fields on every push, and a BPE encode is the most expensive thing in that path — so the count of
 * a string it has already seen is remembered. Bounded: a library that replaces every string simply
 * starts the cache over.
 */
const counted = new Map<string, number>();
const COUNTED_MAX = 4096;

/**
 * Installs the real encoder, or `null` to fall back to the estimate. Called by the tokenizer service
 * when it has a model loaded (and again with `null` when the model has no tokenizer).
 */
export function setEncoder(next: Encoder | null): void {
	encoder = next;
	// Every cached count belongs to the encoder that produced it: a different one answers differently.
	counted.clear();
}

/** The encoding of one string, with no message framing. */
export function countRaw(text: string): number {
	if (typeof text !== 'string' || !text.length) {
		return 0;
	}
	const seen = counted.get(text);
	if (seen !== undefined) {
		return seen;
	}
	const count = encoder ? encoder(text) : guesstimate(text);
	if (counted.size >= COUNTED_MAX) {
		counted.clear();
	}
	counted.set(text, count);
	return count;
}

/** One string counted the way upstream counts it: as a message of its own. */
export function estimateTokens(text: string): number {
	if (typeof text !== 'string' || !text.length) {
		return 0;
	}
	return countRaw(text) + MESSAGE_OVERHEAD;
}

/** A message list counted the way upstream's `countTokensOpenAI(…, full)` does. */
export function estimateMessages(messages: readonly { content?: string; toolCalls?: unknown }[]): number {
	let total = 0;
	for (const message of messages) {
		total += TOKENS_PER_MESSAGE;
		total += countRaw(message.content ?? '');
		if (message.toolCalls !== undefined) {
			total += countRaw(JSON.stringify(message.toolCalls));
		}
	}
	return total + TOKENS_PADDING;
}

/**
 * Which encoding a model name uses, matching `tiktoken.encoding_for_model` for the families that
 * matter: the `o200k_base` models first, then the `cl100k_base` ones, then the legacy `r50k_base`.
 * Anything unknown counts as `cl100k_base` — upstream's default mapping ends at `gpt-3.5-turbo`.
 */
export function encodingForModel(model: string): TikEncoding {
	const name = (model ?? '').toLowerCase().replace(/^models\//, '');
	if (/^(gpt-4o|chatgpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|gpt-oss)/.test(name)) {
		return 'o200k_base';
	}
	// The embeddings and the newer chat models are cl100k, however their names read: `ada` here is
	// part of `text-embedding-ada-002`, not the GPT-2-era `ada`.
	if (/^(text-embedding-|gpt-4|gpt-3\.5|gpt-35)/.test(name)) {
		return 'cl100k_base';
	}
	// Only the `*-davinci`/`*-curie`/… families themselves use the GPT-2 ranks.
	if (/^(text-|code-)?(davinci|curie|babbage|ada)(-|$)/.test(name) || /^gpt-?2$/.test(name)) {
		return 'r50k_base';
	}
	return 'cl100k_base';
}
