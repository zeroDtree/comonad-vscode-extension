// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The shipped providers: what every install starts with. Model facts (windows, prices) and
 * `keyEnv` live on each provider's definition, not here — an entry only says which provider
 * it is, where to reach it, and which model a bare ref runs. DeepSeek comes first, so `auto`
 * runs on DeepSeek Flash.
 */
import type { ProviderEntry } from './schema';

export const SHIPPED_PROVIDERS: readonly ProviderEntry[] = [
	{
		id: 'deepseek',
		base: 'https://api.deepseek.com',
		model: 'deepseek-flash',
	},
	{
		id: 'google',
		base: 'https://generativelanguage.googleapis.com/v1beta',
		model: 'gemini-3.8-flash',
	},
];
