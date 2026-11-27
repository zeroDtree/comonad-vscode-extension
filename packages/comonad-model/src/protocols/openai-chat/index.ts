// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The openai-chat protocol: OpenAI-compatible Chat Completions over SSE, with tool-call
 * delta assembly. One implementation serves every brand that speaks this wire — DeepSeek,
 * OpenCode Go, Google's compatible layer, OpenAI itself — and knows nothing about any
 * of them: quirks are brand data and hooks.
 */
import type { ProtocolDefinition, ProtocolImpl, ResolvedProvider } from '../../config/schema';
import { ModelError, classifyHttpRefusal, modelHttpError, toTransportError } from '../../errors';
import { chatRequest, modelsRequest } from '../../runtime/request';
import type { Transport } from '../../transport/transport';
import type {
	FinishReason,
	InvocationContext,
	Message,
	ProviderStreamEvent,
	ToolCall,
	ToolDeclaration,
	UsageRecord,
} from '../../types';
import { ToolSlots } from './messages';
import { OPENAI_CHAT_OPTIONS, chatBody, mapFinish, retryAfterMsOf, usageOf, type OpenAiStreamEvent } from './wire';

export { ToolSlots, toOpenAiMessages } from './messages';
export { OPENAI_CHAT_OPTIONS, chatBody, mapFinish, retryAfterMsOf, usageOf } from './wire';
export type { OpenAiStreamEvent } from './wire';

export const openaiChatProtocol: ProtocolDefinition = {
	apiVersion: 1,
	id: 'openai-chat',
	defaults: {
		chatPath: '/chat/completions',
		modelsPath: '/models',
		headers: { 'content-type': 'application/json' },
		auth: { kind: 'bearer' },
		optionsSchema: OPENAI_CHAT_OPTIONS,
	},
	create(transport: Transport, provider: ResolvedProvider): ProtocolImpl {
		return {
			chat: (request, emit) => runChat(transport, provider, request, emit),
			listModels: (ctx) => runListModels(transport, provider, ctx),
		};
	},
};

interface ChatCall {
	model: string;
	messages: Message[];
	tools: ToolDeclaration[];
	options: Record<string, unknown>;
	ctx: InvocationContext;
}

