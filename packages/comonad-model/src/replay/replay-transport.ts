// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Replay: a transport that serves recorded endpoint exchanges instead of the network.
 * Conformance suites drive real protocol implementations through it and assert the
 * ProviderStreamEvent sequence — so a refactor of the SSE parser, the delta assembly
 * or the error mapping shows up as a diff against the recording, not as a surprise in
 * production. Fixtures are plain JSON envelopes; the bytes replay through the real
 * parser.
 */
import { parseSse } from '../transport/sse';
import type { SseEvent, Transport, TransportRequest, TransportResponse } from '../transport/transport';

export interface FixtureEnvelope {
	name: string;
	meta?: {
		protocol?: string;
		brand?: string;
		/** HTTP status the endpoint answered with; 200 streams `sse`, anything else sends `body`. */
		status?: number;
		headers?: Record<string, string>;
		note?: string;
	};
	request?: { model?: string; messages?: unknown[]; tools?: unknown[] };
	/** The SSE lines the endpoint sent, verbatim (`data: …` lines with their blank lines). */
	sse?: string[];
	/** A non-streaming payload: a models listing or an error body. */
	body?: unknown;
}

/** Serves one queued envelope per request, recording what the protocol asked for. */
export class ReplayTransport implements Transport {
	readonly requests: TransportRequest[] = [];

	constructor(private readonly envelopes: FixtureEnvelope[]) {}

	async send(request: TransportRequest): Promise<TransportResponse> {
		this.requests.push(request);
		const envelope = this.envelopes.shift();
		if (!envelope) {
			throw new Error(`replay queue is empty; nothing recorded for ${request.method} ${request.url}`);
		}
		const status = envelope.meta?.status ?? 200;
		const headers = { ...(envelope.meta?.headers ?? {}) };
		const body = envelope.body;
		const sseLines = envelope.sse ?? [];
		return {
			status,
			headers,
			text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
			json: async () => body,
			sse(): AsyncIterable<SseEvent> {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						const encoder = new TextEncoder();
						for (const line of sseLines) {
							controller.enqueue(encoder.encode(line));
						}
						controller.close();
					},
				});
				return parseSse(stream);
			},
		};
	}
}
