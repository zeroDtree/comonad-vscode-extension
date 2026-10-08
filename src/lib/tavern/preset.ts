import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { GENERATION_TRIGGERS, INJECTION_POSITION, type LogitBiasSet, type PromptItem, type PromptOrderEntry, type TavernPreset } from './types';

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
		// Upstream's *Triggers*: a list of the generation types, and an empty list means every type, so
		// an empty array is kept exactly as it stands rather than collapsed to `undefined`.
		injection_trigger: Array.isArray(raw.injection_trigger)
			? raw.injection_trigger.filter(
					(name): name is string => typeof name === 'string' && (GENERATION_TRIGGERS as readonly string[]).includes(name),
				)
			: undefined,
		forbid_overrides: boolAt(raw, 'forbid_overrides'),
		extension: boolAt(raw, 'extension'),
	};
}

/**
 * The order blocks a preset ships, split the way upstream keys them: the default block, which every
 * other character falls back to, and one block per character. A block whose `character_id` is a
 * number other than the default is left alone — that is a SillyTavern character index, which means
 * nothing here — and rides along in `raw` so a save never drops it.
 */
function readOrders(value: unknown): { fallback?: PromptOrderEntry[]; byCharacter: Record<string, PromptOrderEntry[]> } {
	const byCharacter: Record<string, PromptOrderEntry[]> = {};
	if (!Array.isArray(value)) {
		return { byCharacter };
	}
	const blocks = value.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object');
	const readEntries = (order: unknown): PromptOrderEntry[] =>
		Array.isArray(order)
			? order
					.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
					.map((entry) => ({ identifier: String(entry.identifier ?? ''), enabled: entry.enabled !== false }))
					.filter((entry) => entry.identifier.length > 0)
			: [];
	let fallback: PromptOrderEntry[] | undefined;
	for (const block of blocks) {
		const entries = readEntries(block.order);
		if (!entries.length) {
			continue;
		}
		const key = typeof block.character_id === 'string' ? block.character_id.trim() : '';
		if (key) {
			byCharacter[key] = entries;
		} else if (Number(block.character_id) === DEFAULT_CHARACTER_ID) {
			fallback = entries;
		}
	}
	return { fallback, byCharacter };
}

/** Parses a preset document. `name` is the display name, `id` the stable key. */
export function parsePreset(json: string, name: string, id: string): TavernPreset {
	const parsed = JSON.parse(json) as unknown;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('the preset is not a JSON object');
	}
	const raw = parsed as Record<string, unknown>;
	const orders = readOrders(raw.prompt_order);
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
		// The nudge prompts: what upstream sends when there is nothing else to send.
		new_chat_prompt: textAt(raw, 'new_chat_prompt'),
		new_group_chat_prompt: textAt(raw, 'new_group_chat_prompt'),
		new_example_chat_prompt: textAt(raw, 'new_example_chat_prompt'),
		continue_nudge_prompt: textAt(raw, 'continue_nudge_prompt'),
		group_nudge_prompt: textAt(raw, 'group_nudge_prompt'),
		send_if_empty: textAt(raw, 'send_if_empty'),
		seed: numberAt(raw, 'seed'),
		logitBiasSelected: textAt(raw, 'bias_preset_selected'),
		stream: boolAt(raw, 'stream_openai'),
		maxContextUnlocked: boolAt(raw, 'max_context_unlocked'),
		useSysprompt: boolAt(raw, 'use_sysprompt'),
		promptOrder: orders.fallback,
		raw,
	};
	if (Object.keys(orders.byCharacter).length) {
		preset.promptOrders = orders.byCharacter;
	}
	const bias = raw.logit_bias;
	if (Array.isArray(bias)) {
		const sets = bias.filter(
			(entry): entry is LogitBiasSet =>
				Boolean(entry) && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string',
		);
		if (sets.length) {
			preset.logitBias = sets;
		}
	}
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
	set('new_chat_prompt', preset.new_chat_prompt);
	set('new_group_chat_prompt', preset.new_group_chat_prompt);
	set('new_example_chat_prompt', preset.new_example_chat_prompt);
	set('continue_nudge_prompt', preset.continue_nudge_prompt);
	set('group_nudge_prompt', preset.group_nudge_prompt);
	set('send_if_empty', preset.send_if_empty);
	set('seed', preset.seed);
	set('bias_preset_selected', preset.logitBiasSelected);
	set('logit_bias', preset.logitBias);
	set('stream_openai', preset.stream);
	set('max_context_unlocked', preset.maxContextUnlocked);
	set('use_sysprompt', preset.useSysprompt);
	if (preset.prompts) {
		set('prompts', preset.prompts);
	}
	if (preset.promptOrder || preset.promptOrders) {
		// The default block comes first, then the per-character ones, and any block we did not
		// understand — a SillyTavern character index, say — is kept exactly where it was.
		const unknown = Array.isArray(preset.raw.prompt_order)
			? (preset.raw.prompt_order as unknown[]).filter((block) => {
					const id = block && typeof block === 'object' ? (block as { character_id?: unknown }).character_id : undefined;
					return typeof id !== 'string' && Number(id) !== DEFAULT_CHARACTER_ID;
				})
			: [];
		const blocks: unknown[] = [];
		if (preset.promptOrder) {
			blocks.push({ character_id: DEFAULT_CHARACTER_ID, order: preset.promptOrder });
		}
		for (const [character, order] of Object.entries(preset.promptOrders ?? {})) {
			blocks.push({ character_id: character, order });
		}
		set('prompt_order', [...blocks, ...unknown]);
	}
	return JSON.stringify(raw, null, 4);
}

/** The sampler settings one turn sends: what a preset contributes that the endpoint understands. */
export interface PresetSamplers {
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	seed?: number;
	logitBias?: Record<string, number>;
}

/**
 * The sampler settings a preset contributes to a request. Only the ones an OpenAI-compatible
 * endpoint understands are sent — the rest (Kobold's `top_k`, `top_a`, `min_p`, `repetition_penalty`)
 * are kept in the file so a preset round-trips, but a chat-completions endpoint would refuse them.
 * `openai_max_tokens` is the reply budget, not the context size, which is what `max_tokens` means.
 */
export function presetSamplers(preset: TavernPreset | undefined): PresetSamplers {
	if (!preset) {
		return {};
	}
	const selected = preset.logitBiasSelected
		? preset.logitBias?.find((entry) => entry.name === preset.logitBiasSelected || entry.id === preset.logitBiasSelected)
		: undefined;
	// A field the preset does not set is left out entirely, so the request carries only what it asks for.
	const candidates: Record<string, unknown> = {
		temperature: preset.temperature,
		topP: preset.top_p,
		maxTokens: preset.maxTokens,
		frequencyPenalty: preset.frequency_penalty,
		presencePenalty: preset.presence_penalty,
		seed: preset.seed,
		logitBias: selected && Object.keys(selected.value ?? {}).length ? { ...selected.value } : undefined,
	};
	return Object.fromEntries(Object.entries(candidates).filter(([, value]) => value !== undefined)) as PresetSamplers;
}
