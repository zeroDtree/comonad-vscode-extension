// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { ModelRuntime } from '../../src/runtime/runtime';
import { openaiChatProtocol, toOpenAiMessages } from '../../src/protocols/openai-chat';
import { ReplayTransport, type FixtureEnvelope } from '../../src/replay/replay-transport';
import { makeFakeInstance } from '../../src/testing';
import type { BrandDefinition } from '../../src/config/schema';
import { ModelError } from '../../src/errors';
import type { Transport, TransportRequest } from '../../src/transport/transport';
import type { InvocationContext, RuntimeStreamEvent } from '../../src/types';
import textUsage from '../fixtures/openai-chat/deepseek-text-usage.json';
import toolFragments from '../fixtures/openai-chat/deepseek-tool-fragments.json';
import googleSignature from '../fixtures/openai-chat/google-signature.json';

/**
 * openai-chat conformance: the ProviderStreamEvent sequence a consumer may rely on, and
 * the error codes, driven by recorded endpoint bytes through the real parser. Adding a
 * brand that speaks this wire means adding fixtures here, not new expectations there.
 */

const DEEPSEEK_BRAND: BrandDefinition = {
	apiVersion: 1,
	id: 'deepseek',
	protocol: 'openai-chat',
	defaults: {
		baseURL: 'https://api.deepseek.com',
		options: { thinkingOff: 'thinking', includeUsage: true },
	},
};

function ctxOf(signal = new AbortController().signal): InvocationContext {
	return { conversationId: 's1', turnId: 's1:1', requestId: `r-${Math.random().toString(36).slice(2)}`, signal };
}

function setup(envelopes: FixtureEnvelope[], brand: BrandDefinition = DEEPSEEK_BRAND) {
	const transport = new ReplayTransport(envelopes);
	const runtime = new ModelRuntime({
		transport,
		keys: { keyFor: async () => 'sk-test', env: () => undefined },
		instances: () => [makeFakeInstance({ id: 'deepseek', brand: brand.id, base: brand.defaults.baseURL ?? 'https://api.deepseek.com', model: 'deepseek-chat' })],
	});
	runtime.registerProtocol(openaiChatProtocol);
	runtime.registerBrand(brand);
	return { runtime, transport };
}

function chatOf(runtime: ModelRuntime, ctx: InvocationContext, events: RuntimeStreamEvent[]) {
	return runtime.stream({
		model: 'deepseek:deepseek-chat',
		messages: [{ role: 'user', content: 'hi' }],
		tools: [],
		ctx,
		onEvent: (event) => events.push(event),
	});
}

