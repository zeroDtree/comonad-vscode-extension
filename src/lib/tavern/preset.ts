import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { INJECTION_POSITION, type PromptItem, type PromptOrderEntry, type TavernPreset } from './types';

/**
 * OpenAI presets, read and written under their SillyTavern names: sampler settings, the prompt
 * list, and the per-character prompt order. An unknown key is kept in `raw` so a save round-trips a
 * preset this build does not fully understand.
 */

/** The SillyTavern character id whose order is the default for every other character. */
export const DEFAULT_CHARACTER_ID = 100_000;

const SAMPLER_KEYS = [
	'temperature',
	'top_p',
	'top_k',
	'top_a',
	'min_p',
	'frequency_penalty',
	'presence_penalty',
	'repetition_penalty',
] as const;

export function presetId(file: string): string {
	const base = basename(file);
	const stem = base.slice(0, base.length - extname(base).length);
	return stem.replace(/[^\w.-]+/g, '-') || 'preset';
}

function numberAt(source: Record<string, unknown>, key: string): number | undefined {
	const value = source[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function textAt(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === 'string' ? value : undefined;
}

function boolAt(source: Record<string, unknown>, key: string): boolean | undefined {
	const value = source[key];
	return typeof value === 'boolean' ? value : undefined;
}

/** One prompt as stored in a preset: unknown keys are dropped, missing roles default to `system`. */
export function normalisePrompt(value: unknown): PromptItem | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const raw = value as Record<string, unknown>;
	const identifier = textAt(raw, 'identifier');
	if (!identifier) {
		return null;
	}
	const role = raw.role === 'user' || raw.role === 'assistant' || raw.role === 'system' ? raw.role : 'system';
	const injection = numberAt(raw, 'injection_position');
	return {
		identifier,
		name: textAt(raw, 'name'),
		role,
		content: textAt(raw, 'content'),
		system_prompt: boolAt(raw, 'system_prompt'),
		marker: boolAt(raw, 'marker'),
		position: raw.position === 'start' || raw.position === 'end' ? raw.position : undefined,
		injection_position: injection === INJECTION_POSITION.absolute ? INJECTION_POSITION.absolute : INJECTION_POSITION.relative,
		injection_depth: numberAt(raw, 'injection_depth'),
		injection_order: numberAt(raw, 'injection_order'),
		forbid_overrides: boolAt(raw, 'forbid_overrides'),
		extension: boolAt(raw, 'extension'),
	};
}

/** The order block a preset ships: the `DEFAULT_CHARACTER_ID` entry, else the first one present. */
function readOrder(value: unknown): PromptOrderEntry[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const blocks = value.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object');
	const chosen =
		blocks.find((block) => Number(block.character_id) === DEFAULT_CHARACTER_ID) ??
		blocks.find((block) => Array.isArray(block.order)) ??
		blocks[0];
	if (!chosen || !Array.isArray(chosen.order)) {
		return undefined;
	}
	return chosen.order
		.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
		.map((entry) => ({ identifier: String(entry.identifier ?? ''), enabled: entry.enabled !== false }))
		.filter((entry) => entry.identifier.length > 0);
}

/** Parses a preset document. `name` is the display name, `id` the stable key. */
export function parsePreset(json: string, name: string, id: string): TavernPreset {
	const parsed = JSON.parse(json) as unknown;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('the preset is not a JSON object');
	}
	const raw = parsed as Record<string, unknown>;
	const preset: TavernPreset = {
		id,
		name,
		maxContext: numberAt(raw, 'openai_max_context'),
		maxTokens: numberAt(raw, 'openai_max_tokens'),
		wi_format: textAt(raw, 'wi_format'),
		scenario_format: textAt(raw, 'scenario_format'),
		personality_format: textAt(raw, 'personality_format'),
		impersonation_prompt: textAt(raw, 'impersonation_prompt'),
		names_behavior: numberAt(raw, 'names_behavior'),
		assistant_prefill: textAt(raw, 'assistant_prefill'),
		squash_system_messages: boolAt(raw, 'squash_system_messages'),
		promptOrder: readOrder(raw.prompt_order),
		raw,
	};
	for (const key of SAMPLER_KEYS) {
		const value = numberAt(raw, key);
		if (value !== undefined) {
			preset[key] = value;
		}
	}
	if (Array.isArray(raw.prompts)) {
		const prompts = raw.prompts.map(normalisePrompt).filter((item): item is PromptItem => item !== null);
		if (prompts.length) {
			preset.prompts = prompts;
		}
	}
	return preset;
}

/** Loads one preset file. */
export async function loadPreset(file: string): Promise<TavernPreset> {
	const json = await readFile(file, 'utf8');
	return parsePreset(json, presetId(file), presetId(file));
}

/** Writes a preset back, keeping every key it arrived with. */
export function presetToJson(preset: TavernPreset): string {
	const raw: Record<string, unknown> = { ...preset.raw };
	const set = (key: string, value: unknown): void => {
		if (value === undefined) {
			delete raw[key];
		} else {
			raw[key] = value;
		}
	};
	for (const key of SAMPLER_KEYS) {
		set(key, preset[key]);
	}
	set('openai_max_context', preset.maxContext);
	set('openai_max_tokens', preset.maxTokens);
	set('wi_format', preset.wi_format);
	set('scenario_format', preset.scenario_format);
	set('personality_format', preset.personality_format);
	set('impersonation_prompt', preset.impersonation_prompt);
	set('names_behavior', preset.names_behavior);
	set('assistant_prefill', preset.assistant_prefill);
	set('squash_system_messages', preset.squash_system_messages);
	if (preset.prompts) {
		set('prompts', preset.prompts);
	}
	if (preset.promptOrder) {
		set('prompt_order', [{ character_id: DEFAULT_CHARACTER_ID, order: preset.promptOrder }]);
	}
	return JSON.stringify(raw, null, 4);
}

/**
 * The sampler settings a preset contributes to a request. `openai_max_tokens` is the reply budget,
 * not the context size, which is what the request's `max_tokens` means.
 */
export function presetSamplers(preset: TavernPreset | undefined): { temperature?: number; topP?: number; maxTokens?: number } {
	if (!preset) {
		return {};
	}
	return { temperature: preset.temperature, topP: preset.top_p, maxTokens: preset.maxTokens };
}
