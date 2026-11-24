// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Service, type Context } from 'cordis';
import { abortable, linkAbort } from '../lib/cancel';
import type { TurnRef } from '../lib/types';
import {
	DEFAULT_OUTPUT_RESERVE,
	MIN_INPUT_BUDGET,
	buildModelHistory,
	calibrate,
	calibrationRatio,
	dropPromptAttachments,
	elideToolResults,
	hasImageAttachments,
	modelSummaryMessage,
	planCompaction,
	resolveBudget,
	resolveCompactionLimits,
	stripImageAttachments,
	type Budget,
	type CompactionLimits,
	type ContextForm,
	type RequestSample,
} from '../lib/prompt';
import { MAX_IMAGES_PER_MESSAGE } from '../lib/images';
import { attachmentNotes, imageParts } from '../lib/attachments';
import { countRaw, estimateAttachments, estimateMessages, estimateTokens, formatTokens } from '../lib/tokens';
import {
	runGraph,
	type CompiledGraph,
	type GraphRegistry,
	type NodeFn,
	type ResumeCursor,
	type RouteFn,
	type SoftRequest,
} from '../lib/graph';
import { instructionBody, loadInstructions, memoryDir, readMemory } from '../lib/instructions';
import { isContextOverflow, isImageUnsupported, isTransportFailure, type Completion } from '../lib/openai';
import {
	ALL_CAPABILITIES,
	APPROVAL_LABELS,
	callTarget,
	capabilitiesOf,
	evaluatePolicy,
	isShellCapability,
	MODE_CAPS,
	MODE_LABELS,
	SANDBOX_LABELS,
	suggestAllowRule,
	type PolicyOutcome,
	type PolicyStep,
} from '../lib/policy';
import { issueAuthorization, verifyAuthorization, type ToolAuthorization } from '../lib/authorization';
import { sandboxReads, workspaceTempDir, writeScopeFor } from '../lib/sandbox';
import {
	buildSubagentPolicy,
	parentFacts,
	SUBAGENT_CAPABILITIES,
	SUBAGENT_WRITE_CAPABILITIES,
	tightenSubagentPolicy,
	type DelegationConstraints,
} from '../lib/subagent';
import { policyRevision, policySnapshot, type CallTrace, type PolicySnapshot, type TraceContext } from '../lib/trace';
import { creationTargets, directoryTargets, rmTargets } from '../lib/shell';
import {
	COMONAD_BLOCK,
	COMONAD_BLOCKS,
	DEFAULT_BLOCK_PREFIX,
	NO_TOOLS_PREFIX,
	composeBlockText,
	type ComonadBlockId,
	type PromptBlock,
} from '../lib/blocks';
import { applyPromptLayout } from '../lib/prompt-layout';
import type {
	AgentSpawnOutcome,
	AgentSpawnRequest,
	AttachmentPart,
	CompletionUsage,
	ImageAttachment,
	Message,
	ModelContext,
	NoticeDetail,
	SessionPolicy,
	TodoItem,
	ToolCall,
	ToolContext,
	ToolImage,
	ToolSpec,
	TurnNote,
} from '../lib/types';
import type { GenerationTrigger } from '../lib/generations';
import type { ToolOutcome } from './tools';
import { describe, formatTodos, lastAssistant, lastReplyIndex } from '../lib/util';
import { allowedToolsFor, BUILTIN_ROLE_BY_ID, SUBAGENT_EXCLUDED_TOOLS, type AgentRole } from '../lib/agents';
import { buildSubagentSystemPrompt } from '../lib/agent-prompts';
import { collectShellEvidence } from '../lib/agent-evidence';
import { planRules } from '../lib/plan-rules';
import { KeyedMutex } from '../lib/locks';
import { skillLines } from './catalog';
import type { JournalApi } from '../lib/journal';
import { DEFAULT_CONTEXT_WINDOW, subagentGrant } from './settings';
import {
	budgetLabel,
	resolveSubagentBudget,
	RunBudget,
	sealPartial,
	type BudgetDimension,
	type BudgetInput,
	type BudgetLimits,
	type BudgetReport,
} from '../lib/budget';
import {
	addTurnNote,
	canRewrite,
	createdDirsInWorkspace,
	createdInWorkspace,
	createdPath,
	MAX_CREATED_PATHS,
	threadTitle,
	type Session,
	type SwipeCarry,
} from './sessions';
import { scopeOf, type ResolveResult } from './references';

/** The summary is a short, non-thinking call; it must not inherit the chat's max effort. */
const SUMMARY_MAX_TOKENS = 3_072;
const SUMMARY_TIMEOUT_MS = 60_000;
/**
 * A turn may fold at its start, again when the request grows past the headroom, and once more when
 * the provider refuses it. Each fold frees most of the window, so four is a backstop, not a cadence.
 */
const MAX_COMPACTIONS_PER_TURN = 4;
/** A provider that accepts the request but stops emitting anything must not freeze the turn. */
const MODEL_STALL_MS = 180_000;

/** Room held back for the summary a compaction adds, so the fit it plans survives its own output. */
const SUMMARY_RESERVE = SUMMARY_MAX_TOKENS + 512;

/** How many tokens of the older turns one summary is allowed to read (a cap, not the window). */
const SUMMARY_SOURCE_TOKENS = 80_000;

/** A summary larger than this is clipped; it is model context, not a second transcript. */
const SUMMARY_TEXT_LIMIT = 8_000;

/** The reply a continue extends: the last thing the model said, when nothing came after it. */
function continuationIndex(transcript: readonly Message[]): number | undefined {
	const at = lastReplyIndex(transcript);
	return at >= 0 && at === transcript.length - 1 ? at : undefined;
}

export interface TurnInput {
	/** The prompt. Empty for a continue, a swipe or a regenerate, which re-run what is already there. */
	text: string;
	/** Typed context to send with this prompt; already stored, so only metadata travels. */
	attachments?: AttachmentPart[];
	sessionId?: string;
	policy?: Partial<SessionPolicy>;
	/** Identifies the calling surface; events and approvals are routed by it. */
	surface?: string;
	signal?: AbortSignal;
	/**
	 * How this generation was started. It decides how the reply is written down; `normal` is a plain
	 * prompt.
	 */
	trigger?: GenerationTrigger;
	/** Re-run the existing prompt at this transcript index, discarding it and every later turn. */
	rewriteAt?: number;
	/**
	 * Called after UserPromptSubmit allowed the turn and before the transcript is cut. The surface
	 * restores files here and announces the turn. Return false to cancel with nothing changed.
	 */
	prepareRewrite?: (session: Session) => Promise<boolean>;
	/**
	 * Native references a surface already holds (VS Code's `request.references`). Called after hooks
	 * and a rewrite cut, so a blocked prompt never pays for the read. `@` tokens are resolved by the
	 * agent itself; this hook is only for references that are not spelled as tokens.
	 */
	resolveAttachments?: (session: Session, signal: AbortSignal) => Promise<ResolveResult | undefined>;
}

export interface TurnResult {
	sessionId: string;
	text: string;
	/** The turn ended because the user stopped it, not because the model or a hook finished. */
	stopped?: boolean;
	/** A native budget stopped this turn; `text` is the partial output. */
	budget?: BudgetReport;
	/** False when the prompt was refused before it reached the transcript; the panel restores it. */
	promptKept?: boolean;
}

/** One running turn: the signal every part of it shares, from prompt building to the last tool. */
interface Turn {
	session: Session;
	ref: TurnRef;
	controller: AbortController;
	signal: AbortSignal;
	unlink: () => void;
}

/** Per-turn summary state, so a broken or pointless summarizer cannot retry on every graph step. */
interface CompactionGuard {
	attempts: number;
	failed: boolean;
	notified: boolean;
	/** The once-per-turn tool-output trim notice has been shown. */
	trimmed: boolean;
	/** There is nothing new to fold this turn; do not ask again until the next turn. */
	blocked: boolean;
}

interface RunState {
	ref: TurnRef;
	sessionId: string;
	/** The chat whose journal, provenance and review collect this run's writes. */
	rootSessionId: string;
	/** The subagent's name, for the audit trail; absent on the main agent. */
	agentName?: string;
	/** The orchestration task this child is running, when known. */
	taskId?: string;
	/** Workspace-relative files this run wrote through the tracked file tools. */
	writes: Set<string>;
	/** The four native budgets for this run segment; absent means unlimited. */
	budget?: RunBudget;
	/** The first exhausted dimension. The run stops at the next message boundary. */
	stop?: BudgetDimension;
	/** Per-turn summary attempts, so a broken summarizer cannot retry on every graph step. */
	compaction?: CompactionGuard;
	/** The last tool call this run attempted, for partial reports. */
	lastTool?: string;
	policy: SessionPolicy;
	/** The model this turn already had to send without images (a reset, not a capability verdict). */
	imagesOff?: string;
	transcript: Message[];
	messages: Message[];
	/** The Context form used to build `messages`, so a rebuild applies the same filtering. */
	contextForm: ContextForm;
	/** Request-only messages appended after the history (the ask for a continue/impersonation). */
	trailer: Message[];
	/** The model-context version `messages` was built from; a resume rebuilds when it moved. */
	modelContextVersion?: number;
	toolCalls: ToolCall[];
	/** One decision-trace handle per entry of `toolCalls`, in the same order. */
	traces?: CallTrace[];
	/** The chat turn this run belongs to, recorded on every trace. */
	turn: number;
	gateReason: string;
	/** The current tool batch; an authorization is bound to it. */
	batch: number;
	/** The user's answer to this batch's approval, when the gate asked for one. */
	approval?: { allowed: boolean; reason: string };
	/** The gate's final decision for this batch. */
	outcome?: PolicyOutcome;
	/** The gate's single-use grant for an allowed batch; the tools node consumes it. */
	authorization?: ToolAuthorization;
	filter?: { allow?: string[] };
	/**
	 * Whether this turn may offer tools at all: the core layout's Tools block. `undefined` (a
	 * subagent) leaves the policy's own list in charge.
	 */
	toolsEnabled?: boolean;
	/** What started this turn, which decides how the reply gets written down. */
	trigger: GenerationTrigger;
	/** The transcript as it stood before this turn, which is what a quiet generation leaves behind. */
	prior: Message[];
	/** The exchange a swipe or a regenerate replaced, put back if the turn is stopped. */
	restore?: Message[];
	/** Fold markers as they stood before a swipe/regenerate cut, restored with `restore`. */
	restoreNotes?: TurnNote[];
	/** The reply a continue extends: its index in the transcript as it stood before this turn. */
	continueInto?: number;
	/** The variants a swipe or a regenerate replaces or grows. */
	swipes?: SwipeCarry;
	/**
	 * Whether this request may be rebuilt from the chat's transcript when it outgrows the window. It is
	 * true for a chat turn and false when a subagent owns the request, because then its parts no longer
	 * line up with a chat record and only elision may rewrite it.
	 */
	foldable: boolean;
}

/** What a continue says as the user when there is a reply to carry on. */
/**
 * The generation types that write nothing into the chat and run no tools: an impersonation streams into the
 * composer, and a quiet turn is the caller's alone. Neither is a turn the chat has taken.
 */
const SILENT_TRIGGERS: ReadonlySet<GenerationTrigger> = new Set<GenerationTrigger>(['impersonate', 'quiet']);

const CONTINUE_ASK = 'Continue the last message exactly where it stops. Do not repeat any of it, and do not start over.';

/** The display name of a Comonad block. */
const BLOCK_NAMES = new Map<ComonadBlockId, string>(COMONAD_BLOCKS.map((block) => [block.id, block.name]));

function blockName(id: ComonadBlockId): string {
	return BLOCK_NAMES.get(id) ?? id;
}

/**
 * A continuation is appended to the text it continues. The model usually starts where the text stops
 * with a space of its own; this only supplies one when neither side brought it.
 */
function joins(text: string, reply: string): string {
	return !text || /\s$/.test(text) || /^\s/.test(reply) ? reply : ` ${reply}`;
}

/** The title of a subagent's hidden conversation, short enough for the panel header. */
function subagentTitle(name: string, description?: string): string {
	const label = description?.replace(/\s+/g, ' ').trim();
	return label ? `Subagent: ${name} — ${clip(label, 60)}` : `Subagent: ${name}`;
}

/** A call id safe to use as a link key; a delegation without one simply has no card link. */
function callIdOf(request: AgentSpawnRequest): string | undefined {
	const callId = request.callId?.trim();
	if (!callId || callId.length > 200 || callId === '__proto__' || callId === 'prototype' || callId === 'constructor') {
		return undefined;
	}
	return callId;
}

const MAX_SUBAGENTS = 4;

declare module 'cordis' {
	interface Context {
		agent: Agent;
	}
}

/**
 * The turn pipeline: one tool-loop graph per turn, wiring policy gates, hooks,
 * checkpoints, usage and subagents. UI never assembles prompts — surfaces call
 * `ctx.agent.runTurn()` and watch `agent/*` events.
 */
export class Agent extends Service {
	static inject = ['host', 'settings', 'graphs', 'sessions', 'attachments', 'references', 'tools', 'llm', 'hooks', 'catalog', 'commands', 'tokenizers', 'usage', 'tasks', 'approval', 'audit', 'decisions', 'orchestrator', 'log'];

	private readonly turns = new Map<string, Turn>();
	/** Session → the model that refused images there. A different model gets to try them again. */
	private readonly imagesOff = new Map<string, string>();
	/** `${sessionId}\0${root}` already merged from the journal in this process. */
	private readonly createdBackfilled = new Set<string>();
	private readonly todoLists = new Map<string, TodoItem[]>();
	private readonly pending = new Map<string, string[]>();
	private readonly greeted = new Set<string>();
	private readonly budgetWarned = new Set<string>();
	/** The system prompt last given to each chat, so `/context` can break the budget down exactly. */
	private readonly systems = new Map<string, string>();
	/** The blocks the last prompt build produced, so a pane can preview generated text synchronously. */
	private readonly lastBlocks = new Map<string, readonly PromptBlock[]>();
	/** Whether the last turn's request offered tools, which decides `/context`'s tool overhead. */
	private readonly toolModes = new Map<string, boolean>();
	/** Sessions already told that their stored model profile is gone. */
	private readonly warned = new Set<string>();
	private activeSubagents = 0;
	/** Children waiting for a subagent slot; the queue makes a large delegate batch wait, not fail. */
	private readonly subagentWaiters: { start: () => void; abort: () => void; signal: AbortSignal }[] = [];
	/** Live subagent sessions, so policy tightening edits the same object the child's run saves. */
	private readonly subagentSessions = new Map<string, Session>();
	/** One write runs at a time per absolute path; different files run concurrently. */
	private readonly writeLocks = new KeyedMutex();
	/** The turn's restore mark is pushed once, even when parallel children write at the same time. */
	private readonly markLocks = new KeyedMutex();

	constructor(ctx: Context) {
		super(ctx, 'agent');
		// The graph engine is its own plugin. The turn's nodes are registered here, and removed with
		// this service, so a reloaded tree cannot leave a stale node behind.
		const { nodes, routes } = this.graphRegistry();
		ctx.effect(() => {
			const offs = [
				...[...nodes].map(([name, fn]) => ctx.graphs.registerNode(name, fn)),
				...[...routes].map(([name, fn]) => ctx.graphs.registerRoute(name, fn)),
			];
			return () => {
				for (const off of offs) {
					off();
				}
			};
		}, 'agent graph nodes');
		ctx.effect(() => () => {
			for (const turn of this.turns.values()) {
				turn.controller.abort();
			}
		});
	}

	/** Snapshot of the current settings as a session policy. */
	policyFor(): SessionPolicy {
		const config = this.ctx.settings.get();
		return {
			workMode: config.mode,
			capabilities: [...MODE_CAPS[config.mode]],
			rules: this.ctx.settings.rules(),
			approval: config.approval,
			approvalResponse: config.approvalResponse,
			network: config.network,
			sandboxMode: config.sandboxMode,
			workingDirectory: config.workingDirectory,
			commandTimeout: config.commandTimeout,
			commandTimeoutOverride: config.commandTimeoutOverride,
			denyReadPaths: [...config.denyReadPaths],
			planDirectory: config.planDirectory,
			budget: { ...config.budget },
			model: config.model,
		};
	}

	/** The live session of a running turn, for code that must see what the turn has written so far. */
	private turnSession(sessionId: string): Session | undefined {
		return this.turns.get(sessionId)?.session;
	}

	/**
	 * Opens a turn: one controller, linked to any surface signal, registered synchronously. A second
	 * turn for the same chat is refused rather than allowed to overwrite this one's signal.
	 */
	private beginTurn(session: Session, ref: TurnRef, text: string, external?: AbortSignal): Turn | null {
		if (this.turns.has(session.id)) {
			return null;
		}
		const controller = new AbortController();
		const turn: Turn = {
			session,
			ref,
			controller,
			signal: controller.signal,
			unlink: linkAbort(external, controller),
		};
		this.turns.set(session.id, turn);
		this.ctx.emit('agent/turn-start', ref, text);
		return turn;
	}

	private endTurn(turn: Turn): void {
		turn.unlink();
		if (this.turns.get(turn.session.id) === turn) {
			this.turns.delete(turn.session.id);
		}
		// A normal finish settles any request that somehow outlived the turn (an approval card left
		// after a repaint); an aborted turn is already settled and this is a no-op.
		turn.controller.abort();
		this.ctx.emit('agent/turn-end', turn.ref);
	}

