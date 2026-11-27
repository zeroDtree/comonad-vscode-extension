// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The gemini protocol: Google's native `generateContent` over SSE. The chat endpoint
 * carries the model in its path (`/models/{model}:streamGenerateContent`), so the
 * request URL is composed per call and locked to the provider origin like every other.
 * Thought signatures travel natively on `functionCall` parts — no bypass, no compat
 * layer: what the model sends comes back verbatim on the next request.
 */
import type { ProtocolDefinition, ProtocolImpl, ResolvedProvider } from '../../config/schema';
import { ModelError, classifyHttpRefusal, modelHttpError, toTransportError } from '../../errors';
import { chatRequest, modelsRequest } from '../../runtime/request';
import { resolveSameOrigin } from '../../transport/security';
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
import { GEMINI_OPTIONS, chatBody, mapFinish, usageOf, type GeminiStreamEvent } from './wire';

export { toGeminiContents, toGeminiTools, signatureOf } from './messages';
export { GEMINI_OPTIONS, chatBody, mapFinish, usageOf } from './wire';
export type { GeminiStreamEvent } from './wire';

export const geminiProtocol: ProtocolDefinition = {
	apiVersion: 1,
	id: 'gemini',
	defaults: {
		// The model is a path segment; `{model}` expands per call, origin-locked to the base.
		chatPath: '/models/{model}:streamGenerateContent?alt=sse',
		modelsPath: '/models',
		headers: { 'content-type': 'application/json' },
		auth: { kind: 'header', name: 'x-goog-api-key' },
		optionsSchema: GEMINI_OPTIONS,
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
	const calls: ToolCall[] = [];
	let content = '';
	let reasoning = '';
	let usage: UsageRecord | undefined;
	let finishReason: string | null | undefined;

	// The path template carries the `models/` segment; the id substitutes bare.
	const bare = request.model.startsWith('models/') ? request.model.slice('models/'.length) : request.model;
	const encoded = bare.split('/').map(encodeURIComponent).join('/');
	const url = resolveSameOrigin(provider.baseURL, provider.chatPath.replace('{model}', encoded));
	const body = chatBody(request);
	const response = await transport.send(chatRequest(provider, request.ctx, body, url));
	if (response.status < 200 || response.status >= 300) {
		const detail = await response.text();
		throw modelHttpError(response.status, trim(detail, 400), {
			retryAfterMs: retryAfterMsOf(response.headers),
			providerRequestId: response.headers['x-goog-request-id'],
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
			let event: GeminiStreamEvent;
			try {
				event = JSON.parse(sse.data) as GeminiStreamEvent;
			} catch {
				continue;
			}
			const recorded = usageOf(event);
			if (recorded) {
				usage = recorded;
				emit({ type: 'usage', usage: recorded });
			}
			const candidate = event.candidates?.[0];
			if (!candidate) {
				continue;
			}
			if (candidate.finishReason) {
				finishReason = candidate.finishReason;
			}
			for (const part of candidate.content?.parts ?? []) {
				if (part.functionCall) {
					// The wire's calls arrive whole; the id is ours to mint.
					const call: ToolCall = {
						id: `call_${calls.length}`,
						name: part.functionCall.name,
						arguments: JSON.stringify(part.functionCall.args ?? {}),
					};
					if (part.functionCall.thoughtSignature) {
						call.extraContent = { google: { thought_signature: part.functionCall.thoughtSignature } };
					}
					calls.push(call);
					emit({ type: 'tool-call', call: { id: call.id, name: call.name, arguments: call.arguments } });
				} else if (part.thought && part.text) {
					reasoning += part.text;
					emit({ type: 'reasoning', text: part.text });
				} else if (part.text) {
					content += part.text;
					emit({ type: 'text', text: part.text });
				}
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

/** The model ids the endpoint offers (`GET modelsPath`): `{models:[{name:'models/…'}]}`. */
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
	const rows = Array.isArray(body) ? body : ((body as { models?: unknown }).models ?? []);
	const ids = (Array.isArray(rows) ? rows : [])
		.map((row) => String((row as { name?: unknown })?.name ?? ''))
		.map((id) => id.trim())
		.filter(Boolean);
	// Reported ids keep their native `models/` prefix; the catalog's modelRules shape them.
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
