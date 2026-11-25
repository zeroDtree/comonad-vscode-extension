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
import type { FileReviewChange, FileReviewHostMessage, FileReviewState } from '../lib/file-review-protocol';
import { findHunk } from '../lib/review-model';
import { isInside } from '../lib/sandbox';
import { keepHunkAction, undoHunkAction } from './hunk-actions';
import { explainDirty, journalPending, journalScope, SHELL_NOTE, undoPaths, unsavedPaths, type JournalScope } from './journal-actions';
import { registerCommand } from './register';

/**
 * The File Review editor: the changed file drawn whole in a webview, with changed lines tinted and
 * deleted lines as real red rows that wrap like the rest of the file — text VS Code's decoration
 * API cannot draw, since inline decoration text cannot contain or wrap lines.
 *
 * It is a **custom text editor**, not a webview panel: the `TextDocument` is the buffer, so the tab
 * gets VS Code's native dirty dot, Cmd/Ctrl+S, close prompt, hot exit and encoding/EOL handling,
 * and `document.isDirty` feeds every existing review guard through `unsavedPaths()`. The guest
 * sends line/character edits, the host applies them with a `WorkspaceEdit`, and both sides compare
 * the removed text before touching the document — a stale edit is a refresh, never an overwrite.
 *
 * Saving is an ordinary save. Nothing is amended: a save whose bytes differ from the journal's last
 * recorded write surfaces as `changedOutside`, exactly as editing in a normal editor would. Block
 * actions stay available against that diff — Keep advances the baseline, Undo refuses unless the
 * buffer still holds the disk text the block was computed from — while **Undo File** asks before
 * restoring, since an outside edit is never folded into the journal silently.
 */

export const FILE_REVIEW_VIEW_TYPE = 'comonad.fileReview';
const REFRESH_MS = 150;
/**
 * A document longer than this is not shipped to the webview: CodeMirror would hold the whole string
 * and the review could not draw a diff anyway. **Open in Editor** edits it in VS Code's own editor.
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

/** A command argument, accepted only as a relative path inside the workspace. */
function relativePath(raw: unknown): string | undefined {
	if (typeof raw !== 'string' || !raw || isAbsolute(raw) || raw.split('/').includes('..')) {
		return undefined;
	}
	return raw;
}

const normalizeEol = (text: string): string => text.replace(/\r\n?/g, '\n');

export type ApplyResult = 'ok' | 'stale' | 'rejected';

function positionOf(document: vscode.TextDocument, line: number, ch: number): vscode.Position | undefined {
	if (!Number.isInteger(line) || line < 0 || line >= document.lineCount) {
		return undefined;
	}
	const text = document.lineAt(line).text;
	if (!Number.isInteger(ch) || ch < 0 || ch > text.length) {
		return undefined;
	}
	return new vscode.Position(line, ch);
}

/**
 * Applies one guest batch to the document. Every range is checked against the text it claims to
 * replace before anything is written: the batch is pre-edit coordinates, so a mismatch means the
 * document moved under the editor and the batch must be dropped rather than applied at the wrong
 * place. Exported so the pipeline is testable without a webview.
 */
export async function applyFileReviewChanges(document: vscode.TextDocument, changes: readonly FileReviewChange[]): Promise<ApplyResult> {
	if (document.uri.scheme !== 'file') {
		return 'rejected';
	}
	if (!changes.length) {
		return 'ok';
	}
	const edit = new vscode.WorkspaceEdit();
	for (const change of changes) {
		const from = positionOf(document, change.fromLine, change.fromCh);
		const to = positionOf(document, change.toLine, change.toCh);
		if (!from || !to || from.isAfter(to)) {
			return 'stale';
		}
		const range = new vscode.Range(from, to);
		if (normalizeEol(document.getText(range)) !== normalizeEol(change.removed)) {
			return 'stale';
		}
		edit.replace(document.uri, range, change.text);
	}
	return (await vscode.workspace.applyEdit(edit)) ? 'ok' : 'rejected';
}

