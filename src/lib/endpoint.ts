// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A stable identity for a provider endpoint: two profiles that name the same base in different
 * spellings (`HTTPS://API.DEEPSEEK.COM/`, `https://api.deepseek.com`) are the same provider, so a
 * key stored for one works for the other. The path keeps its case (paths are case-sensitive), a
 * query is kept (it can select an account), and a fragment never identifies anything.
 */
export function normalizeEndpoint(base: string | undefined): string {
	const raw = (base ?? '').trim();
	if (!raw) {
		return '';
	}
	try {
		const url = new URL(raw);
		url.hash = '';
		return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
	} catch {
		return raw.replace(/\/+$/, '');
	}
}

/**
 * Whether a provider base URL points at the loopback interface of the machine that runs the
 * extension host. In a remote window that is the remote machine, not the user's laptop — the
 * distinction a reverse SSH tunnel exists to bridge.
 */
export function isLoopbackBase(base: string | undefined): boolean {
	const text = base?.trim();
	if (!text) {
		return false;
	}
	let hostname: string;
	try {
		hostname = new URL(text.includes('://') ? text : `http://${text}`).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (hostname.endsWith('.')) {
		hostname = hostname.slice(0, -1);
	}
	if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
		return true;
	}
	if (hostname === '[::1]' || hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') {
		return true;
	}
	const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
	return Boolean(ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255));
}
