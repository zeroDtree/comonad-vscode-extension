import type { CompletionUsage, Message, ToolCall, ToolSpec } from './types';

/** OpenAI-compatible chat completions over SSE, with tool-call delta assembly. Pure module. */

export interface OpenAiRequest {
	base: string;
	key: string;
	/** Environment variable(s) the key would come from, named in the error when none is set. */
	keyEnv?: string | string[];
	model: string;
	messages: Message[];
	tools: ToolSpec[];
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	/** The three knobs a preset may set that a chat-completions endpoint understands. */
	frequencyPenalty?: number;
	presencePenalty?: number;
	seed?: number;
	logitBias?: Record<string, number>;
	/** Thinking effort for models that support `reasoning_effort`. */
	reasoningEffort?: string;	/** How this endpoint turns thinking off, for the `none` effort: DeepSeek's `thinking` field, or `reasoning_effort: "none"`. */
	thinkingOff?: 'thinking' | 'effort';	includeUsage?: boolean;
	responseFormat?: unknown;
	signal: AbortSignal;
	onToken?(text: string): void;
	onReasoning?(text: string): void;
	onToolDelta?(call: ToolCall): void;
}

export interface Completion {
	message: Message;
	toolCalls: ToolCall[];
	usage?: CompletionUsage;
}

export async function openAiChat(request: OpenAiRequest): Promise<Completion> {
	if (!request.base.trim()) {
		throw new Error('no API base URL configured; run "Comonad: Configure Model"');
	}
	if (!request.key.trim()) {
		const names = !request.keyEnv ? [] : Array.isArray(request.keyEnv) ? request.keyEnv : [request.keyEnv];
		throw new Error(
			names.length
				? `no API key — set ${names.join(' or ')} in the environment, or run "Comonad: Configure Model Provider"`
				: 'no API key configured; run "Comonad: Configure Model Provider"',
		);
	}
	const toolCalls = new Map<number, ToolCall>();
	const slots = new ToolSlots();
	let content = '';
	let reasoning = '';
	let usage: CompletionUsage | undefined;

	const body: Record<string, unknown> = {
		model: request.model,
		messages: request.messages.map(toOpenAi),
		stream: true,
	};
	if (request.temperature !== undefined) {
		body.temperature = request.temperature;
	}
	if (request.topP !== undefined) {
		body.top_p = request.topP;
	}
	if (request.frequencyPenalty !== undefined) {
		body.frequency_penalty = request.frequencyPenalty;
	}
	if (request.presencePenalty !== undefined) {
		body.presence_penalty = request.presencePenalty;
	}
	if (request.seed !== undefined) {
		body.seed = request.seed;
	}
	if (request.logitBias !== undefined) {
		body.logit_bias = request.logitBias;
	}
	if (request.maxTokens !== undefined) {
		body.max_tokens = request.maxTokens;
	}
	if (request.reasoningEffort && request.reasoningEffort !== 'auto') {
		// DeepSeek enables thinking by default and only its own field turns it off; Gemini takes
		// `reasoning_effort: "none"`. Providers that declare neither keep the provider default.
		if (request.reasoningEffort === 'none' && request.thinkingOff === 'thinking') {
			body.thinking = { type: 'disabled' };
		} else if (!(request.reasoningEffort === 'none' && !request.thinkingOff)) {
			body.reasoning_effort = request.reasoningEffort;
		}
	}
	if (request.tools.length) {
		body.tools = request.tools.map((tool) => ({
			type: 'function',
			function: { name: tool.name, description: tool.description, parameters: tool.parameters },
		}));
	}
	if (request.responseFormat) {
		body.response_format = request.responseFormat;
	}
	if (request.includeUsage) {
		body.stream_options = { include_usage: true };
	}

	let response: Response;
	try {
		response = await fetch(`${request.base.replace(/\/+$/, '')}/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${request.key}` },
			body: JSON.stringify(body),
			signal: request.signal,
		});
	} catch (error) {
		if (request.signal.aborted) {
			return aborted();
		}
		throw error;
	}
	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		throw new Error(`model request failed (${response.status}): ${trim(detail, 400)}`);
	}
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error('model response had no body');
	}
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (!request.signal.aborted) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith('data:')) {
					continue;
				}
				const data = trimmed.slice(5).trim();
				if (!data || data === '[DONE]') {
					continue;
				}
				let event: StreamEvent;
				try {
					event = JSON.parse(data) as StreamEvent;
				} catch {
					continue;
				}
				if (event.usage) {
					usage = {
						input: event.usage.prompt_tokens ?? 0,
						output: event.usage.completion_tokens ?? 0,
						cached: event.usage.prompt_cache_hit_tokens ?? 0,
					};
				}
				const delta = event.choices?.[0]?.delta;
				if (!delta) {
					continue;
				}
				const calls = delta.tool_calls ?? [];
				if (calls.length === 0) {
					if (delta.reasoning_content) {
						reasoning += delta.reasoning_content;
						request.onReasoning?.(delta.reasoning_content);
					}
					if (delta.content) {
						content += delta.content;
						request.onToken?.(delta.content);
					}
					continue;
				}
				if (delta.content) {
					content += delta.content;
					request.onToken?.(delta.content);
				}
				if (delta.reasoning_content) {
					reasoning += delta.reasoning_content;
					request.onReasoning?.(delta.reasoning_content);
				}
				for (const [offset, call] of calls.entries()) {
					const slot = slots.resolve({ index: call.index ?? offset, id: call.id });
					const current = toolCalls.get(slot.emitIndex) ?? { id: '', name: '', arguments: '' };
					if (slot.id) {
						current.id = slot.id;
					}
					current.name += call.function?.name ?? '';
					current.arguments += call.function?.arguments ?? '';
					toolCalls.set(slot.emitIndex, current);
					if (call.function?.name || call.function?.arguments) {
						request.onToolDelta?.({
							id: slot.id || current.id,
							name: current.name,
							arguments: current.arguments,
						});
					}
				}
			}
		}
	} catch (error) {
		if (!request.signal.aborted) {
			throw error;
		}
	} finally {
		reader.releaseLock();
	}
	if (request.signal.aborted) {
		return aborted();
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
	return { message, toolCalls: calls, usage };
}

