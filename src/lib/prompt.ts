// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { TOKENS_PADDING, countRaw, estimateAttachments, estimateMessages, suffixTokens } from './tokens';
import type { AttachmentPart, Message, ModelContext } from './types';

/** How much of the recorded transcript is sent back to the model. Pure module. */
export type ContextForm = 'rendered' | 'token' | 'raw';

const TOOL_LIMIT = 4_000;

/**
 * - `rendered`: full transcript, long tool output trimmed (default).
 * - `token`: assistant and user text only, no tool traffic.
 * - `raw`: the exact record, nothing trimmed.
 */
export function applyContextForm(transcript: Message[], form: ContextForm, toolLimit = TOOL_LIMIT): Message[] {
	if (form === 'token') {
		// `reasoning` survives even this trim: DeepSeek demands the chain of thought of every earlier
		// turn back whenever a request carries tools, and the agent loop always sends tools.
		return transcript
			.filter((message) => message.role === 'user' || message.role === 'assistant')
			// A prompt's attachments are part of the prompt, not tool traffic: an image-only message must
			// not become an empty one just because this form drops everything else.
			.map((message) => ({ role: message.role, content: message.content, reasoning: message.reasoning, attachments: message.attachments }) as Message);
	}
	if (form === 'raw') {
		return transcript.map((message) => ({ ...message }));
	}
	return transcript.map((message) =>
		message.role === 'tool' && message.content.length > toolLimit
			? { ...message, content: `${message.content.slice(0, toolLimit)}\n[...trimmed]` }
			: { ...message },
	);
}

/** The derived system message a compacted conversation travels with. Never stored in the canonical log. */
export function modelSummaryMessage(summary: string): Message {
	return { role: 'system', content: `Conversation summary (compacted):\n\n${summary}`, summarized: true };
}

/**
 * The model history for one request: the derived summary first, then the tail after `covers`,
 * filtered by the Context form. The summary is added after filtering so `token` cannot drop it.
 */
export function buildModelHistory(
	transcript: readonly Message[],
	modelContext: ModelContext | undefined,
	form: ContextForm,
	toolLimit = TOOL_LIMIT,
): Message[] {
	const from = Math.max(0, Math.min(modelContext?.covers ?? 0, transcript.length));
	const tail = applyContextForm(transcript.slice(from) as Message[], form, toolLimit);
	return modelContext?.summary ? [modelSummaryMessage(modelContext.summary), ...tail] : tail;
}

/** A stable projection of a transcript prefix: edits change it, ordinary appends do not. */
export function modelContextDigest(messages: readonly Message[]): string {
	const projection = messages
		.map((message) =>
			[
				message.role,
				message.content,
				message.at ?? '',
				message.toolCallId ?? '',
				(message.toolCalls ?? []).map((call) => `${call.id}\u0002${call.name}\u0002${call.arguments}`).join('\u0003'),
				(message.attachments ?? [])
					.map((part) =>
						part.kind === 'text'
							? `text\u0002${part.source.path ?? ''}\u0002${part.text}`
							: `${part.kind}\u0002${part.id}`,
					)
					.join('\u0003'),
			].join('\u0000'),
		)
		.join('\u0001');
	return createHash('sha256').update(projection).digest('hex').slice(0, 16);
}

/** How one request's input budget is made up. */
export interface Budget {
	/** The model's input window, after any per-chat override. */
	window: number;
	/** Held back for the reply, from the profile's `maxTokens`. */
	reserve: number;
	/** The system prompt and the tool definitions, measured for this turn. */
	overhead: number;
	/** What is left for the conversation itself. */
	input: number;
}

/** Under this the fixed parts of a request leave no room for a conversation worth having. */
export const MIN_INPUT_BUDGET = 1_024;

/**
 * What is held back for the reply when nothing says otherwise. A profile's `maxTokens` or a preset's
 * sampler wins when either is set; this only keeps a model that declares nothing from having a window
 * treated as if the answer were free.
 */
export const DEFAULT_OUTPUT_RESERVE = 8_192;

/** Where automatic compaction starts, in tokens left before the window is full. */
export const DEFAULT_COMPACTION_HEADROOM = 20_000;
export const MAX_COMPACTION_HEADROOM = 2_000_000;
/** How much of the window is kept verbatim after a summary. */
export const DEFAULT_COMPACTION_RETAIN_PERCENT = 10;
export const MIN_COMPACTION_RETAIN_PERCENT = 5;
export const MAX_COMPACTION_RETAIN_PERCENT = 80;