/** Reads a guest edit batch defensively; anything malformed is ignored. */
function readChanges(raw: unknown): FileReviewChange[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const changes: FileReviewChange[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') {
			return undefined;
		}
		const change = item as Record<string, unknown>;
		const positions = [change.fromLine, change.fromCh, change.toLine, change.toCh];
		if (!positions.every((value) => typeof value === 'number' && Number.isInteger(value) && value >= 0)) {
			return undefined;
		}
		if (typeof change.removed !== 'string' || typeof change.text !== 'string') {
			return undefined;
		}
		changes.push({
			fromLine: change.fromLine as number,
			fromCh: change.fromCh as number,
			toLine: change.toLine as number,
			toCh: change.toCh as number,
			removed: change.removed as string,
			text: change.text as string,
		});
	}
	return changes;
}

/** One open custom editor: its document, its webview, and the journal refresh around them. */
export class FileReviewEditor {
	private readonly subscriptions: vscode.Disposable[] = [];
	private queue: Promise<void> = Promise.resolve();
	private readonly panel: vscode.WebviewPanel;
	private readonly document: vscode.TextDocument;
	private readonly ctx: Context;
	private state: FileReviewState | null = null;
	private ready = false;
	private visible = false;
	private disposed = false;
	private onDisposeHandler: (() => void) | undefined;
	private timer: NodeJS.Timeout | undefined;
	private generation = 0;
	private mutating = 0;
	/** How many guest edits are being applied; their document events are echoes, not news. */
	private applying = 0;
	private lastDirty = false;
	/** The text the guest is known to hold, so a reveal only resyncs when something actually moved. */
	private guestText = '';
	/** A hidden webview cannot receive messages; the document is sent on the first reveal. */
	private documentSent = false;
	private lastDiskText: string | undefined;

