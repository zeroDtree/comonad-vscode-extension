// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { APPROVAL_LABELS, MODE_LABELS } from '../lib/policy';
import type { ContextForm } from '../lib/prompt';
import { turnsOf, type Step, type Turn } from '../lib/turns';
import { clip, describe, preview } from '../lib/util';
import type { Approval, ApprovalDecision, ReasoningEffort, WorkMode } from '../lib/types';
import { GENERATION_LABELS, GENERATION_TRIGGERS, generationTrigger, type GenerationTrigger } from '../lib/generations';
import { DirtyEditorError, type JournalApi, type JournalEntry } from '../lib/journal';
import { formatReference } from '../lib/references';
import { isInside } from '../lib/sandbox';
import { ChatWebviewAssets, type ChatAssetSpec } from '../services/chat-assets';
import { markForRestore, type Session } from '../services/sessions';
import { explainDirty, restoreTo, unsavedPaths } from './journal-actions';
import { REFERENCE_LIMITS, WorkspaceFileCache, mentionResults, resolveReferences, scopeOf } from './references';
import { registerCommand } from './register';

/**
 * How full the window was on the last request, as a share of the window. It reads the prompt size the
 * provider reported rather than counting the transcript, so it is the same number the budget uses and
 * the same one the endpoint charged for.
 */
function contextUsage(session: Session | undefined, window: number): string {
	if (!session?.lastInputTokens || !window) {
		return '';
	}
	const share = Math.min(100, Math.round((session.lastInputTokens / window) * 100));
	return `context ${share}% · ${formatTokens(session.lastInputTokens)}/${formatTokens(window)}`;
}