suite('openai-chat conformance', () => {
	test('text and reasoning stream in order; usage lands before finish', async () => {
		const { runtime } = setup([textUsage]);
		const events: RuntimeStreamEvent[] = [];
		const result = await chatOf(runtime, ctxOf(), events);
		assert.deepStrictEqual(events, [
			{ type: 'reasoning', text: 'thinking ' },
			{ type: 'reasoning', text: 'hard' },
			{ type: 'text', text: 'Hel' },
			{ type: 'text', text: 'lo' },
			{ type: 'usage', usage: { input: 100, output: 5, cached: 40 } },
			{ type: 'finish', reason: 'stop' },
		]);
		assert.strictEqual(result.message.content, 'Hello');
		assert.strictEqual(result.message.reasoning, 'thinking hard');
		assert.deepStrictEqual(result.usage, { input: 100, output: 5, cached: 40 });
		assert.strictEqual(result.finish, 'stop');
	});

	test('tool-call argument fragments assemble into one complete call', async () => {
		const { runtime } = setup([toolFragments]);
		const events: RuntimeStreamEvent[] = [];
		const result = await chatOf(runtime, ctxOf(), events);
		const deltas = events.filter((event) => event.type === 'tool-call');
		// Every delta carries the call's accumulated state, so a UI can render mid-stream.
		assert.deepStrictEqual(deltas[0], {
			type: 'tool-call',
			call: { id: 'call_abc', name: 'read_file', arguments: '' },
		});
		assert.strictEqual(deltas.length, 3);
		assert.deepStrictEqual(result.toolCalls, [
			{ id: 'call_abc', name: 'read_file', arguments: '{"path":"a.ts"}' },
		]);
		assert.strictEqual(result.finish, 'tool_calls');
	});

	test('a thought signature rides the call home, verbatim and opaque', async () => {
		const { runtime } = setup([googleSignature]);
		const result = await chatOf(runtime, ctxOf(), []);
		assert.deepStrictEqual(result.toolCalls[0]?.extraContent, { google: { thought_signature: 'sig-123' } });
		// The echo: the next request hands the same bytes back.
		const wire = toOpenAiMessages([{ role: 'assistant', content: '', toolCalls: result.toolCalls }]);
		const sent = (wire[0] as { tool_calls: { extra_content?: unknown }[] }).tool_calls[0];
		assert.deepStrictEqual(sent?.extra_content, { google: { thought_signature: 'sig-123' } });
	});

	test('an id-less call still gets a stable id in the assembled result', async () => {
		const { runtime } = setup([
			{
				name: 'anonymous call',
				sse: [
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"noop","arguments":"{}"}}]}}]}\n\n',
					'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
					'data: [DONE]\n\n',
				],
			},
		]);
		const result = await chatOf(runtime, ctxOf(), []);
		assert.strictEqual(result.toolCalls[0]?.id, 'call_0');
	});

	suite('error mapping', () => {
		const cases: { name: string; status: number; body: string; code: ModelError['code']; headers?: Record<string, string> }[] = [
			{ name: 'a bad key is auth', status: 401, body: '{"error":{"message":"invalid api key"}}', code: 'auth' },
			{
				name: 'an over-full prompt is context_overflow',
				status: 400,
				body: '{"error":{"message":"This model\'s maximum context length is 65536 tokens"}}',
				code: 'context_overflow',
			},
			{
				name: 'an image refusal is image_unsupported',
				status: 400,
				body: '{"error":{"message":"image input is not supported"}}',
				code: 'image_unsupported',
			},
			{
				name: '429 with Retry-After is rate_limited with a hint',
				status: 429,
				body: '{"error":{"message":"slow down"}}',
				code: 'rate_limited',
				headers: { 'retry-after': '7' },
			},
			{ name: 'a 5xx is server', status: 503, body: 'upstream down', code: 'server' },
			{ name: 'a bad request is invalid_request', status: 400, body: '{"error":{"message":"unknown parameter"}}', code: 'invalid_request' },
		];
		for (const row of cases) {
			test(row.name, async () => {
				const { runtime } = setup([{ name: row.name, meta: { status: row.status, headers: row.headers }, body: row.body }]);
				await assert.rejects(chatOf(runtime, ctxOf(), []), (error: unknown) => {
					assert.ok(error instanceof ModelError, `expected ModelError, got ${String(error)}`);
					assert.strictEqual(error.code, row.code);
					assert.strictEqual(error.status, row.status);
					return true;
				});
			});
		}

		test('429 carries the Retry-After hint in milliseconds', async () => {
			const { runtime } = setup([
				{ name: 'rate limited', meta: { status: 429, headers: { 'retry-after': '7' } }, body: 'slow down' },
			]);
			await assert.rejects(chatOf(runtime, ctxOf(), []), (error: unknown) => {
				assert.ok(error instanceof ModelError);
				assert.strictEqual(error.retryAfterMs, 7000);
				assert.strictEqual(error.retryable, true);
				return true;
			});
		});
	});

	test('malformed data lines and [DONE] are skipped, never fatal', async () => {
		const { runtime } = setup([
			{
				name: 'junk in the stream',
				sse: [
					'data: {not json\n\n',
					'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
					'data: [DONE]\n\n',
				],
			},
		]);
		const result = await chatOf(runtime, ctxOf(), []);
		assert.strictEqual(result.message.content, 'ok');
	});

	test('an abort keeps the streamed text, drops tool fragments, finishes aborted', async () => {
		const controller = new AbortController();
		const transport: Transport = {
			async send(request: TransportRequest) {
				return {
					status: 200,
					headers: {},
					text: async () => '',
					json: async () => undefined,
					sse: async function* () {
						yield { data: '{"choices":[{"delta":{"content":"kept"}}]}' };
						controller.abort();
						yield { data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{\\"a\\""}}]}}]}' };
						yield { data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}' };
						yield { data: '[DONE]' };
					},
				};
			},
		};
		const runtime = new ModelRuntime({
			transport,
			keys: { keyFor: async () => 'sk-test', env: () => undefined },
			instances: () => [makeFakeInstance({ id: 'deepseek', brand: 'deepseek', base: 'https://api.deepseek.com', model: 'deepseek-chat' })],
		});
		runtime.registerProtocol(openaiChatProtocol);
		runtime.registerBrand(DEEPSEEK_BRAND);
		const events: RuntimeStreamEvent[] = [];
		const result = await chatOf(runtime, ctxOf(controller.signal), events);
		assert.strictEqual(result.finish, 'aborted');
		assert.strictEqual(result.message.content, 'kept');
		assert.deepStrictEqual(result.toolCalls, []);
		assert.ok(events.some((event) => event.type === 'finish' && event.reason === 'aborted'));
	});

	suite('request shape', () => {
		test('the request is authenticated, streamed, and usage is requested', async () => {
			const { runtime, transport } = setup([textUsage]);
			await chatOf(runtime, ctxOf(), []);
			const request = transport.requests[0];
			assert.strictEqual(request?.url, 'https://api.deepseek.com/chat/completions');
			assert.strictEqual(request?.headers['authorization'], 'Bearer sk-test');
			const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
			assert.strictEqual(body.stream, true);
			assert.deepStrictEqual(body.stream_options, { include_usage: true });
			assert.strictEqual(body.model, 'deepseek-chat');
		});

		test('thinkingOff maps effort none onto the brand\'s own switch', async () => {
			const { runtime, transport } = setup([textUsage]);
			await runtime.stream({
				model: 'deepseek:deepseek-chat',
				messages: [],
				tools: [],
				ctx: ctxOf(),
				options: { reasoningEffort: 'none' },
			});
			const body = JSON.parse(transport.requests[0]?.body ?? '{}') as Record<string, unknown>;
			assert.deepStrictEqual(body.thinking, { type: 'disabled' });
			assert.ok(!('reasoning_effort' in body));
		});

		test('a provider without thinkingOff sends effort none as reasoning_effort', async () => {
			const gemini: BrandDefinition = {
				apiVersion: 1,
				id: 'google',
				protocol: 'openai-chat',
				defaults: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', options: { thinkingOff: 'effort' } },
			};
			const { runtime, transport } = setup([textUsage], gemini);
			await runtime.stream({
				model: 'deepseek:deepseek-chat',
				messages: [],
				tools: [],
				ctx: ctxOf(),
				options: { reasoningEffort: 'none' },
			});
			const body = JSON.parse(transport.requests[0]?.body ?? '{}') as Record<string, unknown>;
			assert.strictEqual(body.reasoning_effort, 'none');
			assert.ok(!('thinking' in body));
		});
	});

	test('a missing key names the variable to set', async () => {
		const transport = new ReplayTransport([]);
		const runtime = new ModelRuntime({
			transport,
			keys: { keyFor: async () => undefined, env: () => undefined },
			instances: () => [makeFakeInstance({ id: 'deepseek', brand: 'deepseek', base: 'https://api.deepseek.com', model: 'deepseek-flash', keyEnv: 'DEEPSEEK_API_KEY' })],
		});
		runtime.registerProtocol(openaiChatProtocol);
		runtime.registerBrand(DEEPSEEK_BRAND);
		await assert.rejects(chatOf(runtime, ctxOf(), []), /DEEPSEEK_API_KEY/);
	});

	test('the models path is the provider\'s own, and both shapes of listing parse', async () => {
		const { runtime, transport } = setup([
			{ name: 'wrapped listing', body: { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] } },
			{ name: 'bare listing', body: ['m1', 'm2'] },
		]);
		const ctx = ctxOf();
		const first = await runtime.listModels('deepseek', ctx);
		assert.deepStrictEqual(first.map((model) => model.id), ['deepseek-chat', 'deepseek-reasoner']);
		runtime.invalidateCatalog('deepseek');
		const second = await runtime.listModels('deepseek', ctx);
		assert.deepStrictEqual(second.map((model) => model.id), ['m1', 'm2']);
		assert.strictEqual(transport.requests[0]?.url, 'https://api.deepseek.com/models');
		assert.strictEqual(transport.requests[0]?.method, 'GET');
	});
});