/** One streamed chat: content events as they arrive, the assembled answer at the end. */
async function runChat(
	transport: Transport,
	provider: ResolvedProvider,
	request: ChatCall,
	emit: (event: ProviderStreamEvent) => void,
): Promise<{ message: Message; toolCalls: ToolCall[]; usage?: UsageRecord; finish: FinishReason }> {
	if (!provider.key) {
		const names = provider.keyEnvNames;
		throw new ModelError(
			'auth',
			names.length
				? `no API key — set ${names.join(' or ')} in the environment, or run "Comonad: Configure Model Provider"`
				: 'no API key configured; run "Comonad: Configure Model Provider"',
		);
	}
	const toolCalls = new Map<number, ToolCall>();
	const slots = new ToolSlots();
	let content = '';
	let reasoning = '';
	let usage: UsageRecord | undefined;
	let finishReason: string | undefined;

	const body = chatBody(provider, {
		model: request.model,
		messages: request.messages,
		tools: request.tools,
		options: request.options,
	});
	const response = await transport.send(chatRequest(provider, request.ctx, body));
	if (response.status < 200 || response.status >= 300) {
		const detail = await response.text();
		throw modelHttpError(response.status, trim(detail, 400), {
			retryAfterMs: retryAfterMsOf(response.headers),
			providerRequestId: response.headers['x-request-id'],
		});
	}

	try {
		for await (const sse of response.sse()) {
			if (request.ctx.signal.aborted) {
				break;
			}
			if (!sse.data || sse.data === '[DONE]') {
				continue;
			}
			let event: OpenAiStreamEvent;
			try {
				event = JSON.parse(sse.data) as OpenAiStreamEvent;
			} catch {
				continue;
			}
			const recorded = usageOf(event);
			if (recorded) {
				// Only a reported number (including zero) may reach the accumulator.
				usage = recorded;
				emit({ type: 'usage', usage: recorded });
			}
			if (event.choices?.[0]?.finish_reason) {
				finishReason = event.choices[0].finish_reason;
			}
			const delta = event.choices?.[0]?.delta;
			if (!delta) {
				continue;
			}
			const calls = delta.tool_calls ?? [];
			if (calls.length === 0) {
				if (delta.reasoning_content) {
					reasoning += delta.reasoning_content;
					emit({ type: 'reasoning', text: delta.reasoning_content });
				}
				if (delta.content) {
					content += delta.content;
					emit({ type: 'text', text: delta.content });
				}
				continue;
			}
			if (delta.content) {
				content += delta.content;
				emit({ type: 'text', text: delta.content });
			}
			if (delta.reasoning_content) {
				reasoning += delta.reasoning_content;
				emit({ type: 'reasoning', text: delta.reasoning_content });
			}
			for (const [offset, call] of calls.entries()) {
				const slot = slots.resolve({ index: call.index ?? offset, id: call.id });
				const current = toolCalls.get(slot.emitIndex) ?? { id: '', name: '', arguments: '' };
				if (slot.id) {
					current.id = slot.id;
				}
				current.name += call.function?.name ?? '';
				current.arguments += call.function?.arguments ?? '';
				// A thinking model's signature arrives with the call — usually in an earlier chunk than
				// its name — and is kept exactly as it came so the next request can hand it back.
				if (!current.extraContent && call.extra_content) {
					current.extraContent = call.extra_content;
				}
				toolCalls.set(slot.emitIndex, current);
				if (call.function?.name || call.function?.arguments) {
					emit({
						type: 'tool-call',
						call: { id: slot.id || current.id, name: current.name, arguments: current.arguments },
					});
				}
			}
		}
	} catch (error) {
		if (!request.ctx.signal.aborted) {
			throw toTransportError(error);
		}
	}

	if (request.ctx.signal.aborted) {
		// Stop keeps what the reader already saw: the text survives as a partial, tool-call
		// fragments do not.
		emit({ type: 'finish', reason: 'aborted' });
		return {
			message: { role: 'assistant', content, reasoning: reasoning || undefined },
			toolCalls: [],
			finish: 'aborted',
		};
	}

	const calls = [...toolCalls.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, call], index) => ({ ...call, id: call.id || `call_${index}` }));
	const message: Message = {
		role: 'assistant',
		content,
		reasoning: reasoning || undefined,
		toolCalls: calls.length ? calls : undefined,
	};
	const finish = mapFinish(finishReason, calls.length > 0);
	emit({ type: 'finish', reason: finish });
	return { message, toolCalls: calls, usage, finish };
}

/**
 * The model ids the endpoint offers (`GET modelsPath`). Providers disagree on the shape —
 * OpenAI and Gemini wrap the list in `data`, some return a bare array — so both are read.
 */
async function runListModels(
	transport: Transport,
	provider: ResolvedProvider,
	ctx: InvocationContext,
): Promise<string[]> {
	const response = await transport.send(modelsRequest(provider, ctx));
	if (response.status < 200 || response.status >= 300) {
		const detail = await response.text();
		throw new ModelError(
			classifyHttpRefusal(response.status, detail),
			`model list failed (${response.status}): ${trim(detail, 200)}`,
			{ status: response.status, detail },
		);
	}
	const body = (await response.json()) as unknown;
	const rows = Array.isArray(body) ? body : ((body as { data?: unknown }).data ?? []);
	const ids = (Array.isArray(rows) ? rows : [])
		.map((row) => (typeof row === 'string' ? row : String((row as { id?: unknown })?.id ?? '')))
		.map((id) => id.trim())
		.filter(Boolean);
	return [...new Set(ids)].sort();
}

function trim(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
