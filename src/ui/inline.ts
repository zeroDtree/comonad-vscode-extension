// SPDX-License-Identifier: AGPL-3.0-only
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { registerCommand } from './register';

/** Lightbulb actions and editor menu commands that hand a selection to Comonad chat. */

const LANGUAGES = [
	'typescript',
	'typescriptreact',
	'javascript',
	'javascriptreact',
	'python',
	'go',
	'rust',
	'java',
	'c',
	'cpp',
	'csharp',
	'php',
	'ruby',
	'kotlin',
	'swift',
];

async function explainSelection(uri: unknown, range: unknown, mode: 'explain' | 'fix'): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	const target = uri instanceof vscode.Uri && range instanceof vscode.Range && (!editor || editor.document.uri.toString() !== uri.toString()) ? { uri, range } : undefined;
	const document = target ? await vscode.workspace.openTextDocument(target.uri) : editor?.document;
	const selection = target ? target.range : editor?.selection;
	if (!document || !selection || selection.isEmpty) {
		void vscode.window.showInformationMessage('Select some code first.');
		return;
	}
	const relative = vscode.workspace.asRelativePath(document.uri);
	const snippet = document.getText(selection).slice(0, 12_000);
	const start = selection.start.line + 1;
	const prompt =
		mode === 'explain'
			? `Explain what the selected code in ${relative} (lines ${start}-${selection.end.line + 1}) does. Point out subtle behaviour and potential bugs.\n\n\`\`\`${document.languageId}\n${snippet}\n\`\`\``
			: `Improve the selected code in ${relative} (lines ${start}-${selection.end.line + 1}). Fix bugs or simplify it, then apply the edit with apply_edits.\n\n\`\`\`${document.languageId}\n${snippet}\n\`\`\``;
	await openChat(prompt);
}

async function openChat(query: string): Promise<void> {
	try {
		await vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: false });
	} catch {
		try {
			await vscode.commands.executeCommand('workbench.action.chat.open', `@comonad ${query}`);
		} catch {
			await vscode.env.clipboard.writeText(`@comonad ${query}`);
			void vscode.window.showInformationMessage('Copied the prompt to the clipboard — paste it into chat.');
		}
	}
}

export function inline(ctx: Context): void {
	const provider: vscode.CodeActionProvider = {
		provideCodeActions(document, range) {
			if (range.isEmpty || !LANGUAGES.includes(document.languageId)) {
				return [];
			}
			const explain = new vscode.CodeAction('Explain selection with Comonad', vscode.CodeActionKind.Empty.append('quickfix'));
			explain.command = { command: 'comonad.explainSelection', title: 'Explain', arguments: [document.uri, range] };
			const fix = new vscode.CodeAction('Fix or improve selection with Comonad', vscode.CodeActionKind.QuickFix);
			fix.command = { command: 'comonad.fixSelection', title: 'Fix', arguments: [document.uri, range] };
			return [explain, fix];
		},
	};
	ctx.effect(() => {
		const disposable = vscode.languages.registerCodeActionsProvider(LANGUAGES.map((language) => ({ language, scheme: 'file' })), provider, {
			providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty],
		});
		return () => disposable.dispose();
	});
	registerCommand(ctx, 'comonad.explainSelection', (uri, range) => explainSelection(uri, range, 'explain'));
	registerCommand(ctx, 'comonad.fixSelection', (uri, range) => explainSelection(uri, range, 'fix'));
}
