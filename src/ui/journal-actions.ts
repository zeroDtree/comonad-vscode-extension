import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import type { JournalApi, JournalFile, Overwrite } from '../lib/journal';
import { ChangedOutsideError, DirtyEditorError } from '../lib/journal';

/**
 * The review actions the journal's surfaces share: what is pending, the unsaved-editor check, the
 * outside-changes question, undo with its refusals, and restoring to a turn's restore point. `review`,
 * the inline diff and the chat panel's prompt edit all use the same journal, so they ask the same
 * questions in the same words.
 */

export const SHELL_NOTE = 'Changes made by shell commands are not tracked here — review them with git.';

/** The editor's unsaved documents, by workspace-relative path. */
export function unsavedPaths(workspace: string): (path: string) => boolean {
	const open = new Set(
		vscode.workspace.textDocuments
			.filter((document) => document.isDirty && document.uri.scheme === 'file')
			.map((document) => document.uri.fsPath),
	);
	return (path) => open.has(join(workspace, path));
}

/** What the active chat has pending, with the workspace it belongs to. */
export async function journalPending(ctx: Context): Promise<{ sessionId: string; workspace: string; files: JournalFile[] } | undefined> {
	const session = ctx.sessions.active();
	if (!session?.policy.workingDirectory) {
		return undefined;
	}
	const workspace = session.policy.workingDirectory;
	const result = await ctx.checkpoints.pending(workspace, session.id, unsavedPaths(workspace));
	return { sessionId: session.id, workspace, files: result.files };
}

/**
 * Asks what to do about files changed outside the agent. Returns the overwrite policy, or `undefined`
 * when the user cancelled. One answer can cover every file, or each file can be decided on its own.
 */
export async function decideOutside(paths: string[]): Promise<Overwrite | undefined> {
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

export function explainDirty(error: DirtyEditorError): void {
	void vscode.window.showWarningMessage(`Comonad: ${error.message}. Nothing was changed.`);
}

/**
 * Restores files to a journal position, asking once about files changed outside the agent. Nothing is
 * written before the answer, and `false` means the user cancelled — nothing was restored, so the
 * caller must not go on either.
 */
export async function restoreTo(
	journal: JournalApi,
	workspace: string,
	sessionId: string,
	mark: { entryCount: number; at?: number },
	isDirty: (path: string) => boolean,
): Promise<boolean> {
	try {
		await journal.revert(workspace, sessionId, mark, { isDirty });
		return true;
	} catch (error) {
		if (!(error instanceof ChangedOutsideError)) {
			throw error;
		}
		const overwrite = await decideOutside(error.paths);
		if (overwrite === undefined) {
			return false;
		}
		const skip = overwrite === 'all' ? [] : error.paths.filter((path) => !overwrite.includes(path));
		await journal.revert(workspace, sessionId, mark, { isDirty, overwrite, skip });
		return true;
	}
}

/** Undo with the checks the journal makes: refuse unsaved text, then ask about outside changes. */
export async function undoPaths(ctx: Context, workspace: string, sessionId: string, paths: string[], isDirty: (path: string) => boolean): Promise<void> {
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
		// The retry restores the files nothing outside touched, plus the conflicted ones the user
		// chose — undo refuses a conflicted file it is not allowed to overwrite, so an unpicked one
		// must be left out of the request entirely.
		const chosen = overwrite === 'all' ? error.paths : overwrite;
		const wanted = paths.filter((path) => chosen.includes(path) || !error.paths.includes(path));
		await ctx.checkpoints.undo(workspace, sessionId, wanted, { isDirty, overwrite });
		void vscode.window.showInformationMessage(`Comonad: restored ${wanted.length} file(s).`);
	}
}
