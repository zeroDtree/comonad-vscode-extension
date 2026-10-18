// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The generation types a chat can ask for. These are Comonad's own — `/continue`, `/swipe` and the
 * Send menu are built-in commands and real generations of the agent — and they share their names with
 * SillyTavern's `GENERATION_TYPE_TRIGGERS`, because a world-info entry names the same types to say
 * when it belongs in a request. Pure module: no `vscode`, no `cordis`.
 */

export const GENERATION_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'] as const;

export type GenerationTrigger = (typeof GENERATION_TRIGGERS)[number];

/** How each type reads in the UI, in upstream's wording. */
export const GENERATION_LABELS: Record<GenerationTrigger, string> = {
	normal: 'Normal',
	continue: 'Continue',
	impersonate: 'Impersonate',
	swipe: 'Swipe',
	regenerate: 'Regenerate',
	quiet: 'Quiet',
};

export function generationTrigger(value: unknown): GenerationTrigger {
	return GENERATION_TRIGGERS.includes(value as GenerationTrigger) ? (value as GenerationTrigger) : 'normal';
}
