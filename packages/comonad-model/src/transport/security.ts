// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Transport security: endpoint identity, same-origin enforcement for the independently
 * configured chat and models paths, and the SSE abuse limits. A model response is
 * untrusted input; nothing in this file may execute or expand one.
 */
import { ModelError } from '../errors';

/**
 * A provider endpoint's identity: scheme and host lower-cased, trailing slashes trimmed,
 * the path kept case-sensitive, the query kept, the fragment dropped. Two URLs that
 * normalize equal are the same connection (and share one key).
 */
export function normalizeEndpoint(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return url.trim().replace(/\/+$/, '');
	}
	const path = parsed.pathname.replace(/\/+$/, '');
	return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
}

/** The origin (scheme + host + port) of a URL, lower-cased. */
export function originOf(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.origin.toLowerCase();
	} catch {
		return '';
	}
}

/**
 * Joins a path onto the provider's base URL — a suffix, the way the wire has always
 * appended `/chat/completions` to whatever base the user configured, path segments and
 * all. A path that is itself an absolute URL must match the base's origin exactly: a
 * configured path is data, and data does not get to move API keys to another host.
 */
export function resolveSameOrigin(baseURL: string, path: string): string {
	const base = baseURL.trim().replace(/\/+$/, '');
	const suffix = path.trim();
	if (/^[a-z][a-z0-9+.-]*:/i.test(suffix)) {
		// An absolute URL: same origin or nothing.
		let resolved: string;
		try {
			resolved = new URL(suffix).toString();
		} catch {
			throw new ModelError('invalid_request', `endpoint path is not a URL: ${path}`);
		}
		if (originOf(resolved) !== originOf(base)) {
			throw new ModelError(
				'invalid_request',
				`endpoint path ${path} resolves outside the provider origin ${originOf(base)}`,
			);
		}
		return resolved;
	}
	if (!base) {
		throw new ModelError('invalid_request', 'endpoint path without a base URL');
	}
	return `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

/** The bytes one SSE event and one whole response may carry before the stream is cut. */
export interface SseLimits {
	maxEventBytes: number;
	maxTotalBytes: number;
}

export const DEFAULT_SSE_LIMITS: SseLimits = {
	maxEventBytes: 1024 * 1024,
	maxTotalBytes: 32 * 1024 * 1024,
};
