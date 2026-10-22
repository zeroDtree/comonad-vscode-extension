// SPDX-License-Identifier: AGPL-3.0-only
import type { ReasoningEffort } from './types';

/** A persisted or hand-edited value read back as a level; anything else is `auto`. */
export function asReasoningEffort(value: unknown): ReasoningEffort {
	return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'max' ? value : 'auto';
}

/**
 * The deepest thinking level an endpoint accepts. `xhigh` is wire-only: it sits between `high` and
 * `max` on some providers and is never offered in the menu, but a profile may declare it as its top.
 */
export type EffortTop = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Thinking depth, in the order providers rank it. `none` and `auto` are modes, not depths. */
const DEPTH: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

/**
 * A pick above the endpoint's ceiling runs at the ceiling; every other pick is sent unchanged, and
 * so is one the table does not know. `auto` is the provider's own default, which no ceiling applies
 * to, and `none` is not a depth at all.
 */
export function limitEffort(effort: ReasoningEffort | string, top: EffortTop | undefined): string {
	if (!top || effort === 'auto' || effort === 'none') {
		return effort;
	}
	const depth = DEPTH[effort];
	const ceiling = DEPTH[top];
	return depth === undefined || ceiling === undefined || depth <= ceiling ? effort : top;
}
