// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import {
	MAX_DOCUMENT_BYTES,
	MAX_PASTED_TEXTS,
	MAX_PASTED_TEXT_CHARS,
	asPastedTextAttachment,
	publicImages,
} from '../lib/attachments';
import { asReasoningEffort } from '../lib/effort';
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, MAX_TOTAL_IMAGE_BYTES } from '../lib/images';
import { APPROVAL_LABELS, MODE_LABELS } from '../lib/policy';
import type { ContextForm } from '../lib/prompt';
import { turnsOf, type Step, type Turn } from '../lib/turns';
import { clip, describe, preview } from '../lib/util';
import type { Approval, ApprovalDecision, AttachmentPart, WorkMode } from '../lib/types';
import { GENERATION_LABELS, GENERATION_TRIGGERS, generationTrigger, type GenerationTrigger } from '../lib/generations';
import { DirtyEditorError, type JournalApi, type JournalEntry } from '../lib/journal';
import { formatReference } from '../lib/references';
import { isInside } from '../lib/sandbox';
import { countRaw } from '../lib/tokens';
import { ChatWebviewAssets, type ChatAssetSpec } from '../services/chat-assets';
import { inWorkspace, markForRestore, type Session } from '../services/sessions';
import { explainDirty, restoreTo, unsavedPaths } from './journal-actions';
import { WorkspaceFileCache, mentionResults } from './mentions';
import { REFERENCE_LIMITS, scopeOf } from '../services/references';
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
	const listeners = new Map<vscode.Webview, vscode.Disposable>();
	let view: vscode.WebviewView | null = null;
	let panel: vscode.WebviewPanel | null = null;
	let running = false;
	let streamed = false;
	let stopped = false;
	/** The chat that owns the running turn, so Stop and turn-end target it even after a switch. */
	let runningSessionId: string | null = null;
	/** The panel's own stop for work before `runTurn` registers the agent's turn signal. */
	let turnController: AbortController | null = null;
	/** References picked in the editor before the chat webview finished loading. */
	let pendingReferences: string[] = [];
	/** The picker's file list, shared by every client and invalidated by a short TTL. */
	const mentionFiles = new WorkspaceFileCache();
	let seq = 0;
	interface PendingApproval {
		sessionId: string;
		payload: Record<string, unknown>;
		resolve(answer: ApprovalDecision): void;
	}
	const approvals = new Map<string, PendingApproval>();
	/** The subagent conversation each guest has open over the chat, if any. */
	const subagentViews = new Map<vscode.Webview, string>();

	/**
	 * Which chats the recent-chats list shows: the folder this window has open, or every workspace on
	 * the host. A session remembers the folder it was started in, so the scoped list cannot show a
	 * chat from another project; the scope button widens it on demand.
	 */
	let historyScope: 'workspace' | 'all' = 'workspace';

	const inHistory = (session: Session): boolean =>
		historyScope === 'all' || inWorkspace(session, ctx.host.workspace());

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
		listeners.set(
			webview,
			webview.onDidReceiveMessage((message: Record<string, unknown>) => void handle(message, webview)),
		);
		webview.html = chatDocument(webview, extensionUri, webviewAssets());
	};

	const detach = (webview: vscode.Webview): void => {
		clients.delete(webview);
		readyClients.delete(webview);
		focusedClients.delete(webview);
		subagentViews.delete(webview);
		published.delete(webview);
		syncFocus();
		listeners.get(webview)?.dispose();
		listeners.delete(webview);
		if (!clients.size) {
			for (const approval of approvals.values()) {
				approval.resolve('deny');
			}
			approvals.clear();
		}
	};

	const state = async (): Promise<Record<string, unknown>> => {
		const config = ctx.settings.get();
		const session = ctx.sessions.active();
		const all = ctx.sessions.list().filter(inHistory);
		const effort = session?.reasoningEffort ?? config.reasoningEffort;
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
			runningSessionId,
			sessionId: session?.id ?? null,
			workspace: config.workingDirectory,
			mode: config.mode,
			approval: config.approval,
			network: config.network,
			sandbox: ctx.host.sandboxKind(),
			remote: ctx.host.remoteName() ?? null,
			allowUnsandboxedShell: config.allowUnsandboxedShell,
			context: session?.contextForm ?? config.contextForm,
			display: config.displayForm,
			toolCard: config.toolCard,
			reasoningEffort: effort,
			// What the endpoint will actually run, when its ceiling is below the pick: the menu reads
			// `Max → high` rather than claiming a level the provider does not have.
			reasoningEffortResolved: ctx.llm.effortFor(config.model, effort),
			contextWindow: session?.contextWindow ?? config.contextWindow,
			// The window this chat's requests are measured against, which is what the model menu's
			// `Auto (…)` reads out.
			windowTokens: session ? ctx.agent.windowFor(session) : 0,
			modes: splitChoices(MODE_LABELS),
			approvals: splitChoices(APPROVAL_LABELS),
			generations: GENERATION_TRIGGERS.map((value) => ({ value, label: GENERATION_LABELS[value] })),
			// The composer's `/` menu: what `commands.handle()` would resolve, custom files included.
			commands: ctx.commands.suggestions(),
			model: config.model,
			modelLabel: ctx.llm.describe(config.model),
			models: await ctx.llm.availableModels(),
			historyScope,
			sessionTotal: all.length,
			tavern: tavernState(session),
			sessions: all
				.slice(0, 60)
				.map((item) => ({ id: item.id, title: item.title, active: item.id === session?.id, updatedAt: item.updatedAt })),
			todos: session ? ctx.agent.todos(session.id).map((todo) => ({ status: todo.status, text: todo.text })) : [],
		};
	};

	/** run_shell_readonly and start_shell carry the same command/description pair. */
	const SHELL_TOOL = /^(?:run_shell|start_shell)/;

	const shellArgument = (
		name: string | undefined,
		args: string | undefined,
		key: 'command' | 'description',
	): string | undefined => {
		if (!name || !SHELL_TOOL.test(name)) {
			return undefined;
		}
		try {
			const value = (JSON.parse(args ?? '{}') as Record<string, unknown>)[key];
			return typeof value === 'string' ? value : undefined;
		} catch {
			return undefined;
		}
	};

	/** A shell tool's command, kept whole so the expanded card can show it instead of the clipped JSON. */
	const shellCommand = (name: string | undefined, args: string | undefined): string | undefined =>
		shellArgument(name, args, 'command');

	/** The model's title for the call, normalized for one line and bounded for the webview. */
	const shellDescription = (name: string | undefined, args: string | undefined): string | undefined => {
		const text = shellArgument(name, args, 'description')?.replace(/\s+/g, ' ').trim();
		return text ? clip(text, 120) : undefined;
	};

	// The transcript is sent as turns: one prompt plus the steps the agent took for it. The webview
	// renders live turns and replayed turns with the same code, so the two always look the same.
	const stepPayload = (step: Step, session?: Session): unknown => ({
		kind: step.kind,
		text: step.text === undefined ? undefined : clip(step.text, 40_000),
		id: step.id,
		name: step.name,
		args: step.args === undefined ? undefined : clip(step.args, 2_000),
		command: shellCommand(step.name, step.args),
		description: shellDescription(step.name, step.args),
		result: step.result === undefined ? undefined : clip(step.result, 30_000),
		images: publicImages(step.images),
		// A thought's length in tokens, counted with the model's tokenizer when one is warmed: the
		// fold's summary reads it beside the duration, live and after a reload alike.
		tokens: step.kind === 'thought' ? countRaw(step.text ?? '') : undefined,
		// The conversation an `agent` call spawned, so its card can open the child view.
		subagentId:
			step.kind === 'tool' && step.id && session?.subagents && Object.hasOwn(session.subagents, step.id)
				? session.subagents[step.id]
				: undefined,
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

	const summaryMeta = (session: Session | undefined): Record<string, unknown> | undefined => {
		if (!session?.modelContext) {
			return undefined;
		}
		const coveredTurns = turnsOf(session.transcript).filter((turn) => turn.at <= session.modelContext!.covers).length;
		return {
			text: session.modelContext.summary,
			covers: session.modelContext.covers,
			version: session.modelContext.version,
			at: session.modelContext.at,
			model: session.modelContext.model,
			coveredTurns,
		};
	};

	const history = (session: Session | undefined, before?: number, limit = 60) => {
		if (!session) {
			return { turns: [] as unknown[], summary: undefined, firstTurnIndex: undefined, totalTurns: 0, hasMore: false };
		}
		const all = turnsOf(session.transcript);
		const found = before === undefined ? all.length : all.findIndex((turn) => turn.index >= before);
		const end = found < 0 ? all.length : found;
		const page = Math.max(1, Math.min(limit, 200));
		const start = Math.max(0, end - page);
		return {
			turns: all.slice(start, end).map((turn) => ({
				index: turn.index,
				prompt: turn.prompt,
				promptAttachments: ctx.attachments.publicAttachments(turn.promptAttachments),
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
				steps: turn.steps.map((step) => stepPayload(step, session)),
			})),
			summary: summaryMeta(session),
			firstTurnIndex: all[start]?.index,
			totalTurns: all.length,
			hasMore: start > 0,
		};
	};

	/** The turn that just finished, so a live turn settles on the same numbers as a replayed one. */
	const settledTurn = (session: Session | undefined = ctx.sessions.active()): { steps: unknown[]; startedAt?: number; endedAt?: number; files?: boolean } => {
		const turns = turnsOf(session?.transcript ?? []);
		const last = turns[turns.length - 1];
		return last
			? { steps: last.steps.map((step) => stepPayload(step, session)), startedAt: last.startedAt, endedAt: last.endedAt, files: restorePossible(session, last) }
			: { steps: [] };
	};

	/**
	 * The transcript each panel was last handed: which chat, and how much of it. Per client, so a
	 * second panel opening or a hidden view resyncing cannot redraw a live turn in another one.
	 */
	const published = new Map<vscode.Webview, { id: string; length: number; modelContextVersion?: number }>();

	/** The one place a panel is handed a transcript page: a reload, a chat switch, and every rewrite. */
	const publishTurns = (session: Session | undefined, only?: vscode.Webview): void => {
		for (const client of only ? [only] : clients) {
			if (session) {
				published.set(client, { id: session.id, length: session.transcript.length, modelContextVersion: session.modelContext?.version });
			} else {
				published.delete(client);
			}
		}
		post({ type: 'turns', sessionId: session?.id, ...history(session) }, only);
	};

	/** A subagent's conversation as the overlay draws it; `undefined` when it is gone. */
	const subagentSnapshot = (id: string): Record<string, unknown> | undefined => {
		const session = ctx.sessions.get(id);
		if (!session?.parentId) {
			return undefined;
		}
		return {
			type: 'subagent',
			id,
			title: session.title,
			subagent: session.subagent,
			done: session.subagentDone === true,
			turns: history(session).turns,
		};
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
			if ([...clients].some((client) => published.has(client))) {
				publishTurns(undefined);
			}
			return;
		}
		// A different chat, or one that was cut shorter behind the panel's back — a fork above, or an
		// edit: the panel has to be handed the transcript again, not left drawing what is gone. A chat
		// that merely grew is a turn the panel watched happen, with its own streaming to keep; while a
		// turn is running its own mid-flight compaction must not wipe the live stream. The guest
		// re-attaches to the running turn from this transcript (`resumeLive`), so a resync after a
		// reload or a hidden view still ends with the stream on the same turn.
		for (const client of clients) {
			const seen = published.get(client);
			const moved = seen?.id !== session.id;
			const cut = !running && seen?.id === session.id && session.transcript.length < seen.length;
			const summaryChanged = seen?.id === session.id && seen.modelContextVersion !== session.modelContext?.version;
			if (moved || cut || (!running && summaryChanged)) {
				publishTurns(session, client);
			} else if (running && summaryChanged) {
				// Never wipe a live stream for a summary card. The guest moves covered turns and updates the
				// card in place; the regular repaint after the turn settles the rest.
				post({ type: 'summary', summary: summaryMeta(session) }, client);
				published.set(client, { ...seen!, modelContextVersion: session.modelContext?.version });
			}
		}
		// After a repaint, not before it: a card the guest already holds is deduped by id.
		postPendingApprovals();
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
			post({
				type: 'tool-start',
				id: call.id,
				name: call.name,
				args: clip(call.arguments, 2_000),
				command: shellCommand(call.name, call.arguments),
				description: shellDescription(call.name, call.arguments),
			});
		}
	});
	ctx.on('agent/tool-result', (ref, call, output, images) => {
		if (ref.surface === SURFACE) {
			post({ type: 'tool-result', id: call.id, output: clip(output, 30_000), images: publicImages(images) });
		}
	});
	ctx.on('agent/attachments', (ref, attachments) => {
		if (ref.surface === SURFACE) {
			post({ type: 'attachments', attachments: ctx.attachments.publicAttachments(attachments) });
		}
	});
	ctx.on('agent/notice', (ref, text) => {
		if (ref.surface === SURFACE) {
			post({ type: 'notice', text });
		}
	});
	// The card gains its "Open session" link as soon as the child exists, while the call still runs.
	ctx.on('agent/subagent-start', (ref, info) => {
		if (ref.surface === SURFACE) {
			post({ type: 'subagent-start', ...info });
		}
	});
	// A watched subagent gained a step, finished or failed: repaint the open overlay only.
	ctx.on('subagent/changed', (id) => {
		for (const [client, viewed] of subagentViews) {
			if (viewed !== id) {
				continue;
			}
			const snapshot = subagentSnapshot(id);
			if (snapshot) {
				post(snapshot, client);
			}
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
	// Storing or clearing a key changes which rows the model menu can actually run.
	ctx.on('llm/keys-changed', refreshSoon);
	ctx.on('checkpoints/changed', () => void refreshChanges());
	// Content changes (a reload, a card added) only move what the composer reads out, never the
	// transcript.
	ctx.on('tavern/changed', refreshSoon);
	// The `/` menu is state, not a query: a new command (a plugin mounting, a file written) repaints it.
	ctx.on('commands/changed', refreshSoon);
	ctx.on('catalog/changed', refreshSoon);

	// Approvals for panel turns are answered by the webview buttons.
	ctx.on('approval/request', (request, next): Promise<ApprovalDecision> | ApprovalDecision => {
		if (request.surface !== SURFACE || !clients.size) {
			return next();
		}
		if (request.signal.aborted) {
			return 'deny';
		}
		return new Promise<ApprovalDecision>((resolvePromise) => {
			const id = `ap-${++seq}`;
			const payload = {
				type: 'approval',
				id,
				sessionId: request.sessionId,
				reason: request.reason,
				// The approval is a decision about the whole call, so the prompt keeps the argument
				// that matters (a shell command, a path) in full; 8k is a display bound, not a summary.
				calls: request.calls.map((call) => ({ name: call.name, args: preview(call.arguments, 8_000) })),
			};
			const pending: PendingApproval = {
				sessionId: request.sessionId,
				payload,
				resolve: (answer) => {
					request.signal.removeEventListener('abort', withdraw);
					approvals.delete(id);
					resolvePromise(answer);
				},
			};
			const withdraw = (): void => {
				if (!approvals.has(id)) {
					return;
				}
				approvals.delete(id);
				request.signal.removeEventListener('abort', withdraw);
				resolvePromise('deny');
				post({ type: 'approval-withdraw', ids: [id] });
			};
			approvals.set(id, pending);
			request.signal.addEventListener('abort', withdraw, { once: true });
			// A card belongs to the chat that asked; a switch away keeps it pending for the way back.
			if (request.sessionId === ctx.sessions.active()?.id) {
				post(payload);
			}
		});
	});

	/** Hand the guest the cards of the chat now on screen, e.g. after a switch or a reload. */
	const postPendingApprovals = (): void => {
		const active = ctx.sessions.active()?.id;
		for (const approval of approvals.values()) {
			if (approval.sessionId === active) {
				post(approval.payload);
			}
		}
	};

	/**
	 * Turns the composer's pastes and data URLs into stored references. The webview is not trusted:
	 * the bytes are sniffed again by the store, and the types, counts and sizes are checked here.
	 * Pasted text is already in memory and has no bytes to sniff; it is a user note on the message.
	 */
	const ingestAttachments = async (value: unknown): Promise<{ attachments: AttachmentPart[]; problem?: string }> => {
		if (!Array.isArray(value) || value.length === 0) {
			return { attachments: [] };
		}
		const attachments: AttachmentPart[] = [];
		const problems: string[] = [];
		let imageBytes = 0;
		let documentBytes = 0;
		let pdfHint = false;
		let texts = 0;
		let media = 0;
		let textLimit = false;
		let mediaLimit = false;
		const entries = value.slice(0, MAX_IMAGES_PER_MESSAGE + MAX_PASTED_TEXTS);
		for (const entry of entries) {
			const item = entry as { kind?: unknown; data?: unknown; name?: unknown; text?: unknown };
			if (item.kind === 'text') {
				if (texts >= MAX_PASTED_TEXTS) {
					if (!textLimit) {
						textLimit = true;
						problems.push(`only ${MAX_PASTED_TEXTS} pasted texts are sent at a time`);
					}
					continue;
				}
				const pasted = asPastedTextAttachment(item);
				if (!pasted.part) {
					problems.push('a pasted text was empty');
					continue;
				}
				texts += 1;
				attachments.push(pasted.part);
				if (pasted.clipped !== undefined) {
					problems.push(
						`a pasted text was ${pasted.clipped.toLocaleString()} characters; only the first ${MAX_PASTED_TEXT_CHARS.toLocaleString()} were kept`,
					);
				}
				continue;
			}
			if (media >= MAX_IMAGES_PER_MESSAGE) {
				if (!mediaLimit) {
					mediaLimit = true;
					problems.push(`only ${MAX_IMAGES_PER_MESSAGE} images or PDFs are sent at a time`);
				}
				continue;
			}
			media += 1;
			const dataUrl = typeof item.data === 'string' ? item.data : '';
			const name = typeof item.name === 'string' ? item.name : undefined;
			const pdf = /^data:application\/pdf;base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
			const image = pdf ? null : /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
			if (!pdf && !image) {
				problems.push('an attachment was not a supported image or PDF');
				continue;
			}
			const base64 = (pdf ? pdf[1] : image![2])!.replace(/\s+/g, '');
			const limit = pdf ? MAX_DOCUMENT_BYTES : MAX_IMAGE_BYTES;
			if (base64.length > Math.ceil((limit * 4) / 3) + 64) {
				problems.push(pdf ? 'a PDF is over the 20 MiB limit' : 'an image is over the 4 MiB limit');
				continue;
			}
			const data = Buffer.from(base64, 'base64');
			if (pdf) {
				if (documentBytes + data.byteLength > MAX_DOCUMENT_BYTES * 2) {
					problems.push('the PDFs together are over the 40 MiB limit');
					break;
				}
				try {
					const stored = await ctx.attachments.putDocument(data, name);
					attachments.push({ ...stored, origin: 'user' });
					documentBytes += data.byteLength;
					if (!pdfHint && !ctx.references.supports('pdf')) {
						pdfHint = true;
						problems.push('PDF text extraction needs the PDF documents plugin');
					}
				} catch (error) {
					problems.push(describe(error));
				}
				continue;
			}
			if (imageBytes + data.byteLength > MAX_TOTAL_IMAGE_BYTES) {
				problems.push('the images together are over the 12 MiB limit');
				break;
			}
			try {
				const stored = await ctx.attachments.putImage(data, name);
				attachments.push({ ...stored, origin: 'user' });
				imageBytes += data.byteLength;
			} catch (error) {
				problems.push(describe(error));
			}
		}
		if (value.length > entries.length) {
			problems.push('only the first attachments were sent');
		}
		return { attachments, problem: problems.length ? `Attachment(s) skipped: ${problems.join('; ')}.` : undefined };
	};

	const send = async (text: string, incoming?: unknown, source?: vscode.Webview): Promise<void> => {
		if (running) {
			post({ type: 'notice', text: 'A turn is already running in this chat — Stop it or wait for it to finish.' }, source);
			return;
		}
		running = true;
		streamed = false;
		stopped = false;
		turnController = new AbortController();
		let turnSession = ctx.sessions.active()?.id ?? null;
		runningSessionId = turnSession;
		let started = false;
		let handledByCommand = false;
		let rewrite = false;
		let settled: { type: 'notice' | 'command' | 'draft'; text: string } | null = null;
		try {
			const input = text.trim();
			const { attachments, problem } = await ingestAttachments(incoming);
			if (turnController.signal.aborted) {
				return;
			}
			if (problem) {
				post({ type: 'notice', text: problem }, source);
			}
			if (!input && !attachments.length) {
				return;
			}
			started = true;
			post({ type: 'turn-start', text: input, sessionId: turnSession, attachments: ctx.attachments.publicAttachments(attachments) });
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
			const beforeSummary = ctx.sessions.active()?.modelContext?.version;
			const handled = await ctx.commands.handle(undefined, input, surface);
			// A Stop during command handling ends the turn here; the slash command itself is not
			// cancellable, so the turn waits for it but never starts the model afterwards.
			if (turnController.signal.aborted) {
				return;
			}
			if (handled.done) {
				handledByCommand = true;
				// A command can rewrite the chat itself, or move only the model context (`/compact`).
				// Either way the panel is handed the new page before the command's own answer.
				const active = ctx.sessions.active();
				turnSession = active?.id ?? turnSession;
				if (active && (active.transcript.length !== before || active.modelContext?.version !== beforeSummary)) {
					publishTurns(active);
				}
				flush();
				if (handled.result && !streamed) {
					post({ type: 'command', text: handled.result });
				}
				if (attachments.length) {
					post({ type: 'notice', text: 'Commands do not use attachments; the attachment(s) were not sent.' }, source);
				}
				return;
			}
			// A command that hands the turn over (`/plan`, `/review`) says what it printed first, and then
			// the turn's own streaming takes over.
			flush();
			const result = await ctx.agent.runTurn({
				text: handled.text ?? input,
				attachments,
				sessionId: ctx.sessions.active()?.id,
				policy: handled.policy,
				trigger: handled.trigger,
				surface: SURFACE,
				signal: turnController.signal,
			});
			turnSession = result.sessionId;
			stopped ||= result.stopped === true;
			// `/continue`, `/impersonate`, `/swipe`, `/regenerate` and `/quiet` are the ▾ menu from the
			// keyboard, so their answer is delivered the same way the menu's is.
			settled = result.stopped && !result.text ? null : deliver(handled.trigger ?? 'normal', result.text);
			rewrite = rewrote(handled.trigger);
		} finally {
			running = false;
			runningSessionId = null;
			turnController = null;
			if (rewrite) {
				publishTurns(ctx.sessions.get(turnSession ?? '') ?? ctx.sessions.active());
			}
			if (started) {
				const settledSession = ctx.sessions.get(turnSession ?? '') ?? ctx.sessions.active();
				post({ type: 'turn-end', sessionId: settledSession?.id ?? turnSession, stopped, command: handledByCommand, ...settledTurn(settledSession) });
			}
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
		if (!session) {
			return;
		}
		if (running) {
			post({ type: 'notice', text: 'A turn is already running in this chat — Stop it or wait for it to finish.' });
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
		runningSessionId = session.id;
		streamed = false;
		stopped = false;
		turnController = new AbortController();
		// A swipe and a regenerate replace the last reply in place: the webview swaps that turn for the
		// streaming one, and the variants it had are handed over so nothing the reader saw is lost.
		const replaces = trigger === 'swipe' || trigger === 'regenerate' ? last?.index : undefined;
		// A continue is not a turn of its own: its reply is written into the message it carries on, so
		// the webview grows that message instead of opening a second one.
		const continues = trigger === 'continue' ? last?.index : undefined;
		// An impersonation is not a turn of its own either: it is written into the composer, the way
		// upstream's own button does, so the webview streams it there instead of into the chat.
		post({
			type: 'turn-start',
			text,
			sessionId: session.id,
			replaces,
			continues,
			draft: trigger === 'impersonate',
			// A swipe or a regenerate replaces the reply in place; the prompt's attachments stay with it.
			attachments: ctx.attachments.publicAttachments(replaces !== undefined ? last?.promptAttachments : undefined),
		});
		let settled: { type: 'notice' | 'command' | 'draft'; text: string } | null = null;
		try {
			const result = await ctx.agent.runTurn({
				text,
				sessionId: session.id,
				trigger,
				surface: SURFACE,
				signal: turnController.signal,
			});
			stopped ||= result.stopped === true;
			settled = result.stopped && !result.text ? null : deliver(trigger, result.text);
		} finally {
			running = false;
			runningSessionId = null;
			turnController = null;
			// A continue, an impersonation, a quiet turn and the swipes all rewrite what the panel is
			// drawing — the streamed turn is not the transcript. Hand it the transcript instead, the
			// same way a reload or a chat switch does.
			if (rewrote(trigger)) {
				publishTurns(ctx.sessions.active());
			}
			post({ type: 'turn-end', sessionId: session.id, stopped, ...settledTurn(session) });
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
		runningSessionId = session.id;
		streamed = false;
		stopped = false;
		turnController = new AbortController();
		let started = false;
		let settled: { type: 'notice' | 'command' | 'draft'; text: string } | null = null;
		try {
			// A resend is a prompt, not a new command: text that starts with `/` is sent literally.
			const result = await ctx.agent.runTurn({
				text: input,
				sessionId: session.id,
				surface: SURFACE,
				signal: turnController.signal,
				rewriteAt: promptAt,
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
					// The webview is about to draw the cut. Every panel already holds this much of the
					// transcript, so the `sessions/changed` this rewrite emits cannot repaint the live turn.
					for (const client of clients) {
						published.set(client, {
							id: live.id,
							length: promptAt,
							modelContextVersion: live.modelContext?.version,
						});
					}
					post({
						type: 'turn-start',
						text: input,
						sessionId: session.id,
						replacesFrom: turnIndex,
						attachments: ctx.attachments.publicAttachments(turn.promptAttachments),
					});
					started = true;
					return true;
				},
			});
			stopped ||= result.stopped === true;
			if (started) {
				settled = result.stopped && !result.text ? null : deliver('normal', result.text);
			} else if (result.text) {
				// A hook or a stale index stopped the edit before anything was cut or redrawn.
				post({ type: 'notice', text: result.text });
			}
		} finally {
			running = false;
			runningSessionId = null;
			turnController = null;
			if (started) {
				// A turn can end with the panel on another chat: settle the one that was edited.
				const edited = ctx.sessions.get(session.id) ?? ctx.sessions.active();
				publishTurns(edited);
				post({ type: 'turn-end', sessionId: session.id, stopped, ...settledTurn(edited) });
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
		runningSessionId = session.id;
		streamed = false;
		stopped = false;
		turnController = new AbortController();
		// A resume continues the suspended turn: no new prompt, the same turn keeps going.
		post({ type: 'turn-resume', sessionId: session.id });
		try {
			const result = await ctx.agent.resume(session.id, { surface: SURFACE, signal: turnController.signal });
			stopped ||= result.stopped === true;
			if (result.text.startsWith('Error:') || result.text.startsWith('Blocked by hook')) {
				post({ type: 'notice', text: result.text });
			}
		} finally {
			running = false;
			runningSessionId = null;
			turnController = null;
			post({ type: 'turn-end', sessionId: session.id, stopped, ...settledTurn(session) });
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
					// Only this client is forgotten; another panel may be mid-turn with its own copy.
					published.delete(source);
					refresh();
					postPendingApprovals();
					// References picked before the composer loaded are finally in place to receive them.
					for (const token of pendingReferences.splice(0)) {
						post({ type: 'insertReference', token }, source);
					}
					// A reloaded guest forgot its overlay: hand it back, marked as an unsolicited open.
					{
						const viewed = subagentViews.get(source);
						const snapshot = viewed ? subagentSnapshot(viewed) : undefined;
						if (snapshot) {
							post({ ...snapshot, type: 'subagent-open' }, source);
						} else if (viewed) {
							subagentViews.delete(source);
						}
					}
					break;
				case 'resync': {
					// The guest lost the live stream (a dropped message, a race with a reload) and
					// asks for the transcript the host persisted while the turn ran. Only this client
					// is redrawn; a live turn re-attaches to it and the stream continues there.
					post(await state(), source);
					publishTurns(ctx.sessions.active(), source);
					postPendingApprovals();
					break;
				}
				case 'focusState':
					if (message.focused === true) {
						focusedClients.add(source);
					} else {
						focusedClients.delete(source);
					}
					syncFocus();
					break;
				case 'send':
					await send(String(message.text ?? ''), message.attachments, source);
					break;
				case 'attachment': {
					const id = String(message.id ?? '');
					post({ type: 'attachment', id, url: ctx.attachments.dataUrlById(id) ?? null }, source);
					break;
				}
				case 'stop': {
					// The host knows which turn it owns; the guest's id is only a fallback.
					const target = runningSessionId ?? (typeof message.sessionId === 'string' ? message.sessionId : null);
					const controller = turnController;
					let ok = false;
					if (controller && !controller.signal.aborted) {
						controller.abort();
						ok = true;
					}
					if (ctx.agent.stop(target ?? undefined)) {
						ok = true;
					}
					stopped = ok;
					post({ type: 'stop-ack', ok }, source);
					break;
				}
				case 'approve': {
					const id = String(message.id ?? '');
					const pending = approvals.get(id);
					approvals.delete(id);
					const decision = message.decision === 'allow' || message.decision === 'always' ? message.decision : 'deny';
					pending?.resolve(decision);
					break;
				}
				case 'newSession':
					await vscode.commands.executeCommand('comonad.newSession');
					break;
				case 'switchSession':
					ctx.sessions.setActive(String(message.id ?? ''));
					postPendingApprovals();
					break;
				case 'setHistoryScope':
					historyScope = message.scope === 'all' ? 'all' : 'workspace';
					refresh();
					break;
				case 'openSubagent': {
					const id = String(message.id ?? '');
					const snapshot = subagentSnapshot(id);
					if (!snapshot) {
						post({ type: 'notice', text: 'That subagent session is no longer available.' }, source);
						break;
					}
					subagentViews.set(source, id);
					post(snapshot, source);
					break;
				}
				case 'closeSubagent':
					subagentViews.delete(source);
					break;
				case 'search': {
					const query = String(message.query ?? '');
					post({ type: 'search', query, items: ctx.sessions.search(query, 40, inHistory) });
					break;
				}
				case 'loadOlder': {
					const session = ctx.sessions.active();
					const before = Number(message.before);
					if (!session || !Number.isFinite(before)) {
						break;
					}
					if (message.sessionId && String(message.sessionId) !== session.id) {
						break;
					}
					post({ type: 'turns', sessionId: session.id, ...history(session, before), prepend: true }, source);
					break;
				}
				case 'rebuildSummary': {
					if (running) {
						post({ type: 'notice', text: 'A turn is already running in this chat — wait for it to finish.' }, source);
						break;
					}
					const session = ctx.sessions.active();
					if (!session) {
						break;
					}
					if (message.sessionId && String(message.sessionId) !== session.id) {
						break;
					}
					const answer = await ctx.agent.compact(session.id, undefined, true);
					post({ type: 'notice', text: answer }, source);
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
					if (kind === 'file' && !ctx.references.supports('pdf')) {
						result.items = result.items.map((item) =>
							item.badge === 'pdf' ? { ...item, description: `${item.description} · PDF plugin not installed` } : item,
						);
					}
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
					// The control is the chat's, but the pick is also the default for the next chat:
					// a setting changed here outlives the session it was made in.
					const form = asForm(message.context);
					const session = ctx.sessions.active();
					if (session) {
						session.contextForm = form;
						ctx.sessions.save(session);
						ctx.sessions.changed(session.id);
					}
					await ctx.settings.update('contextForm', form);
					break;
				}
				case 'setDisplay':
					// One control for the whole transcript, so every reply renders the same way.
					await ctx.settings.update('displayForm', asForm(message.display));
					break;
				case 'setReasoningEffort': {
					// Persist the pick as well: a new chat starts from the settings, so the effort
					// chosen here carries over instead of snapping back to `auto`.
					const effort = asReasoningEffort(message.effort);
					const session = ctx.sessions.active();
					if (session) {
						session.reasoningEffort = effort;
						ctx.sessions.save(session);
						ctx.sessions.changed(session.id);
					}
					await ctx.settings.update('reasoningEffort', effort);
					break;
				}
				case 'setContextWindow': {
					const window = Math.max(0, Number(message.window) || 0);
					const session = ctx.sessions.active();
					if (session) {
						session.contextWindow = window;
						ctx.sessions.save(session);
						ctx.sessions.changed(session.id);
					}
					await ctx.settings.update('contextWindow', window);
					break;
				}
				case 'toggleNetwork':
					await ctx.settings.applyPolicy({ network: !ctx.settings.get().network });
					break;
				case 'setModel': {
					const model = String(message.model ?? 'auto');
					if (!(await ctx.llm.keyReady(model))) {
						const action = await vscode.window.showWarningMessage(
							`Comonad: ${ctx.llm.describe(model)} has no API key for its endpoint.`,
							'Configure provider…',
						);
						if (action) {
							await vscode.commands.executeCommand('comonad.configureModel');
						}
						break;
					}
					await ctx.settings.update('model', model);
					break;
				}
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
					// Only this view is forgotten — the transcript now includes the running turn, so
					// the guest can re-attach its live stream to it.
					published.delete(webviewView.webview);
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

	// The focus handoff in openChat is async: `editorTextFocus` stays true for a few frames after
	// the first press, so a fast double-press (or the macOS expandLineSelection dance) can fire
	// this twice and drop the token twice, racing the visibility-triggered full refresh. One
	// gesture, one token — the command sees no key events, so the window is time-based.
	let referenceCooldownUntil = 0;
	/** Cmd+L on a selection: the editor's lines as the `@path:lines` token in the composer. */
	const referenceSelection = async (): Promise<void> => {
		const now = Date.now();
		if (now < referenceCooldownUntil) {
			return;
		}
		referenceCooldownUntil = now + 400;
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
		const token = formatReference({ kind: 'file', path, range: { start, end: Math.max(start, end) } });
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
chatPanel.inject = ['sessions', 'agent', 'attachments', 'references', 'settings', 'llm', 'usage', 'commands', 'log', 'host'];

function splitChoices(labels: Record<string, string>): { id: string; label: string; description: string }[] {
	return Object.entries(labels).map(([id, label]) => {
		const [short, detail] = label.split(' — ');
		return { id, label: short ?? id, description: detail ?? '' };
	});
}

function asForm(value: unknown): ContextForm {
	return value === 'token' || value === 'raw' ? value : 'rendered';
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
				<button id="chats-scope" type="button" aria-pressed="false">This workspace</button>
			</div>
			<div id="chats-list"></div>
		</div>
	</div>
</header>
<main id="messages"></main>
<!-- A subagent's own conversation: the parent chat stays underneath, untouched. -->
<div id="subagent-view" hidden role="dialog" aria-modal="true" aria-label="Subagent session">
	<div id="subagent-head">
		<button id="subagent-close" type="button" class="ghost" data-tip="Back to the chat">← Back</button>
		<span id="subagent-title"></span>
		<span id="subagent-status" aria-live="polite"></span>
	</div>
	<div id="subagent-messages"></div>
</div>
<footer>
	<!-- Floats at the bottom of the transcript, above every footer row, whenever the reader has
	     scrolled away from the newest message. -->
	<button id="jump-latest" type="button" hidden data-tip="Jump to the newest message">↓ Latest</button>
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
		<div id="composer-pastes" class="composer-pastes" hidden></div>
		<div id="composer-images" class="composer-images" hidden></div>
		<textarea id="input" rows="1" spellcheck="false" autocorrect="off" autocapitalize="off" placeholder="Ask Comonad…  @ to reference code · / for commands"></textarea>
		<div id="mention" class="mention-menu" role="listbox" aria-label="Composer suggestions" hidden>
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
		<span id="environment" hidden></span>
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
