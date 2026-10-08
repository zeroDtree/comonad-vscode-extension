import { readFile, readdir, stat } from 'node:fs/promises';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Service, type Context } from 'cordis';
import type { Message } from '../lib/types';
import { cardToJson, cardToPng, isCardFile, loadCard } from '../lib/tavern/card';
import { personaJson, slugId, worldInfoJson } from '../lib/tavern/authoring';
import { activateLore, loreIndex, toWorldBook, worldInfoToBook, type LoreBook, type LoreHit, type LoreResult, type TimedEffects } from '../lib/tavern/lore';
import { substituteMacros, type MacroContext } from '../lib/tavern/macro';
import { applyRegex, regexScriptsFrom } from '../lib/tavern/regex';
import { loadPreset, presetSamplers, presetToJson } from '../lib/tavern/preset';
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
	type PersonaDescription,
	type PromptItem,
	type RegexScript,
	type TavernPreset,
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
	samplers: { temperature?: number; topP?: number; maxTokens?: number };
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
			const keys = [character.id, character.name].map((key) => key.toLowerCase());
			const linked = this.personas.find((persona) => persona.connections.some((name) => keys.includes(name.trim().toLowerCase())));
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

	/** Writes a card back to where it came from, or to `characters/<id>.json` when it is new. */
	async saveCharacter(character: Character): Promise<string> {
		const managed = this.managedFile(character.source);
		const file = managed ?? join(this.libraryPath('characters'), `${slugId(character.id, 'character')}.json`);
		await mkdir(dirname(file), { recursive: true });
		if (extname(file).toLowerCase() === '.png') {
			// A PNG card keeps its picture: only the `chara`/`ccv3` chunks are replaced.
			await writeFile(file, cardToPng(await readFile(file), character));
		} else {
			await writeFile(file, cardToJson(character), 'utf8');
		}
		await this.reload();
		return file;
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
		return this.removeFile('personas', this.persona(id) ?? this.findPersona(id));
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
		if (character?.book) {
			const cardBook = toWorldBook(character.book, character.name);
			books.push({ name: `${character.name} (card)`, kind: 'character', book: cardBook });
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
		if (character?.book) {
			bound.push({ name: `${character.name} (card)`, book: toWorldBook(character.book, character.name), source: character.id, raw: {} });
		}
		// `extensions.world` binds a library book to the card, the way SillyTavern does.
		const cardWorld = this.book(character?.world ?? '');
		if (cardWorld && !selected.some((entry) => entry.name === cardWorld.name)) {
			bound.push(cardWorld);
		}
		const personaBook = this.book(persona?.lorebook ?? '');
		if (personaBook) {
			selected.push(personaBook);
		}
		const prompts = turnPrompts(preset, character);
		const scripts = this.scripts(character);
		const macro = this.macroContext(input, character, persona);
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
			settings: this.wiSettings(),
			// The preset's context size is the honest fallback: with neither, the budget is unlimited.
			contextSize: input.contextSize && input.contextSize > 0 ? input.contextSize : (preset?.maxContext ?? 0),
			turn: input.turn,
			effects: input.binding.effects,
			substitute,
			transform: (content) => applyRegex(scripts, substitute(content), { placement: REGEX_PLACEMENT.worldInfo, isPrompt: true }),
		});

		const note = this.authorNote(input.binding, lore, substitute, persona);
		const atDepth = [...lore.atDepth];
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
		};
		const messages = assemble(prompts, blocks, history, { wiFormat: config.tavernWiFormat ?? '{0}', substitute });
		const inert = !character && !preset && !persona && !selected.length && !bound.length && !note.content;
		return { messages, prompts, activated: lore.activated, buckets: lore, effects: lore.effects, inert, samplers: presetSamplers(preset) };
	}

	/** The macro context one turn substitutes with. */
	private macroContext(input: ComposeInput, character: Character | undefined, persona: Persona | undefined): MacroContext {
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
			model: input.model,
			input: input.scan[0]?.text,
		};
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
		for (const file of await listFiles(join(root, 'personas'))) {
			if (extname(file).toLowerCase() !== '.json') {
				continue;
			}
			try {
				into.personas.push(readPersonaFile(JSON.parse(await readFile(file, 'utf8')) as unknown, personaId(file), file));
			} catch (error) {
				this.warn(file, error);
			}
		}
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

/** The prompt list one turn uses: the preset's order, the card's overrides, and no roleplay at all
 *  when neither a character nor a preset is in play. */
export function turnPrompts(preset: TavernPreset | undefined, character: Character | undefined): ActivePrompt[] {
	const prompts = promptCollection(preset);
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
	const raw = (value && typeof value === 'object' ? value : {}) as PersonaDescription & { name?: string };
	return {
		id,
		name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
		description: typeof raw.description === 'string' ? raw.description : '',
		title: typeof raw.title === 'string' ? raw.title : '',
		position: numberOr(raw.position, PERSONA_POSITION.inPrompt),
		depth: numberOr(raw.depth, 4),
		role: numberOr(raw.role, 0),
		lorebook: typeof raw.lorebook === 'string' ? raw.lorebook : '',
		connections: Array.isArray(raw.connections) ? raw.connections.filter((name): name is string => typeof name === 'string') : [],
		source,
		raw,
	};
}

function personaId(file: string): string {
	const base = basename(file);
	return base.slice(0, base.length - extname(base).length);
}

async function listFiles(dir: string): Promise<string[]> {
	try {
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
