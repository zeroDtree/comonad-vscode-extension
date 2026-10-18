import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Service, type Context } from 'cordis';
import { embedTexts } from '../lib/vectors';
import { rank, queryText, type VectorCandidate, type VectorHit } from '../lib/vectors';
import type { LoreBook, LoreMessage } from '../lib/lore';
import type { VectorSettings } from '../lib/settings';

/**
 * The vector side of a world book: the entries that ask to be found by meaning instead of by keys,
 * the vectors they were stored with, and the search that picks them for a turn.
 *
 * SillyTavern keeps this in its Vectors extension, with one collection per world info file and one
 * vector per entry chunk, and a query built from the newest messages. Comonad keeps the same shape
 * in one file per book under the extension's storage, keyed by the text's hash, so a book that was
 * edited re-embeds only the entries that actually changed.
 */

/** Whatever turns text into vectors: the OpenAI-compatible endpoint, or a test stub. */
export interface Embedder {
	name: string;
	embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface VectorQuery {
	/** The books the chat scans. */
	books: readonly LoreBook[];
	/** Newest first, exactly as the scan gets them. */
	messages: readonly LoreMessage[];
}

interface StoredVector {
	/** The hash of the text this vector was made from: the text changed, the vector is stale. */
	hash: string;
	vector: number[];
}

interface Collection {
	model: string;
	entries: Record<string, StoredVector>;
}

declare module 'cordis' {
	interface Context {
		vectors: Vectors;
	}
}

export class Vectors extends Service {
	static inject = ['host', 'settings', 'log'];

	private readonly embedders = new Map<string, Embedder>();
	private readonly warned = new Set<string>();

	constructor(ctx: Context) {
		super(ctx, 'vectors');
	}

	/** Registers an embedder by name. The OpenAI-compatible endpoint is the one that is always there. */
	use(embedder: Embedder): void {
		this.ctx.effect(() => {
			this.embedders.set(embedder.name, embedder);
			return () => {
				this.embedders.delete(embedder.name);
			};
		}, `ctx.vectors.use(${JSON.stringify(embedder.name)})`);
	}

	/** The name of the embedder the settings ask for, or `''` when vectorizing is off. */
	private chosen(model: VectorSettings): string {
		return model.enabled ? (model.profile ? `http:${model.profile}:${model.model}` : `http::${model.model}`) : '';
	}

	private embedder(settings: VectorSettings): Embedder | undefined {
		const name = this.chosen(settings);
		if (!name) {
			return undefined;
		}
		const registered = this.embedders.get(name);
		if (registered) {
			return registered;
		}
		// The endpoint embedder is built here rather than registered, because its base and key are the
		// profile's and a profile can be edited at any time.
		return this.endpointEmbedder(settings);
	}

	/** An embedder that calls the endpoint of a profile (or of the chat's own model when none is set). */
	private endpointEmbedder(settings: VectorSettings): Embedder | undefined {
		const profile = this.ctx.llm.profile(settings.profile) ?? this.ctx.llm.profile(this.ctx.settings.get().model);
		if (!profile?.base) {
			return undefined;
		}
		return {
			name: this.chosen(settings),
			embed: async (texts, signal) =>
				embedTexts({
					base: profile.base ?? '',
					key: await this.ctx.llm.resolveKey(profile),
					model: settings.model || profile.model,
					input: texts,
					signal,
				}),
		};
	}

