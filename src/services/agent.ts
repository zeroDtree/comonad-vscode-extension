// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Service, type Context } from 'cordis';
import { abortable, linkAbort } from '../lib/cancel';
import type { TurnRef } from '../lib/types';
import {
	DEFAULT_OUTPUT_RESERVE,
	buildModelHistory,
	dropPromptAttachments,
	elideToolResults,
	hasImageAttachments,
	modelSummaryMessage,
	planCompaction,
	resolveBudget,
	stripImageAttachments,
	type Budget,
	type ContextForm,
} from '../lib/prompt';
import { MAX_IMAGES_PER_MESSAGE } from '../lib/images';
import { attachmentNotes, imageParts } from '../lib/attachments';
import { estimateAttachments, estimateMessages, estimateTokens } from '../lib/tokens';
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
import { callTarget, gateCalls, isShellCapability, MODE_LABELS, suggestAllowRule, type PolicyStep } from '../lib/policy';
import { sandboxReads, workspaceTempDir, writeScopeFor } from '../lib/sandbox';
import { policySnapshot, type CallTrace, type PolicySnapshot, type TraceContext } from '../lib/trace';
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
	AgentSpawnRequest,
	AttachmentPart,
	Capability,
	ImageAttachment,
	Message,
	ModelContext,
	SessionPolicy,
	TodoItem,
	ToolCall,
	ToolContext,
	ToolImage,
	ToolSpec,
} from '../lib/types';
import type { GenerationTrigger } from '../lib/generations';
import type { ToolOutcome } from './tools';
import type { PresetSamplers } from 'comonad-plugin-tavern';
import { describe, formatTodos, lastAssistant, lastReplyIndex } from '../lib/util';
import { agentIndex, agentLines, allowedToolsFor, skillLines } from './catalog';
import type { JournalApi } from '../lib/journal';
import { DEFAULT_CONTEXT_WINDOW, subagentGrant, subagentStepBudget } from './settings';
import {
	canRewrite,
	createdDirsInWorkspace,
	createdInWorkspace,
	createdPath,
	MAX_CREATED_PATHS,
	threadTitle,
	type Session,
	type SwipeCarry,
} from './sessions';
import type { ComposeResult, TavernApi } from 'comonad-plugin-tavern';
import { scopeOf, type ResolveResult } from './references';

/** Room held back for the summary a compaction adds, so the fit it plans survives its own output. */
const SUMMARY_RESERVE = 1_024;

/** How many characters of the older turns one summary is allowed to read. */
const SUMMARY_SOURCE_LIMIT = 120_000;

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
	 * How this generation was started — SillyTavern's generation type. It decides which world-info
	 * entries may activate and how the reply is written down; `normal` is a plain prompt.
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
}

/** One running turn: the signal every part of it shares, from prompt building to the last tool. */
interface Turn {
	session: Session;
	ref: TurnRef;
	controller: AbortController;
	signal: AbortSignal;
	unlink: () => void;
}

interface RunState {
	ref: TurnRef;
	sessionId: string;
	/** The chat whose journal, provenance and review collect this run's writes. */
	rootSessionId: string;
	/** The subagent's name, for the audit trail; absent on the main agent. */
	agentName?: string;
	/** Workspace-relative files this run wrote through the tracked file tools. */
	writes: Set<string>;
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
	confirmed: boolean | null;
	filter?: { allow?: string[] };
	/**
	 * Whether this turn may offer tools at all: the preset's Tools row under ST, the core layout's
	 * Tools block otherwise. `undefined` (a subagent) leaves the policy's own list in charge.
	 */
	toolsEnabled?: boolean;
	/** Samplers a selected preset contributed to this turn. */
	samplers?: PresetSamplers;
	/** What started this turn, which decides what may activate and what gets written down. */
	trigger: GenerationTrigger;
	/** The transcript as it stood before this turn, which is what a quiet generation leaves behind. */
	prior: Message[];
	/** The exchange a swipe or a regenerate replaced, put back if the turn is stopped. */
	restore?: Message[];
	/** The reply a continue extends: its index in the transcript as it stood before this turn. */
	continueInto?: number;
	/** The variants a swipe or a regenerate replaces or grows. */
	swipes?: SwipeCarry;
	/**
	 * Whether this request may be rebuilt from the chat's transcript when it outgrows the window. It is
	 * true when the request is the transcript plus this turn, and false when something else composed
	 * it — a subagent owns it, or tavern content rewrote it — because then its parts no longer line up
	 * with a chat record and only elision may rewrite it.
	 */
	foldable: boolean;
}

const MAX_SUBAGENT_DEPTH = 2;

/**
 * The capabilities a subagent may ever hold. Full shell writes and plan writes are never among
 * them: a subagent's project changes go through tracked file tools, and its shell writes only the
 * scratch directory. The settings grant can narrow this set, never widen it.
 */
const SUBAGENT_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(['ro', 'shell_ro', 'rw', 'shell_test']);

/** The two capabilities a grant controls; a definition must also name a tool using one. */
const SUBAGENT_WRITE_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(['rw', 'shell_test']);

/** What a continue says as the user when the preset has no `continue_nudge_prompt` of its own. */
/**
 * The generation types that write nothing into the chat and run no tools: an impersonation streams into the
 * composer, and a quiet turn is the caller's alone. Neither is a turn the chat has taken.
 */
const SILENT_TRIGGERS: ReadonlySet<GenerationTrigger> = new Set<GenerationTrigger>(['impersonate', 'quiet']);

const CONTINUE_ASK = 'Continue the last message exactly where it stops. Do not repeat any of it, and do not start over.';

