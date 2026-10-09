import { normalisePrompt } from './preset';
import { blockToPrompt, PROMPT_BLOCKS } from './templates/blocks';
import type { PromptLibraryEntry } from './types';

/**
 * The two prompt libraries, and the pure half of both. A *system* entry lives in the shared
 * `.comonad/prompt-library.json` and every preset can insert it; a *preset* entry lives inside one
 * preset's own file (`PROMPT_LIBRARY_KEY`) and no other preset can see it.
 *
 * This module only shapes entries: the service owns the shared file's paths and writes, and
 * `preset.ts` owns the in-preset key (it reads that one with `normalisePrompt`, since a preset
 * library is plain SillyTavern prompts with no description of their own).
 */

/** The key the shared file keeps its entries under, so the file has room to grow. */
export const PROMPT_LIBRARY_FIELD = 'prompts';

/**
 * The built-in library: the template blocks in `templates/blocks.ts`, the only prompts Comonad ships
 * beyond SillyTavern's own defaults. The set is fixed; the text of each entry may be edited.
 */
export function builtInBlocks(): PromptLibraryEntry[] {
	return PROMPT_BLOCKS.map((block) => ({ ...blockToPrompt(block), description: block.description }));
}

/** The shared library as Comonad ships it. */
export function librarySeed(): PromptLibraryEntry[] {
	return builtInBlocks();
}

/**
 * The built-in library as it is read: the set is fixed by the templates, so only the entries that
 * are built in are kept, and a saved edit to one of them replaces its shipped text. Anything else in
 * the file (an entry added by hand, say) is dropped, because the library cannot grow.
 */
export function mergeBuiltIn(stored: readonly PromptLibraryEntry[]): PromptLibraryEntry[] {
	return builtInBlocks().map((shipped) => {
		const saved = stored.find((entry) => entry.identifier === shipped.identifier);
		return saved ? { ...saved, description: shipped.description } : shipped;
	});
}

/**
 * One entry as a library holds it: SillyTavern's own prompt fields, plus the description the shared
 * file keeps beside the name. An entry with no identifier is not a prompt, so it is dropped.
 */
export function libraryEntry(value: unknown): PromptLibraryEntry | null {
	const prompt = normalisePrompt(value);
	if (!prompt) {
		return null;
	}
	const description = value && typeof value === 'object' ? (value as { description?: unknown }).description : undefined;
	return typeof description === 'string' ? { ...prompt, description } : prompt;
}

/** Every usable entry of a library, in file order. */
export function readPromptLibrary(value: unknown): PromptLibraryEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map(libraryEntry).filter((entry): entry is PromptLibraryEntry => entry !== null);
}

/**
 * A library the pane sent back. A webview is untrusted input, so every entry goes through the same
 * reader and anything unusable is dropped rather than written.
 */
export function sanitisePromptLibrary(value: unknown): PromptLibraryEntry[] {
	return readPromptLibrary(value);
}

/** The shared file's own shape. Comonad's format, not SillyTavern's — hence the `description`. */
export function promptLibraryJson(entries: readonly PromptLibraryEntry[]): string {
	return JSON.stringify({ [PROMPT_LIBRARY_FIELD]: entries }, null, 4);
}

/** Reads the shared file: `{ prompts: [...] }` is what we write, a bare array is tolerated. */
export function parsePromptLibrary(json: string): PromptLibraryEntry[] {
	const parsed = JSON.parse(json) as unknown;
	if (Array.isArray(parsed)) {
		return readPromptLibrary(parsed);
	}
	if (parsed && typeof parsed === 'object') {
		return readPromptLibrary((parsed as Record<string, unknown>)[PROMPT_LIBRARY_FIELD]);
	}
	return [];
}
