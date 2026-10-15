import * as vscode from 'vscode';
import type { Context, Plugin } from 'cordis';
import { loreToolPlugin } from './tools/tavern';
import { Tavern } from './services/tavern';
import { tavernCommands, tavernHelp, tavernSlashCommands } from './commands';
import { tavernPane } from './panel/pane';

/**
 * The tavern plugin: everything SillyTavern-shaped Comonad knows, as one installable row.
 *
 * It provides the `tavern` service — the content library and the composition of a turn out of it —
 * registers the `/char`, `/persona`, `/lore`, `/preset` and `/note` commands, offers the `lore_lookup`
 * tool, and draws the **ST** tab in the settings panel. Without the row none of that exists: the agent
 * falls back to its own prompt shape, and the panel has no tab to show.
 *
 * What it does *not* own is the vocabulary: the content types, the settings keys and the session fields
 * it reads and writes live in the host, under `@comonad/*`, so an install is one folder and no host
 * change. The host reaches it through `ctx.get('tavern')`, which is how a feature this size stays
 * optional.
 */

export type { ComposeInput, ComposeResult, TavernApi, TavernBinding, ContentKind } from './services/tavern';
export type { PresetSamplers } from './lib/preset';
export type { LoreBook, LoreMessage } from './lib/lore';

export async function apply(ctx: Context): Promise<void> {
	// The library is read before anything else is wired: a pane or a command that landed first would
	// answer questions about content that has not been loaded yet.
	await ctx.plugin(Tavern);
	ctx.plugin(loreToolPlugin);
	ctx.effect(() => {
		const panes = ctx.get('panes');
		return panes ? panes.register(tavernPane(ctx)) : () => undefined;
	});
	tavernHelp(ctx);
	tavernCommands(ctx);
	tavernSlashCommands(ctx);
	// The commands this plugin answers are declared in Comonad's manifest with an `enablement` of
	// `comonad.tavern`: the palette and the chat title bar show them while the row is loaded, and have
	// nothing to offer (and nothing that fails) while it is not.
	void vscode.commands.executeCommand('setContext', 'comonad.tavern', true);
	ctx.effect(() => () => void vscode.commands.executeCommand('setContext', 'comonad.tavern', false));
}

const plugin = apply as Plugin.Function;
// `name` is a function's own non-writable property: it is defined, not assigned, so the log lines that
// name the row do not throw in strict mode.
Object.defineProperty(plugin, 'name', { value: 'tavern', configurable: true });
// Every service the row needs to *do* something; until they are all there it stays waiting.
plugin.inject = ['log', 'host', 'settings', 'sessions', 'tools', 'commands', 'panes'];
export default plugin;
