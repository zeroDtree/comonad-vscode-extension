import type { Message } from '../types';
import { parseExamples } from './macro';
import { IDENTITY_PROMPT, isInChat, type ActivePrompt } from './prompts';
import { parseDecorators } from './lore';
import { WI_ROLE } from './types';

/**
 * The assembler: turns the prompt collection, the card, the world books and the conversation into
 * the message list a request is made of. The order is SillyTavern's — every enabled block sits where
 * the prompt list puts it, in-chat injections are spliced into the history by depth, and the
 * post-history instructions land after the history because that is where the list puts them.
 *
 * Comonad's own identity block leads, whatever the preset says: the agent's mode, approval,
 * instructions and tools must survive whatever character the chat wears.
 */

export interface AssembleBlocks {
	/** Comonad's own system prompt. */
	identity: string;
	charDescription?: string;
	charPersonality?: string;
	scenario?: string;
	personaDescription?: string;
	/** World info in front of the character blocks. */
	worldInfoBefore?: string;
	/** World info behind the character blocks. */
	worldInfoAfter?: string;
	/** The card's dialogue examples, as one `<START>`-separated string. */
	examples?: string;
	/** World-info entries that asked to sit at the edges of the example block. */
	examplesBefore?: readonly string[];
	examplesAfter?: readonly string[];
	/** World-info entries that asked to be injected into the chat at a depth. */
	atDepth?: readonly { depth: number; role: number; content: string }[];
}

export interface AssembleOptions {
	/** `wi_format`: how a world-info block is wrapped, `{0}` being the text. */
	wiFormat?: string;
	/** Resolves macros in every block the prompt list supplies. */
	substitute?: (text: string) => string;
	/** What an empty role means for a prompt the list does not characterise. */
	fallbackRole?: 'system' | 'user' | 'assistant';
}

/** Fills `{0}` the way SillyTavern's `stringFormat` does. */
export function formatWorldInfo(value: string | undefined, format: string | undefined): string {
	const text = (value ?? '').trim();
	if (!text) {
		return '';
	}
	const shape = (format ?? '').trim();
	return shape.includes('{0}') ? shape.replace(/\{0\}/g, text) : shape ? `${shape}${text}` : text;
}

/** The content of a marker block, or `undefined` when the chat has nothing to put there. */
function markerContent(identifier: string, blocks: AssembleBlocks, options: AssembleOptions): string | undefined {
	switch (identifier) {
		case IDENTITY_PROMPT:
			return blocks.identity;
		case 'worldInfoBefore':
			return formatWorldInfo(blocks.worldInfoBefore, options.wiFormat);
		case 'worldInfoAfter':
			return formatWorldInfo(blocks.worldInfoAfter, options.wiFormat);
		case 'charDescription':
			return blocks.charDescription;
		case 'charPersonality':
			return blocks.charPersonality;
		case 'scenario':
			return blocks.scenario;
		case 'personaDescription':
			return blocks.personaDescription;
		case 'dialogueExamples':
			return blocks.examples;
		default:
			return undefined;
	}
}

function roleOf(prompt: ActivePrompt, options: AssembleOptions): 'system' | 'user' | 'assistant' {
	return prompt.role ?? options.fallbackRole ?? 'system';
}

function roleFromWorldInfo(role: number): 'system' | 'user' | 'assistant' {
	if (role === WI_ROLE.user) {
		return 'user';
	}
	return role === WI_ROLE.assistant ? 'assistant' : 'system';
}

/** The example block as SillyTavern writes it: one `<START>`-headed message per example. */
export function exampleMessages(examples: string | undefined): Message[] {
	return parseExamples(examples ?? '').map((block) => ({
		role: 'system' as const,
		content: `<START>\n${block}\n`,
	}));
}

/**
 * Splices in-chat injections into a history: `depth` counts back from the end, so depth 0 is after
 * the last message. Same-depth entries keep their relative order.
 */
export function injectAtDepth(
	history: readonly Message[],
	injections: readonly { depth: number; role: number; content: string }[],
): Message[] {
	if (!injections.length) {
		return [...history];
	}
	const sorted = [...injections]
		.map((injection, index) => ({ injection, index }))
		.sort((left, right) => right.injection.depth - left.injection.depth || left.index - right.index);
	const result = [...history];
	for (const { injection } of sorted) {
		const at = Math.max(0, result.length - Math.max(0, injection.depth));
		result.splice(at, 0, { role: roleFromWorldInfo(injection.role), content: injection.content });
	}
	return result;
}

/** Builds the request's messages. `history` is oldest first and already budget-trimmed. */
export function assemble(
	prompts: readonly ActivePrompt[],
	blocks: AssembleBlocks,
	history: readonly Message[],
	options: AssembleOptions = {},
): Message[] {
	const substitute = options.substitute ?? ((text: string) => text);
	const messages: Message[] = [];
	const push = (role: 'system' | 'user' | 'assistant', content: string | undefined): void => {
		const text = (content ?? '').trim();
		if (text) {
			messages.push({ role, content: text });
		}
	};

	for (const prompt of prompts) {
		if (!prompt.enabled || isInChat(prompt)) {
			continue;
		}
		if (prompt.identifier === 'chatHistory') {
			// The history carries its own injections, so the chat-lore depth entries go in here.
			messages.push(...injectAtDepth(history, blocks.atDepth ?? []));
			continue;
		}
		if (prompt.identifier === 'dialogueExamples') {
			const edges = [
				...(blocks.examplesBefore ?? []),
				...exampleMessages(blocks.examples).map((message) => message.content),
				...(blocks.examplesAfter ?? []),
			];
			for (const text of edges) {
				push(roleOf(prompt, options), substitute(text));
			}
			continue;
		}
		const marker = markerContent(prompt.identifier, blocks, options);
		if (marker !== undefined) {
			push(roleOf(prompt, options), substitute(marker));
			continue;
		}
		push(roleOf(prompt, options), substitute(prompt.content ?? ''));
	}

	// A collection that never mentions the history would silently drop the conversation.
	if (!prompts.some((prompt) => prompt.identifier === 'chatHistory' && prompt.enabled)) {
		messages.push(...injectAtDepth(history, blocks.atDepth ?? []));
	}
	return messages;
}

/** The text of one prompt, with its decorators stripped, for a preview in the settings panel. */
export function previewPrompt(prompt: ActivePrompt): string {
	return parseDecorators(prompt.content ?? '').content.trim();
}
