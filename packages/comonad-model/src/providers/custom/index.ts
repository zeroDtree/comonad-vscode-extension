// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Custom: the blank openai-chat vendor for a user-defined endpoint. Everything — base URL,
 * key, paths, options — comes from the provider instance; the vendor contributes nothing
 * but the wire it speaks.
 */
import type { ProviderDefinition } from '../../config/schema';

export const customProvider: ProviderDefinition = {
	apiVersion: 1,
	id: 'custom',
	protocol: 'openai-chat',
	defaults: {},
};
