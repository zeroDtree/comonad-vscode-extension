// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { describe } from '../lib/util';
import { registerCommand } from './register';
import type { JournalFile } from '../lib/journal';
import { DirtyEditorError } from '../lib/journal';
import { SHELL_NOTE, explainDirty, journalPending, undoPaths, unsavedPaths } from './journal-actions';

/**
 * Review of what the agent wrote: keep or undo files. Only the files the journal names are looked at.
 * Shell commands are not journaled, and the review says so.
 *
 * This is the journal's own surface and it travels with the journal: with the row off the commands are
 * not registered at all, and the manifest's `enablement` keeps them out of the palette. Blocks can
 * also be kept and undone in the editor itself — see `inline-diff.ts`.
 */

async function openDiff(ctx: Context, workspace: string, sessionId: string, file: JournalFile): Promise<void> {
	const before = await ctx.checkpoints.baselineContent(workspace, sessionId, file.path);
	const dir = join(ctx.host.storage.tmp, 'review');
	mkdirSync(dir, { recursive: true });
	const beforePath = join(dir, `before-${file.path.replace(/[/\\]/g, '_')}`);
	writeFileSync(beforePath, before ?? '');
	// One column with red/green blocks, as the review reads in the editor; not two panes to compare.
	await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(beforePath), vscode.Uri.file(join(workspace, file.path)), `${file.path} (comonad)`, {
		preview: true,
		renderSideBySide: false,
	});
}

async function reviewChanges(ctx: Context): Promise<void> {
	const state = await journalPending(ctx);
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
		{ label: 'Undo the remaining changes (back to the accepted baseline)', action: 'undo' },
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

async function keepOrUndoAll(ctx: Context, keep: boolean): Promise<void> {
	const state = await journalPending(ctx);
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

export function review(ctx: Context): void {
	registerCommand(ctx, 'comonad.review', () => reviewChanges(ctx));
	registerCommand(ctx, 'comonad.keepAll', () => keepOrUndoAll(ctx, true));
	registerCommand(ctx, 'comonad.undoAll', () => keepOrUndoAll(ctx, false));
}
review.inject = ['sessions', 'checkpoints', 'host', 'log'];