	async runTurn(input: TurnInput): Promise<TurnResult> {
		let text = input.text.trim();
		const trigger: GenerationTrigger = input.trigger ?? 'normal';
		if (input.rewriteAt !== undefined && trigger !== 'normal') {
			return { sessionId: input.sessionId ?? '', text: 'Error: only a new prompt can be edited.', promptKept: false };
		}
		const replay = trigger === 'swipe' || trigger === 'regenerate';
		const target = replay ? (input.sessionId ?? this.ctx.sessions.active()?.id ?? '') : '';
		// A swipe cuts the stored transcript as it starts: refuse it before the cut, not after.
		if (target && this.turns.has(target)) {
			return { sessionId: target, text: 'Error: a turn is already running in this chat.', promptKept: false };
		}
		// A swipe or a regenerate re-runs the prompt that is already there: the reply it produced is
		// dropped here, and the variants it had are handed to `finish` so none of them is lost. What
		// the turn replaced is kept too: a stopped generation puts that exchange back.
		let swipes: SwipeCarry | undefined;
		let attachments = input.attachments;
		let restore: Message[] | undefined;
		let restoreNotes: TurnNote[] | undefined;
		if (replay) {
			swipes = target ? this.ctx.sessions.swipeCarry(target) : undefined;
			const replayed = target ? this.ctx.sessions.replayLast(target) : { text: '', replaced: [], notes: [] };
			if (!replayed.text && !replayed.attachments?.length) {
				return { sessionId: target, text: 'There is nothing to generate again yet.' };
			}
			text = replayed.text;
			// A replayed prompt brings its attachments back; an explicit new set wins.
			attachments = input.attachments?.length ? input.attachments : replayed.attachments;
			restore = replayed.replaced;
			restoreNotes = replayed.notes;
		}
		const session = input.sessionId ? (this.ctx.sessions.get(input.sessionId) ?? this.ctx.sessions.ensureActive(this.policyFor())) : this.ctx.sessions.ensureActive(this.policyFor());
		// A replay cuts the last exchange before the turn begins. If the turn is refused, put that
		// exchange back instead of leaving the chat without the prompt or the reply it replaced.
		const restoreReplay = (): void => {
			if (!restore) {
				return;
			}
			session.transcript = restore;
			session.notes = restoreNotes?.length ? restoreNotes : undefined;
			this.ctx.sessions.invalidateModelContext(session, restore.length);
			this.ctx.sessions.save(session);
			this.ctx.sessions.changed(session.id);
		};
		if (!text && !attachments?.length && !input.resolveAttachments && trigger !== 'continue' && trigger !== 'impersonate') {
			return { sessionId: session.id, text: '' };
		}
		// A continuation is written into the reply it carries on, so there has to be one: in a chat
		// that has said nothing yet the answer would hang on no message at all.
		if (trigger === 'continue' && !session.transcript.length) {
			return { sessionId: session.id, text: 'There is nothing to continue yet.' };
		}
		if (session.cursor) {
			restoreReplay();
			return {
				sessionId: session.id,
				text: 'This session has a suspended tool call. Run "Comonad: Resume Suspended Turn" to continue it.',
				promptKept: false,
			};
		}
		// A stale index must not fire the session hooks or drain pending contexts for a prompt that
		// cannot be replaced; `rewriteAt` validates again after the hooks, before it cuts.
		if (input.rewriteAt !== undefined && !canRewrite(session, input.rewriteAt)) {
			restoreReplay();
			return { sessionId: session.id, text: 'Error: that message is not a prompt that can be edited.', promptKept: false };
		}
		const ref: TurnRef = { sessionId: session.id, surface: input.surface };
		// A continue and an impersonation add no prompt of their own: the conversation is already there,
		// and quiet throws its prompt away again at the end.
		const prompted = trigger !== 'continue' && trigger !== 'impersonate';
		const turn = this.beginTurn(
			session,
			ref,
			prompted ? text : (session.transcript[session.transcript.length - 1]?.content ?? ''),
			input.signal,
		);
		if (!turn) {
			restoreReplay();
			return { sessionId: session.id, text: 'Error: a turn is already running in this chat.', promptKept: false };
		}
		// The prompt keeps the time it was asked at however often the transcript is re-derived below, so
		// a compaction in the middle of this turn cannot make it look like a later message.
		const askedAt = Date.now();
		const seed = (): Message[] =>
			prompted ? [...session.transcript, { role: 'user', content: text, attachments, at: askedAt } as Message] : [...session.transcript];
		// Whether the rewrite has cut the transcript, and whether the seeded prompt has been saved.
		// The catch below uses them to leave a stopped turn in a state a reload can reproduce.
		let cut = false;
		let committed = false;
		try {
			// A surface can stop the turn before the first await; nothing below should start.
			turn.signal.throwIfAborted();
			if (session.subagent && session.parentId) {
				// A delegated session keeps its snapshot; a parent that is still present may only
				// tighten it further. Settings do not overwrite it.
				session.policy = this.tightenChildSession(session) ?? session.policy;
			} else {
				const policy = { ...session.policy, ...this.policyFor(), ...(input.policy ?? {}) };
				// A slash command can replace the mode for this turn; the capability set follows it unless
				// the caller supplied an explicit set.
				if (input.policy?.workMode && input.policy.capabilities === undefined) {
					policy.capabilities = [...MODE_CAPS[input.policy.workMode]];
				}
				session.policy = policy;
				// A node left running by a crashed or stopped turn cannot be awaited any more.
				this.ctx.orchestrator.recover(session);
			}
			if (session.modelContext && !this.ctx.sessions.verifyModelContext(session)) {
				this.notice(ref, 'The stored summary no longer matches the chat; it was dropped from the model context.');
			}
			if (!this.ctx.llm.known(session.policy.model) && !this.warned.has(session.id)) {
				// The chat remembers a model that no longer exists; say which one runs instead, once.
				this.warned.add(session.id);
				this.notice(
					{ sessionId: session.id, surface: input.surface },
					`model profile "${session.policy.model}" is gone — using ${this.ctx.llm.describe('auto')}. Pick one from the model menu.`,
				);
			}
			if (session.title === 'New session' && (text || attachments?.length)) {
				session.title = text ? threadTitle(text) : 'Attachment prompt';
			}
			const config = this.ctx.settings.get();
			const contexts: string[] = [];
			if (!this.greeted.has(session.id)) {
				this.greeted.add(session.id);
				const start = await abortable(
					turn.signal,
					this.ctx.hooks.fire('SessionStart', undefined, { session_id: session.id, cwd: session.policy.workingDirectory }),
				);
				contexts.push(...start.contexts);
			}
			const submitted = await abortable(
				turn.signal,
				this.ctx.hooks.fire('UserPromptSubmit', undefined, { session_id: session.id, prompt: text }),
			);
			if (submitted.blocked) {
				restoreReplay();
				return {
					sessionId: session.id,
					text: `Blocked by hook: ${submitted.reason ?? 'no reason given'}`,
					promptKept: false,
				};
			}
			contexts.push(...submitted.contexts, ...this.ctx.hooks.drainContexts(), ...(this.pending.get(session.id) ?? []));
			this.pending.delete(session.id);
			// An edit cuts the transcript only after the prompt hook accepted the turn, so a blocked edit
			// leaves the old prompt in place. The surface restores files and announces the turn here; a
			// refusal from it cancels the whole operation.
			const previous = input.rewriteAt !== undefined ? session.transcript[input.rewriteAt] : undefined;
			if (input.rewriteAt !== undefined) {
				// A restore is not raced: abandoning it halfway would leave the workspace inconsistent.
				if (input.prepareRewrite && !(await input.prepareRewrite(session))) {
					restoreReplay();
					return { sessionId: session.id, text: '', promptKept: false };
				}
				// The cut follows the restore without an abort check: once files are rolled back, leaving
				// the later turns in the chat would make the transcript disagree with the workspace. A
				// stop from here ends the reply, and the catch below keeps the edited prompt.
				// The edited prompt replaces the old one text for text; its attachments stay unless the
				// editor supplied a new set. Read them before the cut removes the message.
				if (!input.attachments?.length) {
					attachments = previous?.attachments;
				}
				const problem = this.ctx.sessions.rewriteAt(session, input.rewriteAt);
				if (problem) {
					restoreReplay();
					return { sessionId: session.id, text: `Error: ${problem}`, promptKept: false };
				}
				cut = true;
			}
			// User references are resolved after the cut and the policy merge, then seeded into the user
			// message. Hooks' contexts stay in the system block; a replay reuses the stored snapshot and
			// never reads a file again.
			if (prompted && !replay) {
				const samePrompt = input.rewriteAt !== undefined && previous !== undefined && text === previous.content;
				if (samePrompt) {
					if (input.attachments?.length) {
						attachments = [
							...input.attachments,
							...(previous.attachments ?? []).filter((part) => part.origin === 'reference'),
						];
					}
				} else {
					const base = input.rewriteAt !== undefined
						? (input.attachments?.length ? input.attachments : (previous?.attachments ?? []).filter((part) => part.origin === 'user'))
						: (input.attachments ?? []);
					let resolved: ResolveResult = { attachments: [] };
					let native: ResolveResult | undefined;
					try {
						if (text.trim()) {
							resolved = await abortable(turn.signal, this.ctx.references.resolve(text, scopeOf(session.policy), turn.signal));
						}
					} catch (error) {
						if (turn.signal.aborted) {
							throw error;
						}
						this.ctx.log.message(`references: ${describe(error)}`);
					}
					try {
						if (input.resolveAttachments) {
							native = await abortable(turn.signal, input.resolveAttachments(session, turn.signal));
						}
					} catch (error) {
						if (turn.signal.aborted) {
							throw error;
						}
						this.ctx.log.message(`references: ${describe(error)}`);
					}
					attachments = [...base, ...resolved.attachments, ...(native?.attachments ?? [])];
					for (const notice of [...(resolved.notices ?? []), ...(native?.notices ?? [])]) {
						this.notice(ref, notice);
					}
					for (const error of [...(resolved.errors ?? []), ...(native?.errors ?? [])]) {
						this.notice(ref, `reference ${error.token}: ${error.message}`);
					}
				}
				if (attachments?.length) {
					const completed: AttachmentPart[] = [];
					for (const part of attachments) {
						try {
							completed.push(
								part.kind === 'document' && part.text === undefined && !part.textUnavailable
									? await abortable(turn.signal, this.ctx.references.completeDocument(part, turn.signal))
									: part,
							);
						} catch (error) {
							if (turn.signal.aborted) {
								throw error;
							}
							this.ctx.log.message(`references: ${describe(error)}`);
							completed.push(part);
						}
					}
					attachments = completed;
					this.ctx.emit('agent/attachments', ref, attachments);
				}
			}
			turn.signal.throwIfAborted();
			// No snapshot here: a turn is journaled file by file, as the agent actually writes each one.
			let prior = [...session.transcript];
			let seeded = seed();
			// A continue grows the last reply, and only when nothing comes after it. A turn that was
			// stopped, is waiting on a tool call, or failed leaves the transcript ending in something else
			// — merging there would cut that away. With nothing to grow, the answer is a turn of its own.
			// It is derived again whenever a fold rewrites the transcript the turn is running on.
			let continueInto = trigger === 'continue' ? continuationIndex(seeded) : undefined;
			// The prompt belongs to the chat before any model call. Turn-start compaction can take a
			// while, and a reload or resync during it must still find this message: without it the
			// webview repaints the previous turns and binds the live stream to the wrong one.
			if (prompted && !SILENT_TRIGGERS.has(trigger)) {
				session.transcript = seeded;
				committed = true;
				this.ctx.sessions.save(session);
				this.ctx.audit.write(session.id, {
					kind: 'user',
					text: clip(text, 2_000),
					images: attachmentNotes(attachments),
				});
			}
			// What the model is asked to do when the turn carries no prompt of its own. It is also said *as a
			// turn*: a request whose last turn is the model's own is completed by OpenAI but refused outright
			// by Gemini ("Requests ending with a model turn are not supported").
			let ask = '';
			if (trigger === 'continue') {
				if (continueInto !== undefined) {
					contexts.push(CONTINUE_ASK);
				}
				// The ask itself is always there to be sent: a turn that was cut short before it said anything
				// still leaves the model's own turn last, and that is the request Gemini refuses.
				ask = CONTINUE_ASK;
			}
			if (trigger === 'impersonate') {
				const impersonation = 'Write the next message of this conversation as the user, in their voice, and nothing else.';
				// The words stand in the system prompt as well: an impersonation whose history already ends on
				// your own turn has nowhere else to be said.
				contexts.push(impersonation);
				ask = impersonation;
			}
			const blocks = await abortable(turn.signal, this.promptBlocks(session, contexts, trigger));
			// The user's block order and switches apply to the system prompt.
			const system = promptText(applyPromptLayout(blocks, config.prompts));
			// The context budget and every counter in the panels read the same counter, so the model's own
			// tokenizer is made exact before anything is measured with it.
			await abortable(turn.signal, this.ctx.tokenizers.warm(this.ctx.llm.modelName(session.policy.model)));
			// A silent generation is offered no tools, so its budget is measured without them.
			const tools = SILENT_TRIGGERS.has(trigger) ? [] : this.ctx.tools.visible(session.policy);
			const budget = this.budgetFor(session.policy, session.contextWindow, system, tools);
			const room = this.roomFor(budget);
			const toolCost = this.toolTokens(tools);
			const form = session.contextForm ?? config.contextForm;
			let history = buildModelHistory(seeded, session.modelContext, form);
			const compaction: CompactionGuard = { attempts: 0, failed: false, notified: false, trimmed: false, blocked: false };
			const model = session.policy.model;
			const preview = (): Message[] => [{ role: 'system', content: system } as Message, ...history];
			const pressure = (): number => this.pressure(session, model, preview(), toolCost);
			// Compaction only changes the model context: the canonical transcript (and every index into
			// it, including prior/restore/continueInto) stays exactly where it was.
			if (room.enabled) {
				if (pressure() >= room.trigger) {
					const before = pressure();
					const previousCovers = session.modelContext?.covers ?? 0;
					compaction.attempts += 1;
					try {
						const context = await this.compactContext(
							session,
							seeded,
							this.compactTail(room, session, model),
							budget.window,
							undefined,
							turn.signal,
							false,
							(usage) => this.recordSummaryUsage(session, usage),
						);
						if (context) {
							history = buildModelHistory(seeded, context, form);
							this.announceCompaction(session, ref, trigger, context, {
								before,
								after: pressure(),
								folded: context.covers - previousCovers,
								window: budget.window,
							});
						} else {
							compaction.blocked = true;
						}
					} catch (error) {
						if (turn.signal.aborted) {
							throw error;
						}
						compaction.failed = true;
						this.ctx.log.message(`summarize failed: ${describe(error)}`);
						if (!compaction.notified) {
							compaction.notified = true;
							this.notice(ref, `Could not summarize the conversation (${describe(error)}); continuing without a summary.`);
						}
					}
				}
				// A current turn that still cannot fit the reply-reserved window is trimmed; a successful
				// fold leaves the request far below it.
				if (pressure() > budget.window - budget.reserve) {
					const elided = elideToolResults(history, this.rawBodyLimit(budget, session, model));
					if (elided.changed) {
						history = elided.messages;
						if (!compaction.trimmed) {
							compaction.trimmed = true;
							this.notice(ref, 'Trimmed older tool output to fit the model’s window.');
						}
					}
				}
			} else if (estimateMessages(history) > budget.input) {
				// Legacy hard-budget path: proactive compaction is off.
				compaction.attempts += 1;
				try {
					const context = await this.compactContext(
						session,
						seeded,
						this.legacyTail(session, budget),
						budget.window,
						undefined,
						turn.signal,
						false,
						(usage) => this.recordSummaryUsage(session, usage),
					);
					if (context) {
						history = buildModelHistory(seeded, context, form);
					}
				} catch (error) {
					if (turn.signal.aborted) {
						throw error;
					}
					compaction.failed = true;
					this.ctx.log.message(`summarize failed: ${describe(error)}`);
					if (!compaction.notified) {
						compaction.notified = true;
						this.notice(ref, `Could not summarize the conversation (${describe(error)}); continuing with trimmed history.`);
					}
					history = elideToolResults(history, budget.input).messages;
				}
			}
			const messages = [{ role: 'system', content: system } as Message, ...history];
			// Request-only messages live outside the rebuilt history: a continue or an impersonation may
			// append an ask, and a rebuild must not silently drop it.
			const trailer: Message[] = [];
			if (ask && messages[messages.length - 1]?.role !== 'user') {
				const message = { role: 'user', content: ask, at: Date.now() } as Message;
				messages.push(message);
				trailer.push(message);
			}
			// The Tools block gates the whole request.
			const toolsEnabled = config.prompts.find((entry) => entry.id === COMONAD_BLOCK.tools)?.enabled !== false;
			// `/context` reads the system prompt and the tool overhead that were actually sent.
			this.systems.set(session.id, system);
			this.toolModes.set(session.id, toolsEnabled);
			const state: RunState = {
				ref,
				sessionId: session.id,
				rootSessionId: session.parentId ?? session.id,
				agentName: session.subagent,
				writes: new Set(),
				budget: new RunBudget(session.policy.budget ?? {}),
				policy: session.policy,
				transcript: seeded,
				messages,
				contextForm: form,
				trailer,
				modelContextVersion: session.modelContext?.version,
				toolCalls: [],
				filter: session.subagent ? { allow: session.policy.tools ?? [] } : undefined,
				turn: session.turnIndex,
				gateReason: '',
				batch: 0,
				compaction,
				toolsEnabled,
				trigger,
				prior,
				restore,
				restoreNotes,
				continueInto,
				swipes,
				foldable: true,
			};
			if (!committed) {
				session.transcript = seeded;
				committed = true;
				this.ctx.sessions.save(session);
				this.ctx.audit.write(session.id, { kind: 'user', text: clip(text, 2_000), images: attachmentNotes(attachments) });
			}
			return await this.execute(session, state, turn);
		} catch (error) {
			if (turn.signal.aborted) {
				// A stop ends the answer, not the prompt: keep what the panel already drew. A swipe puts
				// back the exchange it replaced; an edit that never cut has nothing of its own to keep.
				let keep: Message[] | undefined;
				if (restore) {
					keep = restore;
				} else if (!committed && !SILENT_TRIGGERS.has(trigger) && (input.rewriteAt === undefined || cut)) {
					keep = seed();
				}
				if (keep) {
					session.transcript = keep;
					if (restore && restoreNotes) {
						session.notes = restoreNotes.length ? restoreNotes : undefined;
					}
					this.ctx.sessions.invalidateModelContext(session, keep.length);
					this.ctx.sessions.save(session);
					this.ctx.sessions.changed(session.id);
				}
				return { sessionId: session.id, text: '', stopped: true };
			}
			// A failure before the prompt was committed must not erase it. Keep the same exchange the
			// abort path would, then report the error through the normal result rather than throwing
			// out of the panel's send (which would settle the turn with a transcript missing the text).
			let keep: Message[] | undefined;
			if (restore) {
				keep = restore;
			} else if (!committed && !SILENT_TRIGGERS.has(trigger) && (input.rewriteAt === undefined || cut)) {
				keep = seed();
			}
			if (keep) {
				session.transcript = keep;
				if (restore && restoreNotes) {
					session.notes = restoreNotes.length ? restoreNotes : undefined;
				}
				this.ctx.sessions.invalidateModelContext(session, keep.length);
				this.ctx.sessions.save(session);
				this.ctx.sessions.changed(session.id);
			}
			this.ctx.log.message(`turn failed: ${describe(error)}`);
			return {
				sessionId: session.id,
				text: `Error: ${describe(error)}`,
				promptKept: committed || keep !== undefined,
			};
		} finally {
			this.endTurn(turn);
		}
	}

