// SPDX-License-Identifier: AGPL-3.0-only
/** OpenAI: the reference openai-chat vendor. The wire is its own dialect, so no quirks. */
import type { ProviderDefinition } from '../../config/schema';

export const openaiProvider: ProviderDefinition = {
	apiVersion: 1,
	id: 'openai',
	protocol: 'openai-chat',
	defaults: {
		baseURL: 'https://api.openai.com/v1',
		options: { includeUsage: true },
	},
};
