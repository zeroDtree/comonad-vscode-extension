import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { describe } from '../lib/util';
import type { DiffFile } from '../services/checkpoints';
import { registerCommand } from './register';

/** Diff review: keep/undo files or hunks, revert to checkpoints, rewind, export. */

async function pending(ctx: Context): Promise<{ sessionId: string; workspace: string; files: DiffFile[] } | undefined> {
	const session = ctx.sessions.active();
	if (!session?.policy.workingDirectory) {
		return undefined;
	}
	const diff = await ctx.checkpoints.diff(session.policy.workingDirectory, session.id);
	return { sessionId: session.id, workspace: session.policy.workingDirectory, files: diff.files };
}

async function openDiff(ctx: Context, workspace: string, sessionId: string, file: DiffFile): Promise<void> {
	const before = await ctx.checkpoints.indexContent(workspace, sessionId, file.path);
	const dir = join(ctx.host.storage.tmp, 'review');
	mkdirSync(dir, { recursive: true });
	const beforePath = join(dir, `before-${file.path.replace(/[/\\]/g, '_')}`);
	writeFileSync(beforePath, before ?? '');
	await vscode.commands.executeCommand(
		'vscode.diff',
		vscode.Uri.file(beforePath),
		vscode.Uri.file(join(workspace, file.path)),
		`${file.path} (comonad)`,
		{ preview: true },
	);
}

async function reviewChanges(ctx: Context): Promise<void> {
	const state = await pending(ctx);
	if (!state) {
		void vscode.window.showInformationMessage('Comonad: no session with a working directory.');
		return;
	}
	if (state.files.length === 0) {
		void vscode.window.showInformationMessage('Comonad: no pending changes.');
		return;
	}
	const picked = await vscode.window.showQuickPick(
		state.files.map((file) => ({
			label: file.path,
			description: `+${file.additions} −${file.deletions}${file.untracked ? ' (new)' : ''}`,
			file,
		})),
		{ title: 'Comonad pending changes', ignoreFocusOut: true },
	);
	if (!picked) {
		return;
	}
	const actions = [
		{ label: 'Open diff', action: 'diff' },
		{ label: 'Keep file (accept into the checkpoint index)', action: 'keep' },
		{ label: 'Undo file (restore from the index)', action: 'undo' },
		...(picked.file.hunks.length > 1
			? [
					{ label: 'Keep one hunk…', action: 'keep-hunk' },
					{ label: 'Undo one hunk…', action: 'undo-hunk' },
				]
			: []),
	];
	const action = await vscode.window.showQuickPick(actions, { title: picked.label, ignoreFocusOut: true });
	if (!action) {
		return;
	}
	try {
		if (action.action === 'diff') {
			await openDiff(ctx, state.workspace, state.sessionId, picked.file);
		} else if (action.action === 'keep') {
			await ctx.checkpoints.keep(state.workspace, state.sessionId, picked.file.path);
		} else if (action.action === 'undo') {
			await ctx.checkpoints.undo(state.workspace, state.sessionId, picked.file.path);
		} else {
			const hunk = await vscode.window.showQuickPick(
				picked.file.hunks.map((item, index) => ({
					label: `Hunk ${index + 1}: ${item.header}`,
					description: `${item.lines.length} lines`,
					index,
				})),
				{ title: picked.label, ignoreFocusOut: true },
			);
			if (!hunk) {
				return;
			}
			if (action.action === 'keep-hunk') {
				await ctx.checkpoints.keep(state.workspace, state.sessionId, picked.file.path, hunk.index);
			} else {
				await ctx.checkpoints.undo(state.workspace, state.sessionId, picked.file.path, hunk.index);
			}
		}
	} catch (error) {
		void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
	}
}

async function keepOrUndoAll(ctx: Context, keep: boolean): Promise<void> {
	const state = await pending(ctx);
	if (!state || state.files.length === 0) {
		void vscode.window.showInformationMessage('Comonad: no pending changes.');
		return;
	}
	for (const file of state.files) {
		const action = keep ? ctx.checkpoints.keep(state.workspace, state.sessionId, file.path) : ctx.checkpoints.undo(state.workspace, state.sessionId, file.path);
		await action.catch((error) => ctx.log.message(`${keep ? 'keep' : 'undo'} failed: ${describe(error)}`));
	}
}

