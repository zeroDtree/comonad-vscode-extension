// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, readdir, stat } from 'node:fs/promises';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Service, type Context } from 'cordis';
import { COMONAD_BLOCK, DEFAULT_BLOCK_PREFIX, TOOL_DEPENDENT_BLOCKS, isComonadBlockId, type ComonadBlockId, type PromptBlock } from '@comonad/lib/blocks';
import type { Message } from '@comonad/lib/types';
import { cardId, cardToJson, cardToPng, isCardFile, isPng, loadCard } from '../lib/card';
import { PERSONA_POSITION, personaJson, slugId, worldInfoJson } from '../lib/authoring';
import { connectionKeys, personaBackup, personaFrom, readPersonaBackup, type PersonaBackup, type PersonaRestore } from '../lib/personas';
import { activateLore, loreIndex, toWorldBook, worldInfoToBook, WI_ENTRY_DEFAULTS, WI_ROLE, type LoreBook, type LoreHit, type LoreResult, type TimedEffects } from '../lib/lore';
import { substituteMacros, type MacroContext } from '../lib/macro';
import { applyRegex, REGEX_PLACEMENT, regexScriptsFrom } from '../lib/regex';
import { vectorSettings, WI_SETTINGS_DEFAULTS, tavernSettings, type TavernSettings } from '../lib/settings';
import { estimateTokens } from '@comonad/lib/tokens';
import { Vectors } from './vectors';
import { emptyStore, mergeStores, readStore, renameKey, storeJson, tagIdsOf, type TagStore } from '../lib/tags';
import { librarySeed, mergeBuiltIn, parsePromptLibrary, promptLibraryJson, sanitisePromptLibrary } from '../lib/library';
import { loadPreset, presetSamplers, presetToJson, type PresetSamplers } from '../lib/preset';
import { applyCardOverrides, DEFAULT_PRESET_ID, TOOLS_PROMPT, promptCollection, withoutRoleplayScaffolding, type ActivePrompt } from '../lib/prompts';
import { assemble, hasMarkerText, markerContent, previewPrompt, type AssembleBlocks } from '../lib/assemble';
import {
	type Character,
	type Persona,
	type PromptLibraryEntry,
	type RegexScript,
	type TavernPreset,
	type GenerationTrigger,
	type WiRole,
	type WorldBook,
	type WorldInfoSettings,
} from '../lib/types';

/**
 * The tavern service: it owns the content (characters, their books, personas, presets), keeps the
 * per-chat selection, and composes a turn's messages out of them.
 *
 * Content is read from `.comonad/{characters,lorebooks,presets,personas}` — project first, then the
 * user library — in SillyTavern's own file formats, so a card, book, persona or preset can be moved
 * between the two tools. The formats are compatible; the folders are our own.
 */

export interface TavernBinding {
	character?: string;
	persona?: string;
	lorebooks?: string[];
	preset?: string;
	/** Standing text injected at depth, like SillyTavern's author's note. */
	authorNote?: string;
	/** Timed world-info effects carried over from the previous turn. */
	effects?: TimedEffects;
}

export interface ComposeInput {
	/** Comonad's own blocks, already built for this turn. The preset decides where each is sent. */
	blocks: readonly PromptBlock[];
	/** The conversation in wire form, oldest first. */
	history: Message[];
	/** What the chat has selected. Anything it leaves out falls back to the configured defaults. */
	binding: TavernBinding;
	/** Newest first, as the world-info scan wants them. */
	scan: Array<{ role: 'user' | 'assistant'; text: string }>;
	/** Chat length for this scan, which is the unit the timed effects count in. */
	turn: number;
	/** What started this generation: an entry may be tied to one of upstream's generation types. */
	trigger?: GenerationTrigger;
	/** The model of the chat, for the `{{model}}` macro. */
	model?: string;
	/** Context the endpoint accepts, for the world-info budget. */
	contextSize?: number;
}

/** An automation an activated entry named (upstream's *Automation ID*), ready for the caller to run. */
export interface LoreAutomation {
	id: string;
	book: string;
	uid: number;
	comment: string;
}

export interface ComposeResult {
	messages: Message[];
	/** The prompt collection this turn used. */
	prompts: ActivePrompt[];
	/** Everything the world books contributed. */
	activated: LoreHit[];
	/** Worlds-info positions that were filled, for the chat's readout. */
	buckets: LoreResult;
	effects: TimedEffects;
	/** True when this result replaces the agent's own `[system, …history]` shape. */
	takeover: boolean;
	/** Whether the preset's Tools entry is on, so the request may offer the policy's tools. */
	toolsEnabled: boolean;
	/** The presets's sampler settings, when a preset is selected. */
	samplers: PresetSamplers;
	/** The scan ran out of budget and dropped entries, and the settings say to say so. */
	overflowAlert: boolean;
	/** The automations the activated entries named, with the setting that allows them already applied. */
	automations: LoreAutomation[];
}

interface LoadedBook {
	name: string;
	book: WorldBook;
	/** Where it came from: a file in the library, or the card it was written from. */
	source: string;
	/** The file as read, so writing it back never loses a field we do not model. */
	raw: Record<string, unknown>;
}

/** The four kinds of content the library holds, which are also its folder names. */
export type ContentKind = 'characters' | 'lorebooks' | 'presets' | 'personas';

const MAX_FILES = 500;

/**
 * The seam between the agent and the tavern: the agent holds only this much of the service, so a
 * build without the tavern plugin still type-checks — `ctx.get('tavern')` answers undefined then.
 */
export type TavernApi = Pick<
	Tavern,
	'enabled' | 'compose' | 'continueNudge' | 'impersonationPrompt' | 'booksFor' | 'loreIndex' | 'promptsFor' | 'displayPrompts'
>;

/** The picture formats upstream accepts for a persona's avatar; ours is the file beside the JSON. */
const AVATAR_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;

declare module 'cordis' {
	interface Context {
		tavern: Tavern;
	}
}

export class Tavern extends Service implements TavernApi {
	static inject = ['host', 'log', 'settings', 'sessions'];

	characters: Character[] = [];
	books: LoadedBook[] = [];
	presets: TavernPreset[] = [];
	personas: Persona[] = [];
	/** The tag registry: SillyTavern keeps it beside the settings, Comonad in `.comonad/tags.json`. */
	tags: TagStore = emptyStore();
	/**
	 * The shared prompt library: `.comonad/prompt-library.json`, seeded from the built-in blocks.
	 * Every preset can insert its entries; a preset's own library rides inside the preset's file.
	 */
	promptLibrary: PromptLibraryEntry[] = [];

	/**
	 * The first read, in flight from the moment the service exists. Nothing else fills the library, so a
	 * window that never sees a `.comonad` change would otherwise open every content surface — and the
	 * shared prompt library — empty until something happened to trigger a reload. Await it to be sure.
	 */
	readonly ready: Promise<void>;

	/**
	 * The reads run one at a time: two in flight would race, and the one that started first could land
	 * last — a startup read of an empty library undoing the reload a pane just asked for.
	 */
	private reading: Promise<void> = Promise.resolve();

	/**
	 * What this service last wrote to each file, so the environment's file watcher can tell its own
	 * echo from an outside edit: a save already puts the one file back into the catalog, and a
	 * watcher re-reading the whole library for our own write is what made editing stutter.
	 */
	private readonly wrote = new Map<string, Buffer | null>();

	constructor(ctx: Context) {
		super(ctx, 'tavern');
		// The vector side of world info lives here rather than in the kernel: the only thing it ever
		// embeds is world-book entries, so it travels with the layer that owns them.
		ctx.plugin(Vectors);
		this.ready = this.reload();
	}

