// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The model catalog: live endpoint listings shaped by data rules (prefix stripping,
 * skip lists) and merged with shipped facts, cached briefly so a menu opens instantly
 * and a key change or TTL refreshes it. "Providers disagree on the shape" is handled
 * here, once, not in every vendor.
 */
import type { ResolvedProvider } from '../config/schema';
import type { ModelInfo } from '../types';

/** Canonicalizes the ids an endpoint lists: drop the skip-list, strip the display prefix. */
export function shapeModelIds(ids: readonly string[], rules: { prefix: string; skip?: RegExp }): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (rules.skip?.test(id)) {
			continue;
		}
		const shaped = rules.prefix && id.startsWith(rules.prefix) ? id.slice(rules.prefix.length) : id;
		if (shaped && !seen.has(shaped)) {
			seen.add(shaped);
			out.push(shaped);
		}
	}
	// Endpoint order preserved: the menu lists what the provider reports, in its own order.
	return out;
}

interface CatalogEntry {
	models: ModelInfo[];
	at: number;
	keyFingerprint: string;
}

/** A short non-cryptographic fingerprint, so a key change misses the cache without a hook. */
function fingerprint(key: string | undefined): string {
	if (!key) {
		return 'none';
	}
	let hash = 5381;
	for (let index = 0; index < key.length; index++) {
		hash = ((hash << 5) + hash + key.charCodeAt(index)) | 0;
	}
	return `${key.length}:${(hash >>> 0).toString(36)}`;
}

export class ModelCatalog {
	private readonly cache = new Map<string, CatalogEntry>();

	constructor(private readonly ttlMs: number = 10 * 60_000) {}

	/** The shaped, fact-merged models an instance offers, live-fetched at most once per TTL. */
	async list(
		providerId: string,
		wire: ResolvedProvider,
		fetchIds: () => Promise<string[]>,
		now: () => number = Date.now,
	): Promise<ModelInfo[]> {
		const keyFingerprint = fingerprint(wire.key);
		const cached = this.cache.get(providerId);
		if (cached && cached.keyFingerprint === keyFingerprint && now() - cached.at < this.ttlMs) {
			return cached.models;
		}
		const ids = shapeModelIds(await fetchIds(), wire.modelRules);
		const models = ids.map((id) => {
			const facts = wire.models.get(id);
			return { ...facts, id, label: facts?.label ?? id };
		});
		this.cache.set(providerId, { models, at: now(), keyFingerprint });
		return models;
	}

	invalidate(providerId?: string): void {
		if (providerId === undefined) {
			this.cache.clear();
		} else {
			this.cache.delete(providerId);
		}
	}
}
