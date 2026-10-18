import {
	COMONAD_BLOCKS,
	DEFAULT_BLOCK_PREFIX,
	isComonadBlockId,
	type ComonadBlockId,
	type PromptBlock,
} from './blocks';

/**
 * The user's layout of Comonad's prompt blocks and of the tool definitions. The array order is the
 * send order; `enabled` is the switch; `prefix` is the editable static opening of a block. Dynamic
 * block content is never stored here — the agent rebuilds it every turn.
 *
 * This module is pure. It sanitizes values that arrive from a webview or from settings.json, so a
 * malformed entry can never reach the prompt builder.
 */

export interface PromptBlockSetting {
	id: ComonadBlockId;
	enabled: boolean;
	prefix: string;
}

export interface ToolPromptSetting {
	name: string;
	enabled: boolean;
}

/** A saved prefix is prose, not a document; this bounds a runaway settings value. */
const PREFIX_LIMIT = 20_000;
const TOOL_LIMIT = 500;
const NAME_LIMIT = 200;

/** The canonical layout: every block on, in the order Comonad has always sent them. */
export function defaultPromptLayout(): PromptBlockSetting[] {
	return COMONAD_BLOCKS.map((block) => ({
		id: block.id,
		enabled: true,
		prefix: DEFAULT_BLOCK_PREFIX[block.id],
	}));
}

/**
 * Reads a saved block layout. Unknown or duplicate identifiers are dropped, the saved order is kept,
 * and any block the value does not mention is appended in its canonical place, switched on. An entry
 * without a prefix gets the built-in one; an empty string is a deliberate "no prefix".
 */
export function parsePromptLayout(value: unknown): PromptBlockSetting[] {
	if (!Array.isArray(value)) {
		return defaultPromptLayout();
	}
	const seen = new Set<string>();
	const layout: PromptBlockSetting[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const record = item as { id?: unknown; enabled?: unknown; prefix?: unknown };
		const id = typeof record.id === 'string' ? record.id : '';
		if (!isComonadBlockId(id) || seen.has(id)) {
			continue;
		}
		seen.add(id);
		layout.push({
			id,
			enabled: record.enabled !== false,
			prefix: typeof record.prefix === 'string' ? record.prefix.slice(0, PREFIX_LIMIT) : DEFAULT_BLOCK_PREFIX[id],
		});
	}
	for (const block of COMONAD_BLOCKS) {
		if (!seen.has(block.id)) {
			layout.push({ id: block.id, enabled: true, prefix: DEFAULT_BLOCK_PREFIX[block.id] });
		}
	}
	return layout;
}

/**
 * Reads a saved tool layout. Names are kept even when no such tool is registered right now: a plugin
 * that is temporarily off keeps its place and switch for when it comes back. Unknown names are
 * ignored by {@link mergeToolLayout} until then.
 */
export function parseToolLayout(value: unknown): ToolPromptSetting[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const layout: ToolPromptSetting[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const record = item as { name?: unknown; enabled?: unknown };
		const name = typeof record.name === 'string' ? record.name.trim().slice(0, NAME_LIMIT) : '';
		if (!name || seen.has(name) || layout.length >= TOOL_LIMIT) {
			continue;
		}
		seen.add(name);
		layout.push({ name, enabled: record.enabled !== false });
	}
	return layout;
}

/**
 * The prefixes from an edited layout over the current core order and switches. Under ST the editor
 * shows the preset's order/switches (read-only), so a save must not copy that mirror into the
 * fallback layout: only the prefix fields are the core layout's to take.
 */
export function mergePromptPrefixes(
	current: readonly PromptBlockSetting[],
	incoming: readonly PromptBlockSetting[],
): PromptBlockSetting[] {
	const byId = new Map(incoming.map((entry) => [entry.id, entry]));
	return current.map((entry) => {
		const edit = byId.get(entry.id);
		return edit ? { ...entry, prefix: edit.prefix } : entry;
	});
}

/**
 * The fallback system prompt's blocks: switched-on, non-empty, in the user's order. Under ST this is
 * not used — the active preset's order is authoritative there, and the agent's full block list is
 * handed to `compose` unchanged.
 */
export function applyPromptLayout(blocks: readonly PromptBlock[], layout: readonly PromptBlockSetting[]): PromptBlock[] {
	const position = new Map(layout.map((entry, index) => [entry.id, index]));
	const enabled = new Map(layout.map((entry) => [entry.id, entry.enabled]));
	return blocks
		.filter((block) => enabled.get(block.id) !== false && block.text.trim().length > 0)
		.sort((left, right) => (position.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(right.id) ?? Number.MAX_SAFE_INTEGER));
}

/**
 * Merges the registered tools with the saved tool layout: configured entries first, in their order,
 * then every tool the layout never mentions, switched on, in the order the registry gave them
 * (alphabetical). Unknown saved names are skipped until the tool registers again.
 */
export function mergeToolLayout<T extends { name: string }>(
	tools: readonly T[],
	entries: readonly ToolPromptSetting[],
): { tool: T; enabled: boolean }[] {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const seen = new Set<string>();
	const layout: { tool: T; enabled: boolean }[] = [];
	for (const entry of entries) {
		const tool = byName.get(entry.name);
		if (!tool || seen.has(entry.name)) {
			continue;
		}
		seen.add(entry.name);
		layout.push({ tool, enabled: entry.enabled });
	}
	for (const tool of tools) {
		if (!seen.has(tool.name)) {
			layout.push({ tool, enabled: true });
		}
	}
	return layout;
}
