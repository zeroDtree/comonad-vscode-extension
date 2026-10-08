import { readFile, readdir, stat } from 'node:fs/promises';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Service, type Context } from 'cordis';
import type { Message } from '../lib/types';
import { cardId, cardToJson, cardToPng, isCardFile, isPng, loadCard } from '../lib/tavern/card';
import { personaJson, slugId, worldInfoJson } from '../lib/tavern/authoring';
import { connectionKeys, personaBackup, personaFrom, readPersonaBackup, type PersonaBackup, type PersonaRestore } from '../lib/tavern/personas';
import { activateLore, loreIndex, toWorldBook, worldInfoToBook, type LoreBook, type LoreHit, type LoreResult, type TimedEffects } from '../lib/tavern/lore';
import { substituteMacros, type MacroContext } from '../lib/tavern/macro';
import { applyRegex, regexScriptsFrom } from '../lib/tavern/regex';
import { emptyStore, mergeStores, readStore, renameKey, storeJson, tagIdsOf, tagsOf, type Tag, type TagStore } from '../lib/tavern/tags';
import { loadPreset, presetSamplers, presetToJson, type PresetSamplers } from '../lib/tavern/preset';
import { applyCardOverrides, promptCollection, withoutRoleplayScaffolding, type ActivePrompt } from '../lib/tavern/prompts';
import { assemble, type AssembleBlocks } from '../lib/tavern/assemble';
import {
	PERSONA_POSITION,
	REGEX_PLACEMENT,
	WI_ENTRY_DEFAULTS,
	WI_ROLE,
	WI_SETTINGS_DEFAULTS,
	type Character,
	type Persona,
	type PromptItem,
	type RegexScript,
	type TavernPreset,
	type GenerationTrigger,
	type WiRole,
	type WorldBook,
	type WorldInfoSettings,
} from '../lib/tavern/types';

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
	/** Comonad's identity block, already built by the agent. */
	identity: string;
	/** The conversation in wire form, oldest first. */
	history: Message[];
	/** What the chat has selected. */
	binding: TavernBinding;
	/** Newest first, as the world-info scan wants them. */
	scan: Array<{ role: 'user' | 'assistant'; text: string }>;
	/** Chat length for this scan, which is the unit the timed effects count in. */
	turn: number;
	/** What started this generation: an entry may be tied to one of upstream's generation types. */
	trigger?: GenerationTrigger;
	/** Entries a vector search found, as `<book>.<uid>`, which the scan activates without their keys. */
	external?: ReadonlySet<string>;
	/** The model of the chat, for the `{{model}}` macro. */
	model?: string;
	/** Context the endpoint accepts, for the world-info budget. */
	contextSize?: number;
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
	/** True when the chat has no tavern content at all: the caller keeps its own shape. */
	inert: boolean;
	/** The presets's sampler settings, when a preset is selected. */
	samplers: PresetSamplers;
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

/** The picture formats upstream accepts for a persona's avatar; ours is the file beside the JSON. */
const AVATAR_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;

declare module 'cordis' {
	interface Context {
		tavern: Tavern;
	}
}

export class Tavern extends Service {
	static inject = ['host', 'log', 'settings', 'sessions'];

	characters: Character[] = [];
	books: LoadedBook[] = [];
	presets: TavernPreset[] = [];
	personas: Persona[] = [];
	/** The tag registry: SillyTavern keeps it beside the settings, Comonad in `.comonad/tags.json`. */
	tags: TagStore = emptyStore();

	constructor(ctx: Context) {
		super(ctx, 'tavern');
	}

	/** Re-reads every source. A broken file is logged and skipped, never fatal. */
	async reload(): Promise<void> {
		const host = this.ctx.host;
		const characters: Character[] = [];
		const books: LoadedBook[] = [];
		const presets: TavernPreset[] = [];
		const personas: Persona[] = [];
		for (const root of this.roots()) {
			await this.readLibrary(root, { characters, books, presets, personas });
		}
		this.tags = await this.readTags();
		this.characters = uniqueBy(characters, (character) => character.id);
		this.books = uniqueBy(books, (book) => book.name.toLowerCase());
		this.presets = uniqueBy(presets, (preset) => preset.id);
		this.personas = uniqueBy(personas, (persona) => persona.id);
		this.ctx.log.message(
			`tavern: ${this.characters.length} character(s), ${this.books.length} lorebook(s), ${this.presets.length} preset(s), ${this.personas.length} persona(s)`,
		);
		this.ctx.emit('tavern/changed');
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
		await writeFile(file, storeJson(this.tags), 'utf8');
		this.tags = await this.readTags();
		this.ctx.emit('tavern/changed');
	}

