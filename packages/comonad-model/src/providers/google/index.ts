// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Google, on its native `gemini` wire: the `models/` prefix its listings carry, the
 * non-chat models its listing also contains, and thought signatures — which on this
 * wire ride natively on `functionCall` parts. The `googleSignatures` hook stays for
 * instances that re-point at the OpenAI-compatible layer via `protocol: "openai-chat"`;
 * it is a no-op on native gemini bodies.
 */
import type { ProviderDefinition } from '../../config/schema';
import { googleSignatures } from './signatures';

export { SKIP_SIGNATURE, demandsSignature, googleSignatures } from './signatures';

export const googleProvider: ProviderDefinition = {
	apiVersion: 1,
	id: 'google',
	protocol: 'gemini',
	keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
	defaults: {
		baseURL: 'https://generativelanguage.googleapis.com/v1beta',
		// Gemini 3's ladder stops at high (minimal/low/medium/high). Wire-specific knobs
		// (`thinkingOff`, `includeUsage`) belong to an instance that re-points at the
		// OpenAI-compatible layer, where the openai-chat schema validates them.
		options: { topEffort: 'high' },
	},
	// Gemini reports its native `models/<id>` form, and lists image, computer-use, research and
	// embedding models that cannot run a chat turn — both are data, so edit them freely.
	modelRules: {
		prefix: 'models/',
		skip: 'computer-use|deep-research|antigravity|aqa|-image|imagen|veo|embedding|-tts|live',
	},
	modelCatalog: [{ id: 'gemini-3.8-flash', contextWindow: 1_048_576 }],
	requestHooks: [googleSignatures],
};