/** A token count the way a window is spoken about: 128K, 1M. */
function formatTokens(tokens: number): string {
	if (tokens >= 1_048_576) {
		return `${Math.round((tokens / 1_048_576) * 10) / 10}M`;
	}
	return `${Math.round(tokens / 1024)}K`;
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
	// The chat's webview asset registry: plugins add scripts/styles to the document through it. It is
	// mounted here because the chat panel is its only consumer, and its lifetime is the chat's.
	ctx.plugin(ChatWebviewAssets);
	const extensionUri = ctx.host.extensionUri as vscode.Uri;
	const clients = new Set<vscode.Webview>();
	const readyClients = new Set<vscode.Webview>();
	const attachments = new Map<vscode.Webview, vscode.Disposable>();
	let view: vscode.WebviewView | null = null;
	let panel: vscode.WebviewPanel | null = null;
	let running = false;
	let streamed = false;
	let stopped = false;
	/** References picked in the editor before the chat webview finished loading. */
	let pendingReferences: string[] = [];
	/** The picker's file list, shared by every client and invalidated by a short TTL. */
	const mentionFiles = new WorkspaceFileCache();
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

	/**
	 * The folders the chat webview may read: its own assets, the plugin library (where every install
	 * lives, so a contribution that arrives after the webview was created still resolves), and any
	 * folders the current contributions declare.
	 */
	const webviewAssets = (): ChatAssetSpec[] => ctx.get('chatWebview')?.list() ?? [];
	const resourceRoots = (): vscode.Uri[] => {
		const roots = new Set<string>([
			join(extensionUri.fsPath, 'resources'),
			join(ctx.host.home(), '.comonad', 'plugins'),
			...(ctx.get('chatWebview')?.directories() ?? []),
		]);
		return [...roots].map((root) => vscode.Uri.file(root));
	};

	const attach = (webview: vscode.Webview): void => {
		clients.add(webview);
		attachments.set(
			webview,
			webview.onDidReceiveMessage((message: Record<string, unknown>) => void handle(message, webview)),
		);
		webview.html = chatDocument(webview, extensionUri, webviewAssets());
	};

	const detach = (webview: vscode.Webview): void => {
		clients.delete(webview);
		readyClients.delete(webview);
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
			// The window this chat's requests are measured against, which is what the model menu's
			// `Auto (…)` reads out.
			windowTokens: session ? ctx.agent.windowFor(session) : 0,
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

	/** A shell tool's command, kept whole so the expanded card can show it instead of the clipped JSON. */
	const shellCommand = (name: string | undefined, args: string | undefined): string | undefined => {
		if (!name || !/^run_shell/.test(name)) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(args ?? '{}') as { command?: unknown };
			return typeof parsed.command === 'string' ? parsed.command : undefined;
		} catch {
			return undefined;
		}
	};

	// The transcript is sent as turns: one prompt plus the steps the agent took for it. The webview
	// renders live turns and replayed turns with the same code, so the two always look the same.
	const stepPayload = (step: Step): unknown => ({
		kind: step.kind,
		text: step.text === undefined ? undefined : clip(step.text, 40_000),
		id: step.id,
		name: step.name,
		args: step.args === undefined ? undefined : clip(step.args, 2_000),
		command: shellCommand(step.name, step.args),
		result: step.result === undefined ? undefined : clip(step.result, 30_000),
		status: step.status,
		ms: step.ms,
		at: step.at,
	});

	/** Whether editing this turn can offer to restore files: the journal knows a point at or after it. */
	const restorePossible = (session: Session | undefined, turn: Turn | undefined): boolean =>
		Boolean(
			session &&
				turn &&
				turn.promptAt !== undefined &&
				session.policy.workingDirectory &&
				ctx.get('checkpoints') &&
				markForRestore(session.marks, turn.promptAt),
		);

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
				// An edit can offer to restore files written since this prompt.
				files: restorePossible(session, turn),
				at: turn.at,
				startedAt: turn.startedAt,
				endedAt: turn.endedAt,
				steps: turn.steps.map(stepPayload),
			}));
	};

	/** The turn that just finished, so a live turn settles on the same numbers as a replayed one. */
	const settledTurn = (session: Session | undefined = ctx.sessions.active()): { steps: unknown[]; startedAt?: number; endedAt?: number; files?: boolean } => {
		const turns = turnsOf(session?.transcript ?? []);
		const last = turns[turns.length - 1];
		return last
			? { steps: last.steps.map(stepPayload), startedAt: last.startedAt, endedAt: last.endedAt, files: restorePossible(session, last) }
			: { steps: [] };
	};

	/** The transcript the panel was last handed: which chat, and how much of it. */
	let published: { id: string; length: number } | null = null;

	/** The one place the panel is handed a transcript: a reload, a chat switch, and every rewrite. */
	const publishTurns = (session: Session | undefined): void => {
		published = session ? { id: session.id, length: session.transcript.length } : null;
		post({ type: 'turns', turns: history(session) });
	};

	// A contribution changes the document itself (scripts/styles), and a webview's HTML cannot be
	// amended in place: reload it and let the ready handshake replay state and turns. A live turn is
	// left alone so its stream survives; the next refresh after it ends reloads.
	let assetsDirty = false;
	const rebuildAssets = (): void => {
		if (!clients.size) {
			return;
		}
		if (running) {
			assetsDirty = true;
			return;
		}
		assetsDirty = false;
		const assets = webviewAssets();
		for (const client of clients) {
			client.html = chatDocument(client, extensionUri, assets);
		}
	};
	ctx.on('chatWebview/changed', rebuildAssets);

	const refresh = (): void => {
		if (assetsDirty && !running) {
			rebuildAssets();
		}
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
		// A different chat, or one that was cut shorter behind the panel's back — a fork above, or an
		// edit: the panel has to be handed the transcript again, not left drawing what is gone. A chat
		// that merely grew is a turn the panel watched happen, with its own streaming to keep. While a
		// turn is running its own mid-flight compaction must not wipe the live stream; the final
		// refresh after it ends catches up.
		const moved = published?.id !== session.id;
		const cut = !running && published?.id === session.id && session.transcript.length < published.length;
		if (moved || cut) {
			publishTurns(session);
		}
	};

	// Pending checkpoint changes: the list above the composer, with the per-file counts the review
	// would show. The journal is a feature plugin of its own, so without it the list is simply empty.
	let changesRun = 0;
	const refreshChanges = async (): Promise<void> => {
		if (!clients.size) {
			return;
		}
		// The journal announces every write: two reads can overlap, and the older answer must not
		// overwrite the newer list.
		const run = ++changesRun;
		const session = ctx.sessions.active();
		const workspace = session?.policy.workingDirectory;
		const journal = ctx.get('checkpoints') as JournalApi | undefined;
		let files: unknown[] = [];
		if (session && workspace && journal) {
			try {
				const pending = await journal.pending(workspace, session.id, unsavedPaths(workspace));
				files = pending.files.map((file) => ({
					path: file.path,
					additions: file.additions,
					deletions: file.deletions,
					created: file.created,
					deleted: file.deleted,
					changedOutside: file.changedOutside,
					dirty: file.dirty,
				}));
			} catch {
				files = [];
			}
		}
		// Nothing pending: the list keeps the files that were reviewed instead of disappearing. Once
		// a new write is pending, that list is what matters and the reviewed one is left out.
		let reviewed: string[] = [];
		if (!files.length && session && workspace && journal) {
			try {
				const latest = new Map<string, JournalEntry>();
				for (const entry of await journal.entries(workspace, session.id)) {
					latest.set(entry.path, entry);
				}
				reviewed = [...latest.values()]
					.filter((entry) => entry.accepted)
					.sort((left, right) => (right.acceptedAt ?? right.at) - (left.acceptedAt ?? left.at) || left.path.localeCompare(right.path))
					.map((entry) => entry.path);
			} catch {
				reviewed = [];
			}
		}
		if (run === changesRun) {
			post({ type: 'changes', files, reviewed });
		}
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
			post({ type: 'tool-start', id: call.id, name: call.name, args: clip(call.arguments, 1_500), command: shellCommand(call.name, call.arguments) });
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
	// One refresh answers a burst of events: a content save moves `tavern/changed`, and the settings
	// it writes through move `settings/changed` a moment later — the panel needs one repaint, not two.
	let refreshTimer: NodeJS.Timeout | undefined;
	const refreshSoon = (): void => {
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			refresh();
		}, 50);
	};
	ctx.on('sessions/changed', refresh);
	ctx.on('settings/changed', refreshSoon);
	ctx.on('checkpoints/changed', () => void refreshChanges());
	// Content changes (a reload, a card added) only move what the composer reads out, never the
	// transcript.
	ctx.on('tavern/changed', refreshSoon);

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
				resolveSystemContext: (live, effective) => resolveReferences(effective, scopeOf(live.policy)),
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
			const result = await ctx.agent.runTurn({
				text,
				sessionId: session.id,
				trigger,
				surface: SURFACE,
				resolveSystemContext: (live, effective) => resolveReferences(effective, scopeOf(live.policy)),
			});
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
		// A regenerate re-runs the prompt in place. When that prompt or a turn after it wrote files,
		// the same choice an edit offers is offered here: keep the workspace, or go back to before
		// this turn. A prompt that wrote nothing has nothing to ask about.
		const journal = ctx.get('checkpoints') as JournalApi | undefined;
		const workspace = session.policy.workingDirectory;
		const mark = last.promptAt === undefined ? undefined : markForRestore(session.marks, last.promptAt);
		if (journal && workspace && mark) {
			const answer = await vscode.window.showWarningMessage(
				'Regenerate this reply?',
				{
					modal: true,
					detail: 'The agent wrote files at or after this prompt. Restoring puts them back to their content before this turn; keeping them leaves the workspace as it is.',
				},
				'Regenerate',
				'Regenerate and restore files',
			);
			if (!answer) {
				return;
			}
			if (answer === 'Regenerate and restore files') {
				try {
					if (!(await restoreTo(journal, workspace, session.id, mark, unsavedPaths(workspace)))) {
						return;
					}
				} catch (error) {
					if (error instanceof DirtyEditorError) {
						explainDirty(error);
					} else {
						post({ type: 'notice', text: `Error: ${describe(error)}` });
					}
					return;
				}
			}
		}
		await generate('regenerate');
	};

	/**
	 * Replaces the prompt at `turnIndex` with `text` and runs it again; everything after it is
	 * discarded. The restore choice is the user's: when checked, files the agent wrote since the
	 * prompt go back before `runTurn` cuts the transcript, so a cancelled question or a blocking hook
	 * leaves both sides as they were.
	 */
	const editPrompt = async (turnIndex: number, text: string, restoreFiles: boolean): Promise<void> => {
		const input = text.trim();
		const session = ctx.sessions.active();
		if (!session || running || !input) {
			return;
		}
		if (session.cursor) {
			post({ type: 'notice', text: 'This session has a suspended tool call. Resume or stop it before editing a prompt.' });
			return;
		}
		const turn = turnsOf(session.transcript).find((item) => item.index === turnIndex);
		if (!turn || turn.greeting || turn.promptAt === undefined) {
			post({ type: 'notice', text: 'That message is not a prompt that can be edited.' });
			return;
		}
		const promptAt = turn.promptAt;
		const journal = ctx.get('checkpoints') as JournalApi | undefined;
		running = true;
		streamed = false;
		stopped = false;
		let started = false;
		let settled: { type: 'notice' | 'command' | 'draft'; text: string } | null = null;
		try {
			// A resend is a prompt, not a new command: text that starts with `/` is sent literally.
			const result = await ctx.agent.runTurn({
				text: input,
				sessionId: session.id,
				surface: SURFACE,
				rewriteAt: promptAt,
				resolveSystemContext: (live, effective) => resolveReferences(effective, scopeOf(live.policy)),
				prepareRewrite: async (live) => {
					const mark = restoreFiles ? markForRestore(live.marks, promptAt) : undefined;
					const workspace = live.policy.workingDirectory;
					if (restoreFiles && mark && journal && workspace) {
						try {
							if (!(await restoreTo(journal, workspace, live.id, mark, unsavedPaths(workspace)))) {
								return false;
							}
						} catch (error) {
							if (error instanceof DirtyEditorError) {
								explainDirty(error);
							} else {
								post({ type: 'notice', text: `Error: ${describe(error)}` });
							}
							return false;
						}
					}
					// The webview is about to draw the cut. The panel already holds this much of the
					// transcript, so the `sessions/changed` this rewrite emits cannot repaint the live turn.
					published = { id: live.id, length: promptAt };
					post({ type: 'turn-start', text: input, replacesFrom: turnIndex });
					started = true;
					return true;
				},
			});
			if (started) {
				settled = deliver('normal', result.text);
			} else if (result.text) {
				// A hook or a stale index stopped the edit before anything was cut or redrawn.
				post({ type: 'notice', text: result.text });
			}
		} finally {
			running = false;
			if (started) {
				// A turn can end with the panel on another chat: settle the one that was edited.
				const edited = ctx.sessions.get(session.id) ?? ctx.sessions.active();
				publishTurns(edited);
				post({ type: 'turn-end', stopped, ...settledTurn(edited) });
				stopped = false;
				if (settled) {
					post(settled);
				}
			}
			refresh();
		}
	};

	const resume = async (): Promise<void> => {
		const session = ctx.sessions.active();
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
					readyClients.add(source);
					// A fresh guest has no transcript of its own: hand it the one the session holds.
					published = null;
					refresh();
					// References picked before the composer loaded are finally in place to receive them.
					for (const token of pendingReferences.splice(0)) {
						post({ type: 'insertReference', token }, source);
					}
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
				case 'mentionQuery': {
					// The picker asks only the webview that is typing; other panels must not repaint.
					const id = Number(message.id) || 0;
					const kind =
						message.kind === 'folder' || message.kind === 'symbol' || message.kind === 'selection'
							? message.kind
							: 'file';
					const query = String(message.query ?? '').slice(0, REFERENCE_LIMITS.queryChars);
					const policy = ctx.sessions.active()?.policy ?? ctx.agent.policyFor();
					const result = await mentionResults(kind, query, scopeOf(policy), mentionFiles);
					post({ type: 'mentionResults', id, kind, query, ...result }, source);
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
					break;
				case 'openUrl':
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
				case 'editPrompt':
					await editPrompt(Number(message.turn), String(message.text ?? ''), message.restoreFiles === true);
					break;
				case 'generate': {
					const trigger = generationTrigger(message.trigger);
					// The Generate menu's Regenerate is the same action as the footer button: it must
					// ask about restoring files before it replays the last prompt.
					if (trigger === 'regenerate') {
						await regenerate(undefined);
					} else {
						await generate(trigger, String(message.text ?? ''));
					}
					break;
				}
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
				case 'keepAll':
					await vscode.commands.executeCommand('comonad.keepAll');
					break;
				case 'undoAll':
					await vscode.commands.executeCommand('comonad.undoAll');
					break;
				case 'openFile': {
					// The row names a workspace-relative path; open the file itself, where the inline
					// review paints its blocks, rather than the separate Comonad diff tab.
					const session = ctx.sessions.active();
					const workspace = session?.policy.workingDirectory;
					const path = String(message.path ?? '');
					if (workspace && path) {
						const target = resolve(workspace, path);
						if (!isInside(workspace, target)) {
							break;
						}
						if (!existsSync(target)) {
							post({ type: 'notice', text: `${path} is no longer on disk.` });
							break;
						}
						await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true });
					}
					break;
				}
				case 'lorebooks':
					// The picker is the tavern row's own command: with that row off there is nothing to pick.
					if (ctx.get('tavern')) {
						await vscode.commands.executeCommand('comonad.pickLorebooks');
					} else {
						post({ type: 'notice', text: 'World books come from the SillyTavern content row — turn it on under Settings → Plugins.' });
					}
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
			localResourceRoots: resourceRoots(),
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
				localResourceRoots: resourceRoots(),
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

	/** Put a reference token in the composer of the chat the command just revealed. */
	const insertReference = (token: string): void => {
		const target = panel?.webview ?? view?.webview;
		if (target && readyClients.has(target)) {
			post({ type: 'insertReference', token }, target);
			return;
		}
		// The composer has not loaded yet: the next ready message puts the token in.
		pendingReferences.push(token);
	};

	/** Cmd+L on a selection: the editor's lines as the `@path:lines` token in the composer. */
	const referenceSelection = async (): Promise<void> => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			void vscode.window.showInformationMessage('Comonad: select some code first.');
			return;
		}
		if (editor.document.uri.scheme !== 'file') {
			void vscode.window.showWarningMessage('Comonad: only selections in file editors can be referenced.');
			return;
		}
		// Prefer the chat's workspace; an outside file keeps its absolute path and the resolver's
		// policy decides whether it can be read.
		const workspace = ctx.sessions.active()?.policy.workingDirectory || ctx.settings.workspace();
		const relativePath = workspace ? relative(workspace, editor.document.uri.fsPath).split(sep).join('/') : '';
		const path = relativePath && !relativePath.startsWith('..') ? relativePath : editor.document.uri.fsPath;
		const start = editor.selection.start.line + 1;
		let end = editor.selection.end.line + 1;
		if (editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line) {
			end -= 1;
		}
		const token = formatReference({ kind: 'file', path, lines: { start, end: Math.max(start, end) } });
		await openChat();
		insertReference(token);
	};

	ctx.effect(() => () => {
		panel?.dispose();
		panel = null;
		view = null;
		focusedClients.clear();
		pendingReferences = [];
		syncFocus();
	});
	registerCommand(ctx, 'comonad.openChat', () => openChat());
	registerCommand(ctx, 'comonad.referenceSelection', () => referenceSelection());
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

