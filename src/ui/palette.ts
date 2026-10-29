// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import type { ApprovalDecision } from '../lib/types';
import { registerCommand } from './register';
import { auditText } from './slash';

/**
 * VS Code command palette bridge plus the fallback approval dialog. Surfaces answer
 * `approval/request` for their own ids; the fallback answers everything else.
 */

export function palette(ctx: Context): void {
	ctx.on('approval/request', async (request, next): Promise<ApprovalDecision> => {
		if (request.surface) {
			return next();
		}
		const detail = request.calls.map((call) => `• ${call.name} ${call.arguments.slice(0, 160)}`).join('\n');
		const picked = await vscode.window.showWarningMessage(
			`Comonad needs approval (${request.reason}).\n\n${detail}`,
			{ modal: true, detail: 'Always allow adds a rule to the settings that already hold your permissions.' },
			'Allow',
			'Always allow',
			'Deny',
		);
		return picked === 'Allow' ? 'allow' : picked === 'Always allow' ? 'always' : 'deny';
	});

	registerCommand(ctx, 'comonad.showDecisionTrace', () => showDecisionTrace(ctx));

	registerCommand(ctx, 'comonad.stop', () => {
		if (!ctx.agent.stop()) {
			void vscode.window.showInformationMessage('Comonad: nothing is running.');
		}
	});
	registerCommand(ctx, 'comonad.resumeTurn', async () => {
		const session = ctx.sessions.active();
		if (!session) {
			void vscode.window.showInformationMessage('Comonad: no session to resume.');
			return;
		}
		const result = await ctx.agent.resume(session.id);
		void vscode.window.showInformationMessage(result.text || 'Comonad: resumed.');
	});
	registerCommand(ctx, 'comonad.showLog', () => ctx.log.show());
	registerCommand(ctx, 'comonad.selectWorkingDirectory', async () => {
		const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Comonad working directory' });
		if (!folder) {
			return;
		}
		const sub = await vscode.window.showInputBox({ prompt: 'Subpath inside the folder (optional)', ignoreFocusOut: true });
		if (sub === undefined) {
			return;
		}
		const path = sub.trim() ? join(folder.uri.fsPath, sub.trim()) : folder.uri.fsPath;
		await ctx.settings.update('workingDirectory', path);
		void vscode.window.showInformationMessage(`Comonad: working directory set to ${path}`);
	});
}
palette.inject = ['agent', 'sessions', 'settings', 'log', 'decisions'];

/** Pick a recent terminal event and open its decision path as a read-only Markdown document. */
async function showDecisionTrace(ctx: Context): Promise<void> {
	const events = ctx.decisions.recent(20);
	if (!events.length) {
		void vscode.window.showInformationMessage('Comonad: no decision traces recorded yet.');
		return;
	}
	const picked = await vscode.window.showQuickPick(
		events.map((event) => ({
			label: `${event.event === 'dispatch_started' ? '$(play)' : '$(circle-slash)'} ${event.tool_name ?? 'tool'}`,
			description: event.call_id,
			detail: `${new Date(event.timestamp).toISOString()}${event.reason ? ` — ${event.reason}` : ''}`,
			callId: event.call_id,
		})),
		{ title: 'Comonad decision trace', ignoreFocusOut: true, matchOnDescription: true, matchOnDetail: true },
	);
	if (!picked) {
		return;
	}
	const document = await vscode.workspace.openTextDocument({ content: auditText(ctx, picked.callId), language: 'markdown' });
	await vscode.window.showTextDocument(document, { preview: true });
}
