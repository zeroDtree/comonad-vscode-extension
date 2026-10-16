import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { APPROVAL_LABELS, MODE_LABELS } from '../lib/policy';
import type { ContextForm } from '../lib/prompt';
import { turnsOf, type Step } from '../lib/turns';
import { clip, describe, preview } from '../lib/util';
import type { Approval, ApprovalDecision, ReasoningEffort, WorkMode } from '../lib/types';
import { GENERATION_LABELS, GENERATION_TRIGGERS, generationTrigger, type GenerationTrigger } from '../lib/tavern/types';
import type { JournalApi } from '../services/checkpoints';
import type { Session } from '../services/sessions';
import { registerCommand } from './register';

/**
 * How full the window was on the last request, as a share of the window. It reads the prompt size the
 * provider reported rather than counting the transcript, so it is the same number the budget uses and
 * the same one the endpoint charged for.
 */
/** A token count the way a window is spoken about: 128K, 1M. */
function formatTokens(tokens: number): string {
	if (tokens >= 1_048_576) {
		return `${Math.round((tokens / 1_048_576) * 10) / 10}M`;
	}
	return `${Math.round(tokens / 1024)}K`;
}

function contextUsage(session: Session | undefined, window: number): string {
	if (!session?.lastInputTokens || !window) {
		return '';
	}
	const share = Math.min(100, Math.round((session.lastInputTokens / window) * 100));
	return `context ${share}% · ${formatTokens(session.lastInputTokens)}/${formatTokens(window)}`;
}

/** The chat: a webview view in the Secondary Side Bar, plus an optional editor window. */

const SURFACE = 'panel';
const VIEW_ID = 'comonad.chat';
const CONTAINER_ID = 'workbench.view.extension.comonadChat';

/**
 * What the content layer reports to the chat UI: the world-book entries the last turn's scan
 * injected, so the lore the model was given is visible next to the composer.
 */
function tavernState(session: Session | undefined): Record<string, unknown> {
	return {
		activated: (session?.tavernActivated ?? []).map((hit) => `${hit.book} — ${hit.comment || hit.reason} (${hit.reason})`),
		overflow: session?.tavernOverflow === true,
	};
}