async function revertFiles(ctx: Context): Promise<void> {
	const session = ctx.sessions.active();
	if (!session?.policy.workingDirectory || session.marks.length === 0) {
		void vscode.window.showInformationMessage('Comonad: nothing to revert yet.');
		return;
	}
	const picked = await vscode.window.showQuickPick(
		[...session.marks].reverse().map((mark) => ({
			label: `${new Date(mark.at).toLocaleTimeString()} · ${mark.text}`,
			description: `turn ${mark.turn}`,
			mark,
		})),
		{ title: 'Revert files to a checkpoint', ignoreFocusOut: true },
	);
	if (!picked) {
		return;
	}
	try {
		await ctx.checkpoints.revert(session.policy.workingDirectory, session.id, picked.mark.checkpointId);
		void vscode.window.showInformationMessage('Comonad: files restored to the checkpoint.');
	} catch (error) {
		void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
	}
}

async function rewind(ctx: Context): Promise<void> {
	const session = ctx.sessions.active();
	if (!session || session.marks.length === 0) {
		void vscode.window.showInformationMessage('Comonad: nothing to rewind yet.');
		return;
	}
	const picked = await vscode.window.showQuickPick(
		[...session.marks].reverse().map((mark) => ({
			label: `${new Date(mark.at).toLocaleTimeString()} · ${mark.text}`,
			description: `turn ${mark.turn} · ${mark.length} messages`,
			mark,
		})),
		{ title: 'Rewind conversation and files', ignoreFocusOut: true },
	);
	if (!picked) {
		return;
	}
	const confirmed = await vscode.window.showWarningMessage(
		`Rewind to "${picked.mark.text}"? Files and the conversation after that point are discarded.`,
		{ modal: true },
		'Rewind',
	);
	if (confirmed !== 'Rewind') {
		return;
	}
	try {
		if (session.policy.workingDirectory) {
			await ctx.checkpoints.revert(session.policy.workingDirectory, session.id, picked.mark.checkpointId);
		}
		ctx.sessions.truncate(session.id, picked.mark.length, picked.mark.at);
		void vscode.window.showInformationMessage(`Comonad: rewound to turn ${picked.mark.turn}.`);
	} catch (error) {
		void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
	}
}

async function exportSession(ctx: Context): Promise<void> {
	const session = ctx.sessions.active();
	if (!session) {
		void vscode.window.showInformationMessage('Comonad: no session to export.');
		return;
	}
	const lines = [`# ${session.title}`, '', `- session: ${session.id}`, `- created: ${new Date(session.createdAt).toISOString()}`, ''];
	for (const message of session.transcript) {
		if (message.role === 'tool') {
			lines.push('<details><summary>tool result</summary>', '', '```', message.content.slice(0, 4_000), '```', '', '</details>', '');
			continue;
		}
		lines.push(`## ${message.role}`, '', message.content, '');
	}
	const target = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(join(ctx.settings.workspace() || ctx.host.storage.root, `${session.id.slice(0, 8)}-session.md`)),
		filters: { Markdown: ['md'] },
	});
	if (!target) {
		return;
	}
	await vscode.workspace.fs.writeFile(target, Buffer.from(lines.join('\n'), 'utf8'));
	void vscode.window.showInformationMessage(`Comonad: exported to ${target.fsPath}`);
}

export function review(ctx: Context): void {
	registerCommand(ctx, 'comonad.review', () => reviewChanges(ctx));
	registerCommand(ctx, 'comonad.keepAll', () => keepOrUndoAll(ctx, true));
	registerCommand(ctx, 'comonad.undoAll', () => keepOrUndoAll(ctx, false));
	registerCommand(ctx, 'comonad.revertFiles', () => revertFiles(ctx));
	registerCommand(ctx, 'comonad.rewind', () => rewind(ctx));
	registerCommand(ctx, 'comonad.exportSession', () => exportSession(ctx));
}
review.inject = ['sessions', 'checkpoints', 'settings', 'host', 'log'];
