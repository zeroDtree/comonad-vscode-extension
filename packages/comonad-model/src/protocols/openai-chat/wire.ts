// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The openai-chat wire: request body shape, the SSE chunk shape, and their mapping onto
 * the protocol-neutral events. Both OpenAI cache-token spellings are read here —
 * `prompt_cache_hit_tokens` (DeepSeek) and `prompt_tokens_details.cached_tokens` (OpenAI)
 * are dialects of this one wire — while genuinely odd usage shapes are a brand's `usageMap`.
 */
import type { OptionSchema, OptionValues, ResolvedProvider } from '../../config/schema';
import type { FinishReason, Message, ToolDeclaration, UsageRecord } from '../../types';
import { toOpenAiMessages } from './messages';

/** What this wire calls its knobs. Anything else is rejected at merge time. */
export const OPENAI_CHAT_OPTIONS: OptionSchema = {
	temperature: { type: 'number' },
	topP: { type: 'number' },
	maxTokens: { type: 'number' },
	reasoningEffort: { type: 'string', enum: ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] },
	topEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
	thinkingOff: { type: 'string', enum: ['thinking', 'effort'] },
	includeUsage: { type: 'boolean' },
	responseFormat: { type: 'object' },
	extraBody: { type: 'object' },
};

/** One streamed chunk, before interpretation. */
export interface OpenAiStreamEvent {
	choices?: {
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: {
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
				/** Google's OpenAI-compatible layer puts the thinking model's signature here. */
				extra_content?: Record<string, unknown> | null;
			}[];
		};
		finish_reason?: string | null;
	}[];
	usage?: {
		prompt_tokens?: number | null;
		completion_tokens?: number | null;
		prompt_cache_hit_tokens?: number | null;
		prompt_tokens_details?: { cached_tokens?: number | null } | null;
	} | null;
}

/** The Chat Completions request body for one chat call. */
export function chatBody(
	provider: ResolvedProvider,
	request: { model: string; messages: readonly Message[]; tools: readonly ToolDeclaration[]; options: OptionValues },
): Record<string, unknown> {
	const options = request.options;
	const body: Record<string, unknown> = {
		model: request.model,
		messages: toOpenAiMessages(request.messages),
		stream: true,
	};
	if (typeof options.temperature === 'number') {
		body.temperature = options.temperature;
	}
	if (typeof options.topP === 'number') {
		body.top_p = options.topP;
	}
	if (typeof options.maxTokens === 'number') {
		body.max_tokens = options.maxTokens;
	}
	const effort = typeof options.reasoningEffort === 'string' ? options.reasoningEffort : undefined;
	const thinkingOff = options.thinkingOff === 'thinking' || options.thinkingOff === 'effort' ? options.thinkingOff : undefined;
	if (effort && effort !== 'auto') {
		// DeepSeek enables thinking by default and only its own field turns it off; Gemini takes
		// `reasoning_effort: "none"`. Providers that declare neither keep the provider default.
		if (effort === 'none' && thinkingOff === 'thinking') {
			body.thinking = { type: 'disabled' };
		} else if (!(effort === 'none' && !thinkingOff)) {
			body.reasoning_effort = effort;
		}
	}
	if (request.tools.length) {
		body.tools = request.tools.map((tool) => ({
			type: 'function',
			function: { name: tool.name, description: tool.description, parameters: tool.parameters },
		}));
	}
	if (options.responseFormat !== undefined) {
		body.response_format = options.responseFormat;
	}
	if (options.includeUsage) {
		body.stream_options = { include_usage: true };
	}
	const extra = options.extraBody;
	if (extra && typeof extra === 'object') {
		Object.assign(body, extra);
	}
	return body;
}

/**
 * The usage a chunk reports, if any. Absent cache fields mean the endpoint does not report
 * cache statistics; only a reported number (including zero) may reach the accumulator, which
 * uses presence as the "this provider reports cache" signal.
 */
export function usageOf(event: OpenAiStreamEvent): UsageRecord | undefined {
	if (!event.usage) {
		return undefined;
	}
	const cached = event.usage.prompt_cache_hit_tokens ?? event.usage.prompt_tokens_details?.cached_tokens;
	return {
		input: event.usage.prompt_tokens ?? 0,
		output: event.usage.completion_tokens ?? 0,
		...(typeof cached === 'number' ? { cached } : {}),
	};
}

/** The wire's finish reasons onto the protocol-neutral set. */
export function mapFinish(reason: string | null | undefined, hasToolCalls: boolean): FinishReason {
	if (reason === 'stop' || reason === 'length' || reason === 'content_filter' || reason === 'tool_calls') {
		return reason;
	}
	if (reason === 'function_call') {
		return 'tool_calls';
	}
	return hasToolCalls ? 'tool_calls' : 'stop';
}

/** Seconds in a Retry-After header to milliseconds; anything unparsable is no hint. */
export function retryAfterMsOf(headers: Record<string, string>): number | undefined {
	const raw = headers['retry-after'];
	if (!raw) {
		return undefined;
	}
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