	/** Remembers the bytes a write put in a file (`null` for a delete) — see `wrote`. */
	private noteWrite(file: string, bytes: Buffer | string | null): void {
		this.wrote.set(resolve(file), bytes === null ? null : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
		while (this.wrote.size > 256) {
			const oldest = this.wrote.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.wrote.delete(oldest);
		}
	}

	/**
	 * Whether the file watcher just saw this service's own write land: the file on disk holds exactly
	 * what was written (or is gone, for a delete). Consumes the record, so the next change to the same
	 * file is an outside edit again. Watcher-side tests ask this before reloading anything.
	 */
	async isOwnWrite(file: string): Promise<boolean> {
		const mine = this.wrote.get(resolve(file));
		if (mine === undefined) {
			return false;
		}
		this.wrote.delete(resolve(file));
		try {
			return mine === null ? false : mine.equals(await readFile(file));
		} catch {
			return mine === null;
		}
	}

	/** Re-reads every source, after the read before it has finished. */
	reload(): Promise<void> {
		const next = this.reading.then(() => this.read());
		this.reading = next.catch(() => undefined);
		return next;
	}

	/**
	 * Runs one catalog change after every read and mutation before it. A save used to end in a full
	 * `reload()`, which queued behind whatever read was already in flight; now that a save adopts just
	 * its own file, the adopt joins the same queue — without it, the first read of the library could
	 * land after a save and replace the catalog out from under it.
	 */
	private mutate<T>(work: () => Promise<T>): Promise<T> {
		const next = this.reading.then(work);
		this.reading = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/** One read of every source. A broken file is logged and skipped, never fatal. */
	private async read(): Promise<void> {
		const characters: Character[] = [];
		const books: LoadedBook[] = [];
		const presets: TavernPreset[] = [];
		const personas: Persona[] = [];
		for (const root of this.roots()) {
			await this.readLibrary(root, { characters, books, presets, personas });
		}
		this.tags = await this.readTags();
		this.promptLibrary = await this.loadPromptLibrary();
		this.characters = uniqueBy(characters, (character) => character.id);
		this.books = uniqueBy(books, (book) => book.name.toLowerCase());
		this.presets = uniqueBy(presets, (preset) => preset.id);
		this.personas = uniqueBy(personas, (persona) => persona.id);
		this.ctx.log.message(
			`tavern: ${this.characters.length} character(s), ${this.books.length} lorebook(s), ${this.presets.length} preset(s), ${this.personas.length} persona(s), ${this.promptLibrary.length} prompt(s) in the library`,
		);
		this.ctx.emit('tavern/changed');
	}

	/**
	 * Puts one just-written file back into the catalog — what a save needs and no more, instead of
	 * re-reading the whole library. The entry is exactly what a full read would produce, because the
	 * same readers run over the same file. A save writes where the item already lived, so the slot is
	 * found by `previous` (the file it lived in — the only name a rename leaves behind) or by its key;
	 * a key that is new to the catalog is added, and one that shadows a same-keyed item from a less
	 * specific root takes that slot, exactly as a full read's shadowing would leave it.
	 */
	private slot<T extends { source?: string }>(list: T[], next: T, previous: string | undefined, key: (item: T) => string): void {
		const wanted = key(next).toLowerCase();
		const at = list.findIndex(
			(item) =>
				(previous !== undefined && item.source && resolve(item.source) === resolve(previous)) ||
				key(item).toLowerCase() === wanted,
		);
		if (at >= 0) {
			list[at] = next;
		} else {
			list.push(next);
		}
	}

	private adoptCharacter(file: string, previous?: string): Promise<void> {
		return this.mutate(async () => {
			this.slot(this.characters, await loadCard(file), previous, (item) => item.id);
		});
	}

	private adoptBook(file: string, previous?: string): Promise<void> {
		return this.mutate(async () => {
			const book = await readBookFile(file);
			if (book) {
				this.slot(this.books, { name: book.name, book, source: file, raw: book.raw }, previous, (item) => item.name);
			}
		});
	}

	private adoptPersona(file: string, previous?: string): Promise<void> {
		return this.mutate(async () => {
			const id = personaId(file);
			const avatar = (await this.avatarsIn(dirname(file))).get(id);
			const persona = readPersonaFile(JSON.parse(await readFile(file, 'utf8')) as unknown, id, file);
			this.slot(this.personas, avatar ? { ...persona, avatar } : persona, previous, (item) => item.id);
		});
	}

	private adoptPreset(file: string, previous?: string): Promise<void> {
		return this.mutate(async () => {
			this.slot(this.presets, { ...(await loadPreset(file)), source: file }, previous, (item) => item.id);
		});
	}

	/**
	 * The folders the library is read from, most specific first: this project's `.comonad`, then the
	 * user library in the home folder. A project item shadows a user item of the same name.
	 */
	roots(): string[] {
		const host = this.ctx.host;
		const roots: string[] = [];
		if (host.trusted() && host.workspace()) {
			roots.push(join(host.workspace(), '.comonad'));
		}
		roots.push(join(host.home(), '.comonad'));
		return roots;
	}

	/**
	 * The registry, merged from every root most specific first: a tag id in the project file wins, and
	 * an entity keeps the tags both files gave it.
	 */
	private async readTags(): Promise<TagStore> {
		let store = emptyStore();
		for (const root of this.roots()) {
			try {
				store = mergeStores(store, readStore(JSON.parse(await readFile(join(root, 'tags.json'), 'utf8')) as unknown));
			} catch {
				// No registry in this root, which is the normal state of a fresh library.
			}
		}
		return store;
	}

	/** Where the registry is written: this project's library when the window has one, else home. */
	tagFile(): string {
		return join(this.writeRoot(), 'tags.json');
	}

	/**
	 * Writes the registry and re-reads the merged view. Upstream saves its own settings the same way:
	 * the file is the state, so the next write starts from what is on disk rather than from memory.
	 */
	async saveTags(): Promise<void> {
		const file = this.tagFile();
		await mkdir(dirname(file), { recursive: true });
		const text = storeJson(this.tags);
		await writeFile(file, text, 'utf8');
		this.noteWrite(file, text);
		await this.mutate(async () => {
			this.tags = await this.readTags();
		});
		this.ctx.emit('tavern/changed');
	}

	/** Where the shared prompt library lives: beside the registry, in the same writable root. */
	promptLibraryFile(): string {
		return join(this.writeRoot(), 'prompt-library.json');
	}

	/**
	 * Reads the shared prompt library. A library that is not there yet is seeded with the built-in
	 * blocks and written, so the file exists to be edited; one that is there but unreadable is logged
	 * and left alone rather than overwritten.
	 */
	private async loadPromptLibrary(): Promise<PromptLibraryEntry[]> {
		const file = this.promptLibraryFile();
		let json: string;
		try {
			json = await readFile(file, 'utf8');
		} catch {
			const seeded = librarySeed();
			try {
				await mkdir(dirname(file), { recursive: true });
				const text = promptLibraryJson(seeded);
				await writeFile(file, text, 'utf8');
				this.noteWrite(file, text);
			} catch (error) {
				this.ctx.log.message(`tavern: could not seed the prompt library: ${error instanceof Error ? error.message : String(error)}`);
			}
			return seeded;
		}
		try {
			return mergeBuiltIn(parsePromptLibrary(json));
		} catch (error) {
			this.ctx.log.message(`tavern: the prompt library could not be read: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	/**
	 * Writes the shared prompt library and re-reads it, so what a pane sees next is what is on disk.
	 * Every entry is sanitised first: what a webview sends is untrusted input.
	 */
	async savePromptLibrary(entries: readonly PromptLibraryEntry[]): Promise<string> {
		const file = this.promptLibraryFile();
		await mkdir(dirname(file), { recursive: true });
		// The set of built-in entries is fixed: a save may edit them, never add or remove one.
		const text = promptLibraryJson(mergeBuiltIn(sanitisePromptLibrary(entries)));
		await writeFile(file, text, 'utf8');
		this.noteWrite(file, text);
		await this.mutate(async () => {
			this.promptLibrary = await this.loadPromptLibrary();
		});
		this.ctx.emit('tavern/changed');
		return file;
	}

	/** The tag **ids** a character carries — what an entry’s character filter compares against. */
	tagIdsFor(id: string | undefined): string[] {
		const character = this.character(id);
		return character ? tagIdsOf(this.tags, character.id) : [];
	}

	character(id: string | undefined): Character | undefined {
		const wanted = (id ?? '').trim();
		return wanted ? this.characters.find((character) => character.id === wanted || character.name === wanted) : undefined;
	}

	persona(id: string | undefined): Persona | undefined {
		const wanted = (id ?? '').trim();
		return wanted ? this.personas.find((persona) => persona.id === wanted || persona.name === wanted) : undefined;
	}

	preset(id: string | undefined): TavernPreset | undefined {
		const wanted = (id ?? '').trim();
		return wanted ? this.presets.find((preset) => preset.id === wanted) : undefined;
	}

	book(name: string): LoadedBook | undefined {
		const wanted = name.trim().toLowerCase();
		return this.books.find((book) => book.name.toLowerCase() === wanted);
	}

	/**
	 * The persona a binding resolves to: the chat's own pick, else a persona bound to this character
	 * through `connections`, else the configured default.
	 */
	personaFor(id: string | undefined, character: Character | undefined): Persona | undefined {
		const chosen = this.persona(id);
		if (chosen) {
			return chosen;
		}
		if (character) {
			// Upstream's connections hold ids: a card's avatar file name, which Comonad calls its id.
			const keys = new Set([character.id, character.name].map((key) => key.trim().toLowerCase()));
			const linked = this.personas.find((persona) =>
				persona.connections.some((connection) => connectionKeys(connection.id).some((key) => keys.has(key))),
			);
			if (linked) {
				return linked;
			}
		}
		return this.persona(tavernSettings(this.ctx).tavernPersona);
	}

	/** Loose lookup for a name typed by hand: id or name, any case. */
	findCharacter(name: string): Character | undefined {
		const wanted = name.trim().toLowerCase();
		return this.characters.find((entry) => entry.id.toLowerCase() === wanted || entry.name.toLowerCase() === wanted);
	}

	/** Loose lookup over personas: id, name or title. */
	findPersona(name: string): Persona | undefined {
		const wanted = name.trim().toLowerCase();
		return this.personas.find(
			(entry) => entry.id.toLowerCase() === wanted || entry.name.toLowerCase() === wanted || entry.title.toLowerCase() === wanted,
		);
	}

	/** Loose lookup over presets: id or name. */
	findPreset(name: string): TavernPreset | undefined {
		const wanted = name.trim().toLowerCase();
		return this.presets.find((entry) => entry.id.toLowerCase() === wanted || entry.name.toLowerCase() === wanted);
	}

	/** Splits a list of book names into the ones that exist and the ones that do not. */
	resolveBooks(names: readonly string[]): { found: string[]; missing: string[] } {
		const found: string[] = [];
		const missing: string[] = [];
		for (const name of names) {
			const wanted = name.trim();
			if (!wanted) {
				continue;
			}
			const hit = this.book(wanted);
			if (hit) {
				found.push(hit.name);
			} else {
				missing.push(wanted);
			}
		}
		return { found, missing };
	}

	/**
	 * The collection a chat sends: the preset's prompts and order, with the card's own overrides
	 * applied. This is what the settings panel edits.
	 */
	promptsFor(sessionId?: string): ActivePrompt[] {
		const session = sessionId ? this.ctx.sessions.get(sessionId) : this.ctx.sessions.active();
		const binding = this.withDefaults({ character: session?.character, preset: session?.preset });
		return turnPrompts(this.preset(binding.preset), this.character(binding.character));
	}

	/**
	 * The text the settings panel shows for every prompt in this chat's collection. A marker is filled
	 * from the same `markerContent` the assembler uses, so the preview and the request cannot disagree;
	 * every other block shows its own content with the decorators stripped, because a decorator tells
	 * the assembler where to put a block and never reaches the model.
	 *
	 * The markers that only exist while a turn is built are deliberately absent — world info needs that
	 * turn's activation scan, and the chat history *is* the conversation — so the panel can report them
	 * as filled from the turn instead of as an empty prompt with no tokens. Comonad's blocks are filled
	 * from the caller's `blocks`, the same values `compose` receives.
	 */
	displayPrompts(sessionId: string | undefined, blocks: readonly PromptBlock[] = []): Record<string, string> {
		const session = sessionId ? this.ctx.sessions.get(sessionId) : this.ctx.sessions.active();
		const config = tavernSettings(this.ctx);
		const binding = this.withDefaults({ character: session?.character, persona: session?.persona });
		const character = this.character(binding.character);
		const persona = this.personaFor(binding.persona, character);
		// No composing turn here, so `{{model}}` and `{{input}}` stand empty rather than guessed at.
		const macro = this.macroContext(undefined, character, persona);
		const prompts = this.promptsFor(sessionId);
		const assembleBlocks: AssembleBlocks = {
			...cardBlocks(character, persona, config, (text) => substituteMacros(text, macro)),
			comonad: this.comonadBlocks(blocks, prompts.some((prompt) => prompt.identifier === TOOLS_PROMPT && prompt.enabled)),
		};
		const options = { wiFormat: config.tavernWiFormat ?? '{0}' };
		const out: Record<string, string> = {};
		for (const prompt of prompts) {
			if (hasMarkerText(prompt.identifier)) {
				const text = markerContent(prompt.identifier, assembleBlocks, options);
				if (text?.trim()) {
					out[prompt.identifier] = text;
				}
				continue;
			}
			if (!prompt.marker) {
				out[prompt.identifier] = previewPrompt(prompt);
			}
		}
		return out;
	}

	/**
	 * The generated text of Comonad's blocks for one preset, as the preset editor shows it. It is the
	 * same map `compose` builds: a block whose content depends on a tool is left empty when the Tools
	 * entry is off, so the editor cannot show instructions the request would not carry.
	 */
	previewPrompts(preset: TavernPreset | undefined, blocks: readonly PromptBlock[]): Record<string, string> {
		const prompts = promptCollection(preset);
		const comonad = this.comonadBlocks(blocks, prompts.some((prompt) => prompt.identifier === TOOLS_PROMPT && prompt.enabled));
		const out: Record<string, string> = {};
		for (const prompt of prompts) {
			if (!isComonadBlockId(prompt.identifier)) {
				continue;
			}
			const text = comonad[prompt.identifier];
			if (text?.trim()) {
				out[prompt.identifier] = text;
			}
		}
		return out;
	}

	/** The agent's named blocks as the assembler's map, with tool-dependent blocks removed when tools are off. */
	private comonadBlocks(blocks: readonly PromptBlock[], toolsEnabled: boolean): Partial<Record<ComonadBlockId, string>> {
		const comonad: Partial<Record<ComonadBlockId, string>> = {};
		for (const block of blocks) {
			comonad[block.id] = block.text;
		}
		if (!toolsEnabled) {
			for (const id of TOOL_DEPENDENT_BLOCKS) {
				comonad[id] = '';
			}
		}
		return comonad;
	}

	/** Where a Comonad-owned preset goes: the project library when this window has one, else home. */
	private writeRoot(): string {
		const host = this.ctx.host;
		return host.trusted() && host.workspace() ? join(host.workspace(), '.comonad') : join(host.home(), '.comonad');
	}

	/** The folder one kind of content is created in, for the "open the library" affordances. */
	libraryPath(kind: ContentKind): string {
		return join(this.writeRoot(), kind);
	}

	/** The library root itself, which holds one folder per kind. */
	libraryRoot(): string {
		return this.writeRoot();
	}

	/** Writes a card where it belongs: a PNG keeps its picture, a JSON card is plain text. */
	private async writeCard(file: string, character: Character, image?: Buffer): Promise<void> {
		await mkdir(dirname(file), { recursive: true });
		if (extname(file).toLowerCase() === '.png') {
			// A PNG card keeps its picture: only the `chara`/`ccv3` chunks are replaced.
			const bytes = cardToPng(image ?? (await readFile(file)), character);
			await writeFile(file, bytes);
			this.noteWrite(file, bytes);
		} else {
			const text = cardToJson(character);
			await writeFile(file, text, 'utf8');
			this.noteWrite(file, text);
		}
	}

	/** Writes a card back to where it came from, or to `characters/<id>.json` when it is new. */
	async saveCharacter(character: Character): Promise<string> {
		const managed = this.managedFile(character.source);
		const file = managed ?? join(this.libraryPath('characters'), `${slugId(character.id, 'character')}.json`);
		await this.writeCard(file, character);
		await this.adoptCharacter(file, managed);
		this.ctx.emit('tavern/changed');
		return file;
	}

	/**
	 * Gives a card a picture. Upstream keeps the two in one file — a PNG *is* the card — so a JSON card
	 * that is given a picture is written as a PNG card beside it and its JSON is removed.
	 */
	async setCharacterAvatar(id: string, image: string): Promise<string> {
		const character = this.character(id);
		if (!character) {
			throw new Error(`there is no character ${id}`);
		}
		const bytes = await readFile(image);
		if (!isPng(bytes)) {
			throw new Error('a card picture has to be a PNG: that is the file the card is written into');
		}
		const managed = this.managedFile(character.source);
		const folder = managed ? dirname(managed) : this.libraryPath('characters');
		const file = join(folder, `${slugId(character.id, 'character')}.png`);
		await this.writeCard(file, character, bytes);
		if (managed && resolve(managed) !== resolve(file)) {
			await rm(managed, { force: true });
			this.noteWrite(managed, null);
		}
		await this.adoptCharacter(file, managed);
		this.ctx.emit('tavern/changed');
		return file;
	}

	/**
	 * Upstream's *Import Card Lore*: the book the card carries becomes a library world book, and the
	 * card is linked to it. The embedded copy stays in the card, exactly as upstream leaves it.
	 */
	async importCardLore(id: string): Promise<{ name: string; entries: number }> {
		const character = this.character(id);
		if (!character) {
			throw new Error(`there is no character ${id}`);
		}
		if (!character.book) {
			throw new Error('this card carries no book of its own');
		}
		const name = (character.book.name ?? '').trim() || `${character.name}'s Lorebook`;
		const book = toWorldBook(character.book, name);
		await this.saveBook(name, { ...book, name });
		await this.saveCharacter({ ...character, world: name });
		return { name, entries: Object.keys(book.entries).length };
	}

	/**
	 * Renames a card the way upstream does: the file is renamed with it (our id *is* the file's stem),
	 * the tag registry key moves, and everything that referred to the old id follows — a persona's
	 * connection, the default character of new chats, and every chat that had it open.
	 */
	async renameCharacter(id: string, name: string): Promise<string> {
		const character = this.character(id);
		if (!character) {
			throw new Error(`there is no character ${id}`);
		}
		const wanted = name.trim();
		if (!wanted) {
			throw new Error('a character needs a name');
		}
		const managed = this.managedFile(character.source);
		const folder = managed ? dirname(managed) : this.libraryPath('characters');
		const target = join(folder, `${slugId(wanted, 'character')}${managed ? extname(managed) : '.json'}`);
		// A rename onto a file another card already owns would write over that card and delete this
		// one; the name is refused instead, the same way a world-book rename is.
		const taken = this.characters.find((other) => other.source && resolve(other.source) === resolve(target));
		if ((managed && resolve(managed) !== resolve(target) && (await stat(target).then(() => true, () => false))) || (taken && taken.id !== character.id)) {
			throw new Error(`another character is already stored as ${basename(target)}`);
		}
		const renamed = { ...character, name: wanted, source: managed ? target : character.source };
		await this.writeCard(target, renamed);
		if (managed && resolve(managed) !== resolve(target)) {
			await rm(managed, { force: true });
			this.noteWrite(managed, null);
		}
		const oldId = character.id;
		const newId = cardId(target);
		const oldKeys = connectionKeys(oldId);
		if (renameKey(this.tags, oldId, newId)) {
			await this.saveTags();
		}
		const linked = this.personas.filter((persona) =>
			persona.connections.some((connection) => connectionKeys(connection.id).some((key) => oldKeys.includes(key))),
		);
		for (const persona of linked) {
			await this.savePersona({
				...persona,
				connections: persona.connections.map((connection) =>
					connectionKeys(connection.id).some((key) => oldKeys.includes(key)) ? { ...connection, id: newId } : connection,
				),
			});
		}
		if (tavernSettings(this.ctx).tavernCharacter === oldId) {
			await this.ctx.settings.update('tavernCharacter', newId);
		}
		for (const session of this.ctx.sessions.list()) {
			if (session.character === oldId) {
				session.character = newId;
				this.ctx.sessions.save(session);
				this.ctx.sessions.changed(session.id);
			}
		}
		await this.reload();
		return newId;
	}

	async deleteCharacter(id: string): Promise<boolean> {
		return this.removeFile(this.character(id));
	}

	/** Writes a world book in SillyTavern's own file shape, renaming the file with the book. */
	async saveBook(name: string, book: WorldBook, source?: string, raw?: Record<string, unknown>): Promise<string> {
		const wanted = name.trim() || book.name;
		const managed = this.managedFile(source ?? '');
		const file = managed ?? join(this.libraryPath('lorebooks'), `${slugId(wanted, 'book')}.json`);
		const renamed = managed && basename(managed, extname(managed)) !== slugId(wanted, 'book');
		const target = renamed ? join(dirname(file), `${slugId(wanted, 'book')}.json`) : file;
		await mkdir(dirname(target), { recursive: true });
		// The file keeps every key it arrived with. The catalog is the fallback for an unsaved raw —
		// looked up by the file the book is coming *from*, since a rename has already changed its name.
		const previous = this.books.find((entry) => (managed ? entry.source && resolve(entry.source) === resolve(managed) : entry.name === book.name));
		const original = raw ?? previous?.raw ?? {};
		const text = worldInfoJson({ ...book, name: wanted }, original);
		await writeFile(target, text, 'utf8');
		this.noteWrite(target, text);
		if (renamed) {
			await rm(file, { force: true });
			this.noteWrite(file, null);
		}
		await this.adoptBook(target, managed ?? undefined);
		if (previous && previous.name.toLowerCase() !== wanted.toLowerCase()) {
			await this.followBookRename(previous.name, wanted);
		}
		this.ctx.emit('tavern/changed');
		return target;
	}

	/**
	 * A renamed book is still the book the settings, the chats and the personas name: every
	 * reference to the old name follows the rename, the same way a renamed card's do.
	 */
	private async followBookRename(from: string, to: string): Promise<void> {
		const config = tavernSettings(this.ctx);
		const active = config.tavernLorebooks ?? [];
		if (active.some((name) => name.toLowerCase() === from.toLowerCase())) {
			await this.ctx.settings.update('tavernLorebooks', active.map((name) => (name.toLowerCase() === from.toLowerCase() ? to : name)));
		}
		for (const session of this.ctx.sessions.list()) {
			const books = session.lorebooks ?? [];
			if (books.some((name) => name.toLowerCase() === from.toLowerCase())) {
				session.lorebooks = books.map((name) => (name.toLowerCase() === from.toLowerCase() ? to : name));
				this.ctx.sessions.save(session);
				this.ctx.sessions.changed(session.id);
			}
		}
		for (const persona of this.personas) {
			if (persona.lorebook && persona.lorebook.toLowerCase() === from.toLowerCase()) {
				await this.savePersona({ ...persona, lorebook: to });
			}
		}
	}

	async deleteBook(name: string): Promise<boolean> {
		const found = this.book(name);
		return found ? this.removeFile(found) : false;
	}

	/** Writes the persona file, with no catalog change of its own — `savePersona` is the public one. */
	private async writePersona(persona: Persona): Promise<string> {
		const managed = this.managedFile(persona.source);
		const file = managed ?? join(this.libraryPath('personas'), `${slugId(persona.id, 'persona')}.json`);
		await mkdir(dirname(file), { recursive: true });
		const text = personaJson(persona, persona.raw as Record<string, unknown>);
		await writeFile(file, text, 'utf8');
		this.noteWrite(file, text);
		return file;
	}

	async savePersona(persona: Persona): Promise<string> {
		const managed = this.managedFile(persona.source);
		const file = await this.writePersona(persona);
		await this.adoptPersona(file, managed);
		this.ctx.emit('tavern/changed');
		return file;
	}

	async deletePersona(id: string): Promise<boolean> {
		const persona = this.persona(id) ?? this.findPersona(id);
		const file = this.managedFile(persona?.source ?? '');
		if (!file) {
			return false;
		}
		await rm(file, { force: true });
		this.noteWrite(file, null);
		// The picture is the persona's too: leaving it behind would name a file nobody owns.
		await this.dropAvatar(dirname(file), basename(file, extname(file)));
		// Upstream clears the default persona and any chat that locked it, so nothing names a ghost.
		const gone = persona?.id ?? id;
		if (tavernSettings(this.ctx).tavernPersona === gone) {
			await this.ctx.settings.update('tavernPersona', '');
		}
		for (const session of this.ctx.sessions.list()) {
			if (session.persona === gone) {
				session.persona = undefined;
				this.ctx.sessions.save(session);
				this.ctx.sessions.changed(session.id);
			}
		}
		await this.reload();
		return true;
	}

	/**
	 * Gives a persona a picture, the way upstream does: the image is a file named after the persona and
	 * sitting beside it. A persona that has never been saved is written first, so a new one can be
	 * given its avatar before it is ever saved by hand.
	 */
	async setPersonaAvatar(id: string, source: string): Promise<string> {
		const persona = this.persona(id) ?? this.findPersona(id);
		if (!persona) {
			throw new Error(`there is no persona ${id}`);
		}
		const file = await this.writePersona(persona);
		const extension = AVATAR_EXTENSIONS.includes(extname(source).toLowerCase() as (typeof AVATAR_EXTENSIONS)[number])
			? extname(source).toLowerCase()
			: '.png';
		const target = join(dirname(file), `${basename(file, extname(file))}${extension}`);
		await this.dropAvatar(dirname(file), basename(file, extname(file)), target);
		await copyFile(source, target);
		this.noteWrite(target, await readFile(target));
		await this.adoptPersona(file, file);
		this.ctx.emit('tavern/changed');
		return target;
	}

	/** Takes a persona's picture away. Returns whether there was one. */
	async clearPersonaAvatar(id: string): Promise<boolean> {
		const persona = this.persona(id) ?? this.findPersona(id);
		const file = this.managedFile(persona?.source ?? '');
		if (!file) {
			return false;
		}
		const gone = await this.dropAvatar(dirname(file), basename(file, extname(file)));
		await this.adoptPersona(file, file);
		this.ctx.emit('tavern/changed');
		return gone;
	}

	/** Removes every picture beside one persona, except `keep`. */
	private async dropAvatar(dir: string, stem: string, keep = ''): Promise<boolean> {
		let gone = false;
		for (const extension of AVATAR_EXTENSIONS) {
			const file = join(dir, `${stem}${extension}`);
			if (file === keep) {
				continue;
			}
			try {
				await stat(file);
			} catch {
				continue;
			}
			await rm(file, { force: true });
			this.noteWrite(file, null);
			gone = true;
		}
		return gone;
	}

	/** Every persona as upstream's backup document, ready to be written to a file. */
	exportPersonas(): PersonaBackup {
		return personaBackup(this.personas, tavernSettings(this.ctx).tavernPersona);
	}

	/**
	 * Restores a backup document: personas the library already has are skipped, and a default persona
	 * the document names is adopted. Returns what was written and what was left out.
	 */
	async importPersonas(value: unknown): Promise<PersonaRestore> {
		const restore = readPersonaBackup(value, new Set(this.personas.map((persona) => persona.id)));
		const dir = this.libraryPath('personas');
		await mkdir(dir, { recursive: true });
		// An id becomes the file's name, so an id that is not file-safe is renamed with it — and the
		// document's default persona follows the same rename.
		const renames = new Map<string, string>();
		for (const persona of restore.personas) {
			const id = slugId(persona.id, 'persona');
			renames.set(persona.id, id);
			const moved = { ...persona, id };
			const file = join(dir, `${id}.json`);
			const text = personaJson(moved, moved.raw as Record<string, unknown>);
			await writeFile(file, text, 'utf8');
			this.noteWrite(file, text);
		}
		const wanted = restore.defaultPersona ? renames.get(restore.defaultPersona) ?? restore.defaultPersona : '';
		if (restore.personas.length) {
			await this.reload();
		}
		if (wanted && this.persona(wanted)) {
			await this.ctx.settings.update('tavernPersona', wanted);
		}
		return { ...restore, personas: restore.personas.map((persona) => ({ ...persona, id: renames.get(persona.id) ?? persona.id })), defaultPersona: wanted };
	}

	/** Writes a preset — its prompts, order and samplers — keeping every key it arrived with. */
	async savePresetValue(preset: TavernPreset, source?: string): Promise<string> {
		const managed = this.managedFile(source ?? this.preset(preset.id)?.source ?? '');
		const file = managed ?? join(this.libraryPath('presets'), `${slugId(preset.id, 'preset')}.json`);
		await mkdir(dirname(file), { recursive: true });
		const text = presetToJson(preset);
		await writeFile(file, text, 'utf8');
		this.noteWrite(file, text);
		await this.adoptPreset(file, managed);
		this.ctx.emit('tavern/changed');
		return file;
	}

	async deletePreset(id: string): Promise<boolean> {
		return this.removeFile(this.preset(id));
	}

	/** The file an item is stored in, when it is one of ours; `undefined` for an unsaved item. */
	private managedFile(source: string): string | undefined {
		if (!source) {
			return undefined;
		}
		const file = resolve(source);
		return this.roots().some((root) => file.startsWith(`${resolve(root)}/`)) ? file : undefined;
	}

	/** The same question asked from outside — an export copies a file byte for byte only if we own it. */
	fileFor(source: string | undefined): string | undefined {
		return this.managedFile(source ?? '');
	}

	/**
	 * Deletes an item's file — only ever inside our own library, never a file the user pointed at
	 * from somewhere else.
	 */
	private async removeFile(item: { source?: string } | undefined): Promise<boolean> {
		const file = this.managedFile(item?.source ?? '');
		if (!file) {
			return false;
		}
		await rm(file, { force: true });
		this.noteWrite(file, null);
		await this.reload();
		// A delete that leaves the catalog unchanged means the file was not there to begin with.
		return true;
	}

	/** The world-info knobs, from the settings. */
	wiSettings(): WorldInfoSettings {
		const config = tavernSettings(this.ctx);
		return {
			scanDepth: numberOr(config.wiScanDepth, WI_SETTINGS_DEFAULTS.scanDepth),
			budget: numberOr(config.wiBudget, WI_SETTINGS_DEFAULTS.budget),
			budgetCap: numberOr(config.wiBudgetCap, WI_SETTINGS_DEFAULTS.budgetCap),
			recursive: config.wiRecursive ?? WI_SETTINGS_DEFAULTS.recursive,
			maxRecursionSteps: numberOr(config.wiMaxRecursionSteps, WI_SETTINGS_DEFAULTS.maxRecursionSteps),
			minActivations: numberOr(config.wiMinActivations, WI_SETTINGS_DEFAULTS.minActivations),
			maxActivationsDepth: numberOr(config.wiMaxActivationsDepth, WI_SETTINGS_DEFAULTS.maxActivationsDepth),
			caseSensitive: config.wiCaseSensitive ?? WI_SETTINGS_DEFAULTS.caseSensitive,
			matchWholeWords: config.wiMatchWholeWords ?? WI_SETTINGS_DEFAULTS.matchWholeWords,
			includeNames: config.wiIncludeNames ?? WI_SETTINGS_DEFAULTS.includeNames,
			characterStrategy: numberOr(config.wiCharacterStrategy, WI_SETTINGS_DEFAULTS.characterStrategy),
			useGroupScoring: config.wiGroupScoring ?? WI_SETTINGS_DEFAULTS.useGroupScoring,
		};
	}

	/** The regex scripts the settings carry, plus the active character's own. */
	scripts(character: Character | undefined): RegexScript[] {
		return [...regexScriptsFrom(tavernSettings(this.ctx).tavernRegex), ...(character?.regex ?? [])];
	}

	/**
	 * The books one chat scans: the ones it selected, plus the character's own card book. Only the
	 * native store's are named — a card book is known as `<character> (card)`.
	 */
	booksFor(sessionId: string, only?: string): LoreBook[] {
		const session = this.ctx.sessions.get(sessionId);
		return this.booksForBinding(this.withDefaults({ character: session?.character, lorebooks: session?.lorebooks }), only);
	}

	/**
	 * The book a card carries, unless the world it is linked to is that same book: *Import Card Lore*
	 * writes the embedded book out as a library book and links it, so scanning both would inject every
	 * entry twice.
	 */
	private cardBookOf(character: Character | undefined, boundName: string): WorldBook | null {
		if (!character?.book) {
			return null;
		}
		const embedded = (character.book.name ?? '').trim().toLowerCase();
		if (embedded && embedded === boundName.trim().toLowerCase()) {
			return null;
		}
		return toWorldBook(character.book, character.name);
	}

	/** Whether the layer owns the prompt for the next turn. */
	enabled(): boolean {
		return tavernSettings(this.ctx).tavernEnabled;
	}

	/**
	 * The index of the active books, so the model knows what it can look up. `heading` is the block's
	 * editable prefix; passing an empty string returns the lines alone, for the agent to head itself.
	 */
	loreIndex(sessionId: string, heading = DEFAULT_BLOCK_PREFIX[COMONAD_BLOCK.lore]): string {
		if (!tavernSettings(this.ctx).tavernEnabled) {
			return '';
		}
		return loreIndex(this.booksFor(sessionId), heading);
	}

	/** The books one binding resolves to, before activation. */
	private booksForBinding(binding: Pick<TavernBinding, 'character' | 'lorebooks'>, only?: string): LoreBook[] {
		const wanted = only?.trim().toLowerCase();
		const books: LoreBook[] = [];
		for (const name of binding.lorebooks ?? []) {
			const found = this.book(name);
			if (found && !books.some((entry) => entry.name === found.name)) {
				books.push({ name: found.name, kind: 'global', book: found.book });
			}
		}
		const character = this.character(binding.character);
		// `extensions.world`: the card binds a world book, which is scanned without being listed.
		const bound = this.book(character?.world ?? '');
		if (bound && !books.some((entry) => entry.name === bound.name)) {
			books.push({ name: bound.name, kind: 'character', book: bound.book });
		}
		const cardBook = this.cardBookOf(character, bound?.name ?? '');
		if (cardBook) {
			books.push({ name: `${character?.name} (card)`, kind: 'character', book: cardBook });
		}
		return wanted ? books.filter((entry) => entry.name.toLowerCase() === wanted) : books;
	}

	/** The chat's binding with the configured defaults filled in for whatever it leaves unset. */
	private withDefaults(binding: TavernBinding): Required<Pick<TavernBinding, 'character' | 'persona' | 'lorebooks' | 'preset'>> & TavernBinding {
		const config = tavernSettings(this.ctx);
		return {
			...binding,
			character: binding.character ?? config.tavernCharacter,
			persona: binding.persona ?? config.tavernPersona,
			lorebooks: binding.lorebooks ?? config.tavernLorebooks,
			preset: binding.preset ?? config.tavernPreset,
		};
	}

	/**
	 * The entries a vector search picks for this turn, as `<book>.<uid>`, which is the shape the scan's
	 * buffer uses. Nothing here can fail the turn: with the vectors off, or an endpoint that will not
	 * answer, the set is simply empty and the scan runs on keys alone.
	 */
	private async vectorHits(books: readonly LoreBook[], scan: readonly { role: 'user' | 'assistant'; text: string }[]): Promise<ReadonlySet<string> | undefined> {
		const settings = vectorSettings(this.ctx);
		// The vectors are this service's own child — reached with `get`, which a row may always use for
		// the services beside it, rather than an inject this row would wait on itself to fill.
		const vectors = this.ctx.get('vectors');
		if (!settings.enabled || !vectors) {
			return undefined;
		}
		const found = await vectors.activate({ books, messages: scan }, settings);
		if (!found.size) {
			return undefined;
		}
		const keys = new Set<string>();
		for (const [book, uids] of found) {
			for (const uid of uids) {
				keys.add(`${book}.${uid}`);
			}
		}
		return keys;
	}

	/** The automations the activated entries named, deduplicated — with the setting applied already. */
	private automationsOf(activated: readonly LoreHit[], config: TavernSettings): LoreAutomation[] {
		if (!config.wiAutomation) {
			return [];
		}
		const seen = new Set<string>();
		const automations: LoreAutomation[] = [];
		for (const hit of activated) {
			const id = (hit.entry.automationId ?? '').trim();
			if (id && !seen.has(id)) {
				seen.add(id);
				automations.push({ id, book: hit.book, uid: hit.entry.uid, comment: (hit.entry.comment ?? '').trim() });
			}
		}
		return automations;
	}

	/**
	 * Composes one turn. When the layer is on it owns the whole request, even with nothing selected:
	 * the shipped collection is the built-in Default. The vector side of the scan runs here as well:
	 * an entry that says `vectorized` is found by meaning, and what it finds activates the scan as if
	 * its keys had matched.
	 */
	async compose(input: ComposeInput): Promise<ComposeResult> {
		const config = tavernSettings(this.ctx);
		if (!config.tavernEnabled) {
			return {
				messages: [],
				prompts: [],
				activated: [],
				buckets: { before: [], after: [], atDepth: [], anTop: [], anBottom: [], examplesBefore: [], examplesAfter: [], outlets: {}, activated: [], effects: {}, overflowed: false },
				effects: {},
				takeover: false,
				toolsEnabled: true,
				samplers: {},
				overflowAlert: false,
				automations: [],
			};
		}
		const binding = this.withDefaults(input.binding);
		const character = this.character(binding.character);
		const persona = this.personaFor(binding.persona, character);
		const preset = this.preset(binding.preset);
		const wanted = binding.lorebooks ?? [];
		const selected: LoadedBook[] = [];
		const bound: LoadedBook[] = [];
		for (const name of wanted) {
			const found = this.book(name);
			if (found) {
				selected.push(found);
			}
		}
		// A character's own book and a persona's book come along without being listed.
		const cardWorld = this.book(character?.world ?? '');
		const cardBook = this.cardBookOf(character, cardWorld?.name ?? '');
		if (cardBook) {
			bound.push({ name: `${character?.name} (card)`, book: cardBook, source: character?.id ?? '', raw: {} });
		}
		// `extensions.world` binds a library book to the card, the way SillyTavern does.
		if (cardWorld && !selected.some((entry) => entry.name === cardWorld.name)) {
			bound.push(cardWorld);
		}
		const personaBook = this.book(persona?.lorebook ?? '');
		if (personaBook) {
			selected.push(personaBook);
		}
		const prompts = turnPrompts(preset, character, input.trigger);
		// The single Tools entry is the turn's switch: off means the request carries no API tools at all.
		const toolsEnabled = prompts.some((prompt) => prompt.identifier === TOOLS_PROMPT && prompt.enabled);
		const scripts = this.scripts(character);
		const macro = this.macroContext(input, character, persona);
		// `{{outlet::Name}}` reads the outlets the scan collects, so both sides share one object: the
		// scan fills its own copy, which is folded in below before any prompt text is substituted.
		const outlets: Record<string, string[]> = {};
		macro.outlets = outlets;
		const substitute = (text: string): string => substituteMacros(text, macro);
		const history = input.history.map((message) => this.regexed(scripts, message));

		const books = [
			...selected.map((book) => ({ name: book.name, kind: 'global' as const, book: book.book })),
			...bound.map((book) => ({ name: book.name, kind: 'character' as const, book: book.book })),
		];
		const lore = activateLore({
			books,
			messages: input.scan.map((item) => ({
				speaker: item.role === 'user' ? persona?.name || macro.user : character?.name || macro.char,
				text: item.text,
			})),
			fields: {
				persona: persona?.description,
				description: character?.description,
				personality: character?.personality,
				depthPrompt: character?.depthPrompt?.prompt,
				scenario: character?.scenario,
				creatorNotes: character?.creatorNotes,
			},
			// An entry's own character/tag filter compares against the card it was read from: the name is
			// the file name — SillyTavern’s “avatar name” — and the tags are registry **ids**, because
			// that is what upstream stores in `character_filter` and what its filter select writes.
			character: character ? { name: character.id, tags: this.tagIdsFor(character.id) } : undefined,
			settings: this.wiSettings(),
			// The preset's context size is the honest fallback: with neither, the budget is unlimited.
			contextSize: input.contextSize && input.contextSize > 0 ? input.contextSize : (preset?.maxContext ?? 0),
			turn: input.turn,
			trigger: input.trigger ?? 'normal',
			external: await this.vectorHits(books, input.scan),
			effects: binding.effects,
			// The budget is counted in the kernel's tokens: this bundle's own copy of the estimator
			// never sees the tokenizer that is loaded, only the service does.
			count: (text: string) => this.ctx.get('tokenizers')?.count(text) ?? estimateTokens(text),
			substitute,
			transform: (content) => applyRegex(scripts, substitute(content), { placement: REGEX_PLACEMENT.worldInfo, isPrompt: true }),
		});
		// Outlet entries are not injected where they sit: they are collected here and expanded wherever
		// a prompt writes `{{outlet::Name}}`.
		Object.assign(outlets, lore.outlets);

		const note = this.authorNote(binding, lore, substitute, persona);
		const atDepth = [...lore.atDepth];
		// Upstream's continue nudge: the preset's own words, said right after the message being carried
		// on from. The agent falls back to its own sentence when the preset has none.
		const nudge = input.trigger === 'continue' ? this.continueNudge(binding, lastMessage(input.history)) : '';
		if (nudge) {
			atDepth.push({ depth: 0, role: WI_ROLE.system, content: substitute(nudge) });
		}
		if (note.content) {
			atDepth.push({ depth: note.depth, role: note.role, content: note.content });
		}
		if (persona && persona.position === PERSONA_POSITION.atDepth && persona.description) {
			atDepth.push({ depth: persona.depth, role: persona.role as WiRole, content: substitute(persona.description) });
		}
		// The card's depth prompt is a character-specific author's note: in chat, at its own depth.
		if (character?.depthPrompt?.prompt.trim()) {
			atDepth.push({
				depth: numberOr(character.depthPrompt.depth, WI_ENTRY_DEFAULTS.depth ?? 4),
				role: character.depthPrompt.role === 'user' ? WI_ROLE.user : character.depthPrompt.role === 'assistant' ? WI_ROLE.assistant : WI_ROLE.system,
				content: substitute(character.depthPrompt.prompt),
			});
		}
		const blocks: AssembleBlocks = {
			...cardBlocks(character, persona, config, substitute),
			comonad: this.comonadBlocks(input.blocks, toolsEnabled),
			worldInfoBefore: lore.before.join('\n'),
			worldInfoAfter: lore.after.join('\n'),
			examplesBefore: lore.examplesBefore,
			examplesAfter: lore.examplesAfter,
			atDepth,
			// Upstream heads the history block with the preset's *new chat* prompt, and fills an empty turn
			// with `send_if_empty` when the history would otherwise end on the reply.
			historyHead: preset?.new_chat_prompt,
			sendIfEmpty: preset?.send_if_empty,
		};
		const messages = assemble(prompts, blocks, history, { wiFormat: config.tavernWiFormat ?? '{0}', substitute });
		return {
			messages,
			prompts,
			activated: lore.activated,
			buckets: lore,
			effects: lore.effects,
			takeover: true,
			toolsEnabled,
			samplers: presetSamplers(preset),
			overflowAlert: config.wiOverflowAlert && lore.overflowed,
			automations: this.automationsOf(lore.activated, config),
		};
	}

	/** The macro context one turn substitutes with. The compose input is absent when nothing is composing. */
	private macroContext(input: ComposeInput | undefined, character: Character | undefined, persona: Persona | undefined): MacroContext {
		return {
			char: character?.name ?? 'Assistant',
			user: persona?.name ?? tavernSettings(this.ctx).tavernUserName ?? 'User',
			persona: persona?.description,
			description: character?.description,
			personality: character?.personality,
			scenario: character?.scenario,
			charPrompt: character?.systemPrompt,
			charInstruction: character?.postHistoryInstructions,
			charDepthPrompt: character?.depthPrompt?.prompt,
			charVersion: character?.version,
			creatorNotes: character?.creatorNotes,
			model: input?.model,
			input: input?.scan[0]?.text,
		};
	}

	/**
	 * Upstream's *continue nudge*: what a preset says when the model is asked to carry the last message
	 * on. `{{lastChatMessage}}` is that message, exactly as upstream substitutes it. A preset without
	 * one answers `''`, and the agent says its own words instead.
	 */
	continueNudge(binding: TavernBinding, lastChatMessage = ''): string {
		const resolved = this.withDefaults(binding);
		const template = (this.preset(resolved.preset)?.continue_nudge_prompt ?? '').trim();
		if (!template) {
			return '';
		}
		const character = this.character(resolved.character);
		const persona = this.personaFor(resolved.persona, character);
		const macro = this.macroContext(undefined, character, persona);
		return substituteMacros(template, { ...macro, lastChatMessage }).trim();
	}

	/**
	 * The preset's impersonation prompt, substituted: what SillyTavern sends when the model writes your
	 * next message for you. Upstream replaces `{{user}}` with “You” here, and so does this. With no
	 * template in the preset, the plain request stands in — said in the user's own name.
	 */
	impersonationPrompt(binding: TavernBinding): string {
		const resolved = this.withDefaults(binding);
		const character = this.character(resolved.character);
		const persona = this.personaFor(resolved.persona, character);
		const macro = this.macroContext(undefined, character, persona);
		const template = (this.preset(resolved.preset)?.impersonation_prompt ?? '').trim();
		if (!template) {
			return `Write the next message of this conversation as ${tavernSettings(this.ctx).tavernUserName || 'the user'}, in their voice, and nothing else.`;
		}
		return substituteMacros(template.replaceAll(/{{user}}/gi, 'You'), macro).trim();
	}
	/** The author's note: the configured text, the persona's own bottom/top placements, and the
	 *  world-info entries that asked for its edges. */
	private authorNote(
		binding: TavernBinding,
		lore: LoreResult,
		substitute: (text: string) => string,
		persona: Persona | undefined,
	): { content: string; depth: number; role: WiRole } {
		const configured = (binding.authorNote ?? tavernSettings(this.ctx).tavernAuthorNote ?? '').trim();
		const personaTop = persona?.position === PERSONA_POSITION.anTop ? persona.description : '';
		const personaBottom = persona?.position === PERSONA_POSITION.anBottom ? persona.description : '';
		const parts = [...lore.anTop, personaTop, configured, personaBottom, ...lore.anBottom].filter(Boolean);
		return {
			content: substitute(parts.join('\n')).trim(),
			depth: numberOr(persona?.position === PERSONA_POSITION.atDepth ? undefined : tavernSettings(this.ctx).tavernNoteDepth, 4),
			role: 0 as WiRole,
		};
	}

	/** A history message with the regex scripts applied on its way into the prompt. */
	private regexed(scripts: readonly RegexScript[], message: Message): Message {
		if (!scripts.length || !message.content) {
			return message;
		}
		const placement = message.role === 'assistant' ? REGEX_PLACEMENT.aiOutput : message.role === 'user' ? REGEX_PLACEMENT.userInput : null;
		if (placement === null) {
			return message;
		}
		return { ...message, content: applyRegex(scripts, message.content, { placement, isPrompt: true }) };
	}

	/** Reads one `.comonad` library root. */
	private async readLibrary(
		root: string,
		into: { characters: Character[]; books: LoadedBook[]; presets: TavernPreset[]; personas: Persona[] },
	): Promise<void> {
		await this.readCharacterDir(join(root, 'characters'), into.characters);
		for (const file of await listFiles(join(root, 'lorebooks'))) {
			const book = await readBookFile(file);
			if (book) {
				into.books.push({ name: book.name, book, source: file, raw: book.raw ?? {} });
			}
		}
		for (const file of await listFiles(join(root, 'presets'))) {
			if (extname(file).toLowerCase() !== '.json') {
				continue;
			}
			try {
				into.presets.push({ ...(await loadPreset(file)), source: file });
			} catch (error) {
				this.warn(file, error);
			}
		}
		const personaDir = join(root, 'personas');
		const avatars = await this.avatarsIn(personaDir);
		for (const file of await listFiles(personaDir)) {
			if (extname(file).toLowerCase() !== '.json') {
				continue;
			}
			try {
				const id = personaId(file);
				const persona = readPersonaFile(JSON.parse(await readFile(file, 'utf8')) as unknown, id, file);
				const avatar = avatars.get(id);
				into.personas.push(avatar ? { ...persona, avatar } : persona);
			} catch (error) {
				this.warn(file, error);
			}
		}
	}

	/**
	 * The picture beside a persona's file, which is how upstream stores an avatar. The persona's id is
	 * the file's name, so the picture is found by asking for the same stem with an image extension.
	 */
	private async avatarsIn(dir: string): Promise<Map<string, string>> {
		const found = new Map<string, string>();
		for (const file of await listFiles(dir)) {
			const extension = extname(file).toLowerCase() as (typeof AVATAR_EXTENSIONS)[number];
			if (AVATAR_EXTENSIONS.includes(extension)) {
				found.set(basename(file, extension), file);
			}
		}
		return found;
	}

	private async readCharacterDir(dir: string, into: Character[]): Promise<void> {
		for (const file of await listFiles(dir)) {
			if (!isCardFile(file)) {
				continue;
			}
			try {
				into.push(await loadCard(file));
			} catch (error) {
				this.warn(file, error);
			}
		}
	}

	private warn(file: string, error: unknown): void {
		this.ctx.log.message(`tavern: skipped ${basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export const tavernPlugin = Tavern;

	/**
	 * The prompt list one turn uses: the preset's order, the card's overrides, and no roleplay at all
	 * when neither a character nor a preset is in play. `trigger` picks the blocks: one limited to some
	 * generation types is left out of the others.
	 */
/**
 * The blocks a card and a persona supply. One function builds them for the assembler and for the
 * settings panel's preview, so what the panel says a marker holds cannot drift from what is sent.
 */
function cardBlocks(
	character: Character | undefined,
	persona: Persona | undefined,
	config: TavernSettings,
	substitute: (text: string) => string,
): Omit<AssembleBlocks, 'comonad'> {
	return {
		charDescription: character?.description,
		// A configured format wraps the value; without one the card's own text is sent as it stands.
		charPersonality:
			character?.personality && config.tavernPersonalityFormat
				? macroize(config.tavernPersonalityFormat, substitute)
				: character?.personality,
		scenario: character?.scenario && config.tavernScenarioFormat ? macroize(config.tavernScenarioFormat, substitute) : character?.scenario,
		personaDescription: persona && persona.position === PERSONA_POSITION.inPrompt ? persona.description : undefined,
		examples: character?.examples,
	};
}

export function turnPrompts(
	preset: TavernPreset | undefined,
	character: Character | undefined,
	trigger?: GenerationTrigger,
): ActivePrompt[] {
	const prompts = promptCollection(preset, character?.id ?? '', trigger);
	if (character) {
		return applyCardOverrides(prompts, character);
	}
	// No character and no roleplay preset: the built-in Default (or its editable copy, which is the
	// same collection) must not tell a coding chat to write someone else's next reply.
	return preset && preset.id !== DEFAULT_PRESET_ID ? prompts : withoutRoleplayScaffolding(prompts);
}

/** Reads a world book file: the native shape, keeping the file for a lossless round trip. */
export async function readBookFile(file: string): Promise<(WorldBook & { raw: Record<string, unknown> }) | null> {
	const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
	if (!parsed || typeof parsed !== 'object') {
		return null;
	}
	const record = parsed as { name?: string; entries?: unknown };
	const fallback = basename(file, extname(file));
	if (Array.isArray(record.entries)) {
		const book = toWorldBook(record as { name?: string; entries: unknown[] }, fallback);
		return { ...book, raw: record as Record<string, unknown> };
	}
	if (!record.entries || typeof record.entries !== 'object') {
		return null;
	}
	const book = worldInfoToBook(record.name?.trim() || fallback, record.entries as Record<string, unknown>);
	return { ...book, raw: record as Record<string, unknown> };
}

/** Reads one persona from either our own file shape or a SillyTavern description block. */
export function readPersonaFile(value: unknown, id: string, source: string): Persona {
	return personaFrom(value, id, id, source);
}

function personaId(file: string): string {
	const base = basename(file);
	return base.slice(0, base.length - extname(base).length);
}

/** The message a continue carries on from: the last one in the history, as upstream takes it. */
function lastMessage(history: readonly Message[]): string {
	return history[history.length - 1]?.content ?? '';
}

async function listFiles(dir: string): Promise<string[]> {	try {
		const info = await stat(dir);
		if (!info.isDirectory()) {
			return [];
		}
	} catch {
		return [];
	}
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
			.slice(0, MAX_FILES)
			.map((entry) => join(dir, entry.name));
	} catch {
		return [];
	}
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	const kept: T[] = [];
	for (const item of items) {
		const id = key(item).toLowerCase();
		if (!seen.has(id)) {
			seen.add(id);
			kept.push(item);
		}
	}
	return kept;
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** `scenario_format` and `personality_format` wrap the card field and are substituted like prompts. */
function macroize(format: string, substitute: (text: string) => string): string {
	return substitute(format).trim();
}
