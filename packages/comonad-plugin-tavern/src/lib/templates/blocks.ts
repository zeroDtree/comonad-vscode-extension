// SPDX-License-Identifier: AGPL-3.0-only
import type { PromptItem } from '../types';

/**
 * The prompt blocks Comonad offers to drop into a preset, written here rather than copied from
 * another tool. Upstream's *Add prompt* gives you an empty block; these are the blocks that make a
 * chat-completion preset worth starting from, and each one is a single instruction the model can
 * actually follow. A block is inserted with its own identifier, so it is editable and movable like
 * any other.
 */

export interface PromptBlockTemplate {
	/** The identifier a block is inserted with: stable, and unlike any shipped block's. */
	id: string;
	name: string;
	/** What it does, shown beside the name in the menu. */
	description: string;
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export const PROMPT_BLOCKS: readonly PromptBlockTemplate[] = [
	{
		id: 'comonad-style',
		name: 'Writing style',
		description: 'Sentence length, tense and point of view.',
		role: 'system',
		content:
			'Write in the past tense, third person limited to {{char}}. Vary sentence length; keep paragraphs short. No headings, no lists, no bullet points.',
	},
	{
		id: 'comonad-in-character',
		name: 'Stay in character',
		description: 'Never break the scene, never speak for the user.',
		role: 'system',
		content:
			'Stay in character as {{char}} at all times. Never write {{user}}\u2019s words, thoughts or actions, and never mention that this is a story, a model, or a prompt.',
	},
	{
		id: 'comonad-no-meta',
		name: 'No meta commentary',
		description: 'Nothing outside the fiction.',
		role: 'system',
		content:
			'Reply with the scene itself and nothing else: no preamble, no summary, no out-of-character notes, no options for {{user}} to choose from.',
	},
	{
		id: 'comonad-length',
		name: 'Length and pacing',
		description: 'How long a reply is, and how much time it covers.',
		role: 'system',
		content:
			'Write about two paragraphs. Move the scene forward by one beat, and end on something {{user}} can answer.',
	},
	{
		id: 'comonad-agency',
		name: '{{char}} agency',
		description: 'The character wants things of their own.',
		role: 'system',
		content:
			'{{char}} has their own goals, moods and opinions, and acts on them. They may disagree, refuse, or change the subject rather than going along with {{user}}.',
	},
	{
		id: 'comonad-continuity',
		name: 'Scene continuity',
		description: 'Keep track of what has already happened.',
		role: 'system',
		content:
			'Keep the place, the time of day, who is present and what has already been said consistent with the chat so far. Do not restate what {{user}} already knows.',
	},
	{
		id: 'comonad-show',
		name: 'Show, do not tell',
		description: 'Concrete detail instead of named feelings.',
		role: 'system',
		content:
			'Show feeling through what {{char}} does and notices, not by naming the emotion. Use concrete detail of the place and the body rather than adjectives about the mood.',
	},
	{
		id: 'comonad-format',
		name: 'Reply format',
		description: 'How the reply is laid out on the page.',
		role: 'system',
		content:
			'Speech in double quotes, actions and description in plain prose. Do not prefix lines with {{char}}\u2019s name, and do not use markdown emphasis.',
	},
];

/** One block as a prompt the prompt list can hold. */
export function blockToPrompt(block: PromptBlockTemplate): PromptItem {
	return {
		identifier: block.id,
		name: block.name,
		role: block.role,
		system_prompt: block.role === 'system',
		content: block.content,
	};
}
