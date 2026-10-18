import type { Context, Plugin } from 'cordis';
import { clip } from '@comonad/lib/util';
import { searchLore, type LoreBook } from '../lib/lore';
import type { WorldInfoSettings } from '../lib/types';
import type { ToolContext, ToolSpec } from '@comonad/lib/types';

/**
 * `lore_lookup`: the model's own way into the world books, the Comonad equivalent of SillyTavern's
 * `/wi` commands. The automatic pass in `lore.ts` decides what the model *already* sees; this lets
 * it ask for more. Read-only: a lookup never changes what the next turn injects.
 */

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_CHARS = 8_000;

/** What the tool needs from the tavern service, so it can be tested without one. */
export interface LoreLookupHost {
	/** The books that apply to one chat, optionally narrowed to a single book by name. */
	booksFor(sessionId: string, only?: string): LoreBook[];
	settings(): WorldInfoSettings;
}

export function loreLookupTool(host: LoreLookupHost): ToolSpec {
	return {
		name: 'lore_lookup',
		description:
			'Search this chat’s world books (lorebooks) for an entry, and return its notes and full text. Use it when the user mentions a name, place or term the character should know, or when the prompt lists a world book that looks relevant.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'What to look up: one or more words, matched against entry keys, titles and text.' },
				book: { type: 'string', description: 'Limit the search to one world book, by name.' },
				limit: { type: 'number', description: `How many entries to return (default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}).` },
			},
			required: ['query'],
			additionalProperties: false,
		},
		capability: 'ro',
		needsNetwork: false,
		// The library lives in the user folder too, so this works in a window with no folder open.
		needsWorkspace: false,
		async execute(raw: unknown, ctx: ToolContext): Promise<string> {
			const args = (raw ?? {}) as { query?: unknown; book?: unknown; limit?: unknown };
			const query = typeof args.query === 'string' ? args.query.trim() : '';
			if (!query) {
				return 'Error: lore_lookup needs a query.';
			}
			const only = typeof args.book === 'string' ? args.book.trim() : '';
			const books = host.booksFor(ctx.sessionId, only);
			if (!books.length) {
				return only ? `Error: no world book named “${only}” is active in this chat.` : 'No world books are active in this chat.';
			}
			const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.round(args.limit) : DEFAULT_LIMIT;
			const hits = searchLore(books, query, host.settings(), Math.min(MAX_LIMIT, Math.max(1, requested)));
			if (!hits.length) {
				return `No entry in ${books.map((book) => book.name).join(', ')} matches “${query}”.`;
			}
			const blocks = hits.map((hit) => {
				const keys = (hit.entry.key ?? []).join(', ');
				// An untitled entry is still findable by what matched it, rather than a bare number.
				const title = (hit.entry.comment ?? '').trim() || keys || `entry ${hit.entry.uid}`;
				const flags = [hit.entry.constant ? 'always active' : '', hit.entry.disable ? 'disabled' : ''].filter(Boolean).join(', ');
				return [`### ${title} — ${hit.book} (matched ${hit.matched})`, keys ? `keys: ${keys}` : '', flags ? `(${flags})` : '', hit.entry.content.trim()]
					.filter(Boolean)
					.join('\n');
			});
			return clip(blocks.join('\n\n'), MAX_CHARS);
		},
	};
}

export function loreTools(ctx: Context): void {
	ctx.tools.register(
		loreLookupTool({
			booksFor: (sessionId, only) => ctx.tavern.booksFor(sessionId, only),
			settings: () => ctx.tavern.wiSettings(),
		}),
	);
}

const plugin = loreTools as Plugin.Function;
plugin.inject = ['tools', 'tavern'];
export const loreToolPlugin = plugin;
