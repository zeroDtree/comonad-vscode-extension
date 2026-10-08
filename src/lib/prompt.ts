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

/** Cheap token estimate: ~4 characters per token, good enough for budgets. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function estimateMessages(messages: Message[]): number {
	return messages.reduce(
		(sum, message) => sum + estimateTokens(message.content) + (message.toolCalls ? estimateTokens(JSON.stringify(message.toolCalls)) : 0),
		0,
	);
}

/**
 * Drops whole turns from the front until the estimate fits `limit` tokens, so a
 * tool result never loses the assistant call it belongs to. The newest turn is
 * kept even when it alone is over budget; `limit <= 0` keeps everything.
 *
 * A character's opening line is pinned: it is the chat's premise, it is one message,
 * and losing it silently the first time a chat grows would be a surprise.
 */
export function applyContextLimit(messages: Message[], limit: number): Message[] {
	if (limit <= 0 || messages.length === 0) {
		return messages;
	}
	const greeting = messages[0]?.greeting ? messages[0] : undefined;
	const body = greeting ? messages.slice(1) : messages;
	const kept = trimTurns(body, limit);
	return greeting ? [greeting, ...kept] : kept;
}

function trimTurns(messages: Message[], limit: number): Message[] {
	const starts = messages
		.map((message, index) => (index === 0 || message.role === 'user' ? index : -1))
		.filter((index) => index >= 0);
	for (const start of starts) {
		if (estimateMessages(messages.slice(start)) <= limit) {
			return start === 0 ? messages : messages.slice(start);
		}
	}
	const start = starts[starts.length - 1] ?? 0;
	return start === 0 ? messages : messages.slice(start);
}
