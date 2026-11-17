// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { describe } from '../lib/util';
import type { FileChange } from '../lib/journal';
import { ChangedOutsideError, DirtyEditorError } from '../lib/journal';
import { fileReviewIdle, fileReviewState } from '../lib/file-review-model';
import type { FileReviewHostMessage, FileReviewState } from '../lib/file-review-protocol';
import { findHunk } from '../lib/review-model';
import { isInside } from '../lib/sandbox';
import { keepHunkAction, undoHunkAction } from './hunk-actions';
import { explainDirty, journalPending, journalScope, SHELL_NOTE, undoPaths, unsavedPaths, type JournalScope } from './journal-actions';
import { registerCommand } from './register';

/**
 * The File Review tab: the changed file drawn whole in a webview editor, with deleted lines as real
 * red rows that wrap and scroll like the rest of the file — the review Cursor shows inside the
 * editor, which VS Code's decoration API cannot draw (inline text cannot contain or wrap lines).
 *
 * It is the same journal as the Review tab, the chat's pending list and the editor's inline review:
 * the guest names a block by `hunkKey`, the host looks it up in a fresh `change()` and runs the same
 * Keep/Undo actions, and `checkpoints/changed` brings the new state back. The guest never names a
 * path and never sees a hunk object. The file itself stays the place to edit; this tab is read-only
 * and offers a button to open it.
 */

const PANEL_ID = 'comonad.fileReview';
const REFRESH_MS = 150;
/**
 * Both texts travel to the guest as one message; past this many characters the tab defers to the
 * native diff instead of copying a file that cannot be read at a glance anyway.
 */
const MAX_TEXT = 4_000_000;

/** A URI written into an HTML attribute; webview URIs can contain characters that would close it. */
function escapeAttribute(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll("'", '&#39;');
}

