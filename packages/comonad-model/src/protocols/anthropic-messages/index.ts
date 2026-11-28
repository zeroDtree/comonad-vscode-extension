// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The anthropic-messages protocol: the Messages API over SSE. One implementation serves
 * every vendor that speaks it — Anthropic itself, and proxies that mirror the wire. Tool
 * calls assemble from `tool_use` + `input_json_delta` pieces; usage folds from the two
 * halves the stream carries.
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
import { toToolCall, type AnthropicCallPiece } from './messages';
import {
	ANTHROPIC_MESSAGES_OPTIONS,
	chatBody,
	foldUsage,
	mapFinish,
	type AnthropicStreamEvent,
} from './wire';

export { toAnthropicMessages, toAnthropicTools } from './messages';
export { ANTHROPIC_MESSAGES_OPTIONS, chatBody, foldUsage, mapFinish } from './wire';
export type { AnthropicStreamEvent } from './wire';

export const anthropicMessagesProtocol: ProtocolDefinition = {
	apiVersion: 1,
	id: 'anthropic-messages',
	defaults: {
		chatPath: '/v1/messages',
		modelsPath: '/v1/models',
		headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
		auth: { kind: 'header', name: 'x-api-key' },
		optionsSchema: ANTHROPIC_MESSAGES_OPTIONS,
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
	const pieces = new Map<number, AnthropicCallPiece>();
	let content = '';
	let reasoning = '';
	let usageStart: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
	let outputTokens: number | undefined;
	let stopReason: string | null | undefined;

	const body = chatBody(provider, request);
	const response = await transport.send(chatRequest(provider, request.ctx, body));
	if (response.status < 200 || response.status >= 300) {
		const detail = await response.text();
		throw modelHttpError(response.status, trim(detail, 400), {
			retryAfterMs: retryAfterMsOf(response.headers),
			providerRequestId: response.headers['request-id'],
		});
	}

	try {
		for await (const sse of response.sse()) {
			if (request.ctx.signal.aborted) {
				break;
			}
			if (!sse.data) {
				continue;
			}
			let event: AnthropicStreamEvent;
			try {
				event = JSON.parse(sse.data) as AnthropicStreamEvent;
			} catch {
				continue;
			}
			switch (event.type) {
				case 'message_start':
					usageStart = event.message?.usage;
					break;
				case 'content_block_start': {
					const block = event.content_block;
					if (block?.type === 'tool_use') {
						const index = event.index ?? pieces.size;
						pieces.set(index, { id: block.id ?? `call_${index}`, name: block.name ?? '', arguments: '' });
						emit({
							type: 'tool-call',
							call: { id: block.id ?? `call_${index}`, name: block.name ?? '', arguments: '' },
						});
					}
					break;
				}
				case 'content_block_delta': {
					const delta = event.delta;
					if (delta?.type === 'text_delta' && delta.text) {
						content += delta.text;
						emit({ type: 'text', text: delta.text });
					} else if (delta?.type === 'thinking_delta' && delta.thinking) {
						reasoning += delta.thinking;
						emit({ type: 'reasoning', text: delta.thinking });
					} else if (delta?.type === 'input_json_delta') {
						const index = event.index ?? 0;
						const piece = pieces.get(index) ?? { id: `call_${index}`, name: '', arguments: '' };
						piece.arguments += delta.partial_json ?? '';
						pieces.set(index, piece);
						emit({
							type: 'tool-call',
							call: { id: piece.id, name: piece.name, arguments: piece.arguments },
						});
					}
					break;
				}
				case 'message_delta':
					if (event.delta?.stop_reason !== undefined) {
						stopReason = event.delta.stop_reason;
					}
					if (event.usage?.output_tokens !== undefined) {
						outputTokens = event.usage.output_tokens;
					}
					break;
				case 'error':
					throw new ModelError('protocol', event.error?.message ?? 'model stream error', {
						detail: event.error?.type,
					});
				default:
					break;
			}
		}
	} catch (error) {
		if (!request.ctx.signal.aborted) {
			throw toTransportError(error);
		}
	}

	if (request.ctx.signal.aborted) {
		emit({ type: 'finish', reason: 'aborted' });
		return {
			message: { role: 'assistant', content, reasoning: reasoning || undefined },
			toolCalls: [],
			finish: 'aborted',
		};
	}

	const calls = [...pieces.entries()].sort(([left], [right]) => left - right).map(([, piece]) => toToolCall(piece));
	const usage = foldUsage(usageStart, outputTokens);
	if (usage) {
		emit({ type: 'usage', usage });
	}
	const message: Message = {
		role: 'assistant',
		content,
		reasoning: reasoning || undefined,
		toolCalls: calls.length ? calls : undefined,
	};
	const finish = mapFinish(stopReason, calls.length > 0);
	emit({ type: 'finish', reason: finish });
	return { message, toolCalls: calls, usage, finish };
}

/** The model ids the endpoint offers (`GET modelsPath`): `{data:[…]}` with id/display_name. */
async function runListModels(
	transport: Transport,
	provider: ResolvedProvider,
	ctx: InvocationContext,
): Promise<string[]> {
	const response = await transport.send(modelsRequest(provider, ctx));
	if (response.status < 200 || response.status >= 300) {
		const detail = await response.text();
		throw new ModelError(classifyHttpRefusal(response.status, detail), `model list failed (${response.status}): ${trim(detail, 200)}`, {
			status: response.status,
			detail,
		});
	}
	const body = (await response.json()) as unknown;
	const rows = Array.isArray(body) ? body : ((body as { data?: unknown }).data ?? []);
	const ids = (Array.isArray(rows) ? rows : [])
		.map((row) => String((row as { id?: unknown })?.id ?? ''))
		.map((id) => id.trim())
		.filter(Boolean);
	return [...new Set(ids)];
}

function retryAfterMsOf(headers: Record<string, string>): number | undefined {
	const raw = headers['retry-after'];
	if (!raw) {
		return undefined;
	}
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function trim(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
