// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';

/** Reacts to the environment: `.comonad` files, settings, workspace trust and folders. */

export function reactions(ctx: Context): void {
	// The plugin list is the host's to apply: a change to a `cordis.yml` is passed to the host rather
	// than reloaded blindly, because the host knows when the write was its own.
	const applyList = (file: string) => void ctx.get('plugins')?.fileChanged(file);
	// The catalog only reads `skills`, `agents` and `commands`; other `.comonad` files are not ours.
	const catalogPaths = /[\\/]\.comonad[\\/](skills|agents|commands)[\\/]/;

	/** A batch of file changes, coalesced: one reload answers a storm of events. */
	let timer: NodeJS.Timeout | undefined;
	const touched = new Set<string>();
	const schedule = (file: string): void => {
		touched.add(file);
		clearTimeout(timer);
		timer = setTimeout(() => {
			const files = [...touched];
			touched.clear();
			void reloadFor(files);
		}, 300);
	};
	const reloadFor = async (files: string[]): Promise<void> => {
		if (files.some((file) => catalogPaths.test(file))) {
			await ctx.catalog.reload().catch((error) => ctx.log.message(`reactions: catalog reload failed: ${error}`));
		}
	};

	const watcher = vscode.workspace.createFileSystemWatcher('**/.comonad/**');
	const refresh = (uri?: vscode.Uri) => {
		// A `cordis.yml` is the plugin list itself, so a change to it is applied as such rather than
		// as content: everything else in `.comonad` is a file of the library to read again. Settings
		// are the host's own: its watcher has already dropped the cache and said so.
		if (uri?.path.endsWith('/cordis.yml')) {
			applyList(uri.fsPath);
			return;
		}
		if (uri?.path.endsWith('/settings.json')) {
			return;
		}
		if (uri) {
			schedule(uri.fsPath);
		}
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

	// The server list names resources of its own: reload it when a hand edit changed it, not on
	// every settings save. A save this panel made reloads explicitly after its awaited write.
	let mcpSeen = JSON.stringify(ctx.host.config().mcpServers ?? {});
	ctx.on('settings/changed', () => {
		mcpSeen = JSON.stringify(ctx.host.config().mcpServers ?? {});
	});
	ctx.on('settings/file-changed', () => {
		const next = JSON.stringify(ctx.host.config().mcpServers ?? {});
		if (next === mcpSeen) {
			return;
		}
		mcpSeen = next;
		void ctx.mcp.reload().catch((error) => ctx.log.message(`reactions: mcp reload failed: ${error}`));
	});
	ctx.effect(() => {
		const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			// The catalog roots move with the window, so it reads them again.
			void ctx.catalog.reload().catch((error) => ctx.log.message(`reactions: catalog reload failed: ${error}`));
			void ctx.mcp.reload().catch((error) => ctx.log.message(`reactions: mcp reload failed: ${error}`));
		});
		return () => subscription.dispose();
	});
	ctx.effect(() => {
		const subscription = vscode.workspace.onDidGrantWorkspaceTrust(() => {
			// A trusted workspace contributes its own `.comonad`, so the catalog roots grow a branch.
			void ctx.catalog.reload().catch((error) => ctx.log.message(`reactions: catalog reload failed: ${error}`));
			void ctx.mcp.reload().catch((error) => ctx.log.message(`reactions: mcp reload failed: ${error}`));
		});
		return () => subscription.dispose();
	});

	// Initial load, and the one-time removal of snapshot repositories from the previous design.
	void ctx.catalog.reload().catch((error) => ctx.log.message(`reactions: catalog reload failed: ${error}`));
	void ctx.mcp.reload().catch((error) => ctx.log.message(`reactions: mcp reload failed: ${error}`));
	// The journal is its own row: purge what an older design left behind, and nothing when it is off.
	void ctx
		.get('checkpoints')
		?.purgeLegacy()
		.catch((error) => ctx.log.message(`reactions: legacy purge failed: ${error}`));
}
reactions.inject = ['catalog', 'mcp', 'sessions'];
