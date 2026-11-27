// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A server-sent events parser over a byte stream. Spec-shaped (`event:`/`data:` fields,
 * multi-line data joined by newlines, blank-line dispatch) but forgiving: a stream that
 * ends on a complete `data:` line without its blank line still dispatches, and unknown
 * fields are ignored. `data: [DONE]` is passed through like any other payload — the
 * protocol decides what it means. Malformed JSON is the protocol's problem, not the
 * parser's; this layer only bounds the bytes.
 */
import { ModelError } from '../errors';
import { DEFAULT_SSE_LIMITS, type SseLimits } from './security';
import type { SseEvent } from './transport';

/** Parses an SSE byte stream into events, one buffer at a time. */
export async function* parseSse(
	stream: ReadableStream<Uint8Array>,
	limits: SseLimits = DEFAULT_SSE_LIMITS,
): AsyncIterable<SseEvent> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let eventName: string | undefined;
	let data: string[] = [];
	let totalBytes = 0;

	const dispatch = (): SseEvent | undefined => {
		if (!data.length) {
			return undefined;
		}
		const event: SseEvent = { data: data.join('\n') };
		if (eventName) {
			event.event = eventName;
		}
		eventName = undefined;
		data = [];
		return event;
	};

	const feed = function* (chunk: string): Iterable<SseEvent> {
		buffer += chunk;
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const raw of lines) {
			const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
			if (line === '') {
				const event = dispatch();
				if (event) {
					yield event;
				}
				continue;
			}
			if (line.startsWith(':')) {
				continue;
			}
			const colon = line.indexOf(':');
			const field = colon === -1 ? line : line.slice(0, colon);
			const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
			if (field === 'data') {
				data.push(value);
			} else if (field === 'event') {
				eventName = value;
			}
			// `id:` and `retry:` (and anything unknown) are ignored on purpose.
		}
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			totalBytes += value.byteLength;
			if (totalBytes > limits.maxTotalBytes) {
				throw new ModelError('protocol', `model stream exceeded ${limits.maxTotalBytes} bytes`);
			}
			for (const event of feed(decoder.decode(value, { stream: true }))) {
				if (event.data.length > limits.maxEventBytes) {
					throw new ModelError('protocol', `model stream event exceeded ${limits.maxEventBytes} bytes`);
				}
				yield event;
			}
		}
		// A trailing complete line without its dispatch blank line: forgive the missing blank.
		for (const event of feed(decoder.decode())) {
			yield event;
		}
		const pending = dispatch();
		if (pending) {
			yield pending;
		}
	} finally {
		reader.releaseLock();
	}
}
