import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { describe } from '@comonad/lib/util';
import { registerCommand } from '@comonad/ui/register';
import type { JournalFile, Overwrite } from './services/journal';
import { ChangedOutsideError, DirtyEditorError } from './services/journal';

/**
 * Review of what the agent wrote: keep or undo files and hunks, rewind to a turn. Only the files the
 * journal names are looked at. Shell commands are not journaled, and the review says so.
 *
 * This is the journal's own surface and it travels with the journal: with the row out of the tree the
 * commands are not registered at all, and the manifest's `enablement` keeps them out of the palette.
 */

const SHELL_NOTE = 'Changes made by shell commands are not tracked here — review them with git.';

/** The editor's unsaved documents, by workspace-relative path. */
function unsavedPaths(workspace: string): (path: string) => boolean {
	const open = new Set(
		vscode.workspace.textDocuments
			.filter((document) => document.isDirty && document.uri.scheme === 'file')
			.map((document) => document.uri.fsPath),
	);
	return (path) => open.has(join(workspace, path));
}

async function pending(ctx: Context): Promise<{ sessionId: string; workspace: string; files: JournalFile[] } | undefined> {
	const session = ctx.sessions.active();
	if (!session?.policy.workingDirectory) {
		return undefined;
	}
	const workspace = session.policy.workingDirectory;
	const result = await ctx.checkpoints.pending(workspace, session.id, unsavedPaths(workspace));
	return { sessionId: session.id, workspace, files: result.files };
}

