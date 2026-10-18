import { COMONAD_BLOCK, COMONAD_BLOCKS, COMONAD_BLOCK_IDS, isComonadBlockId } from '@comonad/lib/blocks';
import type { PromptItem, PromptOrderEntry, TavernPreset } from './types';

/**
 * The prompt collection: the blocks SillyTavern ships, Comonad's own generated blocks, the default
 * order, and the rules for merging a preset's prompts and order over them. A *marker* block has no
 * content of its own — the assembler fills it from the chat, the card, the world books, the persona
 * or, for Comonad's blocks, from the agent's state for the turn.
 */

/** `0` keeps a prompt in the ordered list; `1` injects it in chat, at a depth. */
export const INJECTION_POSITION = {
	relative: 0,
	absolute: 1,
} as const;

/** The twelve prompts SillyTavern ships, verbatim from its `chatCompletionDefaultPrompts`. */
export const ST_PROMPTS: readonly PromptItem[] = [
	{
		identifier: 'main',
		name: 'Main Prompt',
		system_prompt: true,
		role: 'system',
		// Upstream's own text, `{{charIfNotGroup}}` and all: that macro is the character in a solo chat.
		content: "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.",
	},
	{
		identifier: 'nsfw',
		name: 'Auxiliary Prompt',
		system_prompt: true,
		role: 'system',
		content: '',
	},
	{ identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, role: 'system', marker: true },
	{
		identifier: 'jailbreak',
		name: 'Post-History Instructions',
		system_prompt: true,
		role: 'system',
		content: '',
	},
	{ identifier: 'chatHistory', name: 'Chat History', system_prompt: true, role: 'system', marker: true },
	{ identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, role: 'system', marker: true },
	{ identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, role: 'system', marker: true },
	{
		identifier: 'enhanceDefinitions',
		name: 'Enhance Definitions',
		role: 'system',
		system_prompt: true,
		marker: false,
		content:
			"If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
	},
	{ identifier: 'charDescription', name: 'Char Description', system_prompt: true, role: 'system', marker: true },
	{ identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, role: 'system', marker: true },
	{ identifier: 'scenario', name: 'Scenario', system_prompt: true, role: 'system', marker: true },
	{ identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, role: 'system', marker: true },
];

/**
 * Comonad's own blocks. They are markers with no stored text: the agent builds their content for
 * every turn, and the preset decides only whether and where they are sent. `extension` is
 * SillyTavern's own flag for an extension prompt, so a file opened there reads the rows as ours.
 */
export const COMONAD_PROMPTS: readonly PromptItem[] = COMONAD_BLOCKS.map(({ id, name }) => ({
	identifier: id,
	name,
	role: 'system' as const,
	system_prompt: true,
	marker: true,
	extension: true,
}));

/** Everything a collection starts from: Comonad's blocks, then SillyTavern's shipped prompts. */
export const DEFAULT_PROMPTS: readonly PromptItem[] = [...COMONAD_PROMPTS, ...ST_PROMPTS];

/**
 * The order the default collection uses. Comonad's meta blocks lead, the conversation follows, and
 * the turn's own Context stays inside that meta group rather than after the history — a request
 * should end on the conversation, not on a system message appended after the user's turn.
 */
export const DEFAULT_ORDER: readonly PromptOrderEntry[] = [
	...COMONAD_BLOCK_IDS.map((identifier) => ({ identifier, enabled: true })),
	{ identifier: 'main', enabled: true },
	{ identifier: 'worldInfoBefore', enabled: true },
	{ identifier: 'personaDescription', enabled: true },
	{ identifier: 'charDescription', enabled: true },
	{ identifier: 'charPersonality', enabled: true },
	{ identifier: 'scenario', enabled: true },
	{ identifier: 'enhanceDefinitions', enabled: false },
	{ identifier: 'nsfw', enabled: true },
	{ identifier: 'worldInfoAfter', enabled: true },
	{ identifier: 'dialogueExamples', enabled: true },
	{ identifier: 'chatHistory', enabled: true },
	{ identifier: 'jailbreak', enabled: true },
];

/** Comonad's identity block, the first entry of the shipped collection. */
export const IDENTITY_PROMPT = COMONAD_BLOCK.identity;
/** The one entry that switches the request's API tools on or off. */
export const TOOLS_PROMPT = COMONAD_BLOCK.tools;
/** The built-in Default template's id; an unselected chat uses the same collection. */
export const DEFAULT_PRESET_ID = 'default';
/** The turn's own attached context. */
export const CONTEXT_PROMPT = COMONAD_BLOCK.context;

/**
 * Adds every Comonad block an order does not mention. The block is inserted right after Identity,
 * which keeps a preset's own placement untouched; an order that has lost Identity gets the whole
 * group in front. This is what lets an imported SillyTavern preset — whose order knows nothing of
 * Comonad — still send the agent's instructions and tools.
 */
export function completeOrder(order: readonly PromptOrderEntry[]): PromptOrderEntry[] {
	const result = order.map((entry) => ({ ...entry }));
	const present = new Set(result.map((entry) => entry.identifier));
	const missing = COMONAD_BLOCK_IDS.filter((identifier) => !present.has(identifier));
	if (!missing.length) {
		return result;
	}
	const identityAt = result.findIndex((entry) => entry.identifier === IDENTITY_PROMPT);
	if (identityAt < 0) {
		return [...missing.map((identifier) => ({ identifier, enabled: true })), ...result];
	}
	const rest = missing.filter((identifier) => identifier !== IDENTITY_PROMPT);
	return [...result.slice(0, identityAt + 1), ...rest.map((identifier) => ({ identifier, enabled: true })), ...result.slice(identityAt + 1)];
}

