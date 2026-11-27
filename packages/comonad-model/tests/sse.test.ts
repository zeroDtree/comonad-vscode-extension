// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { ModelError } from '../src/errors';
import { parseSse } from '../src/transport/sse';
import type { SseEvent } from '../src/transport/transport';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

async function collect(...chunks: string[]): Promise<SseEvent[]> {
	const events: SseEvent[] = [];
	for await (const event of parseSse(streamOf(...chunks))) {
		events.push(event);
	}
	return events;
}

async function collectWith(limits: { maxEventBytes: number; maxTotalBytes: number }, ...chunks: string[]): Promise<SseEvent[]> {
	const events: SseEvent[] = [];
	for await (const event of parseSse(streamOf(...chunks), limits)) {
		events.push(event);
	}
	return events;
}

suite('sse parser', () => {
	test('a data line dispatches on its blank line', async () => {
		const events = await collect('data: {"a":1}\n\ndata: {"b":2}\n\n');
		assert.deepStrictEqual(events.map((event) => event.data), ['{"a":1}', '{"b":2}']);
	});

	test('multi-line data joins with newlines; the event field rides along', async () => {
		const events = await collect('event: message_start\ndata: {"x":\ndata: 1}\n\n');
		assert.deepStrictEqual(events, [{ event: 'message_start', data: '{"x":\n1}' }]);
	});

	test('comments, unknown fields and bare colons are ignored', async () => {
		const events = await collect(': keepalive\nid: 7\nretry: 100\ndata: {"ok":true}\n\n');
		assert.deepStrictEqual(events.map((event) => event.data), ['{"ok":true}']);
	});

	test('[DONE] passes through as ordinary data', async () => {
		const events = await collect('data: [DONE]\n\n');
		assert.deepStrictEqual(events.map((event) => event.data), ['[DONE]']);
	});

	test('CRLF endings parse the same', async () => {
		const events = await collect('event: delta\r\ndata: {"t":"hi"}\r\n\r\n');
		assert.deepStrictEqual(events, [{ event: 'delta', data: '{"t":"hi"}' }]);
	});

	test('a complete data line without its blank line still dispatches at EOF', async () => {
		const events = await collect('data: {"last":1}\n');
		assert.deepStrictEqual(events.map((event) => event.data), ['{"last":1}']);
	});

	test('chunks split mid-line reassemble', async () => {
		const events = await collect('data: {"spl', 'it":true}', '\n\ndata: tail\n\n');
		assert.deepStrictEqual(events.map((event) => event.data), ['{"split":true}', 'tail']);
	});

	test('an event over the per-event limit fails the stream', async () => {
		const big = 'x'.repeat(2048);
		await assert.rejects(
			collectWith({ maxEventBytes: 1024, maxTotalBytes: 65536 }, `data: ${big}\n\n`),
			(error: unknown) => error instanceof ModelError && error.code === 'protocol',
		);
	});

	test('a stream over the total limit fails the stream', async () => {
		const chunk = `data: ${'y'.repeat(512)}\n\n`;
		await assert.rejects(
			collectWith({ maxEventBytes: 65536, maxTotalBytes: 4096 }, chunk.repeat(20)),
			(error: unknown) => error instanceof ModelError && error.code === 'protocol',
		);
	});
});