/**
 * What one request may spend on messages: the window, less the reply's share, less the fixed part of
 * every request (system prompt and tool definitions). Both of those are why a window's headline
 * number is not the amount of conversation that fits. A window too small to hold them leaves nothing
 * rather than a negative number — the fixed parts cannot be spent on messages — and a caller that
 * reads a budget under `MIN_INPUT_BUDGET` should say the window is misconfigured, not guess.
 */
export function resolveBudget(window: number, reserve: number, overhead: number): Budget {
	const room = Math.floor(window) - Math.max(0, reserve) - Math.max(0, overhead);
	return { window, reserve, overhead, input: Math.max(0, room) };
}

/** A provider-reported prompt size and the local estimate for the same request. */
export interface RequestSample {
	input: number;
	estimate: number;
}

/** Either side below this is noise, and a test provider often reports `input: 1`. */
export const CALIBRATION_MIN_TOKENS = 1_000;
export const CALIBRATION_RATIO_MIN = 0.5;
export const CALIBRATION_RATIO_MAX = 2;

/**
 * How far the local estimate is from the provider's count. `1` when there is no usable sample: a
 * provider that reports nothing must not turn into a made-up multiplier.
 */
export function calibrationRatio(sample: RequestSample | undefined): number {
	if (!sample || !Number.isFinite(sample.input) || !Number.isFinite(sample.estimate)) {
		return 1;
	}
	if (sample.input < CALIBRATION_MIN_TOKENS || sample.estimate < CALIBRATION_MIN_TOKENS) {
		return 1;
	}
	return Math.min(CALIBRATION_RATIO_MAX, Math.max(CALIBRATION_RATIO_MIN, sample.input / sample.estimate));
}

/** The provider-scale size a local estimate predicts. */
export function calibrate(estimate: number, sample: RequestSample | undefined): number {
	return Math.round(estimate * calibrationRatio(sample));
}

/** Where automatic compaction begins and how much verbatim tail it keeps. */
export interface CompactionLimits {
	/** False when the feature is off (`headroom` 0) or the window leaves no room for messages. */
	enabled: boolean;
	/** Whole-request tokens at which a summary is written. */
	trigger: number;
	/** Verbatim tail target, as a share of the configured window. */
	retain: number;
	/** The headroom actually used, clamped to half the window. */
	headroom: number;
}

/**
 * Turns the two settings into tokens. A headroom of 0 disables automatic compaction; the reply's
 * reserve is still held back and the hard-limit fallback still applies. The retain share is a
 * ceiling the planner may undershoot so the summary and the fixed request parts also fit.
 */
export function resolveCompactionLimits(
	window: number,
	reserve: number,
	headroom: number,
	retainPercent: number,
): CompactionLimits {
	const win = Math.max(0, Math.floor(window));
	const held = Math.max(0, Math.floor(reserve));
	const requested = Number.isFinite(headroom) ? headroom : 0;
	const effective = Math.min(Math.max(0, Math.floor(requested)), Math.floor(win / 2));
	const percent = Number.isFinite(retainPercent) ? retainPercent : DEFAULT_COMPACTION_RETAIN_PERCENT;
	const pct = Math.min(MAX_COMPACTION_RETAIN_PERCENT, Math.max(MIN_COMPACTION_RETAIN_PERCENT, percent));
	return {
		enabled: effective > 0,
		trigger: Math.max(0, win - Math.max(effective, held)),
		retain: Math.floor((win * pct) / 100),
		headroom: effective,
	};
}

/**
 * Sizes an old tool result is stepped down through. The first step keeps its head — usually the
 * command's own output and the start of a file, which is where the answer is — and the last one
 * leaves only the marker, for a result whose body nothing later depends on.
 */
const TOOL_ELISION_STEPS = [1_200, 400, 0];

function elided(text: string, size: number): string {
	if (text.length <= size) {
		return text;
	}
	return size <= 0 ? `[...${text.length} chars elided]` : `${text.slice(0, size)}\n[...${text.length - size} chars elided]`;
}

/**
 * Shrinks the oldest tool results until the estimate fits, without dropping a message or touching the
 * pairing between a call and its result. This is the cheap first answer to an over-full request: it
 * costs no model call, so it can run on every step of a turn.
 *
 * A message is stepped down through the sizes until one of them does not shrink it any further — a
 * marker is longer than a short result, so replacing it would grow the request — and every step's
 * saving is measured against the content that step replaces, not against the original.
 */
