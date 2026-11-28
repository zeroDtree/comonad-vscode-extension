// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { ModelRuntime } from '../../src/runtime/runtime';
import { anthropicMessagesProtocol, toAnthropicMessages, toAnthropicTools } from '../../src/protocols/anthropic-messages';
import { foldUsage } from '../../src/protocols/anthropic-messages/wire';
import { ReplayTransport, type FixtureEnvelope } from '../../src/replay/replay-transport';
import { makeFakeEntry } from '../../src/testing';
import { anthropicProvider } from '../../src/providers/anthropic';
import { ModelError } from '../../src/errors';
import type { Transport } from '../../src/transport/transport';
import type { InvocationContext, RuntimeStreamEvent } from '../../src/types';
import claudeToolUsage from '../fixtures/anthropic-messages/claude-tool-usage.json';

/** anthropic-messages conformance: the ProviderStreamEvent sequence this wire must produce. */

function ctxOf(signal = new AbortController().signal): InvocationContext {
	return { conversationId: 's1', turnId: 's1:1', requestId: `r-${Math.random().toString(36).slice(2)}`, signal };
}

function setup(envelopes: FixtureEnvelope[]) {
	const transport = new ReplayTransport(envelopes);
	const runtime = new ModelRuntime({
		transport,
		keys: { keyFor: async () => 'sk-ant-test', env: () => undefined },
		entries: () => [makeFakeEntry({ id: 'claude', provider: 'anthropic', base: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' })],
	});
	runtime.registerProtocol(anthropicMessagesProtocol);
	runtime.registerDefinition(anthropicProvider);
	return { runtime, transport };
}

function chatOf(runtime: ModelRuntime, ctx: InvocationContext, events: RuntimeStreamEvent[]) {
	return runtime.stream({
		model: 'claude:claude-sonnet-5-5',
		messages: [{ role: 'user', content: 'read a.ts' }],
		tools: [],
		ctx,
		onEvent: (event) => events.push(event),
	});
}

suite('anthropic-messages conformance', () => {
	test('text and tool pieces assemble; cache usage folds into one record', async () => {
		const { runtime } = setup([claudeToolUsage]);
		const events: RuntimeStreamEvent[] = [];
		const result = await chatOf(runtime, ctxOf(), events);
		assert.deepStrictEqual(events, [
			{ type: 'text', text: 'Hi ' },
			{ type: 'text', text: 'there' },
			{ type: 'tool-call', call: { id: 'call_1', name: 'read_file', arguments: '' } },
			{ type: 'tool-call', call: { id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' } },
			// input 8 fresh + 2 cache read = the whole 10-token prompt
			{ type: 'usage', usage: { input: 10, output: 5, cached: 2, cacheWrite: 0 } },
			{ type: 'finish', reason: 'tool_calls' },
		]);
		assert.strictEqual(result.message.content, 'Hi there');
		assert.deepStrictEqual(result.toolCalls, [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }]);
		assert.strictEqual(result.finish, 'tool_calls');
	});

	test('the request carries the version header, the x-api-key scheme and a mandatory cap', async () => {
		const { runtime, transport } = setup([claudeToolUsage]);
		await runtime.stream({
			model: 'claude:claude-sonnet-5-5',
			messages: [{ role: 'user', content: 'hi' }],
			tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
			ctx: ctxOf(),
		});
		const request = transport.requests[0];
		assert.strictEqual(request?.url, 'https://api.anthropic.com/v1/messages');
		assert.strictEqual(request?.headers['x-api-key'], 'sk-ant-test');
		assert.strictEqual(request?.headers['anthropic-version'], '2023-06-01');
		const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
		assert.strictEqual(typeof body.max_tokens, 'number', 'the wire refuses a request without a cap');
		assert.deepStrictEqual((body.tools as { input_schema?: unknown }[])[0]?.input_schema, { type: 'object', properties: {} });
	});

	test('a refusal maps to content_filter; a bad key to auth', async () => {
		const { runtime } = setup([
			{ name: 'refusal', meta: { status: 200 }, sse: [
				'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":1}}\n\n',
				'event: message_stop\ndata: {"type":"message_stop"}\n\n',
			] },
		]);
		const result = await chatOf(runtime, ctxOf(), []);
		assert.strictEqual(result.finish, 'content_filter');

		const denied = setup([{ name: 'denied', meta: { status: 401 }, body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' }]);
		await assert.rejects(chatOf(denied.runtime, ctxOf(), []), (error: unknown) => {
			assert.ok(error instanceof ModelError);
			assert.strictEqual(error.code, 'auth');
			return true;
		});
	});

	test('an abort keeps the streamed text and finishes aborted', async () => {
		const controller = new AbortController();
		const transport: Transport = {
			async send() {
				return {
					status: 200,
					headers: {},
					text: async () => '',
					json: async () => undefined,
					sse: async function* () {
						yield { event: 'message_start', data: '{"type":"message_start","message":{"usage":{"input_tokens":3}}}' };
						yield { event: 'content_block_delta', data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"kept"}}' };
						controller.abort();
						yield { event: 'message_stop', data: '{"type":"message_stop"}' };
					},
				};
			},
		};
		const runtime = new ModelRuntime({
			transport,
			keys: { keyFor: async () => 'sk-ant-test', env: () => undefined },
			entries: () => [makeFakeEntry({ id: 'claude', provider: 'anthropic', base: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' })],
		});
		runtime.registerProtocol(anthropicMessagesProtocol);
		runtime.registerDefinition(anthropicProvider);
		const result = await chatOf(runtime, ctxOf(controller.signal), []);
		assert.strictEqual(result.finish, 'aborted');
		assert.strictEqual(result.message.content, 'kept');
	});

	test('foldUsage counts the whole prompt exactly once', () => {
		assert.deepStrictEqual(foldUsage({ input_tokens: 8, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }, 5), {
			input: 13,
			output: 5,
			cached: 2,
			cacheWrite: 3,
		});
		assert.deepStrictEqual(foldUsage(undefined, 5), { input: 0, output: 5 });
		assert.strictEqual(foldUsage(undefined, undefined), undefined);
	});

	test('tool results pair into one user turn; images ride the result', () => {
		const { system, messages } = toAnthropicMessages([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', arguments: '{"a":1}' }] },
			{ role: 'tool', toolCallId: 'c1', content: 'r1' },
			{ role: 'tool', toolCallId: 'c2', content: 'r2' },
		]);
		assert.strictEqual(system, 'sys');
		assert.deepStrictEqual(messages[1]?.content, [
			{ type: 'tool_use', id: 'c1', name: 't', input: { a: 1 } },
		]);
		const results = messages[2]?.content as { type: string; tool_use_id: string }[];
		assert.strictEqual(results.length, 2, 'consecutive results merge into one user turn');
		assert.deepStrictEqual(results.map((block) => block.tool_use_id), ['c1', 'c2']);
		assert.deepStrictEqual(toAnthropicTools([{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }]), [
			{ name: 't', description: 'd', input_schema: { type: 'object', properties: {} } },
		]);
	});
});
