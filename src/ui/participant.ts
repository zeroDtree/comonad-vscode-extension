// SPDX-License-Identifier: AGPL-3.0-only
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { clip, describe, preview } from '../lib/util';
import type { ApprovalDecision, TextAttachment } from '../lib/types';
import { scopeOf } from '../services/references';

/** `@comonad` inside VS Code's chat view. The standalone panel lives in chat-panel.ts. */

let seq = 0;

export function participant(ctx: Context): void {
	const created = vscode.chat.createChatParticipant('comonad', async (request, _context, response, token) => {
		const surface = `participant:${++seq}`;
		let text = request.prompt.trim();
		// Native references are resolved after hooks, inside the turn. A description is already the
		// content the editor chose to show; a bare URI goes through the same guards as an `@` token.
		const notes: TextAttachment[] = [];
		const uris: vscode.Uri[] = [];
		for (const reference of request.references) {
			const description = typeof reference.modelDescription === 'string' ? reference.modelDescription : '';
			if (description.trim()) {
				notes.push({ kind: 'text', origin: 'user', form: 'note', source: {}, text: description.trim().slice(0, 80_000) });
			} else if (reference.value instanceof vscode.Uri) {
				uris.push(reference.value);
			}
		}
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
				if (approval.gate) {
					const picked = await vscode.window.showWarningMessage(
						`Comonad: ${approval.gate.title}`,
						{ modal: true, detail: approval.gate.body },
						'Approve',
						'Deny',
					);
					return picked === 'Approve' ? 'allow' : 'deny';
				}
				const detail = approval.calls.map((call) => `• ${call.name} ${preview(call.arguments, 160)}`).join('\n');
				const picked = await vscode.window.showWarningMessage(
					`Comonad needs approval (${approval.reason}).\n\n${detail}`,
					{ modal: true, detail: 'Always allow adds a rule to the settings that already hold your permissions.' },
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
					attachments: notes.length ? notes : undefined,
					policy: handled.policy,
					workflow: handled.workflow,
					surface,
					signal: controller.signal,
					resolveAttachments: uris.length
						? (live, signal) => ctx.references.resolveUris(uris, scopeOf(live.policy), signal)
						: undefined,
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
participant.inject = ['commands', 'agent', 'references', 'settings', 'sessions', 'log'];
