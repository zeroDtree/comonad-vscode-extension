// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';

/** Reacts to the environment: `.comonad` files, settings, workspace trust and folders. */

/** The slice of the tavern service this row touches: to reload it, and to recognise its own writes. */
interface Reloadable {
	reload(): Promise<void>;
	isOwnWrite(file: string): Promise<boolean>;
}

export function reactions(ctx: Context): void {
	// The tavern feature is a plugin of its own: nothing here reads its library unless it is loaded.
	// It is looked up when a file actually changes, not captured here — a tavern installed mid-session
	// is watched from the moment its row arrives. The plugin list is the host's to apply: a change to a
	// `cordis.yml` is passed to the host rather than reloaded blindly, because the host knows when the
	// write was its own.
	const applyList = (file: string) => void ctx.get('plugins')?.fileChanged(file);
	const tavern = (): Reloadable | undefined => ctx.get('tavern') as Reloadable | undefined;
	// The catalog only reads `skills`, `agents` and `commands`; the content folders beside them are
	// the tavern's, and a save there must not re-read anything but the file it saved.
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
		// A change this process made is already in the catalog it wrote: the watcher is for edits made
		// elsewhere. The check consumes the record, so the next change to the file is an edit again.
		const outside: string[] = [];
		for (const file of files) {
			if (await tavern()?.isOwnWrite(file)) {
				continue;
			}
			outside.push(file);
		}
		if (!outside.length) {
			return;
		}
		if (outside.some((file) => catalogPaths.test(file))) {
			await ctx.catalog.reload().catch((error) => ctx.log.message(`reactions: catalog reload failed: ${error}`));
		}
		if (outside.some((file) => !catalogPaths.test(file))) {
			await tavern()
				?.reload()
				.catch((error) => ctx.log.message(`reactions: tavern reload failed: ${error}`));
		}
	};

	const watcher = vscode.workspace.createFileSystemWatcher('**/.comonad/**');
	const refresh = (uri?: vscode.Uri) => {
		// A `cordis.yml` is the plugin list itself, so a change to it is applied as such rather than
		// as content: everything else in `.comonad` is a file of the library to read again.
		if (uri?.path.endsWith('/cordis.yml')) {
			applyList(uri.fsPath);
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

	ctx.effect(() => {
		const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
			// Settings are not files: a `comonad.*` write changes nothing on disk to read again. The
			// one setting that names a resource of its own is the server list.
			if (event.affectsConfiguration('comonad.mcpServers')) {
				void ctx.mcp.reload().catch((error) => ctx.log.message(`reactions: mcp reload failed: ${error}`));
			}
		});
		return () => subscription.dispose();
	});
	ctx.effect(() => {
		const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			// The library roots move with the window, so everything that reads them reads them again.
			void ctx.catalog.reload().catch((error) => ctx.log.message(`reactions: catalog reload failed: ${error}`));
			void ctx.mcp.reload().catch((error) => ctx.log.message(`reactions: mcp reload failed: ${error}`));
			void tavern()
				?.reload()
				.catch((error) => ctx.log.message(`reactions: tavern reload failed: ${error}`));
		});
		return () => subscription.dispose();
	});
	ctx.effect(() => {
		const subscription = vscode.workspace.onDidGrantWorkspaceTrust(() => {
			// A trusted workspace contributes its own `.comonad`, so the roots grow a branch.
			void ctx.catalog.reload().catch((error) => ctx.log.message(`reactions: catalog reload failed: ${error}`));
			void ctx.mcp.reload().catch((error) => ctx.log.message(`reactions: mcp reload failed: ${error}`));
			void tavern()
				?.reload()
				.catch((error) => ctx.log.message(`reactions: tavern reload failed: ${error}`));
		});
		return () => subscription.dispose();
	});

	// Initial load, and the one-time removal of snapshot repositories from the previous design. The
	// tavern reads its own library when its service is constructed, so it is not read again here.
	void ctx.catalog.reload().catch((error) => ctx.log.message(`reactions: catalog reload failed: ${error}`));
	void ctx.mcp.reload().catch((error) => ctx.log.message(`reactions: mcp reload failed: ${error}`));
	// The journal is its own row: purge what an older design left behind, and nothing when it is off.
	void ctx
		.get('checkpoints')
		?.purgeLegacy()
		.catch((error) => ctx.log.message(`reactions: legacy purge failed: ${error}`));
}
reactions.inject = ['catalog', 'mcp', 'sessions'];
