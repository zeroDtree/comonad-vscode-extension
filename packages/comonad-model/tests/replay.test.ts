// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { ReplayTransport } from '../src/replay/replay-transport';
import { RecordingTransport, formatSse } from '../src/replay/record';
import type { SseEvent, Transport, TransportRequest } from '../src/transport/transport';
import type { InvocationContext } from '../src/types';
import textUsage from './fixtures/openai-chat/deepseek-text-usage.json';
import toolFragments from './fixtures/openai-chat/deepseek-tool-fragments.json';

const ctx: InvocationContext = {
	conversationId: 's1',
	turnId: 's1:1',
	requestId: 'r1',
	signal: new AbortController().signal,
};

function requestOf(overrides: Partial<TransportRequest> = {}): TransportRequest {
	return {
		url: 'https://api.deepseek.com/chat/completions',
		method: 'POST',
		headers: {},
		signal: ctx.signal,
		ctx,
		...overrides,
	};
}

async function collect(events: AsyncIterable<SseEvent>): Promise<string[]> {
	const out: string[] = [];
	for await (const event of events) {
		out.push(event.data);
	}
	return out;
}

suite('replay transport', () => {
	test('a fixture replays its SSE bytes through the real parser', async () => {
		const transport = new ReplayTransport([textUsage]);
		const response = await transport.send(requestOf());
		assert.strictEqual(response.status, 200);
		const data = await collect(response.sse());
		assert.strictEqual(data.length, 6);
		assert.match(data[0] ?? '', /reasoning_content/);
		assert.strictEqual(data[data.length - 1], '[DONE]');
	});

	test('a tool-call fragment fixture keeps every delta in order', async () => {
		const transport = new ReplayTransport([toolFragments]);
		const response = await transport.send(requestOf());
		const data = await collect(response.sse());
		assert.strictEqual(data.length, 5);
		assert.match(data[1] ?? '', /path/);
		assert.match(data[3] ?? '', /tool_calls/);
	});

	test('an error envelope carries status and body', async () => {
		const transport = new ReplayTransport([
			{ name: 'rate limited', meta: { status: 429, headers: { 'retry-after': '7' } }, body: { error: { message: 'slow down' } } },
		]);
		const response = await transport.send(requestOf());
		assert.strictEqual(response.status, 429);
		assert.strictEqual(response.headers['retry-after'], '7');
		assert.deepStrictEqual(await response.json(), { error: { message: 'slow down' } });
		assert.match(await response.text(), /slow down/);
	});

	test('an empty queue is a loud failure, not a hang', async () => {
		const transport = new ReplayTransport([]);
		await assert.rejects(transport.send(requestOf()), /queue is empty/);
	});

	test('every request is recorded for assertions', async () => {
		const transport = new ReplayTransport([textUsage]);
		await transport.send(requestOf({ url: 'https://api.deepseek.com/models', method: 'GET' }));
		assert.strictEqual(transport.requests.length, 1);
		assert.strictEqual(transport.requests[0]?.method, 'GET');
	});
});

suite('recording transport', () => {
	function stub(events: SseEvent[]): Transport {
		return {
			async send() {
				return {
					status: 200,
					headers: {},
					text: async () => '',
					json: async () => undefined,
					sse: async function* () {
						for (const event of events) {
							yield event;
						}
					},
				};
			},
		};
	}

	test('an exchange round-trips through the envelope format', async () => {
		const sent = [{ data: '{"a":1}' }, { event: 'delta', data: '{"b":2}' }, { data: '[DONE]' }];
		const recorder = new RecordingTransport(stub(sent));
		const response = await recorder.send(requestOf());
		assert.strictEqual(recorder.recorded.length, 1);
		assert.deepStrictEqual(recorder.recorded[0]?.sse, [
			'data: {"a":1}\n\n',
			'event: delta\ndata: {"b":2}\n\n',
			'data: [DONE]\n\n',
		]);
		assert.deepStrictEqual(await collect(response.sse()), sent.map((event) => event.data));
	});

	test('formatSse writes the event field only when there is one', () => {
		assert.strictEqual(formatSse({ data: 'x' }), 'data: x\n\n');
		assert.strictEqual(formatSse({ event: 'e', data: 'x' }), 'event: e\ndata: x\n\n');
	});
});
