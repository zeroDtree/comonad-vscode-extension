// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Google's thought signatures, the one quirk Google's OpenAI-compatible layer enforces:
 * Gemini 3 refuses a request whose function call in the history carries no signature, so
 * a call that never had one is sent back with Google's own bypass instead. The signature
 * itself travels opaque on `extra_content`; this hook only supplies the fallback.
 */
import type { RequestHook } from '../../config/schema';

/**
 * Google's own last resort for a function call whose thought signature is unknown — one written
 * before signatures were kept, or by another provider. Gemini 3 refuses the request without
 * *something* in the field, so the placeholder is sent rather than losing the turn.
 */
export const SKIP_SIGNATURE: Record<string, unknown> = {
	google: { thought_signature: 'skip_thought_signature_validator' },
};

/**
 * Whether this model demands a thought signature back with every function call. Gemini 3 and
 * later do; 2.5's signatures are optional, and inventing one there would only cost performance.
 */
export function demandsSignature(model: string): boolean {
	return /(^|[^a-z])gemini-[3-9]/i.test(model);
}

/** Injects the bypass where a history call has no signature of its own. */
export const googleSignatures: RequestHook = (body) => {
	const model = typeof body.model === 'string' ? body.model : '';
	if (!demandsSignature(model)) {
		return;
	}
	const messages = body.messages;
	if (!Array.isArray(messages)) {
		return;
	}
	for (const message of messages) {
		if (!message || typeof message !== 'object') {
			continue;
		}
		const entry = message as Record<string, unknown>;
		if (entry.role !== 'assistant' || !Array.isArray(entry.tool_calls)) {
			continue;
		}
		for (const raw of entry.tool_calls) {
			const call = raw as Record<string, unknown>;
			if (call && !call.extra_content) {
				call.extra_content = SKIP_SIGNATURE;
			}
		}
	}
};
