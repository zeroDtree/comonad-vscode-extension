import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { registerCommand } from './register';

/** Tree of background shell tasks started by the agent. */

export function tasksView(ctx: Context): void {
	const emitter = new vscode.EventEmitter<void>();
	const provider: vscode.TreeDataProvider<vscode.TreeItem> = {
		onDidChangeTreeData: emitter.event,
		getTreeItem: (element) => element,
		getChildren: () =>
			ctx.tasks.list().map((task) => {
				const running = task.exitCode === null;
				const icon = running ? 'sync~spin' : task.exitCode === 0 ? 'check' : 'error';
				const item = new vscode.TreeItem(task.command, vscode.TreeItemCollapsibleState.None);
				item.id = task.id;
				item.contextValue = 'comonad.task';
				item.iconPath = new vscode.ThemeIcon(icon);
				item.description = running ? 'running' : `exit ${task.exitCode}`;
				item.tooltip = `${task.command}\ncwd: ${task.cwd}\nstarted: ${new Date(task.startedAt).toLocaleTimeString()}`;
				item.command = { command: 'comonad.readTaskOutput', title: 'Show output', arguments: [task.id] };
				return item;
			}),
	};
	const tree = vscode.window.createTreeView('comonad.tasks', { treeDataProvider: provider });
	ctx.effect(() => () => {
		tree.dispose();
		emitter.dispose();
	});
	ctx.on('tasks/changed', () => emitter.fire());

	registerCommand(ctx, 'comonad.readTaskOutput', async (id) => {
		if (typeof id !== 'string') {
			return;
		}
		const document = await vscode.workspace.openTextDocument({ content: ctx.tasks.read(id, 400), language: 'log' });
		await vscode.window.showTextDocument(document, { preview: true });
	});
	registerCommand(ctx, 'comonad.stopTask', (id) => {
		if (typeof id === 'string' && ctx.tasks.stop(id)) {
			void vscode.window.showInformationMessage(`Comonad: stopping task ${id}.`);
		}
	});
}
tasksView.inject = ['tasks'];
