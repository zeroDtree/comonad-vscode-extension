// SPDX-License-Identifier: AGPL-3.0-only
import { basename, isAbsolute, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { journalScope, type JournalScope } from './journal-actions';
import { registerCommand } from './register';

/**
 * The baseline diff both review surfaces open: the accepted content, served as a virtual document,
 * compared with the file in one column. It travels with the journal row, and it is the only consumer
 * of the journal's `baselineContent`.
 */

const BASELINE_SCHEME = 'comonad-baseline';

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

export function changeDiff(ctx: Context): void {
	const baselines = new Map<string, vscode.Uri>();
	const changed = new vscode.EventEmitter<vscode.Uri>();

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

	function baselineUri(file: vscode.Uri, current: JournalScope): vscode.Uri {
		const uri = file.with({ scheme: BASELINE_SCHEME, query: encodeURIComponent(JSON.stringify(current)) });
		baselines.set(uri.toString(), uri);
		return uri;
	}

	function fireBaselines(): void {
		for (const uri of baselines.values()) {
			changed.fire(uri);
		}
	}

	const provider = vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
		onDidChange: changed.event,
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

	registerCommand(ctx, 'comonad.openChangeDiff', async (uri?: vscode.Uri) => {
		const current = journalScope(ctx);
		const file = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
		if (!current || !file || !relativeOf(current.workspace, file)) {
			return;
		}
		// Inline, not side by side: the accepted baseline's lines and the current file's sit in one
		// column, so the review reads like the file itself, only changed.
		await vscode.commands.executeCommand('vscode.diff', baselineUri(file, current), file, `${basename(file.fsPath)} (Comonad)`, {
			preview: true,
			renderSideBySide: false,
		});
	});

	// A baseline advances when a block or file is kept; an open diff has to say so.
	ctx.on('checkpoints/changed', fireBaselines);
	ctx.on('sessions/changed', fireBaselines);
	ctx.effect(() => () => {
		provider.dispose();
		changed.dispose();
	});
}
changeDiff.inject = ['sessions', 'checkpoints'];
