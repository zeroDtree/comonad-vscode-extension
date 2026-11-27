// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OpenCode Go: speaks openai-chat at its own paths — chat and models live at independent
 * locations, not a `/models` suffix of the chat URL — and stamps every request with the
 * session header from the invocation context. The host origin is per-connection (the
 * instance configures `base`); only the paths are the brand's.
 */
import type { BrandDefinition } from '../../config/schema';

export const opencodeGoBrand: BrandDefinition = {
	apiVersion: 1,
	id: 'opencode-go',
	protocol: 'openai-chat',
	defaults: {
		chatPath: '/inference/go/openai/v1/chat/completions',
		modelsPath: '/inference/go/v1/models',
		options: { includeUsage: true },
	},
	headerHooks: [
		(headers, ctx) => {
			const session = ctx.attributes?.sessionId ?? ctx.conversationId;
			if (session !== undefined && session !== '') {
				headers['x-opencode-session'] = String(session);
			}
		},
	],
};
