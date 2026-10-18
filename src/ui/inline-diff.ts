// SPDX-License-Identifier: AGPL-3.0-only
import { basename, isAbsolute, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { describe } from '../lib/util';
import type { FileChange } from '../lib/journal';
import { DirtyEditorError } from '../lib/journal';
import { applyHunk, diffLines, editForHunk, hunkKey, stripEol, type LineHunk } from '../lib/line-diff';
import { registerCommand } from './register';
import { explainDirty, undoPaths, unsavedPaths } from './journal-actions';

/**
 * The inline review of what the agent wrote: each changed block is painted in the editor, with
 * Keep/Undo above it, and the file itself has Keep File / Undo File / Show Diff at the top.
 *
 * There is no inline-diff API in VS Code, so this is the standard composition: a baseline document
 * served by a content provider, a line diff against it, editor decorations, and code lenses whose
 * commands act on one block. It travels with the journal row and disappears with it.
 */

const BASELINE_SCHEME = 'comonad-baseline';
/** More than this many blocks in one file: the rest are reached through Show Diff. */
const MAX_BLOCK_LENSES = 25;
const REFRESH_MS = 150;

/**
 * The colors the review paints with, not the theme's faint diff overlays: Cursor's review is a solid
 * green block for an addition and a red one for a removal, and a change has to be readable at a
 * glance. The fills are translucent so selection and syntax colors still read through them.
 */
const GREEN_FILL = 'rgba(46, 160, 67, 0.28)';
const GREEN_EDGE = 'rgba(46, 160, 67, 0.9)';
const RED_FILL = 'rgba(248, 81, 73, 0.24)';
const RED_WASH = 'rgba(248, 81, 73, 0.1)';
const RED_EDGE = 'rgba(248, 81, 73, 0.9)';

interface Scope {
	sessionId: string;
	workspace: string;
}

/** The active chat and the folder its journal is about, or `undefined` when there is neither. */
function scopeOf(ctx: Context): Scope | undefined {
	const session = ctx.sessions.active();
	const workspace = session?.policy.workingDirectory;
	return session && workspace ? { sessionId: session.id, workspace } : undefined;
}

/** A file's path relative to the workspace with forward slashes; `undefined` when it is outside. */
function relativeOf(workspace: string, uri: vscode.Uri, scheme = 'file'): string | undefined {
	if (uri.scheme !== scheme) {
		return undefined;
	}
	const path = relative(workspace, uri.fsPath);
	if (!path || path.startsWith('..') || isAbsolute(path)) {
		return undefined;
	}
	return path.split(sep).join('/');
}

function clampLine(document: vscode.TextDocument, line: number): number {
	return Math.max(0, Math.min(document.lineCount - 1, line));
}

/**
 * The line a block's lens sits above: the line just after the block, so the actions read as its own
 * footer — the bottom-right position Cursor's floating bar takes. A pure deletion anchors at the
 * line that followed the removed text.
 */
function lensLine(hunk: LineHunk, document: vscode.TextDocument): number {
	const line = hunk.newLines > 0 ? hunk.newStart - 1 + hunk.newLines : hunk.newStart;
	return clampLine(document, line);
}

/** A hover that lists the lines a block removes. */
function removedHover(lines: string[]): vscode.MarkdownString {
	const fence = lines.some((line) => line.includes('```')) ? '~~~~' : '```';
	return new vscode.MarkdownString(`${fence}diff\n${lines.join('\n')}\n${fence}`);
}

function clipped(text: string, length = 110): string {
	return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function inlineDiff(ctx: Context): void {
	let changes = new Map<string, FileChange>();
	let scopeKey = '';
	let generation = 0;
	let timer: NodeJS.Timeout | undefined;
	/** A review action is writing the journal: a refresh now would read the state it is replacing. */
	let mutating = 0;

	const enabled = (): boolean => ctx.settings.get().inlineDiff !== false;
	// The gutter bars travel with the extension, so a change is visible even in the overview rail.
	const extensionUri = ctx.host.extensionUri as vscode.Uri | undefined;
	const gutter = (file: string): vscode.Uri | undefined => (extensionUri ? vscode.Uri.joinPath(extensionUri, 'resources', file) : undefined);
	const addedIcon = gutter('diff-added.svg');
	const removedIcon = gutter('diff-removed.svg');
	const lensChanged = new vscode.EventEmitter<void>();
	const baselineChanged = new vscode.EventEmitter<vscode.Uri>();
	const baselines = new Map<string, vscode.Uri>();

	const added = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: GREEN_FILL,
		overviewRulerColor: GREEN_EDGE,
		overviewRulerLane: vscode.OverviewRulerLane.Left,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		...(addedIcon ? { gutterIconPath: addedIcon, gutterIconSize: 'contain' } : {}),
	});
	// A deleted block has no line of its own in an open document, so the line it sat on carries the
	// red wash and edge and the removed text rides on it as a red chip — the closest stable stand-in
	// for the solid red lines a diff editor draws.
	// No left border here: the chip is drawn at the line start, and the border ran through its first
	// character. The red fill and the gutter bar already say what happened.
	const removedAfter = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: RED_WASH,
		after: {
			color: new vscode.ThemeColor('editorError.foreground'),
			backgroundColor: RED_FILL,
			fontStyle: 'normal',
		},
		overviewRulerColor: RED_EDGE,
		overviewRulerLane: vscode.OverviewRulerLane.Left,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		...(removedIcon ? { gutterIconPath: removedIcon, gutterIconSize: 'contain' } : {}),
	});
	const removedBefore = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: RED_WASH,
		before: {
			color: new vscode.ThemeColor('editorError.foreground'),
			backgroundColor: RED_FILL,
			fontStyle: 'normal',
		},
		overviewRulerColor: RED_EDGE,
		overviewRulerLane: vscode.OverviewRulerLane.Left,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		...(removedIcon ? { gutterIconPath: removedIcon, gutterIconSize: 'contain' } : {}),
	});

	const provider = vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
		onDidChange: baselineChanged.event,
		provideTextDocumentContent: async (uri) => {
			const target = baselineTarget(uri);
			if (!target) {
				return '';
			}
			try {
				return (await ctx.checkpoints.baselineContent(target.workspace, target.sessionId, target.path)) ?? '';
			} catch {
				return '';
			}
		},
	});

	/** The file a baseline URI stands for: the accepted baseline of that path, as text. */
	function baselineTarget(uri: vscode.Uri): { workspace: string; sessionId: string; path: string } | undefined {
		try {
			const params = JSON.parse(decodeURIComponent(uri.query)) as { workspace?: unknown; sessionId?: unknown };
			if (typeof params.workspace !== 'string' || typeof params.sessionId !== 'string') {
				return undefined;
			}
			// The baseline document carries its own scheme; the path itself is the real file's.
		const path = relativeOf(params.workspace, uri, BASELINE_SCHEME);
			return path ? { workspace: params.workspace, sessionId: params.sessionId, path } : undefined;
		} catch {
			return undefined;
		}
	}

	function baselineUri(file: vscode.Uri, current: Scope): vscode.Uri {
		const uri = file.with({ scheme: BASELINE_SCHEME, query: encodeURIComponent(JSON.stringify(current)) });
		baselines.set(uri.toString(), uri);
		return uri;
	}

	function fireBaselines(): void {
		for (const uri of baselines.values()) {
			baselineChanged.fire(uri);
		}
	}

	function lensEmitterFire(): void {
		lensChanged.fire();
	}

	/** Applies the decorations of every visible editor from the cache. */
	function paint(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			const change = enabled() ? changes.get(editor.document.uri.fsPath) : undefined;
			if (!change) {
				editor.setDecorations(added, []);
				editor.setDecorations(removedAfter, []);
				editor.setDecorations(removedBefore, []);
				continue;
			}
			const addedRanges: vscode.Range[] = [];
			const after: vscode.DecorationOptions[] = [];
			const before: vscode.DecorationOptions[] = [];
			for (const hunk of change.hunks) {
				if (hunk.newLines > 0) {
					const start = clampLine(editor.document, hunk.newStart - 1);
					const end = clampLine(editor.document, hunk.newStart - 1 + hunk.newLines - 1);
					addedRanges.push(new vscode.Range(start, 0, Math.max(start, end), 0));
				}
				const removed = hunk.lines.filter((line) => line.type === 'del').map((line) => stripEol(line.text));
				if (!removed.length) {
					continue;
				}
				const label = `${clipped(removed[0]!)}${removed.length > 1 ? ` … (+${removed.length - 1})` : ''}`;
				const anchor = hunk.newLines > 0 ? hunk.newStart - 2 : hunk.newStart - 1;
				const options: vscode.DecorationOptions = {
					range: new vscode.Range(0, 0, 0, 0),
					hoverMessage: removedHover(removed),
				};
				if (anchor >= 0) {
					options.range = new vscode.Range(clampLine(editor.document, anchor), 0, clampLine(editor.document, anchor), 0);
					// The red chip already says "removed"; a minus sign and padding only add noise.
					options.renderOptions = { after: { contentText: label } };
					after.push(options);
				} else {
					options.renderOptions = { before: { contentText: label } };
					before.push(options);
				}
			}
			editor.setDecorations(added, addedRanges);
			editor.setDecorations(removedAfter, after);
			editor.setDecorations(removedBefore, before);
		}
	}

	/** Whether the active editor belongs to a pending file, for the editor-title actions. */
	function context(): void {
		const editor = vscode.window.activeTextEditor;
		const pending = Boolean(editor && enabled() && changes.has(editor.document.uri.fsPath));
		void vscode.commands.executeCommand('setContext', 'comonad.activePending', pending);
	}

	/** Reads every open pending document's change once; later reads are served from the cache. */
	async function refresh(): Promise<void> {
		if (mutating > 0) {
			// An action is mid-write; re-reading now could land before its save and undo the redraw.
			schedule();
			return;
		}
		const run = ++generation;
		const current = scopeOf(ctx);
		if (!current || !enabled()) {
			changes = new Map();
			scopeKey = '';
			lensEmitterFire();
			paint();
			context();
			return;
		}
		const key = `${current.sessionId}\u0000${current.workspace}`;
		if (key !== scopeKey) {
			changes = new Map();
			scopeKey = key;
		}
		let pendingPaths: Set<string>;
		try {
			// The list only: the per-file blocks are asked for below, and a `git diff` over every
			// pending file would be paid on every keystroke for counts this surface does not show.
			const pending = await ctx.checkpoints.pending(current.workspace, current.sessionId, unsavedPaths(current.workspace), { diff: false });
			pendingPaths = new Set(pending.files.map((file) => file.path));
		} catch {
			return;
		}
		// One read per open pending document, in parallel: they are independent, and the corpus is
		// whatever the user has open, not the library.
		const loaded = await Promise.all(
			vscode.workspace.textDocuments.map(async (document) => {
				const path = relativeOf(current.workspace, document.uri);
				if (!path || !pendingPaths.has(path)) {
					return undefined;
				}
				try {
					return [document.uri.fsPath, await ctx.checkpoints.change(current.workspace, current.sessionId, path)] as const;
				} catch {
					// The journal moved under the read; the next refresh picks it up.
					return undefined;
				}
			}),
		);
		const next = new Map(loaded.filter((entry): entry is readonly [string, FileChange] => entry !== undefined));
		if (run !== generation) {
			return;
		}
		changes = next;
		lensEmitterFire();
		fireBaselines();
		paint();
		context();
	}

	function schedule(): void {
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void refresh();
		}, REFRESH_MS);
	}

	const lenses = vscode.languages.registerCodeLensProvider(
		{ scheme: 'file' },
		{
			onDidChangeCodeLenses: lensChanged.event,
			provideCodeLenses: (document) => {
				const change = enabled() ? changes.get(document.uri.fsPath) : undefined;
				if (!change) {
					return [];
				}
				// The file actions are text in the editor, not only icons in its title bar: Cursor's
				// "Undo File / Keep File" are always in view, and a lens is the one text surface VS Code
				// gives an extension here. The block's own actions sit at its bottom edge, Undo first.
				const lenses: vscode.CodeLens[] = [
					new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
						title: '$(discard) Undo File',
						command: 'comonad.undoFile',
						arguments: [document.uri],
						tooltip: 'Undo the remaining changes in this file',
					}),
					new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
						title: '$(check) Keep File',
						command: 'comonad.keepFile',
						arguments: [document.uri],
						tooltip: 'Accept this file as it is now',
					}),
					new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
						title: '$(diff) Show Diff',
						command: 'comonad.openChangeDiff',
						arguments: [document.uri],
						tooltip: 'Open the diff against the accepted baseline',
					}),
				];
				// A dirty document has no saved state to act on; an outside edit is not the agent's to
				// keep block by block; binary and oversized files have no blocks to show.
				if (document.isDirty || change.changedOutside || change.binary || change.truncated) {
					return lenses;
				}
				for (const hunk of change.hunks.slice(0, MAX_BLOCK_LENSES)) {
					const line = lensLine(hunk, document);
					const range = new vscode.Range(line, 0, line, 0);
					lenses.push(
						new vscode.CodeLens(range, { title: '$(discard) Undo', command: 'comonad.undoHunk', arguments: [document.uri, hunk], tooltip: 'Restore this block to the baseline' }),
						new vscode.CodeLens(range, { title: '$(check) Keep', command: 'comonad.keepHunk', arguments: [document.uri, hunk], tooltip: 'Accept this change into the baseline' }),
					);
				}
				if (change.hunks.length > MAX_BLOCK_LENSES) {
					lenses.push(
						new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
							title: `$(diff) ${change.hunks.length - MAX_BLOCK_LENSES} more change(s) — Show Diff`,
							command: 'comonad.openChangeDiff',
							arguments: [document.uri],
						}),
					);
				}
				return lenses;
			},
		},
	);

	/** The scope and relative path a command's URI belongs to. */
	function target(uri: vscode.Uri | undefined): { current: Scope; path: string } | undefined {
		const current = scopeOf(ctx);
		if (!current || !uri) {
			return undefined;
		}
		const path = relativeOf(current.workspace, uri);
		return path ? { current, path } : undefined;
	}

	const commandUri = (uri: vscode.Uri | undefined): vscode.Uri | undefined =>
		uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;

	/** The overlay's own cache is updated in place after an action: a click must not wait on git. */
	function repaint(): void {
		lensEmitterFire();
		paint();
		context();
	}

	/** Applies a kept block to the cache without asking git again. */
	function keptLocally(uri: vscode.Uri, hunk: LineHunk): boolean {
		const change = changes.get(uri.fsPath);
		if (!change) {
			return false;
		}
		const located = change.hunks.find((candidate) => hunkKey(candidate) === hunkKey(hunk));
		if (!located) {
			return false;
		}
		const baseline = applyHunk(change.baseline, located);
		if (baseline === change.current) {
			changes.delete(uri.fsPath);
		} else {
			changes.set(uri.fsPath, { ...change, baseline, hunks: diffLines(baseline, change.current).hunks });
		}
		repaint();
		return true;
	}

	/** Replaces the cached current side after the review edited the file itself. */
	function undoneLocally(uri: vscode.Uri, change: FileChange, current: string): void {
		if (current === change.baseline) {
			changes.delete(uri.fsPath);
		} else {
			changes.set(uri.fsPath, { ...change, current, hunks: diffLines(change.baseline, current).hunks });
		}
		repaint();
	}

	registerCommand(ctx, 'comonad.keepFile', async (uri?: vscode.Uri) => {
		const resolved = target(commandUri(uri));
		const file = commandUri(uri);
		if (!resolved || !file) {
			return;
		}
		const document = await vscode.workspace.openTextDocument(file);
		if (document.isDirty) {
			void vscode.window.showWarningMessage('Comonad: save the file first — the inline review works on the saved content.');
			return;
		}
		// The file leaves the pending list, so the overlay drops it without a round trip.
		changes.delete(file.fsPath);
		repaint();
		try {
			await ctx.checkpoints.keep(resolved.current.workspace, resolved.current.sessionId, [resolved.path]);
			void vscode.window.showInformationMessage(`Comonad: kept ${resolved.path}.`);
		} catch (error) {
			void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
			await refresh();
		}
	});

	registerCommand(ctx, 'comonad.undoFile', async (uri?: vscode.Uri) => {
		const resolved = target(commandUri(uri));
		if (!resolved) {
			return;
		}
		try {
			await undoPaths(ctx, resolved.current.workspace, resolved.current.sessionId, [resolved.path], unsavedPaths(resolved.current.workspace));
			// Undo can be cancelled in the outside-changes question, so the truth comes from the journal.
			await refresh();
		} catch (error) {
			if (error instanceof DirtyEditorError) {
				explainDirty(error);
				return;
			}
			void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
		}
	});

	registerCommand(ctx, 'comonad.openChangeDiff', async (uri?: vscode.Uri) => {
		const resolved = target(commandUri(uri));
		const file = commandUri(uri);
		if (!resolved || !file) {
			return;
		}
		// Inline, not side by side: the accepted baseline's lines and the current file's sit in one
		// column, with deleted lines as solid red blocks and additions as green — the review reads
		// like the file itself, only changed.
		await vscode.commands.executeCommand('vscode.diff', baselineUri(file, resolved.current), file, `${basename(file.fsPath)} (Comonad)`, {
			preview: true,
			renderSideBySide: false,
		});
	});

	registerCommand(ctx, 'comonad.keepHunk', async (uri: vscode.Uri, hunk: LineHunk) => {
		const resolved = target(uri);
		if (!resolved) {
			return;
		}
		const document = await vscode.workspace.openTextDocument(uri);
		if (document.isDirty) {
			void vscode.window.showWarningMessage('Comonad: save the file first — the inline review works on the saved content.');
			return;
		}
		// The overlay answers the click first; the journal write follows, and a refusal is reconciled
		// by re-reading the truth. Waiting on git before redrawing is what made the button feel slow.
		const local = keptLocally(uri, hunk);
		let kept = false;
		mutating += 1;
		try {
			await ctx.checkpoints.keepHunk(resolved.current.workspace, resolved.current.sessionId, resolved.path, hunk, {
				isDirty: unsavedPaths(resolved.current.workspace),
			});
			kept = true;
		} catch (error) {
			void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
		} finally {
			mutating = Math.max(0, mutating - 1);
		}
		// A refusal (the file moved under the lens, an outside edit) has to put the overlay back.
		if (!kept || !local) {
			await refresh();
		}
	});

	registerCommand(ctx, 'comonad.undoHunk', async (uri: vscode.Uri, hunk: LineHunk) => {
		const resolved = target(uri);
		if (!resolved) {
			return;
		}
		const document = await vscode.workspace.openTextDocument(uri);
		if (document.isDirty) {
			void vscode.window.showWarningMessage('Comonad: save the file first — the inline review works on the saved content.');
			return;
		}
		try {
			// The cached change is exactly what the lens was drawn from; only a stale cache pays for a
			// journal read, and the truth is still re-checked below.
			let change = changes.get(uri.fsPath);
			let located = change?.hunks.find((candidate) => hunkKey(candidate) === hunkKey(hunk));
			if (!located) {
				change = await ctx.checkpoints.change(resolved.current.workspace, resolved.current.sessionId, resolved.path);
				located = change.hunks.find((candidate) => hunkKey(candidate) === hunkKey(hunk));
			}
			if (!change || !located) {
				void vscode.window.showInformationMessage('Comonad: this change moved — the editor has been refreshed.');
				await refresh();
				return;
			}
			const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
			const edit = editForHunk(document.getText(), eol, located);
			if (edit.start === edit.end && !edit.text) {
				return;
			}
			const workspaceEdit = new vscode.WorkspaceEdit();
			workspaceEdit.replace(uri, new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
			mutating += 1;
			try {
				if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
					throw new Error('the editor refused the change');
				}
				// The block is gone from the editor; draw that now, then persist and note it.
				undoneLocally(uri, change, document.getText());
				if (!(await document.save())) {
					throw new Error('the file could not be saved');
				}
				// The review made this edit itself: it must not read as a change from outside the agent.
				await ctx.checkpoints.amend(resolved.current.workspace, resolved.current.sessionId, resolved.path);
			} finally {
				mutating = Math.max(0, mutating - 1);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
			await refresh();
		}
	});

	// One refresh per burst: a save, a journal change and a tab switch often land together.
	ctx.on('checkpoints/changed', schedule);
	ctx.on('sessions/changed', schedule);
	ctx.on('settings/changed', schedule);
	ctx.effect(() => {
		const subscriptions = [
			vscode.window.onDidChangeVisibleTextEditors(() => {
				paint();
				schedule();
			}),
			vscode.window.onDidChangeActiveTextEditor(() => {
				context();
				paint();
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (event.document.uri.scheme === 'file') {
					schedule();
				}
			}),
			vscode.workspace.onDidSaveTextDocument(() => schedule()),
			vscode.workspace.onDidCloseTextDocument((document) => {
				if (changes.delete(document.uri.fsPath)) {
					lensEmitterFire();
					context();
				}
			}),
		];
		return () => {
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
		};
	});
	ctx.effect(() => () => {
		clearTimeout(timer);
		provider.dispose();
		lenses.dispose();
		lensChanged.dispose();
		baselineChanged.dispose();
		added.dispose();
		removedAfter.dispose();
		removedBefore.dispose();
		void vscode.commands.executeCommand('setContext', 'comonad.activePending', false);
	});

	void vscode.commands.executeCommand('setContext', 'comonad.activePending', false);
	schedule();
}
inlineDiff.inject = ['sessions', 'checkpoints', 'host', 'log', 'settings'];