export function elideToolResults(messages: Message[], limit: number): { messages: Message[]; changed: boolean } {
	const out = messages.map((message) => ({ ...message }));
	let total = estimateMessages(out);
	let changed = false;
	// Images cost more than any text an old tool result can give back, so they go first. Prompts are
	// untouched here: what the user attached is not a tool result.
	for (let index = 0; index < out.length && total > limit; index += 1) {
		const message = out[index]!;
		const images = message.attachments?.filter((part) => part.kind === 'image');
		if (message.role !== 'tool' || !images?.length) {
			continue;
		}
		total -= estimateAttachments(images);
		const rest = message.attachments?.filter((part) => part.kind !== 'image');
		out[index] = { ...message, attachments: rest?.length ? rest : undefined };
		changed = true;
	}
	for (let index = 0; index < out.length && total > limit; index += 1) {
		const message = out[index]!;
		if (message.role !== 'tool') {
			continue;
		}
		const original = message.content;
		let current = original;
		for (const size of TOOL_ELISION_STEPS) {
			if (total <= limit) {
				break;
			}
			const next = elided(original, size);
			if (next.length >= current.length) {
				continue;
			}
			// Replacing one message's content moves the estimate by exactly the two strings' counts:
			// `countMessages` adds a fixed per-message cost and one padding for the list.
			total += countRaw(next) - countRaw(current);
			out[index] = { ...message, content: next };
			current = next;
			changed = true;
		}
	}
	return { messages: out, changed };
}

/** Whether any message carries an image. */
export function hasImageAttachments(messages: readonly Message[]): boolean {
	return messages.some((message) => message.attachments?.some((part) => part.kind === 'image'));
}

/**
 * The same messages without images, for a model that refused them. Text and document attachments
 * stay: they are content the model can still read. A message that was only an image keeps a line
 * saying what was left out, so the request never contains an empty prompt.
 */
export function stripImageAttachments(
	messages: readonly Message[],
	fallback = '[image omitted: this model does not accept images]',
): Message[] {
	return messages.map((message) => {
		if (!message.attachments?.some((part) => part.kind === 'image')) {
			return message;
		}
		const rest = message.attachments.filter((part) => part.kind !== 'image');
		return {
			...message,
			attachments: rest.length ? rest : undefined,
			content: message.content || fallback,
		};
	});
}

/**
 * The last resort for a request that still does not fit after tool output has been elided: drop
 * images and documents from older prompts, keeping text references and the newest prompt intact
 * while `keepLastUser` is set.
 */
export function dropPromptAttachments(messages: Message[], keepLastUser = true): { messages: Message[]; changed: boolean } {
	let lastUser = -1;
	if (keepLastUser) {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			if (messages[index]!.role === 'user') {
				lastUser = index;
				break;
			}
		}
	}
	let changed = false;
	const out = messages.map((message, index) => {
		const media = message.attachments?.some((part) => part.kind !== 'text');
		if (message.role !== 'user' || !media || index === lastUser) {
			return message;
		}
		changed = true;
		const rest: AttachmentPart[] = message.attachments!.filter((part) => part.kind === 'text');
		return {
			...message,
			attachments: rest.length ? rest : undefined,
			content: message.content || (rest.length ? message.content : '[attachments omitted to fit the model’s window]'),
		};
	});
	return { messages: out, changed };
}

/** Indices a message list may be cut at: the first message, and every user message after it. */
export function turnStarts(messages: readonly Message[]): number[] {
	return messages
		.map((message, index) => (index === 0 || message.role === 'user' ? index : -1))
		.filter((index) => index >= 0);
}

/** Which messages a compaction folds into a summary, and which it keeps verbatim. */
export interface CompactionPlan {
	/** Folded into the summary. */
	/** First message this plan may cover; messages before it are already summarized. */
	from: number;
	/** Absolute first message kept verbatim. */
	cut: number;
	/** Newly covered by this plan: `messages.slice(from, cut)`. */
	older: Message[];
	/** Kept word for word, newest last. */
	recent: Message[];
}

/**
 * Chooses the cut for a compaction: the earliest turn boundary at or after `from` whose tail fits
 * `retain` tokens — the longest verbatim tail within the target. The newest turn is kept even when
 * it alone exceeds `retain`, because the alternative is sending nothing.
 */
export function planCompaction(messages: readonly Message[], retain: number, from = 0): CompactionPlan {
	const start = Math.max(0, Math.min(from, messages.length));
	const starts = turnStarts(messages).filter((index) => index >= start);
	// One suffix pass: `suffix[cut] + padding` is exactly estimateMessages(messages.slice(cut)).
	const suffix = suffixTokens(messages);
	for (const cut of starts) {
		if (suffix[cut]! + TOKENS_PADDING <= retain) {
			return { from: start, cut, older: messages.slice(start, cut), recent: messages.slice(cut) };
		}
	}
	const cut = starts[starts.length - 1] ?? start;
	return { from: start, cut, older: messages.slice(start, cut), recent: messages.slice(cut) };
}
