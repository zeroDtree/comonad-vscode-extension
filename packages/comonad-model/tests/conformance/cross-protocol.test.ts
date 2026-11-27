// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { ModelRuntime } from '../../src/runtime/runtime';
import { anthropicMessagesProtocol } from '../../src/protocols/anthropic-messages';
import { geminiProtocol } from '../../src/protocols/gemini';
import { openaiChatProtocol } from '../../src/protocols/openai-chat';
import { anthropicBrand } from '../../src/brands/anthropic';
import { googleBrand } from '../../src/brands/google';
import { ReplayTransport, type FixtureEnvelope } from '../../src/replay/replay-transport';
import { makeFakeInstance } from '../../src/testing';
import type { BrandDefinition, ProviderInstanceConfig, ProtocolDefinition } from '../../src/config/schema';
import type { InvocationContext, RuntimeStreamEvent, UsageRecord } from '../../src/types';

/**
 * The cross-protocol matrix: one semantic scenario — a streamed answer, one tool call,
 * cache-split usage — through every wire, asserting the same event sequence where the
 * wires' granularity matches. Streaming granularity itself (per-delta vs whole calls)
 * is normalized away: what must be identical is the semantic unit sequence.
 */

interface Scenario {
	protocol: ProtocolDefinition;
	brand: BrandDefinition;
	instance: ProviderInstanceConfig;
	fixture: FixtureEnvelope;
}

function ctxOf(): InvocationContext {
	return { conversationId: 's1', turnId: 's1:1', requestId: `r-${Math.random().toString(36).slice(2)}`, signal: new AbortController().signal };
}

interface Normalized {
	text: string;
	reasoning: string;
	tools: { name: string; arguments: string }[];
	usage?: { input: number; output: number; cached: number; cacheWrite: number };
	finish?: string;
}

function normalize(events: RuntimeStreamEvent[]): Normalized {
	const out: Normalized = { text: '', reasoning: '', tools: [] };
	for (const event of events) {
		if (event.type === 'text') {
			out.text += event.text;
		} else if (event.type === 'reasoning') {
			out.reasoning += event.text;
		} else if (event.type === 'tool-call') {
			const existing = out.tools.find((tool) => tool.name === event.call.name);
			if (existing) {
				existing.arguments = event.call.arguments;
			} else {
				out.tools.push({ name: event.call.name, arguments: event.call.arguments });
			}
		} else if (event.type === 'usage') {
			out.usage = usageOf(event.usage);
		} else if (event.type === 'finish') {
			out.finish = event.reason;
		}
	}
	return out;
}

function usageOf(usage: UsageRecord): Normalized['usage'] {
	return {
		input: usage.input,
		output: usage.output,
		cached: usage.cached ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
	};
}

const SCENARIOS: Scenario[] = [
	{
		protocol: openaiChatProtocol,
		brand: {
			apiVersion: 1,
			id: 'matrix-openai',
			protocol: 'openai-chat',
			defaults: { baseURL: 'https://x.test' },
		},
		instance: makeFakeInstance({ id: 'one', brand: 'matrix-openai', base: 'https://x.test', model: 'm' }),
		fixture: {
			name: 'openai-shape',
			sse: [
				'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"there"}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_cache_hit_tokens":2}}\n\n',
				'data: [DONE]\n\n',
			],
		},
	},
	{
		protocol: anthropicMessagesProtocol,
		brand: anthropicBrand,
		instance: makeFakeInstance({ id: 'two', brand: 'anthropic', base: 'https://api.anthropic.com', model: 'm' }),
		fixture: {
			name: 'anthropic-shape',
			sse: [
				'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":8,"cache_read_input_tokens":2,"cache_creation_input_tokens":0}}}\n\n',
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\n',
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n\n',
				'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"read_file"}}\n\n',
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
				'event: message_stop\ndata: {"type":"message_stop"}\n\n',
			],
		},
	},
	{
		protocol: geminiProtocol,
		brand: googleBrand,
		instance: makeFakeInstance({ id: 'three', brand: 'google', base: 'https://generativelanguage.googleapis.com/v1beta', model: 'm' }),
		fixture: {
			name: 'gemini-shape',
			sse: [
				'data: {"candidates":[{"content":{"parts":[{"text":"Hi "},{"text":"there"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"cachedContentTokenCount":2}}\n\n',
				'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.ts"}}}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"cachedContentTokenCount":2}}\n\n',
			],
		},
	},
];

suite('cross-protocol matrix', () => {
	test('the same scenario yields the same event sequence on every wire', async () => {
		const normalized: Normalized[] = [];
		for (const scenario of SCENARIOS) {
			const transport = new ReplayTransport([scenario.fixture]);
			const runtime = new ModelRuntime({
				transport,
				keys: { keyFor: async () => 'k', env: () => undefined },
				instances: () => [scenario.instance],
			});
			runtime.registerProtocol(scenario.protocol);
			runtime.registerBrand(scenario.brand);
			const events: RuntimeStreamEvent[] = [];
			const result = await runtime.stream({
				model: scenario.instance.id,
				messages: [{ role: 'user', content: 'read a.ts' }],
				tools: [],
				ctx: ctxOf(),
				onEvent: (event) => events.push(event),
			});
			assert.strictEqual(result.toolCalls.length, 1, scenario.fixture.name);
			normalized.push(normalize(events));
		}
		const [first, ...rest] = normalized;
		for (const other of rest) {
			assert.deepStrictEqual(other, first);
		}
		// And the common sequence is exactly the scenario the fixtures encode.
		assert.deepStrictEqual(first, {
			text: 'Hi there',
			reasoning: '',
			tools: [{ name: 'read_file', arguments: '{"path":"a.ts"}' }],
			usage: { input: 10, output: 5, cached: 2, cacheWrite: 0 },
			finish: 'tool_calls',
		});
	});
});