	/** Continues the suspended tool call of a session (after approval). */
	async resume(sessionId: string, options: { surface?: string; signal?: AbortSignal } = {}): Promise<TurnResult> {
		const session = this.ctx.sessions.require(sessionId);
		const cursor = session.cursor;
		if (!cursor || !Array.isArray(cursor.payload)) {
			if (cursor) {
				session.cursor = null;
				this.ctx.sessions.save(session);
			}
			return { sessionId, text: 'This session has no suspended turn.' };
		}
		const state = cursor.state as RunState;
		const ref: TurnRef = { sessionId, surface: options.surface ?? state.ref.surface };
		const turn = this.beginTurn(session, ref, session.transcript[session.transcript.length - 1]?.content ?? '', options.signal);
		if (!turn) {
			return { sessionId, text: 'Error: a turn is already running in this chat.' };
		}
		try {
			const answer = await this.ctx.approval.request({
				calls: cursor.payload as ToolCall[],
				reason: 'resume the suspended turn',
				surface: options.surface,
				sessionId,
				signal: turn.signal,
				response: session.policy.approvalResponse,
			});
			// A stop during the resume prompt leaves the original suspension intact and resumable.
			if (turn.signal.aborted) {
				return { sessionId, text: '', stopped: true };
			}
			state.policy = session.policy;
			const approvalReason =
				answer === 'deny'
					? state.policy.approvalResponse === 'never'
						? 'the approval response policy denies without asking'
						: 'the approval surface denied the resumed call'
					: 'the approval surface allowed the resumed call';
			state.ref.surface = options.surface ?? state.ref.surface;
			this.ctx.sessions.verifyModelContext(session);
			// A manual summary may have moved the model context while the turn was suspended. Rebuild
			// the model-facing messages from the canonical transcript; the suspended work is untouched.
			if (state.modelContextVersion !== session.modelContext?.version) {
				const systems = state.messages.filter((message) => message.role === 'system' && !message.summarized);
				state.messages = [
					...systems,
					...buildModelHistory(state.transcript, session.modelContext, state.contextForm ?? this.ctx.settings.get().contextForm),
					...(state.trailer ?? []),
				];
				state.modelContextVersion = session.modelContext?.version;
			}
			session.cursor = null;
			this.ctx.sessions.save(session);
			return await this.execute(session, state, turn, {
				node: cursor.node,
				value: { allowed: answer !== 'deny', reason: approvalReason },
				payload: cursor.payload,
				step: cursor.step,
			});
		} catch (error) {
			if (turn.signal.aborted) {
				return { sessionId, text: '', stopped: true };
			}
			throw error;
		} finally {
			this.endTurn(turn);
		}
	}

	/**
	 * Summarizes the conversation on demand. The cut keeps only the turns after the last prompt: what
	 * a reader asking for this wants is the conversation folded now, not a tail that happens to fit.
	 */
	async compact(sessionId: string, instructions?: string, rebuild = false): Promise<string> {
		const session = this.ctx.sessions.require(sessionId);
		const before = session.modelContext?.covers ?? 0;
		const context = await this.compactContext(
			session,
			session.transcript,
			0,
			this.windowFor(session),
			instructions,
			undefined,
			rebuild,
		);
		if (!context) {
			return 'Nothing to compact yet.';
		}
		return rebuild
			? `Rebuilt the model summary from ${context.covers} messages (the full chat is kept).`
			: `Summarized ${Math.max(0, context.covers - before)} more messages for the model context (${context.covers} total).`;
	}

		/** The input budget of one request: the window, less the reply's share, less the fixed part. */
	private budgetFor(policy: SessionPolicy, window: number | undefined, system: string, tools: ToolSpec[]): Budget {
		const profile = this.ctx.llm.profileFor(policy.model);
		return resolveBudget(
			this.windowOf(policy, window),
			policy.maxTokens ?? profile?.maxTokens ?? DEFAULT_OUTPUT_RESERVE,
			estimateTokens(system) + this.toolTokens(tools),
		);
	}

	/** The window a chat is measured against, for the surfaces that show it. */
	windowFor(session: Session): number {
		return this.windowOf(session.policy, session.contextWindow);
	}

	/**
	 * The window before the reply's share and the fixed part come off: the chat's own override, else
	 * the model profile's, else the documented fallback. A subagent passes its own policy and no
	 * override, so it is measured against the window of the model it runs on rather than its parent's.
	 */
	private windowOf(policy: SessionPolicy, override: number | undefined): number {
		return override || this.ctx.llm.profileFor(policy.model)?.contextWindow || DEFAULT_CONTEXT_WINDOW;
	}

