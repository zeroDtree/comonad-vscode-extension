import { DEFAULT_ORDER, DEFAULT_PRESET_ID, ST_PROMPTS } from '../prompts';
import type { PromptItem, PromptOrderEntry, TavernPreset } from '../types';
import { blockToPrompt, PROMPT_BLOCKS } from './blocks';

/**
 * The preset templates Comonad ships, written here rather than copied from another tool: a preset is
 * samplers, formats, the nudge prompts and the prompt list, and these cover the ground a user usually
 * wants to start from.
 *
 * *Default* is the collection an unselected chat already uses: the built-in default, made a file only
 * when the user asks for an editable copy. The other four add a sampler and nudge set on top of it.
 *
 * Choosing one copies it into the library (`.comonad/presets/<id>.json`), where it is an ordinary
 * preset that can be edited or deleted; *Restore the template* writes it again from here. The
 * identifiers are Comonad's own, so a template never collides with a preset imported from elsewhere.
 */

export interface PresetTemplate {
	/** The library id and the file name the template is written as. */
	id: string;
	name: string;
	/** What it is for, shown beside the name in the picker. */
	description: string;
	/** Everything the preset holds; `raw` is empty, because nothing here came from another file. */
	preset: TavernPreset;
}

/** The nudge prompts every roleplay template starts with: our own wording for upstream's markers. */
const NUDGES = {
	new_chat_prompt: '[A new chat begins.]',
	new_group_chat_prompt: '[A new group chat begins.]',
	new_example_chat_prompt: '[An example chat follows.]',
	continue_nudge_prompt: '[Continue the last message without repeating any of it.]',
	group_nudge_prompt: '[Write the next reply only as {{char}}.]',
	send_if_empty: '',
} as const;

/** The shipped prompt definitions, copied so a template can be edited without touching the originals. */
function shippedPrompts(): PromptItem[] {
	return ST_PROMPTS.map((prompt) => ({ ...prompt }));
}

/** The shipped order, copied. */
function shippedOrder(): PromptOrderEntry[] {
	return DEFAULT_ORDER.map((entry) => ({ ...entry }));
}

/** The shipped list with one extra block in front of the chat history, and the order that places it. */
function withBlock(id: string): { prompts: PromptItem[]; promptOrder: PromptOrderEntry[] } {
	const prompts = shippedPrompts();
	const promptOrder = shippedOrder();
	const block = PROMPT_BLOCKS.find((entry) => entry.id === id);
	if (block) {
		const prompt = blockToPrompt(block);
		prompts.push(prompt);
		const at = promptOrder.findIndex((entry) => entry.identifier === 'chatHistory');
		promptOrder.splice(at < 0 ? promptOrder.length : at, 0, { identifier: prompt.identifier, enabled: true });
	}
	return { prompts, promptOrder };
}

/** The built-in Default: exactly the collection a chat with no preset selected sends. */
export function defaultPreset(): TavernPreset {
	return {
		id: DEFAULT_PRESET_ID,
		name: 'Default',
		prompts: shippedPrompts(),
		promptOrder: shippedOrder(),
		raw: {},
	};
}

function template(id: string, name: string, description: string, preset: Partial<TavernPreset>): PresetTemplate {
	return {
		id,
		name,
		description,
		preset: {
			id,
			name,
			maxContext: 8192,
			maxTokens: 300,
			wi_format: '{0}',
			scenario_format: '{{scenario}}',
			personality_format: '{{personality}}',
			names_behavior: 0,
			prompts: shippedPrompts(),
			promptOrder: shippedOrder(),
			...NUDGES,
			...preset,
			raw: {},
		},
	};
}

export const PRESET_TEMPLATES: readonly PresetTemplate[] = [
	{
		id: DEFAULT_PRESET_ID,
		name: 'Default',
		description: 'Comonad’s blocks, SillyTavern’s shipped prompts and their order — the same collection an unselected chat uses.',
		preset: defaultPreset(),
	},
	template('balanced', 'Balanced', 'The defaults, with a reply of a few paragraphs.', {
		temperature: 1,
		top_p: 1,
	}),
	template('creative', 'Creative', 'Looser sampling, longer replies, a nudge away from repetition.', {
		temperature: 1.25,
		top_p: 0.95,
		frequency_penalty: 0.2,
		maxTokens: 450,
	}),
	template('precise', 'Precise', 'Tighter sampling and short replies, for a scene that keeps its footing.', {
		temperature: 0.6,
		top_p: 0.9,
		maxTokens: 250,
	}),
	template('long-form', 'Long-form', 'For scenes that are written out: a length block and room to use it.', {
		temperature: 1.05,
		top_p: 1,
		maxTokens: 900,
		...withBlock('comonad-length'),
	}),
];

/** The template with this id, if the library preset came from one. */
export function presetTemplate(id: string): PresetTemplate | undefined {
	return PRESET_TEMPLATES.find((entry) => entry.id === id || entry.preset.id === id);
}