/** The display name of a Comonad block, shared with the tavern's preset list. */
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
	static inject = ['host', 'settings', 'graphs', 'sessions', 'attachments', 'references', 'tools', 'llm', 'hooks', 'catalog', 'commands', 'tokenizers', 'usage', 'tasks', 'approval', 'audit', 'decisions', 'log'];

	private readonly turns = new Map<string, Turn>();
	/** Background subagents outlive their turn; they are aborted only when the agent unloads. */
	private readonly backgroundSubagents = new Set<AbortController>();
	/** Session → the model that refused images there. A different model gets to try them again. */
	private readonly imagesOff = new Map<string, string>();
	/** `${sessionId}\0${root}` already merged from the journal in this process. */
	private readonly createdBackfilled = new Set<string>();
	private readonly todoLists = new Map<string, TodoItem[]>();
	private readonly pending = new Map<string, string[]>();
	private readonly greeted = new Set<string>();
	private readonly depths = new Map<string, number>();
	private readonly budgetWarned = new Set<string>();
	/** Sessions already warned that the world-info budget was spent. */
	private readonly overflowWarned = new Set<string>();
	/** The system prompt last given to each chat, so `/context` can break the budget down exactly. */
	private readonly systems = new Map<string, string>();
	/** The blocks the last prompt build produced, so a pane can preview generated text synchronously. */
	private readonly lastBlocks = new Map<string, readonly PromptBlock[]>();
	/** Whether the last turn's request offered tools, which decides `/context`'s tool overhead. */
	private readonly toolModes = new Map<string, boolean>();
	/** Sessions already told that their stored model profile is gone. */
	private readonly warned = new Set<string>();
	private activeSubagents = 0;
	/** Live subagent sessions, so a nested spawn edits the same object the child's run saves. */
	private readonly subagentSessions = new Map<string, Session>();
	/** The write-capable subagent currently running, if any: file writes are serialised. */
	private writingSubagent: string | null = null;

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
			for (const controller of this.backgroundSubagents) {
				controller.abort();
			}
		});
	}

	/**
	 * The tavern feature, when its plugin is loaded. Read through `ctx.get` and not as an injected
	 * property: injecting it would make the whole agent inactive without it, and a turn does not need it.
	 */
	private tavern(): TavernApi | undefined {
		return this.ctx.get('tavern') as TavernApi | undefined;
	}

	/** Snapshot of the current settings as a session policy. */
	policyFor(): SessionPolicy {
		const config = this.ctx.settings.get();
		return {
			workMode: config.mode,
			approval: config.approval,
			approvalResponse: config.approvalResponse,
			network: config.network,
			sandboxMode: config.sandboxMode,
			workingDirectory: config.workingDirectory,
			commandTimeout: config.commandTimeout,
			commandTimeoutOverride: config.commandTimeoutOverride,
			denyReadPaths: [...config.denyReadPaths],
			planDirectory: config.planDirectory,
			maxSteps: config.maxSteps,
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
			return { sessionId: input.sessionId ?? '', text: 'Error: only a new prompt can be edited.' };
		}
		const replay = trigger === 'swipe' || trigger === 'regenerate';
		const target = replay ? (input.sessionId ?? this.ctx.sessions.active()?.id ?? '') : '';
		// A swipe cuts the stored transcript as it starts: refuse it before the cut, not after.
		if (target && this.turns.has(target)) {
			return { sessionId: target, text: 'Error: a turn is already running in this chat.' };
		}
		// A swipe or a regenerate re-runs the prompt that is already there: the reply it produced is
		// dropped here, and the variants it had are handed to `finish` so none of them is lost. What
		// the turn replaced is kept too: a stopped generation puts that exchange back.
		let swipes: SwipeCarry | undefined;
		let attachments = input.attachments;
		let restore: Message[] | undefined;
		if (replay) {
			swipes = target ? this.ctx.sessions.swipeCarry(target) : undefined;
			const replayed = target ? this.ctx.sessions.replayLast(target) : { text: '', replaced: [] };
			if (!replayed.text && !replayed.attachments?.length) {
				return { sessionId: target, text: 'There is nothing to generate again yet.' };
			}
			text = replayed.text;
			// A replayed prompt brings its attachments back; an explicit new set wins.
			attachments = input.attachments?.length ? input.attachments : replayed.attachments;
			restore = replayed.replaced;
		}
		const session = input.sessionId ? (this.ctx.sessions.get(input.sessionId) ?? this.ctx.sessions.ensureActive(this.policyFor())) : this.ctx.sessions.ensureActive(this.policyFor());
		if (!text && !attachments?.length && !input.resolveAttachments && trigger !== 'continue' && trigger !== 'impersonate') {
			return { sessionId: session.id, text: '' };
		}
		// A continuation is written into the reply it carries on, so there has to be one: in a chat
		// that has said nothing yet the answer would hang on no message at all.
		if (trigger === 'continue' && !session.transcript.length) {
			return { sessionId: session.id, text: 'There is nothing to continue yet.' };
		}
		if (session.cursor) {
			return {
				sessionId: session.id,
				text: 'This session has a suspended tool call. Run "Comonad: Resume Suspended Turn" to continue it.',
			};
		}
		// A stale index must not fire the session hooks or drain pending contexts for a prompt that
		// cannot be replaced; `rewriteAt` validates again after the hooks, before it cuts.
		if (input.rewriteAt !== undefined && !canRewrite(session, input.rewriteAt)) {
			return { sessionId: session.id, text: 'Error: that message is not a prompt that can be edited.' };
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
			return { sessionId: session.id, text: 'Error: a turn is already running in this chat.' };
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
			session.policy = { ...session.policy, ...this.policyFor(), ...(input.policy ?? {}) };
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
				return { sessionId: session.id, text: `Blocked by hook: ${submitted.reason ?? 'no reason given'}` };
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
					return { sessionId: session.id, text: '' };
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
					return { sessionId: session.id, text: `Error: ${problem}` };
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
			// What the model is asked to do when the turn carries no prompt of its own. It is also said *as a
			// turn*: a request whose last turn is the model's own is completed by OpenAI but refused outright
			// by Gemini ("Requests ending with a model turn are not supported"). Upstream answers the same
			// problem with a preset's `send_if_empty`, said as the user when the history ends on a reply.
			let ask = '';
			if (trigger === 'continue') {
				// The preset's own nudge travels with the messages (see `compose`); when it has none, the
				// agent says what it wants in its own words — and only when there is a reply to carry on.
				const nudge = this.tavern()?.continueNudge(
					{ character: session.character, persona: session.persona, preset: session.preset },
					session.transcript[session.transcript.length - 1]?.content ?? '',
				);
				if (!nudge && continueInto !== undefined) {
					contexts.push(CONTINUE_ASK);
				}
				// The ask itself is always there to be sent: a turn that was cut short before it said anything
				// still leaves the model's own turn last, and that is the request Gemini refuses.
				ask = nudge || CONTINUE_ASK;
			}
			if (trigger === 'impersonate') {
				// The tavern layer knows the preset's template and the user's name; without it, the plain
				// request stands.
				const impersonation =
					this.tavern()?.impersonationPrompt({ character: session.character, persona: session.persona, preset: session.preset }) ??
					'Write the next message of this conversation as the user, in their voice, and nothing else.';
				// The words stand in the system prompt as well: an impersonation whose history already ends on
				// your own turn has nowhere else to be said.
				contexts.push(impersonation);
				ask = impersonation;
			}
			const blocks = await abortable(turn.signal, this.promptBlocks(session, contexts, trigger));
			// The fallback is the only place the user's block order and switches apply: under ST the active
			// preset owns them, and `compose` receives the full block list rather than this filtered view.
			const system = promptText(applyPromptLayout(blocks, config.prompts));
			// The world-info budget, the context budget and every counter in the panels read the same
			// counter, so the model's own tokenizer is made exact before anything is measured with it.
			await abortable(turn.signal, this.ctx.tokenizers.warm(this.ctx.llm.modelName(session.policy.model)));
			// A silent generation is offered no tools, so its budget is measured without them.
			const tools = SILENT_TRIGGERS.has(trigger) ? [] : this.ctx.tools.visible(session.policy);
			const budget = this.budgetFor(session.policy, session.contextWindow, system, tools);
			const form = session.contextForm ?? config.contextForm;
			let history = buildModelHistory(seeded, session.modelContext, form);
			// Compaction only changes the model context: the canonical transcript (and every index into
			// it, including prior/restore/continueInto) stays exactly where it was.
			if (estimateMessages(history) > budget.input) {
				this.notice(ref, 'Summarizing the conversation — it no longer fits the model’s window.');
				try {
					const context = await this.compactContext(session, seeded, budget.input, undefined, turn.signal);
					if (context) {
						history = buildModelHistory(seeded, context, form);
					}
				} catch (error) {
					if (turn.signal.aborted) {
						throw error;
					}
					this.ctx.log.message(`summarize failed: ${describe(error)}`);
					this.notice(ref, `Could not summarize the conversation (${describe(error)}); its older turns stay as they are.`);
				}
			}
			const tavern = await abortable(turn.signal, this.tavernTurn(session, seeded, history, blocks, trigger, budget.window));
			if (tavern?.overflowAlert && !this.overflowWarned.has(session.id)) {
				this.overflowWarned.add(session.id);
				this.notice(
					ref,
					`World info budget reached after ${tavern.activated.length} entries — the rest were left out. Raise "Context %", give the book fewer entries, or tick "Ignore budget" on the ones that must always be sent.`,
				);
			}
			// The ST layer takes the whole request whenever it is on: with nothing selected it composes the
			// built-in default collection. Only an absent or disabled layer keeps the agent's own shape.
			const composed = tavern?.takeover === true;
			const messages = composed ? [...tavern!.messages] : [{ role: 'system', content: system } as Message, ...history];
			// Request-only messages live outside the rebuilt history: a continue or an impersonation may
			// append an ask, and a rebuild must not silently drop it.
			const trailer: Message[] = [];
			if (ask && messages[messages.length - 1]?.role !== 'user') {
				const message = { role: 'user', content: ask, at: Date.now() } as Message;
				messages.push(message);
				trailer.push(message);
			}
			// The Tools entry gates the whole request in both shapes: the preset's row under ST, the core
			// layout's block when the agent composes its own prompt.
			const toolsEnabled = composed
				? tavern!.toolsEnabled
				: config.prompts.find((entry) => entry.id === COMONAD_BLOCK.tools)?.enabled !== false;
			// `/context` reads what was actually sent: the composed system messages, and the tool overhead
			// the preset left in place.
			this.systems.set(session.id, composed ? this.systemText(messages) : system);
			this.toolModes.set(session.id, toolsEnabled);
			const state: RunState = {
				ref,
				sessionId: session.id,
				rootSessionId: session.id,
				writes: new Set(),
				policy: session.policy,
				transcript: seeded,
				messages,
				contextForm: form,
				trailer,
				modelContextVersion: session.modelContext?.version,
				toolCalls: [],
				turn: session.turnIndex,
				gateReason: '',
				confirmed: null,
				toolsEnabled,
				samplers: tavern?.samplers,
				trigger,
				prior,
				restore,
				continueInto,
				swipes,
				// A composed request is not a slice of the chat, so there is nothing to fold it back into.
				foldable: !composed,
			};
			session.transcript = seeded;
			committed = true;
			this.ctx.sessions.save(session);
			this.ctx.audit.write(session.id, { kind: 'user', text: clip(text, 2_000), images: attachmentNotes(attachments) });
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
					this.ctx.sessions.invalidateModelContext(session, keep.length);
					this.ctx.sessions.save(session);
					this.ctx.sessions.changed(session.id);
				}
				return { sessionId: session.id, text: '', stopped: true };
			}
			throw error;
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
			if (answer === 'deny') {
				this.respondTraces(
					state,
					'deny',
					state.policy.approvalResponse === 'never'
						? 'the approval response policy denies without asking'
						: 'the approval surface denied the resumed call',
				);
			} else {
				this.respondTraces(state, 'allow', 'the approval surface allowed the resumed call');
			}
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
				value: answer !== 'deny',
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
	 * Summarizes the conversation on demand. The cut is planned against a budget of zero, which keeps
	 * only the turns after the last prompt: what a reader asking for this wants is the conversation
	 * folded now, not the longest tail that happens to fit.
	 */
	async compact(sessionId: string, instructions?: string, rebuild = false): Promise<string> {
		const session = this.ctx.sessions.require(sessionId);
		const before = session.modelContext?.covers ?? 0;
		const context = await this.compactContext(session, session.transcript, 0, instructions, undefined, rebuild);
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

	/**
	 * Summarizes the canonical prefix, extending the previous summary unless `rebuild` is set. The
	 * transcript, marks and cursor are untouched; the caller rebuilds only its model messages.
	 */
	private async compactContext(
		session: Session,
		source: readonly Message[],
		budget: number,
		instructions?: string,
		signal?: AbortSignal,
		rebuild = false,
	): Promise<ModelContext | null> {
		const previous = session.modelContext;
		const from = rebuild ? 0 : previous?.covers ?? 0;
		// The summary itself is part of the body budget; reserve what the existing one costs, and let
		// SUMMARY_RESERVE cover the new summary's growth.
		const summaryTokens = previous ? estimateTokens(modelSummaryMessage(previous.summary).content) : 0;
		const plan = planCompaction(source, Math.max(0, budget - summaryTokens), SUMMARY_RESERVE, from);
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
		const text = await this.summaryText(
			session.policy.model,
			older,
			rebuild ? undefined : previous?.summary,
			instructions,
			signal,
		);
		if (!text) {
			return null;
		}
		return this.ctx.sessions.recordModelContext(session, text, cut, session.policy.model) ?? null;
	}

	/**
	 * The request about to be sent, made to fit. Old tool output is elided first, because that is what
	 * grew the request and it costs no model call; only a request that still does not fit has the turns
	 * before this one folded away. The current turn is never folded: it is what the user just asked for.
	 *
	 * A composed request — tavern content rewrote it, or a subagent owns it — no longer lines up with a
	 * chat record, so only elision may touch it.
	 */
	private async fitRequest(
		state: RunState,
		session: Session | undefined,
		tools: ToolSpec[],
		signal: AbortSignal,
	): Promise<{ messages: Message[]; transcript?: Message[] }> {
		const budget = this.budgetFor(state.policy, session?.contextWindow, this.systemText(state.messages), tools);
		// The primary system prompt and the tool definitions are fixed overhead; the derived summary is
		// body, not overhead, or it would be invisible to this budget and to /context.
		const systems = state.messages.filter((message) => message.role === 'system' && !message.summarized);
		const body = state.messages.filter((message) => message.role !== 'system' || message.summarized);
		const fixed = estimateMessages(systems);
		if (estimateMessages(body) <= budget.input) {
			return { messages: state.messages };
		}
		// Elision still walks the whole request; its limit carries the fixed part so only the body shrinks.
		const elided = elideToolResults(state.messages, budget.input + fixed);
		if (elided.changed) {
			this.notice(state.ref, 'Trimmed older tool output to fit the model’s window.');
		}
		const elidedBody = elided.messages.filter((message) => message.role !== 'system' || message.summarized);
		if (estimateMessages(elidedBody) <= budget.input || !state.foldable || !session) {
			return { messages: elided.messages };
		}
		this.notice(state.ref, 'Summarizing the conversation — this turn outgrew the model’s window.');
		try {
			const context = await this.compactContext(session, state.transcript, budget.input, undefined, signal);
			if (!context) {
				return { messages: elided.messages };
			}
			state.modelContextVersion = context.version;
			const history = buildModelHistory(state.transcript, context, state.contextForm ?? this.ctx.settings.get().contextForm);
			return { messages: [...systems, ...history, ...(state.trailer ?? [])] };
		} catch (error) {
			signal.throwIfAborted();
			// The turn still has to be answered, so a summary that failed is reported and not fatal.
			this.ctx.log.message(`summarize failed mid-turn: ${describe(error)}`);
			return { messages: elided.messages };
		}
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
		const call = (messages: Message[]): Promise<Completion> =>
			this.ctx.llm.chat(
				state.policy.model,
				messages,
				tools,
				{
					onToken: (text) => {
						streamed = true;
						this.ctx.emit('agent/token', state.ref, text);
					},
					onReasoning: (text) => {
						streamed = true;
						this.ctx.emit('agent/reasoning', state.ref, text);
					},
					onToolDelta: (call) => {
						streamed = true;
						this.ctx.emit('agent/tool-delta', state.ref, call);
					},
				},
				signal,
				{ reasoningEffort: session?.reasoningEffort, ...state.samplers },
			);
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
		}
		if (completion.usage && session) {
			session.usage.inputTokens += completion.usage.input;
			session.usage.outputTokens += completion.usage.output;
			session.usage.requests += 1;
			session.lastInputTokens = completion.usage.input;
			this.ctx.usage.add(completion.usage);
			const cost = this.ctx.llm.costFor(state.policy.model, completion.usage);
			if (cost > 0) {
				session.usage.cost += cost;
				this.checkBudget(session, state.ref);
			}
			if (!live) {
				this.ctx.sessions.save(session);
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
		if (!session || !state.foldable) {
			return estimateMessages(body) < estimateMessages(state.messages) ? [...system, ...body] : null;
		}
		try {
			const context = await this.compactContext(session, state.transcript, 0, undefined, signal);
			if (!context) {
				return null;
			}
			state.modelContextVersion = context.version;
			const history = buildModelHistory(state.transcript, context, state.contextForm ?? this.ctx.settings.get().contextForm);
			return [...system, ...history, ...(state.trailer ?? [])];
		} catch (error) {
			signal.throwIfAborted();
			this.ctx.log.message(`emergency summarize failed: ${describe(error)}`);
			return null;
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
	): Promise<string> {
		const lines = older.map((message) => {
			const notes = attachmentNotes(message.attachments);
			const suffix = notes?.length ? ` [attachments: ${notes.join('; ')}]` : '';
			return `${message.role}: ${clip(message.content, 2_000)}${suffix}`;
		});
		let head = 0;
		let used = previous ? previous.length : 0;
		while (head < lines.length && used + lines[head]!.length < SUMMARY_SOURCE_LIMIT / 4) {
			used += lines[head]!.length;
			head += 1;
		}
		const tail: string[] = [];
		for (let index = lines.length - 1; index >= head && used < SUMMARY_SOURCE_LIMIT; index -= 1) {
			const line = lines[index]!;
			if (used + line.length > SUMMARY_SOURCE_LIMIT) {
				break;
			}
			used += line.length;
			tail.unshift(line);
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
			{ signal },
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
		// A composed turn whose Tools entry was off carried no tool overhead; report that turn, not
		// the policy list that would have been offered without the preset.
		const visible = this.toolModes.get(session.id) === false ? [] : this.ctx.tools.visible(session.policy);
		const files = session.instructions ?? [];
		const profile = this.ctx.llm.profileFor(session.policy.model);
		const system = this.systems.get(session.id) ?? '';
		const budget = this.budgetFor(session.policy, session.contextWindow, system, visible);
		const used = session.lastInputTokens;
		const windowLine = profile?.contextWindow
			? `- window: ${budget.window} tokens${session.contextWindow ? ' (set for this chat)' : ` — from the ${profile.label || profile.id} profile`}`
			: `- window: ${budget.window} tokens — **a fallback, not this model's own**. Set \`contextWindow\` on its profile.`;
		return [
			'**Context**',
			windowLine,
			`- room for messages: ${budget.input} tokens = ${budget.window} window − ${budget.reserve} held for the reply − ${budget.overhead} of system prompt and tool definitions`,
			`  - of that overhead: ${estimateTokens(system)} system prompt, ${this.toolTokens(visible)} the ${visible.length} tool definitions`,
			used === undefined
				? '- last request: none yet, so the numbers below are estimates'
				: `- last request: ${used} tokens, as the provider counted them`,
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
			// A Stop that lands as the graph finishes wins over the Stop hook.
			signal.throwIfAborted();
			const stop = await this.fireStop(session, state, signal);
			if (stop.blocked) {
				state = {
					...state,
					messages: [...state.messages, { role: 'user', content: `(hook) ${stop.reason ?? 'keep working'}` }],
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
		const signal = turn.signal;
		let cursor = resume;
		for (;;) {
			const graph = this.graph();
			const outcome = await runGraph(graph, state, {
				maxSteps: state.policy.maxSteps,
				resume: cursor,
				signal,
				choose: (request: SoftRequest) => this.ctx.llm.choose(state.policy.model, request, signal),
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
			if (answer === 'deny') {
				this.respondTraces(
					state,
					'deny',
					state.policy.approvalResponse === 'never'
						? 'the approval response policy denies without asking'
						: 'the approval surface denied the call',
				);
			} else {
				this.respondTraces(state, 'allow', 'the approval surface allowed the call');
			}
			if (answer === 'always' && calls[0]) {
				const rule = suggestAllowRule(calls[0], this.ctx.tools.get(calls[0].name));
				await this.ctx.settings.addAllowRule(rule).catch(() => undefined);
				this.notice(state.ref, `Added allow rule: ${rule}`);
			}
			session.cursor = null;
			cursor = { node: outcome.node, value: answer !== 'deny', payload: outcome.payload, step: outcome.step };
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
		this.settleCancelledCalls(state);
		session.cursor = null;
		this.finish(session, state, { aborted: true });
		const reply = lastAssistant(state.transcript.slice(state.prior.length))?.content.trim() ?? '';
		return { sessionId: session.id, text: reply, stopped: true };
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
			// A subagent is shown only the read-only tools on its list; the model never learns of a write tool.
			// A silent generation (an impersonation or a quiet turn) writes nothing down and is offered no
			// tools at all: a tool it called would run for real, and its reply is thrown away afterwards.
			// A preset whose Tools entry is off offers none either, for the whole turn.
			const offered = this.ctx.tools.visible(state.policy).filter((tool) => this.subagentToolAllowed(state, tool));
			const visible = SILENT_TRIGGERS.has(state.trigger) || state.toolsEnabled === false ? [] : offered;
			const live = this.turnSession(state.sessionId);
			const session = live ?? this.ctx.sessions.get(state.sessionId);
			// A long turn grows by its own tool results, so the request is checked here as well as at the
			// turn's start: eliding old output costs nothing, and folding the turns before this one is
			// what keeps a request that has outgrown the window from being refused outright.
			const fitted = await this.fitRequest(state, session, visible, runtime.signal);
			if (fitted.messages !== state.messages || fitted.transcript !== undefined) {
				state = { ...state, messages: fitted.messages, transcript: fitted.transcript ?? state.transcript };
			}
			// The window of this model round trip is what the UI shows as "thinking for Ns".
			const startedAt = Date.now();
			const sent = await this.request(state, visible, runtime.signal, session, Boolean(live));
			if (sent.messages !== state.messages) {
				state = { ...state, messages: sent.messages };
			}
			const completion = sent.completion;
			const message = completion.message;
			if (message.content || message.toolCalls?.length) {
				this.ctx.audit.write(state.sessionId, {
					kind: 'assistant',
					text: clip(message.content, 2_000),
					tools: message.toolCalls?.map((call) => call.name),
					...(state.agentName ? { subagent: state.agentName, root: state.rootSessionId } : {}),
				});
			}
			if (message.content || message.toolCalls?.length || message.reasoning) {
				return {
					...state,
					messages: [...state.messages, message],
					transcript: [...state.transcript, { ...message, at: Date.now(), startedAt }],
					toolCalls: completion.toolCalls,
					traces: undefined,
				};
			}
			return { ...state, toolCalls: completion.toolCalls, traces: undefined };
		});

		nodes.set('agent.confirm', async (state, runtime) => {
			if (!runtime.resuming) {
				runtime.suspend(state.toolCalls);
			}
			return { ...state, confirmed: runtime.resume === true };
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
			const results = new Array<Message | null>(state.toolCalls.length).fill(null);
			const stopped = (call: ToolCall): Message => ({
				role: 'tool',
				toolCallId: call.id,
				content: 'Stopped by the user.',
				at: Date.now(),
			});
			const runCall = async (call: ToolCall, index: number): Promise<void> => {
				if (runtime.signal.aborted) {
					this.denyTrace(state, index, 'stopped before dispatch');
					results[index] = stopped(call);
					return;
				}
				// A preset can switch tools off for the whole turn. The router rejects such a call first;
				// this is the second line for a custom graph or a resumed cursor that reached the tools node.
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
							this.toolContext(state, runtime.signal, state.traces?.[index] ? index : undefined),
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
				const readOnly = (tool?.capability === 'ro' || tool?.capability === 'shell_ro') && call.name !== 'ask_user';
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

		routes.set('agent.after-llm', (state) => {
			if (state.toolCalls.length === 0) {
				return 'end';
			}
			const rules = this.ctx.settings.rules();
			const snapshot = policySnapshot(state.policy, rules);
			// A silent generation is offered no tools, so a call it makes anyway is dropped with its turn: the
			// reply is what it wrote, and nothing is run on its behalf.
			if (SILENT_TRIGGERS.has(state.trigger)) {
				this.denyWithoutGate(state, 'a silent generation drops tool calls', snapshot, 'silent-generation');
				return 'end';
			}
			// The Tools entry is the whole turn's switch: a call made anyway is answered as rejected and
			// never reaches the tool. The model then gets its own turn to reply without one.
			if (state.toolsEnabled === false) {
				state.gateReason = 'the Tools entry is off';
				this.denyWithoutGate(state, state.gateReason, snapshot, 'tools-switch');
				return 'reject';
			}
			// A tool switched off in the Prompts tab is treated like an unknown one: it was not offered,
			// and a call invented for it must not run.
			const off = state.toolCalls.find((call) => !this.ctx.tools.isEnabled(call.name));
			if (off) {
				state.gateReason = `tool ${off.name} is switched off in Prompts`;
				this.denyWithoutGate(state, state.gateReason, snapshot, 'tool-switch');
				return 'reject';
			}
			// A subagent may only call what its grant and definition offered it; a call invented for a
			// hidden tool is refused here, before the gate has a chance to read a rule for it.
			if (state.filter) {
				const unavailable = state.toolCalls.find((call) => {
					const tool = this.ctx.tools.get(call.name);
					return !tool || !this.subagentToolAllowed(state, tool);
				});
				if (unavailable) {
					state.gateReason = `tool ${unavailable.name} is not available to this subagent`;
					this.denyWithoutGate(state, state.gateReason, snapshot, 'subagent');
					return 'reject';
				}
			}
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
			const gate = gateCalls(state.toolCalls, (name) => this.ctx.tools.get(name), state.policy, rules, {
				sandbox: this.ctx.host.sandboxKind(),
				created: process.platform === 'win32' ? undefined : created,
				createdDirs: process.platform === 'win32' ? undefined : createdDirs,
				deletionStaysInside:
					process.platform === 'win32' ? undefined : (target) => insideRealWorkspace(workspace, target),
				deletionScratch: process.platform === 'win32' ? undefined : (target) => inTree(scratch, target) || inTree(temp, target),
			});
			this.beginTraces(state, gate.calls, snapshot);
			state.gateReason = gate.reason;
			if (gate.decision === 'allow') {
				return 'tools';
			}
			// A subagent runs inside a pre-approved, filtered tool set: ordinary confirmations are
			// resolved by delegation. An escalated one — a dangerous command, or a rule the user
			// wrote to ask about — needs the user, and a subagent cannot ask, so it is refused rather
			// than parked on a surface that will never answer it.
			if (gate.decision === 'confirm' && state.filter) {
				if (gate.escalated) {
					state.gateReason = `${gate.reason}; a subagent cannot ask you`;
					this.respondTraces(state, 'deny', state.gateReason, 'subagent_cannot_ask');
					return 'reject';
				}
				return 'tools';
			}
			if (gate.decision === 'reject') {
				gate.calls.forEach((callGate, index) => {
					this.denyTrace(
						state,
						index,
						callGate.decision === 'reject' ? callGate.reason : `batch rejected: ${gate.reason}`,
					);
				});
				return 'reject';
			}
			return 'confirm';
		});

		routes.set('agent.after-confirm', (state) => (state.confirmed ? 'tools' : 'reject'));

		return { nodes, routes };
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
	private beginTraces(state: RunState, gates: readonly { steps: PolicyStep[] }[], snapshot: PolicySnapshot): void {
		state.traces = state.toolCalls.map((call, index) =>
			this.ctx.decisions.begin(this.traceContext(state, call), gates[index]?.steps ?? [], snapshot),
		);
	}

	/**
	 * A denial reached before the gate (tools off, a call the subagent may not see, a silent
	 * generation) still gets a truthful capability node, so no model-issued call is invisible.
	 */
	private denyWithoutGate(state: RunState, reason: string, snapshot: PolicySnapshot, matchedRule = 'capability'): void {
		state.traces = state.toolCalls.map((call) => {
			const trace = this.ctx.decisions.begin(
				this.traceContext(state, call),
				[{ layer: 'capability', decision: 'deny', matchedRule, reason }],
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
		if (!SUBAGENT_CAPABILITIES.has(tool.capability)) {
			return false;
		}
		return !state.filter.allow || state.filter.allow.includes(tool.name);
	}

	private toolContext(state: RunState, signal: AbortSignal, traceIndex?: number): ToolContext {
		return {
			sessionId: state.sessionId,
			workspace: state.policy.workingDirectory,
			policy: state.policy,
			signal,
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
			// One scratch tree per chat, shared by its subagents so the main agent can read their reports.
			scratchDirectory: state.policy.workingDirectory.trim() ? scratchDirectory(state.policy.workingDirectory, state.rootSessionId) : undefined,
			resolveReference: (path, options) => this.ctx.references.resolvePath(path, scopeOf(state.policy), signal, options),
			log: (text) => this.notice(state.ref, text),
			ask: (question, options, multi) => this.ctx.host.ask(question, options, multi),
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
			// turn. `length` is this turn's prompt index, which is what an edited prompt cuts at.
			if (!session.marks.some((mark) => mark.turn === session.turnIndex)) {
				const entries = await journal.entries(workspace, session.id);
				const prompt = session.transcript.findLastIndex((message) => message.role === 'user');
				session.marks.push({
					turn: session.turnIndex,
					entryCount: entries.length,
					length: Math.max(0, prompt),
					at: Date.now(),
				});
				this.ctx.sessions.save(session);
			}
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

	private async spawnAgent(parent: RunState, request: AgentSpawnRequest): Promise<string> {
		const depth = this.depths.get(parent.sessionId) ?? 0;
		if (depth >= MAX_SUBAGENT_DEPTH) {
			return 'Error: subagent depth limit reached';
		}
		if (this.activeSubagents >= MAX_SUBAGENTS) {
			return 'Error: too many subagents are running; try again later';
		}
		const definition = this.ctx.catalog.agent(request.agent);
		if (request.agent && !definition) {
			return `Error: unknown agent ${request.agent}`;
		}
		// The unnamed spawn is the `explore` agent, by name: `agents[0]` is whatever sorts first once
		// a user has agents of their own, and that would silently make one of them the default.
		const agent = definition ?? this.ctx.catalog.agent('explore');
		// A subagent's writes belong to the chat that spawned it, and never reach outside the workspace.
		// A full-access parent is narrowed to workspace-write for its children; a narrower parent is
		// inherited as it is, because a sandbox mode can only ever tighten.
		const policy: SessionPolicy = {
			...parent.policy,
			model: agent?.model || parent.policy.model,
			sandboxMode: parent.policy.sandboxMode === 'danger-full-access' ? 'workspace-write' : parent.policy.sandboxMode,
		};
		const grant = subagentGrant(this.ctx.settings.get(), agent?.name ?? 'explore', agent?.builtin === true);
		// The settings grant is the authorization; the definition's tools are the selection. Both, plus
		// the parent's own allow list (for a nested spawn), and the hard subagent cap.
		const listed = this.ctx.tools
			.visible(policy)
			.filter((tool) => SUBAGENT_CAPABILITIES.has(tool.capability))
			.filter((tool) => !parent.filter?.allow || parent.filter.allow.includes(tool.name))
			.filter((tool) => tool.capability !== 'rw' || (grant.files && tool.trackedWrite === true))
			.filter((tool) => tool.capability !== 'shell_test' || grant.test)
			.map((tool) => tool.name)
			.filter((name) => name !== 'agent' || depth + 1 < MAX_SUBAGENT_DEPTH);
		// No explicit tools list means read-only: a definition opts into writing by naming the tool.
		const allow = agent?.tools?.length
			? allowedToolsFor(agent, listed)
			: listed.filter((name) => {
					const capability = this.ctx.tools.get(name)?.capability;
					return capability === undefined || !SUBAGENT_WRITE_CAPABILITIES.has(capability);
				});
		const writeCapable = allow.some((name) => SUBAGENT_WRITE_CAPABILITIES.has(this.ctx.tools.get(name)?.capability ?? 'ro'));
		// A background run has no live turn to journal against and nobody to review its diff.
		if (request.background && writeCapable) {
			return 'Error: a write-capable subagent must run in the foreground; background subagents are read-only';
		}
		// Two writers would race on the same files and on the same journal mark.
		if (writeCapable && this.writingSubagent) {
			return `Error: another write-capable subagent is already running (${this.writingSubagent}); wait for it to finish`;
		}
		if (writeCapable) {
			this.writingSubagent = request.description ?? agent?.name ?? 'subagent';
		}
		const releaseWriter = (): void => {
			if (writeCapable) {
				this.writingSubagent = null;
			}
		};
		const subId = `sub-${randomUUID()}`;
		// The parent's `agent` card links to the child conversation. The map lives on the session that
		// owns the call, so a nested spawn links the subagent's card, not the root's.
		const owner =
			this.turnSession(parent.sessionId) ?? this.subagentSessions.get(parent.sessionId) ?? this.ctx.sessions.get(parent.sessionId);
		const callId = request.callId?.trim();
		if (owner && callId && callId.length <= 200 && callId !== '__proto__' && callId !== 'prototype' && callId !== 'constructor') {
			const links = Object.entries({ ...(owner.subagents ?? {}), [callId]: subId });
			// Keep the newest links: an old card losing its link is better than an unbounded session file.
			owner.subagents = Object.fromEntries(links.slice(-256));
			try {
				this.ctx.sessions.save(owner);
			} catch (error) {
				this.ctx.log.message(`subagent link: ${describe(error)}`);
			}
		}
		const run = async (): Promise<string> => {
			this.activeSubagents += 1;
			// The depth is the *child's*: a spawn from inside this run reads it off `subId`, and two
			// siblings finishing at different times each retire only their own entry.
			this.depths.set(subId, depth + 1);
			let finishChild: (() => void) | undefined;
			try {
				const system = [
					`You are the ${agent?.name ?? 'explore'} subagent of Comonad.`,
					agent?.prompt ?? 'Complete the delegated task and return a concise report.',
					'Project files may be changed only with the file tools offered to you; never use a shell command to write a project file. run_shell_test can write only its scratch directory. If a tool you need is not offered, report that instead of working around it.',
					agentIndex(this.ctx.catalog.agents),
				].join('\n\n');
				const parentSession = request.fork ? this.ctx.sessions.get(parent.sessionId) : undefined;
				const base = request.fork && parentSession ? parentSession.transcript : [];
				const inherited = request.fork ? parent.messages.filter((message) => message.role !== 'system') : [];
				const subTranscript: Message[] = [...base, { role: 'user', content: request.prompt, at: Date.now() }];
				// The child's conversation is a real session from this moment on: the card can open it
				// while it works, and it outlives the parent turn as a transcript.
				const child = this.ctx.sessions.createChild(policy, subId, {
					title: subagentTitle(agent?.name ?? 'explore', request.description),
					parentId: parent.sessionId,
					subagent: agent?.name ?? 'explore',
					transcript: subTranscript,
				});
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
				this.ctx.emit('agent/subagent-start', parent.ref, {
					callId,
					id: subId,
					name: agent?.name ?? 'explore',
					description: request.description,
				});
				// A nested spawn's card lives in its parent subagent's view: repaint that view now.
				if (parent.filter) {
					this.ctx.emit('subagent/changed', parent.sessionId);
				}
				const state: RunState = {
					ref: { sessionId: subId },
					sessionId: subId,
					rootSessionId: parent.rootSessionId,
					agentName: agent?.name ?? 'explore',
					writes: new Set(),
					policy,
					transcript: subTranscript,
					messages: [{ role: 'system', content: system }, ...inherited, { role: 'user', content: request.prompt }],
					contextForm: this.ctx.settings.get().contextForm,
					trailer: [],
					toolCalls: [],
					turn: child.turnIndex,
					gateReason: '',
					confirmed: null,
					filter: { allow },
					// A subagent is an ordinary generation of its own; nothing about it is swiped or quieted.
					trigger: 'normal',
					prior: [...base],
					// A subagent's request is its own, with no chat record behind it to fold, so only
					// elision may shrink it; the isolation is what keeps its oversize off the parent.
					foldable: false,
				};
				const abort = new AbortController();
				// A background run outlives the turn that started it: it is aborted when the agent
				// unloads, not when the parent turn ends (which endTurn's cleanup abort would do). A
				// foreground run is the turn's own work and stops with it.
				const unlink = request.background ? () => undefined : linkAbort(request.signal, abort);
				if (request.background) {
					this.backgroundSubagents.add(abort);
				}
				try {
					abort.signal.throwIfAborted();
					const outcome = await runGraph(this.graph(), state, {
						// The parent turn's budget is the default only when the setting says to inherit:
						// a subagent otherwise spends its own configured budget.
						maxSteps: subagentStepBudget(this.ctx.settings.get(), parent.policy.maxSteps ?? 0, agent?.maxTurns),
						signal: abort.signal,
						choose: (soft: SoftRequest) => this.ctx.llm.choose(policy.model, soft, abort.signal),
						onStep: (current) => remember(current.transcript),
					});
					const report = outcome.status === 'aborted' ? '(stopped)' : (lastAssistant(outcome.state.transcript)?.content ?? '(no report)');
					return state.writes.size ? `${report}\n\nFiles changed:\n${[...state.writes].map((path) => `- ${path}`).join('\n')}` : report;
				} finally {
					unlink();
					this.backgroundSubagents.delete(abort);
				}
			} finally {
				try {
					finishChild?.();
				} catch (error) {
					this.ctx.log.message(`subagent session: ${describe(error)}`);
				}
				this.activeSubagents -= 1;
				this.depths.delete(subId);
			}
		};
		if (request.background) {
			void run()
				.then((text) => {
					this.pushContext(parent.sessionId, `Subagent "${request.description ?? agent?.name ?? 'task'}" finished:\n${clip(text, 4_000)}`);
					this.ctx.host.notify(`Subagent ${request.description ?? agent?.name ?? ''} finished`);
				})
				.catch((error) => this.ctx.log.message(`subagent failed: ${describe(error)}`))
				.finally(releaseWriter);
			return `Started in the background: ${request.description ?? request.prompt.slice(0, 60)}`;
		}
		try {
			return await run();
		} catch (error) {
			return `Error: ${describe(error)}`;
		} finally {
			releaseWriter();
		}
	}

	/**
	 * The tavern layer's contribution to one turn: the chat's character, persona, world books and
	 * preset composed around the agent's named blocks. Returns `undefined` when the layer is off —
	 * and when composition failed, because a broken card or book must not cost the user a turn.
	 */
	private async tavernTurn(
		session: Session,
		transcript: Message[],
		history: Message[],
		blocks: readonly PromptBlock[],
		trigger: GenerationTrigger,
		window: number,
	): Promise<ComposeResult | undefined> {
		const tavern = this.tavern();
		if (!tavern) {
			return undefined;
		}
		try {
			const scan = [...transcript]
				.slice(-40)
				.reverse()
				.filter((message): message is Message & { role: 'user' | 'assistant' } => message.role === 'user' || message.role === 'assistant')
				.map((message) => ({ role: message.role, text: message.content }));
			// The session's own selection travels as it is; the tavern resolves what it leaves unset from
			// its own settings, and composes (vectors and all) without the kernel knowing any of it.
			const composed = await tavern.compose({
				blocks,
				history,
				binding: {
					character: session.character,
					persona: session.persona,
					lorebooks: session.lorebooks,
					preset: session.preset,
					authorNote: session.authorNote,
					effects: session.tavernEffects,
				},
				scan,
				turn: transcript.length,
				trigger,
				model: session.policy.model,
				contextSize: window,
			});
			// Timed world-info effects outlive the turn; the activated list is for the chat's readout.
			if (composed.effects !== session.tavernEffects) {
				session.tavernEffects = composed.effects;
			}
			session.tavernActivated = composed.activated.slice(0, 50).map((hit) => ({
				book: hit.book,
				comment: (hit.entry.comment ?? '').trim(),
				reason: hit.reason,
			}));
			session.tavernOverflow = composed.buckets.overflowed;
			void this.automate(session, composed, { sessionId: session.id });
			return composed;
		} catch (error) {
			// A broken card or book must never cost the user a turn.
			this.ctx.log.message(`tavern: compose failed: ${describe(error)}`);
			return undefined;
		}
	}

	/**
	 * Upstream's *Automation ID*: when an entry that names one activates, that automation runs — a
	 * Quick Reply in SillyTavern, and here the `WorldInfoActivated` hook plus a slash command of the
	 * same name. The tavern hands over the names it collected (setting applied, duplicates taken out);
	 * a name nothing is registered under is simply ignored — a name is enough to run a command.
	 */
	private async automate(session: Session, composed: ComposeResult, ref: TurnRef): Promise<void> {
		const surface = {
			markdown: (text: string) => this.notice(ref, text),
			progress: (text: string) => this.notice(ref, text),
		};
		for (const automation of composed.automations) {
			try {
				await this.ctx.hooks.fire('WorldInfoActivated', undefined, {
					session_id: session.id,
					automation_id: automation.id,
					book: automation.book,
					uid: automation.uid,
					comment: automation.comment,
				});
				if (!this.ctx.commands.get(automation.id) && !this.ctx.catalog.command(automation.id)) {
					continue;
				}
				const outcome = await this.ctx.commands.handle(automation.id, '', surface);
				if (outcome.done) {
					if (outcome.result) {
						this.notice(ref, outcome.result);
					}
					continue;
				}
				// An automation that asked for a generation cannot start one from inside a turn.
				this.notice(ref, `Automation "${automation.id}" belongs to a generation type — run /${automation.id} to use it.`);
			} catch (error) {
				this.notice(ref, `Automation "${automation.id}" failed: ${describe(error)}`);
			}
		}
	}

	/**
	 * The blocks of the system prompt this chat sends, in order, each with the stable id a preset uses
	 * to place it. `contexts` is the turn's own attached context, which only exists while a turn is
	 * being built; `trigger` decides whether this generation may carry tools at all.
	 */
	async promptBlocks(session: Session, contexts: string[] = [], trigger?: GenerationTrigger): Promise<PromptBlock[]> {
		const config = this.ctx.settings.get();
		const host = this.ctx.host;
		// A silent generation is offered no tools, so the prompt must not advertise any either.
		const visible = SILENT_TRIGGERS.has(trigger ?? 'normal') ? [] : this.ctx.tools.visible(session.policy);
		const has = (name: string): boolean => visible.some((tool) => tool.name === name);
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
				`Mode: ${MODE_LABELS[session.policy.workMode] ?? session.policy.workMode}; approval: ${session.policy.approval}; approval response: ${session.policy.approvalResponse}; network: ${session.policy.network ? 'on' : 'off'}; sandbox: ${session.policy.sandboxMode}.`,
				`Today: ${new Date().toISOString().slice(0, 10)}.`,
			].join('\n'),
		);
		const toolBody: string[] = [];
		if (has('apply_edits') || has('write_file')) {
			toolBody.push('Prefer apply_edits for precise changes and write_file for new files or full rewrites.');
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
			push(COMONAD_BLOCK.todos, formatTodos(todos));
		}
		// The indexes advertise a tool, so they only travel when that tool does.
		if (config.skills && has('skill')) {
			push(COMONAD_BLOCK.skills, skillLines(this.ctx.catalog.skills));
		}
		if (has('agent')) {
			push(COMONAD_BLOCK.agents, agentLines(this.ctx.catalog.agents));
		}
		// The books a chat can look up, without the plugin's own heading: the prefix above is the
		// block's editable opening, and this is only the list it adds below.
		if (has('lore_lookup')) {
			push(COMONAD_BLOCK.lore, this.tavern()?.loreIndex(session.id, '') ?? '');
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

	private notice(ref: TurnRef, text: string): void {
		this.ctx.emit('agent/notice', ref, text);
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
export function scratchDirectory(workspace: string, rootSessionId: string): string | undefined {
	const dir = join(workspace, '.comonad', 'scratch', rootSessionId);
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
