// SPDX-License-Identifier: AGPL-3.0-only
/** OpenAI: the reference openai-chat brand. The wire is its own dialect, so no quirks. */
import type { BrandDefinition } from '../../config/schema';

export const openaiBrand: BrandDefinition = {
	apiVersion: 1,
	id: 'openai',
	protocol: 'openai-chat',
	defaults: {
		baseURL: 'https://api.openai.com/v1',
		options: { includeUsage: true },
	},
};