export function chatDocument(webview: vscode.Webview, extensionUri: vscode.Uri, assets: readonly ChatAssetSpec[] = []): string {
	const nonce = randomBytes(16).toString('base64');
	const uri = (file: string): string => String(webview.asWebviewUri(vscode.Uri.file(file)));
	const script = String(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'chat.js')));
	const highlight = String(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'highlight.js')));
	const style = String(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'chat.css')));
	const assetStyles = assets.flatMap((asset) => asset.styles ?? []).map(uri);
	const assetScripts = assets.flatMap((asset) => asset.scripts ?? []).map(uri);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${escapeAttribute(style)}" />
${assetStyles.map((src) => `<link rel="stylesheet" href="${escapeAttribute(src)}" />`).join('\n')}
</head>
<body>
<!-- The bar is the recent-chats list's frame and nothing else: born folded, it opens with the list.
     Left up by default it reads as a black band under the title until the first state push — which
     waits on model discovery — i.e. as a shadow while the extension is still loading. -->
<header id="bar" hidden>
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
	<div id="changes-panel" hidden>
		<div id="changes-head">
			<button id="changes-toggle" type="button" class="ghost" data-tip="Collapse the changed files" aria-expanded="true">▾</button>
			<span id="changes-title"></span>
			<span id="changes-actions">
				<button id="changes-undo" type="button" class="ghost">Undo</button>
				<button id="changes-keep" type="button" class="ghost">Keep</button>
				<button id="changes-review" type="button" class="primary">Review</button>
			</span>
		</div>
		<div id="changes-list"></div>
	</div>
	<div id="editor">
		<textarea id="input" rows="3" placeholder="Ask Comonad…  Enter to send · Shift+Enter for a new line · @ to reference code · /help for commands"></textarea>
		<div id="mention" class="mention-menu" role="listbox" aria-label="Reference a workspace item" hidden>
			<div id="mention-head" class="mention-head" hidden></div>
			<div id="mention-list"></div>
		</div>
		<div id="controls">
			<div class="pill" data-control="model">
				<button class="pill-trigger" type="button" aria-haspopup="true" aria-expanded="false"><span class="pill-label"></span><span class="chev">▾</span></button>
				<div class="pill-menu" hidden></div>
			</div>
			<!-- What belongs at the right edge of the box: the chips, the generation menu and Send. -->
			<div id="sendbar">
				<button id="lore" class="chip" hidden></button>
				<div class="pill pill-caret" data-control="generate">
					<button class="pill-trigger" type="button" aria-haspopup="true" aria-expanded="false" data-tip="Generation type — Normal, Continue, Impersonate, Swipe, Regenerate, Quiet"><span class="pill-label">Generate</span><span class="chev">▾</span></button>
					<div class="pill-menu" hidden></div>
				</div>
				<button id="stop" class="ghost" data-tip="Stop the running turn (Esc)" hidden>Stop</button>
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
${assetScripts.map((src) => `<script nonce="${nonce}" src="${escapeAttribute(src)}"></script>`).join('\n')}
<script nonce="${nonce}" src="${escapeAttribute(highlight)}"></script>
<script nonce="${nonce}" src="${escapeAttribute(script)}"></script>
</body>
</html>`;
}

/** A URI written into an HTML attribute; webview URIs can contain characters that would close it. */
function escapeAttribute(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll("'", '&#39;');
}
