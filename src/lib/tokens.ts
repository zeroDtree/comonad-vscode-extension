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

import { estimateImageTokens } from './images';
import type { AttachmentPart } from './types';

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

/** What the typed content beside a message's prose costs. */
export function estimateAttachments(attachments?: readonly AttachmentPart[]): number {
	let total = 0;
	for (const part of attachments ?? []) {
		if (part.kind === 'text') {
			total += countRaw(part.text);
		} else if (part.kind === 'image') {
			total += estimateImageTokens(part);
		} else {
			total += countRaw(part.text ?? '');
		}
	}
	return total;
}

/**
 * Everything one message contributes to the request. `reasoning` is part of the wire body whenever
 * it is present (DeepSeek requires `reasoning_content` back), so a context budget that ignores it
 * undercounts by however much the model thought.
 */
export function messageTokens(message: {
	content?: string;
	reasoning?: string;
	toolCalls?: unknown;
	attachments?: readonly AttachmentPart[];
}): number {
	let total = TOKENS_PER_MESSAGE;
	total += countRaw(message.content ?? '');
	total += countRaw(message.reasoning ?? '');
	total += estimateAttachments(message.attachments);
	if (message.toolCalls !== undefined) {
		total += countRaw(JSON.stringify(message.toolCalls));
	}
	return total;
}

/** A message list counted the way upstream's `countTokensOpenAI(…, full)` does. */
export function estimateMessages(
	messages: readonly {
		content?: string;
		reasoning?: string;
		toolCalls?: unknown;
		attachments?: readonly AttachmentPart[];
	}[],
): number {
	let total = 0;
	for (const message of messages) {
		total += messageTokens(message);
	}
	return total + TOKENS_PADDING;
}

/** The same totals from each cut to the end, in one pass, for every candidate cut. */
export function suffixTokens(
	messages: readonly {
		content?: string;
		reasoning?: string;
		toolCalls?: unknown;
		attachments?: readonly AttachmentPart[];
	}[],
): number[] {
	const suffix = new Array<number>(messages.length + 1).fill(0);
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		suffix[index] = suffix[index + 1]! + messageTokens(messages[index]!);
	}
	return suffix;
}

/** A token count the way a window is spoken about: raw below 1K, whole K, one-decimal M/G. */
export function formatTokens(tokens: number): string {
	const count = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
	if (count < 1_024) {
		return `${count}`;
	}
	if (count < 1_048_576) {
		const thousands = Math.round(count / 1_024);
		return thousands < 1_024 ? `${thousands}K` : '1M';
	}
	if (count < 1_073_741_824) {
		const millions = Math.round((count / 1_048_576) * 10) / 10;
		return millions < 1_024 ? `${millions}M` : '1G';
	}
	return `${Math.round((count / 1_073_741_824) * 10) / 10}G`;
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