	constructor(ctx: Context, extensionUri: vscode.Uri, document: vscode.TextDocument, panel: vscode.WebviewPanel) {
		this.ctx = ctx;
		this.document = document;
		this.panel = panel;
		this.visible = panel.visible;
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
		};
		panel.webview.html = fileReviewDocument(panel.webview, extensionUri);
		this.subscriptions.push(
			panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
				const run = (): Promise<void> => this.handle(message);
				this.queue = this.queue.then(run, run);
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (event.document === this.document) {
					this.documentChanged();
				}
			}),
			vscode.workspace.onDidSaveTextDocument((saved) => {
				if (saved === this.document) {
					this.saved();
				}
			}),
			panel.onDidChangeViewState(() => this.viewStateChanged()),
			panel.onDidDispose(() => this.dispose()),
		);
	}

	onDispose(handler: () => void): void {
		this.onDisposeHandler = handler;
	}

	/** Re-reads the journal; the provider calls this for every open editor on tree events. */
	schedule(): void {
		if (this.disposed) {
			return;
		}
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.refresh();
		}, REFRESH_MS);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		clearTimeout(this.timer);
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.onDisposeHandler?.();
	}

	private post(message: FileReviewHostMessage): boolean {
		if (!this.ready || this.disposed || !this.panel.visible) {
			return false;
		}
		void this.panel.webview.postMessage(message);
		return true;
	}

	private notify(level: 'info' | 'warn' | 'error', text: string): void {
		this.post({ type: 'notice', level, text });
	}

	private actionError(error: unknown): void {
		if (error instanceof DirtyEditorError || error instanceof ChangedOutsideError) {
			this.notify('warn', `${error.message}. Nothing was changed.`);
			return;
		}
		this.ctx.log.message(`file review: ${describe(error)}`);
		this.notify('error', describe(error));
	}

	private displayPath(): string {
		const scope = journalScope(this.ctx);
		return (scope && relativeOf(scope.workspace, this.document.uri.fsPath)) || basename(this.document.uri.fsPath);
	}

	private scopePath(): { scope: JournalScope; path: string } | undefined {
		const scope = journalScope(this.ctx);
		const path = scope ? relativeOf(scope.workspace, this.document.uri.fsPath) : undefined;
		return scope && path ? { scope, path } : undefined;
	}

	private postDirty(force = false): void {
		const dirty = this.document.isDirty;
		if (!force && dirty === this.lastDirty) {
			return;
		}
		this.lastDirty = dirty;
		this.post({ type: 'dirty', dirty });
	}

	private push(state: FileReviewState): void {
		this.state = state;
		this.post({ type: 'state', state });
		this.ensureDocument(state);
	}

	/**
	 * Hands the guest its buffer once. Binary content and documents too large to draw never travel;
	 * the tab shows the reason, and **Open in Editor** edits them in VS Code's own editor.
	 */
	private ensureDocument(state: FileReviewState): void {
		if (this.documentSent || !this.ready || this.disposed || state.reason === 'binary') {
			return;
		}
		const text = this.document.getText();
		if (text.length > MAX_TEXT) {
			return;
		}
		if (this.post({ type: 'document', text, languageId: this.document.languageId, tabSize: this.tabSize() })) {
			this.guestText = text;
			this.documentSent = true;
		}
	}

	/** The editor is live only after the guest's listener exists; the handshake is its `ready`. */
	private async start(): Promise<void> {
		if (this.ready || this.disposed) {
			return;
		}
		this.ready = true;
		await this.refresh();
		this.postDirty(true);
	}

	private tabSize(): number {
		return vscode.workspace.getConfiguration('editor', this.document.uri).get<number>('tabSize') ?? 4;
	}

	private async refresh(): Promise<FileReviewState> {
		const fallback = this.state ?? fileReviewIdle(this.displayPath(), 'no-pending', 'Reading the change…');
		if (this.disposed) {
			return fallback;
		}
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.mutating > 0) {
			this.schedule();
			return fallback;
		}
		const run = ++this.generation;
		const path = this.displayPath();
		if (this.document.getText().length > MAX_TEXT) {
			const state = fileReviewIdle(path, 'too-large', `${path} is too large to draw here. Open in Editor edits it in the editor.`);
			this.push(state);
			return state;
		}
		const target = this.scopePath();
		if (!target) {
			const state = fileReviewIdle(
				path,
				'no-pending',
				journalScope(this.ctx) ? 'This file is outside the chat workspace; there is nothing to review.' : 'Open a Comonad chat to review the files it writes.',
			);
			this.push(state);
			return state;
		}
		let pending: Awaited<ReturnType<typeof this.ctx.checkpoints.pending>>;
		try {
			pending = await this.ctx.checkpoints.pending(target.scope.workspace, target.scope.sessionId, unsavedPaths(target.scope.workspace), {
				diff: false,
				// The user named this file; the review setting trims listings, not an explicit open.
				includeExcluded: true,
			});
		} catch (error) {
			if (run !== this.generation || this.disposed) {
				return this.state ?? fallback;
			}
			this.ctx.log.message(`file review: ${describe(error)}`);
			const state = fileReviewIdle(path, 'error', `${describe(error)} ${SHELL_NOTE}`);
			this.push(state);
			return state;
		}
		if (run !== this.generation || this.disposed) {
			return this.state ?? fallback;
		}
		const summary = pending.files.find((file) => file.path === target.path);
		if (!summary) {
			const state = fileReviewIdle(path, 'no-pending', 'No pending changes for this file.');
			this.push(state);
			return state;
		}
		let change: FileChange;
		try {
			change = await this.ctx.checkpoints.change(target.scope.workspace, target.scope.sessionId, target.path);
		} catch (error) {
			if (run !== this.generation || this.disposed) {
				return this.state ?? fallback;
			}
			const state = fileReviewIdle(path, 'error', describe(error));
			this.push(state);
			return state;
		}
		if (run !== this.generation || this.disposed) {
			return this.state ?? fallback;
		}
		this.noteDiskChange(change.current);
		const state = fileReviewState(change, this.document.isDirty);
		state.path = path;
		this.push(state);
		return state;
	}

	/**
	 * A file that changed on disk while the editor holds unsaved text is a conflict the user must
	 * see. The buffer is never replaced here: a save is last-writer-wins, exactly like a normal
	 * editor, and the journal reports the saved file as changed outside the agent afterwards.
	 */
	private noteDiskChange(disk: string): void {
		if (this.lastDiskText !== undefined && this.document.isDirty && disk !== this.lastDiskText) {
			this.notify('warn', 'The file changed on disk while you had unsaved edits. Saving will overwrite that change.');
		}
		this.lastDiskText = disk;
	}

	private viewStateChanged(): void {
		this.visible = this.panel.visible;
		if (!this.visible || !this.ready) {
			return;
		}
		// Messages sent to a hidden webview are dropped: a reveal resyncs the buffer if it moved, and
		// the refresh below sends a document that was never delivered, then the current state.
		const text = this.document.getText();
		if (this.documentSent && this.guestText !== text && this.post({ type: 'replace', text })) {
			this.guestText = text;
		}
		this.postDirty(true);
		void this.refresh();
	}

	private documentChanged(): void {
		if (this.disposed) {
			return;
		}
		const text = this.document.getText();
		// Our own edits are echoes: they were applied while `applying` was set, or the guest already
		// holds exactly this text. Anything else is another editor, a revert or a save participant.
		if (this.applying === 0 && this.documentSent && text !== this.guestText && this.post({ type: 'replace', text })) {
			this.guestText = text;
		}
		this.postDirty();
	}

	private saved(): void {
		if (this.disposed) {
			return;
		}
		this.guestText = this.document.getText();
		this.postDirty(true);
		// The save may have moved the file away from the agent's write; the journal says so now.
		void this.refresh();
	}

	private async apply(changes: readonly FileReviewChange[], length: unknown): Promise<void> {
		this.applying += 1;
		let result: ApplyResult = 'rejected';
		try {
			result = await applyFileReviewChanges(this.document, changes);
		} finally {
			this.applying = Math.max(0, this.applying - 1);
		}
		const text = this.document.getText();
		if (result !== 'ok' || (typeof length === 'number' && text.length !== length)) {
			this.notify('error', 'The file changed while you were editing; the last change was not applied.');
			// The guest buffer is ahead of the document; only claim it is in sync once the replace landed.
			if (this.post({ type: 'replace', text })) {
				this.guestText = text;
			}
		} else {
			this.guestText = text;
		}
		this.postDirty();
	}

	private async handle(message: Record<string, unknown>): Promise<void> {
		try {
			switch (String(message.type)) {
				case 'ready':
					await this.start();
					return;
				case 'edit': {
					const changes = readChanges(message.changes);
					if (changes) {
						await this.apply(changes, message.length);
					}
					return;
				}
				case 'save': {
					if (!(await this.document.save())) {
						this.notify('warn', 'The file could not be saved.');
					}
					return;
				}
				case 'keepHunk':
					if (typeof message.hunk === 'string' && message.hunk) {
						await this.mutate(() => this.keepHunk(message.hunk as string));
					}
					return;
				case 'undoHunk':
					if (typeof message.hunk === 'string' && message.hunk) {
						await this.mutate(() => this.undoHunk(message.hunk as string));
					}
					return;
				case 'keepFile':
					await this.mutate(() => this.keepFile());
					return;
				case 'undoFile':
					await this.mutate(() => this.undoFile());
					return;
				case 'openEditor':
					await vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default', {
						// Pinned: the review tab is a preview tab, and another preview would replace it.
						preview: false,
						viewColumn: this.panel.viewColumn ?? vscode.ViewColumn.Active,
					});
					return;
				case 'openDiff':
					await vscode.commands.executeCommand('comonad.openChangeDiff', this.document.uri, this.panel.viewColumn ?? vscode.ViewColumn.Active);
					return;
			}
		} catch (error) {
			this.actionError(error);
		}
	}

	private async mutate(run: () => Promise<void>): Promise<void> {
		this.mutating += 1;
		try {
			await run();
		} catch (error) {
			this.actionError(error);
		} finally {
			this.mutating = Math.max(0, this.mutating - 1);
		}
		await this.refresh();
	}

	private async keepHunk(key: string): Promise<void> {
		const target = this.scopePath();
		if (!target) {
			return;
		}
		if (unsavedPaths(target.scope.workspace)(target.path)) {
			this.notify('warn', `${target.path} has unsaved changes. Save it first.`);
			return;
		}
		let change: FileChange;
		try {
			change = await this.ctx.checkpoints.change(target.scope.workspace, target.scope.sessionId, target.path);
		} catch {
			this.notify('info', 'This change moved — the review has been refreshed.');
			return;
		}
		const hunk = findHunk(change, key);
		if (!hunk) {
			this.notify('info', 'This change moved — the review has been refreshed.');
			return;
		}
		if (change.binary || change.truncated) {
			this.notify('warn', `${target.path} cannot be reviewed block by block.`);
			return;
		}
		await keepHunkAction(this.ctx, target.scope, target.path, hunk);
	}

	private async undoHunk(key: string): Promise<void> {
		const target = this.scopePath();
		if (!target) {
			return;
		}
		const outcome = await undoHunkAction(this.ctx, target.scope, target.path, key);
		if (outcome.kind === 'dirty') {
			this.notify('warn', `${target.path} has unsaved changes. Save it first.`);
		} else if (outcome.kind === 'stale') {
			this.notify('info', 'This change moved — the review has been refreshed.');
		}
	}

	private async keepFile(): Promise<void> {
		const target = this.scopePath();
		if (!target) {
			return;
		}
		if (unsavedPaths(target.scope.workspace)(target.path)) {
			this.notify('warn', `${target.path} has unsaved changes. Save it first.`);
			return;
		}
		await this.ctx.checkpoints.keep(target.scope.workspace, target.scope.sessionId, [target.path]);
	}

	private async undoFile(): Promise<void> {
		const target = this.scopePath();
		if (!target) {
			return;
		}
		try {
			await undoPaths(this.ctx, target.scope.workspace, target.scope.sessionId, [target.path], unsavedPaths(target.scope.workspace), { quiet: true });
		} catch (error) {
			if (error instanceof DirtyEditorError) {
				this.notify('warn', `${error.message}. Nothing was changed.`);
				return;
			}
			throw error;
		}
	}
}

