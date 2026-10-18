// SPDX-License-Identifier: AGPL-3.0-only
import * as vscode from 'vscode';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from 'cordis';
import type { CommandSpec } from '@comonad/services/commands';
import { slugId } from './lib/authoring';
import { blankPng, cardToPng, greetingsOf } from './lib/card';
import { tavernSettings } from './lib/settings';
import type { Character, Persona, TavernPreset } from './lib/types';
import { registerCommand } from '@comonad/ui/register';

/** Picking tavern content for the active chat: a character (with its opening line) and its books. */

function describe(character: Character): string {
	const parts = [character.source];
	if (character.book?.entries?.length) {
		parts.push(`${character.book.entries.length} lore entries`);
	}
	if (character.alternateGreetings.length) {
		parts.push(`${character.alternateGreetings.length} alternate greeting(s)`);
	}
	return parts.join(' · ');
}

/**
 * Binds a character to a chat and opens it with the chosen greeting. A chat that already said
 * something is never rewritten — it just gains the character.
 */
export function assignCharacter(ctx: Context, sessionId: string, character: Character, index = 0): boolean {
	const session = ctx.sessions.require(sessionId);
	session.character = character.id;
	ctx.sessions.save(session);
	const line = greetingsOf(character)[index];
	return line ? ctx.sessions.greet(sessionId, line, index) : false;
}

export function tavernCommands(ctx: Context): void {
	registerCommand(ctx, 'comonad.pickCharacter', async () => {
		if (!ctx.tavern.characters.length) {
			ctx.host.notify('Comonad: no characters found. Put cards in .comonad/characters, or use Comonad: Manage Content.');
			return;
		}
		const session = ctx.sessions.active() ?? ctx.sessions.ensureActive(ctx.agent.policyFor());
		const picked = await vscode.window.showQuickPick(
			ctx.tavern.characters.map((character) => ({
				label: character.name,
				description: describe(character),
				detail: character.description.slice(0, 200),
				id: character.id,
			})),
			{ title: 'Character', placeHolder: 'Write this chat as…', ignoreFocusOut: true },
		);
		if (!picked) {
			return;
		}
		const character = ctx.tavern.character(picked.id) ?? ctx.tavern.findCharacter(picked.id);
		if (!character) {
			return;
		}
		const greetings = greetingsOf(character);
		let index = 0;
		if (greetings.length > 1) {
			const chosen = await vscode.window.showQuickPick(
				greetings.map((line, at) => ({
					label: (at === 0 ? '$(star) ' : '$(comment) ') + line.split('\n')[0]!.slice(0, 60),
					detail: at === 0 ? 'The card’s own greeting' : `Alternate greeting ${at}`,
					at,
				})),
				{ title: `${character.name} — opening line`, placeHolder: 'How should the chat begin?', ignoreFocusOut: true },
			);
			if (!chosen) {
				// Cancelling the greeting still selects the character: the chat simply opens empty.
				session.character = character.id;
				ctx.sessions.save(session);
				ctx.sessions.changed(session.id);
				return;
			}
			index = chosen.at;
		}
		const inserted = assignCharacter(ctx, session.id, character, index);
		if (!inserted && greetings.length) {
			ctx.host.notify('Comonad: this chat already has messages, so the greeting was not inserted.');
		}
	});

	registerCommand(ctx, 'comonad.pickPersona', async () => {
		if (!ctx.tavern.personas.length) {
			ctx.host.notify('Comonad: no personas found. Put them in .comonad/personas, or use Comonad: Manage Content.');
			return;
		}
		const session = ctx.sessions.active() ?? ctx.sessions.ensureActive(ctx.agent.policyFor());
		const current = session.persona ?? tavernSettings(ctx).tavernPersona;
		const picked = await vscode.window.showQuickPick(
			[
				{ label: '$(circle-slash) None', description: 'Speak as ' + tavernSettings(ctx).tavernUserName, id: '' },
				...ctx.tavern.personas.map((persona) => ({
					label: (persona.id === current ? '$(check) ' : '') + (persona.title || persona.name),
					description: describePersona(persona),
					detail: persona.description.split('\n')[0]?.slice(0, 200),
					id: persona.id,
				})),
			],
			{ title: 'Persona', placeHolder: 'Who is the user in this chat?', ignoreFocusOut: true },
		);
		if (!picked) {
			return;
		}
		session.persona = picked.id || undefined;
		ctx.sessions.save(session);
		ctx.sessions.changed(session.id);
	});

	registerCommand(ctx, 'comonad.pickTavernPreset', async () => {
		const session = ctx.sessions.active() ?? ctx.sessions.ensureActive(ctx.agent.policyFor());
		const current = session.preset ?? tavernSettings(ctx).tavernPreset;
		const picked = await vscode.window.showQuickPick(
			[
				{ label: '$(circle-slash) Default (built-in)', description: 'Comonad’s blocks and SillyTavern’s shipped prompts', id: '' },
				...ctx.tavern.presets.map((preset) => ({
					label: (preset.id === current ? '$(check) ' : '') + preset.name,
					description: describePreset(preset),
					id: preset.id,
				})),
			],
			{ title: 'Preset', placeHolder: 'Prompts, order and samplers for this chat', ignoreFocusOut: true },
		);
		if (!picked) {
			return;
		}
		session.preset = picked.id || undefined;
		ctx.sessions.save(session);
		ctx.sessions.changed(session.id);
	});

	registerCommand(ctx, 'comonad.pickLorebooks', async () => {
		if (!ctx.tavern.books.length) {
			ctx.host.notify(
				'Comonad: no world books found. Put them in .comonad/lorebooks, or create one in the ST tab of the settings.',
			);
			return;
		}
		const session = ctx.sessions.active() ?? ctx.sessions.ensureActive(ctx.agent.policyFor());
		const selected = new Set(session.lorebooks ?? tavernSettings(ctx).tavernLorebooks);
		const picked = await vscode.window.showQuickPick(
			ctx.tavern.books.map((entry) => ({
				label: entry.name,
				description: `${Object.keys(entry.book.entries).length} entries · ${entry.source}`,
				picked: selected.has(entry.name),
				name: entry.name,
			})),
			{ title: 'World books', placeHolder: 'Scanned for this chat', canPickMany: true, ignoreFocusOut: true },
		);
		if (!picked) {
			return;
		}
		session.lorebooks = picked.map((item) => item.name);
		ctx.sessions.save(session);
		ctx.sessions.changed(session.id);
	});

	registerCommand(ctx, 'comonad.reloadTavern', async () => {
		await ctx.tavern.reload();
		ctx.host.notify(
			`Comonad: ${ctx.tavern.characters.length} character(s), ${ctx.tavern.books.length} book(s), ${ctx.tavern.presets.length} preset(s), ${ctx.tavern.personas.length} persona(s).`,
		);
	});

	registerCommand(ctx, 'comonad.revealContentLibrary', async () => {
		const dir = ctx.tavern.libraryRoot();
		mkdirSync(dir, { recursive: true });
		await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
	});

	/**
	 * Writes a character out as a PNG card, the way cards are shared. The card keeps its picture when
	 * it came from one; a card that was built here gets a blank canvas.
	 */
	registerCommand(ctx, 'comonad.exportCharacter', async () => {
		const session = ctx.sessions.active();
		const character = ctx.tavern.character(session?.character ?? tavernSettings(ctx).tavernCharacter) ?? ctx.tavern.characters[0];
		if (!character) {
			ctx.host.notify('Comonad: no character to export. Create one in the ST tab of the settings.');
			return;
		}
		const target = await vscode.window.showSaveDialog({
			title: `Export ${character.name} as a PNG card`,
			defaultUri: vscode.Uri.file(join(ctx.settings.workspace() || ctx.settings.home(), `${slugId(character.name, 'card')}.png`)),
			filters: { 'Character card': ['png'] },
		});
		if (!target) {
			return;
		}
		const source = character.source.toLowerCase().endsWith('.png') ? character.source : '';
		const image = source ? Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(source))) : blankPng();
		await vscode.workspace.fs.writeFile(target, cardToPng(image, character));
		ctx.host.notify(`exported ${target.fsPath}`);
	});
}

