// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Anthropic: the reference anthropic-messages vendor. The wire's fixed facts (the
 * version header, the `x-api-key` scheme, mandatory max_tokens) ride as vendor data.
 * Prices are Anthropic's first-party list rates in USD per million tokens; a cache
 * write costs 1.25× input and a cache read is the published discount. Facts come from
 * the provider's own pricing page — edit freely.
 */
import type { ProviderDefinition } from '../../config/schema';

export const anthropicProvider: ProviderDefinition = {
	apiVersion: 1,
	id: 'anthropic',
	protocol: 'anthropic-messages',
	defaults: {
		baseURL: 'https://api.anthropic.com',
		auth: { kind: 'header', name: 'x-api-key' },
		headers: { 'anthropic-version': '2023-06-01' },
		// The effort ladder runs low…max on this wire.
		options: { topEffort: 'max' },
	},
	modelCatalog: [
		{
			id: 'claude-opus-5-5',
			contextWindow: 1_000_000,
			pricing: { inPerM: 4, cachedInPerM: 0.2, cacheWritePerM: 5, outPerM: 20 },
		},
		{
			id: 'claude-sonnet-5-5',
			contextWindow: 1_000_000,
			pricing: { inPerM: 2, cachedInPerM: 0.1, cacheWritePerM: 2.5, outPerM: 10 },
		},
		{
			id: 'claude-haiku-5-5',
			contextWindow: 1_000_000,
			pricing: { inPerM: 0.1, cacheWritePerM: 0.125, outPerM: 0.5 },
		},
		{
			id: 'claude-fable-5-2',
			contextWindow: 1_000_000,
			pricing: { inPerM: 8, cachedInPerM: 0.2, cacheWritePerM: 10, outPerM: 40 },
		},
	],
};
