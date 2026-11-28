// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { ModelRuntime } from '../../src/runtime/runtime';
import { geminiProtocol, toGeminiContents } from '../../src/protocols/gemini';
import { ReplayTransport, type FixtureEnvelope } from '../../src/replay/replay-transport';
import { makeFakeEntry } from '../../src/testing';
import { googleProvider } from '../../src/providers/google';
import { ModelError } from '../../src/errors';
import type { Transport } from '../../src/transport/transport';
import type { InvocationContext, RuntimeStreamEvent } from '../../src/types';
import geminiToolUsage from '../fixtures/gemini/gemini-tool-usage.json';

/** gemini conformance: the native wire's ProviderStreamEvent sequence and request shape. */

function ctxOf(signal = new AbortController().signal): InvocationContext {
	return { conversationId: 's1', turnId: 's1:1', requestId: `r-${Math.random().toString(36).slice(2)}`, signal };
}

function setup(envelopes: FixtureEnvelope[]) {
	const transport = new ReplayTransport(envelopes);
	const runtime = new ModelRuntime({
		transport,
		keys: { keyFor: async () => 'g-key', env: () => undefined },
		entries: () => [makeFakeEntry({ id: 'gemini', provider: 'google', base: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.8-flash' })],
	});
	runtime.registerProtocol(geminiProtocol);
	runtime.registerDefinition(googleProvider);
	return { runtime, transport };
}

function chatOf(runtime: ModelRuntime, ctx: InvocationContext, events: RuntimeStreamEvent[]) {
	return runtime.stream({
		model: 'gemini:gemini-3.8-flash',
		messages: [{ role: 'user', content: 'read a.ts' }],
		tools: [],
		ctx,
		onEvent: (event) => events.push(event),
	});
}

suite('gemini conformance', () => {
	test('text parts and a whole functionCall stream; the signature rides the call', async () => {
		const { runtime } = setup([geminiToolUsage]);
		const events: RuntimeStreamEvent[] = [];
		const result = await chatOf(runtime, ctxOf(), events);
		assert.deepStrictEqual(events, [
			{ type: 'usage', usage: { input: 10, output: 3, cached: 2 } },
			{ type: 'text', text: 'Hi ' },
			{ type: 'text', text: 'there' },
			{ type: 'usage', usage: { input: 10, output: 5, cached: 2 } },
			{ type: 'tool-call', call: { id: 'call_0', name: 'read_file', arguments: '{"path":"a.ts"}' } },
			{ type: 'finish', reason: 'tool_calls' },
		]);
		assert.strictEqual(result.message.content, 'Hi there');
		assert.deepStrictEqual(result.toolCalls, [
			{ id: 'call_0', name: 'read_file', arguments: '{"path":"a.ts"}', extraContent: { google: { thought_signature: 'sig-1' } } },
		]);
		// The signature comes home on the next request, natively on the part.
		const { contents } = toGeminiContents([{ role: 'assistant', content: '', toolCalls: result.toolCalls }]);
		const part = contents[0]?.parts[0]?.functionCall;
		assert.strictEqual(part?.thoughtSignature, 'sig-1');
	});

	test('the chat URL names the model in its path and stays on the provider origin', async () => {
		const { runtime, transport } = setup([geminiToolUsage]);
		await chatOf(runtime, ctxOf(), []);
		const request = transport.requests[0];
		assert.strictEqual(request?.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
		assert.strictEqual(request?.headers['x-goog-api-key'], 'g-key');
		const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
		assert.ok(Array.isArray(body.contents));
	});

	test('a refusal finish maps to content_filter; a bad key to auth', async () => {
		const { runtime } = setup([
			{
				name: 'safety',
				sse: ['data: {"candidates":[{"content":{"parts":[{"text":"partial"}],"role":"model"},"finishReason":"SAFETY"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}\n\n'],
			},
		]);
		const result = await chatOf(runtime, ctxOf(), []);
		assert.strictEqual(result.finish, 'content_filter');

		const denied = setup([{ name: 'denied', meta: { status: 400 }, body: '{"error":{"code":400,"message":"API key not valid"}}' }]);
		await assert.rejects(chatOf(denied.runtime, ctxOf(), []), (error: unknown) => error instanceof ModelError);
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
						yield { data: '{"candidates":[{"content":{"parts":[{"text":"kept"}],"role":"model"}}]}' };
						controller.abort();
						yield { data: '{"candidates":[{"content":{"parts":[{"text":"dropped"}],"role":"model"},"finishReason":"STOP"}]}' };
					},
				};
			},
		};
		const runtime = new ModelRuntime({
			transport,
			keys: { keyFor: async () => 'g-key', env: () => undefined },
			entries: () => [makeFakeEntry({ id: 'gemini', provider: 'google', base: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.8-flash' })],
		});
		runtime.registerProtocol(geminiProtocol);
		runtime.registerDefinition(googleProvider);
		const result = await chatOf(runtime, ctxOf(controller.signal), []);
		assert.strictEqual(result.finish, 'aborted');
		assert.strictEqual(result.message.content, 'kept');
	});

	test('the models listing keeps native ids for the catalog rules to shape', async () => {
		const { runtime } = setup([
			{ name: 'listing', body: { models: [{ name: 'models/gemini-3.8-flash' }, { name: 'models/gemini-3.9-pro' }] } },
		]);
		const models = await runtime.listModels('gemini', ctxOf());
		// The google vendor strips the `models/` prefix and drops non-chat listings.
		assert.deepStrictEqual(models.map((model) => model.id), ['gemini-3.8-flash', 'gemini-3.9-pro']);
	});

	test('a tool message answers the call by name, found through the id', () => {
		const { contents } = toGeminiContents([
			{ role: 'assistant', content: '', toolCalls: [{ id: 'c9', name: 'search', arguments: '{"q":1}' }] },
			{ role: 'tool', toolCallId: 'c9', content: 'found' },
			{ role: 'tool', toolCallId: 'unknown', content: 'lost' },
		]);
		const model = contents[0]?.parts[0]?.functionCall;
		assert.strictEqual(model?.name, 'search');
		assert.deepStrictEqual(model?.args, { q: 1 });
		const responses = contents[1]?.parts.map((part) => part.functionResponse);
		assert.deepStrictEqual(responses?.map((response) => response?.name), ['search', 'unknown']);
	});
});
