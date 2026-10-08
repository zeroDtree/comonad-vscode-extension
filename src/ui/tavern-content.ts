import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
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
} from '../lib/tavern/authoring';
import { blankPng, cardToPng } from '../lib/tavern/card';
import { describe } from '../lib/util';
import type { ContentKind } from '../services/tavern';
import { assignCharacter } from './tavern';

/**
 * The content editor, as the settings panel's **ST** tab uses it: the four kinds of tavern content
 * in Comonad's own library (`{characters,lorebooks,presets,personas}` under `.comonad`), written in
 * SillyTavern's file formats. The pane is a webview; every message it sends is untrusted, so the
 * payloads go through the `adopt*` sanitisers before a writer ever sees them.
 */

export interface ContentNote {
	message: string;
	error?: boolean;
}

/** The four kinds, in the order the pane shows them. */
const KINDS: ContentKind[] = ['characters', 'lorebooks', 'personas', 'presets'];

export interface ContentController {
	/** The state slice the settings panel pushes with its own. */
	state(): Record<string, unknown>;
	/** Handles one `{type:'content', action}` message. Returns a note for the pane, if any. */
	action(message: Record<string, unknown>): Promise<ContentNote | null>;
	/** The pane's selection follows the last chat, so "Use in this chat" starts on the right item. */
	focus(kind?: ContentKind): void;
}

