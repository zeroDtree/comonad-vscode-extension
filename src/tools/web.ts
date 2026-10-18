// SPDX-License-Identifier: AGPL-3.0-only
import { objectSchema } from '../lib/types';
import { toolset } from '../services/tools';

const MAX_BYTES = 60_000;

export const webTools = toolset([
	{
		name: 'fetch_url',
		description: 'Fetch a URL and return its text content. Only text, JSON and XML responses are returned.',
		capability: 'ro',
		needsNetwork: true,
		needsWorkspace: false,
		parameters: objectSchema({ url: { type: 'string' }, maxBytes: { type: 'number' } }, ['url']),
		async execute(args) {
			const { url, maxBytes } = args as { url: string; maxBytes?: number };
			const response = await fetch(url, {
				headers: { 'user-agent': 'comonad-vscode/0.2' },
				redirect: 'follow',
				signal: AbortSignal.timeout(20_000),
			});
			if (!response.ok) {
				return `Error: ${response.status} ${response.statusText}`;
			}
			const type = response.headers.get('content-type') ?? '';
			if (!/text\/|application\/(json|xml|javascript|xhtml)/.test(type)) {
				return `Error: unsupported content type ${type || '(unknown)'}`;
			}
			const text = await response.text();
			const limit = Math.min(maxBytes ?? MAX_BYTES, MAX_BYTES);
			return text.length > limit ? `${text.slice(0, limit)}\n[...truncated, ${text.length} chars]` : text;
		},
	},
	{
		name: 'web_search',
		description: 'Search the web. Returns titles, URLs and snippets. Use fetch_url to read a result in full.',
		capability: 'ro',
		needsNetwork: true,
		needsWorkspace: false,
		parameters: objectSchema({ query: { type: 'string' }, count: { type: 'number' } }, ['query']),
		async execute(args) {
			const { query, count } = args as { query: string; count?: number };
			const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
				headers: { 'user-agent': 'Mozilla/5.0 (compatible; comonad/0.2)' },
				signal: AbortSignal.timeout(20_000),
			});
			if (!response.ok) {
				return `Error: search failed with ${response.status}`;
			}
			const html = await response.text();
			const results: string[] = [];
			const pattern =
				/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
			for (const match of html.matchAll(pattern)) {
				if (results.length >= Math.min(count ?? 8, 10)) {
					break;
				}
				const href = decodeDuckDuckGo(match[1] ?? '');
				const title = stripTags(match[2] ?? '');
				const snippet = stripTags(match[3] ?? '');
				if (href) {
					results.push(`${title}\n${href}${snippet ? `\n${snippet}` : ''}`);
				}
			}
			return results.join('\n\n') || '(no results)';
		},
	},
]);

function decodeDuckDuckGo(href: string): string {
	try {
		const url = new URL(href, 'https://duckduckgo.com');
		const target = url.searchParams.get('uddg');
		return target ? decodeURIComponent(target) : url.toString();
	} catch {
		return href;
	}
}

function stripTags(html: string): string {
	return html
		.replace(/<[^>]*>/g, '')
		.replaceAll('&amp;', '&')
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&#x27;', "'")
		.replace(/\s+/g, ' ')
		.trim();
}