	/** The tags a character carries, in the registry's order. */
	tagsFor(id: string | undefined): Tag[] {
		const character = this.character(id);
		return character ? tagsOf(this.tags, character.id) : [];
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
		return this.persona(this.ctx.settings.get().tavernPersona);
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
		const config = this.ctx.settings.get();
		const preset = this.preset(session?.preset ?? config.tavernPreset);
		const character = this.character(session?.character ?? config.tavernCharacter);
		return turnPrompts(preset, character);
	}

	/**
	 * Saves a prompt collection as a preset in the native store — `.comonad/presets` in this
	 * workspace, or the user folder when the window has no trusted folder.
	 */
	async savePreset(name: string, prompts: readonly ActivePrompt[], base?: TavernPreset): Promise<string> {
		const id = slugId(name, 'preset');
		// The base supplies the samplers and the unknown keys; the file is the one the *new* id owns,
		// so "save as" never overwrites the preset it was copied from.
		const preset: TavernPreset = {
			...(base ?? this.preset(id) ?? { id, name }),
			id,
			name: name.trim() || id,
			prompts: prompts.map((prompt) => prompt as unknown as PromptItem),
			promptOrder: prompts.map((prompt) => ({ identifier: prompt.identifier, enabled: prompt.enabled })),
			raw: base?.raw ?? this.preset(id)?.raw ?? {},
		};
		await this.savePresetValue(preset, this.preset(id)?.source);
		return id;
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
			await writeFile(file, cardToPng(image ?? (await readFile(file)), character));
		} else {
			await writeFile(file, cardToJson(character), 'utf8');
		}
	}

	/** Writes a card back to where it came from, or to `characters/<id>.json` when it is new. */
	async saveCharacter(character: Character): Promise<string> {
		const managed = this.managedFile(character.source);
		const file = managed ?? join(this.libraryPath('characters'), `${slugId(character.id, 'character')}.json`);
		await this.writeCard(file, character);
		await this.reload();
		return file;
	}

	/**
	 * Gives a card a picture. Upstream keeps the two in one file — a PNG *is* the card — so a JSON card
	 * that is given a picture is written as a PNG card beside it and its JSON is removed.
	 */
	async setCharacterAvatar(id: string, image: string): Promise<string> {
		const character = this.character(id) ?? this.characters[0];
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
		}
		await this.reload();
		return file;
	}

	/**
	 * Upstream's *Import Card Lore*: the book the card carries becomes a library world book, and the
	 * card is linked to it. The embedded copy stays in the card, exactly as upstream leaves it.
	 */
	async importCardLore(id: string): Promise<{ name: string; entries: number }> {
		const character = this.character(id) ?? this.characters[0];
		if (!character?.book) {
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
		const character = this.character(id) ?? this.characters[0];
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
		const renamed = { ...character, name: wanted, source: managed ? target : character.source };
		await this.writeCard(target, renamed);
		if (managed && resolve(managed) !== resolve(target)) {
			await rm(managed, { force: true });
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
		if (this.ctx.settings.get().tavernCharacter === oldId) {
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
		return this.removeFile('characters', this.character(id));
	}

	/** Writes a world book in SillyTavern's own file shape, renaming the file with the book. */
	async saveBook(name: string, book: WorldBook, source?: string, raw?: Record<string, unknown>): Promise<string> {
		const wanted = name.trim() || book.name;
		const managed = this.managedFile(source ?? '');
		const file = managed ?? join(this.libraryPath('lorebooks'), `${slugId(wanted, 'book')}.json`);
		const renamed = managed && basename(managed, extname(managed)) !== slugId(wanted, 'book');
		const target = renamed ? join(dirname(file), `${slugId(wanted, 'book')}.json`) : file;
		await mkdir(dirname(target), { recursive: true });
		// The file keeps every key it arrived with; the catalog is the fallback for an unsaved raw.
		const original = raw ?? this.books.find((entry) => entry.name === book.name)?.raw ?? {};
		await writeFile(target, worldInfoJson({ ...book, name: wanted }, original), 'utf8');
		if (renamed) {
			await rm(file, { force: true });
		}
		await this.reload();
		return target;
	}

	async deleteBook(name: string): Promise<boolean> {
		const found = this.book(name);
		return found ? this.removeFile('lorebooks', found) : false;
	}

	async savePersona(persona: Persona): Promise<string> {
		const managed = this.managedFile(persona.source);
		const file = managed ?? join(this.libraryPath('personas'), `${slugId(persona.id, 'persona')}.json`);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, personaJson(persona, persona.raw as Record<string, unknown>), 'utf8');
		await this.reload();
		return file;
	}

	async deletePersona(id: string): Promise<boolean> {
		const persona = this.persona(id) ?? this.findPersona(id);
		const file = this.managedFile(persona?.source ?? '');
		if (!file) {
			return false;
		}
		await rm(file, { force: true });
		// The picture is the persona's too: leaving it behind would name a file nobody owns.
		await this.dropAvatar(dirname(file), basename(file, extname(file)));
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
		const file = await this.savePersona(persona);
		const extension = AVATAR_EXTENSIONS.includes(extname(source).toLowerCase() as (typeof AVATAR_EXTENSIONS)[number])
			? extname(source).toLowerCase()
			: '.png';
		const target = join(dirname(file), `${basename(file, extname(file))}${extension}`);
		await this.dropAvatar(dirname(file), basename(file, extname(file)), target);
		await copyFile(source, target);
		await this.reload();
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
		await this.reload();
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
			gone = true;
		}
		return gone;
	}

	/** Every persona as upstream's backup document, ready to be written to a file. */
	exportPersonas(): PersonaBackup {
		return personaBackup(this.personas, this.ctx.settings.get().tavernPersona);
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
			await writeFile(join(dir, `${id}.json`), personaJson(moved, moved.raw as Record<string, unknown>), 'utf8');
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
		await writeFile(file, presetToJson(preset), 'utf8');
		await this.reload();
		return file;
	}

	async deletePreset(id: string): Promise<boolean> {
		return this.removeFile('presets', this.preset(id));
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
	private async removeFile(kind: ContentKind, item: { source?: string } | undefined): Promise<boolean> {
		const file = this.managedFile(item?.source ?? '');
		if (!file) {
			return false;
		}
		await rm(file, { force: true });
		await this.reload();
		// A delete that leaves the catalog unchanged means the file was not there to begin with.
		return true;
	}

	/** The world-info knobs, from the settings. */
	wiSettings(): WorldInfoSettings {
		const config = this.ctx.settings.get();
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
		return [...regexScriptsFrom(this.ctx.settings.get().tavernRegex), ...(character?.regex ?? [])];
	}

	/**
	 * The books one chat scans: the ones it selected, plus the character's own card book. Only the
	 * native store's are named — a card book is known as `<character> (card)`.
	 */
	booksFor(sessionId: string, only?: string): LoreBook[] {
		const session = this.ctx.sessions.get(sessionId);
		return this.booksForBinding(
			{
				character: session?.character ?? this.ctx.settings.get().tavernCharacter,
				lorebooks: session?.lorebooks ?? this.ctx.settings.get().tavernLorebooks,
			},
			only,
		);
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

	/** The index of the active books, so the model knows what it can look up. */
	loreIndex(sessionId: string): string {
		return loreIndex(this.booksFor(sessionId));
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

	/**
	 * Composes one turn. With no character, book, persona or preset selected the result is inert and
	 * the caller keeps its own message shape — that is what makes the port risk-free to ship.
	 */
	compose(input: ComposeInput): ComposeResult {
		const config = this.ctx.settings.get();
		const character = this.character(input.binding.character);
		const persona = this.personaFor(input.binding.persona, character);
		const preset = this.preset(input.binding.preset);
		const wanted = input.binding.lorebooks ?? config.tavernLorebooks ?? [];
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
			external: input.external,
			effects: input.binding.effects,
			substitute,
			transform: (content) => applyRegex(scripts, substitute(content), { placement: REGEX_PLACEMENT.worldInfo, isPrompt: true }),
		});
		// Outlet entries are not injected where they sit: they are collected here and expanded wherever
		// a prompt writes `{{outlet::Name}}`.
		Object.assign(outlets, lore.outlets);

		const note = this.authorNote(input.binding, lore, substitute, persona);
		const atDepth = [...lore.atDepth];
		// Upstream's continue nudge: the preset's own words, said right after the message being carried
		// on from. The agent falls back to its own sentence when the preset has none.
		const nudge = input.trigger === 'continue' ? this.continueNudge(input.binding, lastMessage(input.history)) : '';
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
			identity: input.identity,
			charDescription: character?.description,
			charPersonality: character?.personality && config.tavernPersonalityFormat ? macroize(config.tavernPersonalityFormat, substitute) : character?.personality,
			scenario: character?.scenario && config.tavernScenarioFormat ? macroize(config.tavernScenarioFormat, substitute) : character?.scenario,
			personaDescription: persona && persona.position === PERSONA_POSITION.inPrompt ? persona.description : undefined,
			worldInfoBefore: lore.before.join('\n'),
			worldInfoAfter: lore.after.join('\n'),
			examples: character?.examples,
			examplesBefore: lore.examplesBefore,
			examplesAfter: lore.examplesAfter,
			atDepth,
			// Upstream heads the history block with the preset's *new chat* prompt, and fills an empty turn
			// with `send_if_empty` when the history would otherwise end on the reply.
			historyHead: preset?.new_chat_prompt,
			sendIfEmpty: preset?.send_if_empty,
		};
		const messages = assemble(prompts, blocks, history, { wiFormat: config.tavernWiFormat ?? '{0}', substitute });
		const inert = !character && !preset && !persona && !selected.length && !bound.length && !note.content;
		return { messages, prompts, activated: lore.activated, buckets: lore, effects: lore.effects, inert, samplers: presetSamplers(preset) };
	}

	/** The macro context one turn substitutes with. The compose input is absent when nothing is composing. */
	private macroContext(input: ComposeInput | undefined, character: Character | undefined, persona: Persona | undefined): MacroContext {
		return {
			char: character?.name ?? 'Assistant',
			user: persona?.name ?? this.ctx.settings.get().tavernUserName ?? 'User',
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
	 * on. `{{lastChatMessage}}` is that message, exactly as upstream substitutes it.
	 */
	continueNudge(binding: TavernBinding, lastChatMessage = ''): string {
		const template = (this.preset(binding.preset ?? '')?.continue_nudge_prompt ?? '').trim();
		if (!template) {
			return '';
		}
		const character = this.character(binding.character);
		const persona = this.personaFor(binding.persona, character);
		const macro = this.macroContext(undefined, character, persona);
		return substituteMacros(template, { ...macro, lastChatMessage }).trim();
	}

	/**
	 * The preset's impersonation prompt, substituted: what SillyTavern sends when the model writes your
	 * next message for you. Upstream replaces `{{user}}` with “You” here, and so does this.
	 */
	impersonationPrompt(binding: TavernBinding): string {
		const template = (this.preset(binding.preset)?.impersonation_prompt ?? '').trim();
		if (!template) {
			return '';
		}
		const character = this.character(binding.character);
		const persona = this.personaFor(binding.persona, character);
		const macro = this.macroContext(undefined, character, persona);
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
		const configured = (binding.authorNote ?? this.ctx.settings.get().tavernAuthorNote ?? '').trim();
		const personaTop = persona?.position === PERSONA_POSITION.anTop ? persona.description : '';
		const personaBottom = persona?.position === PERSONA_POSITION.anBottom ? persona.description : '';
		const parts = [...lore.anTop, personaTop, configured, personaBottom, ...lore.anBottom].filter(Boolean);
		return {
			content: substitute(parts.join('\n')).trim(),
			depth: numberOr(persona?.position === PERSONA_POSITION.atDepth ? undefined : this.ctx.settings.get().tavernNoteDepth, 4),
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
export function turnPrompts(
	preset: TavernPreset | undefined,
	character: Character | undefined,
	trigger?: GenerationTrigger,
): ActivePrompt[] {
	const prompts = promptCollection(preset, character?.id ?? '', trigger);
	if (character) {
		return applyCardOverrides(prompts, character);
	}
	return preset ? prompts : withoutRoleplayScaffolding(prompts);
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