export function chatPanel(ctx: Context): void {
	const extensionUri = ctx.host.extensionUri as vscode.Uri;
	const clients = new Set<vscode.Webview>();
	const attachments = new Map<vscode.Webview, vscode.Disposable>();
	let view: vscode.WebviewView | null = null;
	let panel: vscode.WebviewPanel | null = null;
	let running = false;
	let streamed = false;
	let stopped = false;
	let seq = 0;
	const approvals = new Map<string, (answer: ApprovalDecision) => void>();

	// A chord pressed inside a webview is resolved against the workbench's *root* context, where the
	// part-scoped keys (`auxiliaryBarFocus`, `focusedView`) are out of scope — that is why `Cmd+N`
	// used to fall through to VS Code's New Text File. The guest reports its own focus instead, and
	// `setContext` writes the key where every target can see it.
	const focusedClients = new Set<vscode.Webview>();
	const syncFocus = (): void => {
		void vscode.commands.executeCommand('setContext', 'comonad.chatFocused', focusedClients.size > 0);
	};

	/** Reveal a guest and put the caret in it, declaring it focused until it says otherwise. */
	const focusGuest = (webview: vscode.Webview): void => {
		focusedClients.add(webview);
		syncFocus();
		post({ type: 'focus' }, webview);
	};

	const post = (message: unknown, only?: vscode.Webview): void => {
		if (only) {
			void only.postMessage(message);
			return;
		}
		for (const client of clients) {
			void client.postMessage(message);
		}
	};

	const attach = (webview: vscode.Webview): void => {
		clients.add(webview);
		attachments.set(
			webview,
			webview.onDidReceiveMessage((message: Record<string, unknown>) => void handle(message, webview)),
		);
		webview.html = html(webview, extensionUri);
	};

	const detach = (webview: vscode.Webview): void => {
		clients.delete(webview);
		focusedClients.delete(webview);
		syncFocus();
		attachments.get(webview)?.dispose();
		attachments.delete(webview);
		if (!clients.size) {
			for (const resolve of approvals.values()) {
				resolve('deny');
			}
			approvals.clear();
		}
	};

	const state = async (): Promise<Record<string, unknown>> => {
		const config = ctx.settings.get();
		const session = ctx.sessions.active();
		const all = ctx.sessions.list();
		const usage = session?.usage;
		const tokens = usage ? usage.inputTokens + usage.outputTokens : 0;
		return {
			type: 'state',
			detail: [
				usage && usage.requests ? `${tokens} tokens · $${usage.cost.toFixed(3)}` : '',
				session ? `turn ${session.turnIndex}` : '',
				contextUsage(session, session ? ctx.agent.windowFor(session) : 0),
			]
				.filter(Boolean)
				.join('  ·  '),
			suspended: Boolean(session?.cursor),
			running,
			sessionId: session?.id ?? null,
			workspace: config.workingDirectory,
			mode: config.mode,
			approval: config.approval,
			network: config.network,
			context: session?.contextForm ?? config.contextForm,
			display: config.displayForm,
			reasoningEffort: session?.reasoningEffort ?? config.reasoningEffort,
			contextWindow: session?.contextWindow ?? config.contextWindow,
			// The window the request is actually measured against, and how full it was last time: the
			// provider's own count of the prompt rather than an estimate of the transcript.
			windowTokens: session ? ctx.agent.windowFor(session) : 0,
			contextUsed: session?.lastInputTokens ?? 0,
			modes: splitChoices(MODE_LABELS),
			approvals: splitChoices(APPROVAL_LABELS),
			generations: GENERATION_TRIGGERS.map((value) => ({ value, label: GENERATION_LABELS[value] })),
			model: config.model,
			modelLabel: ctx.llm.describe(config.model),
			models: await ctx.llm.availableModels(),
			sessionTotal: all.length,
			tavern: tavernState(session),
			sessions: all
				.slice(0, 60)
				.map((item) => ({ id: item.id, title: item.title, active: item.id === session?.id, updatedAt: item.updatedAt })),
			todos: session ? ctx.agent.todos(session.id).map((todo) => ({ status: todo.status, text: todo.text })) : [],
		};
	};

	// The transcript is sent as turns: one prompt plus the steps the agent took for it. The webview
	// renders live turns and replayed turns with the same code, so the two always look the same.
	const stepPayload = (step: Step): unknown => ({
		kind: step.kind,
		text: step.text === undefined ? undefined : clip(step.text, 40_000),
		id: step.id,
		name: step.name,
		args: step.args === undefined ? undefined : clip(step.args, 2_000),
		result: step.result === undefined ? undefined : clip(step.result, 30_000),
		status: step.status,
		ms: step.ms,
		at: step.at,
	});

	const history = (session: Session | undefined): unknown[] => {
		if (!session) {
			return [];
		}
		return turnsOf(session.transcript)
			.slice(-60)
			.map((turn) => ({
				index: turn.index,
				prompt: turn.prompt,
				greeting: turn.greeting,
				// The reply variants and which one is showing: the webview draws `‹ n/m ›` from these.
				swipes: turn.swipes,
				swipeId: turn.swipeId,
				continued: turn.continued,
				at: turn.at,
				startedAt: turn.startedAt,
				endedAt: turn.endedAt,
				steps: turn.steps.map(stepPayload),
			}));
	};

	/** The turn that just finished, so a live turn settles on the same numbers as a replayed one. */
	const settledTurn = (): { steps: unknown[]; startedAt?: number; endedAt?: number } => {
		const turns = turnsOf(ctx.sessions.active()?.transcript ?? []);
		const last = turns[turns.length - 1];
		return last ? { steps: last.steps.map(stepPayload), startedAt: last.startedAt, endedAt: last.endedAt } : { steps: [] };
	};

	/** The transcript the panel was last handed: which chat, and how much of it. */
	let published: { id: string; length: number } | null = null;

	/** The one place the panel is handed a transcript: a reload, a chat switch, and every rewrite. */
	const publishTurns = (session: Session | undefined): void => {
		published = session ? { id: session.id, length: session.transcript.length } : null;
		post({ type: 'turns', turns: history(session) });
	};

	const refresh = (): void => {
		void refreshState();
		void refreshChanges();
	};

	/**
	 * A generation the transcript holds somewhere other than the turn that streamed it: a continue
	 * grows the reply before it, an impersonation and a quiet turn are not written at all, and a swipe
	 * keeps the reply as one variant among several. The panel has to be handed the transcript again, or
	 * it keeps drawing a turn the session does not hold.
	 */
	const rewrote = (trigger: GenerationTrigger | undefined): boolean => trigger !== undefined && trigger !== 'normal';

	/**
	 * How a finished generation reaches the panel when it did not land where it streamed: an
	 * impersonation is yours to send (the composer), a quiet turn is a notice — it is nowhere else —
	 * and an error or an unstreamed reply is said outright. `null` means the streamed turn said it.
	 */
	const deliver = (trigger: GenerationTrigger, text: string): { type: 'notice' | 'command' | 'draft'; text: string } | null => {
		if (text.startsWith('Error:') || text.startsWith('Blocked by hook')) {
			return { type: 'notice', text };
		}
		if (trigger === 'impersonate') {
			return { type: 'draft', text };
		}
		if (trigger === 'quiet') {
			return { type: 'notice', text: text || '(no reply)' };
		}
		return streamed ? null : { type: 'command', text: text || '(no reply)' };
	};

	const refreshState = async (): Promise<void> => {
		if (!clients.size) {
			return;
		}
		// The session is read *after* the wait, never before it: a fork announces itself twice — as a new
		// chat, and then as that copy with everything after the turn removed — and a snapshot taken
		// before the wait would hand the panel the conversation as it stood before the cut.
		post(await state());
		const session = ctx.sessions.active();
		if (panel) {
			panel.title = session ? `Comonad · ${trimTitle(session.title)}` : 'Comonad';
		}
		if (!session) {
			if (published) {
				publishTurns(undefined);
			}
			return;
		}
		// A different chat, or one that was cut shorter behind the panel's back — the fork above, or a
		// rewind: the panel has to be handed the transcript again, not left drawing what is gone. A chat
		// that merely grew is a turn the panel watched happen, with its own streaming to keep.
		const moved = published?.id !== session.id;
		const cut = published?.id === session.id && session.transcript.length < published.length;
		if (moved || cut) {
			publishTurns(session);
		}
	};

	// Pending checkpoint changes shown as a review chip in the composer.
	const refreshChanges = async (): Promise<void> => {
		if (!clients.size) {
			return;
		}
		const session = ctx.sessions.active();
		const workspace = session?.policy.workingDirectory;
		// The journal is a feature plugin of its own: without it there is no chip, and nothing else
		// changes — the composer simply has nothing pending to show.
		const journal = ctx.get('checkpoints') as JournalApi | undefined;
		let count = 0;
		if (session && workspace && journal) {
			try {
				count = (await journal.pending(workspace, session.id)).files.length;
			} catch {
				count = 0;
			}
		}
		post({ type: 'changes', count });
	};

	// Stream the agent's events for this surface into the webview.
	ctx.on('agent/token', (ref, text) => {
		if (ref.surface === SURFACE) {
			streamed = true;
			post({ type: 'text', text });
		}
	});
	ctx.on('agent/reasoning', (ref, text) => {
		if (ref.surface === SURFACE) {
			post({ type: 'reasoning', text });
		}
	});
	ctx.on('agent/tool-start', (ref, call) => {
		if (ref.surface === SURFACE) {
			streamed = true;
			post({ type: 'tool-start', id: call.id, name: call.name, args: clip(call.arguments, 1_500) });
		}
	});
	ctx.on('agent/tool-result', (ref, call, output) => {
		if (ref.surface === SURFACE) {
			post({ type: 'tool-result', id: call.id, output: clip(output, 30_000) });
		}
	});
	ctx.on('agent/notice', (ref, text) => {
		if (ref.surface === SURFACE) {
			post({ type: 'notice', text });
		}
	});
	ctx.on('sessions/changed', refresh);
	ctx.on('settings/changed', refresh);
	ctx.on('checkpoints/changed', () => void refreshChanges());
	// Content changes (a reload, a card added) only move what the composer reads out, never the
	// transcript.
	ctx.on('tavern/changed', () => void refreshState());

	// Approvals for panel turns are answered by the webview buttons.
	ctx.on('approval/request', (request, next): Promise<ApprovalDecision> | ApprovalDecision => {
		if (request.surface !== SURFACE || !clients.size) {
			return next();
		}
		return new Promise((resolve) => {
			const id = `ap-${++seq}`;
			approvals.set(id, resolve);
			post({
				type: 'approval',
				id,
				reason: request.reason,
				calls: request.calls.map((call) => ({ name: call.name, args: preview(call.arguments, 300) })),
			});
		});
	});

	const send = async (text: string): Promise<void> => {
		const input = text.trim();
		if (!input || running) {
			return;
		}
		running = true;
		streamed = false;
		stopped = false;
		let handledByCommand = false;
		let rewrite = false;
		let settled: { type: 'notice' | 'command' | 'draft'; text: string } | null = null;
		post({ type: 'turn-start', text: input });
		try {
			// A command answers through the surface, and a redraw — `/compact` replaces the transcript —
			// would wipe an answer that was already on screen. The answers are held back until the
			// command is through; its progress is shown as it goes.
			const answers: string[] = [];
			const flush = (): void => {
				for (const answer of answers.splice(0)) {
					post({ type: 'command', text: answer });
				}
			};
			const surface = {
				markdown: (markdown: string) => answers.push(markdown),
				progress: (markdown: string) => post({ type: 'notice', text: markdown }),
			};
			const before = ctx.sessions.active()?.transcript.length ?? 0;
			const handled = await ctx.commands.handle(undefined, input, surface);
			if (handled.done) {
				handledByCommand = true;
				// A command can rewrite the chat itself: `/compact` swaps the transcript for a summary.
				// A chat that still holds what the panel is drawing has to be handed the new transcript,
				// before its own answer, which the redraw would wipe.
				const active = ctx.sessions.active();
				if (active && active.transcript.length !== before) {
					publishTurns(active);
				}
				flush();
				if (handled.result && !streamed) {
					post({ type: 'command', text: handled.result });
				}
				return;
			}
			// A command that hands the turn over (`/plan`, `/review`) says what it printed first, and then
			// the turn's own streaming takes over.
			flush();
			const result = await ctx.agent.runTurn({
				text: handled.text ?? input,
				sessionId: ctx.sessions.active()?.id,
				policy: handled.policy,
				trigger: handled.trigger,
				surface: SURFACE,
			});
			// `/continue`, `/impersonate`, `/swipe`, `/regenerate` and `/quiet` are the ▾ menu from the
			// keyboard, so their answer is delivered the same way the menu's is.
			settled = deliver(handled.trigger ?? 'normal', result.text);
			rewrite = rewrote(handled.trigger);
		} finally {
			running = false;
			if (rewrite) {
				publishTurns(ctx.sessions.active());
			}
			post({ type: 'turn-end', stopped, command: handledByCommand, ...settledTurn() });
			stopped = false;
			// After the redraw: a notice and a draft have nowhere else to be read.
			if (settled) {
				post(settled);
			}
			refresh();
		}
	};

	/** The generation types the composer's ▾ menu offers: upstream's own list, in its order. */
	const generate = async (trigger: GenerationTrigger, text = ''): Promise<void> => {
		const session = ctx.sessions.active();
		if (!session || running) {
			return;
		}
		const turns = turnsOf(session.transcript);
		const last = turns[turns.length - 1];
		if (trigger === 'swipe' || trigger === 'regenerate') {
			if (!last || last.greeting) {
				post({ type: 'notice', text: 'There is nothing to generate again yet.' });
				return;
			}
		}
		if (trigger === 'continue' && !last) {
			// Nothing to carry on: the answer would have no message to be written into.
			post({ type: 'notice', text: 'There is nothing to continue yet.' });
			return;
		}
		if (trigger === 'quiet' && !text.trim()) {
			// A quiet generation is never written down, so its prompt has to be the one in the box.
			post({ type: 'notice', text: 'Quiet needs a prompt in the box — say what to ask privately.' });
			return;
		}
		running = true;
		streamed = false;
		// A swipe and a regenerate replace the last reply in place: the webview swaps that turn for the
		// streaming one, and the variants it had are handed over so nothing the reader saw is lost.
		const replaces = trigger === 'swipe' || trigger === 'regenerate' ? last?.index : undefined;
		// A continue is not a turn of its own: its reply is written into the message it carries on, so
		// the webview grows that message instead of opening a second one.
		const continues = trigger === 'continue' ? last?.index : undefined;
		// An impersonation is not a turn of its own either: it is written into the composer, the way
		// upstream's own button does, so the webview streams it there instead of into the chat.
		post({ type: 'turn-start', text, replaces, continues, draft: trigger === 'impersonate' });
		let settled: { type: 'notice' | 'command' | 'draft'; text: string } | null = null;
		try {
			const result = await ctx.agent.runTurn({ text, sessionId: session.id, trigger, surface: SURFACE });
			settled = deliver(trigger, result.text);
		} finally {
			running = false;
			// A continue, an impersonation, a quiet turn and the swipes all rewrite what the panel is
			// drawing — the streamed turn is not the transcript. Hand it the transcript instead, the
			// same way a reload or a chat switch does.
			if (rewrote(trigger)) {
				publishTurns(ctx.sessions.active());
			}
			post({ type: 'turn-end', stopped, ...settledTurn() });
			stopped = false;
			// After the redraw: a quiet reply, a draft and an error have nowhere else to be read.
			if (settled) {
				post(settled);
			}
			refresh();
		}
	};

	/** Switches a reply to one of its variants. Nothing is generated: the text is already there. */
	const swipeTo = (index: number, turn?: number): void => {
		const session = ctx.sessions.active();
		if (!session || running) {
			return;
		}
		if (ctx.sessions.setSwipe(session.id, index, turn)) {
			// The variant that is showing is the transcript's own text, so the panel is handed the
			// transcript it just moved rather than left with the one it was drawing.
			publishTurns(ctx.sessions.active());
			refresh();
		}
	};

	/** Runs a turn again, dropping the reply it produced (the Regenerate button on the last turn). */
	const regenerate = async (turn: number | undefined): Promise<void> => {
		const session = ctx.sessions.active();
		if (!session || running) {
			return;
		}
		const turns = turnsOf(session.transcript);
		const last = turns[turns.length - 1];
		if (!last || (turn !== undefined && turn !== last.index)) {
			post({ type: 'notice', text: 'Only the last turn can be regenerated.' });
			return;
		}
		await generate('regenerate');
	};

	const resume = async (): Promise<void> => {		const session = ctx.sessions.active();
		if (!session?.cursor || running) {
			return;
		}
		running = true;
		streamed = false;
		// A resume continues the suspended turn: no new prompt, the same turn keeps going.
		post({ type: 'turn-resume' });
		try {
			const result = await ctx.agent.resume(session.id, { surface: SURFACE });
			if (result.text.startsWith('Error:') || result.text.startsWith('Blocked by hook')) {
				post({ type: 'notice', text: result.text });
			}
		} finally {
			running = false;
			post({ type: 'turn-end', stopped, ...settledTurn() });
			stopped = false;
			refresh();
		}
	};

	const handle = async (message: Record<string, unknown>, source: vscode.Webview): Promise<void> => {
		try {
			switch (message.type) {
				case 'ready':
					// A fresh guest has no transcript of its own: hand it the one the session holds.
					published = null;
					refresh();
					break;
				case 'focusState':
					if (message.focused === true) {
						focusedClients.add(source);
					} else {
						focusedClients.delete(source);
					}
					syncFocus();
					break;
				case 'send':
					await send(String(message.text ?? ''));
					break;
				case 'stop':
					stopped = true;
					ctx.agent.stop();
					break;
				case 'approve': {
					const id = String(message.id ?? '');
					const resolve = approvals.get(id);
					approvals.delete(id);
					const decision = message.decision === 'allow' || message.decision === 'always' ? message.decision : 'deny';
					resolve?.(decision);
					break;
				}
				case 'newSession':
					await vscode.commands.executeCommand('comonad.newSession');
					break;
				case 'switchSession':
					ctx.sessions.setActive(String(message.id ?? ''));
					break;
				case 'search': {
					const query = String(message.query ?? '');
					post({ type: 'search', query, items: ctx.sessions.search(query) });
					break;
				}
				case 'openSettings':
					await vscode.commands.executeCommand('comonad.openSettings');
					break;
				case 'configureModel':
					await vscode.commands.executeCommand('comonad.configureModel');
					break;
				case 'resume':
					await resume();
					break;				case 'openUrl':
					await openLink(String(message.url ?? ''));
					break;
				case 'copy':
					await vscode.env.clipboard.writeText(String(message.text ?? ''));
					break;
				case 'fork': {
					// Fork from a turn: the same conversation up to the end of it, as a new chat. Turns
					// always end on a boundary, so a fork can never cut a tool call off its result.
					const session = ctx.sessions.active();
					if (!session || running) {
						break;
					}
					const index = Number(message.turn);
					const turn = turnsOf(session.transcript).find((item) => item.index === index);
					if (turn) {
						// `forkAt` also makes the fork the active chat, so the panel switches to it — and it is
						// handed that copy here, because the fork is announced twice: once when it is made and
						// again when it is cut to this turn, and only the second one is the chat that is wanted.
						publishTurns(ctx.sessions.forkAt(session.id, turn.at));
					}
					break;
				}
				case 'regenerate':
					await regenerate(Number.isFinite(Number(message.turn)) ? Number(message.turn) : undefined);
					break;
				case 'generate':
					await generate(generationTrigger(message.trigger), String(message.text ?? ''));
					break;
				case 'setSwipe':
					swipeTo(Number(message.index), Number.isFinite(Number(message.turn)) ? Number(message.turn) : undefined);
					break;
				case 'setMode':
					if (typeof message.mode === 'string' && message.mode in MODE_LABELS) {
						await ctx.settings.applyPolicy({ mode: message.mode as WorkMode });
					}
					break;
				case 'setApproval':
					if (typeof message.approval === 'string' && message.approval in APPROVAL_LABELS) {
						await ctx.settings.applyPolicy({ approval: message.approval as Approval });
					}
					break;
				case 'setContext': {
					const session = ctx.sessions.active();
					if (session) {
						session.contextForm = asForm(message.context);
						ctx.sessions.save(session);
						ctx.sessions.changed(session.id);
					}
					break;
				}
				case 'setDisplay':
					// One control for the whole transcript, so every reply renders the same way.
					await ctx.settings.update('displayForm', asForm(message.display));
					break;
				case 'setReasoningEffort': {
					const session = ctx.sessions.active();
					if (session) {
						session.reasoningEffort = asReasoningEffort(message.effort);
						ctx.sessions.save(session);
						ctx.sessions.changed(session.id);
					}
					break;
				}
				case 'setContextWindow': {
					const session = ctx.sessions.active();
					if (session) {
						session.contextWindow = Math.max(0, Number(message.window) || 0);
						ctx.sessions.save(session);
						ctx.sessions.changed(session.id);
					}
					break;
				}
				case 'toggleNetwork':
					await ctx.settings.applyPolicy({ network: !ctx.settings.get().network });
					break;
				case 'setModel':
					await ctx.settings.update('model', String(message.model ?? 'auto'));
					break;
				case 'review':
					await vscode.commands.executeCommand('comonad.review');
					break;
				case 'lorebooks':
					await vscode.commands.executeCommand('comonad.pickLorebooks');
					break;
			}
		} catch (error) {
			ctx.log.message(`chat panel error: ${describe(error)}`);
			post({ type: 'notice', text: `Error: ${describe(error)}` });
		}
	};

	const openLink = async (url: string): Promise<void> => {
		if (!url) {
			return;
		}
		if (/^https?:/i.test(url)) {
			await vscode.env.openExternal(vscode.Uri.parse(url));
			return;
		}
		const match = url.match(/^(.+?)(?::(\d+))?$/);
		const target = match?.[1] ?? url;
		const path = isAbsolute(target) ? target : join(ctx.settings.workspace() || ctx.settings.home(), target);
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
			const editor = await vscode.window.showTextDocument(document);
			if (match?.[2]) {
				const line = Math.max(0, Number(match[2]) - 1);
				const position = new vscode.Position(line, 0);
				editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
				editor.selection = new vscode.Selection(position, position);
			}
		} catch {
			post({ type: 'notice', text: `Could not open ${url}` });
		}
	};

	const popOut = async (): Promise<void> => {
		try {
			await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
		} catch {
			void vscode.window.showInformationMessage('Comonad: this VS Code version cannot move the chat into its own window.');
		}
	};

	const openPanel = (options: { popOut?: boolean } = {}): void => {
		if (panel) {
			panel.reveal();
			focusGuest(panel.webview);
			if (options.popOut) {
				void popOut();
			}
			return;
		}
		const created = vscode.window.createWebviewPanel('comonad.chat', 'Comonad', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
		});
		created.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'comonad.svg');
		created.onDidDispose(() => {
			detach(created.webview);
			panel = null;
		});
		panel = created;
		attach(created.webview);
		if (options.popOut || ctx.settings.get().chatWindow) {
			void popOut();
		}
	};

	// The chat view lives in the Secondary Side Bar, Cursor-style.
	const provider: vscode.WebviewViewProvider = {
		resolveWebviewView: (webviewView) => {
			view = webviewView;
			webviewView.webview.options = {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
			};
			webviewView.onDidDispose(() => {
				if (view === webviewView) {
					view = null;
				}
				detach(webviewView.webview);
			});
			webviewView.onDidChangeVisibility(() => {
				if (webviewView.visible) {
					// Messages posted while the view is hidden are dropped: resync from the session.
					published = null;
					refresh();
				} else {
					focusedClients.delete(webviewView.webview);
					syncFocus();
				}
			});
			attach(webviewView.webview);
		},
	};
	ctx.effect(() => {
		const disposable = vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		});
		return () => disposable.dispose();
	});

	const openChat = async (): Promise<void> => {
		if (panel) {
			// The chat was popped out on purpose: bring it back where the user put it.
			panel.reveal();
			focusGuest(panel.webview);
			return;
		}
		try {
			await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
		} catch {
			try {
				await vscode.commands.executeCommand(CONTAINER_ID);
			} catch {
				openPanel();
			}
		}
		if (view) {
			focusGuest(view.webview);
		}
	};

	ctx.effect(() => () => {
		panel?.dispose();
		panel = null;
		view = null;
		focusedClients.clear();
		syncFocus();
	});
	registerCommand(ctx, 'comonad.openChat', () => openChat());
	registerCommand(ctx, 'comonad.openChatWindow', () => openPanel({ popOut: true }));
	// The title-bar icons are commands; the chat list itself lives in the webview.
	registerCommand(ctx, 'comonad.toggleHistory', () => post({ type: 'toggleHistory' }));
}
chatPanel.inject = ['sessions', 'agent', 'settings', 'llm', 'usage', 'commands', 'log', 'host'];

