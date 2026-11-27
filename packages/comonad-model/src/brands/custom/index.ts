// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Custom: the blank openai-chat brand for a user-defined endpoint. Everything — base URL,
 * key, paths, options — comes from the provider instance; the brand contributes nothing
 * but the wire it speaks.
 */
import type { BrandDefinition } from '../../config/schema';

export const customBrand: BrandDefinition = {
	apiVersion: 1,
	id: 'custom',
	protocol: 'openai-chat',
	defaults: {},
};
