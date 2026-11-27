// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The transport contract: one request in, one response out. Protocol implementations
 * never touch `fetch` directly — everything HTTP-shaped (auth, headers, SSE parsing,
 * abort, origin security) happens below this seam.
 */
import type { InvocationContext } from '../types';

export interface TransportRequest {
	/** Absolute URL; the transport refuses anything outside the provider's origin. */
	url: string;
	method: 'GET' | 'POST';
	headers: Record<string, string>;
	body?: string;
	/** The call's only cancellation channel. */
	signal: AbortSignal;
	ctx: InvocationContext;
}

/** One server-sent event, before any protocol interpretation. */
export interface SseEvent {
	event?: string;
	data: string;
}

export interface TransportResponse {
	status: number;
	/** Header names lower-cased, so lookups are case-insensitive. */
	headers: Record<string, string>;
	text(): Promise<string>;
	json(): Promise<unknown>;
	sse(): AsyncIterable<SseEvent>;
}

export interface Transport {
	send(request: TransportRequest): Promise<TransportResponse>;
}
