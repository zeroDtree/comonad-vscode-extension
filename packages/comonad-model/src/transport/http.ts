// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The fetch-based transport. Redirects are refused outright: a 3xx must never carry an
 * Authorization header (or a query key) to a host the user did not configure. Abort and
 * timeout surface as ModelError codes so no caller has to read a DOMException.
 */
import { ModelError, toTransportError } from '../errors';
import { parseSse } from './sse';
import { DEFAULT_SSE_LIMITS, type SseLimits } from './security';
import type { SseEvent, Transport, TransportRequest, TransportResponse } from './transport';

export class HttpTransport implements Transport {
	constructor(private readonly limits: SseLimits = DEFAULT_SSE_LIMITS) {}

	async send(request: TransportRequest): Promise<TransportResponse> {
		let response: Response;
		try {
			response = await fetch(request.url, {
				method: request.method,
				headers: request.headers,
				body: request.body,
				signal: request.signal,
				redirect: 'error',
			});
		} catch (error) {
			throw this.normalize(error, request);
		}
		const headers: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			headers[name.toLowerCase()] = value;
		});
		const limits = this.limits;
		return {
			status: response.status,
			headers,
			text: () => response.text().catch(() => ''),
			json: async () => {
				try {
					return await response.json();
				} catch (error) {
					throw new ModelError('protocol', 'model response was not JSON', { cause: error });
				}
			},
			sse(): AsyncIterable<SseEvent> {
				if (!response.body) {
					throw new ModelError('protocol', 'model response had no body');
				}
				return parseSse(response.body, limits);
			},
		};
	}

	/** Abort and timeout keep their own codes; anything else fetch threw is a transport failure. */
	private normalize(error: unknown, request: TransportRequest): ModelError {
		if (error instanceof ModelError) {
			return error;
		}
		const name = error instanceof Error ? error.name : '';
		if (name === 'TimeoutError') {
			return new ModelError('timeout', 'model request timed out', { cause: error });
		}
		if (request.signal.aborted || name === 'AbortError') {
			return new ModelError('aborted', 'model request aborted', { cause: error });
		}
		return toTransportError(error);
	}
}
