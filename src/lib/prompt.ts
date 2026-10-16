import { countMessages, countRaw, countTokens } from './tokens';
import type { Message } from './types';

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
			.map((message) => ({ role: message.role, content: message.content, reasoning: message.reasoning }) as Message);
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

/** One string's token count, in the shape SillyTavern reports one (see `lib/tokens.ts`). */
export function estimateTokens(text: string): number {
	return countTokens(text);
}

export function estimateMessages(messages: Message[]): number {
	return countMessages(messages);
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

/**
 * Sizes an old tool result is stepped down through. The first step keeps its head — usually the
 * command's own output and the start of a file, which is where the answer is — and the last one
 * leaves only the marker, for a result whose body nothing later depends on.
 */
const TOOL_ELISION_STEPS = [1_200, 400, 0];

function elided(text: string, size: number): string {
	return size <= 0 ? `[...${text.length} chars elided]` : `${text.slice(0, size)}\n[...${text.length - size} chars elided]`;
}

/**
 * Shrinks the oldest tool results until the estimate fits, without dropping a message or touching the
 * pairing between a call and its result. This is the cheap first answer to an over-full request: it
 * costs no model call, so it can run on every step of a turn.
 */
export function elideToolResults(messages: Message[], limit: number): { messages: Message[]; changed: boolean } {
	const out = messages.map((message) => ({ ...message }));
	let total = estimateMessages(out);
	let changed = false;
	for (let index = 0; index < out.length && total > limit; index += 1) {
		const message = out[index]!;
		if (message.role !== 'tool') {
			continue;
		}
		const original = message.content;
		for (const size of TOOL_ELISION_STEPS) {
			if (original.length <= size || total <= limit) {
				continue;
			}
			const next = elided(original, size);
			// Replacing one message's content moves the estimate by exactly the two strings' counts:
			// `countMessages` adds a fixed per-message cost and one padding for the list.
			total += countRaw(next) - countRaw(original);
			out[index] = { ...message, content: next };
			changed = true;
		}
	}
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
	older: Message[];
	/** Kept word for word, newest last. */
	recent: Message[];
}

/**
 * Chooses the cut for a compaction: the earliest turn boundary whose tail still fits the budget once
 * `reserve` is set aside for the summary itself. Keeping the longest tail that fits is what makes the
 * newest turns survive word for word. When not even the current turn fits, it is kept anyway — the
 * alternative is sending nothing, and the request will not shrink below one turn by folding.
 */
export function planCompaction(messages: Message[], budget: number, reserve = 0): CompactionPlan {
	const starts = turnStarts(messages);
	for (const cut of starts) {
		const recent = messages.slice(cut);
		if (estimateMessages(recent) + reserve <= budget) {
			return { older: messages.slice(0, cut), recent };
		}
	}
	const cut = starts[starts.length - 1] ?? 0;
	return { older: messages.slice(0, cut), recent: messages.slice(cut) };
}