	/**
	 * What the tool definitions cost. They travel with every request of the turn, so they are part of
	 * the budget rather than part of the conversation — which is why a window's headline number is
	 * never the amount of chat that fits.
	 */
	private toolTokens(tools: ToolSpec[]): number {
		return estimateTokens(
			JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))),
		);
	}

	/** The provider count paired with the local estimate for the same request, when it is usable. */
	private requestSample(session: Session | undefined, model: string): RequestSample | undefined {
		if (!session?.lastInputTokens || !session.lastEstimateTokens) {
			return undefined;
		}
		// A different model has a different tokenizer; wait for its first measurement.
		if (session.lastInputModel && session.lastInputModel !== model) {
			return undefined;
		}
		return { input: session.lastInputTokens, estimate: session.lastEstimateTokens };
	}

	/** What the provider is likely to count for this whole request. */
	private pressure(session: Session | undefined, model: string, messages: readonly Message[], toolCost: number): number {
		return calibrate(estimateMessages(messages) + Math.max(0, toolCost), this.requestSample(session, model));
	}

	/** Where this request compacts and how much it may keep; the settings are read live. */
	private roomFor(budget: Budget): CompactionLimits & { overhead: number; window: number } {
		const config = this.ctx.settings.get();
		const limits = resolveCompactionLimits(
			budget.window,
			budget.reserve,
			config.compactionHeadroom,
			config.compactionRetainPercent,
		);
		return {
			...limits,
			enabled: limits.enabled && budget.input >= MIN_INPUT_BUDGET,
			overhead: budget.overhead,
			window: budget.window,
		};
	}

	/** A provider-scale limit, in the raw units the estimator and planner use. */
	private rawLimit(tokens: number, session: Session | undefined, model: string): number {
		return Math.floor(Math.max(0, tokens) / calibrationRatio(this.requestSample(session, model)));
	}

	/** How much of the body may stay before the reply-reserved window is exceeded. */
	private rawBodyLimit(budget: Budget, session: Session | undefined, model: string): number {
		const raw = this.rawLimit(budget.window - budget.reserve, session, model) - budget.overhead;
		return Math.max(0, Math.min(budget.input, raw));
	}

	/** The verbatim tail one proactive fold may keep, in raw estimate tokens. */
	private compactTail(room: CompactionLimits & { overhead: number }, session: Session, model: string): number {
		const ratio = calibrationRatio(this.requestSample(session, model));
		const summaryTokens = session.modelContext ? estimateTokens(modelSummaryMessage(session.modelContext.summary).content) : 0;
		const ceiling = this.rawLimit(room.trigger, session, model) - room.overhead - summaryTokens - SUMMARY_RESERVE;
		return Math.max(0, Math.min(Math.floor(Math.max(0, room.retain) / ratio), ceiling));
	}

	/** The tail the old hard-budget planner used, for the disabled-proactive path. */
	private legacyTail(session: Session, budget: Budget): number {
		const summaryTokens = session.modelContext ? estimateTokens(modelSummaryMessage(session.modelContext.summary).content) : 0;
		return Math.max(0, budget.input - summaryTokens - SUMMARY_RESERVE);
	}

	/** Announces one successful fold and records the marker the chat draws in the turn it happened. */
	private announceCompaction(
		session: Session,
		ref: TurnRef,
		trigger: GenerationTrigger,
		context: ModelContext,
		fold: { before: number; after: number; folded: number; window: number },
	): void {
		const share = fold.window > 0 ? Math.round((fold.after / fold.window) * 100) : 0;
		const text = `Summarized ${fold.folded} earlier message${fold.folded === 1 ? '' : 's'}: about ${formatTokens(fold.after)} tokens now instead of ${formatTokens(fold.before)} (${share}% of the ${formatTokens(fold.window)} window).`;
		// A silent generation has no turn in the chat to mark; the text notice stands in.
		if (SILENT_TRIGGERS.has(trigger)) {
			this.notice(ref, text);
			return;
		}
		const note: TurnNote = {
			anchor: session.transcript.length,
			at: context.at,
			version: context.version,
			folded: fold.folded,
			covers: context.covers,
			before: fold.before,
			after: fold.after,
			window: fold.window,
			summary: context.summary,
		};
		addTurnNote(session, note);
		// recordModelContext already fired sessions/changed for the summary; this save only adds the
		// marker, so it deliberately emits no second event.
		this.ctx.sessions.save(session);
		this.notice(ref, text, { kind: 'compaction', note });
	}

	/**
	 * Summarizes the canonical prefix, extending the previous summary unless `rebuild` is set. The
	 * transcript, marks and cursor are untouched; the caller rebuilds only its model messages.
	 */
	private async compactContext(
		session: Session,
		source: readonly Message[],
		tail: number,
		window: number,
		instructions?: string,
		signal?: AbortSignal,
		rebuild = false,
		onUsage?: (usage: { input: number; output: number }) => void,
	): Promise<ModelContext | null> {
		const previous = session.modelContext;
		const from = rebuild ? 0 : previous?.covers ?? 0;
		const plan = planCompaction(source, Math.max(0, tail), from);
		let cut = Math.min(plan.cut, source.length);
		if (rebuild && previous) {
			cut = Math.max(cut, previous.covers);
		}
		if (cut <= from && !rebuild) {
			return null;
		}
		const older = source.slice(rebuild ? 0 : from, cut);
		if (!older.length) {
			return null;
		}
		// The summarizer reads as much of the old turns as its own cap allows; a small retain target
		// must not starve it.
		const sourceTokens = Math.max(4_000, Math.min(SUMMARY_SOURCE_TOKENS, Math.max(0, window - SUMMARY_RESERVE)));
		const text = await this.summaryText(
			session.policy.model,
			older,
			rebuild ? undefined : previous?.summary,
			instructions,
			signal,
			onUsage,
			sourceTokens,
		);
		if (!text) {
			throw new Error('the summarizer returned an empty summary');
		}
		const context = this.ctx.sessions.recordModelContext(session, text, cut, session.policy.model);
		if (!context) {
			throw new Error('the summary could not be recorded');
		}
		return context;
	}

	/** A summary is a real request: count it, but never let it overwrite the chat's last input size. */
	private recordSummaryUsage(session: Session, usage: CompletionUsage): void {
		session.usage.inputTokens += usage.input;
		session.usage.outputTokens += usage.output;
		session.usage.requests += 1;
		if (usage.cached !== undefined && Number.isFinite(usage.cached)) {
			session.usage.cachedTokens = (session.usage.cachedTokens ?? 0) + Math.min(Math.max(0, usage.cached), usage.input);
		}
		this.ctx.usage.add(usage);
		const cost = this.ctx.llm.costFor(session.policy.model, usage);
		if (cost > 0) {
			session.usage.cost += cost;
		}
		this.ctx.sessions.save(session);
	}

	/**
	 * The request about to be sent, made to fit. At the configured headroom it folds the turns before
	 * this one into a summary, keeping the retained tail small; only a request that still cannot fit
	 * the reply-reserved window has its tool output elided. The current turn is never folded: it is
	 * what the user just asked for.
	 *
	 * A subagent owns its request, so it no longer lines up with a chat record and only elision may
	 * touch it.
	 */
	private async fitRequest(
		state: RunState,
		session: Session | undefined,
		tools: ToolSpec[],
		signal: AbortSignal,
	): Promise<{ messages: Message[]; transcript?: Message[] }> {
		const budget = this.budgetFor(state.policy, session?.contextWindow, this.systemText(state.messages), tools);
		const room = this.roomFor(budget);
		const toolCost = this.toolTokens(tools);
		const model = state.policy.model;
		const guard = (state.compaction ??= { attempts: 0, failed: false, notified: false, trimmed: false, blocked: false });
		let messages = state.messages;

		if (!room.enabled) {
			// Proactive compaction off: keep the cheap trim first, then fold only what is still too large.
			// The primary system prompt and the tool definitions are fixed overhead; the derived summary
			// is body, not overhead, or it would be invisible to this budget and to /context.
			const systems = state.messages.filter((message) => message.role === 'system' && !message.summarized);
			const body = state.messages.filter((message) => message.role !== 'system' || message.summarized);
			const fixed = estimateMessages(systems);
			if (estimateMessages(body) <= budget.input) {
				return { messages: state.messages };
			}
			// Elision still walks the whole request; its limit carries the fixed part so only the body shrinks.
			const elided = elideToolResults(state.messages, budget.input + fixed);
			if (elided.changed && !guard.trimmed) {
				guard.trimmed = true;
				this.notice(state.ref, 'Trimmed older tool output to fit the model’s window.');
			}
			const elidedBody = elided.messages.filter((message) => message.role !== 'system' || message.summarized);
			if (estimateMessages(elidedBody) <= budget.input || !state.foldable || !session) {
				return { messages: elided.messages };
			}
			if (guard.failed || guard.blocked || guard.attempts >= MAX_COMPACTIONS_PER_TURN) {
				return { messages: elided.messages };
			}
			guard.attempts += 1;
			try {
				const context = await this.compactContext(
					session,
					state.transcript,
					this.legacyTail(session, budget),
					budget.window,
					undefined,
					signal,
					false,
					(usage) => {
						state.budget?.spendTokens(usage.input + usage.output);
						this.recordSummaryUsage(session, usage);
					},
				);
				if (!context) {
					guard.blocked = true;
					return { messages: elided.messages };
				}
				state.modelContextVersion = context.version;
				const history = buildModelHistory(state.transcript, context, state.contextForm ?? this.ctx.settings.get().contextForm);
				return { messages: [...systems, ...history, ...(state.trailer ?? [])] };
			} catch (error) {
				signal.throwIfAborted();
				// The turn still has to be answered, so a summary that failed is reported and not fatal.
				guard.failed = true;
				this.ctx.log.message(`summarize failed mid-turn: ${describe(error)}`);
				if (!guard.notified) {
					guard.notified = true;
					this.notice(state.ref, `Could not summarize the conversation (${describe(error)}); continuing with trimmed history.`);
				}
				return { messages: elided.messages };
			}
		}

		// Proactive path: fold first at the headroom, then trim only if the current turn alone still
		// cannot fit the reply-reserved window.
		if (this.pressure(session, model, messages, toolCost) >= room.trigger) {
			if (state.foldable && session && !guard.failed && !guard.blocked && guard.attempts < MAX_COMPACTIONS_PER_TURN) {
				const before = this.pressure(session, model, messages, toolCost);
				const previousCovers = session.modelContext?.covers ?? 0;
				guard.attempts += 1;
				try {
					const context = await this.compactContext(
						session,
						state.transcript,
						this.compactTail(room, session, model),
						budget.window,
						undefined,
						signal,
						false,
						(usage) => {
							state.budget?.spendTokens(usage.input + usage.output);
							this.recordSummaryUsage(session, usage);
						},
					);
					if (context) {
						state.modelContextVersion = context.version;
						const systems = state.messages.filter((message) => message.role === 'system' && !message.summarized);
						messages = [
							...systems,
							...buildModelHistory(state.transcript, context, state.contextForm ?? this.ctx.settings.get().contextForm),
							...(state.trailer ?? []),
						];
						this.announceCompaction(session, state.ref, state.trigger, context, {
							before,
							after: this.pressure(session, model, messages, toolCost),
							folded: context.covers - previousCovers,
							window: budget.window,
						});
					} else {
						guard.blocked = true;
					}
				} catch (error) {
					signal.throwIfAborted();
					guard.failed = true;
					this.ctx.log.message(`summarize failed mid-turn: ${describe(error)}`);
					if (!guard.notified) {
						guard.notified = true;
						this.notice(state.ref, `Could not summarize the conversation (${describe(error)}); continuing without a summary.`);
					}
				}
			}
		}

		if (this.pressure(session, model, messages, toolCost) > budget.window - budget.reserve) {
			const systems = messages.filter((message) => message.role === 'system' && !message.summarized);
			const fixed = estimateMessages(systems);
			const elided = elideToolResults(messages, this.rawBodyLimit(budget, session, model) + fixed);
			if (elided.changed) {
				messages = elided.messages;
				if (!guard.trimmed) {
					guard.trimmed = true;
					this.notice(state.ref, 'Trimmed older tool output to fit the model’s window.');
				}
			}
		}
		return { messages };
	}

	/**
	 * One model round trip, with the usage it reported recorded against the session. Its `input` is the
	 * real size of the prompt — the one measurement of the context that is not an estimate — so it is
	 * kept for the panels and for judging whether the next request needs to shrink.
	 *
	 * A refusal about the prompt's size is the one kind a retry can fix: the request is shrunk as far as
	 * it goes and sent once more, and only a second refusal is the turn's answer.
	 */
	private async request(
		state: RunState,
		tools: ToolSpec[],
		signal: AbortSignal,
		session: Session | undefined,
		live: boolean,
	): Promise<{ completion: Completion; messages: Message[] }> {
		// Whether this attempt already reached the screen. A failure after tokens were streamed must not
		// retry: the reader would see the answer twice.
		let streamed = false;
		// A request that connects and then goes silent is indistinguishable from a freeze. The timer
		// resets on every visible delta, so long reasoning is fine; three silent minutes are not.
		let stall: ReturnType<typeof setTimeout> | undefined;
		const watchdog = new AbortController();
		const arm = (): void => {
			if (stall) {
				clearTimeout(stall);
			}
			stall = setTimeout(
				() => watchdog.abort(new Error(`the model sent no output for ${Math.round(MODEL_STALL_MS / 1_000)} seconds`)),
				MODEL_STALL_MS,
			);
		};
		const callSignal = AbortSignal.any([signal, watchdog.signal]);
		const call = (messages: Message[]): Promise<Completion> =>
			this.ctx.llm.chat(
				state.policy.model,
				messages,
				tools,
				{
					onToken: (text) => {
						streamed = true;
						arm();
						this.ctx.emit('agent/token', state.ref, text);
					},
					onReasoning: (text) => {
						streamed = true;
						arm();
						this.ctx.emit('agent/reasoning', state.ref, text);
					},
					onToolDelta: (call) => {
						streamed = true;
						arm();
						this.ctx.emit('agent/tool-delta', state.ref, call);
					},
				},
				callSignal,
				{ reasoningEffort: session?.reasoningEffort },
			);
		arm();
		const attempt = (messages: Message[]): Promise<Completion> => {
			streamed = false;
			return call(messages);
		};
		// A model that once refused images never sees another one this session; the transcript keeps
		// them, so switching to a vision model later can still show them. A transport reset only turns
		// images off for this turn: the next turn gets to try again.
		const refusedModel = this.imagesOff.get(state.sessionId);
		const off = refusedModel === state.policy.model || state.imagesOff === state.policy.model;
		let messages = off ? stripImageAttachments(state.messages) : state.messages;
		let completion: Completion;
		// A new chat has no provider count yet, so the status line would show no context segment during
		// its first reply. Hand the surface the same local estimate that calibrates the provider's count
		// below, marked provisional. Emitted once per request, outside `attempt`, so an image, transport
		// or overflow retry cannot make the line jump; a child's request never paints the parent's line.
		if (session && !session.parentId && !session.lastInputTokens && !signal.aborted) {
			this.ctx.emit('agent/estimate', state.ref, {
				usage: { ...session.usage },
				turnIndex: session.turnIndex,
				estimateTokens: estimateMessages(messages) + this.toolTokens(tools),
				window: this.windowFor(session),
			});
		}
		try {
			completion = await attempt(messages);
		} catch (error) {
			if (isImageUnsupported(error) && hasImageAttachments(messages) && !off) {
				this.imagesOff.set(state.sessionId, state.policy.model);
				state.imagesOff = state.policy.model;
				this.notice(state.ref, 'The selected model does not accept images; resending this request as text.');
				messages = stripImageAttachments(state.messages);
				completion = await attempt(messages);
			} else if (isTransportFailure(error) && !streamed && hasImageAttachments(messages) && !off) {
				// The usual cause is a stale keep-alive socket; one repeat can succeed. If it does not,
				// the endpoint cannot take the picture and the text is still worth answering.
				this.notice(state.ref, `The connection ended while sending images (${describe(error)}); retrying once.`);
				try {
					completion = await attempt(messages);
				} catch (again) {
					if (!isTransportFailure(again)) {
						throw again;
					}
					state.imagesOff = state.policy.model;
					this.notice(state.ref, 'Images could not be sent to this endpoint; resending the request as text.');
					messages = stripImageAttachments(state.messages);
					completion = await attempt(messages);
				}
			} else if (!isContextOverflow(error)) {
				throw error;
			} else {
				// The estimate said it fit and the endpoint disagreed. Trust the endpoint: shrink hard, retry once.
				this.notice(state.ref, 'The model refused the request as too long; shrinking it and trying again.');
				const shrunk = await this.emergencyFit(state, session, signal);
				if (!shrunk) {
					throw error;
				}
				messages = shrunk;
				completion = await attempt(messages);
			}
		} finally {
			if (stall) {
				clearTimeout(stall);
			}
		}
		// The run budget counts real spend; without a provider usage event, estimate rather than
		// treating an unreported request as free.
		state.budget?.spendTokens(
			completion.usage
				? completion.usage.input + completion.usage.output
				: estimateMessages(messages) + estimateTokens(completion.message.content),
		);
		if (completion.usage && session) {
			session.usage.inputTokens += completion.usage.input;
			session.usage.outputTokens += completion.usage.output;
			session.usage.requests += 1;
			const cached = completion.usage.cached;
			if (cached !== undefined && Number.isFinite(cached)) {
				session.usage.cachedTokens =
					(session.usage.cachedTokens ?? 0) + Math.min(Math.max(0, cached), completion.usage.input);
			}
			session.lastInputTokens = completion.usage.input;
			// The local estimate for the request whose size the provider just reported. Their ratio
			// calibrates the next pressure check against the endpoint's own tokenizer.
			session.lastEstimateTokens = estimateMessages(messages) + this.toolTokens(tools);
			session.lastInputModel = state.policy.model;
			this.ctx.usage.add(completion.usage);
			const cost = this.ctx.llm.costFor(state.policy.model, completion.usage);
			if (cost > 0) {
				session.usage.cost += cost;
				this.checkBudget(session, state.ref);
			}
			if (!live) {
				this.ctx.sessions.save(session);
			}
			// The status line is painted from this snapshot. Emitted here rather than from the graph's
			// step hook: usage is in memory now, the transcript only reaches disk after the node
			// returns, and a request completed just before a Stop never reaches the hook. A child's
			// spend belongs to the child, not to any open chat.
			if (!session.parentId) {
				this.ctx.emit('agent/usage', state.ref, {
					usage: { ...session.usage },
					turnIndex: session.turnIndex,
					lastInputTokens: session.lastInputTokens,
					window: this.windowFor(session),
				});
			}
		}
		return { completion, messages };
	}

	/**
	 * The hardest shrink available, for a refusal the estimate did not predict: every tool result down
	 * to its marker, and every turn but the last folded away. Returns `null` when there is nothing left
	 * to give, which is the endpoint's answer to keep.
	 */
	private async emergencyFit(state: RunState, session: Session | undefined, signal: AbortSignal): Promise<Message[] | null> {
		const system = state.messages.filter((message) => message.role === 'system' && !message.summarized);
		// Tool output goes to its markers first; older prompts' pictures go next, keeping the newest
		// prompt intact so the question being answered still has what it was asked about.
		const elided = elideToolResults(state.messages, 0).messages;
		const dropped = dropPromptAttachments(elided, true);
		const body = (dropped.changed ? dropped.messages : elided).filter(
			(message) => message.role !== 'system' || message.summarized,
		);
		// When a summary cannot do any more, the hard trim is still a better answer than the refusal.
		const fallback = (): Message[] | null =>
			estimateMessages(body) < estimateMessages(state.messages) ? [...system, ...body] : null;
		if (!session || !state.foldable) {
			return fallback();
		}
		const guard = (state.compaction ??= { attempts: 0, failed: false, notified: false, trimmed: false, blocked: false });
		if (guard.failed || guard.blocked || guard.attempts >= MAX_COMPACTIONS_PER_TURN) {
			return fallback();
		}
		guard.attempts += 1;
		try {
			const context = await this.compactContext(
				session,
				state.transcript,
				0,
				this.windowOf(state.policy, session.contextWindow),
				undefined,
				signal,
				false,
				(usage) => {
					state.budget?.spendTokens(usage.input + usage.output);
					this.recordSummaryUsage(session, usage);
				},
			);
			if (!context) {
				return fallback();
			}
			state.modelContextVersion = context.version;
			const history = buildModelHistory(state.transcript, context, state.contextForm ?? this.ctx.settings.get().contextForm);
			return [...system, ...history, ...(state.trailer ?? [])];
		} catch (error) {
			signal.throwIfAborted();
			guard.failed = true;
			this.ctx.log.message(`emergency summarize failed: ${describe(error)}`);
			if (!guard.notified) {
				guard.notified = true;
				this.notice(state.ref, `Could not summarize the conversation (${describe(error)}); continuing with trimmed history.`);
			}
			return fallback();
		}
	}

	/** The system prompt of a message list, as the budget's fixed part measures it. */
	private systemText(messages: Message[]): string {
		// The derived summary is body context, not part of the fixed system prompt.
		return messages
			.filter((message) => message.role === 'system' && !message.summarized)
			.map((message) => message.content)
			.join('\n');
	}

	/**
	 * The prompt one summary is written from: the turns being folded as a head and a tail within a
	 * character budget. The tail is the part that matters — the turns nearest the present are the ones
	 * the next request leans on — so a conversation too long to read in full loses its middle and says
	 * so in the text the model sees. A previous summary is handed over as the base to extend.
	 */
	private async summaryText(
		model: string,
		older: Message[],
		previous?: string,
		instructions?: string,
		signal?: AbortSignal,
		onUsage?: (usage: { input: number; output: number }) => void,
		sourceTokens = SUMMARY_SOURCE_TOKENS,
	): Promise<string> {
		const lines = older.map((message) => {
			const notes = attachmentNotes(message.attachments);
			const suffix = notes?.length ? ` [attachments: ${notes.join('; ')}]` : '';
			return `${message.role}: ${clip(message.content, 2_000)}${suffix}`;
		});
		// Counts are tokens, not characters: the same 120k characters are ~40k tokens in English and
		// more than 100k in CJK, and the summary request must itself fit the model's window.
		const costs = lines.map((line) => countRaw(line));
		let head = 0;
		let used = previous ? countRaw(previous) : 0;
		const headBudget = Math.max(1_000, Math.floor(sourceTokens / 4));
		while (head < lines.length && used + costs[head]! < headBudget) {
			used += costs[head]!;
			head += 1;
		}
		const tail: string[] = [];
		for (let index = lines.length - 1; index >= head && used < sourceTokens; index -= 1) {
			const cost = costs[index]!;
			if (used + cost > sourceTokens) {
				break;
			}
			used += cost;
			tail.unshift(lines[index]!);
		}
		const omitted = lines.length - head - tail.length;
		const text = await this.ctx.llm.complete(
			model,
			this.summaryInstruct(instructions),
			[
				previous ? `It was summarized once before; extend that summary rather than starting over:\n\n${previous}` : '',
				`The earliest turns:\n\n${lines.slice(0, head).join('\n\n')}`,
				omitted > 0 ? `[...${omitted} messages between these were left out of this request]` : '',
				`The most recent turns:\n\n${tail.join('\n\n')}`,
			]
				.filter(Boolean)
				.join('\n\n'),
			{
				signal,
				onUsage,
				// Summarizing is not reasoning: the chat's Max effort belongs to the answer, not to
				// folding old turns, and a thinking summary can sit for minutes before emitting text.
				reasoningEffort: 'none',
				// A thinking-only reply from a profile that cannot switch thinking off must not look
				// like a silently empty summary.
				rejectReasoningOnly: true,
				maxTokens: SUMMARY_MAX_TOKENS,
				timeoutMs: SUMMARY_TIMEOUT_MS,
			},
		);
		return text.length <= SUMMARY_TEXT_LIMIT
			? text
			: `${text.slice(0, SUMMARY_TEXT_LIMIT)}\n[... summary truncated, ${text.length - SUMMARY_TEXT_LIMIT} chars]`;
	}

	private summaryInstruct(instructions?: string): string {
		return [
			'You summarize agent conversations for a coding assistant. Write the summary the next request will be answered from.',
			'Preserve decisions, file paths, open tasks, user preferences and unresolved issues.',
			'Do not drop facts from early in the conversation: a detail mentioned only once is exactly the kind this summary has to keep.',
			'The last request in the conversation is being answered separately, so do not answer it here.',
			instructions ? `Extra instructions: ${instructions}` : '',
		]
			.filter(Boolean)
			.join('\n');
	}

	stop(sessionId?: string): boolean {
		const id = sessionId ?? this.ctx.sessions.active()?.id ?? '';
		// A command with no target stops the one running turn even if the panel moved to another chat.
		const turn = this.turns.get(id) ?? (sessionId === undefined && this.turns.size === 1 ? [...this.turns.values()][0] : undefined);
		if (!turn) {
			return false;
		}
		turn.controller.abort();
		return true;
	}

	todos(sessionId: string): TodoItem[] {
		return this.todoLists.get(sessionId) ?? [];
	}

	/** Queues extra context for the next turn of a session (used by background subagents). */
	pushContext(sessionId: string, text: string): void {
		this.pending.set(sessionId, [...(this.pending.get(sessionId) ?? []), text]);
	}

	/** Token-budget breakdown for /context. */
	contextReport(): string {
		const session = this.ctx.sessions.active();
		if (!session) {
			return 'No active session.';
		}
		const config = this.ctx.settings.get();
		const form = session.contextForm ?? config.contextForm;
		this.ctx.sessions.verifyModelContext(session);
		const modelHistory = buildModelHistory(session.transcript, session.modelContext, form);
		const sum = (role: Message['role']) =>
			modelHistory
				.filter((message) => message.role === role)
				.reduce((total, message) => total + estimateTokens(message.content) + estimateAttachments(message.attachments), 0);
		const user = sum('user');
		const assistant = sum('assistant');
		const tool = sum('tool');
		const attachments = modelHistory.flatMap((message) => message.attachments ?? []);
		const attachmentTokens = (kind: AttachmentPart['kind']) =>
			attachments.filter((part) => part.kind === kind).reduce((total, part) => total + estimateAttachments([part]), 0);
		const attachmentLine = attachments.length
			? `- attachments in model context: ${attachmentTokens('text')} text · ${attachmentTokens('image')} image · ${attachmentTokens('document')} document tokens`
			: '';
		const canonicalTokens = estimateMessages(session.transcript);
		const modelTokens = estimateMessages(modelHistory);
		const summaryTokens = session.modelContext ? estimateTokens(modelSummaryMessage(session.modelContext.summary).content) : 0;
		// A turn whose Tools block was off carried no tool overhead; report that turn, not the policy
		// list that would have been offered without the block.
		const visible = this.toolModes.get(session.id) === false ? [] : this.ctx.tools.visible(session.policy);
		const files = session.instructions ?? [];
		const profile = this.ctx.llm.profileFor(session.policy.model);
		const system = this.systems.get(session.id) ?? '';
		const budget = this.budgetFor(session.policy, session.contextWindow, system, visible);
		const room = this.roomFor(budget);
		const sample = this.requestSample(session, session.policy.model);
		const ratio = calibrationRatio(sample);
		const currentPressure = calibrate(estimateMessages(modelHistory) + budget.overhead, sample);
		const used = session.lastInputTokens;
		const windowLine = profile?.contextWindow
			? `- window: ${budget.window} tokens${session.contextWindow ? ' (set for this chat)' : ` — from the ${profile.label || profile.id} profile`}`
			: `- window: ${budget.window} tokens — **a fallback, not this model's own**. Set \`contextWindow\` on its profile.`;
		return [
			'**Context**',
			windowLine,
			`- room for messages: ${budget.input} tokens = ${budget.window} window − ${budget.reserve} held for the reply − ${budget.overhead} of system prompt and tool definitions`,
			`  - of that overhead: ${estimateTokens(system)} system prompt, ${this.toolTokens(visible)} the ${visible.length} tool definitions`,
			room.enabled
				? `- automatic compaction: summarize at ${room.trigger} tokens (${room.headroom} headroom, ${budget.reserve} held for the reply); keep ${room.retain} tokens (${config.compactionRetainPercent}% of the window)`
				: '- automatic compaction: off (`compactionHeadroom` is 0, or the window leaves no room for messages)',
			`- current pressure: ${currentPressure} tokens estimated${ratio !== 1 ? ` (local estimate ×${ratio.toFixed(2)})` : ''}`,
			used === undefined
				? '- last request: none yet, so the numbers below are estimates'
				: `- last request: ${used} tokens, as the provider counted them${sample ? ` (local estimate ${sample.estimate}, ×${ratio.toFixed(2)})` : ''}`,
			`- canonical transcript: ${session.transcript.length} messages, ${canonicalTokens} tokens (the full chat is kept)`,
			`- model context: ${modelTokens} tokens = ${summaryTokens} summary + ${user + assistant + tool} messages (user ${user} · assistant ${assistant} · tool ${tool})`,
			...(attachmentLine ? [attachmentLine] : []),
			`- instruction files: ${files.length}${files.length ? ` — ${files.slice(0, 5).map((file) => file.split('/').pop()).join(', ')}` : ''}`,
			`- context form: ${form}`,
			session.modelContext
				? `- summary: covers ${session.modelContext.covers} messages, version ${session.modelContext.version}${session.modelContext.model ? `, by ${session.modelContext.model}` : ''}`
				: '- not summarized yet: past the window, the older turns are folded into a model context',
		].join('\n');
	}

	private async execute(session: Session, state: RunState, turn: Turn, resume?: ResumeCursor): Promise<TurnResult> {
		const signal = turn.signal;
		try {
			// Journal backfill can be slow on a remote filesystem; it must not outlive a Stop.
			await abortable(signal, this.backfillCreated(session, state.policy.workingDirectory));

			const outcome = await this.runStage(session, state, turn, resume);
			state = outcome.state;
			if (outcome.status === 'aborted') {
				return this.aborted(session, state);
			}
			const budget = this.budgetStopped(session, state, false);
			if (budget) {
				return budget;
			}
			// A Stop that lands as the graph finishes wins over the Stop hook.
			signal.throwIfAborted();
			const stop = await this.fireStop(session, state, signal);
			const reminder = this.todoReminder(state);
			if (stop.blocked || reminder) {
				// One more round for both: the Stop hook's reason and the unfinished todo list.
				state = {
					...state,
					messages: [
						...state.messages,
						...(stop.blocked ? [{ role: 'user' as const, content: `(hook) ${stop.reason ?? 'keep working'}` }] : []),
						...(reminder ? [{ role: 'user' as const, content: `(hook) ${reminder}` }] : []),
					],
				};
				const again = await this.runStage(session, state, turn);
				state = again.state;
				if (again.status === 'aborted') {
					return this.aborted(session, state);
				}
			}
			this.finish(session, state);
			return { sessionId: session.id, text: lastAssistant(state.transcript)?.content ?? '' };
		} catch (error) {
			if (signal.aborted) {
				return this.aborted(session, state);
			}
			this.ctx.log.message(`turn failed: ${describe(error)}`);
			this.ctx.audit.write(session.id, { kind: 'error', message: describe(error) });
			// A swipe or a regenerate that failed keeps the exchange it replaced: the chat is left with
			// the reply it had, not with a prompt whose answer was thrown away.
			if (state.restore) {
				this.finish(session, state, { aborted: true });
			}
			return { sessionId: session.id, text: `Error: ${describe(error)}` };
		}
	}

	/**
	 * One graph run, with the tool-approval suspensions it can contain. Nothing about turns, Stop
	 * hooks or transcripts belongs here: the caller decides when the whole turn is over.
	 */
	private async runStage(
		session: Session,
		state: RunState,
		turn: Turn,
		resume?: ResumeCursor,
	): Promise<{ status: 'done' | 'aborted'; state: RunState; step: number }> {
		// The budget deadline interrupts a running model or tool, not only the next node. Link the
		// turn's stop signal through a local controller so a budget timeout is distinguishable from
		// the user's Stop.
		const controller = new AbortController();
		const unlink = linkAbort(turn.signal, controller);
		const signal = controller.signal;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = state.budget?.deadline();
		if (deadline !== undefined) {
			timer = setTimeout(() => {
				state.budget?.stop('milliseconds');
				controller.abort(new Error('time budget exhausted'));
			}, Math.min(2_147_483_647, Math.max(0, deadline - Date.now())));
		}
		let cursor = resume;
		try {
			for (;;) {
				const graph = this.graph();
				const outcome = await runGraph(graph, state, {
					resume: cursor,
					signal,
					choose: (request: SoftRequest) =>
						this.ctx.llm.choose(state.policy.model, request, signal, (usage) =>
							state.budget?.spendTokens(usage.input + usage.output),
						),
					// The chat's stored transcript follows the turn as it runs. A panel that reloads or
					// resyncs mid-turn can then redraw the steps it missed, and a turn suspended on an
					// approval leaves a complete record behind instead of only the prompt.
					onStep: (current) => this.persistTranscript(session, current),
				});
				state = outcome.state;
				if (outcome.status === 'aborted') {
					return { status: 'aborted', state, step: outcome.step };
				}
				if (outcome.status === 'done') {
					return { status: 'done', state, step: outcome.step };
				}
				const calls = Array.isArray(outcome.payload) ? (outcome.payload as ToolCall[]) : [];
				// The suspension is where a turn can sit for a long time: write down everything it has
				// done first, so the chat shows the work while the approval question is open.
				this.persistTranscript(session, state);
				session.cursor = { node: outcome.node, payload: outcome.payload, step: outcome.step, state };
				this.ctx.sessions.save(session);
				const answer = calls.length
					? await this.ctx.approval.request({
							calls,
							reason: state.gateReason,
							surface: state.ref.surface,
							sessionId: session.id,
							signal,
							response: state.policy.approvalResponse,
						})
					: 'deny';
				if (signal.aborted) {
					return { status: 'aborted', state, step: outcome.step };
				}
				const approvalReason =
					answer === 'deny'
						? state.policy.approvalResponse === 'never'
							? 'the approval response policy denies without asking'
							: 'the approval surface denied the call'
						: 'the approval surface allowed the call';
				if (answer === 'always' && calls[0]) {
					const rule = suggestAllowRule(calls[0], this.ctx.tools.get(calls[0].name));
					await this.ctx.settings.addAllowRule(rule).catch(() => undefined);
					this.notice(state.ref, `Added allow rule: ${rule}`);
				}
				session.cursor = null;
				cursor = {
					node: outcome.node,
					value: { allowed: answer !== 'deny', reason: approvalReason },
					payload: outcome.payload,
					step: outcome.step,
				};
			}
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			unlink();
		}
	}

	private fireStop(session: Session, state: RunState, signal: AbortSignal) {
		return abortable(
			signal,
			this.ctx.hooks.fire('Stop', undefined, {
				session_id: session.id,
				last_assistant_message: lastAssistant(state.transcript)?.content ?? '',
			}),
		);
	}

	/** The clean end of a stopped turn: no Stop hook, no stale reply, a wire-valid transcript. */
	private aborted(session: Session, state: RunState): TurnResult {
		const budget = this.budgetStopped(session, state, true);
		if (budget) {
			return budget;
		}
		this.settleCancelledCalls(state);
		session.cursor = null;
		this.finish(session, state, { aborted: true });
		const reply = lastAssistant(state.transcript.slice(state.prior.length))?.content.trim() ?? '';
		return { sessionId: session.id, text: reply, stopped: true };
	}

	/** End a turn whose native budget ran out, leaving a sealed, resumable transcript. */
	private budgetStopped(session: Session, state: RunState, aborted: boolean): TurnResult | undefined {
		const dimension = state.budget?.stopReason ?? state.stop;
		if (!dimension) {
			return undefined;
		}
		state.budget?.stop(dimension);
		sealPartial(state.messages, state.transcript, dimension);
		state.toolCalls = [];
		state.traces = undefined;
		session.cursor = null;
		this.persistTranscript(session, state);
		this.finish(session, state, aborted ? { aborted: true } : undefined);
		this.notice(state.ref, `Budget exhausted (${budgetLabel(dimension)}); send another message to continue.`);
		const reply = lastAssistant(state.transcript.slice(state.prior.length))?.content.trim() ?? '';
		return { sessionId: session.id, text: reply, stopped: true, budget: state.budget?.report() };
	}

	/** Give every unanswered tool call a result, so the next request is still a valid conversation. */
	private settleCancelledCalls(state: RunState): void {
		if (!state.toolCalls.length) {
			return;
		}
		// This batch's results live in the aborted node's local array, never in the transcript: every
		// call is unanswered here. Scanning the whole transcript would mistake an earlier turn's reused
		// synthetic id (call_0) for an answer and leave the request ending in dangling tool calls.
		// A call that never dispatched is denied for the audit; one that already wrote
		// `dispatch_started` keeps that terminal (the service ignores the later denial).
		for (const trace of state.traces ?? []) {
			this.ctx.decisions.terminal(trace, 'denied', 'stopped before dispatch');
		}
		state.transcript = [
			...state.transcript,
			...state.toolCalls.map((call): Message => ({ role: 'tool', toolCallId: call.id, content: 'Stopped by the user.', at: Date.now() })),
		];
		state.toolCalls = [];
		state.traces = undefined;
	}

	/**
	 * Writes the turn's transcript into the session while it is still running. The transcript is
	 * otherwise only written when the turn ends, which leaves a reload (or a resync after the chat's
	 * view was hidden) with nothing to show but the prompt. A silent generation is not the chat's,
	 * so it never touches the stored transcript.
	 */
	private persistTranscript(session: Session, state: RunState): void {
		if (SILENT_TRIGGERS.has(state.trigger) || session.transcript === state.transcript) {
			return;
		}
		session.transcript = state.transcript;
		this.ctx.sessions.save(session);
	}

	/**
	 * A turn is about to finish with items still marked in progress: the work it stands for cannot be
	 * running any more. Ask the model to close the list itself, the way a Stop hook asks it to keep
	 * working. The list is left exactly as the model wrote it; only the model may change a status, and
	 * this fires once per turn — the round it triggers is the last chance to do so.
	 */
	private todoReminder(state: RunState): string | undefined {
		if (SILENT_TRIGGERS.has(state.trigger) || state.toolsEnabled === false) {
			return undefined;
		}
		if (!this.ctx.tools.visible(state.policy).some((tool) => tool.name === 'todo_write')) {
			return undefined;
		}
		const open = (this.todoLists.get(state.sessionId) ?? []).filter((item) => item.status === 'in_progress');
		if (!open.length) {
			return undefined;
		}
		const list = open.map((item) => `"${item.text}"`).join(', ');
		const one = open.length === 1;
		return `The todo list still has ${open.length} item${one ? '' : 's'} in progress: ${list}. Call todo_write now: mark ${one ? 'it' : 'them'} completed if the work is done, or pending if it is not, then finish.`;
	}

	private finish(session: Session, state: RunState, options: { aborted?: boolean } = {}): void {
		const answer = lastAssistant(state.transcript);
		const reply = answer?.content.trim() ? answer.content : '';
		if (options.aborted) {
			// A stopped turn keeps the partial reply it streamed, but never merges a continue: the
			// previous reply is already in the transcript and must not be concatenated with itself.
			// A swipe puts back the exchange it replaced; a quiet or impersonated turn was never in the
			// chat at all, so it leaves the record as it stood before the turn.
			if (state.restore) {
				session.transcript = state.restore;
				session.notes = state.restoreNotes?.length ? state.restoreNotes : undefined;
			} else if (state.trigger === 'quiet' || state.trigger === 'impersonate') {
				session.transcript = state.prior;
			} else {
				session.transcript = state.transcript;
			}
		} else if (state.trigger === 'quiet' || state.trigger === 'impersonate') {
			// Upstream keeps neither in the chat: a quiet generation is the caller's alone, and an
			// impersonation is streamed into the composer, for you to edit and send yourself.
			session.transcript = state.prior;
		} else if (state.trigger === 'continue' && reply && state.continueInto !== undefined && state.continueInto >= 0) {
			// A continuation extends the reply it continues: one message, one swipe, nothing truncated.
			const merged = [...state.transcript];
			const previous = merged[state.continueInto];
			if (previous) {
				const grown = `${previous.content}${joins(previous.content, reply)}`;
				merged[state.continueInto] = {
					...previous,
					content: grown,
					// The variant that is showing grows with it, so switching versions cannot show stale text.
					swipes: previous.swipes?.map((variant, index) => (index === (previous.swipeId ?? 0) ? grown : variant)),
					continued: true,
					at: answer?.at ?? previous.at,
				};
			}
			session.transcript = merged.slice(0, state.continueInto + 1);
		} else if (state.swipes && reply) {
			// A swipe or a regenerate: the variants the reader already saw are kept, and upstream's rule
			// is that only the very first variant is ever overwritten.
			const swipes = [...state.swipes.swipes];
			if (state.trigger === 'regenerate' && swipes.length <= 1) {
				swipes[0] = reply;
			} else {
				swipes.push(reply);
			}
			const swipeId = swipes.length - 1;
			const message = state.transcript[lastReplyIndex(state.transcript)];
			if (message) {
				message.content = reply;
				message.swipes = swipes;
				message.swipeId = swipeId;
				// One record per version, as upstream keeps them. The versions that were already there
				// keep the little a transcript can still say about them.
				const records = [...state.swipes.swipeInfo];
				while (records.length < swipes.length - 1) {
					records.push({});
				}
				records.push({ gen_started: message.startedAt ?? null, gen_finished: message.at ?? null, extra: { gen_id: Date.now() } });
				message.swipeInfo = records.slice(-swipes.length);
			}
			session.transcript = state.transcript;
		} else {
			session.transcript = state.transcript;
		}
		// An impersonation writes nothing into the chat, so it is not a turn the chat has taken.
		if (!SILENT_TRIGGERS.has(state.trigger)) {
			session.turnIndex += 1;
		}
		session.cursor = null;
		session.policy = state.policy;
		this.ctx.sessions.invalidateModelContext(session, session.transcript.length);
		this.ctx.sessions.save(session);
		if (!SILENT_TRIGGERS.has(state.trigger)) {
			this.ctx.audit.write(session.id, { kind: 'turn-end', turn: session.turnIndex });
		}
		this.ctx.sessions.changed(session.id);
	}

	private checkBudget(session: Session, ref: TurnRef): void {
		const budget = this.ctx.settings.get().budgetUsd;
		if (budget <= 0 || session.usage.cost <= budget || this.budgetWarned.has(session.id)) {
			return;
		}
		this.budgetWarned.add(session.id);
		this.notice(ref, `Budget alert: this session cost $${session.usage.cost.toFixed(2)} so far (limit $${budget.toFixed(2)})`);
	}

	private graph(): CompiledGraph<RunState> {
		return this.ctx.graphs.get<RunState>();
	}

	private graphRegistry(): GraphRegistry<RunState> {
		const nodes = new Map<string, NodeFn<RunState>>();
		const routes = new Map<string, RouteFn<RunState>>();

		nodes.set('llm.complete', async (state, runtime) => {
			// A budget stop is a clean message boundary: no more model calls and no more tools.
			if (state.stop) {
				return { ...state, toolCalls: [], traces: undefined };
			}
			// A parent tightening lands before the next request, so the model never sees a tool the
			// child no longer holds.
			this.refreshSubagentPolicy(state);
			const exhausted = state.budget?.check();
			if (exhausted) {
				return { ...state, stop: exhausted, toolCalls: [], traces: undefined };
			}
			// A subagent is shown only the read-only tools on its list; the model never learns of a write tool.
			// A silent generation (an impersonation or a quiet turn) writes nothing down and is offered no
			// tools at all: a tool it called would run for real, and its reply is thrown away afterwards.
			// A turn whose Tools block is off offers none either, for the whole turn.
			const offered = this.ctx.tools.visible(state.policy).filter((tool) => this.subagentToolAllowed(state, tool));
			const visible = SILENT_TRIGGERS.has(state.trigger) || state.toolsEnabled === false ? [] : offered;
			const live = this.turnSession(state.sessionId) ?? this.subagentSessions.get(state.sessionId);
			const session = live ?? this.ctx.sessions.get(state.sessionId);
			// A long turn grows by its own tool results, so the request is checked here as well as at the
			// turn's start: eliding old output costs nothing, and folding the turns before this one is
			// what keeps a request that has outgrown the window from being refused outright.
			const fitted = await this.fitRequest(state, session, visible, runtime.signal);
			if (fitted.messages !== state.messages || fitted.transcript !== undefined) {
				state = { ...state, messages: fitted.messages, transcript: fitted.transcript ?? state.transcript };
			}
			// Token budgets are spend, not context: if the next request's input alone cannot fit in
			// what is left, stop before paying for it. Output remains best-effort (one response).
			const tokenLimit = state.budget?.limits.tokens ?? 0;
			if (state.budget && tokenLimit > 0) {
				const estimate = estimateMessages(fitted.messages);
				if (state.budget.usage.tokens + estimate >= tokenLimit) {
					state.budget.stop('tokens');
					return { ...state, stop: 'tokens', toolCalls: [], traces: undefined };
				}
			}
			state.budget?.spendTurn();
			// The window of this model round trip is what the UI shows as "thinking for Ns".
			const startedAt = Date.now();
			const sent = await this.request(state, visible, runtime.signal, session, Boolean(live));
			if (sent.messages !== state.messages) {
				state = { ...state, messages: sent.messages };
			}
			const completion = sent.completion;
			const raw = completion.message;
			// The transcript's assistant message must carry the calls: a later resume or a budget seal
			// reads them from there. Some test/plugin adapters return them only on the completion.
			const message =
				completion.toolCalls.length && !raw.toolCalls?.length ? { ...raw, toolCalls: completion.toolCalls } : raw;
			if (message.content || message.toolCalls?.length) {
				this.ctx.audit.write(state.sessionId, {
					kind: 'assistant',
					text: clip(message.content, 2_000),
					tools: message.toolCalls?.map((call) => call.name),
					...(state.agentName ? { subagent: state.agentName, root: state.rootSessionId } : {}),
				});
			}
			// A turn budget stops the next model round, not the tools this round asked for; token and
			// time spend, however, can end the current round before any tool runs.
			const stop = state.budget?.check(Date.now(), ['milliseconds', 'tokens']);
			const toolCalls = stop ? [] : completion.toolCalls;
			if (message.content || message.toolCalls?.length || message.reasoning) {
				return {
					...state,
					...(stop ? { stop } : {}),
					messages: [...state.messages, message],
					transcript: [...state.transcript, { ...message, at: Date.now(), startedAt }],
					toolCalls,
					traces: undefined,
				};
			}
			return { ...state, ...(stop ? { stop } : {}), toolCalls, traces: undefined };
		});

		nodes.set('agent.calls', async (state) => ({
			...state,
			batch: state.batch + 1,
			approval: undefined,
			outcome: undefined,
			authorization: undefined,
			gateReason: '',
			traces: undefined,
		}));

		nodes.set('agent.approval', async (state, runtime) => {
			if (!runtime.resuming) {
				runtime.suspend(state.toolCalls);
			}
			const answer = runtime.resume as { allowed?: boolean; reason?: string } | undefined;
			return {
				...state,
				approval: {
					allowed: answer?.allowed === true,
					reason: answer?.reason ?? 'the approval surface denied the call',
				},
			};
		});

		nodes.set('agent.reject', async (state) => {
			const reason = `Rejected: ${state.gateReason || 'policy'}`;
			const messages = state.toolCalls.map((call): Message => ({ role: 'tool', toolCallId: call.id, content: reason, at: Date.now() }));
			return {
				...state,
				toolCalls: [],
				traces: undefined,
				messages: [...state.messages, ...messages],
				transcript: [...state.transcript, ...messages],
			};
		});

		nodes.set('agent.tools', async (state, runtime) => {
			// The gate is the only issuer. Consume its grant here: a second visit to this node, a
			// resumed cursor, or a custom graph that routed around the gate has none, and every call
			// is answered as unauthorized instead of running.
			const authorization = state.authorization;
			state.authorization = undefined;
			const authorized =
				Boolean(authorization) &&
				state.toolCalls.every((call) =>
					verifyAuthorization(authorization, { sessionId: state.sessionId, batch: state.batch, callId: call.id }),
				);
			if (!authorized) {
				const reason = 'the tool call was not authorized by the tool policy';
				const messages = state.toolCalls.map((call): Message => ({
					role: 'tool',
					toolCallId: call.id,
					content: `Error: ${reason}`,
					at: Date.now(),
				}));
				if (state.traces) {
					state.toolCalls.forEach((_call, index) => {
						this.denyTrace(state, index, reason, {
							layer: 'authorization',
							decision: 'deny',
							matchedRule: 'authorization',
							reason,
						});
					});
				} else {
					const rules = state.policy.rules ?? this.ctx.settings.rules();
					this.denyWithoutGate(state, reason, policySnapshot(state.policy, rules), 'authorization', 'authorization');
				}
				return {
					...state,
					toolCalls: [],
					traces: undefined,
					messages: [...state.messages, ...messages],
					transcript: [...state.transcript, ...messages],
				};
			}
			const results = new Array<Message | null>(state.toolCalls.length).fill(null);
			const stopped = (call: ToolCall): Message => ({
				role: 'tool',
				toolCallId: call.id,
				content: 'Stopped by the user.',
				at: Date.now(),
			});
			const runCall = async (call: ToolCall, index: number): Promise<void> => {
				state.lastTool = call.name;
				if (runtime.signal.aborted) {
					const dimension = state.budget?.stopReason;
					this.denyTrace(state, index, dimension ? `${budgetLabel(dimension)} budget exhausted` : 'stopped before dispatch');
					results[index] = dimension
						? { role: 'tool', toolCallId: call.id, content: `Error: ${budgetLabel(dimension)} budget exhausted before this tool call ran; resume to continue.`, at: Date.now() }
						: stopped(call);
					return;
				}
				// The tool budget counts every call that reaches dispatch, and a turn/token/time stop
				// ends the batch here. Every call still gets a result: the transcript must stay valid.
				const exhausted = state.budget?.check(Date.now(), ['milliseconds', 'tokens', 'tools']);
				if (exhausted) {
					const reason = `the ${budgetLabel(exhausted)} budget was exhausted before this tool call ran; resume to continue`;
					this.denyTrace(state, index, reason);
					results[index] = { role: 'tool', toolCallId: call.id, content: `Error: ${reason}.`, at: Date.now() };
					state.stop = exhausted;
					return;
				}
				// The Tools block can switch tools off for the whole turn. The router rejects such a call
				// first; this is the second line for a custom graph or a resumed cursor that reached the tools node.
				if (state.toolsEnabled === false) {
					this.denyTrace(state, index, 'tools are switched off for this turn');
					results[index] = { role: 'tool', toolCallId: call.id, content: 'Error: tools are switched off for this turn', at: Date.now() };
					return;
				}
				if (!this.ctx.tools.isEnabled(call.name)) {
					this.denyTrace(state, index, `tool ${call.name} is switched off in Prompts`);
					results[index] = { role: 'tool', toolCallId: call.id, content: `Error: tool ${call.name} is switched off in Prompts`, at: Date.now() };
					return;
				}
				// The second line of defence: a subagent's call is refused if the tool is not on its list, or
				// if it exceeds the capabilities a subagent may hold, whatever the model asked for.
				const tool = this.ctx.tools.get(call.name);
				if (state.filter && (!tool || !this.subagentToolAllowed(state, tool))) {
					this.denyTrace(state, index, `tool ${call.name} is not available to this subagent`);
					results[index] = { role: 'tool', toolCallId: call.id, content: `Error: tool ${call.name} is not available to this subagent`, at: Date.now() };
					return;
				}
				// Count only calls that can actually dispatch; a switched-off or unavailable tool is a
				// denial, not a spent tool call.
				state.budget?.spendTools(1);
				let args = call.arguments;
				let pre;
				try {
					pre = await abortable(
						runtime.signal,
						this.ctx.hooks.fire('PreToolUse', call.name, {
							session_id: state.sessionId,
							tool_name: call.name,
							tool_input: parseArguments(call.arguments),
						}),
					);
				} catch (error) {
					if (runtime.signal.aborted) {
						results[index] = stopped(call);
						return;
					}
					throw error;
				}
				if (runtime.signal.aborted) {
					this.denyTrace(state, index, 'stopped before dispatch');
					results[index] = stopped(call);
					return;
				}
				if (pre.updatedInput) {
					args = JSON.stringify(pre.updatedInput);
				}
				this.ctx.emit('agent/tool-start', state.ref, { ...call, arguments: args });
				// The card is on screen from here on: a stop has to settle it as well as the transcript,
				// or the webview keeps a call spinner that nothing will ever finish.
				const settleStopped = (): void => {
					this.denyTrace(state, index, 'stopped before dispatch');
					results[index] = stopped(call);
					this.ctx.emit('agent/tool-result', state.ref, { ...call, arguments: args }, 'Stopped by the user.');
				};
				let outcome: ToolOutcome;
				if (pre.blocked) {
					const reason = `blocked by hook: ${pre.reason ?? 'no reason given'}`;
					this.denyTrace(state, index, reason, {
						layer: 'hook',
						decision: 'deny',
						matchedRule: 'PreToolUse',
						reason,
					});
					outcome = { content: `Error: ${reason}`, isError: true };
				} else {
					try {
						outcome = await this.ctx.tools.invoke(
							{ ...call, arguments: args },
							this.toolContext(state, runtime.signal, authorization, state.traces?.[index] ? index : undefined),
						);
					} catch (error) {
						if (runtime.signal.aborted) {
							settleStopped();
							return;
						}
						throw error;
					}
					if (runtime.signal.aborted) {
						settleStopped();
						return;
					}
					const failed = outcome.isError || outcome.content.startsWith('Error:');
					let post;
					try {
						post = await abortable(
							runtime.signal,
							this.ctx.hooks.fire(failed ? 'PostToolUseFailure' : 'PostToolUse', call.name, {
								session_id: state.sessionId,
								tool_name: call.name,
								tool_input: parseArguments(args),
								tool_response: outcome.content,
							}),
						);
					} catch (error) {
						if (runtime.signal.aborted) {
							settleStopped();
							return;
						}
						throw error;
					}
					if (post.contexts.length) {
						outcome = { ...outcome, content: `${outcome.content}\n\n[hook] ${post.contexts.join('\n[hook] ')}` };
					}
					// A failed call is text the model has to read, not a picture it should look at.
					if (failed) {
						outcome = { ...outcome, images: undefined };
					}
				}
				// The bytes become a stored reference before the message is written; the transcript never
				// carries base64, and the model still sees the picture on the next step.
				const attachments = await this.rememberAttachments(state, call, outcome.images);
				if (outcome.images?.length && !attachments?.length) {
					const why =
						this.imagesOff.get(state.sessionId) === state.policy.model || state.imagesOff === state.policy.model
							? 'this model does not accept images'
							: 'the image could not be attached';
					outcome = { ...outcome, content: `${outcome.content}\n\n[image output omitted: ${why}]` };
				}
				this.ctx.emit('agent/tool-result', state.ref, { ...call, arguments: args }, outcome.content, imageParts(attachments));
				this.ctx.audit.write(state.sessionId, {
					kind: 'tool',
					tool: call.name,
					arguments: clip(args, 500),
					output: clip(outcome.content, 500),
					images: attachmentNotes(attachments),
					trace_id: state.traces?.[index]?.callId,
					...(state.agentName ? { subagent: state.agentName, root: state.rootSessionId } : {}),
				});
				results[index] = { role: 'tool', toolCallId: call.id, content: outcome.content, attachments, at: Date.now() };
			};
			// Read-only calls run in small parallel batches; writes, tasks and questions stay ordered.
			const parallel: number[] = [];
			const serial: number[] = [];
			state.toolCalls.forEach((call, index) => {
				const tool = this.ctx.tools.get(call.name);
				const readOnly =
					(tool?.capability === 'ro' || tool?.capability === 'shell_ro') &&
					call.name !== 'ask_user' &&
					tool?.serial !== true;
				(readOnly ? parallel : serial).push(index);
			});
			for (let start = 0; start < parallel.length; start += 6) {
				const batch = parallel.slice(start, start + 6);
				await Promise.all(batch.map((index) => runCall(state.toolCalls[index]!, index)));
			}
			for (const index of serial) {
				await runCall(state.toolCalls[index]!, index);
			}
			// Every call gets a result so the model's tool-call message is still a valid request.
			state.toolCalls.forEach((call, index) => {
				results[index] ??= stopped(call);
			});
			const messages = results.filter((message): message is Message => message !== null);
			return {
				...state,
				toolCalls: [],
				traces: undefined,
				messages: [...state.messages, ...messages],
				transcript: [...state.transcript, ...messages],
			};
		});

		nodes.set('agent.gate', async (state) => {
			// A parent tightening lands before the gate reads the call, including while the approval
			// was open: a grant the parent no longer allows must not run.
			this.refreshSubagentPolicy(state);
			// The turn's own rules, not the current settings: a delegated agent carries its snapshot,
			// and a main turn keeps the rules it started with.
			const rules = state.policy.rules ?? this.ctx.settings.rules();
			const snapshot = policySnapshot(state.policy, rules);
			const workspace = state.policy.workingDirectory;
			const created = new Set(this.createdInSession(state));
			const createdDirs = new Set(this.createdDirsInSession(state));
			if (process.platform !== 'win32' && workspace.trim()) {
				// A command that creates and removes the same literal path is safe when the path is
				// absent now: the creation form will make it, and rm cannot delete a user's file.
				for (const call of state.toolCalls) {
					const tool = this.ctx.tools.get(call.name);
					if (!tool || !isShellCapability(tool.capability)) {
						continue;
					}
					const command = callTarget(call, tool);
					const files = new Set(creationTargets(command, workspace));
					const dirs = new Set(directoryTargets(command, workspace));
					if (!files.size && !dirs.size) {
						continue;
					}
					for (const target of rmTargets(command, workspace)) {
						if (!files.has(target) && !dirs.has(target)) {
							continue;
						}
						let exists = true;
						try {
							lstatSync(target);
						} catch (error) {
							exists = (error as NodeJS.ErrnoException).code !== 'ENOENT';
						}
						if (exists) {
							continue;
						}
						const clean = createdPath(relative(resolve(workspace), target).split(sep).join('/'));
						if (clean) {
							(dirs.has(target) ? createdDirs : created).add(clean);
						}
					}
				}
			}
			// The trees the session owns outright: the test scratch and the workspace temp dir are the
			// AI's own, so a workspace-writable shell may delete under them without asking.
			const scratch = workspace.trim() ? scratchDirectory(workspace, state.rootSessionId) : undefined;
			const temp = workspace.trim() ? workspaceTempDir(workspace) : undefined;
			const inTree = (root: string | undefined, target: string): boolean =>
				Boolean(root && (resolve(target) === resolve(root) || insideRealWorkspace(root, target)));
			const result = evaluatePolicy({
				calls: state.toolCalls,
				lookup: (name) => this.ctx.tools.get(name),
				policy: state.policy,
				rules,
				env: {
					sandbox: this.ctx.host.sandboxKind(),
					created: process.platform === 'win32' ? undefined : created,
					createdDirs: process.platform === 'win32' ? undefined : createdDirs,
					deletionStaysInside:
						process.platform === 'win32' ? undefined : (target) => insideRealWorkspace(workspace, target),
					deletionScratch: process.platform === 'win32' ? undefined : (target) => inTree(scratch, target) || inTree(temp, target),
				},
				toolsEnabled: state.toolsEnabled !== false,
				toolEnabled: (name) => this.ctx.tools.isEnabled(name),
				delegated: state.filter ? (tool) => this.subagentToolAllowed(state, tool) : undefined,
			});
			// The first pass opens one chain per call; the resumed pass reuses them and appends the
			// answer to the decision that asked for it.
			if (!state.traces) {
				this.beginTraces(state, result.calls, snapshot);
			}
			let outcome = result.outcome;
			let reason = result.reason;
			if (state.approval) {
				this.respondTraces(state, state.approval.allowed ? 'allow' : 'deny', state.approval.reason);
			}
			if (result.outcome === 'reject') {
				// A policy rejection always wins, even when the user approved; the resumed pass records
				// the layer that tightened so the trace explains the reversal.
				const deciding = result.calls.find((call) => call.decision === 'reject')?.traces.at(-1);
				result.calls.forEach((call, index) => {
					if (state.approval?.allowed && deciding) {
						this.appendTraceStep(state, index, deciding);
					}
					this.denyTrace(
						state,
						index,
						call.decision === 'reject' ? (deciding?.reason ?? result.reason) : `batch rejected: ${result.reason}`,
					);
				});
			} else if (state.approval && !state.approval.allowed) {
				outcome = 'reject';
				// The model sees both why the call reached approval and why it was denied.
				reason =
					state.approval.reason === result.reason
						? result.reason
						: `${result.reason}; ${state.approval.reason}`;
			} else if (state.approval?.allowed && outcome === 'confirm') {
				outcome = 'allow';
			}
			state.gateReason = reason;
			state.outcome = outcome;
			state.authorization =
				outcome === 'allow'
					? issueAuthorization({
							sessionId: state.sessionId,
							batch: state.batch,
							callIds: state.toolCalls.map((call) => call.id),
						})
					: undefined;
			return state;
		});

		routes.set('agent.after-llm', (state) => {
			// A budget stop ends the run before the next batch, even if the model emitted calls.
			if (state.stop || state.toolCalls.length === 0) {
				return 'end';
			}
			// The call is revalidated against a parent that may have tightened during the request.
			this.refreshSubagentPolicy(state);
			// A silent generation is offered no tools, so a call it makes anyway is dropped with its
			// turn: the reply is what it wrote, and nothing is run on its behalf. Its transcript is
			// discarded afterwards, so the unanswered calls never reach the chat record.
			if (SILENT_TRIGGERS.has(state.trigger)) {
				const rules = state.policy.rules ?? this.ctx.settings.rules();
				this.denyWithoutGate(
					state,
					'a silent generation drops tool calls',
					policySnapshot(state.policy, rules),
					'silent-generation',
				);
				return 'end';
			}
			return 'calls';
		});

		routes.set('agent.gate', (state) => {
			if (!state.outcome) {
				throw new Error('agent.gate ran without an outcome');
			}
			return state.outcome === 'allow' ? 'tools' : state.outcome === 'confirm' ? 'approval' : 'reject';
		});

		return { nodes, routes };
	}

	/**
	 * Re-applies the parent's current restrictions to a live child. The child snapshot only ever
	 * narrows, so a parent that later relaxes its own policy cannot widen the child. A running turn
	 * picks this up before its next model request and before its next gate.
	 */
	private refreshSubagentPolicy(state: RunState): void {
		if (!state.filter) {
			return;
		}
		const session = this.subagentSessions.get(state.sessionId) ?? this.ctx.sessions.get(state.sessionId);
		if (!session) {
			return;
		}
		const next = this.tightenChildSession(session);
		if (!next) {
			return;
		}
		state.policy = next;
		state.filter = { allow: next.tools ?? [] };
	}

	/** The tightened policy of one child session, persisted when its revision changes. */
	private tightenChildSession(session: Session): SessionPolicy | undefined {
		const parent = session.parentId ? this.ctx.sessions.get(session.parentId) : undefined;
		if (!parent) {
			return undefined;
		}
		const facts = parentFacts(parent.policy, this.policyFor());
		const next = tightenSubagentPolicy(session.policy, facts, (policy) => this.ctx.tools.visible(policy).map((tool) => tool.name));
		const rules = next.rules ?? this.ctx.settings.rules();
		const revision = policyRevision(policySnapshot(next, rules));
		if (revision === session.policyRevision) {
			return undefined;
		}
		session.policy = next;
		session.policyRevision = revision;
		this.ctx.sessions.save(session);
		this.ctx.emit('subagent/changed', session.id);
		return next;
	}

	/** The context every trace record carries, so a call id resolves to a chat and a model call. */
	private traceContext(state: RunState, call: ToolCall): TraceContext {
		return {
			sessionId: state.sessionId,
			turn: state.turn,
			providerCallId: call.id,
			toolName: call.name,
			...(state.agentName ? { subagent: state.agentName } : {}),
		};
	}

	/** Opens one chain per call, in the same order as `state.toolCalls`. */
	private beginTraces(state: RunState, calls: readonly { traces: PolicyStep[] }[], snapshot: PolicySnapshot): void {
		state.traces = state.toolCalls.map((call, index) =>
			this.ctx.decisions.begin(this.traceContext(state, call), calls[index]?.traces ?? [], snapshot),
		);
	}

	/**
	 * A denial reached before the gate (silent generation, a missing authorization) still gets a
	 * truthful node, so no model-issued call is invisible.
	 */
	private denyWithoutGate(
		state: RunState,
		reason: string,
		snapshot: PolicySnapshot,
		matchedRule = 'capability',
		layer: PolicyStep['layer'] = 'capability',
	): void {
		state.traces = state.toolCalls.map((call) => {
			const trace = this.ctx.decisions.begin(
				this.traceContext(state, call),
				[{ layer, decision: 'deny', matchedRule, reason }],
				snapshot,
			);
			this.ctx.decisions.terminal(trace, 'denied', reason);
			return trace;
		});
	}

	private appendTraceStep(state: RunState, index: number, step: PolicyStep): CallTrace | undefined {
		const trace = state.traces?.[index];
		if (!trace) {
			return undefined;
		}
		const next = this.ctx.decisions.extend(trace, step);
		state.traces![index] = next;
		return next;
	}

	/** Ends one call's chain, optionally after appending the layer that denied it. */
	private denyTrace(state: RunState, index: number, reason: string, step?: PolicyStep): void {
		const trace = step ? this.appendTraceStep(state, index, step) : state.traces?.[index];
		if (trace) {
			this.ctx.decisions.terminal(trace, 'denied', reason);
		}
	}

	private denyAllTraces(state: RunState, reason: string): void {
		for (const trace of state.traces ?? []) {
			this.ctx.decisions.terminal(trace, 'denied', reason);
		}
	}

	/** Appends the approval response policy's decision to every call in the batch. */
	private respondTraces(
		state: RunState,
		decision: 'allow' | 'deny',
		reason: string,
		matchedRule: string = state.policy.approvalResponse,
	): void {
		const step: PolicyStep = {
			layer: 'response',
			decision,
			matchedRule,
			reason,
		};
		state.traces = state.traces?.map((trace) => this.ctx.decisions.extend(trace, step));
		if (decision === 'deny') {
			this.denyAllTraces(state, reason);
		}
	}

	/**
	 * Stores what a tool handed back and returns the references the message keeps. A model that already
	 * refused images gets none; a store failure is reported and the tool text stands on its own.
	 */
	private async rememberAttachments(state: RunState, call: ToolCall, images?: ToolImage[]): Promise<ImageAttachment[] | undefined> {
		if (!images?.length || this.imagesOff.get(state.sessionId) === state.policy.model || state.imagesOff === state.policy.model) {
			return undefined;
		}
		const parts: ImageAttachment[] = [];
		let dropped = 0;
		for (const image of images.slice(0, MAX_IMAGES_PER_MESSAGE)) {
			try {
				const stored = await this.ctx.attachments.putImage(image.data, image.name);
				parts.push({ ...stored, origin: 'tool' });
			} catch (error) {
				dropped += 1;
				this.ctx.log.message(`dropped image from ${call.name}: ${describe(error)}`);
			}
		}
		if (images.length > MAX_IMAGES_PER_MESSAGE) {
			dropped += images.length - MAX_IMAGES_PER_MESSAGE;
		}
		if (dropped) {
			this.notice(state.ref, `Dropped ${dropped} image(s) from ${call.name}: they could not be attached or exceeded limits.`);
		}
		return parts.length ? parts : undefined;
	}

	/** Whether a subagent's model may see or run this tool; the main agent is unfiltered here. */
	private subagentToolAllowed(state: RunState, tool: ToolSpec): boolean {
		if (!state.filter) {
			return true;
		}
		if (!SUBAGENT_CAPABILITIES.includes(tool.capability)) {
			return false;
		}
		return !state.filter.allow || state.filter.allow.includes(tool.name);
	}

	private toolContext(
		state: RunState,
		signal: AbortSignal,
		authorization: ToolAuthorization | undefined,
		traceIndex?: number,
	): ToolContext {
		return {
			sessionId: state.sessionId,
			rootSessionId: state.rootSessionId,
			batch: state.batch,
			...(state.taskId ? { taskId: state.taskId } : {}),
			...(state.agentName ? { agentName: state.agentName } : {}),
			authorization,
			workspace: state.policy.workingDirectory,
			policy: state.policy,
			signal,
			// The task graph belongs to the root turn; a child has no accessor and cannot mutate it.
			...(state.filter
				? {}
				: {
						taskGraph: {
							sessionId: state.sessionId,
							turn: state.turn,
							get: () => this.turnSession(state.sessionId)?.taskGraph,
							set: (graph) => {
								const live = this.turnSession(state.sessionId);
								if (!live) {
									throw new Error('no live session for this task graph');
								}
								live.taskGraph = graph;
								this.ctx.sessions.save(live);
							},
						},
					}),
			traceStep:
				traceIndex === undefined
					? undefined
					: (step) => {
							this.appendTraceStep(state, traceIndex, step);
						},
			traceDenied:
				traceIndex === undefined
					? undefined
					: (reason) => {
							const trace = state.traces?.[traceIndex];
							if (trace) {
								this.ctx.decisions.terminal(trace, 'denied', reason);
							}
						},
			traceDispatch:
				traceIndex === undefined
					? undefined
					: (reason) => {
							// The call's effective range, not just the session mode: the read-only shell and
							// the test shell narrow the mode for their own capability.
							const tool = this.ctx.tools.get(state.toolCalls[traceIndex]?.name ?? '');
							const write = writeScopeFor({
								sandboxMode: state.policy.sandboxMode,
								write: tool?.capability === 'shell_test' ? 'scratch' : tool?.capability === 'shell_ro' ? 'none' : undefined,
							});
							const reads = sandboxReads(state.policy.sandboxMode);
							const trace = this.appendTraceStep(state, traceIndex, {
								layer: 'sandbox',
								decision: 'allow',
								matchedRule: state.policy.sandboxMode,
								reason: `${reason}; read=${reads}; write=${write}`,
							});
							if (trace) {
								this.ctx.decisions.terminal(trace, 'dispatch_started');
							}
						},
			// One scratch root per chat; each child gets its own subtree so parallel tests do not collide.
			scratchDirectory: state.policy.workingDirectory.trim()
				? scratchDirectory(state.policy.workingDirectory, state.rootSessionId, state.sessionId)
				: undefined,
			resolveReference: (path, options) => this.ctx.references.resolvePath(path, scopeOf(state.policy), signal, options),
			log: (text) => this.notice(state.ref, text),
			ask: async (question, options, multi) => {
				if (signal.aborted) {
					return [];
				}
				// A surface may render the question (the panel's inline card); the native host answers
				// when nobody claims it, which is the participant and turns with no surface.
				const answers = await Promise.resolve(
					this.ctx.waterfall(
						'question/request',
						{ question, options, multi, sessionId: state.sessionId, surface: state.ref.surface, signal },
						() => this.ctx.host.ask(question, options, multi),
					),
				);
				return Array.isArray(answers)
					? answers.filter((answer): answer is string => typeof answer === 'string')
					: [];
			},
			todos: (items) => {
				if (items) {
					this.todoLists.set(state.sessionId, items);
					this.ctx.sessions.changed(state.sessionId);
				}
				return this.todoLists.get(state.sessionId) ?? [];
			},
			tasks: this.ctx.tasks,
			spawnAgent: (request) => this.spawnAgent(state, request),
			sensitiveEnv: this.ctx.settings.get().filterSensitiveEnv,
			edit: (path, write) => this.journalEdit(state, path, write),
			noteCreated: (path) => this.noteCreated(state, path),
			noteCreatedDir: (path) => this.noteCreatedDir(state, path),
			noteDeleted: (path) => this.noteDeleted(state, path),
		};
	}

	/**
	 * Runs one file write and journals its content before and after. The first write of a path in a
	 * turn records the earlier content; later writes in the same turn only move the after-hash.
	 * Nothing is recorded when there is no workspace, when checkpoints are off, or when the write fails.
	 */
	private async journalEdit(state: RunState, path: string, write: () => Promise<void>): Promise<void> {
		// Parallel subagents may write different files at once; the same absolute path is one at a time.
		return this.writeLocks.run(resolve(path), () => this.journalEditLocked(state, path, write));
	}

	private async journalEditLocked(state: RunState, path: string, write: () => Promise<void>): Promise<void> {
		const workspace = state.policy.workingDirectory;
		const inside = Boolean(workspace) && isInside(workspace, path);
		const rel = inside ? relative(resolve(workspace), resolve(path)).split(sep).join('/') : '';
		// A subagent's writes belong to the chat that spawned it: the same journal, provenance and
		// review as the main agent's own writes.
		const session = this.turnSession(state.rootSessionId) ?? this.ctx.sessions.get(state.rootSessionId);
		// The journal is a feature of its own, not a part of the agent: without its plugin (or with
		// checkpoints switched off) a write is simply a write, and nothing is recorded.
		const journal = this.ctx.get('checkpoints') as JournalApi | undefined;
		if (!workspace || !session || !journal || !this.ctx.settings.get().checkpoints || !inside) {
			await write();
			if (rel) {
				state.writes.add(rel);
			}
			return;
		}
		let before: string | null;
		try {
			// The turn's restore point is taken before its first write: restoring to it undoes the whole
			// turn. `length` is this turn's prompt index, which is what an edited prompt cuts at. The
			// keyed mutex makes the check-and-push atomic across parallel child writes.
			await this.markLocks.run(`${session.id}:${session.turnIndex}`, async () => {
				if (session.marks.some((mark) => mark.turn === session.turnIndex)) {
					return;
				}
				const entries = await journal.entries(workspace, session.id);
				if (session.marks.some((mark) => mark.turn === session.turnIndex)) {
					return;
				}
				const prompt = session.transcript.findLastIndex((message) => message.role === 'user');
				session.marks.push({
					turn: session.turnIndex,
					entryCount: entries.length,
					length: Math.max(0, prompt),
					at: Date.now(),
				});
				this.ctx.sessions.save(session);
			});
			before = await journal.store(workspace, state.rootSessionId, rel);
		} catch (error) {
			// A shadow repository that cannot be reached (git missing, storage gone) must not keep the
			// agent from writing: with nothing recorded, this write is what a disabled journal leaves.
			this.ctx.log.message(`journal: not recording (${describe(error)}); writing without an entry`);
			await write();
			state.writes.add(rel);
			return;
		}
		await write();
		state.writes.add(rel);
		try {
			const after = await journal.store(workspace, state.rootSessionId, rel);
			await journal.record(workspace, state.rootSessionId, session.turnIndex, rel, before, after);
		} catch (error) {
			// The write already happened; a failure to record it is said, not thrown back over it.
			this.ctx.log.message(`journal: the write landed but was not recorded (${describe(error)})`);
		}
	}

	/**
	 * Merges the journal's creations into the session once per session and workspace. The journal is
	 * read even when new writes are paused: its entries record what earlier file tools created, and
	 * the gate may use them to let the agent remove its own files without an approval.
	 */
	private async backfillCreated(session: Session, workspace: string): Promise<void> {
		if (!workspace.trim()) {
			return;
		}
		const root = resolve(workspace);
		const key = `${session.id}\0${root}`;
		if (session.createdRoot !== root) {
			session.created = [];
			session.createdDirs = [];
			session.createdRoot = root;
			this.createdBackfilled.delete(key);
		}
		if (this.createdBackfilled.has(key)) {
			return;
		}
		const journal = this.ctx.get('checkpoints') as JournalApi | undefined;
		if (journal) {
			try {
				const created = new Set(session.created ?? []);
				for (const entry of await journal.entries(workspace, session.id)) {
					if (entry.before !== null) {
						continue;
					}
					const path = createdPath(entry.path);
					if (path) {
						created.add(path);
					}
				}
				session.created = [...created].slice(-MAX_CREATED_PATHS);
				this.ctx.sessions.save(session);
			} catch (error) {
				this.ctx.log.message(`created: journal backfill failed (${describe(error)})`);
				return;
			}
		}
		this.createdBackfilled.add(key);
	}

	/** The provenance the gate may use, bound to the workspace it was recorded under. */
	private createdInSession(state: RunState): ReadonlySet<string> {
		const session = this.turnSession(state.rootSessionId) ?? this.ctx.sessions.get(state.rootSessionId);
		return session ? createdInWorkspace(session, state.policy.workingDirectory) : new Set();
	}

	private createdDirsInSession(state: RunState): ReadonlySet<string> {
		const session = this.turnSession(state.rootSessionId) ?? this.ctx.sessions.get(state.rootSessionId);
		return session ? createdDirsInWorkspace(session, state.policy.workingDirectory) : new Set();
	}

	private noteCreated(state: RunState, path: string): void {
		this.noteProvenance(state, path, 'files');
	}

	/** A created directory owns its whole subtree for the deletion check. */
	private noteCreatedDir(state: RunState, path: string): void {
		this.noteProvenance(state, path, 'dirs');
	}

	private noteProvenance(state: RunState, path: string, kind: 'files' | 'dirs'): void {
		const session = this.turnSession(state.rootSessionId) ?? this.ctx.sessions.get(state.rootSessionId);
		const workspace = state.policy.workingDirectory;
		if (!session || !workspace.trim()) {
			return;
		}
		const root = resolve(workspace);
		if (session.createdRoot !== root) {
			session.created = [];
			session.createdDirs = [];
			session.createdRoot = root;
		}
		const clean = createdPath(relative(root, resolve(path)).split(sep).join('/'));
		if (!clean) {
			return;
		}
		const list = new Set(kind === 'files' ? session.created ?? [] : session.createdDirs ?? []);
		if (list.has(clean)) {
			return;
		}
		list.add(clean);
		const bounded = [...list].slice(-MAX_CREATED_PATHS);
		if (kind === 'files') {
			session.created = bounded;
		} else {
			session.createdDirs = bounded;
		}
	}

	private noteDeleted(state: RunState, path: string): void {
		const session = this.turnSession(state.rootSessionId) ?? this.ctx.sessions.get(state.rootSessionId);
		const workspace = state.policy.workingDirectory;
		if (!session || !workspace.trim()) {
			return;
		}
		const root = resolve(workspace);
		if (session.createdRoot !== root) {
			return;
		}
		const clean = createdPath(relative(root, resolve(path)).split(sep).join('/'));
		if (!clean) {
			return;
		}
		const gone = (entry: string): boolean => entry !== clean && !entry.startsWith(`${clean}/`);
		session.created = (session.created ?? []).filter(gone);
		session.createdDirs = (session.createdDirs ?? []).filter(gone);
	}

	private async spawnAgent(parent: RunState, request: AgentSpawnRequest): Promise<AgentSpawnOutcome> {
		const failed = (error: string): AgentSpawnOutcome => ({ ok: false, report: '', writes: [], error });
		// A child has a filter; only the root Orchestrator may delegate.
		if (parent.filter) {
			return failed('subagents cannot delegate');
		}
		const role = request.pinned
			? (request.agent ? BUILTIN_ROLE_BY_ID.get(request.agent.trim().toLowerCase()) : undefined)
			: this.ctx.catalog.agent(request.agent);
		if (!role) {
			return failed(`unknown agent ${request.agent ?? '(none)'}`);
		}
		// A delegation can only narrow: validate every field here rather than trusting the model's JSON.
		if (
			request.capabilities !== undefined &&
			(!Array.isArray(request.capabilities) ||
				request.capabilities.some(
					(capability) => typeof capability !== 'string' || !(ALL_CAPABILITIES as readonly string[]).includes(capability),
				))
		) {
			return failed('invalid capabilities for a subagent delegation');
		}
		if (request.capabilities?.some((capability) => !role.capabilities.includes(capability))) {
			return failed(`${role.id} cannot use ${request.capabilities.filter((capability) => !role.capabilities.includes(capability)).join(', ')}`);
		}
		if (request.network !== undefined && typeof request.network !== 'boolean') {
			return failed('the subagent network constraint must be a boolean');
		}
		if (request.network === true && !role.network) {
			return failed(`${role.id} does not allow network`);
		}
		if (request.sandboxMode !== undefined && !Object.hasOwn(SANDBOX_LABELS, request.sandboxMode)) {
			return failed('invalid sandbox mode for a subagent delegation');
		}
		if (request.approval !== undefined && !Object.hasOwn(APPROVAL_LABELS, request.approval)) {
			return failed('invalid approval policy for a subagent delegation');
		}
		const capabilities = request.capabilities === undefined ? [...role.capabilities] : [...new Set(request.capabilities)];
		const constraints: DelegationConstraints = {
			capabilities,
			network: request.network ?? role.network,
			...(request.sandboxMode ? { sandboxMode: request.sandboxMode } : {}),
			...(request.approval ? { approval: request.approval } : {}),
		};
		// The candidate carries the effective capabilities/network/sandbox/rules; its tool list is
		// computed against the registry before the final policy (and its revision) is written.
		const parentPolicy: SessionPolicy = {
			...parent.policy,
			rules: parent.policy.rules ?? this.ctx.settings.rules(),
		};
		const candidate = buildSubagentPolicy(parentPolicy, constraints, undefined, role.model || parent.policy.model);
		const grant = subagentGrant(this.ctx.settings.get(), role);
		// The settings grant is the authorization; the role's tools are the selection. The orchestrator
		// tools and leaf-forbidden tools are excluded even from a custom role's list.
		const listed = this.ctx.tools
			.visible(candidate)
			.filter((tool) => SUBAGENT_CAPABILITIES.includes(tool.capability))
			.filter((tool) => !SUBAGENT_EXCLUDED_TOOLS.includes(tool.name))
			.filter((tool) => !parent.filter?.allow || parent.filter.allow.includes(tool.name))
			.filter((tool) => tool.capability !== 'rw' || (grant.files && tool.trackedWrite === true))
			.filter((tool) => tool.capability !== 'shell_test' || grant.test)
			.map((tool) => tool.name);
		// No explicit tools list means read-only: a custom role opts into writing by naming the tool.
		const allow = role.tools?.length
			? allowedToolsFor(role, listed)
			: listed.filter((name) => {
					const capability = this.ctx.tools.get(name)?.capability;
					return capability === undefined || !SUBAGENT_WRITE_CAPABILITIES.includes(capability);
				});
		const policy: SessionPolicy = { ...candidate, tools: allow };
		const revision = policyRevision(policySnapshot(policy, policy.rules ?? this.ctx.settings.rules()));
		const subId = request.resumeSessionId ?? `sub-${randomUUID()}`;
		let release: (() => void) | undefined;
		try {
			release = await this.acquireSubagentSlot(request.signal);
			return await this.runSubagent(parent, request, role, policy, revision, subId, allow, callIdOf(request));
		} catch (error) {
			return failed(describe(error));
		} finally {
			release?.();
		}
	}

	/** Creates the child conversation, runs its graph and returns the structured outcome. */
	private async runSubagent(
		parent: RunState,
		request: AgentSpawnRequest,
		role: AgentRole,
		policy: SessionPolicy,
		revision: string,
		subId: string,
		allow: string[],
		callId: string | undefined,
	): Promise<AgentSpawnOutcome> {
		const config = this.ctx.settings.get();
		// The parent's card links to the child conversation. The map lives on the session that owns
		// the call, so a nested card could link its own child rather than the root's.
		const owner =
			this.turnSession(parent.sessionId) ?? this.subagentSessions.get(parent.sessionId) ?? this.ctx.sessions.get(parent.sessionId);
		if (owner && callId) {
			const links = Object.entries({ ...(owner.subagents ?? {}), [callId]: subId });
			// Keep the newest links: an old card losing its link is better than an unbounded session file.
			owner.subagents = Object.fromEntries(links.slice(-256));
			try {
				this.ctx.sessions.save(owner);
			} catch (error) {
				this.ctx.log.message(`subagent link: ${describe(error)}`);
			}
		}
		const instructions = config.instructions
			? instructionBody(await loadInstructions(policy.workingDirectory, this.ctx.host.home(), this.ctx.host.trusted()))
			: '';
		const memory = config.memory ? await readMemory(memoryDir(this.ctx.host.storage.root, policy.workingDirectory)) : '';
		const skills = config.skills && allow.includes('skill') ? skillLines(this.ctx.catalog.skills) : '';
		// Inherit copies the root run's current limits (not its remaining budget); the task/resume
		// budget can still tighten both modes.
		const budgetLimits = resolveSubagentBudget({
			mode: config.subagentBudgetMode,
			parent: parent.budget?.limits ?? parent.policy.budget,
			global: config.subagentBudget,
			role: role.budget,
			task: request.budget,
		});
		const system = buildSubagentSystemPrompt({
			role,
			contract: request.contract ?? 'worker',
			instructions,
			memory,
			skills,
			network: policy.network,
			sandbox: policy.sandboxMode,
			capabilities: [...capabilitiesOf(policy)],
			budget: budgetLimits,
		});
		// Resume is a continuation, not a retry: reuse the child session, its transcript and its
		// workspace writes, and start the graph at the normal entry (the next model turn).
		const previous = request.resumeSessionId ? this.ctx.sessions.get(subId) : undefined;
		if (request.resumeSessionId) {
			if (!previous) {
				return { ok: false, report: '', writes: [], sessionId: subId, error: `cannot resume ${subId}: the child session is gone` };
			}
			if (previous.parentId !== parent.sessionId || previous.subagent !== role.id) {
				return { ok: false, report: '', writes: [], sessionId: subId, error: `cannot resume ${subId}: it is not this role's child` };
			}
		}
		const subTranscript: Message[] = previous
			? [...previous.transcript]
			: [{ role: 'user', content: request.prompt, at: Date.now() }];
		// The child's conversation is a real session from this moment on: the card can open it while
		// it works, and it outlives the parent turn as a transcript.
		const child = previous ?? this.ctx.sessions.createChild(policy, subId, {
			title: subagentTitle(role.id, request.description),
			parentId: parent.sessionId,
			subagent: role.id,
			transcript: subTranscript,
			policyRevision: revision,
		});
		if (previous) {
			child.subagentDone = false;
			child.transcript = subTranscript;
			child.policy = policy;
			child.policyRevision = revision;
		}
		this.subagentSessions.set(subId, child);
		let latest = subTranscript;
		const remember = (next: Message[]): void => {
			latest = next;
			child.transcript = next;
			child.turnIndex = next.some((message) => message.role === 'user') ? 1 : 0;
			try {
				this.ctx.sessions.save(child);
			} catch (error) {
				this.ctx.log.message(`subagent session: ${describe(error)}`);
			}
			this.ctx.emit('subagent/changed', subId);
		};
		let finishChild: (() => void) | undefined;
		// Settles the child conversation even when an event listener throws before the graph starts.
		finishChild = () => {
			child.transcript = latest;
			child.subagentDone = true;
			try {
				this.ctx.sessions.save(child);
			} catch (error) {
				this.ctx.log.message(`subagent session: ${describe(error)}`);
			}
			this.ctx.emit('subagent/changed', subId);
			this.subagentSessions.delete(subId);
		};
		const state: RunState = {
			ref: { sessionId: subId },
			sessionId: subId,
			rootSessionId: parent.rootSessionId,
			agentName: role.id,
			...(request.taskId ? { taskId: request.taskId } : {}),
			writes: new Set(),
			budget: new RunBudget(budgetLimits),
			policy,
			transcript: subTranscript,
			messages: [{ role: 'system', content: system }, ...subTranscript],
			contextForm: config.contextForm,
			trailer: [],
			toolCalls: [],
			turn: child.turnIndex,
			gateReason: '',
			batch: 0,
			filter: { allow },
			// A subagent is an ordinary generation of its own; nothing about it is swiped or quieted.
			trigger: 'normal',
			prior: [],
			// A subagent's request is its own, with no chat record behind it to fold, so only elision
			// may shrink it; the isolation is what keeps its oversize off the parent.
			foldable: false,
		};
		const abort = new AbortController();
		const unlink = linkAbort(request.signal, abort);
		const budget = state.budget ?? new RunBudget();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = budget.deadline();
		if (deadline !== undefined) {
			timer = setTimeout(() => {
				budget.stop('milliseconds');
				abort.abort(new Error('time budget exhausted'));
			}, Math.min(2_147_483_647, Math.max(0, deadline - Date.now())));
		}
		try {
			request.onStart?.(subId);
			this.ctx.emit('agent/subagent-start', parent.ref, {
				callId,
				id: subId,
				name: role.id,
				description: request.description,
			});
			abort.signal.throwIfAborted();
			const runSegment = (current: RunState) =>
				runGraph(this.graph(), current, {
					signal: abort.signal,
					choose: (soft: SoftRequest) =>
						this.ctx.llm.choose(policy.model, soft, abort.signal, (usage) =>
							state.budget?.spendTokens(usage.input + usage.output),
						),
					onStep: (next) => remember(next.transcript),
				});
			const check = (report: string): string | null => {
				if (!request.checkReport) {
					return null;
				}
				try {
					return request.checkReport(report);
				} catch (error) {
					return describe(error);
				}
			};
			const outcome = await runSegment(state);
			let latestState = outcome.state;
			let status = outcome.status;
			let contractError: string | undefined;
			let dimension = budget.stopReason ?? latestState.stop ?? budget.check();
			// One repair round in the same child session: presentation errors are cheap to correct,
			// while rerunning the worker would repeat its tools and spend an attempt.
			if (status !== 'aborted' && !dimension && request.checkReport) {
				const rejected = check(lastAssistant(latestState.transcript)?.content ?? '');
				if (rejected) {
					const repair: Message = {
						role: 'user',
						content: `(runtime) Your final message failed the contract: ${rejected}\nReturn exactly one corrected JSON object matching the contract in your system prompt. Do not repeat completed work and do not run tools; reuse what is already in the transcript.`,
						at: Date.now(),
					};
					const transcript = [...latestState.transcript, repair];
					remember(transcript);
					const repaired = await runSegment({
						...latestState,
						messages: [...latestState.messages, repair],
						transcript,
						toolCalls: [],
						traces: undefined,
						stop: undefined,
						lastTool: undefined,
						gateReason: '',
						batch: 0,
						approval: undefined,
						outcome: undefined,
						authorization: undefined,
					});
					latestState = repaired.state;
					status = repaired.status;
					contractError = check(lastAssistant(latestState.transcript)?.content ?? '') ?? undefined;
					dimension = budget.stopReason ?? latestState.stop ?? budget.check();
				}
			}
			const lastTool = latestState.lastTool ?? state.lastTool;
			const observedCommands = collectShellEvidence(latestState.transcript);
			if (dimension) {
				budget.stop(dimension);
				const partial = sealPartial(latestState.messages, latestState.transcript, dimension);
				latest = latestState.transcript;
				child.transcript = latest;
				return {
					ok: false,
					paused: true,
					report: partial,
					writes: [...latestState.writes],
					sessionId: subId,
					budget: budget.report(),
					...(lastTool ? { lastTool } : {}),
					observedCommands,
				};
			}
			const stopped = status === 'aborted';
			return {
				ok: !stopped,
				report: stopped ? '(stopped)' : (lastAssistant(latestState.transcript)?.content ?? ''),
				writes: [...latestState.writes],
				sessionId: subId,
				budget: budget.report(),
				...(stopped ? { stopped: true } : {}),
				...(lastTool ? { lastTool } : {}),
				...(contractError ? { contractError } : {}),
				observedCommands,
			};
		} catch (error) {
			const dimension = budget.stopReason ?? budget.check();
			if (dimension) {
				budget.stop(dimension);
				const partial = sealPartial(state.messages, state.transcript, dimension);
				latest = state.transcript;
				child.transcript = latest;
				return {
					ok: false,
					paused: true,
					report: partial,
					writes: [...state.writes],
					sessionId: subId,
					budget: budget.report(),
					...(state.lastTool ? { lastTool: state.lastTool } : {}),
				};
			}
			return { ok: false, report: '', writes: [...state.writes], sessionId: subId, error: describe(error) };
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			unlink();
			try {
				finishChild();
			} catch (error) {
				this.ctx.log.message(`subagent session: ${describe(error)}`);
			}
		}
	}

	/** Waits for a subagent slot; the queue is the concurrency cap without a hard failure. */
	private async acquireSubagentSlot(signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) {
			throw signal.reason ?? new Error('stopped');
		}
		if (this.activeSubagents < MAX_SUBAGENTS) {
			this.activeSubagents += 1;
			return () => this.releaseSubagentSlot();
		}
		return new Promise<() => void>((resolve, reject) => {
			const waiter = {
				signal,
				start: () => {
					signal.removeEventListener('abort', onAbort);
					this.activeSubagents += 1;
					resolve(() => this.releaseSubagentSlot());
				},
				abort: () => {
					signal.removeEventListener('abort', onAbort);
					const index = this.subagentWaiters.indexOf(waiter);
					if (index !== -1) {
						this.subagentWaiters.splice(index, 1);
					}
					reject(signal.reason ?? new Error('stopped'));
				},
			};
			const onAbort = (): void => waiter.abort();
			signal.addEventListener('abort', onAbort, { once: true });
			this.subagentWaiters.push(waiter);
		});
	}

	private releaseSubagentSlot(): void {
		this.activeSubagents = Math.max(0, this.activeSubagents - 1);
		const next = this.subagentWaiters.shift();
		if (!next) {
			return;
		}
		if (next.signal.aborted) {
			next.abort();
			return;
		}
		next.start();
	}

	/**
	 * The blocks of the system prompt this chat sends, in order, each with a stable id. `contexts` is
	 * the turn's own attached context, which only exists while a turn is being built; `trigger` decides
	 * whether this generation may carry tools at all.
	 */
	async promptBlocks(session: Session, contexts: string[] = [], trigger?: GenerationTrigger): Promise<PromptBlock[]> {
		const config = this.ctx.settings.get();
		const host = this.ctx.host;
		// A silent generation is offered no tools, so the prompt must not advertise any either.
		const visible = SILENT_TRIGGERS.has(trigger ?? 'normal') ? [] : this.ctx.tools.visible(session.policy);
		const has = (name: string): boolean => visible.some((tool) => tool.name === name);
		const rules = planRules({ policy: session.policy, visible: new Set(visible.map((tool) => tool.name)) });
		const setting = new Map(config.prompts.map((entry) => [entry.id, entry]));
		const prefixOf = (id: ComonadBlockId): string => setting.get(id)?.prefix ?? DEFAULT_BLOCK_PREFIX[id];
		const blocks: PromptBlock[] = [];
		// Only a block with a body is part of this turn. Its static opening is the user's prefix; the
		// dynamic part is what the agent just built.
		const push = (id: ComonadBlockId, body: string, separator = '\n'): void => {
			if (!body.trim()) {
				return;
			}
			const prefix = prefixOf(id);
			blocks.push({ id, name: blockName(id), prefix, body: body.trim(), text: composeBlockText(prefix, body, separator) });
		};

		push(
			COMONAD_BLOCK.identity,
			[
				`Mode: ${MODE_LABELS[session.policy.workMode] ?? session.policy.workMode} (capabilities: ${[...capabilitiesOf(session.policy)].join(', ') || 'none'}); approval: ${session.policy.approval}; approval response: ${session.policy.approvalResponse}; network: ${session.policy.network ? 'on' : 'off'}; sandbox: ${session.policy.sandboxMode}.`,
				`Today: ${new Date().toISOString().slice(0, 10)}.`,
			].join('\n'),
		);
		const toolBody: string[] = [];
		if (has('edit_ranges') || has('write_file')) {
			toolBody.push('Prefer edit_ranges for precise changes and write_file for new files or full rewrites.');
		}
		if (rules.planMode && visible.length > 0 && !session.parentId && !session.subagent) {
			const readers = rules.canReadPlans ? ' list_plans and read_plan show the plans recorded for this chat.' : '';
			const revise = rules.canReadPlans ? 'read_plan and then revise it with edit_plan' : 'revise it with edit_plan';
			const readAndRevise = rules.canReadPlans
				? 'Read the plan with read_plan and revise it with edit_plan'
				: 'Revise it with edit_plan';
			toolBody.push(
				rules.deliverable !== 'plan-file'
					? 'Plan mode: the implementation plan is the deliverable, but this session cannot write plan files. Put the plan in your final summary and stop; the user can switch to a write-capable mode to implement.'
					: rules.canCreatePlan && rules.canEditPlan
						? `Plan mode: the recorded plan is the deliverable. Create it with write_plan, or ${revise} when the user asks for changes, then stop and summarize; the user starts implementation from the plan card. ` +
							`Do not implement or delegate write work in this turn.${readers}`
						: rules.canCreatePlan
							? 'Plan mode: the recorded plan is the deliverable. Record the implementation plan with write_plan, then stop and summarize; the user starts implementation from the plan card. ' +
								`Do not implement or delegate write work in this turn.${readers}`
							: `Plan mode: the recorded plan is the deliverable. ${readAndRevise} when the user asks for changes, then stop and summarize; the user starts implementation from the plan card. ` +
								`edit_plan edits only an existing plan: if this chat has no plan file, put the implementation plan in your summary instead. Do not implement or delegate write work in this turn.${readers}`,
			);
		}
		if (!session.policy.workingDirectory) {
			toolBody.push('This session has no working directory: file, shell and task tools are unavailable.');
		}
		const toolsPrefix = prefixOf(COMONAD_BLOCK.tools);
		// The user edits the "tools are available" guidance; a turn with no tools uses the built-in
		// no-tools sentence instead, so the prompt can never tell the model to call what is not there.
		const toolsText = visible.length
			? composeBlockText(toolsPrefix, toolBody.join('\n'))
			: composeBlockText(NO_TOOLS_PREFIX, toolBody.join('\n'));
		if (toolsText.trim()) {
			blocks.push({ id: COMONAD_BLOCK.tools, name: blockName(COMONAD_BLOCK.tools), prefix: toolsPrefix, body: toolBody.join('\n').trim(), text: toolsText });
		}
		if (config.instructions) {
			const layers = await loadInstructions(session.policy.workingDirectory, host.home(), host.trusted());
			session.instructions = layers.map((layer) => layer.source);
			push(COMONAD_BLOCK.instructions, instructionBody(layers), '\n\n');
		}
		if (config.memory) {
			const memory = await readMemory(memoryDir(host.storage.root, session.policy.workingDirectory));
			push(COMONAD_BLOCK.memory, memory);
		}
		const todos = this.todoLists.get(session.id) ?? [];
		if (todos.length) {
			// The list travels with the rule that closes it: a turn must not leave work "in progress".
			push(COMONAD_BLOCK.todos, `${formatTodos(todos)}\n\nBefore you finish, call todo_write: every item must end completed or pending.`);
		}
		// The indexes advertise a tool, so they only travel when that tool does.
		if (config.skills && has('skill')) {
			push(COMONAD_BLOCK.skills, skillLines(this.ctx.catalog.skills));
		}
		if (has('delegate') && !session.parentId && !session.subagent) {
			push(COMONAD_BLOCK.orchestrator, this.ctx.orchestrator.prompt(session, rules));
		}
		if (contexts.length) {
			push(COMONAD_BLOCK.context, contexts.join('\n\n'));
		}
		// The pane previews a generated block far more often than it starts a turn, and it cannot await:
		// the last build is kept so `lastPromptBlocks()` can answer synchronously.
		this.lastBlocks.set(session.id, blocks);
		return blocks;
	}

	/** The blocks of the most recent prompt build for a chat, or an empty list before the first turn. */
	lastPromptBlocks(sessionId: string): readonly PromptBlock[] {
		return this.lastBlocks.get(sessionId) ?? [];
	}

	private notice(ref: TurnRef, text: string, detail?: NoticeDetail): void {
		this.ctx.emit('agent/notice', ref, text, detail);
	}
}