export function fileReviewDocument(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = randomBytes(16).toString('base64');
	const uri = (file: string): string => String(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', file)));
	const script = uri('file-review.js');
	const style = uri('file-review.css');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${escapeAttribute(style)}" />
</head>
<body>
<header id="fr-top">
	<span id="fr-path"></span>
	<span id="fr-badges"></span>
	<span class="fr-spacer"></span>
	<span id="fr-actions">
		<button id="fr-open" type="button">Open in Editor</button>
		<button id="fr-diff" type="button">Open Diff</button>
		<button id="fr-undo" type="button">Undo File</button>
		<button id="fr-keep" type="button">Keep File</button>
	</span>
</header>
<main id="fr-main">
	<div id="fr-empty" hidden></div>
	<div id="fr-editor"></div>
</main>
<div id="fr-notice" role="status" aria-live="polite" hidden></div>
<script nonce="${nonce}" src="${escapeAttribute(script)}"></script>
</body>
</html>`;
}

/** The workspace-relative path of a file URI, with forward slashes; `undefined` when outside. */
function relativeOf(workspace: string, fsPath: string): string | undefined {
	const path = relative(workspace, fsPath);
	if (!path || path.startsWith('..') || isAbsolute(path)) {
		return undefined;
	}
	return path.split(sep).join('/');
}

/** A guest- or command-supplied path, accepted only as a relative path inside the workspace. */
function relativePath(raw: unknown): string | undefined {
	if (typeof raw !== 'string' || !raw || isAbsolute(raw) || raw.split('/').includes('..')) {
		return undefined;
	}
	return raw;
}

export function fileReviewPanel(ctx: Context): void {
	const extensionUri = ctx.host.extensionUri as vscode.Uri | undefined;
	let panel: vscode.WebviewPanel | null = null;
	/** The file the tab shows; kept across a close so reopening returns to it. */
	let path: string | null = null;
	let view: FileReviewState | null = null;
	let generation = 0;
	let timer: NodeJS.Timeout | undefined;
	/** A review action is writing the journal: a read now would see the state it is replacing. */
	let mutating = 0;
	let queue: Promise<void> = Promise.resolve();

	const post = (message: FileReviewHostMessage): void => {
		if (panel) {
			void panel.webview.postMessage(message);
		}
	};

	const notify = (level: 'info' | 'warn' | 'error', text: string): void => post({ type: 'notice', level, text });

	function actionError(error: unknown): void {
		if (error instanceof DirtyEditorError || error instanceof ChangedOutsideError) {
			notify('warn', `${error.message}. Nothing was changed.`);
			return;
		}
		ctx.log.message(`file review: ${describe(error)}`);
		notify('error', describe(error));
	}

	function title(): string {
		return path ? `${basename(path)} (Comonad)` : 'Comonad · File Review';
	}

	function push(): void {
		if (!panel || !view) {
			return;
		}
		panel.title = title();
		void panel.webview.postMessage({ type: 'state', state: view } satisfies FileReviewHostMessage);
	}

	function schedule(): void {
		if (!panel) {
			return;
		}
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void refreshNow();
		}, REFRESH_MS);
	}

	/** Rebuilds the tab from the journal: the file's flags first, then its two texts and blocks. */
	async function refreshNow(): Promise<void> {
		if (!panel) {
			return;
		}
		clearTimeout(timer);
		timer = undefined;
		if (mutating > 0) {
			schedule();
			return;
		}
		const run = ++generation;
		const scope = journalScope(ctx);
		const wanted = path;
		if (!scope || !wanted) {
			view = fileReviewIdle(wanted ?? '', 'no-pending', 'Open a Comonad chat to review the files it writes.');
			push();
			return;
		}
		let pending: Awaited<ReturnType<typeof ctx.checkpoints.pending>>;
		try {
			pending = await ctx.checkpoints.pending(scope.workspace, scope.sessionId, unsavedPaths(scope.workspace), { diff: false });
		} catch (error) {
			if (run !== generation || !panel) {
				return;
			}
			ctx.log.message(`file review: ${describe(error)}`);
			view = fileReviewIdle(wanted, 'error', `${describe(error)} ${SHELL_NOTE}`);
			push();
			return;
		}
		if (run !== generation || !panel) {
			return;
		}
		const summary = pending.files.find((file) => file.path === wanted);
		if (!summary) {
			view = fileReviewIdle(wanted, 'no-pending', 'No pending changes for this file.');
			push();
			return;
		}
		let change: FileChange;
		try {
			change = await ctx.checkpoints.change(scope.workspace, scope.sessionId, wanted);
		} catch (error) {
			if (run !== generation || !panel) {
				return;
			}
			view = fileReviewIdle(wanted, 'error', describe(error));
			push();
			return;
		}
		if (run !== generation || !panel) {
			return;
		}
		if (change.baseline.length + change.current.length > MAX_TEXT) {
			view = fileReviewIdle(wanted, 'too-large', `${wanted} is too large to draw here. Open Diff shows it in the editor's diff view.`);
			push();
			return;
		}
		view = fileReviewState(change, summary.dirty || unsavedPaths(scope.workspace)(wanted));
		push();
	}

	function mutate(run: () => Promise<void>): Promise<void> {
		mutating += 1;
		return run()
			.catch((error) => actionError(error))
			.finally(() => {
				mutating = Math.max(0, mutating - 1);
				void refreshNow();
			});
	}

	function scopePath(): { scope: JournalScope; path: string } | undefined {
		const scope = journalScope(ctx);
		return scope && path ? { scope, path } : undefined;
	}

	async function keepHunk(key: string): Promise<void> {
		const target = scopePath();
		if (!target) {
			return;
		}
		if (unsavedPaths(target.scope.workspace)(target.path)) {
			notify('warn', `${target.path} has unsaved changes. Save it first.`);
			return;
		}
		let change: FileChange;
		try {
			change = await ctx.checkpoints.change(target.scope.workspace, target.scope.sessionId, target.path);
		} catch {
			notify('info', 'This change moved — the review has been refreshed.');
			return;
		}
		const hunk = findHunk(change, key);
		if (!hunk) {
			notify('info', 'This change moved — the review has been refreshed.');
			return;
		}
		if (change.changedOutside) {
			notify('warn', `${target.path} changed outside the agent; block actions are disabled. Use Undo File to restore the baseline.`);
			return;
		}
		if (change.binary || change.truncated) {
			notify('warn', `${target.path} cannot be reviewed block by block.`);
			return;
		}
		await keepHunkAction(ctx, target.scope, target.path, hunk);
	}

	async function undoHunk(key: string): Promise<void> {
		const target = scopePath();
		if (!target) {
			return;
		}
		const outcome = await undoHunkAction(ctx, target.scope, target.path, key);
		if (outcome.kind === 'dirty') {
			notify('warn', `${target.path} has unsaved changes. Save it first.`);
		} else if (outcome.kind === 'stale') {
			notify('info', 'This change moved — the review has been refreshed.');
		} else if (outcome.kind === 'outside') {
			notify('warn', `${target.path} changed outside the agent; use Undo File to restore the accepted baseline.`);
		}
	}

	async function keepFile(): Promise<void> {
		const target = scopePath();
		if (!target) {
			return;
		}
		if (unsavedPaths(target.scope.workspace)(target.path)) {
			notify('warn', `${target.path} has unsaved changes. Save it first.`);
			return;
		}
		await ctx.checkpoints.keep(target.scope.workspace, target.scope.sessionId, [target.path]);
	}

	async function undoFile(): Promise<void> {
		const target = scopePath();
		if (!target) {
			return;
		}
		try {
			await undoPaths(ctx, target.scope.workspace, target.scope.sessionId, [target.path], unsavedPaths(target.scope.workspace), { quiet: true });
		} catch (error) {
			if (error instanceof DirtyEditorError) {
				notify('warn', `${error.message}. Nothing was changed.`);
				return;
			}
			throw error;
		}
	}

	async function openFile(): Promise<void> {
		const target = scopePath();
		if (!target) {
			return;
		}
		const file = resolve(target.scope.workspace, target.path);
		if (!isInside(target.scope.workspace, file) || !existsSync(file)) {
			notify('warn', `${target.path} is no longer on disk.`);
			return;
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
		await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
	}

	async function openDiff(): Promise<void> {
		const target = scopePath();
		if (!target) {
			return;
		}
		const file = resolve(target.scope.workspace, target.path);
		if (!isInside(target.scope.workspace, file) || !existsSync(file)) {
			notify('warn', `${target.path} is no longer on disk.`);
			return;
		}
		await vscode.commands.executeCommand('comonad.openChangeDiff', vscode.Uri.file(file));
	}

	async function handle(message: Record<string, unknown>): Promise<void> {
		try {
			switch (String(message.type)) {
				case 'ready':
					await refreshNow();
					return;
				case 'keepHunk':
					if (typeof message.hunk === 'string' && message.hunk) {
						await mutate(() => keepHunk(message.hunk as string));
					}
					return;
				case 'undoHunk':
					if (typeof message.hunk === 'string' && message.hunk) {
						await mutate(() => undoHunk(message.hunk as string));
					}
					return;
				case 'keepFile':
					await mutate(() => keepFile());
					return;
				case 'undoFile':
					await mutate(() => undoFile());
					return;
				case 'openFile':
					await openFile();
					return;
				case 'openDiff':
					await openDiff();
					return;
			}
		} catch (error) {
			actionError(error);
		}
	}

	function attach(created: vscode.WebviewPanel): void {
		if (!extensionUri) {
			created.dispose();
			return;
		}
		panel = created;
		created.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
		};
		created.webview.html = fileReviewDocument(created.webview, extensionUri);
		created.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
			queue = queue.then(
				() => handle(message),
				() => handle(message),
			);
		});
		created.onDidChangeViewState(() => {
			if (created.visible) {
				void refreshNow();
			}
		});
		created.onDidDispose(() => {
			if (panel === created) {
				panel = null;
				view = null;
			}
		});
	}

	/** The file to review: the named one, the active editor's, or a pick from what is pending. */
	async function choose(requested: unknown): Promise<string | undefined> {
		// A named file opens whether or not a chat is active: the tab itself says there is no session
		// to review against, which is more useful than refusing the click.
		const named = relativePath(requested);
		if (named) {
			return named;
		}
		const scope = journalScope(ctx);
		if (!scope) {
			void vscode.window.showInformationMessage('Comonad: open a chat with a working directory first.');
			return undefined;
		}
		const editor = vscode.window.activeTextEditor;
		if (editor?.document.uri.scheme === 'file') {
			const active = relativeOf(scope.workspace, editor.document.uri.fsPath);
			if (active) {
				return active;
			}
		}
		const pending = await journalPending(ctx);
		const files = pending?.files ?? [];
		if (!files.length) {
			void vscode.window.showInformationMessage('Comonad: no pending changes.');
			return undefined;
		}
		const picked = await vscode.window.showQuickPick(
			files.map((file) => ({ label: file.path, description: `+${file.additions} −${file.deletions}` })),
			{ title: 'Review which file?', placeHolder: 'A file the agent changed', ignoreFocusOut: true },
		);
		return picked?.label;
	}

	async function open(requested?: unknown): Promise<void> {
		const next = await choose(requested);
		if (!next) {
			return;
		}
		path = next;
		if (panel) {
			panel.reveal();
			await refreshNow();
			return;
		}
		if (!extensionUri) {
			void vscode.window.showErrorMessage('Comonad: the extension resources are unavailable.');
			return;
		}
		const created = vscode.window.createWebviewPanel(PANEL_ID, title(), vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
		});
		created.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'comonad.svg');
		attach(created);
		// The guest asks for state once its listener is installed; posting before that is dropped.
	}

	registerCommand(ctx, 'comonad.reviewFile', (requested?: unknown) => open(requested));

	ctx.on('checkpoints/changed', schedule);
	ctx.on('sessions/changed', schedule);
	ctx.on('settings/changed', schedule);

	ctx.effect(() => {
		const subscriptions = [
			// A save is a new disk state, not a burst: read it now instead of waiting out the debounce.
			vscode.workspace.onDidSaveTextDocument(() => void refreshNow()),
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (event.document.uri.scheme === 'file') {
					schedule();
				}
			}),
			vscode.workspace.onDidCloseTextDocument(() => schedule()),
		];
		return () => {
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			clearTimeout(timer);
		};
	});

	ctx.effect(() => {
		if (!extensionUri) {
			return () => undefined;
		}
		const disposable = vscode.window.registerWebviewPanelSerializer(PANEL_ID, {
			deserializeWebviewPanel: async (restored: vscode.WebviewPanel, state: unknown) => {
				const saved = (state as { path?: unknown } | undefined)?.path;
				if (typeof saved === 'string' && relativePath(saved)) {
					path = saved;
				}
				if (panel && panel !== restored) {
					restored.dispose();
					return;
				}
				attach(restored);
			},
		});
		return () => disposable.dispose();
	});

	ctx.effect(() => () => {
		panel?.dispose();
		panel = null;
		view = null;
	});
}
fileReviewPanel.inject = ['sessions', 'checkpoints', 'host', 'log'];
