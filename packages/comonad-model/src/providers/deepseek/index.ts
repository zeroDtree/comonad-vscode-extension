// SPDX-License-Identifier: AGPL-3.0-only
/**
 * DeepSeek: an openai-chat vendor whose quirks are all declarative — thinking switches
 * off through its own `thinking` field (`thinkingOff: 'thinking'`), cache hits report
 * through `prompt_cache_hit_tokens` (read by the wire's dual dialect mapping), and the
 * reasoning chain must come back with tools (echoed generically). Prices are DeepSeek's
 * list rates in USD per million tokens — **peak** hours, cache-miss input, so a cost is
 * an upper bound (off-peak is half) while `cachedInPerM` keeps long agent loops honest.
 */
import type { ProviderDefinition } from '../../config/schema';

export const deepseekProvider: ProviderDefinition = {
	apiVersion: 1,
	id: 'deepseek',
	protocol: 'openai-chat',
	keyEnv: 'DEEPSEEK_API_KEY',
	defaults: {
		baseURL: 'https://api.deepseek.com',
		options: { thinkingOff: 'thinking', topEffort: 'max', includeUsage: true },
	},
	modelCatalog: [
		{
			id: 'deepseek-flash',
			contextWindow: 1_048_576,
			pricing: { inPerM: 0.3, cachedInPerM: 0.006, outPerM: 1.2 },
		},
		{
			id: 'deepseek-v4-pro',
			contextWindow: 1_048_576,
			pricing: { inPerM: 1.32, cachedInPerM: 0.044, outPerM: 3.96 },
		},
	],
};
