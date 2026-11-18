// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { describe } from '../lib/util';
import type { FileChange } from '../lib/journal';
import { ChangedOutsideError, DirtyEditorError } from '../lib/journal';
import { fileSummary, findHunk, reviewState } from '../lib/review-model';
import type { ReviewHostMessage, ReviewState } from '../lib/review-protocol';
import { isInside } from '../lib/sandbox';
import { keepHunkAction, undoHunkAction } from './hunk-actions';
import { explainDirty, journalPending, journalScope, SHELL_NOTE, undoPaths, unsavedPaths, type JournalScope } from './journal-actions';
import { registerCommand } from './register';

/**
 * The Review tab: one editor surface for everything the journal has pending. The file list is the
 * listing; the main pane is the accepted baseline against the file on disk, block by block. Every
 * action goes through the same journal the File Review tab and the chat's pending list use, and
 * every change comes back as `checkpoints/changed`, so all three surfaces stay one story.
 *
 * The guest never sees a hunk object: it names a block by `hunkKey` and the host looks it up in a
 * fresh `change()`. A stale key is a refresh, not an overwrite.
 */

const PANEL_ID = 'comonad.review';
const TITLE = 'Comonad · Review Changes';
const REFRESH_MS = 150;
const DIRTY_MS = 200;

/** A URI written into an HTML attribute; webview URIs can contain characters that would close it. */
function escapeAttribute(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll("'", '&#39;');
}

