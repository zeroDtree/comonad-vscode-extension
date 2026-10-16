import * as vscode from 'vscode';
import type { Context, Plugin } from 'cordis';
import { Checkpoints } from './services/journal';
import { review } from './review';

/**
 * The change journal: one shadow git store per session and workspace, holding every file the agent
 * wrote, as one installable row.
 *
 * It provides the `checkpoints` service — which the agent writes through, the chat panel counts
 * pending changes from, and the review commands read — and draws nothing else: the review is the
 * diff editor and the palette, so the plugin brings its commands and no webview. Without the row
 * nothing is journaled and no review command exists; a write is simply a write.
 *
 * What it does *not* own is the vocabulary: the session's rewind points (`marks`), the storage
 * folder and the `checkpoints/changed` event live in the host, so an install is one folder and no
 * host change. The host reaches the journal through `ctx.get('checkpoints')`, which is how a feature
 * this size stays optional.
 */

export { Checkpoints } from './services/journal';
export type { Blob, JournalApi, JournalEntry, JournalFile, Pending, RevertReport, Overwrite } from './services/journal';
export { ChangedOutsideError, DirtyEditorError } from './services/journal';
export { parseDiffs, type JournalHunk } from './lib/diff';

export async function apply(ctx: Context): Promise<void> {
	await ctx.plugin(Checkpoints);
	// The review is a plugin of its own so that its handlers *inject* the journal: the commands read
	// `ctx.checkpoints`, and `review.inject` is what declares it.
	ctx.plugin(review);
	// The commands this plugin answers are declared in Comonad's manifest with an `enablement` of
	// `comonad.checkpoints`: the palette and the keybinding show them while the row is loaded, and have
	// nothing to offer (and nothing that fails) while it is not.
	void vscode.commands.executeCommand('setContext', 'comonad.checkpoints', true);
	ctx.effect(() => () => void vscode.commands.executeCommand('setContext', 'comonad.checkpoints', false));
}

const plugin = apply as Plugin.Function;
// `name` is a function's own non-writable property: it is defined, not assigned, so the log lines that
// name the row do not throw in strict mode.
Object.defineProperty(plugin, 'name', { value: 'checkpoints', configurable: true });
// Every service the row and its two children need before the journal can record anything; until they
// are all there the row waits, which is what "the kernel is not up yet" looks like.
plugin.inject = ['log', 'host', 'sessions'];
export default plugin;