async function openDiff(ctx: Context, workspace: string, sessionId: string, file: JournalFile): Promise<void> {
	const before = await ctx.checkpoints.baselineContent(workspace, sessionId, file.path);
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

/**
 * Asks what to do about files changed outside the agent. Returns the overwrite policy, or `undefined`
 * when the user cancelled. One answer can cover every file, or each file can be decided on its own.
 */
async function decideOutside(paths: string[]): Promise<Overwrite | undefined> {
	const answer = await vscode.window.showWarningMessage(
		`${paths.length === 1 ? 'This file was' : `${paths.length} files were`} changed outside the agent since it last wrote ${paths.length === 1 ? 'it' : 'them'}. Restoring will discard those changes.`,
		{ modal: true },
		'Restore all',
		'Choose per file',
	);
	if (answer === 'Restore all') {
		return 'all';
	}
	if (answer !== 'Choose per file') {
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		paths.map((path) => ({ label: path, picked: false })),
		{ title: 'Restore which changed files?', canPickMany: true, ignoreFocusOut: true },
	);
	// Choosing nothing is a cancel: an empty list would only repeat the same refusal.
	return picked && picked.length > 0 ? picked.map((item) => item.label) : undefined;
}

function explainDirty(error: DirtyEditorError): void {
	void vscode.window.showWarningMessage(`Comonad: ${error.message}. Nothing was changed.`);
}

async function reviewChanges(ctx: Context): Promise<void> {
	const state = await pending(ctx);
	if (!state) {
		void vscode.window.showInformationMessage('Comonad: no session with a working directory.');
		return;
	}
	if (state.files.length === 0) {
		void vscode.window.showInformationMessage(`Comonad: no pending changes. ${SHELL_NOTE}`);
		return;
	}
	const picked = await vscode.window.showQuickPick(
		state.files.map((file) => ({
			label: file.path,
			description: `+${file.additions} −${file.deletions}${file.created ? ' (new)' : ''}${file.deleted ? ' (deleted)' : ''}`,
			detail: [file.changedOutside ? 'changed outside the agent' : '', file.dirty ? 'unsaved in editor' : ''].filter(Boolean).join(' · ') || undefined,
			file,
		})),
		{ title: `Comonad pending changes — ${SHELL_NOTE}`, ignoreFocusOut: true },
	);
	if (!picked) {
		return;
	}
	const actions = [
		{ label: 'Open diff', action: 'diff' },
		{ label: 'Keep file (accept as is)', action: 'keep' },
		{ label: 'Undo file (restore what it was before the agent)', action: 'undo' },
	];
	const action = await vscode.window.showQuickPick(actions, { title: picked.label, ignoreFocusOut: true });
	if (!action) {
		return;
	}
	try {
		if (action.action === 'diff') {
			await openDiff(ctx, state.workspace, state.sessionId, picked.file);
		} else if (action.action === 'keep') {
			await ctx.checkpoints.keep(state.workspace, state.sessionId, [picked.file.path]);
		} else {
			await undoPaths(ctx, state.workspace, state.sessionId, [picked.file.path], unsavedPaths(state.workspace));
		}
	} catch (error) {
		if (error instanceof DirtyEditorError) {
			explainDirty(error);
			return;
		}
		void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
	}
}

/** Undo with the checks the journal makes: refuse unsaved text, then ask about outside changes. */
async function undoPaths(ctx: Context, workspace: string, sessionId: string, paths: string[], isDirty: (path: string) => boolean): Promise<void> {
	try {
		await ctx.checkpoints.undo(workspace, sessionId, paths, { isDirty });
		void vscode.window.showInformationMessage(`Comonad: restored ${paths.length} file(s).`);
	} catch (error) {
		if (!(error instanceof ChangedOutsideError)) {
			throw error;
		}
		const overwrite = await decideOutside(error.paths);
		if (overwrite === undefined) {
			return;
		}
		await ctx.checkpoints.undo(workspace, sessionId, paths, { isDirty, overwrite });
		void vscode.window.showInformationMessage(`Comonad: restored ${paths.length} file(s).`);
	}
}

async function keepOrUndoAll(ctx: Context, keep: boolean): Promise<void> {
	const state = await pending(ctx);
	if (!state || state.files.length === 0) {
		void vscode.window.showInformationMessage(`Comonad: no pending changes. ${SHELL_NOTE}`);
		return;
	}
	const paths = state.files.map((file) => file.path);
	try {
		if (keep) {
			await ctx.checkpoints.keep(state.workspace, state.sessionId, paths);
		} else {
			await undoPaths(ctx, state.workspace, state.sessionId, paths, unsavedPaths(state.workspace));
		}
	} catch (error) {
		if (error instanceof DirtyEditorError) {
			explainDirty(error);
			return;
		}
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
			description: `turn ${mark.turn}`,
			mark,
		})),
		{ title: `Rewind conversation and files — ${SHELL_NOTE}`, ignoreFocusOut: true },
	);
	if (!picked) {
		return;
	}
	const confirmed = await vscode.window.showWarningMessage(
		`Rewind to "${picked.mark.text}"? Files written after that point go back to what they were, and the conversation after it is discarded.`,
		{ modal: true },
		'Rewind',
	);
	if (confirmed !== 'Rewind') {
		return;
	}
	const workspace = session.policy.workingDirectory;
	try {
		if (workspace) {
			await revertTo(ctx, workspace, session.id, picked.mark.entryCount, unsavedPaths(workspace));
		}
		ctx.sessions.truncate(session.id, picked.mark.length, picked.mark.at);
		void vscode.window.showInformationMessage(`Comonad: rewound to turn ${picked.mark.turn}.`);
	} catch (error) {
		if (error instanceof DirtyEditorError) {
			explainDirty(error);
			return;
		}
		void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
	}
}

/** Rewinds files, asking once about files changed outside the agent. Nothing is written before the answer. */
async function revertTo(ctx: Context, workspace: string, sessionId: string, entryCount: number, isDirty: (path: string) => boolean): Promise<void> {
	try {
		await ctx.checkpoints.revert(workspace, sessionId, { entryCount }, { isDirty });
	} catch (error) {
		if (!(error instanceof ChangedOutsideError)) {
			throw error;
		}
		const overwrite = await decideOutside(error.paths);
		if (overwrite === undefined) {
			return;
		}
		const skip = overwrite === 'all' ? [] : error.paths.filter((path) => !overwrite.includes(path));
		await ctx.checkpoints.revert(workspace, sessionId, { entryCount }, { isDirty, overwrite, skip });
	}
}

export function review(ctx: Context): void {
	registerCommand(ctx, 'comonad.review', () => reviewChanges(ctx));
	registerCommand(ctx, 'comonad.keepAll', () => keepOrUndoAll(ctx, true));
	registerCommand(ctx, 'comonad.undoAll', () => keepOrUndoAll(ctx, false));
	registerCommand(ctx, 'comonad.rewind', () => rewind(ctx));
}
review.inject = ['sessions', 'checkpoints', 'host', 'log'];