export function contentController(ctx: Context): ContentController {
	let kind: ContentKind = 'characters';	let current: string | null = null;
	/** An item the pane created but has not saved yet: not in the catalog, and never written. */
	let draft: unknown = null;

	const items = (wanted: ContentKind): { id: string; name: string; detail: string; source: string }[] => {
		switch (wanted) {
			case 'characters':
				return ctx.tavern.characters.map((character) => ({
					id: character.id,
					name: character.name,
					detail: character.description.split('\n')[0]?.slice(0, 90) || 'no description',
					source: character.source,
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
						? `bound to ${persona.connections.join(', ')}`
						: persona.description.split('\n')[0]?.slice(0, 90) || 'no description',
					source: persona.source,
				}));
			case 'presets':
				return ctx.tavern.presets.map((preset) => ({
					id: preset.id,
					name: preset.name,
					detail: `${preset.prompts?.length ?? 0} prompts${preset.temperature !== undefined ? ` · temp ${preset.temperature}` : ''}`,
					source: preset.source ?? '',
				}));
		}
	};

	/** The full item the form edits, loaded fresh from the catalog unless it is an unsaved draft. */
	const item = (wanted: ContentKind, id: string | null): unknown => {
		if (draft && id === current) {
			return draft;
		}
		switch (wanted) {
			case 'characters':
				return ctx.tavern.character(id ?? '') ?? null;
			case 'lorebooks': {
				const found = ctx.tavern.book(id ?? '');
				return found ? { ...found.book, source: found.source, raw: found.raw } : null;
			}
			case 'personas':
				return ctx.tavern.persona(id ?? '') ?? null;
			case 'presets':
				return ctx.tavern.preset(id ?? '') ?? null;
		}
	};

	/** What the active chat uses, so the pane can mark it and offer to change it. */
	const adopted = (): Record<string, string[]> => {
		const session = ctx.sessions.active();
		const config = ctx.settings.get();
		return {
			characters: [session?.character ?? config.tavernCharacter].filter(Boolean),
			lorebooks: session?.lorebooks ?? config.tavernLorebooks,
			personas: [session?.persona ?? config.tavernPersona].filter(Boolean),
			presets: [session?.preset ?? config.tavernPreset].filter(Boolean),
		};
	};

	const firstItem = (wanted: ContentKind): string | null => items(wanted)[0]?.id ?? null;

	const state = (): Record<string, unknown> => ({
		kind,
		items: items(kind),
		item: item(kind, current),
		adopted: adopted(),
		counts: {
			characters: ctx.tavern.characters.length,
			lorebooks: ctx.tavern.books.length,
			personas: ctx.tavern.personas.length,
			presets: ctx.tavern.presets.length,
		},
		kindLabels: { characters: 'Characters', lorebooks: 'World books', personas: 'Personas', presets: 'Presets' },
		library: ctx.tavern.libraryPath(kind),
		catalog: {
			characters: ctx.tavern.characters.map((character) => ({ id: character.id, name: character.name })),
			lorebooks: ctx.tavern.books.map((book) => ({ id: book.name, name: book.name })),
			personas: ctx.tavern.personas.map((persona) => ({ id: persona.id, name: persona.title || persona.name })),
			presets: ctx.tavern.presets.map((preset) => ({ id: preset.id, name: preset.name })),
		},
	});

	/** A draft is only a draft until it is saved; the catalog never sees it. */
	const beginDraft = (wanted: ContentKind, copy?: unknown): void => {
		if (copy) {
			const name = `${String((copy as { name?: unknown }).name ?? 'item')} (copy)`;
			const clone: Record<string, unknown> = { ...(structuredClone(copy) as Record<string, unknown>), id: slugId(name, 'item'), name, source: '' };
			if (wanted === 'lorebooks') {
				clone.raw = {};
			}
			draft = clone;
			current = String(clone.id);
			return;
		}
		switch (wanted) {
			case 'characters':
				draft = blankCharacter('New character', slugId('New character', 'character'));
				current = (draft as { id: string }).id;
				break;
			case 'lorebooks': {
				const book = blankBook('New lorebook');
				const uid = nextUid(book);
				book.entries[String(uid)] = blankEntry(uid);
				draft = { ...book, source: '', raw: {} };
				current = book.name;
				break;
			}
			case 'personas':
				draft = blankPersona('New persona', slugId('New persona', 'persona'));
				current = (draft as { id: string }).id;
				break;
			case 'presets':
				draft = blankPreset('New preset', slugId('New preset', 'preset'));
				current = (draft as { id: string }).id;
				break;
		}
	};

	const save = async (wanted: ContentKind, raw: Record<string, unknown>): Promise<string> => {
		switch (wanted) {
			case 'characters': {
				const character = adoptCharacter(raw);
				const file = await ctx.tavern.saveCharacter(character);
				draft = null;
				current = character.id;
				return file;
			}
			case 'lorebooks': {
				const book = adoptBook(raw);
				const file = await ctx.tavern.saveBook(book.name, book, book.source, book.raw);
				draft = null;
				current = book.name;
				return file;
			}
			case 'personas': {
				const persona = adoptPersona(raw);
				const file = await ctx.tavern.savePersona(persona);
				draft = null;
				current = persona.id;
				return file;
			}
			case 'presets': {
				const preset = adoptPreset(raw);
				const file = await ctx.tavern.savePresetValue(preset, preset.source);
				draft = null;
				current = preset.id;
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
				const books = ctx.settings.get().tavernLorebooks;
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
			const books = new Set(session.lorebooks ?? ctx.settings.get().tavernLorebooks);
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
		const character = ctx.tavern.character(id) ?? ctx.tavern.characters[0];
		if (!character) {
			throw new Error('no character to export');
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

	const action = async (message: Record<string, unknown>): Promise<ContentNote | null> => {
		const wanted = String(message.kind ?? kind) as ContentKind;
		if (!KINDS.includes(wanted)) {
			return null;
		}
		if (wanted !== kind) {
			kind = wanted;
			draft = null;
			current = firstItem(kind);
		}
		switch (message.action) {
			case 'ready':
				current = current && item(kind, current) ? current : firstItem(kind);
				return null;
			case 'select':
				current = String(message.id ?? '');
				return null;
			case 'new':
				beginDraft(kind);
				return null;
			case 'duplicate':
				beginDraft(kind, item(kind, current));
				return null;
			case 'save': {
				const file = await save(kind, (message.item ?? {}) as Record<string, unknown>);
				return { message: `Saved ${describe(file.split('/').pop())}` };
			}
			case 'delete': {
				const gone = await remove(kind, String(message.id ?? ''));
				return gone ? { message: 'Deleted.' } : { message: 'That item is not in Comonad’s library, so nothing was deleted.', error: true };
			}
			case 'adopt':
				await adopt(kind, String(message.id ?? ''), Boolean(message.asDefault), message.on !== false);
				return null;
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
		focus: (wanted) => {
			if (wanted) {
				kind = wanted;
				draft = null;
				current = firstItem(kind);
			} else {
				current = current && item(kind, current) ? current : firstItem(kind);
			}
		},
	};
}