function aborted(): Completion {
	return { message: { role: 'assistant', content: '' }, toolCalls: [] };
}

/**
 * The model ids an OpenAI-compatible endpoint offers (`GET /models`). Providers disagree on the
 * shape — OpenAI and Gemini wrap the list in `data`, some return a bare array — so both are read.
 */
export async function listEndpointModels(request: { base: string; key: string; signal: AbortSignal }): Promise<string[]> {
	const base = request.base.trim();
	if (!base) {
		return [];
	}
	const response = await fetch(`${base.replace(/\/+$/, '')}/models`, {
		method: 'GET',
		headers: request.key ? { authorization: `Bearer ${request.key}` } : {},
		signal: request.signal,
	});
	if (!response.ok) {
		throw new Error(`model list failed (${response.status}): ${trim(await response.text().catch(() => ''), 200)}`);
	}
	const body = (await response.json()) as unknown;
	const rows = Array.isArray(body) ? body : ((body as { data?: unknown }).data ?? []);
	const ids = (Array.isArray(rows) ? rows : [])
		.map((row) => (typeof row === 'string' ? row : String((row as { id?: unknown })?.id ?? '')))
		.map((id) => id.trim())
		.filter(Boolean);
	return [...new Set(ids)].sort();
}

function toOpenAi(message: Message): Record<string, unknown> {
	if (message.role === 'tool') {
		return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
	}
	if (message.role === 'assistant') {
		// `reasoning_content` must come back whenever the request carries tools — DeepSeek answers a
		// 400 otherwise — and is ignored by endpoints that do not know the field.
		const body: Record<string, unknown> = { role: 'assistant', content: message.content || null };
		if (message.reasoning) {
			body.reasoning_content = message.reasoning;
		}
		if (message.toolCalls?.length) {
			body.tool_calls = message.toolCalls.map((call) => ({
				id: call.id,
				type: 'function',
				function: { name: call.name, arguments: call.arguments },
			}));
		}
		return body;
	}
	return { role: message.role, content: message.content };
}

interface StreamEvent {
	choices?: {
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
		};
	}[];
	usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } | null;
}

/** Maps OpenAI's per-index tool-call deltas onto stable call ids. */
export class ToolSlots {
	private next = 0;
	private readonly byId = new Map<string, number>();
	private readonly byWire = new Map<number, { id: string; emitIndex: number }>();

	resolve(call: { index: number; id?: string }): { emitIndex: number; id: string } {
		if (call.id && this.byId.has(call.id)) {
			return { emitIndex: this.byId.get(call.id) ?? 0, id: call.id };
		}
		const wire = this.byWire.get(call.index);
		if (call.id && wire?.id && wire.id !== call.id) {
			const emitIndex = this.next++;
			this.byId.set(call.id, emitIndex);
			this.byWire.set(call.index, { id: call.id, emitIndex });
			return { emitIndex, id: call.id };
		}
		if (wire) {
			if (call.id && !wire.id) {
				wire.id = call.id;
				this.byId.set(call.id, wire.emitIndex);
			}
			return { emitIndex: wire.emitIndex, id: wire.id };
		}
		const emitIndex = this.next++;
		const id = call.id ?? '';
		if (id) {
			this.byId.set(id, emitIndex);
		}
		this.byWire.set(call.index, { id, emitIndex });
		return { emitIndex, id };
	}
}

function trim(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
