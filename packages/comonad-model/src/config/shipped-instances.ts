// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The shipped provider instances: the connections every install starts with. Model facts
 * (windows, prices) are not duplicated here — they live on each brand's `modelCatalog`,
 * merged by model id at resolve time. DeepSeek Flash comes first, so `auto` runs on it.
 */
import type { ProviderInstanceConfig } from './schema';

export const SHIPPED_INSTANCES: readonly ProviderInstanceConfig[] = [
	{
		id: 'deepseek',
		brand: 'deepseek',
		base: 'https://api.deepseek.com',
		model: 'deepseek-flash',
		keyEnv: 'DEEPSEEK_API_KEY',
	},
	{
		id: 'deepseek-pro',
		brand: 'deepseek',
		base: 'https://api.deepseek.com',
		model: 'deepseek-v4-pro',
		keyEnv: 'DEEPSEEK_API_KEY',
	},
	{
		id: 'gemini',
		brand: 'google',
		base: 'https://generativelanguage.googleapis.com/v1beta',
		model: 'gemini-3.8-flash',
		keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
	},
];
