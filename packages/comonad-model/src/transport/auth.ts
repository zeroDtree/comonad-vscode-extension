// SPDX-License-Identifier: AGPL-3.0-only
/** How a provider instance authenticates: the key's shape on the wire, never the key itself. */

export type AuthScheme =
	| { kind: 'bearer' }
	| { kind: 'header'; name: string }
	| { kind: 'query'; name: string };

export const BEARER: AuthScheme = { kind: 'bearer' };

/** Applies the scheme to a request copy: headers and URL only, the key never lands in a log. */
export function applyAuth(
	request: { url: string; headers: Record<string, string> },
	auth: AuthScheme,
	key: string,
): { url: string; headers: Record<string, string> } {
	const headers = { ...request.headers };
	let url = request.url;
	switch (auth.kind) {
		case 'bearer':
			headers.authorization = `Bearer ${key}`;
			break;
		case 'header':
			headers[auth.name.toLowerCase()] = key;
			break;
		case 'query': {
			const joiner = url.includes('?') ? '&' : '?';
			url = `${url}${joiner}${encodeURIComponent(auth.name)}=${encodeURIComponent(key)}`;
			break;
		}
	}
	return { url, headers };
}

/** A key-shaped string with only its first and last hints left, for diagnostics. */
export function maskSecret(secret: string): string {
	if (secret.length <= 8) {
		return '***';
	}
	return `${secret.slice(0, 3)}***${secret.slice(-2)}`;
}

/** Removes every occurrence of the given secrets from text destined for a log or an error. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret && secret.length > 0) {
			out = out.split(secret).join(maskSecret(secret));
		}
	}
	return out;
}
