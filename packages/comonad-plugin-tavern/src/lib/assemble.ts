import type { Message } from '@comonad/lib/types';
import { parseExamples } from './macro';
import { IDENTITY_PROMPT, isInChat, type ActivePrompt } from './prompts';
import { parseDecorators } from './lore';
import { WI_ROLE } from '@comonad/lib/tavern/types';

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
	/** World-info entries and in-chat prompts that asked to sit at a depth. */
	atDepth?: readonly { depth: number; role: number; content: string; order?: number }[];
	/**
	 * Upstream's `new_chat_prompt`: the heading of the chat-history block, which a preset sends on
	 * every request (a group chat sends its own).
	 */
	historyHead?: string;
	/**
	 * Upstream's `send_if_empty`: what is said *as the user* when the history would otherwise end on
	 * the reply — a continue is the case that reaches this.
	 */
	sendIfEmpty?: string;
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

/** The role order upstream inserts a depth group in: assistant, then user, then system. */
function rolePriority(role: number): number {
	if (role === WI_ROLE.assistant) {
		return 2;
	}
	return role === WI_ROLE.user ? 1 : 0;
}

/**
 * Splices in-chat injections into a history: `depth` counts back from the end, so depth 0 is after
 * the last message. Deeper depths are handled first, so they end up further up the transcript; inside
 * a depth the order is upstream's — `order` low first, then assistant, user, system, which is how
 * `populationInjectionPrompts` lays a depth group out. Entries that tie keep the order they arrived
 * in, which is where the world-info scan or the prompt list put them.
 */
export function injectAtDepth(
	history: readonly Message[],
	injections: readonly { depth: number; role: number; content: string; order?: number }[],
): Message[] {
	if (!injections.length) {
		return [...history];
	}
	const sorted = [...injections]
		.map((injection, index) => ({ injection, index }))
		.sort(
			(left, right) =>
				right.injection.depth - left.injection.depth ||
				(left.injection.order ?? 100) - (right.injection.order ?? 100) ||
				rolePriority(right.injection.role) - rolePriority(left.injection.role) ||
				left.index - right.index,
		);
	// A depth group is spliced in one go: inserting them one by one would reverse them, since every
	// insertion lands on the same index.
	const result = [...history];
	for (let start = 0; start < sorted.length; ) {
		const depth = sorted[start].injection.depth;
		let end = start;
		while (end < sorted.length && sorted[end].injection.depth === depth) {
			end++;
		}
		const at = Math.max(0, result.length - Math.max(0, depth));
		result.splice(
			at,
			0,
			...sorted.slice(start, end).map(({ injection }) => ({ role: roleFromWorldInfo(injection.role), content: injection.content })),
		);
		start = end;
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
	// A block whose position is *in chat* is not sent where it sits in the list: it is spliced into the
	// history at its own depth, in its own order and with its own role, exactly as upstream does. The
	// world-info entries that asked for a depth travel the same way.
	const injections = [
		...(blocks.atDepth ?? []).map((entry) => ({ ...entry })),
		...prompts
			.filter((prompt) => prompt.enabled && isInChat(prompt) && (prompt.content ?? '').trim())
			.map((prompt) => ({
				depth: prompt.injection_depth ?? 4,
				role: prompt.role === 'user' ? WI_ROLE.user : prompt.role === 'assistant' ? WI_ROLE.assistant : WI_ROLE.system,
				content: substitute(prompt.content ?? ''),
				order: prompt.injection_order,
			})),
	];

	for (const prompt of prompts) {
		if (!prompt.enabled || isInChat(prompt)) {
			continue;
		}
		if (prompt.identifier === 'chatHistory') {
			// The history carries its own injections, so the chat-lore depth entries go in here.
			// Upstream heads this block with the *new chat* prompt, and fills an empty turn after a reply.
			push('system', substitute(blocks.historyHead ?? ''));
			messages.push(...injectAtDepth(history, injections));
			if (blocks.sendIfEmpty && history[history.length - 1]?.role === 'assistant') {
				push('user', substitute(blocks.sendIfEmpty));
			}
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
