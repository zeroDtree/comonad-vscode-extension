import { INJECTION_POSITION, type PromptItem, type PromptOrderEntry, type TavernPreset } from '@comonad/lib/tavern/types';

/**
 * The prompt collection: the twelve blocks SillyTavern ships, the default order, and the rules for
 * merging a preset's own prompts and order over them. A *marker* block has no content of its own —
 * the assembler fills it from the chat, the card, the world books or the persona.
 */

/** The shipped prompts, verbatim from SillyTavern's `chatCompletionDefaultPrompts`. */
export const DEFAULT_PROMPTS: readonly PromptItem[] = [
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

/** The order the shipped prompts are applied in, verbatim from `promptManagerDefaultPromptOrder`. */
export const DEFAULT_ORDER: readonly PromptOrderEntry[] = [
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

/**
 * Comonad's own identity block, as a prompt. It is first and stays first: the agent's mode,
 * approval, instructions and tools must survive whatever character the chat wears.
 */
export const IDENTITY_PROMPT = 'comonad';

/**
 * A preset with Comonad's identity block taken out of its prompt list and every order. Returns the
 * same object when there is nothing to remove, so a caller can tell a change from no change.
 */
export function withoutIdentityBlock(preset: TavernPreset): TavernPreset {
	const has = (entries: readonly { identifier: string }[] | undefined) => (entries ?? []).some((entry) => entry.identifier === IDENTITY_PROMPT);
	const orders = preset.promptOrders ? Object.fromEntries(Object.entries(preset.promptOrders).map(([key, order]) => [key, order.filter((entry) => entry.identifier !== IDENTITY_PROMPT)])) : undefined;
	const ordersHad = Object.values(preset.promptOrders ?? {}).some((order) => has(order));
	if (!has(preset.prompts) && !has(preset.promptOrder) && !ordersHad) {
		return preset;
	}
	return {
		...preset,
		prompts: preset.prompts?.filter((prompt) => prompt.identifier !== IDENTITY_PROMPT),
		promptOrder: preset.promptOrder?.filter((entry) => entry.identifier !== IDENTITY_PROMPT),
		promptOrders: orders,
	};
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

/** A prompt plus whether the order turns it on. */
export interface ActivePrompt extends PromptItem {
	enabled: boolean;
}

/**
 * Merges a preset's prompts and order over the shipped ones. A prompt the preset defines replaces
 * the shipped block of the same identifier; a prompt the preset adds is appended; an identifier that
 * appears in the order but nowhere else becomes a marker, so a preset can place a block the build
 * does not know about. `character` picks the order: upstream keeps one per character, and the preset's
 * default block stands in for every character that has none. `trigger` picks the blocks themselves: a
 * block limited to some generation types is left out of the others, as upstream's `shouldTrigger` says.
 */
export function promptCollection(preset?: TavernPreset, characterId = '', trigger?: string): ActivePrompt[] {
	const prompts = new Map<string, PromptItem>();
	prompts.set(IDENTITY_PROMPT, {
		identifier: IDENTITY_PROMPT,
		name: 'Comonad',
		role: 'system',
		system_prompt: true,
		marker: true,
	});
	for (const prompt of DEFAULT_PROMPTS) {
		prompts.set(prompt.identifier, { ...prompt });
	}
	for (const prompt of preset?.prompts ?? []) {
		const existing = prompts.get(prompt.identifier);
		prompts.set(prompt.identifier, existing ? { ...existing, ...prompt } : { ...prompt });
	}
	// The character's own order wins over the preset's default block, which wins over the shipped one.
	const perCharacter = characterId ? preset?.promptOrders?.[characterId] : undefined;
	const order = perCharacter?.length ? perCharacter : preset?.promptOrder?.length ? preset.promptOrder : DEFAULT_ORDER;
	// Comonad's identity block leads whatever the preset says; the shipped order predates it.
	const ordered: ActivePrompt[] = [{ ...prompts.get(IDENTITY_PROMPT)!, enabled: true }];
	for (const entry of order) {
		if (entry.identifier === IDENTITY_PROMPT) {
			continue;
		}
		const prompt = prompts.get(entry.identifier) ?? { identifier: entry.identifier, role: 'system' as const, marker: false };
		prompts.delete(entry.identifier);
		if (triggersGeneration(prompt, trigger)) {
			ordered.push({ ...prompt, enabled: entry.enabled });
		}
	}
	// Anything the order never mentions rides along at the end, switched on, rather than vanishing.
	for (const prompt of prompts.values()) {
		if (prompt.identifier === IDENTITY_PROMPT) {
			continue;
		}
		if (triggersGeneration(prompt, trigger)) {
			ordered.push({ ...prompt, enabled: true });
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
 * Silences the shipped blocks that only make sense with a character behind them. Without a card or a
 * preset there is nothing to write a reply *as*, and the default main prompt would otherwise tell a
 * coding agent to roleplay.
 */
export function withoutRoleplayScaffolding(prompts: readonly ActivePrompt[]): ActivePrompt[] {
	return prompts.map((prompt) => (prompt.identifier === 'main' ? { ...prompt, content: '' } : prompt));
}

/** Turns one prompt on or off, keeping its place. */
export function setEnabled(prompts: ActivePrompt[], identifier: string, enabled: boolean): ActivePrompt[] {
	return prompts.map((prompt) => (prompt.identifier === identifier ? { ...prompt, enabled } : prompt));
}

/** Moves one prompt by `delta` places; the first entry (the identity block) never moves. */
export function movePrompt(prompts: ActivePrompt[], identifier: string, delta: number): ActivePrompt[] {
	const index = prompts.findIndex((prompt) => prompt.identifier === identifier);
	if (index < 1) {
		return prompts;
	}
	const target = Math.min(prompts.length - 1, Math.max(1, index + delta));
	if (target === index) {
		return prompts;
	}
	const next = [...prompts];
	const [moved] = next.splice(index, 1);
	next.splice(target, 0, moved);
	return next;
}

/** Whether a prompt is injected in chat at a depth rather than sitting in the ordered list. */
export function isInChat(prompt: ActivePrompt): boolean {
	return prompt.injection_position === INJECTION_POSITION.absolute;
}
