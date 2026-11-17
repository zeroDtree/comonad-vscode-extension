// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import type { FileChange } from '../lib/journal';
import { DirtyEditorError } from '../lib/journal';
import { editForHunk, revertHunk, type LineHunk } from '../lib/line-diff';
import { findHunk } from '../lib/review-model';
import type { JournalScope } from './journal-actions';
import { unsavedPaths } from './journal-actions';

/**
 * The block-level review actions the editor's inline review and the Review tab share.
 *
 * Keep advances the accepted baseline by one block and writes nothing to disk; undo puts the block
 * back in the file, saves it, and amends the journal so the review's own edit does not read as a
 * change from outside the agent. Both surfaces speak the same hunk identity (`hunkKey`) and the same
 * refusals, so a click means the same thing wherever it was made.
 */

/** Accepts one block into the baseline. A dirty editor or an outside edit refuses inside the journal. */
export async function keepHunkAction(ctx: Context, scope: JournalScope, path: string, hunk: LineHunk): Promise<void> {
	await ctx.checkpoints.keepHunk(scope.workspace, scope.sessionId, path, hunk, {
		isDirty: unsavedPaths(scope.workspace),
	});
}

export type UndoHunkOutcome =
	| { kind: 'done'; change: FileChange; text: string }
	| { kind: 'stale' }
	| { kind: 'dirty'; error: DirtyEditorError }
	| { kind: 'outside' };

/**
 * Reverts one block in the file on disk. The change is re-read here, not taken from a caller's cache:
 * a block can be accepted in another surface at any moment, and the key must be checked against the
 * journal as it is now. The document is left alone when it has unsaved text or when the file changed
 * outside the agent — those files are the journal's to ask about, not this edit's to overwrite.
 */
export async function undoHunkAction(ctx: Context, scope: JournalScope, path: string, key: string): Promise<UndoHunkOutcome> {
	const uri = vscode.Uri.file(join(scope.workspace, path));
	const document = await vscode.workspace.openTextDocument(uri);
	if (document.isDirty) {
		return { kind: 'dirty', error: new DirtyEditorError([path]) };
	}
	let change: FileChange;
	try {
		change = await ctx.checkpoints.change(scope.workspace, scope.sessionId, path);
	} catch {
		// The journal moved under the click: the next refresh shows the file as it is now.
		return { kind: 'stale' };
	}
	const located = findHunk(change, key);
	if (!located) {
		return { kind: 'stale' };
	}
	if (change.changedOutside) {
		return { kind: 'outside' };
	}
	if (change.binary || change.truncated) {
		return { kind: 'stale' };
	}
	// `editForHunk` trusts the hunk's new side; the document is the authority on whether that side is
	// still there. A mismatch is a stale block, never an overwrite.
	try {
		revertHunk(document.getText(), located);
	} catch {
		return { kind: 'stale' };
	}
	const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	const edit = editForHunk(document.getText(), eol, located);
	if (edit.start === edit.end && !edit.text) {
		return { kind: 'stale' };
	}
	const workspaceEdit = new vscode.WorkspaceEdit();
	workspaceEdit.replace(uri, new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
	if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
		throw new Error('the editor refused the change');
	}
	const text = document.getText();
	if (!(await document.save())) {
		throw new Error('the file could not be saved');
	}
	// The review made this edit itself: it must not read as a change from outside the agent.
	await ctx.checkpoints.amend(scope.workspace, scope.sessionId, path);
	return { kind: 'done', change, text };
}
