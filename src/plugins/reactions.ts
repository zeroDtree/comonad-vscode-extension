import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';

/** Reacts to the environment: `.comonad` files, settings, workspace trust and folders. */

export function reactions(ctx: Context): void {
	// The tavern feature is a plugin of its own: nothing here reads its library unless it is loaded.
	const tavern = ctx.get('tavern');
	// The plugin list is the host's to apply, and it does not exist yet while this row is being mounted:
	// it is read when a file actually changes, not captured here. Injecting it instead would be worse
	// than useless — the row would wait for the host that is mounting it. A change to a `cordis.yml` is
	// passed to the host rather than reloaded blindly: the host knows when the write was its own.
	const applyList = (file: string) => void ctx.get('plugins')?.fileChanged(file);
	const watcher = vscode.workspace.createFileSystemWatcher('**/.comonad/**');
	const refresh = (uri?: vscode.Uri) => {
		// A `cordis.yml` is the plugin list itself, so a change to it is applied as such rather than
		// as content: everything else in `.comonad` is a file of the library to read again.
		if (uri?.path.endsWith('/cordis.yml')) {
			applyList(uri.fsPath);
			return;
		}
		void ctx.catalog.reload();
		void tavern?.reload();
	};
	watcher.onDidCreate(refresh);
	watcher.onDidChange(refresh);
	watcher.onDidDelete(refresh);
	ctx.effect(() => () => watcher.dispose());

	// The user's own list lives outside the workspace, and is the one a plugin is usually added to.
	const home = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(vscode.Uri.file(ctx.host.home()), '.comonad/cordis.yml'),
	);
	const reload = () => applyList(join(ctx.host.home(), '.comonad', 'cordis.yml'));
	home.onDidCreate(reload);
	home.onDidChange(reload);
	home.onDidDelete(reload);
	ctx.effect(() => () => home.dispose());

	ctx.effect(() => {
		const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration('comonad')) {
				return;
			}
			void ctx.catalog.reload();
			void tavern?.reload();
			if (event.affectsConfiguration('comonad.mcpServers')) {
				void ctx.mcp.reload();
			}
		});
		return () => subscription.dispose();
	});
	ctx.effect(() => {
		const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void ctx.mcp.reload();
			void ctx.catalog.reload();
			void tavern?.reload();
		});
		return () => subscription.dispose();
	});
	ctx.effect(() => {
		const subscription = vscode.workspace.onDidGrantWorkspaceTrust(() => {
			void ctx.catalog.reload();
			void ctx.mcp.reload();
			void tavern?.reload();
		});
		return () => subscription.dispose();
	});

	// Initial load, and the one-time removal of snapshot repositories from the previous design.
	void ctx.catalog.reload();
	void ctx.mcp.reload();
	void tavern?.reload();
	// The journal is its own plugin: purge what an older design left behind, and nothing when it is off.
	void ctx.get('checkpoints')?.purgeLegacy();
}
reactions.inject = ['catalog', 'mcp', 'sessions'];
