// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Resolved wire → transport request: the one place hooks, headers and auth compose, so
 * every protocol implementation sends the same shaped request without re-implementing
 * the layering's tail. Key material stays out of anything a log could reach.
 */
import type { ResolvedProvider } from '../config/schema';
import { applyAuth } from '../transport/auth';
import type { TransportRequest } from '../transport/transport';
import type { InvocationContext } from '../types';

/**
 * Builds a POST against the provider's chat URL: body hooks run first (they may rewrite the
 * body), then header hooks see the accumulated headers, then the auth scheme applies.
 */
export function chatRequest(
	wire: ResolvedProvider,
	ctx: InvocationContext,
	body: Record<string, unknown>,
	/** A same-origin override for wires whose chat endpoint carries the model in the path. */
	url?: string,
): TransportRequest {
	for (const hook of wire.requestHooks) {
		hook(body, wire, ctx);
	}
	const headers = { ...wire.headers };
	for (const hook of wire.headerHooks) {
		hook(headers, ctx);
	}
	const authed = applyAuth({ url: url ?? wire.chatURL, headers }, wire.auth, wire.key ?? '');
	return {
		url: authed.url,
		method: 'POST',
		headers: authed.headers,
		body: JSON.stringify(body),
		signal: ctx.signal,
		ctx,
	};
}

/** Builds a GET against the provider's models URL, with the same hook and auth order. */
export function modelsRequest(wire: ResolvedProvider, ctx: InvocationContext): TransportRequest {
	const headers = { ...wire.headers };
	for (const hook of wire.headerHooks) {
		hook(headers, ctx);
	}
	const authed = applyAuth({ url: wire.modelsURL, headers }, wire.auth, wire.key ?? '');
	return { url: authed.url, method: 'GET', headers: authed.headers, signal: ctx.signal, ctx };
}