tavernCommands.inject = ['tavern', 'sessions', 'settings', 'host', 'agent'];

/** One-line description of a persona: where its text lands and what it covers. */
function describePersona(persona: Persona): string {
	const parts = [persona.source];
	if (persona.lorebook) {
		parts.push(`book ${persona.lorebook}`);
	}
	if (!persona.description) {
		parts.push('no description');
	}
	return parts.join(' · ');
}

/** One-line description of a preset: how many prompt blocks and whether it sets samplers. */
function describePreset(preset: TavernPreset): string {
	const parts = [`${promptCount(preset)} prompts`];
	if (preset.temperature !== undefined) {
		parts.push(`temp ${preset.temperature}`);
	}
	if (preset.maxTokens) {
		parts.push(`max ${preset.maxTokens}`);
	}
	return parts.join(' · ');
}

function promptCount(preset: TavernPreset): number {
	return preset.prompts?.length ?? 0;
}

/** The rows `/help` gets from this plugin, while it is loaded. */
export function tavernHelp(ctx: Context): void {
	ctx.commands.addHelp('tavern', [
		'| `/char [name]` | pick the character this chat speaks as |',
		'| `/persona [name]` | pick who you are in this chat |',
		'| `/lore [names]` | pick the world books this chat scans |',
		'| `/preset [name]` | pick the prompt and sampler preset |',
		"| `/note [text]` | set or clear the standing author's note |",
	]);
}

