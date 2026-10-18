import { basename, extname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import {
	adoptBook,
	adoptCharacter,
	adoptPersona,
	adoptPreset,
	blankBook,
	blankCharacter,
	blankEntry,
	blankPersona,
	blankPreset,
	nextUid,
	slugId,
} from '../lib/authoring';
import { blankPng, cardToJson, cardToPng, loadCard } from '../lib/card';
import { convertCharacterToPersona, connectionKeys } from '../lib/personas';
import { tavernSettings, type TavernSettings } from '../lib/settings';
import { PRESET_TEMPLATES, presetTemplate } from '../lib/templates/presets';
import { parsePreset, presetId, presetToJson } from '../lib/preset';
import { COMONAD_PROMPTS, DEFAULT_PROMPTS, ST_PROMPTS, TOOLS_PROMPT, orderOf, promptCollection } from '../lib/prompts';
import { estimateTokens } from '@comonad/lib/tokens';
import { DEFAULT_SORT, SEARCH_SORT, SORT_RULES, visibleEntries } from '../lib/search';
import {
	TAG_IMPORT,
	addTags,
	applyTagImport,
	byId,
	deleteTag,
	ensureTag,
	planTagImport,
	pruneTags,
	removeTag,
	renameTag,
	sorted,
	tagPatch,
} from '../lib/tags';
import type { PromptLibraryEntry, TavernPreset, WorldBook, WorldEntry } from '../lib/types';
import { GENERATION_LABELS, GENERATION_TRIGGERS } from '@comonad/lib/generations';
import { PERSONA_POSITION } from '../lib/authoring';
import { describe } from '@comonad/lib/util';
import type { ContentKind } from '../services/tavern';
import { assignCharacter } from '../commands';

/**
 * The content editor, as the settings panel's **ST** tab uses it: the four kinds of tavern content
 * in Comonad's own library (`{characters,lorebooks,presets,personas}` under `.comonad`), written in
 * SillyTavern's file formats. The pane is a webview; every message it sends is untrusted, so the
 * payloads go through the `adopt*` sanitisers before a writer ever sees them.
 */

export interface ContentNote {
	message?: string;
	error?: boolean;
	/** The pane should render again from a fresh state: something on disk changed under it. */
	refresh?: boolean;
	/** An autosave is not worth a status line, so the pane keeps what it was showing. */
	quiet?: boolean;
	/** World books: the uids in display order, and the token count of each entry. */
	order?: number[];
	tokens?: Record<number, number>;
	total?: number;
	/** World books: the entry the pane should open. */
	entry?: number;
	/** World books: the book the pane should select, after a rename or a new file. */
	book?: string;
}

/** The four kinds, in the order the pane shows them. */
const KINDS: ContentKind[] = ['characters', 'lorebooks', 'personas', 'presets'];

/** One row of the list the pane draws: the identity every kind shares, plus what the list marks. */
export interface ContentItem {
	id: string;
	name: string;
	detail: string;
	source: string;
	/** A card's picture is its own file when it is a PNG, so the row shows it where there is one. */
	avatar?: string;
	/** Upstream's `fav`: the list can show only these. */
	favourite?: boolean;
	/** When the card was made, for the "newest first" order; an unstamped card sorts last. */
	createdAt?: string;
}

export interface ContentController {
	/** The state slice the settings panel pushes with its own. */
	state(): Record<string, unknown>;
	/** Handles one `{type:'content', action}` message. Returns a note for the pane, if any. */
	action(message: Record<string, unknown>): Promise<ContentNote | null>;
}

export interface ContentOptions {
	/**
	 * Turns a file on disk into something a webview may show. An avatar lives in the library folder,
	 * which is outside the extension, so the panel has to allow it and hand out the URI itself.
	 */
	uri?: (file: string) => string;
}

/**
 * What the library holds, in the shape every picker draws from — the editor's selects, the world-book
 * page's target list and the settings half of the tab. One builder, so the halves cannot drift.
 */
export function contentCatalog(ctx: Context): Record<string, unknown> | null {
	const tavern = ctx.get('tavern');
	if (!tavern) {
		return null;
	}
	return {
		characters: tavern.characters.map((character) => ({ id: character.id, name: character.name, source: character.source })),
		lorebooks: tavern.books.map((book) => ({
			id: book.name,
			name: book.name,
			entries: Object.keys(book.book.entries).length,
			source: book.source,
		})),
		personas: tavern.personas.map((persona) => ({ id: persona.id, name: persona.title || persona.name, source: persona.source })),
		presets: tavern.presets.map((preset) => ({ id: preset.id, name: preset.name })),
	};
}

export function contentController(ctx: Context, options: ContentOptions = {}): ContentController {
	// The real counter is the kernel's, behind the service: this package's bundle carries its own
	// copy of the pure estimator, and only the service is looking at the tokenizer that is loaded.
	const count = (text: string): number => ctx.get('tokenizers')?.count(text) ?? estimateTokens(text);
	let kind: ContentKind = 'characters';	let current: string | null = null;
	/** An item the pane created but has not saved yet: not in the catalog, and never written. */
	let draft: unknown = null;

	/** A picture as the webview may see it; an avatar the panel cannot reach comes back empty. */
	const imageUri = (file: string | undefined): string => (file && options.uri ? options.uri(file) : '');

	/**
	 * A card's picture, when it has one: upstream stores a card *as* its picture, so a PNG card's own
	 * file is the avatar, and a JSON card has none.
	 */
	const cardPicture = (source: string): string =>
		/\.(png|jpe?g|webp|gif)$/i.test(source) ? imageUri(source) : '';

	/**
	 * Whether a persona is already connected to a character. Upstream writes the card's avatar file
	 * name into a connection, so `Kestrel.png` and `Kestrel` have to mean the same thing here.
	 */
	const connectedTo = (connections: readonly { id: string }[], character: { id: string; name?: string }): boolean => {
		const keys = new Set([character.id, character.name ?? ''].map((key) => key.trim().toLowerCase()));
		return connections.some((connection) => connectionKeys(connection.id).some((key) => keys.has(key)));
	};

	const items = (wanted: ContentKind): ContentItem[] => {
		switch (wanted) {
			case 'characters':
				return ctx.tavern.characters.map((character) => ({
					id: character.id,
					name: character.name,
					detail: character.description.split('\n')[0]?.slice(0, 90) || 'no description',
					source: character.source,
					// A PNG card *is* its picture, so a card's avatar is its own file when it is an image.
					avatar: cardPicture(character.source),
					favourite: character.favourite,
					createdAt: character.createdAt,
				}));
			case 'lorebooks':
				return ctx.tavern.books.map((book) => ({
					id: book.name,
					name: book.name,
					detail: `${Object.keys(book.book.entries).length} entries`,
					source: book.source,
				}));
			case 'personas':
				return ctx.tavern.personas.map((persona) => ({
					id: persona.id,
					name: persona.title || persona.name,
					detail: persona.connections.length
						? `bound to ${persona.connections.map((connection) => ctx.tavern.character(connection.id)?.name ?? connection.id).join(', ')}`
						: persona.description.split('\n')[0]?.slice(0, 90) || 'no description',
					source: persona.source,
				}));
			case 'presets':
				return ctx.tavern.presets.map((preset) => ({
					id: preset.id,
					name: preset.name,
					detail: `${promptCollection(preset).length} prompts${preset.temperature !== undefined ? ` · temp ${preset.temperature}` : ''}`,
					source: preset.source ?? '',
				}));
		}
	};

	/** The full item the form edits, loaded fresh from the catalog unless it is an unsaved draft. */
	const item = (wanted: ContentKind, id: string | null): unknown => {
		if (draft && id === current) {
			// A new preset is a draft file that does not exist yet, but the editor still draws the whole
			// collection: the shipped prompts plus Comonad's generated rows, in their default order.
			if (wanted === 'presets') {
				const preset = draft as TavernPreset;
				return { ...preset, prompts: promptCollection(preset) };
			}
			return draft;
		}
		switch (wanted) {
			case 'characters': {
				const found = ctx.tavern.character(id ?? '');
				// The card's picture is derived, not stored: the pane shows it but never writes it back.
				return found ? { ...found, picture: cardPicture(found.source) } : null;
			}
			case 'lorebooks': {
				const found = ctx.tavern.book(id ?? '');
				return found ? { ...found.book, source: found.source, raw: found.raw } : null;
			}
			case 'personas':
				return ctx.tavern.persona(id ?? '') ?? null;
			case 'presets': {
				// The editor draws the whole collection in send order: the shipped blocks, Comonad's
				// generated ones, and this preset's own. The raw file stores only definitions and order.
				const found = ctx.tavern.preset(id ?? '');
				return found ? { ...found, prompts: promptCollection(found) } : null;
			}
		}
	};

	/** What the active chat uses, so the pane can mark it and offer to change it. */
	const adopted = (): Record<string, string[]> => {
		const session = ctx.sessions.active();
		const config = tavernSettings(ctx);
		return {
			characters: [session?.character ?? config.tavernCharacter].filter(Boolean),
			lorebooks: session?.lorebooks ?? config.tavernLorebooks,
			personas: [session?.persona ?? config.tavernPersona].filter(Boolean),
			presets: [session?.preset ?? config.tavernPreset].filter(Boolean),
		};
	};

	const firstItem = (wanted: ContentKind): string | null => items(wanted)[0]?.id ?? null;

	/**
	 * The item the pane shows: the remembered selection while it still exists, else the first of the
	 * kind. Opening a kind must show something rather than an empty page, and a selection that a
	 * delete or another window took away heals to whatever is left.
	 */
	const selected = (): string | null => {
		if (current && item(kind, current)) {
			return current;
		}
		current = firstItem(kind);
		return current;
	};

	/** What the world-book panel is showing: the search box and the sort select, which live in the
	 *  pane but decide the order the host computes for it. */
	let view = { query: '', sort: DEFAULT_SORT.value };
	/** The order `ordered` last produced, and for what — see there. */
	let orderCache: { book: WorldBook | null; query: string; sort: string; order: WorldEntry[] } | null = null;

	/**
	 * The tag registry as the pane draws it: every tag in upstream's order, how many characters carry
	 * each one, and what the selected character carries. The registry lives in `tags.json`, not in a
	 * card, so none of this travels through the form's Save button.
	 */
	const tagState = (): Record<string, unknown> => {
		const store = ctx.tavern.tags;
		const counts: Record<string, number> = {};
		for (const character of ctx.tavern.characters) {
			for (const id of new Set(ctx.tavern.tagIdsFor(character.id))) {
				counts[id] = (counts[id] ?? 0) + 1;
			}
		}
		return {
			list: sorted(store.tags),
			counts,
			assigned: kind === 'characters' && current ? ctx.tavern.tagIdsFor(current) : [],
			import: tavernSettings(ctx).tagImportSetting,
		};
	};

	/**
	 * The world-book slice. SillyTavern keeps the entry list, the active worlds and the global
	 * activation knobs in the same panel, so they travel together here: `item` is still the book the
	 * editor writes back, and this is how the list should be shown and what the panel's own settings
	 * currently are. Token counts come from here because the pane has no estimator of its own.
	 */
	const bookState = (): Record<string, unknown> => {
		const loaded = ctx.tavern.book(current ?? '');
		const config = tavernSettings(ctx);
		const entries = loaded ? Object.values(loaded.book.entries).sort((left, right) => left.uid - right.uid) : [];
		const { tokens, total } = counts(entries);
		return {
			name: loaded?.name ?? '',
			order: ordered(loaded?.book ?? null, view.query, view.sort).map((entry) => entry.uid),
			tokens,
			total,
			query: view.query,
			sort: view.query ? SEARCH_SORT.value : view.sort,
			rules: SORT_RULES.map((rule) => ({ value: rule.value, label: rule.label })),
			worlds: config.tavernLorebooks,
			characters: ctx.tavern.characters.map((character) => ({ id: character.id, name: character.name })),
			// The filter select offers the registry's tags, and stores their **ids**: that is what upstream
			// writes into `character_filter`, so an entry filtered here reads the same in SillyTavern.
			tags: sorted(ctx.tavern.tags.tags),
			// What an entry may be limited to, and what its Automation ID can run.
			generations: GENERATION_TRIGGERS.map((value) => ({ value, label: GENERATION_LABELS[value] })),
			wi: {
				scanDepth: config.wiScanDepth,
				budget: config.wiBudget,
				budgetCap: config.wiBudgetCap,
				minActivations: config.wiMinActivations,
				maxActivationsDepth: config.wiMaxActivationsDepth,
				maxRecursionSteps: config.wiMaxRecursionSteps,
				characterStrategy: config.wiCharacterStrategy,
				includeNames: config.wiIncludeNames,
				recursive: config.wiRecursive,
				caseSensitive: config.wiCaseSensitive,
				matchWholeWords: config.wiMatchWholeWords,
				useGroupScoring: config.wiGroupScoring,
				overflowAlert: config.wiOverflowAlert,
				automation: config.wiAutomation,
				vectorEnabled: config.wiVectorEnabled,
				vectorThreshold: config.wiVectorThreshold,
				vectorMaxEntries: config.wiVectorMaxEntries,
				vectorQuery: config.wiVectorQuery,
				vectorModel: config.wiVectorModel,
			},
		};
	};

	/**
	 * The persona slice. SillyTavern's avatar *is* the persona — the picture, the name and the
	 * description are one thing — so the list carries all three, plus what only the host knows: the
	 * token count of each description and which of the three locks is on.
	 */
	const personaState = (): Record<string, unknown> => {
		const session = ctx.sessions.active();
		const config = tavernSettings(ctx);
		const character = ctx.tavern.character(session?.character ?? config.tavernCharacter);
		const chat = session?.persona ?? config.tavernPersona;
		return {
			list: ctx.tavern.personas.map((persona) => ({
				id: persona.id,
				name: persona.name,
				title: persona.title,
				detail: persona.description.split('\n')[0]?.slice(0, 90) || 'no description',
				avatar: imageUri(persona.avatar),
				connections: persona.connections.map((connection) => ({
					type: connection.type,
					id: connection.id,
					name: ctx.tavern.character(connection.id)?.name ?? connection.id,
				})),
				// The three locks upstream shows: the crown, the chat, and the open character.
				locked: {
					default: persona.id === config.tavernPersona,
					chat: persona.id === chat,
					character: Boolean(character) && connectedTo(persona.connections, character ?? { id: '' }),
				},
				tokens: count(persona.description),
				position: persona.position,
				depth: persona.depth,
				role: persona.role,
			})),
			chatCharacter: character?.id ?? '',
			chatCharacterName: character?.name ?? '',
			default: config.tavernPersona,
			chat,
			positions: [
				{ value: PERSONA_POSITION.inPrompt, label: 'In prompt' },
				{ value: PERSONA_POSITION.afterChar, label: 'After character (deprecated)' },
				{ value: PERSONA_POSITION.anTop, label: "Author's note top" },
				{ value: PERSONA_POSITION.anBottom, label: "Author's note bottom" },
				{ value: PERSONA_POSITION.atDepth, label: 'In chat at depth' },
				{ value: PERSONA_POSITION.none, label: 'None (disabled)' },
			],
			characters: ctx.tavern.characters.map((entry) => ({ id: entry.id, name: entry.name })),
			// The world books a persona can be given, the way upstream's *Link to Persona Lorebook* works.
			lorebooks: ctx.tavern.books.map((book) => book.name),
			settings: {
				autoLock: config.personaAutoLock,
				allowMulti: config.personaAllowMultiConnections,
				notifications: config.personaShowNotifications,
			},
			library: ctx.tavern.libraryPath('personas'),
		};
	};

	/**
	 * The prompt slice: what each block costs, the total the list shows above it, the shipped blocks a
	 * *Reset* puts back, the generation types a block's *Triggers* may name, and the two libraries —
	 * the shared one every preset may insert from, and the one this preset keeps for itself.
	 */
	const presetState = (): Record<string, unknown> => {
		const preset = item('presets', current) as TavernPreset | null;
		const raw = ctx.tavern.preset(current ?? '');
		const session = ctx.sessions.active();
		// The agent keeps the last blocks it built, so a generated block's current text can be shown
		// without making a synchronous pane push await instruction and memory reads.
		const blocks = ctx.get('agent')?.lastPromptBlocks?.(session?.id ?? '') ?? [];
		const preview = raw ? ctx.tavern.previewPrompts(raw, blocks) : {};
		const tokens: Record<string, number> = {};
		let total = 0;
		for (const prompt of preset?.prompts ?? []) {
			const cost = count(String(preview[prompt.identifier] ?? prompt.content ?? ''));
			tokens[prompt.identifier] = cost;
			total += cost;
		}
		return {
			tokens,
			total,
			preview,
			comonad: COMONAD_PROMPTS.map((prompt) => prompt.identifier),
			toolsPrompt: TOOLS_PROMPT,
			shipped: DEFAULT_PROMPTS.map((prompt) => ({ ...prompt })),
			generations: GENERATION_TRIGGERS.map((value) => ({ value, label: GENERATION_LABELS[value] })),
		};
	};

	const state = (): Record<string, unknown> => {
		current = selected();
		return {
		kind,
		items: items(kind),
		item: item(kind, current),
		book: kind === 'lorebooks' ? bookState() : undefined,
		personas: kind === 'personas' ? personaState() : undefined,
		preset: kind === 'presets' ? presetState() : undefined,
		// The built-in library is shared by every preset, so it is sent whatever kind is showing: the
		// pane's entry box must not depend on which tab was last open. The description rides along so
		// the picker can explain an entry.
		builtInPrompts: ctx.tavern.promptLibrary.map((entry) => ({ ...entry })),
		// The preset picker lists the templates that ship.
		presetTemplates: PRESET_TEMPLATES.map((entry) => ({
			id: entry.id,
			name: entry.name,
			description: entry.description,
			inLibrary: Boolean(ctx.tavern.preset(entry.id)),
		})),
		tags: tagState(),
		adopted: adopted(),
		counts: {
			characters: ctx.tavern.characters.length,
			lorebooks: ctx.tavern.books.length,
			personas: ctx.tavern.personas.length,
			presets: ctx.tavern.presets.length,
		},
		kindLabels: { characters: 'Characters', lorebooks: 'World books', personas: 'Personas', presets: 'Presets' },
		library: ctx.tavern.libraryPath(kind),
		catalog: contentCatalog(ctx),
		};
	};

	/** A draft is only a draft until it is saved; the catalog never sees it. */
	/**
	 * A draft's slug is the file it saves to, so two drafts must never share one: a second copy of the
	 * same card, or two titles that slug to the same fallback, would write over each other's file.
	 */
	const freeSlug = (wanted: ContentKind, base: string, fallback: string): string => {
		const taken = (id: string): boolean => {
			const key = id.toLowerCase();
			return wanted === 'lorebooks'
				? ctx.tavern.books.some((item) => item.name.toLowerCase() === key)
				: wanted === 'characters'
					? ctx.tavern.characters.some((item) => item.id.toLowerCase() === key)
					: wanted === 'personas'
						? ctx.tavern.personas.some((item) => item.id.toLowerCase() === key)
						: ctx.tavern.presets.some((item) => item.id.toLowerCase() === key);
		};
		let slug = slugId(base, fallback);
		for (let index = 2; taken(slug); index += 1) {
			slug = slugId(`${base} ${index}`, fallback);
		}
		return slug;
	};

	const beginDraft = (wanted: ContentKind, copy?: unknown): void => {
		if (copy) {
			const name = `${String((copy as { name?: unknown }).name ?? 'item')} (copy)`;
			const clone: Record<string, unknown> = {
				...(structuredClone(copy) as Record<string, unknown>),
				id: freeSlug(wanted, name, 'item'),
				name: wanted === 'lorebooks' ? freeName(name) : name,
				source: '',
			};
			if (wanted === 'lorebooks') {
				clone.raw = {};
			}
			draft = clone;
			current = wanted === 'lorebooks' ? String(clone.name) : String(clone.id);
			return;
		}
		switch (wanted) {
			case 'characters':
				draft = blankCharacter('New character', freeSlug('characters', 'New character', 'character'));
				current = (draft as { id: string }).id;
				break;
			case 'lorebooks': {
				const book = blankBook(freeName('New lorebook'));
				const uid = nextUid(book);
				book.entries[String(uid)] = blankEntry(uid);
				draft = { ...book, source: '', raw: {} };
				current = book.name;
				break;
			}
			case 'personas':
				draft = blankPersona('New persona', freeSlug('personas', 'New persona', 'persona'));
				current = (draft as { id: string }).id;
				break;
			case 'presets':
				draft = blankPreset('New preset', freeSlug('presets', 'New preset', 'preset'));
				current = (draft as { id: string }).id;
				break;
		}
	};

	const save = async (wanted: ContentKind, raw: Record<string, unknown>): Promise<string> => {
		// What the pane opens next is the entry the *file* became: a slug may normalise the id or the
		// name the form typed, and the catalog is keyed by what a read of the file produces.
		const landed = (file: string): void => {
			draft = null;
			if (wanted === 'lorebooks') {
				current = ctx.tavern.books.find((item) => item.source === file)?.name ?? current;
				return;
			}
			const list = wanted === 'characters' ? ctx.tavern.characters : wanted === 'personas' ? ctx.tavern.personas : ctx.tavern.presets;
			current = list.find((item) => item.source === file)?.id ?? current;
		};
		switch (wanted) {
			case 'characters': {
				const character = adoptCharacter(raw);
				const file = await ctx.tavern.saveCharacter(character);
				landed(file);
				return file;
			}
			case 'lorebooks': {
				const book = adoptBook(raw);
				const file = await ctx.tavern.saveBook(book.name, book, book.source, book.raw);
				landed(file);
				return file;
			}
			case 'personas': {
				const persona = adoptPersona(raw);
				const file = await ctx.tavern.savePersona(persona);
				landed(file);
				return file;
			}
			case 'presets': {
				const preset = adoptPreset(raw);
				const file = await ctx.tavern.savePresetValue(preset, preset.source);
				landed(file);
				return file;
			}
		}
	};

	const remove = async (wanted: ContentKind, id: string): Promise<boolean> => {
		const gone =
			wanted === 'characters'
				? await ctx.tavern.deleteCharacter(id)
				: wanted === 'lorebooks'
					? await ctx.tavern.deleteBook(id)
					: wanted === 'personas'
						? await ctx.tavern.deletePersona(id)
						: await ctx.tavern.deletePreset(id);
		if (gone && current === id) {
			current = null;
			draft = null;
		}
		return gone;
	};

	/** Binds an item to the active chat, or makes it the default for new chats. */
	const adopt = async (wanted: ContentKind, id: string, asDefault: boolean, on: boolean): Promise<void> => {
		if (asDefault) {
			if (wanted === 'lorebooks') {
				const books = tavernSettings(ctx).tavernLorebooks;
				await ctx.settings.update('tavernLorebooks', on ? [...new Set([...books, id])] : books.filter((name) => name !== id));
				return;
			}
			const key = wanted === 'characters' ? 'tavernCharacter' : wanted === 'personas' ? 'tavernPersona' : 'tavernPreset';
			await ctx.settings.update(key, on ? id : '');
			return;
		}
		const session = ctx.sessions.active() ?? ctx.sessions.ensureActive(ctx.agent.policyFor());
		if (wanted === 'characters') {
			const character = ctx.tavern.character(id);
			if (character) {
				assignCharacter(ctx, session.id, character);
			}
			return;
		}
		if (wanted === 'lorebooks') {
			const books = new Set(session.lorebooks ?? tavernSettings(ctx).tavernLorebooks);
			if (on) {
				books.add(id);
			} else {
				books.delete(id);
			}
			session.lorebooks = [...books];
		} else if (wanted === 'personas') {
			session.persona = on ? id : undefined;
		} else {
			session.preset = on ? id : undefined;
		}
		ctx.sessions.save(session);
		ctx.sessions.changed(session.id);
	};

	const reveal = async (wanted: ContentKind | null): Promise<void> => {
		const dir = wanted ? ctx.tavern.libraryPath(wanted) : ctx.tavern.libraryRoot();
		mkdirSync(dir, { recursive: true });
		await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
	};

	/** Writes a card as a PNG, the way cards are shared. Needs a picture to hang it on. */
	const exportPng = async (id: string): Promise<string> => {
		const character = ctx.tavern.character(id);
		if (!character) {
			throw new Error('pick the character to export first');
		}
		const target = await vscode.window.showSaveDialog({
			title: `Export ${character.name} as a PNG card`,
			defaultUri: vscode.Uri.file(join(ctx.settings.workspace() || ctx.settings.home(), `${slugId(character.name, 'card')}.png`)),
			filters: { 'Character card': ['png'] },
		});
		if (!target) {
			return '';
		}
		// A card that came from a PNG keeps its picture; a new one gets a blank canvas.
		const source = character.source.toLowerCase().endsWith('.png') ? character.source : '';
		const image = source ? Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(source))) : blankPng();
		await vscode.workspace.fs.writeFile(target, cardToPng(image, character));
		return target.fsPath;
	};

	/* ------------------------------------------------------------------ world books */

	/**
	 * The world-book panel is SillyTavern's, and so is its write model: the pane holds the book while
	 * it is open and every structural change is made there, then written as a whole. The host only
	 * does what one book cannot — touching another file, or the file system.
	 */
	const BOOK_ACTIONS = new Set([
		'order',
		'write',
		'move',
		'create',
		'rename',
		'duplicateBook',
		'exportBook',
		'importBook',
		'reload',
		'setting',
		'addEntry',
		'duplicateEntry',
		'deleteEntry',
		'deleteBook',
	]);

	/**
	 * The settings SillyTavern keeps *inside* its world-info panel — the active worlds and the global
	 * activation knobs. They are written straight through instead of going through the settings form,
	 * because upstream has no Save button here either; the allow list is what keeps an untrusted
	 * webview from writing a key this panel has no business touching.
	 */
	const WI_KEYS = new Set<keyof TavernSettings>([
		'tavernLorebooks',
		'wiScanDepth',
		'wiBudget',
		'wiBudgetCap',
		'wiMinActivations',
		'wiMaxActivationsDepth',
		'wiMaxRecursionSteps',
		'wiCharacterStrategy',
		'wiIncludeNames',
		'wiRecursive',
		'wiCaseSensitive',
		'wiMatchWholeWords',
		'wiGroupScoring',
		'wiOverflowAlert',
		'wiAutomation',
		'wiVectorEnabled',
		'wiVectorProfile',
		'wiVectorModel',
		'wiVectorThreshold',
		'wiVectorMaxEntries',
		'wiVectorQuery',
	]);

	/** A book as the pane sends it: everything the editor touched, nothing derived. */
	const incoming = (raw: unknown): WorldBook & { source?: string; raw?: Record<string, unknown> } => {
		const book = adoptBook(raw);
		return { ...book, source: book.source, raw: book.raw };
	};

	const entriesOf = (book: WorldBook): WorldEntry[] =>
		Object.values(book.entries).sort((left, right) => left.uid - right.uid);

	/** The token count of every entry, which the editor shows next to its content. */
	const counts = (entries: readonly WorldEntry[]): { tokens: Record<number, number>; total: number } => {
		const tokens: Record<number, number> = {};
		let total = 0;
		for (const entry of entries) {
			const cost = count(String(entry.content ?? ''));
			tokens[entry.uid] = cost;
			total += cost;
		}
		return { tokens, total };
	};

	/** The display order of the entry list. Cached: the search scores every entry, and a push that
	 *  moves nothing else must not pay for the search again. A save replaces the book object, which
	 *  is exactly when the order has to be worked out anew. */
	const ordered = (book: WorldBook | null, query: string, sort: string): WorldEntry[] => {
		if (orderCache && orderCache.book === book && orderCache.query === query && orderCache.sort === sort) {
			return orderCache.order;
		}
		const order = book ? visibleEntries(entriesOf(book), query, sort) : [];
		orderCache = { book, query, sort, order };
		return order;
	};

	const writeBook = async (raw: unknown): Promise<ContentNote> => {
		const book = incoming(raw);
		await ctx.tavern.saveBook(book.name, book, book.source, book.raw);
		return { quiet: true, message: 'Saved', ...counts(entriesOf(book)) };
	};

	/** A file name that is free, so creating or duplicating never overwrites a book by accident.
	 *  Compared case-insensitively: the file it becomes may collide that way on macOS or Windows. */
	const freeName = (wanted: string): string => {
		const taken = new Set(ctx.tavern.books.map((book) => book.name.toLowerCase()));
		if (!taken.has(wanted.toLowerCase())) {
			return wanted;
		}
		for (let index = 2; ; index += 1) {
			const candidate = `${wanted} ${index}`;
			if (!taken.has(candidate.toLowerCase())) {
				return candidate;
			}
		}
	};

	const bookAction = async (message: Record<string, unknown>): Promise<ContentNote | null> => {
		const id = String(message.id ?? current ?? '');
		switch (message.action) {
			case 'order': {
				// The search box and the sort select are the pane's, but the rules are SillyTavern's and
				// live in `lib/tavern/search.ts`, so the host does the ordering and the pane only renders.
				view = { query: String(message.query ?? ''), sort: String(message.sort ?? DEFAULT_SORT.value) };
				const loaded = ctx.tavern.book(id);
				if (!loaded) {
					return null;
				}
				const shown = ordered(loaded.book, view.query, view.sort);
				return { order: shown.map((entry) => entry.uid), ...counts(entriesOf(loaded.book)) };
			}
			case 'write':
				return await writeBook(message.book);
			case 'move': {
				// Moving or copying one entry into another book is the one structural change that needs a
				// file the pane does not have: read it, add the entry, write both.
				const source = ctx.tavern.book(id);
				const target = ctx.tavern.book(String(message.target ?? ''));
				const uid = Number(message.uid);
				if (!source || !target) {
					return { message: 'Pick a target book first.', error: true };
				}
				const entry = source.book.entries[String(uid)];
				if (!entry) {
					return { message: `Entry ${uid} is gone.`, error: true };
				}
				const wanted = { ...entry, uid: nextUid(target.book) };
				target.book.entries[String(wanted.uid)] = wanted;
				await ctx.tavern.saveBook(target.name, target.book, target.source, target.raw);
				if (message.move === true) {
					delete source.book.entries[String(uid)];
					await ctx.tavern.saveBook(source.name, source.book, source.source, source.raw);
				}
				return { refresh: true, message: `${message.move === true ? 'Moved' : 'Copied'} the entry to ${target.name}.` };
			}
			case 'addEntry': {
				const loaded = ctx.tavern.book(id);
				if (!loaded) {
					return null;
				}
				// A fresh entry gets its defaults here rather than in the pane, so `blankEntry` stays the
				// one place that knows what a new entry looks like.
				const uid = nextUid(loaded.book);
				loaded.book.entries[String(uid)] = blankEntry(uid);
				await ctx.tavern.saveBook(loaded.name, loaded.book, loaded.source, loaded.raw);
				return { refresh: true, entry: uid, message: 'Entry added.' };
			}
			case 'duplicateEntry': {
				const loaded = ctx.tavern.book(id);
				const source = loaded?.book.entries[String(Number(message.uid))];
				if (!loaded || !source) {
					return { message: 'That entry is no longer in the book.', error: true };
				}
				const uid = nextUid(loaded.book);
				loaded.book.entries[String(uid)] = {
					...structuredClone(source),
					uid,
					displayIndex: uid,
					comment: source.comment?.trim() || `entry ${source.uid}`,
				};
				await ctx.tavern.saveBook(loaded.name, loaded.book, loaded.source, loaded.raw);
				return { refresh: true, entry: uid, message: 'Entry duplicated.' };
			}
			case 'deleteEntry': {
				const loaded = ctx.tavern.book(id);
				if (!loaded || !loaded.book.entries[String(Number(message.uid))]) {
					return { message: 'That entry is no longer in the book.', error: true };
				}
				delete loaded.book.entries[String(Number(message.uid))];
				await ctx.tavern.saveBook(loaded.name, loaded.book, loaded.source, loaded.raw);
				return { refresh: true, message: 'Entry deleted.' };
			}
			case 'deleteBook': {
				const loaded = ctx.tavern.book(id);
				if (!loaded) {
					return null;
				}
				// A modal question from the host, because a webview's own confirm() is not dependable.
				const answer = await vscode.window.showWarningMessage(
					`Delete the world book “${loaded.name}”?`,
					{ modal: true, detail: 'The file is removed from Comonad’s library. This cannot be undone.' },
					'Delete',
				);
				if (answer !== 'Delete') {
					return null;
				}
				const gone = await ctx.tavern.deleteBook(loaded.name);
				if (gone) {
					current = null;
					draft = null;
				}
				return gone ? { refresh: true, message: `Deleted ${loaded.name}.` } : { message: 'That book is not in Comonad’s library, so nothing was deleted.', error: true };
			}
			case 'create': {
				// A webview cannot ask for text of its own (`window.prompt` is dead there), so the name
				// is asked for here — the same way renaming is — with the free version of the default.
				const answer =
					typeof message.name === 'string' && message.name.trim()
						? String(message.name)
						: await vscode.window.showInputBox({
								title: 'New world book',
								value: freeName('New Lorebook'),
								prompt: 'The file is named after the book.',
								validateInput: (value) => (value.trim() ? undefined : 'A book needs a name.'),
							});
				const wanted = (answer ?? '').trim();
				if (!wanted) {
					return null;
				}
				const name = freeName(wanted);
				const book = blankBook(name);
				const uid = nextUid(book);
				book.entries[String(uid)] = blankEntry(uid);
				await ctx.tavern.saveBook(name, book);
				return { refresh: true, book: name, entry: uid, message: `Created ${name}.` };
			}
			case 'rename': {
				const loaded = ctx.tavern.book(id);
				if (!loaded) {
					return { message: 'That book is no longer in the library.', error: true };
				}
				// The pane has no dependable prompt of its own, so the name is asked for host-side.
				const answer =
					message.name === undefined
						? await vscode.window.showInputBox({
								title: 'Rename world book',
								value: loaded.name,
								prompt: 'The file is renamed with the book.',
								validateInput: (value) => (value.trim() ? undefined : 'A book needs a name.'),
							})
						: String(message.name);
				const name = (answer ?? '').trim();
				if (!name || name === loaded.name) {
					return null;
				}
				// A rename onto a name that is taken would write over that book's file and delete this
				// one: the name is asked for again rather than a book lost.
				if (ctx.tavern.book(name)) {
					return { message: `Another world book is already named ${name}.`, error: true };
				}
				await ctx.tavern.saveBook(name, { ...loaded.book, name }, loaded.source, loaded.raw);
				return { refresh: true, book: name, message: `Renamed to ${name}.` };
			}
			case 'duplicateBook': {
				const loaded = ctx.tavern.book(id);
				if (!loaded) {
					return { message: 'That book is no longer in the library.', error: true };
				}
				const name = freeName(`${loaded.name} (copy)`);
				// Every uid is kept: the copy is a copy, and the entries refer to nothing outside the file.
				await ctx.tavern.saveBook(name, { ...loaded.book, name });
				return { refresh: true, book: name, message: `Duplicated as ${name}.` };
			}
			case 'exportBook': {
				const loaded = ctx.tavern.book(id);
				if (!loaded) {
					return { message: 'That book is no longer in the library.', error: true };
				}
				const target = await vscode.window.showSaveDialog({
					title: `Export ${loaded.name}`,
					defaultUri: vscode.Uri.file(join(ctx.settings.workspace() || ctx.settings.home(), `${slugId(loaded.name, 'lorebook')}.json`)),
					filters: { 'World Info': ['json'] },
				});
				if (!target) {
					return null;
				}
				const source = ctx.tavern.fileFor(loaded.source);
				// A book that came from the library is copied byte for byte, so nothing we do not model is lost.
				const bytes = source
					? await readFile(source)
					: Buffer.from(JSON.stringify({ ...loaded.raw, name: loaded.name, entries: loaded.book.entries }, null, 4), 'utf8');
				await writeFile(target.fsPath, bytes);
				return { message: `Exported ${basename(target.fsPath)} to ${target.fsPath}` };
			}
			case 'importBook': {
				const picked = await vscode.window.showOpenDialog({
					title: 'Import a world info file',
					canSelectMany: true,
					filters: { 'World Info': ['json', 'lorebook'] },
					openLabel: 'Import',
				});
				if (!picked?.length) {
					return null;
				}
				const dir = ctx.tavern.libraryPath('lorebooks');
				await mkdirSync(dir, { recursive: true });
				let last = '';
				let count = 0;
				for (const source of picked) {
					try {
						const parsed = JSON.parse(await readFile(source.fsPath, 'utf8')) as { name?: unknown; entries?: unknown };
						const fallback = basename(source.fsPath, extname(source.fsPath));
						const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : fallback;
						const file = join(dir, `${slugId(name, 'lorebook')}.json`);
						await writeFile(file, JSON.stringify({ ...parsed, name }, null, 4), 'utf8');
						last = name;
						count += 1;
					} catch (error) {
						ctx.log.message(`tavern: import skipped ${basename(source.fsPath)}: ${describe(error)}`);
					}
				}
				if (!count) {
					return { message: 'Nothing could be imported: those files are not world info.', error: true };
				}
				return { refresh: true, book: last, message: `Imported ${count} book${count === 1 ? '' : 's'}.` };
			}
			case 'reload':
				await ctx.tavern.reload();
				return { refresh: true, message: 'Re-read the library.' };
			case 'setting': {
				const key = String(message.key ?? '') as keyof TavernSettings;
				if (!WI_KEYS.has(key)) {
					return { message: `${String(message.key)} is not a world-info setting.`, error: true };
				}
				await ctx.settings.update(key, message.value);
				return { quiet: true };
			}
			default:
				return null;
		}
	};

	/**
	 * The tag registry's verbs, routed beside `BOOK_ACTIONS`: they belong to no one kind of content,
	 * they are all named `tag…`, and the pane sends them with the character they are about.
	 */
	const TAG_ACTIONS = new Set(['tagAssign', 'tagUnassign', 'tagCreate', 'tagRename', 'tagUpdate', 'tagDelete', 'tagPrune', 'tagImport']);

	/**
	 * The tag registry's own verbs. A tag belongs to `tags.json` and to no card, so these write the
	 * registry and answer at once — upstream saves its settings the moment a tag is changed, and
	 * there is no Save button in its Manage Tags dialog either.
	 */
	const tagAction = async (message: Record<string, unknown>): Promise<ContentNote | null> => {
		const store = ctx.tavern.tags;
		const id = String(message.id ?? current ?? '');
		const tagId = String(message.tag ?? '');
		switch (message.action) {
			case 'tagAssign': {
				// The pane may send a name that is not a tag yet: typing a new one creates it, which is
				// exactly what upstream's tag input does.
				const tag = byId(store, tagId) ?? ensureTag(store, String(message.name ?? ''));
				if (!tag || !ctx.tavern.character(id)) {
					return { message: 'Pick a character and a tag first.', error: true };
				}
				if (!addTags(store, id, [tag])) {
					return { quiet: true };
				}
				await ctx.tavern.saveTags();
				return { message: `${ctx.tavern.character(id)?.name} is tagged ${tag.name}.` };
			}
			case 'tagUnassign': {
				if (!removeTag(store, id, tagId)) {
					return { quiet: true };
				}
				await ctx.tavern.saveTags();
				return { message: 'Tag removed.' };
			}
			case 'tagCreate': {
				const name = String(message.name ?? '').trim();
				if (!name) {
					return { message: 'A tag needs a name.', error: true };
				}
				const existing = ensureTag(store, name);
				if (!existing) {
					return null;
				}
				await ctx.tavern.saveTags();
				return { message: `Tag ${existing.name} is ready.` };
			}
			case 'tagRename': {
				const name = String(message.name ?? '').trim();
				if (!name) {
					return { message: 'A tag needs a name.', error: true };
				}
				if (!renameTag(store, tagId, name)) {
					return null;
				}
				await ctx.tavern.saveTags();
				return { message: `Renamed to ${name}.` };
			}
			case 'tagUpdate': {
				const tag = byId(store, tagId);
				if (!tag) {
					return null;
				}
				Object.assign(tag, tagPatch(message.patch));
				await ctx.tavern.saveTags();
				return { quiet: true };
			}
			case 'tagDelete': {
				const tag = byId(store, tagId);
				if (!tag) {
					return null;
				}
				// Upstream asks first and offers to merge the tag into another one; so do we.
				const into = String(message.into ?? '');
				const other = byId(store, into);
				const answer = await vscode.window.showWarningMessage(
					`Delete the tag ${tag.name}?`,
					{
						modal: true,
						detail: other
							? `Everything tagged ${tag.name} is tagged ${other.name} instead.`
							: 'It is taken off every character that carries it.',
					},
					'Delete',
				);
				if (answer !== 'Delete') {
					return null;
				}
				deleteTag(store, tagId, other?.id);
				await ctx.tavern.saveTags();
				return { message: other ? `${tag.name} was merged into ${other.name}.` : `Deleted ${tag.name}.` };
			}
			case 'tagPrune': {
				const gone = pruneTags(store);
				if (!gone) {
					return { message: 'Every tag is carried by something.' };
				}
				await ctx.tavern.saveTags();
				return { message: `Removed ${gone} unused tag${gone === 1 ? '' : 's'}.` };
			}
			case 'tagImport': {
				const character = ctx.tavern.character(id);
				if (!character) {
					return { message: 'Pick a character first.', error: true };
				}
				const setting = tavernSettings(ctx).tagImportSetting;
				let chosen: number = setting;
				if (setting === TAG_IMPORT.ASK) {
					const offer = planTagImport(store, character.id, character.tags, TAG_IMPORT.ALL);
					if (!offer.names.length) {
						return { message: `${character.name} carries no tag that is not already here.` };
					}
					const answer = await vscode.window.showWarningMessage(
						`Import ${offer.names.length} tag${offer.names.length === 1 ? '' : 's'} from ${character.name}?`,
						{
							modal: true,
							detail: offer.fresh.length
								? `New tags: ${offer.fresh.join(', ')}. The *Tag Import Option* setting decides this next time.`
								: 'Every one of them already exists as a tag.',
						},
						'Import all',
						'Only existing',
						'None',
					);
					chosen = answer === 'Import all' ? TAG_IMPORT.ALL : answer === 'Only existing' ? TAG_IMPORT.ONLY_EXISTING : TAG_IMPORT.NONE;
				}
				const names = applyTagImport(store, character.id, planTagImport(store, character.id, character.tags, chosen));
				if (!names.length) {
					return { message: 'Nothing to import: the card tags are either already here or already assigned.' };
				}
				await ctx.tavern.saveTags();
				return { message: `Imported ${names.join(', ')}.` };
			}
			default:
				return null;
		}
	};

	/**
	 * The persona-only verbs. Upstream's persona panel does more than edit a description: it sets the
	 * picture, connects a persona to characters, locks it to a chat, and backs the whole set up or
	 * restores it. A picture and a backup are files of their own — that is the host's business — and a
	 * connection is a binding, so none of it travels through the form's Save button.
	 */
	const PERSONA_ACTIONS = new Set([
		'personaConnect',
		'personaDisconnect',
		'personaAvatar',
		'personaFromImage',
		'personaClearAvatar',
		'personaBackup',
		'personaRestore',
		'personaFromCharacter',
		'personaDuplicate',
		'personaDelete',
		'personaSetting',
	]);

	/** The persona-wide settings the pane may write straight through, as upstream's own panel does. */
	const PERSONA_KEYS = new Set<keyof TavernSettings>(['personaAutoLock', 'personaAllowMultiConnections', 'personaShowNotifications']);

	const personaAction = async (message: Record<string, unknown>): Promise<ContentNote | null> => {
		const id = String(message.id ?? current ?? '');
		switch (message.action) {
			case 'personaConnect': {
				const persona = ctx.tavern.persona(id) ?? ctx.tavern.findPersona(id);
				const character = ctx.tavern.character(String(message.character ?? ''));
				if (!persona || !character) {
					return { message: 'Pick a persona and a character first.', error: true };
				}
				if (connectedTo(persona.connections, character)) {
					return { quiet: true };
				}
				// With *Allow multiple persona connections per character* off, upstream keeps one persona per
				// character: connecting this one takes the character away from whichever persona had it.
				const keepOne = !tavernSettings(ctx).personaAllowMultiConnections;
				if (keepOne) {
					for (const other of ctx.tavern.personas) {
						if (other.id === persona.id || !connectedTo(other.connections, character)) {
							continue;
						}
						await ctx.tavern.savePersona({
							...other,
							connections: other.connections.filter((connection) => !connectedTo([connection], character)),
						});
					}
				}
				await ctx.tavern.savePersona({
					...persona,
					connections: [...persona.connections, { type: 'character' as const, id: character.id }],
				});
				return { refresh: true, message: `${persona.name} is connected to ${character.name}.` };
			}
			case 'personaDisconnect': {
				const persona = ctx.tavern.persona(id) ?? ctx.tavern.findPersona(id);
				if (!persona) {
					return { message: 'That persona is no longer in the library.', error: true };
				}
				const index = typeof message.index === 'number' ? message.index : -1;
				const character = ctx.tavern.character(String(message.character ?? ''));
				const connections =
					index >= 0
						? persona.connections.filter((_, at) => at !== index)
						: persona.connections.filter((connection) => !character || !connectedTo([connection], character));
				if (connections.length === persona.connections.length) {
					return { quiet: true };
				}
				await ctx.tavern.savePersona({ ...persona, connections });
				return { refresh: true, message: 'Connection removed.' };
			}
			case 'personaAvatar': {
				// Upstream's avatar *is* the persona, so a persona the pane has not saved yet is saved
				// here first: picking a picture is allowed to be the thing that creates it.
				let persona = ctx.tavern.persona(id) ?? ctx.tavern.findPersona(id);
				if (!persona && message.item) {
					await save('personas', message.item as Record<string, unknown>);
					persona = ctx.tavern.persona(current ?? id) ?? ctx.tavern.findPersona(id);
				}
				if (!persona) {
					return { message: 'That persona is no longer in the library.', error: true };
				}
				const picked = await vscode.window.showOpenDialog({
					title: `Choose a picture for ${persona.name}`,
					canSelectMany: false,
					filters: { Image: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
					openLabel: 'Use as avatar',
				});
				const source = picked?.[0]?.fsPath;
				if (!source) {
					return null;
				}
				const file = await ctx.tavern.setPersonaAvatar(persona.id, source);
				return { refresh: true, message: `Avatar set from ${basename(file)}.` };
			}
			case 'personaFromImage': {
				// Upstream's upload tile: the picture is the persona, so the file's name becomes the name.
				const picked = await vscode.window.showOpenDialog({
					title: 'Create a persona from a picture',
					canSelectMany: false,
					filters: { Image: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
					openLabel: 'Create persona',
				});
				const source = picked?.[0]?.fsPath;
				if (!source) {
					return null;
				}
				const stem = basename(source, extname(source));
				let id = slugId(stem, 'persona');
				for (let index = 2; ctx.tavern.persona(id); index += 1) {
					id = slugId(`${stem} ${index}`, 'persona');
				}
				await ctx.tavern.savePersona(blankPersona(stem, id));
				await ctx.tavern.setPersonaAvatar(id, source);
				current = id;
				draft = null;
				return { refresh: true, message: `Created the persona ${stem}.` };
			}
			case 'personaDuplicate': {
				const persona = ctx.tavern.persona(id) ?? ctx.tavern.findPersona(id);
				if (!persona) {
					return { message: 'That persona is no longer in the library.', error: true };
				}
				const base = `${persona.name} (copy)`;
				let newId = slugId(base, 'persona');
				for (let index = 2; ctx.tavern.persona(newId); index += 1) {
					newId = slugId(`${base} ${index}`, 'persona');
				}
				// The copy gets its own file; the picture is copied too, the way upstream's clone does.
				await ctx.tavern.savePersona({ ...persona, id: newId, source: '' });
				if (persona.avatar) {
					await ctx.tavern.setPersonaAvatar(newId, persona.avatar);
				}
				current = newId;
				draft = null;
				return { refresh: true, message: `Duplicated as ${newId}.` };
			}
			case 'personaDelete': {
				const persona = ctx.tavern.persona(id) ?? ctx.tavern.findPersona(id);
				if (!persona) {
					return { message: 'That persona is no longer in the library.', error: true };
				}
				// A modal question from the host, because a webview's own confirm() is not dependable.
				const answer = await vscode.window.showWarningMessage(
					`Delete the persona ${persona.name}?`,
					{ modal: true, detail: 'The file and its picture are removed from Comonad’s library. This cannot be undone.' },
					'Delete',
				);
				if (answer !== 'Delete') {
					return null;
				}
				const gone = await ctx.tavern.deletePersona(persona.id);
				if (gone) {
					current = null;
					draft = null;
				}
				return gone
					? { refresh: true, message: `Deleted ${persona.name}.` }
					: { message: 'That persona is not in Comonad’s library, so nothing was deleted.', error: true };
			}
			case 'personaSetting': {
				const key = String(message.key ?? '') as keyof TavernSettings;
				if (!PERSONA_KEYS.has(key)) {
					return { message: `${String(message.key)} is not a persona setting.`, error: true };
				}
				await ctx.settings.update(key, message.value);
				return { quiet: true };
			}
			case 'personaClearAvatar': {
				const gone = await ctx.tavern.clearPersonaAvatar(id);
				return gone ? { refresh: true, message: 'Avatar removed.' } : { message: 'That persona has no picture.' };
			}
			case 'personaBackup': {
				const dated = new Date().toISOString().slice(0, 10).replace(/-/g, '');
				const target = await vscode.window.showSaveDialog({
					title: 'Back up every persona',
					defaultUri: vscode.Uri.file(join(ctx.settings.workspace() || ctx.settings.home(), `personas_${dated}.json`)),
					filters: { 'Persona backup': ['json'] },
				});
				if (!target) {
					return null;
				}
				await writeFile(target.fsPath, JSON.stringify(ctx.tavern.exportPersonas(), null, 2), 'utf8');
				return { message: `Backed up ${ctx.tavern.personas.length} persona(s) to ${basename(target.fsPath)}` };
			}
			case 'personaRestore': {
				const picked = await vscode.window.showOpenDialog({
					title: 'Restore personas from a backup',
					canSelectMany: false,
					filters: { 'Persona backup': ['json'] },
					openLabel: 'Restore',
				});
				const file = picked?.[0]?.fsPath;
				if (!file) {
					return null;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(await readFile(file, 'utf8'));
				} catch (error) {
					return { message: `${basename(file)} is not JSON: ${describe(error)}`, error: true };
				}
				const restore = await ctx.tavern.importPersonas(parsed);
				for (const warning of restore.skipped) {
					ctx.log.message(`tavern: persona restore: ${warning}`);
				}
				if (!restore.personas.length) {
					return {
						message: restore.skipped.length ? `Nothing was restored: ${restore.skipped[0]}` : 'That backup holds no personas.',
						error: true,
					};
				}
				const names = restore.personas.map((persona) => persona.name).join(', ');
				const skipped = restore.skipped.length ? ` ${restore.skipped.length} skipped, see the log.` : '';
				return {
					refresh: true,
					message: `Restored ${restore.personas.length} persona(s): ${names}.${skipped}`,
				};
			}
			case 'personaFromCharacter': {
				const wanted = String(message.character ?? ctx.sessions.active()?.character ?? tavernSettings(ctx).tavernCharacter ?? '');
				const character = ctx.tavern.character(wanted);
				if (!character) {
					return { message: 'Pick the character to convert first.', error: true };
				}
				const newId = slugId(`${character.name} (Persona)`, 'persona');
				if (ctx.tavern.persona(newId)) {
					// Upstream asks before overwriting a persona that came from the same card.
					const answer = await vscode.window.showWarningMessage(
						`Overwrite the persona ${ctx.tavern.persona(newId)?.name}?`,
						{ modal: true, detail: `A persona for ${character.name} already exists. Converting replaces its description.` },
						'Overwrite',
					);
					if (answer !== 'Overwrite') {
						return null;
					}
				}
				// The conversion reverses who is who, which is why upstream asks about the macros.
				let swap = false;
				if (/\{\{\s*(char|user)\s*\}\}/i.test(character.description)) {
					const answer = await vscode.window.showWarningMessage(
						`Swap the macros in ${character.name}'s description?`,
						{
							modal: true,
							detail: 'A persona speaks as the user, so {{char}} and {{user}} trade places. Upstream asks the same question.',
						},
						'Swap',
						'Keep as is',
					);
					if (!answer) {
						return null;
					}
					swap = answer === 'Swap';
				}
				const persona = convertCharacterToPersona(character, newId, '', swap);
				await ctx.tavern.savePersona(persona);
				current = persona.id;
				draft = null;
				return { refresh: true, message: `Created the persona ${persona.name}.` };
			}
			default:
				return null;
		}
	};

	/**
	 * The character-only verbs: the entries of upstream's *More…* menu that need a file or a question
	 * of their own. A world binding and the card's own fields travel through the form instead.
	 */
	const CHARACTER_ACTIONS = new Set([
		'characterFavourite',
		'characterAvatar',
		'characterImportLore',
		'characterRename',
		'characterSource',
		'characterImport',
		'characterExportJson',
	]);

	const characterAction = async (message: Record<string, unknown>): Promise<ContentNote | null> => {
		const id = String(message.id ?? current ?? '');
		const character = ctx.tavern.character(id);
		switch (message.action) {
			case 'characterFavourite': {
				if (!character) {
					return { message: 'That character is no longer in the library.', error: true };
				}
				const on = Boolean(message.on);
				await ctx.tavern.saveCharacter({ ...character, favourite: on });
				return { quiet: true, message: on ? `${character.name} is a favourite.` : '' };
			}
			case 'characterAvatar': {
				// Upstream keeps a card and its picture in one file, so a JSON card becomes a PNG card.
				let target = character;
				if (!target && message.item) {
					await save('characters', message.item as Record<string, unknown>);
					target = ctx.tavern.character(current ?? id);
				}
				if (!target) {
					return { message: 'That character is no longer in the library.', error: true };
				}
				const picked = await vscode.window.showOpenDialog({
					title: `Choose the picture for ${target.name}`,
					canSelectMany: false,
					filters: { 'PNG image': ['png'] },
					openLabel: 'Use as the card',
				});
				const source = picked?.[0]?.fsPath;
				if (!source) {
					return null;
				}
				const file = await ctx.tavern.setCharacterAvatar(target.id, source);
				return { refresh: true, message: `${target.name} is now ${basename(file)}.` };
			}
			case 'characterImportLore': {
				if (!character) {
					return { message: 'That character is no longer in the library.', error: true };
				}
				if (!character.book) {
					return { message: `${character.name} carries no book of its own.`, error: true };
				}
				const imported = await ctx.tavern.importCardLore(character.id);
				return {
					refresh: true,
					message: `Imported ${imported.entries} entr${imported.entries === 1 ? 'y' : 'ies'} into ${imported.name}, and linked it to ${character.name}.`,
				};
			}
			case 'characterRename': {
				if (!character) {
					return { message: 'That character is no longer in the library.', error: true };
				}
				// A webview's own prompt is not dependable, so the name is asked for host-side.
				const answer = await vscode.window.showInputBox({
					title: 'Rename character',
					value: character.name,
					prompt: 'The card file is renamed with the character, as SillyTavern renames it.',
					validateInput: (value) => (value.trim() ? undefined : 'A character needs a name.'),
				});
				const name = (answer ?? '').trim();
				if (!name || name === character.name) {
					return null;
				}
				const newId = await ctx.tavern.renameCharacter(character.id, name);
				current = newId;
				draft = null;
				return { refresh: true, message: `Renamed to ${name}.` };
			}
			case 'characterSource': {
				if (!character?.sourceLink) {
					return { message: `${character?.name ?? 'That character'} does not seem to have a source.` };
				}
				// Upstream only ever opens the link; the field itself comes from the card.
				await vscode.env.openExternal(vscode.Uri.parse(character.sourceLink));
				return null;
			}
			case 'characterImport': {
				const picked = await vscode.window.showOpenDialog({
					title: 'Import character cards',
					canSelectMany: true,
					filters: { 'Character card': ['png', 'json'], Image: ['png'] },
					openLabel: 'Import',
				});
				if (!picked?.length) {
					return null;
				}
				const dir = ctx.tavern.libraryPath('characters');
				mkdirSync(dir, { recursive: true });
				let count = 0;
				let last = '';
				for (const source of picked) {
					try {
						// Read it first: a file that is not a card is refused rather than copied in.
						const card = await loadCard(source.fsPath);
						const file = join(dir, `${slugId(card.name, 'character')}${extname(source.fsPath).toLowerCase()}`);
						await vscode.workspace.fs.copy(vscode.Uri.file(source.fsPath), vscode.Uri.file(file), { overwrite: true });
						last = card.id;
						count += 1;
					} catch (error) {
						ctx.log.message(`tavern: import skipped ${basename(source.fsPath)}: ${describe(error)}`);
					}
				}
				if (!count) {
					return { message: 'Nothing could be imported: those files are not character cards.', error: true };
				}
				await ctx.tavern.reload();
				current = last;
				draft = null;
				return { refresh: true, message: `Imported ${count} card${count === 1 ? '' : 's'}.` };
			}
			case 'characterExportJson': {
				if (!character) {
					return { message: 'That character is no longer in the library.', error: true };
				}
				const target = await vscode.window.showSaveDialog({
					title: `Export ${character.name} as JSON`,
					defaultUri: vscode.Uri.file(join(ctx.settings.workspace() || ctx.settings.home(), `${slugId(character.name, 'card')}.json`)),
					filters: { 'Character card': ['json'] },
				});
				if (!target) {
					return null;
				}
				await writeFile(target.fsPath, cardToJson(character), 'utf8');
				return { message: `Exported ${basename(target.fsPath)} to ${target.fsPath}` };
			}
			default:
				return null;
		}
	};

	/**
	 * The preset manager's own verbs: a preset is a file, so importing, exporting and starting from a
	 * template are all file work. Upstream's *Update current preset* is this pane's Save button — the
	 * form writes the prompt list and the order straight back into the preset — and *Restore* is one
	 * of the two restores below.
	 */
	const PRESET_ACTIONS = new Set(['presetImport', 'presetExport', 'presetTemplate', 'presetRestoreTemplate', 'presetRestorePrompts']);

	const presetAction = async (message: Record<string, unknown>): Promise<ContentNote | null> => {
		const id = String(message.id ?? current ?? '');
		const preset = ctx.tavern.preset(id);
		switch (message.action) {
			case 'presetImport': {
				const picked = await vscode.window.showOpenDialog({
					title: 'Import an OpenAI preset',
					canSelectMany: true,
					filters: { 'OpenAI preset': ['json', 'settings'] },
					openLabel: 'Import',
				});
				if (!picked?.length) {
					return null;
				}
				const dir = ctx.tavern.libraryPath('presets');
				mkdirSync(dir, { recursive: true });
				let count = 0;
				let last = '';
				for (const source of picked) {
					try {
						// Read it first: a file that is not a preset is refused rather than copied in.
						const parsed = parsePreset(await readFile(source.fsPath, 'utf8'), basename(source.fsPath, extname(source.fsPath)), presetId(source.fsPath));
						const file = join(dir, `${slugId(parsed.id, 'preset')}.json`);
						await writeFile(file, presetToJson({ ...parsed, id: slugId(parsed.id, 'preset') }), 'utf8');
						last = parsed.id;
						count += 1;
					} catch (error) {
						ctx.log.message(`tavern: import skipped ${basename(source.fsPath)}: ${describe(error)}`);
					}
				}
				if (!count) {
					return { message: 'Nothing could be imported: those files are not OpenAI presets.', error: true };
				}
				await ctx.tavern.reload();
				current = last;
				draft = null;
				return { refresh: true, message: `Imported ${count} preset${count === 1 ? '' : 's'}.` };
			}
			case 'presetExport': {
				if (!preset) {
					return { message: 'Pick a preset first.', error: true };
				}
				const target = await vscode.window.showSaveDialog({
					title: `Export ${preset.name}`,
					defaultUri: vscode.Uri.file(join(ctx.settings.workspace() || ctx.settings.home(), `${slugId(preset.name, 'preset')}.json`)),
					filters: { 'OpenAI preset': ['json'] },
				});
				if (!target) {
					return null;
				}
				// A preset that came from the library is copied byte for byte, so nothing we do not model is lost.
				const source = ctx.tavern.fileFor(preset.source);
				await writeFile(target.fsPath, source ? await readFile(source) : Buffer.from(presetToJson(preset), 'utf8'));
				return { message: `Exported ${basename(target.fsPath)} to ${target.fsPath}` };
			}
			case 'presetTemplate': {
				// Starting from a template copies it into the library, where it is an ordinary preset.
				const template = presetTemplate(String(message.template ?? ''));
				if (!template) {
					return { message: 'That template is not one of ours.', error: true };
				}
				const file = await ctx.tavern.savePresetValue({ ...template.preset, source: '' });
				current = template.id;
				draft = null;
				return { refresh: true, message: `Started from ${template.name}: ${basename(file)}` };
			}
			case 'presetRestoreTemplate': {
				const template = presetTemplate(id);
				if (!template) {
					return { message: 'This preset did not come from one of Comonad’s templates.', error: true };
				}
				const answer = await vscode.window.showWarningMessage(
					`Restore ${preset?.name ?? template.name} from the template?`,
					{ modal: true, detail: 'Every sampler, nudge prompt and prompt block returns to what the template ships.' },
					'Restore',
				);
				if (answer !== 'Restore') {
					return null;
				}
				await ctx.tavern.savePresetValue({ ...template.preset, source: preset?.source ?? '' });
				current = template.id;
				draft = null;
				return { refresh: true, message: `${template.name} was restored from the template.` };
			}
			case 'presetRestorePrompts': {
				if (!preset) {
					return { message: 'Pick a preset first.', error: true };
				}
				const answer = await vscode.window.showWarningMessage(
					`Restore the prompt list of ${preset.name}?`,
					{ modal: true, detail: 'The shipped prompts and their order come back. Samplers and nudge prompts are left alone.' },
					'Restore',
				);
				if (answer !== 'Restore') {
					return null;
				}
				// The restored file carries SillyTavern's definitions and the whole order, Comonad's
				// generated entries included. Their text is never stored: the agent builds it each turn.
				const shipped = promptCollection();
				await ctx.tavern.savePresetValue({
					...preset,
					prompts: ST_PROMPTS.map((prompt) => ({ ...prompt })),
					promptOrder: orderOf(shipped),
					promptOrders: undefined,
				});
				return { refresh: true, message: 'The shipped prompts are back.' };
			}
			default:
				return null;
		}
	};

	/**
	 * The shared prompt library is a file of its own, so it writes straight through instead of waiting
	 * for the preset form's Save: the pane posts the whole library after every change, and a quiet note
	 * keeps the status line out of the way while the next state push re-renders it.
	 */
	const promptLibraryAction = async (message: Record<string, unknown>): Promise<ContentNote | null> => {
		const entries = Array.isArray(message.prompts) ? (message.prompts as PromptLibraryEntry[]) : [];
		try {
			await ctx.tavern.savePromptLibrary(entries);
		} catch (error) {
			return { message: `The prompt library could not be saved: ${describe(error)}`, error: true };
		}
		return { quiet: true };
	};

	const action = async (message: Record<string, unknown>): Promise<ContentNote | null> => {
		const wanted = String(message.kind ?? kind) as ContentKind;
		if (!KINDS.includes(wanted)) {
			return null;
		}
		if (String(message.action ?? '').startsWith('tag') && TAG_ACTIONS.has(String(message.action))) {
			kind = wanted;
			return await tagAction(message);
		}
		if (String(message.action ?? '').startsWith('preset') && PRESET_ACTIONS.has(String(message.action))) {
			kind = wanted;
			return await presetAction(message);
		}
		if (message.action === 'promptLibrarySave') {
			return await promptLibraryAction(message);
		}
		if (String(message.action ?? '').startsWith('character') && CHARACTER_ACTIONS.has(String(message.action))) {
			kind = wanted;
			return await characterAction(message);
		}
		if (String(message.action ?? '').startsWith('persona') && PERSONA_ACTIONS.has(String(message.action))) {
			kind = wanted;
			return await personaAction(message);
		}
		if (wanted === 'lorebooks' && BOOK_ACTIONS.has(String(message.action))) {
			kind = wanted;
			return await bookAction(message);
		}
		if (wanted !== kind) {
			kind = wanted;
			draft = null;
			current = firstItem(kind);
		}
		switch (message.action) {
			case 'select':
				// An empty id means "this kind, not an item": the pane switched tabs and wants that
				// kind's first entry, not an empty page beside a list that has entries in it.
				current = String(message.id ?? '').trim() || firstItem(kind);
				if (kind === 'lorebooks') {
					// Upstream clears the search box when another book is opened, and keeps the sort select.
					view = { ...view, query: '' };
				}
				return null;
			case 'new':
				beginDraft(kind);
				return null;
			case 'duplicate':
				beginDraft(kind, item(kind, current));
				return null;
			case 'save': {
				const file = await save(kind, (message.item ?? {}) as Record<string, unknown>);
				// The persona page saves on its own as fields change, so it asks for no status line.
				return message.quiet === true ? { quiet: true } : { message: `Saved ${describe(file.split('/').pop())}` };
			}
			case 'delete': {
				const gone = await remove(kind, String(message.id ?? ''));
				return gone ? { message: 'Deleted.' } : { message: 'That item is not in Comonad’s library, so nothing was deleted.', error: true };
			}
			case 'adopt': {
				const id = String(message.id ?? '');
				await adopt(kind, id, Boolean(message.asDefault), message.on !== false);
				// Upstream announces the persona it just locked to the chat; the setting can silence it.
				if (kind === 'personas' && message.on !== false && message.asDefault !== true && tavernSettings(ctx).personaShowNotifications) {
					const persona = ctx.tavern.persona(id);
					return persona ? { message: `Selected ${persona.name} for this chat.` } : null;
				}
				return null;
			}
			case 'reveal':
				await reveal(kind);
				return null;
			case 'exportPng': {
				const file = await exportPng(String(message.id ?? ''));
				return file ? { message: `Exported ${describe(file.split('/').pop())}` } : null;
			}
			default:
				return null;
		}
	};

	return {
		state,
		action: async (message) => {
			try {
				return await action(message);
			} catch (error) {
				return { message: describe(error), error: true };
			}
		},
	};
}
