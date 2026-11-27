// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The fallback chain: which provider instances to try after one fails for good. The
 * chain is walked only while nothing has been shown to the consumer — once a stream
 * produced output there is nothing safe left to fall back to.
 */

/**
 * The instances to attempt, starting with the requested one, then its fallback list
 * with duplicates, the starting instance itself, and any cycle removed. A config that
 * routes A → B → A becomes a single A → B walk.
 */
export function fallbackChain(start: string, fallback: readonly string[]): string[] {
	const chain = [start];
	const seen = new Set([start]);
	for (const id of fallback) {
		if (!seen.has(id)) {
			seen.add(id);
			chain.push(id);
		}
	}
	return chain;
}
