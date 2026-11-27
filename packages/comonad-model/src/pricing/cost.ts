// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cost, as a pure function of usage and prices. The one rule that matters to the UI:
 * an unpriced model is `null` — displayed as "—" — never as $0.000. Free is a price,
 * and this way nobody has to tell the two apart by eye.
 */
import type { Pricing, UsageRecord } from '../types';

const PER_MILLION = 1_000_000;

/**
 * Estimated USD for one request. The cache terms fall back to the input price when they
 * have no price of their own, and the overlapping token counts are clamped so the four
 * terms always sum to the whole prompt exactly once.
 */
export function costFor(usage: UsageRecord, pricing?: Pricing | null): number | null {
	if (!pricing || !Number.isFinite(pricing.inPerM) || !Number.isFinite(pricing.outPerM)) {
		return null;
	}
	const inPerM = pricing.inPerM as number;
	const outPerM = pricing.outPerM as number;
	const cached = Math.min(usage.cached ?? 0, usage.input);
	const cacheWrite = Math.min(usage.cacheWrite ?? 0, usage.input - cached);
	const fresh = usage.input - cached - cacheWrite;
	const cachedInPerM = Number.isFinite(pricing.cachedInPerM) ? (pricing.cachedInPerM as number) : inPerM;
	const cacheWritePerM = Number.isFinite(pricing.cacheWritePerM) ? (pricing.cacheWritePerM as number) : inPerM;
	return (
		(fresh / PER_MILLION) * inPerM +
		(cached / PER_MILLION) * cachedInPerM +
		(cacheWrite / PER_MILLION) * cacheWritePerM +
		(usage.output / PER_MILLION) * outPerM
	);
}

/** Whether the catalog knows enough prices for `costFor` to produce a number. */
export function isPriced(pricing?: Pricing | null): boolean {
	return costFor({ input: 0, output: 0 }, pricing) !== null;
}
