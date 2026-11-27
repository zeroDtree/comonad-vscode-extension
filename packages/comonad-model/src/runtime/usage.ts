// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Usage accumulation. The cache fields keep their presence semantics across sums: a
 * provider either reports cache statistics or it does not, and a session total knows
 * the difference between "no hits" and "no cache reporting".
 */
import type { UsageRecord } from '../types';

/** Adds two records; an absent cache field contributes nothing and stays absent unless any term reported. */
export function addUsage(left: UsageRecord | undefined, right: UsageRecord | undefined): UsageRecord | undefined {
	if (!left) {
		return right ? { ...right } : undefined;
	}
	if (!right) {
		return left;
	}
	const total: UsageRecord = { input: left.input + right.input, output: left.output + right.output };
	const cached = sumReported(left.cached, right.cached);
	if (cached !== undefined) {
		total.cached = cached;
	}
	const cacheWrite = sumReported(left.cacheWrite, right.cacheWrite);
	if (cacheWrite !== undefined) {
		total.cacheWrite = cacheWrite;
	}
	return total;
}

function sumReported(left: number | undefined, right: number | undefined): number | undefined {
	if (left === undefined && right === undefined) {
		return undefined;
	}
	return (left ?? 0) + (right ?? 0);
}