export function reviewDocument(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = randomBytes(16).toString('base64');
	const uri = (file: string): string => String(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', file)));
	const script = uri('review.js');
	const style = uri('review.css');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${escapeAttribute(style)}" />
</head>
<body>
<header id="rv-top">
	<div id="rv-summary"></div>
	<div id="rv-actions">
		<button id="rv-files-toggle" type="button" class="rv-ghost" aria-pressed="true" title="Show or hide the file list">Files</button>
		<button id="rv-wrap" type="button" class="rv-ghost" aria-pressed="false" title="Wrap long lines">Wrap</button>
		<button id="rv-undo-all" type="button" class="rv-ghost">Undo All</button>
		<button id="rv-keep-all" type="button" class="rv-primary">Keep All</button>
	</div>
</header>
<div id="rv-body">
	<nav id="rv-files" aria-label="Pending files">
		<div id="rv-files-head">
			<span id="rv-files-title">Files</span>
			<span id="rv-files-count"></span>
		</div>
		<div id="rv-file-list"></div>
		<div id="rv-note"></div>
	</nav>
	<main id="rv-main">
		<div id="rv-file-head" hidden>
			<button id="rv-prev" type="button" class="rv-ghost" title="Previous file">‹</button>
			<button id="rv-next" type="button" class="rv-ghost" title="Next file">›</button>
			<button id="rv-path" type="button" class="rv-link"></button>
			<span id="rv-badges"></span>
			<span class="rv-spacer"></span>
			<button id="rv-open-diff" type="button" class="rv-ghost" hidden>Open Diff</button>
			<button id="rv-undo-file" type="button" class="rv-ghost">Undo File</button>
			<button id="rv-keep-file" type="button" class="rv-primary">Keep File</button>
		</div>
		<div id="rv-empty" hidden></div>
		<div id="rv-hunks"></div>
	</main>
</div>
<div id="rv-notice" role="status" aria-live="polite" hidden></div>
<script nonce="${nonce}" src="${escapeAttribute(script)}"></script>
</body>
</html>`;
}

export function reviewPanel(ctx: Context): void {
	const extensionUri = ctx.host.extensionUri as vscode.Uri | undefined;
	let panel: vscode.WebviewPanel | null = null;
	/** The file the reader last chose; kept across a close so reopening returns to it. */
	let selectedPath: string | null = null;
	let model: ReviewState | null = null;
	let scopeKey = '';
	let generation = 0;
	let timer: NodeJS.Timeout | undefined;
	let dirtyTimer: NodeJS.Timeout | undefined;
	let lastDirty = '';
	/** A review action is writing the journal: a read now would see the state it is replacing. */
	let mutating = 0;
	let queue: Promise<void> = Promise.resolve();

	const modelScope = (): JournalScope | undefined =>
		model?.sessionId && model.workspace ? { sessionId: model.sessionId, workspace: model.workspace } : undefined;

	const post = (message: ReviewHostMessage): void => {
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
		ctx.log.message(`review: ${describe(error)}`);
		notify('error', describe(error));
	}

	function push(): void {
		if (!panel || !model) {
			return;
		}
		panel.title = model.totals.files ? `${TITLE} (${model.totals.files})` : TITLE;
		// The state carries the same flags a dirty message would; remember them so an unchanged
		// keystroke burst does not send a second, identical message.
		lastDirty = model.files.filter((file) => file.dirty).map((file) => file.path).join('\n');
		void panel.webview.postMessage({ type: 'state', state: model });
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

	/**
	 * Rebuilds the listing and the selected file from the journal. The listing carries the counts and
	 * flags; only the selected file pays for a line diff.
	 */
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
		let pending: Awaited<ReturnType<typeof journalPending>>;
		try {
			pending = await journalPending(ctx);
		} catch (error) {
			ctx.log.message(`review: ${describe(error)}`);
			if (run !== generation || !panel) {
				return;
			}
			model = reviewState({
				sessionId: scope?.sessionId ?? null,
				workspace: scope?.workspace ?? null,
				available: false,
				files: [],
				activePath: null,
				active: null,
				error: describe(error),
				note: SHELL_NOTE,
			});
			push();
			return;
		}
		if (run !== generation || !panel) {
			return;
		}
		if (!pending) {
			scopeKey = '';
			selectedPath = null;
			model = reviewState({ sessionId: null, workspace: null, available: false, files: [], activePath: null, active: null, note: SHELL_NOTE });
			push();
			return;
		}
		const key = `${pending.sessionId}\u0000${pending.workspace}`;
		if (key !== scopeKey) {
			scopeKey = key;
			selectedPath = null;
		}
		const files = pending.files.map(fileSummary);
		const activePath = selectedPath && files.some((file) => file.path === selectedPath) ? selectedPath : (files[0]?.path ?? null);
		selectedPath = activePath;
		let active: FileChange | null = null;
		let activeError: string | null = null;
		if (activePath) {
			try {
				active = await ctx.checkpoints.change(pending.workspace, pending.sessionId, activePath);
			} catch (error) {
				activeError = describe(error);
			}
		}
		if (run !== generation || !panel) {
			return;
		}
		model = reviewState({
			sessionId: pending.sessionId,
			workspace: pending.workspace,
			available: pending.available,
			files,
			activePath,
			active,
			activeError,
			note: SHELL_NOTE,
		});
		push();
	}

	function postDirty(): void {
		const scope = modelScope();
		if (!scope || !panel || !model) {
			return;
		}
		const dirty = unsavedPaths(scope.workspace);
		const paths = model.files.filter((file) => dirty(file.path)).map((file) => file.path);
		const key = paths.join('\n');
		if (key === lastDirty) {
			return;
		}
		lastDirty = key;
		void panel.webview.postMessage({ type: 'dirty', paths });
	}

	function scheduleDirty(): void {
		clearTimeout(dirtyTimer);
		dirtyTimer = setTimeout(() => {
			dirtyTimer = undefined;
			postDirty();
		}, DIRTY_MS);
	}

	async function mutate(run: () => Promise<void>): Promise<void> {
		mutating += 1;
		try {
			await run();
		} catch (error) {
			actionError(error);
		} finally {
			mutating = Math.max(0, mutating - 1);
		}
		await refreshNow();
	}

	/** A path the listing just named; nothing else may reach the journal from the guest. */
	function pendingPath(raw: unknown): string | undefined {
		if (typeof raw !== 'string' || !raw || isAbsolute(raw) || raw.split('/').includes('..')) {
			return undefined;
		}
		return model?.files.some((file) => file.path === raw) ? raw : undefined;
	}

	async function keepHunk(path: string, key: string): Promise<void> {
		const scope = modelScope();
		if (!scope) {
			return;
		}
		if (unsavedPaths(scope.workspace)(path)) {
			notify('warn', `${path} has unsaved changes. Save it first.`);
			return;
		}
		let change: FileChange;
		try {
			change = await ctx.checkpoints.change(scope.workspace, scope.sessionId, path);
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
			notify('warn', `${path} changed outside the agent; block actions are disabled. Use Undo File to restore the baseline.`);
			return;
		}
		if (change.binary || change.truncated) {
			notify('warn', `${path} cannot be reviewed block by block.`);
			return;
		}
		await keepHunkAction(ctx, scope, path, hunk);
	}

	async function undoHunk(path: string, key: string): Promise<void> {
		const scope = modelScope();
		if (!scope) {
			return;
		}
		const outcome = await undoHunkAction(ctx, scope, path, key);
		if (outcome.kind === 'dirty') {
			notify('warn', `${path} has unsaved changes. Save it first.`);
		} else if (outcome.kind === 'stale') {
			notify('info', 'This change moved — the review has been refreshed.');
		} else if (outcome.kind === 'outside') {
			notify('warn', `${path} changed outside the agent; use Undo File to restore the accepted baseline.`);
		}
	}

	async function keepFile(path: string): Promise<void> {
		const scope = modelScope();
		if (!scope) {
			return;
		}
		if (unsavedPaths(scope.workspace)(path)) {
			notify('warn', `${path} has unsaved changes. Save it first.`);
			return;
		}
		await ctx.checkpoints.keep(scope.workspace, scope.sessionId, [path]);
	}

	async function undoFile(path: string): Promise<void> {
		const scope = modelScope();
		if (!scope) {
			return;
		}
		try {
			await undoPaths(ctx, scope.workspace, scope.sessionId, [path], unsavedPaths(scope.workspace), { quiet: true });
		} catch (error) {
			if (error instanceof DirtyEditorError) {
				notify('warn', `${error.message}. Nothing was changed.`);
				return;
			}
			throw error;
		}
	}

	async function keepAll(): Promise<void> {
		const scope = modelScope();
		if (!scope) {
			return;
		}
		// The listing in the webview can be a moment old; the journal is the authority on what is
		// pending and on which editors have unsaved text.
		const pending = await ctx.checkpoints.pending(scope.workspace, scope.sessionId, unsavedPaths(scope.workspace), { diff: false });
		if (!pending.files.length) {
			notify('info', 'No pending changes.');
			return;
		}
		const dirty = pending.files.filter((file) => file.dirty).map((file) => file.path);
		if (dirty.length) {
			notify('warn', `Save these files first: ${dirty.join(', ')}. Nothing was changed.`);
			return;
		}
		await ctx.checkpoints.keep(scope.workspace, scope.sessionId, pending.files.map((file) => file.path));
	}

	async function undoAll(): Promise<void> {
		const scope = modelScope();
		if (!scope) {
			return;
		}
		const pending = await ctx.checkpoints.pending(scope.workspace, scope.sessionId, unsavedPaths(scope.workspace), { diff: false });
		if (!pending.files.length) {
			notify('info', 'No pending changes.');
			return;
		}
		try {
			await undoPaths(ctx, scope.workspace, scope.sessionId, pending.files.map((file) => file.path), unsavedPaths(scope.workspace), { quiet: true });
		} catch (error) {
			if (error instanceof DirtyEditorError) {
				notify('warn', `${error.message}. Nothing was changed.`);
				return;
			}
			throw error;
		}
	}

	async function openFile(path: string, line: unknown): Promise<void> {
		const scope = modelScope();
		if (!scope) {
			return;
		}
		const target = resolve(scope.workspace, path);
		if (!isInside(scope.workspace, target) || !existsSync(target)) {
			notify('warn', `${path} is no longer on disk.`);
			return;
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
		const editor = await vscode.window.showTextDocument(document, { preview: true, viewColumn: panel?.viewColumn ?? vscode.ViewColumn.Active });
		const wanted = Number(line);
		if (Number.isFinite(wanted)) {
			const index = Math.max(0, Math.min(document.lineCount - 1, Math.floor(wanted) - 1));
			const range = new vscode.Range(index, 0, index, document.lineAt(index).text.length);
			editor.selection = new vscode.Selection(range.start, range.end);
			editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}
	}

	async function openDiff(path: string): Promise<void> {
		const scope = modelScope();
		if (!scope) {
			return;
		}
		const target = resolve(scope.workspace, path);
		if (!isInside(scope.workspace, target) || !existsSync(target)) {
			notify('warn', `${path} is no longer on disk.`);
			return;
		}
		await vscode.commands.executeCommand('comonad.openChangeDiff', vscode.Uri.file(target), panel?.viewColumn ?? vscode.ViewColumn.Active);
	}

	async function handle(message: Record<string, unknown>): Promise<void> {
		try {
			switch (String(message.type)) {
				case 'ready':
					lastDirty = '';
					await refreshNow();
					return;
				case 'selectFile': {
					const path = pendingPath(message.path);
					if (path && path !== selectedPath) {
						selectedPath = path;
						await refreshNow();
					}
					return;
				}
				case 'openFile': {
					const path = pendingPath(message.path);
					if (path) {
						await openFile(path, message.line);
					}
					return;
				}
				case 'openDiff': {
					const path = pendingPath(message.path);
					if (path) {
						await openDiff(path);
					}
					return;
				}
				case 'keepHunk': {
					const path = pendingPath(message.path);
					if (path && typeof message.hunk === 'string' && message.hunk) {
						await mutate(() => keepHunk(path, message.hunk as string));
					}
					return;
				}
				case 'undoHunk': {
					const path = pendingPath(message.path);
					if (path && typeof message.hunk === 'string' && message.hunk) {
						await mutate(() => undoHunk(path, message.hunk as string));
					}
					return;
				}
				case 'keepFile': {
					const path = pendingPath(message.path);
					if (path) {
						await mutate(() => keepFile(path));
					}
					return;
				}
				case 'undoFile': {
					const path = pendingPath(message.path);
					if (path) {
						await mutate(() => undoFile(path));
					}
					return;
				}
				case 'keepAll':
					await mutate(() => keepAll());
					return;
				case 'undoAll':
					await mutate(() => undoAll());
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
		created.webview.html = reviewDocument(created.webview, extensionUri);
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
			}
		});
	}

	function open(): void {
		if (panel) {
			panel.reveal();
			void refreshNow();
			return;
		}
		if (!extensionUri) {
			void vscode.window.showErrorMessage('Comonad: the extension resources are unavailable.');
			return;
		}
		const created = vscode.window.createWebviewPanel(PANEL_ID, TITLE, vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
		});
		created.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'comonad.svg');
		attach(created);
		// The guest asks for state once its listener is installed; posting before that is dropped.
	}

	async function keepAllCommand(): Promise<void> {
		const scope = journalScope(ctx);
		if (!scope) {
			void vscode.window.showInformationMessage('Comonad: no session with a working directory.');
			return;
		}
		const pending = await ctx.checkpoints.pending(scope.workspace, scope.sessionId, unsavedPaths(scope.workspace), { diff: false });
		if (!pending.files.length) {
			void vscode.window.showInformationMessage(`Comonad: no pending changes. ${SHELL_NOTE}`);
			return;
		}
		const dirty = pending.files.filter((file) => file.dirty).map((file) => file.path);
		if (dirty.length) {
			void vscode.window.showWarningMessage(`Comonad: save these files first: ${dirty.join(', ')}. Nothing was changed.`);
			return;
		}
		await ctx.checkpoints.keep(scope.workspace, scope.sessionId, pending.files.map((file) => file.path));
	}

	async function undoAllCommand(): Promise<void> {
		const scope = journalScope(ctx);
		if (!scope) {
			void vscode.window.showInformationMessage('Comonad: no session with a working directory.');
			return;
		}
		const pending = await ctx.checkpoints.pending(scope.workspace, scope.sessionId, unsavedPaths(scope.workspace), { diff: false });
		if (!pending.files.length) {
			void vscode.window.showInformationMessage(`Comonad: no pending changes. ${SHELL_NOTE}`);
			return;
		}
		try {
			await undoPaths(ctx, scope.workspace, scope.sessionId, pending.files.map((file) => file.path), unsavedPaths(scope.workspace));
		} catch (error) {
			if (error instanceof DirtyEditorError) {
				explainDirty(error);
				return;
			}
			throw error;
		}
	}

	registerCommand(ctx, 'comonad.review', () => open());
	registerCommand(ctx, 'comonad.keepAll', () => keepAllCommand());
	registerCommand(ctx, 'comonad.undoAll', () => undoAllCommand());

	ctx.on('checkpoints/changed', schedule);
	ctx.on('sessions/changed', schedule);
	ctx.on('settings/changed', schedule);

	ctx.effect(() => {
		const subscriptions = [
			// A save is a new disk state, not a burst: read it now instead of waiting out the debounce
			// that coalesces journal events.
			vscode.workspace.onDidSaveTextDocument(() => void refreshNow()),
			vscode.workspace.onDidChangeTextDocument(() => scheduleDirty()),
			vscode.workspace.onDidCloseTextDocument(() => scheduleDirty()),
		];
		return () => {
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			clearTimeout(timer);
			clearTimeout(dirtyTimer);
		};
	});

	ctx.effect(() => {
		if (!extensionUri) {
			return () => undefined;
		}
		const disposable = vscode.window.registerWebviewPanelSerializer(PANEL_ID, {
			deserializeWebviewPanel: async (restored: vscode.WebviewPanel) => {
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
	});
}
reviewPanel.inject = ['sessions', 'checkpoints', 'host', 'log'];