/** The wire text of a block list: the blocks separated by a blank line, as the model receives them. */
export function promptText(blocks: readonly PromptBlock[]): string {
	return blocks.map((block) => block.text).join('\n\n');
}

export const agentPlugin = Agent;

/**
 * The test shell's scratch tree. It sits inside the workspace so a workspace-write sandbox can
 * permit it while every read outside the workspace's mode stays refused; `run_shell_test` still
 * narrows the call to this one writable subpath. The real path is checked because a workspace can
 * ship `.comonad` (or the session folder) as a symlink: the scratch must not become a writable hole
 * outside the workspace. A path that escapes, or cannot be created, disables the test shell instead.
 */
export function scratchDirectory(workspace: string, rootSessionId: string, sessionId?: string): string | undefined {
	const leaf = sessionId && sessionId !== rootSessionId ? sessionId.replace(/[^A-Za-z0-9._-]/g, '_') : '';
	const dir = leaf
		? join(workspace, '.comonad', 'scratch', rootSessionId, leaf)
		: join(workspace, '.comonad', 'scratch', rootSessionId);
	try {
		mkdirSync(dir, { recursive: true });
		const root = realpathSync(workspace);
		return isInside(root, realpathSync(dir)) ? dir : undefined;
	} catch {
		return undefined;
	}
}

/** Whether a path lies inside the workspace; anything outside is not journaled. */
function isInside(workspace: string, path: string): boolean {
	const root = resolve(workspace);
	const target = resolve(path);
	const rel = relative(root, target);
	return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

/**
 * Whether deleting `target` provably stays inside the workspace. The parent is resolved, because
 * `rm link/file` follows the link; the target itself is not, because rm unlinks a symlink itself.
 */
function insideRealWorkspace(workspace: string, target: string): boolean {
	try {
		const root = realpathSync(workspace);
		const parent = realpathSync(dirname(target));
		const rel = relative(root, parent);
		return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
	} catch {
		return false;
	}
}

function parseArguments(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return {};
	}
}

function clip(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
