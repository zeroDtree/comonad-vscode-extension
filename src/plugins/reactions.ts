import * as vscode from 'vscode';
import type { Context } from 'cordis';

/** Reacts to the environment: `.comonad` files, settings, workspace trust and folders. */

export function reactions(ctx: Context): void {
	const watcher = vscode.workspace.createFileSystemWatcher('**/.comonad/**');
	const refresh = () => {
		void ctx.catalog.reload();
		void ctx.tavern.reload();
	};
	watcher.onDidCreate(refresh);
	watcher.onDidChange(refresh);
	watcher.onDidDelete(refresh);
	ctx.effect(() => () => watcher.dispose());

	ctx.effect(() => {
		const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration('comonad')) {
				return;
			}
			void ctx.catalog.reload();
			void ctx.tavern.reload();
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
			void ctx.tavern.reload();
		});
		return () => subscription.dispose();
	});
	ctx.effect(() => {
		const subscription = vscode.workspace.onDidGrantWorkspaceTrust(() => {
			void ctx.catalog.reload();
			void ctx.mcp.reload();
			void ctx.tavern.reload();
		});
		return () => subscription.dispose();
	});

	// Initial load and checkpoint housekeeping.
	void ctx.catalog.reload();
	void ctx.mcp.reload();
	void ctx.tavern.reload();
	const session = ctx.sessions.active();
	if (session?.policy.workingDirectory) {
		void ctx.checkpoints.gc(session.policy.workingDirectory, session.id);
	}
}
reactions.inject = ['catalog', 'mcp', 'sessions', 'checkpoints'];