/** The file to review: the named one, the active editor's, or a pick from what is pending. */
async function choose(ctx: Context, requested: unknown): Promise<vscode.Uri | undefined> {
	if (requested instanceof vscode.Uri) {
		return requested;
	}
	const named = relativePath(requested);
	if (named) {
		const scope = journalScope(ctx);
		if (!scope) {
			void vscode.window.showInformationMessage('Comonad: open a chat with a working directory first.');
			return undefined;
		}
		return vscode.Uri.file(resolve(scope.workspace, named));
	}
	const active = vscode.window.activeTextEditor?.document.uri;
	if (active?.scheme === 'file') {
		return active;
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
	if (!picked) {
		return undefined;
	}
	const scope = journalScope(ctx);
	return scope ? vscode.Uri.file(resolve(scope.workspace, picked.label)) : undefined;
}

async function openFileReview(ctx: Context, requested?: unknown): Promise<void> {
	const uri = await choose(ctx, requested);
	if (!uri) {
		return;
	}
	if (!existsSync(uri.fsPath)) {
		// A deleted file has no document to edit; the native diff shows the baseline it came from.
		await vscode.commands.executeCommand('comonad.openChangeDiff', uri);
		return;
	}
	const scope = journalScope(ctx);
	const path = scope ? relativeOf(scope.workspace, uri.fsPath) : undefined;
	if (scope && path) {
		try {
			const change = await ctx.checkpoints.change(scope.workspace, scope.sessionId, path);
			if (change.binary) {
				await vscode.commands.executeCommand('comonad.openChangeDiff', uri);
				return;
			}
		} catch {
			// Not pending: the tab still opens, just without a diff.
		}
	}
	await vscode.commands.executeCommand('vscode.openWith', uri, FILE_REVIEW_VIEW_TYPE, {
		preview: true,
		viewColumn: vscode.ViewColumn.Active,
	});
}

class FileReviewProvider implements vscode.CustomTextEditorProvider {
	readonly editors = new Set<FileReviewEditor>();

	constructor(
		private readonly ctx: Context,
		private readonly extensionUri: vscode.Uri,
	) {}

	resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
		if (document.uri.scheme !== 'file') {
			return;
		}
		const editor = new FileReviewEditor(this.ctx, this.extensionUri, document, panel);
		this.editors.add(editor);
		editor.onDispose(() => this.editors.delete(editor));
	}

	refreshAll(): void {
		for (const editor of this.editors) {
			editor.schedule();
		}
	}
}

export function fileReviewEditor(ctx: Context): void {
	const extensionUri = ctx.host.extensionUri as vscode.Uri | undefined;
	if (!extensionUri) {
		return;
	}
	const provider = new FileReviewProvider(ctx, extensionUri);
	ctx.effect(() => {
		const registration = vscode.window.registerCustomEditorProvider(FILE_REVIEW_VIEW_TYPE, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		});
		return () => registration.dispose();
	});
	ctx.on('checkpoints/changed', () => provider.refreshAll());
	ctx.on('sessions/changed', () => provider.refreshAll());
	ctx.on('settings/changed', () => provider.refreshAll());
	registerCommand(ctx, 'comonad.reviewFile', (requested?: unknown) => openFileReview(ctx, requested));
	ctx.effect(() => () => {
		for (const editor of provider.editors) {
			editor.dispose();
		}
	});
}
fileReviewEditor.inject = ['sessions', 'checkpoints', 'host', 'log'];
