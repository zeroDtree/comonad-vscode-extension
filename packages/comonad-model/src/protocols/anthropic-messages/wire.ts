// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The anthropic-messages wire: request body shape, the SSE event shape, and their
 * mapping onto the protocol-neutral events. Two wire facts live here: `max_tokens` is
 * mandatory, and usage arrives in pieces — the input half on `message_start`, the output
 * half on `message_delta` — with cache reads and cache writes as their own fields.
 */
import type { OptionSchema, OptionValues, ResolvedProvider } from '../../config/schema';
import type { FinishReason, Message, ToolDeclaration, UsageRecord } from '../../types';
import { toAnthropicMessages, toAnthropicTools } from './messages';

/** What this wire calls its knobs. */
export const ANTHROPIC_MESSAGES_OPTIONS: OptionSchema = {
	maxTokens: { type: 'number' },
	reasoningEffort: { type: 'string', enum: ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] },
	// A host knob, not a wire one: the ceiling the effort picker may ask for.
	topEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
	extraBody: { type: 'object' },
};

/** The Messages API request body for one chat call. */
export function chatBody(
	_resolved: ResolvedProvider,
	request: { model: string; messages: readonly Message[]; tools: readonly ToolDeclaration[]; options: OptionValues },
): Record<string, unknown> {
	const options = request.options;
	const { system, messages } = toAnthropicMessages(request.messages);
	const body: Record<string, unknown> = {
		model: request.model,
		// The wire refuses a request without a hard output cap.
		max_tokens: typeof options.maxTokens === 'number' ? options.maxTokens : 64_000,
		messages,
		stream: true,
	};
	if (system) {
		body.system = system;
	}
	if (request.tools.length) {
		body.tools = toAnthropicTools(request.tools);
	}
	const effort = typeof options.reasoningEffort === 'string' ? options.reasoningEffort : undefined;
	if (effort && effort !== 'auto') {
		// `none` is not a depth on this wire — thinking runs regardless; the floor stands in.
		body.output_config = { effort: effort === 'none' ? 'low' : effort };
	}
	const extra = options.extraBody;
	if (extra && typeof extra === 'object') {
		Object.assign(body, extra);
	}
	return body;
}

/** One streamed event, before interpretation. */
export interface AnthropicStreamEvent {
	type?: string;
	message?: {
		usage?: {
			input_tokens?: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		};
	};
	content_block?: {
		type?: string;
		id?: string;
		name?: string;
	};
	index?: number;
	delta?: {
		type?: string;
		text?: string;
		thinking?: string;
		partial_json?: string;
		stop_reason?: string | null;
	};
	usage?: {
		output_tokens?: number;
	};
	error?: { type?: string; message?: string };
}

/**
 * The usage a stream reports, folded into one record. `input_tokens` is the uncached
 * input: cache reads and cache writes are billed apart, and our UsageRecord wants the
 * whole prompt as `input`, a superset of the two cache fields.
 */
export function foldUsage(
	start: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined,
	output: number | undefined,
): UsageRecord | undefined {
	if (!start && output === undefined) {
		return undefined;
	}
	const cached = start?.cache_read_input_tokens;
	const cacheWrite = start?.cache_creation_input_tokens;
	const fresh = start?.input_tokens ?? 0;
	return {
		input: fresh + (cached ?? 0) + (cacheWrite ?? 0),
		output: output ?? 0,
		...(cached !== undefined ? { cached } : {}),
		...(cacheWrite !== undefined ? { cacheWrite } : {}),
	};
}

/** The wire's stop reasons onto the protocol-neutral set. */
export function mapFinish(reason: string | null | undefined, hasToolCalls: boolean): FinishReason {
	switch (reason) {
		case 'max_tokens':
			return 'length';
		case 'tool_use':
			return 'tool_calls';
		case 'refusal':
			return 'content_filter';
		case 'end_turn':
		case 'stop_sequence':
		case 'pause_turn':
			return 'stop';
		default:
			return hasToolCalls ? 'tool_calls' : 'stop';
	}
}
