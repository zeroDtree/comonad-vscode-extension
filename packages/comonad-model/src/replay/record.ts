// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Recording: wraps a real transport and serializes each exchange to the replay envelope
 * shape. The recorder is a development tool — run it against a live endpoint with a key,
 * commit only the fixture, never the key.
 */
import { parseSse } from '../transport/sse';
import type { SseEvent, Transport, TransportRequest, TransportResponse } from '../transport/transport';
import type { FixtureEnvelope } from './replay-transport';

/** A transport that passes through and remembers each exchange as a fixture envelope. */
export class RecordingTransport implements Transport {
	readonly recorded: FixtureEnvelope[] = [];

	constructor(private readonly inner: Transport) {}

	async send(request: TransportRequest): Promise<TransportResponse> {
		const response = await this.inner.send(request);
		const envelope: FixtureEnvelope = {
			name: `${request.method} ${request.url}`,
			meta: { status: response.status, headers: response.headers },
			request: { model: undefined },
			sse: [],
		};
		if (response.status === 200) {
			for await (const event of response.sse()) {
				envelope.sse?.push(formatSse(event));
			}
		} else {
			envelope.body = await response.text().catch(() => '');
		}
		this.recorded.push(envelope);
		// The bytes were consumed into `envelope.sse`; hand the caller the same stream again,
		// parsed by the same parser the network path uses.
		const bytes = new TextEncoder().encode((envelope.sse ?? []).join(''));
		return {
			status: response.status,
			headers: response.headers,
			text: async () => (envelope.body === undefined ? '' : typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body)),
			json: async () => envelope.body,
			sse(): AsyncIterable<SseEvent> {
				return parseSse(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(bytes);
							controller.close();
						},
					}),
				);
			},
		};
	}
}

/** One event back into its wire lines. */
export function formatSse(event: SseEvent): string {
	const prefix = event.event ? `event: ${event.event}\n` : '';
	return `${prefix}data: ${event.data}\n\n`;
}