/** Selecting tavern content for a chat, as slash commands: the host's command list, the plugin's rules. */
export function tavernSlashCommands(ctx: Context): void {
	const register = (name: string, description: string, run: CommandSpec['run']): void => {
		ctx.commands.register({ name, description, run });
	};

		register('char', 'Pick the character this chat speaks as', async (args, surface) => {
			const session = ctx.sessions.active();
			if (!session) {
				surface.markdown('No active session yet.');
				return { done: true };
			}
			const named = args.trim();
			if (!named) {
				await vscode.commands.executeCommand('comonad.pickCharacter');
				return { done: true };
			}
			const character = ctx.tavern.findCharacter(named);
			if (!character) {
				const known = ctx.tavern.characters.map((entry) => entry.name).join(', ') || '(none found)';
				surface.markdown(`No character named **${named}**. Known characters: ${known}.`);
				return { done: true };
			}
			const opened = assignCharacter(ctx, session.id, character);
			const greetings = greetingsOf(character).length;
			surface.markdown(
				`This chat speaks as **${character.name}**.` +
					(opened ? ' It opens with the card’s greeting.' : greetings ? ' The chat already has messages, so the greeting was not inserted.' : ''),
			);
			return { done: true };
		});

		register('persona', 'Pick who you are in this chat', async (args, surface) => {
			const session = ctx.sessions.active();
			if (!session) {
				surface.markdown('No active session yet.');
				return { done: true };
			}
			const named = args.trim().toLowerCase();
			if (!named) {
				await vscode.commands.executeCommand('comonad.pickPersona');
				return { done: true };
			}
			const persona = ctx.tavern.findPersona(named);
			if (!persona) {
				const known = ctx.tavern.personas.map((entry) => entry.title || entry.name).join(', ') || '(none found)';
				surface.markdown(`No persona named **${args.trim()}**. Known personas: ${known}.`);
				return { done: true };
			}
			session.persona = persona.id;
			ctx.sessions.save(session);
			ctx.sessions.changed(session.id);
			surface.markdown(`You are **${persona.title || persona.name}** in this chat.`);
			return { done: true };
		});

		register('lore', 'Pick the world books this chat scans', async (args, surface) => {
			const session = ctx.sessions.active();
			if (!session) {
				surface.markdown('No active session yet.');
				return { done: true };
			}
			const named = args.trim();
			if (!named) {
				await vscode.commands.executeCommand('comonad.pickLorebooks');
				return { done: true };
			}
			if (named.toLowerCase() === 'none') {
				session.lorebooks = [];
				ctx.sessions.save(session);
				ctx.sessions.changed(session.id);
				surface.markdown('This chat scans no world books of its own.');
				return { done: true };
			}
			const { found, missing } = ctx.tavern.resolveBooks(named.split(/[\s,]+/));
			if (missing.length) {
				const known = ctx.tavern.books.map((entry) => entry.name).join(', ') || '(none found)';
				surface.markdown(`No world book named ${missing.map((name) => `**${name}**`).join(', ')}. Known books: ${known}.`);
				return { done: true };
			}
			session.lorebooks = found;
			ctx.sessions.save(session);
			ctx.sessions.changed(session.id);
			surface.markdown(`This chat scans: ${found.join(', ')}.`);
			return { done: true };
		});

		register('preset', 'Pick the prompt and sampler preset', async (args, surface) => {
			const named = args.trim();
			if (!named) {
				await vscode.commands.executeCommand('comonad.pickTavernPreset');
				return { done: true };
			}
			const session = ctx.sessions.active();
			if (!session) {
				surface.markdown('No active session yet.');
				return { done: true };
			}
			if (named.toLowerCase() === 'none') {
				session.preset = undefined;
				ctx.sessions.save(session);
				ctx.sessions.changed(session.id);
				surface.markdown('This chat uses the built-in Default preset.');
				return { done: true };
			}
			const preset = ctx.tavern.findPreset(named);
			if (!preset) {
				const known = ctx.tavern.presets.map((entry) => entry.name).join(', ') || '(none found)';
				surface.markdown(`No preset named **${named}**. Known presets: ${known}.`);
				return { done: true };
			}
			session.preset = preset.id;
			ctx.sessions.save(session);
			ctx.sessions.changed(session.id);
			surface.markdown(`This chat uses **${preset.name}**.`);
			return { done: true };
		});

		register('note', "Set or clear this chat's standing author's note", (args, surface) => {
			const session = ctx.sessions.active();
			if (!session) {
				surface.markdown('No active session yet.');
				return { done: true };
			}
			const text = args.trim();
			session.authorNote = text || undefined;
			ctx.sessions.save(session);
			ctx.sessions.changed(session.id);
			surface.markdown(text ? `Author's note set (depth ${tavernSettings(ctx).tavernNoteDepth}).` : 'Author’s note cleared.');
			return { done: true };
		});
}