/** Upstream's `shouldTrigger`: a block with no trigger list is sent for every generation type. */
export function triggersGeneration(prompt: Pick<PromptItem, 'injection_trigger'>, trigger: string | undefined): boolean {
	return !trigger || !prompt.injection_trigger?.length || prompt.injection_trigger.includes(trigger);
}

/** The block of this identifier as Comonad ships it, which is what *Reset* puts back. */
export function shippedPrompt(identifier: string): PromptItem | undefined {
	const found = DEFAULT_PROMPTS.find((prompt) => prompt.identifier === identifier);
	return found ? { ...found } : undefined;
}

/** A prompt plus what the collection decides about it: on, and in chat at a depth rather than listed. */
export interface ActivePrompt extends PromptItem {
	enabled: boolean;
	inChat: boolean;
}

/**
 * Merges a preset's prompts and order over the shipped ones. A prompt the preset defines replaces
 * the shipped block of the same identifier; a prompt the preset adds is appended; an identifier that
 * appears in the order but nowhere else becomes a marker, so a preset can place a block the build
 * does not know about. Comonad's own blocks are never taken from the preset: their text is generated
 * for the turn, and only their place and switch come from the order. `character` picks the order:
 * upstream keeps one per character, and the preset's default block stands in for every character that
 * has none. `trigger` picks the blocks themselves: a block limited to some generation types is left
 * out of the others, as upstream's `shouldTrigger` says.
 */
export function promptCollection(preset?: TavernPreset, characterId = '', trigger?: string): ActivePrompt[] {
	const prompts = new Map<string, PromptItem>();
	for (const prompt of DEFAULT_PROMPTS) {
		prompts.set(prompt.identifier, { ...prompt });
	}
	for (const prompt of preset?.prompts ?? []) {
		if (isComonadBlockId(prompt.identifier)) {
			continue;
		}
		const existing = prompts.get(prompt.identifier);
		prompts.set(prompt.identifier, existing ? { ...existing, ...prompt } : { ...prompt });
	}
	// The character's own order wins over the preset's default block, which wins over the shipped one.
	const perCharacter = characterId ? preset?.promptOrders?.[characterId] : undefined;
	const order = completeOrder(perCharacter?.length ? perCharacter : preset?.promptOrder?.length ? preset.promptOrder : DEFAULT_ORDER);
	const placed = (prompt: PromptItem, enabled: boolean): ActivePrompt => ({ ...prompt, enabled, inChat: isInChat(prompt) });
	const ordered: ActivePrompt[] = [];
	for (const entry of order) {
		const prompt = prompts.get(entry.identifier) ?? { identifier: entry.identifier, role: 'system' as const, marker: false };
		prompts.delete(entry.identifier);
		if (triggersGeneration(prompt, trigger)) {
			ordered.push(placed(prompt, entry.enabled));
		}
	}
	// Anything the order never mentions rides along at the end, switched on, rather than vanishing.
	for (const prompt of prompts.values()) {
		if (triggersGeneration(prompt, trigger)) {
			ordered.push(placed(prompt, true));
		}
	}
	return ordered;
}

/** The order half of a collection, for storing back into a preset or the settings. */
export function orderOf(prompts: readonly ActivePrompt[]): PromptOrderEntry[] {
	return prompts.map((prompt) => ({ identifier: prompt.identifier, enabled: prompt.enabled }));
}

/**
 * A card's overrides of the two prompts it owns, as SillyTavern applies them: the card's
 * `system_prompt` replaces the main prompt and its `post_history_instructions` replace the
 * post-history one, unless the prompt is marked as not overridable.
 */
export function applyCardOverrides(
	prompts: readonly ActivePrompt[],
	card: { systemPrompt?: string; postHistoryInstructions?: string },
): ActivePrompt[] {
	return prompts.map((prompt) => {
		if (prompt.forbid_overrides) {
			return prompt;
		}
		if (prompt.identifier === 'main' && card.systemPrompt?.trim()) {
			return { ...prompt, content: card.systemPrompt };
		}
		if (prompt.identifier === 'jailbreak' && card.postHistoryInstructions?.trim()) {
			return { ...prompt, content: card.postHistoryInstructions };
		}
		return prompt;
	});
}

/**
 * Silences the shipped blocks that only make sense with a character behind them. Without a card and
 * without an explicitly selected preset there is nothing to write a reply *as*, and the default main
 * prompt would otherwise tell a coding agent to roleplay.
 */
export function withoutRoleplayScaffolding(prompts: readonly ActivePrompt[]): ActivePrompt[] {
	return prompts.map((prompt) => (prompt.identifier === 'main' ? { ...prompt, content: '' } : prompt));
}

/** Turns one prompt on or off, keeping its place. */
export function setEnabled(prompts: ActivePrompt[], identifier: string, enabled: boolean): ActivePrompt[] {
	return prompts.map((prompt) => (prompt.identifier === identifier ? { ...prompt, enabled } : prompt));
}

/** Moves one prompt by `delta` places; the list is the whole order, so the first entry may move too. */
export function movePrompt(prompts: ActivePrompt[], identifier: string, delta: number): ActivePrompt[] {
	const index = prompts.findIndex((prompt) => prompt.identifier === identifier);
	if (index < 0) {
		return prompts;
	}
	const target = Math.min(prompts.length - 1, Math.max(0, index + delta));
	if (target === index) {
		return prompts;
	}
	const next = [...prompts];
	const [moved] = next.splice(index, 1);
	next.splice(target, 0, moved);
	return next;
}

/** Whether a prompt is injected in chat at a depth rather than sitting in the ordered list. */
export function isInChat(prompt: Pick<PromptItem, 'injection_position'>): boolean {
	return prompt.injection_position === INJECTION_POSITION.absolute;
}
