/**
 * Embeddings: what a vector search needs, and the arithmetic it is made of.
 *
 * The world-info scan activates an entry whose keys match the chat; a **vectorized** entry is the
 * other way round — it is found because its text is close to what the chat is about. Both halves
 * live here: the endpoint call (`POST /embeddings`, OpenAI-compatible) and the cosine ranking that
 * turns a list of vectors into an ordered list of entries. Pure module: no `vscode`, no `cordis`.
 */

export interface EmbedRequest {
	base: string;
	key: string;
	model: string;
	/** One vector per input, in the same order. */
	input: string[];
	signal?: AbortSignal;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * Embeds a batch of texts. The endpoint answers `{data: [{embedding, index}]}`; rows are put back in
 * the order of the request, because some endpoints reorder them.
 */
export async function embedTexts(request: EmbedRequest): Promise<number[][]> {
	const base = request.base.trim();
	if (!base || !request.input.length) {
		return [];
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT);
	const abort = (): void => controller.abort();
	request.signal?.addEventListener('abort', abort, { once: true });
	try {
		const response = await fetch(`${base.replace(/\/+$/, '')}/embeddings`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(request.key ? { authorization: `Bearer ${request.key}` } : {}),
			},
			body: JSON.stringify({ model: request.model, input: request.input }),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`embedding failed (${response.status}): ${(await response.text().catch(() => '')).trim().slice(0, 200)}`);
		}
		const body = (await response.json()) as { data?: Array<{ embedding?: unknown; index?: unknown }>; embeddings?: unknown };
		const rows = Array.isArray(body.data) ? body.data : [];
		// Filled rather than left sparse: a missing vector has to be *visible* to the check below, and
		// `filter` steps over the holes of a sparse array without calling the predicate.
		const vectors: Array<number[] | undefined> = new Array<number[] | undefined>(request.input.length).fill(undefined);
		rows.forEach((row, at) => {
			const vector = asVector(row?.embedding);
			if (!vector.length) {
				return;
			}
			const index = typeof row?.index === 'number' && Number.isInteger(row.index) && row.index >= 0 && row.index < vectors.length ? row.index : at;
			if (index >= vectors.length) {
				// A row nobody asked for: counting it would put a vector where no text was sent.
				return;
			}
			vectors[index] = vector;
		});
		const missing = vectors.filter((vector) => !vector);
		if (missing.length) {
			throw new Error(`embedding failed: ${missing.length} of ${request.input.length} texts came back without a vector`);
		}
		return vectors as number[][];
	} finally {
		clearTimeout(timer);
		request.signal?.removeEventListener('abort', abort);
	}
}

function asVector(value: unknown): number[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
	}
	return [];
}

/** Cosine similarity, and `0` for anything that cannot be compared (a zero vector, two lengths). */
export function cosine(left: readonly number[], right: readonly number[]): number {
	if (!left.length || !right.length || left.length !== right.length) {
		return 0;
	}
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let at = 0; at < left.length; at += 1) {
		dot += left[at]! * right[at]!;
		leftNorm += left[at]! * left[at]!;
		rightNorm += right[at]! * right[at]!;
	}
	if (leftNorm === 0 || rightNorm === 0) {
		return 0;
	}
	return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export interface VectorCandidate {
	/** The entry's uid, which is what the scan knows it by. */
	uid: number;
	vector: number[];
}

export interface VectorHit {
	uid: number;
	score: number;
}

/**
 * The entries closest to a query: above the threshold, best first, and never more than `max`, which
 * are upstream's own rules (its score threshold is a floor, not a cutoff on the count).
 */
export function rank(query: readonly number[], candidates: readonly VectorCandidate[], options: { threshold: number; max: number }): VectorHit[] {
	const hits: VectorHit[] = [];
	for (const candidate of candidates) {
		const score = cosine(query, candidate.vector);
		if (score >= options.threshold) {
			hits.push({ uid: candidate.uid, score });
		}
	}
	hits.sort((left, right) => right.score - left.score || left.uid - right.uid);
	return options.max > 0 ? hits.slice(0, options.max) : hits;
}

/** The query the search runs on: the newest few messages of the chat, oldest first. */
export function queryText(messages: readonly { text: string }[], limit: number): string {
	const wanted = limit > 0 ? messages.slice(0, limit) : messages;
	return wanted
		.map((message) => message.text.trim())
		.filter(Boolean)
		.reverse()
		.join('\n')
		.trim();
}