function splitChoices(labels: Record<string, string>): { id: string; label: string; description: string }[] {
	return Object.entries(labels).map(([id, label]) => {
		const [short, detail] = label.split(' — ');
		return { id, label: short ?? id, description: detail ?? '' };
	});
}

function asForm(value: unknown): ContextForm {
	return value === 'token' || value === 'raw' ? value : 'rendered';
}

function asReasoningEffort(value: unknown): ReasoningEffort {
	return value === 'none' || value === 'low' || value === 'medium' || value === 'high' ? value : 'auto';
}

function trimTitle(title: string): string {
	return title.length > 42 ? `${title.slice(0, 42)}…` : title;
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = randomBytes(16).toString('base64');
	const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'chat.js'));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'chat.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
</head>
<body>
<header id="bar">
	<div id="chats" hidden>
		<div id="chats-card">
			<div id="chats-search">
				<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.4 3.4"/></svg>
				<input id="search" type="search" placeholder="Search recent chats" spellcheck="false" autocomplete="off" />
			</div>
			<div id="chats-list"></div>
		</div>
	</div>
</header>
<main id="messages"></main>
<footer>
	<div id="todos" hidden></div>
	<div id="editor">
		<textarea id="input" rows="3" placeholder="Ask Comonad…  Enter to send · Shift+Enter for a new line · /help for commands"></textarea>
		<div id="controls">
			<div class="pill" data-control="model">
				<button class="pill-trigger" type="button" aria-haspopup="true" aria-expanded="false"><span class="pill-label"></span><span class="chev">▾</span></button>
				<div class="pill-menu" hidden></div>
			</div>
			<!-- What belongs at the right edge of the box: the chips, the generation menu and Send. -->
			<div id="sendbar">
				<button id="lore" class="chip" hidden></button>
				<button id="changes" class="chip" hidden></button>
				<button id="stop" class="ghost" data-tip="Stop the running turn (Esc)" hidden>Stop</button>
				<div class="pill pill-caret" data-control="generate">
					<button class="pill-trigger" type="button" aria-haspopup="true" aria-expanded="false" data-tip="Generation type — Normal, Continue, Impersonate, Swipe, Regenerate, Quiet"><span class="pill-label">Generate</span><span class="chev">▾</span></button>
					<div class="pill-menu" hidden></div>
				</div>
				<button id="send" class="primary" data-tip="Send — Enter">Send</button>
			</div>
		</div>
	</div>
	<div id="pills">
		<div class="pill" data-control="mode">
			<button class="pill-trigger" type="button" aria-haspopup="true" aria-expanded="false"><span class="pill-label"></span><span class="chev">▾</span></button>
			<div class="pill-menu" hidden></div>
		</div>
		<div class="pill" data-control="approval">
			<button class="pill-trigger" type="button" aria-haspopup="true" aria-expanded="false"><span class="pill-label"></span><span class="chev">▾</span></button>
			<div class="pill-menu" hidden></div>
		</div>
		<div class="pill" data-control="context">
			<button class="pill-trigger" type="button" aria-haspopup="true" aria-expanded="false">
				<span class="pill-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 13.2V3.4"/><path d="M3.9 7.5L8 3.4l4.1 4.1"/></svg></span>
				<span class="pill-label"></span><span class="chev">▾</span>
			</button>
			<div class="pill-menu" hidden></div>
		</div>
		<div class="pill" data-control="display">
			<button class="pill-trigger" type="button" aria-haspopup="true" aria-expanded="false">
				<span class="pill-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M1.7 8S4.1 4.2 8 4.2 14.3 8 14.3 8 11.9 11.8 8 11.8 1.7 8 1.7 8z"/><circle cx="8" cy="8" r="1.8"/></svg></span>
				<span class="pill-label"></span><span class="chev">▾</span>
			</button>
			<div class="pill-menu" hidden></div>
		</div>
		<button id="network" type="button">Network</button>
	</div>
	<div id="status"></div>
</footer>
<div id="tip" hidden></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