	/**
	 * The entries the chat's own words ask for, book by book: an entry that says `vectorized` is found
	 * here instead of by its keys. Answers `<book name> -> uids`, which is what the scan reads.
	 */
	async activate(query: VectorQuery, settings: VectorSettings): Promise<Map<string, number[]>> {
		const hits = new Map<string, number[]>();
		if (!settings.enabled) {
			return hits;
		}
		const wanted = query.books
			.map((entry) => ({
				name: entry.name,
				entries: Object.values(entry.book.entries).filter((candidate) => candidate.vectorized === true && !candidate.disable && (candidate.content ?? '').trim()),
			}))
			.filter((book) => book.entries.length);
		if (!wanted.length) {
			return hits;
		}
		const text = queryText(query.messages, settings.queryMessages);
		if (!text) {
			return hits;
		}
		const embedder = this.embedder(settings);
		if (!embedder) {
			return hits;
		}
		try {
			// One call for the query and everything that has no vector yet: the index is what makes the
			// second turn cheap, and the hash is what makes an edited entry re-embed.
			const stored = wanted.map((book) => this.collection(book.name, settings.model));
			const missing: Array<{ book: number; uid: number; text: string; hash: string }> = [];
			wanted.forEach((book, index) => {
				for (const entry of book.entries) {
					const content = String(entry.content ?? '');
					const hash = hashOf(content);
					if (stored[index]!.entries[String(entry.uid)]?.hash !== hash) {
						missing.push({ book: index, uid: entry.uid, text: content, hash });
					}
				}
			});
			if (missing.length) {
				const vectors = await embedder.embed([text, ...missing.map((item) => item.text)]);
				const queryVector = vectors[0];
				if (!queryVector?.length) {
					return hits;
				}
				missing.forEach((item, at) => {
					const vector = vectors[at + 1];
					if (vector?.length) {
						stored[item.book]!.entries[String(item.uid)] = { hash: item.hash, vector };
					}
				});
				wanted.forEach((book, index) => this.write(book.name, settings.model, stored[index]!));
				return this.select(wanted, stored, queryVector, settings);
			}
			// Everything is indexed: only the query needs embedding.
			const [queryVector] = await embedder.embed([text]);
			if (!queryVector?.length) {
				return hits;
			}
			return this.select(wanted, stored, queryVector, settings);
		} catch (error) {
			// A failing endpoint costs the vectorized entries, never the turn.
			const message = error instanceof Error ? error.message : String(error);
			if (!this.warned.has(message)) {
				this.warned.add(message);
				this.ctx.log.message(`vectors: ${message}`);
			}
			return hits;
		}
	}

	private select(
		books: Array<{ name: string; entries: Array<{ uid: number }> }>,
		stored: Collection[],
		queryVector: number[],
		settings: VectorSettings,
	): Map<string, number[]> {
		const hits = new Map<string, number[]>();
		books.forEach((book, index) => {
			const candidates: VectorCandidate[] = [];
			for (const entry of book.entries) {
				const vector = stored[index]!.entries[String(entry.uid)]?.vector;
				if (vector) {
					candidates.push({ uid: entry.uid, vector });
				}
			}
			const ranked: VectorHit[] = rank(queryVector, candidates, { threshold: settings.threshold, max: settings.maxEntries });
			if (ranked.length) {
				hits.set(book.name, ranked.map((hit) => hit.uid));
			}
		});
		return hits;
	}

	/** Where a book's vectors live: one file per book and model, under the extension's storage. */
	private file(book: string, model: string): string {
		const name = `${hashOf(book).slice(0, 16)}-${model.replace(/[^\w.-]+/g, '-')}.json`;
		return join(this.ctx.host.storage.root, 'vectors', name);
	}

	private collection(book: string, model: string): Collection {
		try {
			const parsed = JSON.parse(readFileSync(this.file(book, model), 'utf8')) as Collection;
			if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
				return { model, entries: parsed.entries };
			}
		} catch {
			// No index yet, or one we cannot read: it is rebuilt from the book.
		}
		return { model, entries: {} };
	}

	private write(book: string, model: string, collection: Collection): void {
		try {
			const file = this.file(book, model);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, JSON.stringify(collection), 'utf8');
		} catch (error) {
			this.ctx.log.message(`vectors: could not write the index for ${book}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** How many vectors a book has, for the panel's readout. */
	indexed(book: string, settings: VectorSettings): number {
		return Object.keys(this.collection(book, settings.model).entries).length;
	}
}

export const vectorsPlugin = Vectors;

function hashOf(text: string): string {
	return createHash('sha1').update(text).digest('hex');
}
