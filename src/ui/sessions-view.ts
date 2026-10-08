import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { MODE_LABELS } from '../lib/policy';
import type { Session } from '../services/sessions';
import { registerCommand } from './register';

/** Sessions tree view with open / fork / rename / delete commands. */

function ago(at: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (seconds < 60) {
		return 'just now';
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	return `${Math.round(hours / 24)}d ago`;
}

export function sessionsView(ctx: Context): void {
	const emitter = new vscode.EventEmitter<void>();
	const provider: vscode.TreeDataProvider<vscode.TreeItem> = {
		onDidChangeTreeData: emitter.event,
		getTreeItem: (element) => element,
		getChildren: () => {
			const active = ctx.sessions.active()?.id;
			return ctx.sessions.list().map((session) => {
				const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
				item.id = session.id;
				item.description = `${MODE_LABELS[session.policy.workMode]?.split(' — ')[0] ?? session.policy.workMode} · ${ago(session.updatedAt)}${session.cursor ? ' · paused' : ''}`;
				item.tooltip = `${session.id}\n${session.transcript.length} messages · updated ${new Date(session.updatedAt).toLocaleString()}`;
				item.iconPath = new vscode.ThemeIcon(active === session.id ? 'comment-discussion' : 'comment');
				item.contextValue = 'comonad.session';
				item.command = { command: 'comonad.openSession', title: 'Open session', arguments: [session.id] };
				return item;
			});
		},
	};
	const tree = vscode.window.createTreeView('comonad.sessions', { treeDataProvider: provider });
	ctx.effect(() => () => {
		tree.dispose();
		emitter.dispose();
	});
	ctx.on('sessions/changed', () => emitter.fire());

	registerCommand(ctx, 'comonad.openSession', (id) => {
		if (typeof id === 'string') {
			ctx.sessions.setActive(id);
		}
	});
	registerCommand(ctx, 'comonad.newSession', async () => {
		ctx.sessions.create(ctx.agent.policyFor());
		// A new chat you cannot see is not a new chat: show the surface and hand the caret to its
		// input, so Cmd+N reads the same from the chat, the trees, the title bar or the palette.
		await vscode.commands.executeCommand('comonad.openChat');
	});
	registerCommand(ctx, 'comonad.forkSession', () => {
		const session = ctx.sessions.fork();
		void vscode.window.showInformationMessage(`Comonad: forked into "${session.title}".`);
	});
	registerCommand(ctx, 'comonad.renameSession', async (id) => {
		if (typeof id !== 'string') {
			return;
		}
		const session = ctx.sessions.get(id);
		if (!session) {
			return;
		}
		const title = await vscode.window.showInputBox({ prompt: 'Session title', value: session.title, ignoreFocusOut: true });
		if (title === undefined) {
			return;
		}
		session.title = title.trim() || session.title;
		ctx.sessions.save(session);
		ctx.sessions.changed(id);
	});
	registerCommand(ctx, 'comonad.deleteSession', async (id) => {
		if (typeof id !== 'string') {
			return;
		}
		const session = ctx.sessions.get(id);
		if (!session) {
			return;
		}
		const confirmed = await vscode.window.showWarningMessage(`Delete session "${session.title}"? This cannot be undone.`, { modal: true }, 'Delete');
		if (confirmed !== 'Delete') {
			return;
		}
		ctx.sessions.remove(id);
	});
}
sessionsView.inject = ['sessions', 'agent'];

export type { Session };
