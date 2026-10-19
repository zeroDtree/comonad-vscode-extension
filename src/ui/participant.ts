// SPDX-License-Identifier: AGPL-3.0-only
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { sniffImage } from '../lib/images';
import { clip, describe, preview } from '../lib/util';
import type { ApprovalDecision } from '../lib/types';
import { resolveReferences, scopeOf } from './references';

/** `@comonad` inside VS Code's chat view. The standalone panel lives in chat-panel.ts. */

let seq = 0;

export function participant(ctx: Context): void {
	const created = vscode.chat.createChatParticipant('comonad', async (request, _context, response, token) => {
		const surface = `participant:${++seq}`;
		let text = request.prompt.trim();
		const pieces: string[] = [];
		for (const reference of request.references) {
			const description = typeof reference.modelDescription === 'string' ? reference.modelDescription : '';
			if (description.trim()) {
				pieces.push(description.trim());
			} else if (reference.value instanceof vscode.Uri) {
				try {
					const bytes = await vscode.workspace.fs.readFile(reference.value);
					const image = sniffImage(bytes);
					pieces.push(
						image
							? `File ${reference.value.fsPath} is a ${image.mime} image; use read_file to view it.`
							: `File ${reference.value.fsPath}:\n${Buffer.from(bytes).toString('utf8').slice(0, 20_000)}`,
					);
				} catch {
					// ignore unreadable references
				}
			}
		}
		const systemContext = pieces.length ? pieces.join('\n\n').slice(0, 80_000) : undefined;
		const form = ctx.settings.get().displayForm;
		const limit = form === 'raw' ? 4_000 : 700;
		let streamed = false;
		let thinking = false;

		const offs = [
			ctx.on('agent/token', (ref, chunk) => {
				if (ref.surface === surface) {
					streamed = true;
					response.markdown(chunk);
				}
			}),
			ctx.on('agent/reasoning', (ref, chunk) => {
				if (ref.surface !== surface || form === 'token') {
					return;
				}
				streamed = true;
				if (!thinking) {
					thinking = true;
					response.markdown('\n\n> 🧠 ');
				}
				response.markdown(chunk.replaceAll('\n', '\n> '));
			}),
			ctx.on('agent/tool-start', (ref, call) => {
				if (ref.surface !== surface || form === 'token') {
					return;
				}
				streamed = true;
				thinking = false;
				response.markdown(`\n\n**⚙ ${call.name}** \`${preview(call.arguments, form === 'raw' ? 400 : 120)}\`\n`);
			}),
			ctx.on('agent/tool-result', (ref, _call, output) => {
				if (ref.surface !== surface || form === 'token') {
					return;
				}
				response.markdown(`\n> ${clip(output, limit).replaceAll('\n', '\n> ')}\n`);
			}),
			ctx.on('agent/notice', (ref, notice) => {
				if (ref.surface === surface) {
					response.progress(notice);
				}
			}),
			ctx.on('approval/request', async (approval, next): Promise<ApprovalDecision> => {
				if (approval.surface !== surface) {
					return next();
				}
				const detail = approval.calls.map((call) => `• ${call.name} ${preview(call.arguments, 160)}`).join('\n');
				const picked = await vscode.window.showWarningMessage(
					`Comonad needs approval (${approval.reason}).\n\n${detail}`,
					{ modal: true, detail: 'Always allow adds a rule to the workspace settings.' },
					'Allow',
					'Always allow',
					'Deny',
				);
				return picked === 'Allow' ? 'allow' : picked === 'Always allow' ? 'always' : 'deny';
			}),
		];

		try {
			const surfaceApi = {
				markdown: (markdown: string) => response.markdown(markdown),
				progress: (markdown: string) => response.progress(markdown),
			};
			const handled = await ctx.commands.handle(request.command, text, surfaceApi);
			if (handled.done) {
				if (handled.result && !streamed) {
					response.markdown(handled.result);
				}
				return;
			}
			if (handled.text !== undefined) {
				text = handled.text;
			}
			if (!text) {
				response.markdown('What would you like to do?');
				return;
			}
			const controller = new AbortController();
			const subscription = token.onCancellationRequested(() => controller.abort());
			try {
				const result = await ctx.agent.runTurn({
					text,
					sessionId: ctx.sessions.active()?.id,
					systemContext,
					policy: handled.policy,
					surface,
					signal: controller.signal,
					resolveSystemContext: (live, effective) => resolveReferences(effective, scopeOf(live.policy)),
				});
				if (result.text.startsWith('Error:') || result.text.startsWith('Blocked by hook')) {
					response.markdown(result.text);
				} else if (!streamed) {
					response.markdown(result.text || '(no reply)');
				}
			} finally {
				subscription.dispose();
			}
		} catch (error) {
			ctx.log.message(`participant failed: ${describe(error)}`);
			response.markdown(`Error: ${describe(error)}`);
		} finally {
			for (const off of offs) {
				off();
			}
		}
	});
	created.followupProvider = {
		provideFollowups(): vscode.ChatFollowup[] {
			return [
				{ prompt: '/review', label: 'Review changes' },
				{ prompt: '/compact', label: 'Compact conversation' },
				{ prompt: '/status', label: 'Status' },
			];
		},
	};
	ctx.effect(() => () => created.dispose());
}
participant.inject = ['commands', 'agent', 'settings', 'sessions', 'log'];
