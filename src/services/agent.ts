import { randomUUID } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { Service, type Context } from 'cordis';
import type { TurnRef } from '../lib/types';
import {
	applyContextForm,
	applyContextLimit,
	estimateTokens,
} from '../lib/prompt';
import {
	compileGraphs,
	runGraph,
	type CompiledGraph,
	type GraphRegistry,
	type NodeFn,
	type ResumeCursor,
	type RouteFn,
	type SoftRequest,
} from '../lib/graph';
import { formatInstructions, loadInstructions, memoryDir, readMemory } from '../lib/instructions';
import { DEFAULT_GRAPH_SOURCE, parseGraphSource } from '../lib/mermaid';
import { gateCalls, MODE_CAPS, MODE_LABELS, suggestAllowRule } from '../lib/policy';
import type { AgentSpawnRequest, Capability, Message, SessionPolicy, TodoItem, ToolCall, ToolContext } from '../lib/types';
import type { GenerationTrigger } from '../lib/tavern/types';
import type { PresetSamplers } from 'comonad-plugin-tavern';
import { describe, formatTodos, lastAssistant, lastReplyIndex } from '../lib/util';
import { agentIndex, allowedToolsFor, skillIndex } from './catalog';
import type { JournalApi } from './checkpoints';
import type { Config } from './settings';
import { threadTitle, type Session, type SwipeCarry } from './sessions';
import type { ComposeResult, TavernApi } from 'comonad-plugin-tavern';

export interface TurnInput {
	/** The prompt. Empty for a continue, a swipe or a regenerate, which re-run what is already there. */
	text: string;
	sessionId?: string;
	systemContext?: string;
	policy?: Partial<SessionPolicy>;
	/** Identifies the calling surface; events and approvals are routed by it. */
	surface?: string;
	signal?: AbortSignal;
	/**
	 * How this generation was started — SillyTavern's generation type. It decides which world-info
	 * entries may activate and how the reply is written down; `normal` is a plain prompt.
	 */
	trigger?: GenerationTrigger;
}

export interface TurnResult {
	sessionId: string;
	text: string;
}

interface RunState {
	ref: TurnRef;
	sessionId: string;
	policy: SessionPolicy;
	transcript: Message[];
	messages: Message[];
	toolCalls: ToolCall[];
	gateReason: string;
	confirmed: boolean | null;
	filter?: { allow?: string[] };
	/** Samplers a selected preset contributed to this turn. */
	samplers?: PresetSamplers;
	/** What started this turn, which decides what may activate and what gets written down. */
	trigger: GenerationTrigger;
	/** The transcript as it stood before this turn, which is what a quiet generation leaves behind. */
	prior: Message[];
	/** The reply a continue extends: its index in the transcript as it stood before this turn. */
	continueInto?: number;
	/** The variants a swipe or a regenerate replaces or grows. */
	swipes?: SwipeCarry;
}

const MAX_SUBAGENT_DEPTH = 2;

/** The capabilities a subagent may use. Anything that writes — files, shell, plans — is never offered. */
const SUBAGENT_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(['ro', 'shell_ro']);

/** What a continue says as the user when the preset has no `continue_nudge_prompt` of its own. */
const CONTINUE_ASK = 'Continue the last message exactly where it stops. Do not repeat any of it, and do not start over.';

/**
 * A continuation is appended to the text it continues. The model usually starts where the text stops
 * with a space of its own; this only supplies one when neither side brought it.
 */
function joins(text: string, reply: string): string {
	return !text || /\s$/.test(text) || /^\s/.test(reply) ? reply : ` ${reply}`;
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
	static inject = ['host', 'settings', 'sessions', 'tools', 'llm', 'hooks', 'catalog', 'commands', 'vectors', 'tokenizers', 'usage', 'tasks', 'approval', 'audit', 'log'];

	private readonly stops = new Map<string, AbortController>();
	/** The live Session object per running turn; usage is mutated here and saved by finish(). */
	private readonly live = new Map<string, Session>();
	private readonly todoLists = new Map<string, TodoItem[]>();
	private readonly pending = new Map<string, string[]>();
	private readonly greeted = new Set<string>();
	private readonly depths = new Map<string, number>();
	private readonly budgetWarned = new Set<string>();
	/** Sessions already warned that the world-info budget was spent. */
	private readonly overflowWarned = new Set<string>();
	/** Sessions already told that their stored model profile is gone. */
	private readonly warned = new Set<string>();
	private activeSubagents = 0;
	private compiledSource = '';
	private compiled: CompiledGraph<RunState> | null = null;

	constructor(ctx: Context) {
		super(ctx, 'agent');
		ctx.effect(() => () => {
			for (const controller of this.stops.values()) {
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
			network: config.network,
			workingDirectory: config.workingDirectory,
			commandTimeout: config.commandTimeout,
			denyReadPaths: [...config.denyReadPaths],
			planDirectory: config.planDirectory,
			model: config.model,
		};
	}

	async runTurn(input: TurnInput): Promise<TurnResult> {
		let text = input.text.trim();
		const trigger: GenerationTrigger = input.trigger ?? 'normal';
		// A swipe or a regenerate re-runs the prompt that is already there: the reply it produced is
		// dropped here, and the variants it had are handed to `finish` so none of them is lost. The
		// session is read *after* the replay, which rewrites the stored transcript.
		let swipes: SwipeCarry | undefined;
		if (trigger === 'swipe' || trigger === 'regenerate') {
			const target = input.sessionId ?? this.ctx.sessions.active()?.id ?? '';
			swipes = target ? this.ctx.sessions.swipeCarry(target) : undefined;
			const replayed = target ? this.ctx.sessions.replayLast(target) : '';
			if (!replayed) {
				return { sessionId: target, text: 'There is nothing to generate again yet.' };
			}
			text = replayed;
		}
		const session = input.sessionId ? (this.ctx.sessions.get(input.sessionId) ?? this.ctx.sessions.ensureActive(this.policyFor())) : this.ctx.sessions.ensureActive(this.policyFor());
		if (!text && trigger !== 'continue' && trigger !== 'impersonate') {
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
		session.policy = { ...session.policy, ...this.policyFor(), ...(input.policy ?? {}) };
		if (!this.ctx.llm.known(session.policy.model) && !this.warned.has(session.id)) {
			// The chat remembers a model that no longer exists; say which one runs instead, once.
			this.warned.add(session.id);
			this.notice(
				{ sessionId: session.id, surface: input.surface },
				`model profile "${session.policy.model}" is gone — using ${this.ctx.llm.describe('auto')}. Pick one from the model menu.`,
			);
		}
		if (session.title === 'New session' && text) {
			session.title = threadTitle(text);
		}
		const config = this.ctx.settings.get();
		if (config.autoCompactChars > 0 && session.transcript.length > 12) {
			const chars = session.transcript.reduce((total, message) => total + message.content.length, 0);
			if (chars > config.autoCompactChars) {
				this.notice({ sessionId: session.id, surface: input.surface }, 'Auto-compacting the conversation…');
				try {
					await this.compact(session.id);
				} catch (error) {
					this.ctx.log.message(`auto-compact failed: ${describe(error)}`);
				}
			}
		}
		const contexts: string[] = [];
		if (!this.greeted.has(session.id)) {
			this.greeted.add(session.id);
			const start = await this.ctx.hooks.fire('SessionStart', undefined, { session_id: session.id, cwd: session.policy.workingDirectory });
			contexts.push(...start.contexts);
		}
		const submitted = await this.ctx.hooks.fire('UserPromptSubmit', undefined, { session_id: session.id, prompt: text });
		if (submitted.blocked) {
			return { sessionId: session.id, text: `Blocked by hook: ${submitted.reason ?? 'no reason given'}` };
		}
		contexts.push(...submitted.contexts, ...this.ctx.hooks.drainContexts(), ...(this.pending.get(session.id) ?? []));
		this.pending.delete(session.id);
		if (input.systemContext) {
			contexts.push(input.systemContext);
		}
		// No snapshot here: a turn is journaled file by file, as the agent actually writes each one.
		// A continue and an impersonation add no prompt of their own: the conversation is already there,
		// and quiet throws its prompt away again at the end.
		const prompted = trigger !== 'continue' && trigger !== 'impersonate';
		const prior = [...session.transcript];
		const seeded = prompted ? [...session.transcript, { role: 'user', content: text, at: Date.now() } as Message] : [...session.transcript];
		// A continue grows the last reply, and only when nothing comes after it. A turn that was
		// stopped, is waiting on a tool call, or failed leaves the transcript ending in something else
		// — merging there would cut that away. With nothing to grow, the answer is a turn of its own.
		const lastReply = trigger === 'continue' ? lastReplyIndex(seeded) : -1;
		const continueInto = lastReply >= 0 && lastReply === seeded.length - 1 ? lastReply : undefined;
		// What the model is asked to do when the turn carries no prompt of its own. It is also said *as a
		// turn*: a request whose last turn is the model's own is completed by OpenAI but refused outright
		// by Gemini ("Requests ending with a model turn are not supported"). Upstream answers the same
		// problem with a preset's `send_if_empty`, said as the user when the history ends on a reply.
		let ask = '';
		if (trigger === 'continue') {
			// The preset's own nudge travels with the messages (see `compose`); when it has none, the
			// agent says what it wants in its own words — and only when there is a reply to carry on.
			const nudge = this.tavern()?.continueNudge(
				{
					character: session.character ?? config.tavernCharacter,
					persona: session.persona ?? config.tavernPersona,
					preset: session.preset ?? config.tavernPreset,
				},
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
			const impersonation =
				this.tavern()?.impersonationPrompt({
					character: session.character ?? config.tavernCharacter,
					persona: session.persona ?? config.tavernPersona,
					preset: session.preset ?? config.tavernPreset,
				}) ||
				`Write the next message of this conversation as ${this.ctx.settings.get().tavernUserName || 'the user'}, in their voice, and nothing else.`;
			// The words stand in the system prompt as well: an impersonation whose history already ends on
			// your own turn has nowhere else to be said.
			contexts.push(impersonation);
			ask = impersonation;
		}
		const system = await this.systemPrompt(session, contexts);
		const ref: TurnRef = { sessionId: session.id, surface: input.surface };
		// The world-info budget, the context trim and every counter in the panels read the same counter,
		// so the model's own tokenizer is made exact before anything is measured with it.
		await this.ctx.tokenizers.warm(this.ctx.llm.modelName(session.policy.model));
		const history = applyContextLimit(
			applyContextForm(seeded, session.contextForm ?? config.contextForm),
			session.contextLimit ?? config.contextLimit,
		);
		const tavern = await this.tavernTurn(session, seeded, history, system, config, trigger);
		if (tavern?.buckets.overflowed && config.wiOverflowAlert && !this.overflowWarned.has(session.id)) {
			this.overflowWarned.add(session.id);
			this.notice(
				ref,
				`World info budget reached after ${tavern.activated.length} entries — the rest were left out. Raise "Context %", give the book fewer entries, or tick "Ignore budget" on the ones that must always be sent.`,
			);
		}
		// With no tavern content configured this is exactly `[system, …history]`, so the port is invisible
		// until a character, book, persona or preset is actually selected.
		const messages =
			tavern && !tavern.inert ? [...tavern.messages] : [{ role: 'system', content: system } as Message, ...history];
		// The ask goes last whenever the request would end in the model's own turn — which is what a
		// continue and an impersonation look like until something is said as the user.
		if (ask && messages[messages.length - 1]?.role !== 'user') {
			messages.push({ role: 'user', content: ask, at: Date.now() } as Message);
		}
		const state: RunState = {
			ref,
			sessionId: session.id,
			policy: session.policy,
			transcript: seeded,
			messages,
			toolCalls: [],
			gateReason: '',
			confirmed: null,
			samplers: tavern?.samplers,
			trigger,
			prior,
			continueInto,
			swipes,
		};
		session.transcript = seeded;
		this.ctx.sessions.save(session);
		this.ctx.audit.write(session.id, { kind: 'user', text: clip(text, 2_000) });
		return this.execute(session, state, input.signal);
	}

	/** Continues the suspended tool call of a session (after approval). */
	async resume(sessionId: string, options: { surface?: string } = {}): Promise<TurnResult> {
		const session = this.ctx.sessions.require(sessionId);
		const cursor = session.cursor;
		if (!cursor) {
			return { sessionId, text: 'This session has no suspended turn.' };
		}
		const calls = Array.isArray(cursor.payload) ? (cursor.payload as ToolCall[]) : [];
		const answer = await this.ctx.approval.request({ calls, reason: 'resume the suspended turn', surface: options.surface });
		const state = cursor.state as RunState;
		state.policy = session.policy;
		state.ref.surface = options.surface ?? state.ref.surface;
		session.cursor = null;
		this.ctx.sessions.save(session);
		return this.execute(session, state, undefined, {
			node: cursor.node,
			value: answer !== 'deny',
			payload: cursor.payload,
			step: cursor.step,
		});
	}

	async compact(sessionId: string, instructions?: string): Promise<string> {
		const session = this.ctx.sessions.require(sessionId);
		if (session.transcript.length <= 4) {
			return 'Nothing to compact yet.';
		}
		const before = session.transcript.length;
		const body = session.transcript
			.map((message) => `${message.role}: ${clip(message.content, 4_000)}`)
			.join('\n\n')
			.slice(0, 120_000);
		const summary = await this.ctx.llm.complete(
			session.policy.model,
			[
				'You compact agent conversations. Preserve decisions, file paths, open tasks, user preferences and unresolved issues.',
				instructions ? `Extra instructions: ${instructions}` : '',
			]
				.filter(Boolean)
				.join('\n'),
			`Summarize this conversation:\n\n${body}`,
		);
		session.transcript = [
			{ role: 'system', content: `Conversation summary (compacted):\n\n${summary}` },
			...session.transcript.slice(-2),
		];
		this.ctx.sessions.save(session);
		this.ctx.sessions.changed(sessionId);
		return `Compacted ${before} messages into a summary.`;
	}

	stop(sessionId?: string): boolean {
		const id = sessionId ?? this.ctx.sessions.active()?.id ?? '';
		const controller = this.stops.get(id);
		if (!controller) {
			return false;
		}
		controller.abort();
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
		const sum = (role: Message['role']) =>
			session.transcript.filter((message) => message.role === role).reduce((total, message) => total + estimateTokens(message.content), 0);
		const user = sum('user');
		const assistant = sum('assistant');
		const tool = sum('tool');
		const visible = this.ctx.tools.visible(session.policy);
		const toolTokens = estimateTokens(
			JSON.stringify(visible.map((item) => ({ name: item.name, description: item.description, parameters: item.parameters }))),
		);
		const files = session.instructions ?? [];
		return [
			'**Context estimate** (approx. 4 chars per token)',
			`- messages: ${user + assistant + tool} tokens (user ${user} · assistant ${assistant} · tool ${tool})`,
			`- tool definitions: ${visible.length} tools ≈ ${toolTokens} tokens`,
			`- instruction files: ${files.length}${files.length ? ` — ${files.slice(0, 5).map((file) => file.split('/').pop()).join(', ')}` : ''}`,
			`- context form: ${config.contextForm} · auto-compact at ${config.autoCompactChars > 0 ? `${config.autoCompactChars} chars` : 'off'}`,
		].join('\n');
	}

	private async execute(
		session: Session,
		state: RunState,
		signal?: AbortSignal,
		resume?: ResumeCursor,
	): Promise<TurnResult> {
		const abort = new AbortController();
		const link = () => abort.abort();
		signal?.addEventListener('abort', link, { once: true });
		this.stops.set(session.id, abort);
		this.live.set(session.id, session);
		let cursor = resume;
		let stopRetried = false;
		this.ctx.emit('agent/turn-start', state.ref, state.transcript[state.transcript.length - 1]?.content ?? '');
		try {
			const graph = this.graph();
			for (;;) {
				const outcome = await runGraph(graph, state, {
					resume: cursor,
					signal: abort.signal,
					choose: (request: SoftRequest) => this.ctx.llm.choose(state.policy.model, request, abort.signal),
				});
				state = outcome.state;
				if (outcome.status === 'done') {
					const stop = await this.ctx.hooks.fire('Stop', undefined, {
						session_id: session.id,
						last_assistant_message: lastAssistant(state.transcript)?.content ?? '',
					});
					if (stop.blocked && !stopRetried) {
						stopRetried = true;
						state = {
							...state,
							messages: [...state.messages, { role: 'user', content: `(hook) ${stop.reason ?? 'keep working'}` }],
						};
						cursor = undefined;
						continue;
					}
					this.finish(session, state);
					return { sessionId: session.id, text: lastAssistant(state.transcript)?.content ?? '' };
				}
				const calls = Array.isArray(outcome.payload) ? (outcome.payload as ToolCall[]) : [];
				session.cursor = { node: outcome.node, payload: outcome.payload, step: outcome.step, state };
				this.ctx.sessions.save(session);
				const answer = calls.length
					? await this.ctx.approval.request({ calls, reason: state.gateReason, surface: state.ref.surface })
					: 'deny';
				if (answer === 'always' && calls[0]) {
					const rule = suggestAllowRule(calls[0], this.ctx.tools.get(calls[0].name));
					await this.ctx.settings.addAllowRule(rule).catch(() => undefined);
					this.notice(state.ref, `Added allow rule: ${rule}`);
				}
				session.cursor = null;
				cursor = { node: outcome.node, value: answer !== 'deny', payload: outcome.payload, step: outcome.step };
			}
		} catch (error) {
			if (abort.signal.aborted) {
				this.finish(session, state);
				return { sessionId: session.id, text: lastAssistant(state.transcript)?.content ?? '' };
			}
			this.ctx.log.message(`turn failed: ${describe(error)}`);
			this.ctx.audit.write(session.id, { kind: 'error', message: describe(error) });
			return { sessionId: session.id, text: `Error: ${describe(error)}` };
		} finally {
			signal?.removeEventListener('abort', link);
			this.stops.delete(session.id);
			this.live.delete(session.id);
			this.ctx.emit('agent/turn-end', state.ref);
		}
	}

	private finish(session: Session, state: RunState): void {
		const answer = lastAssistant(state.transcript);
		const reply = answer?.content.trim() ? answer.content : '';
		if (state.trigger === 'quiet' || state.trigger === 'impersonate') {
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
		session.turnIndex += 1;
		session.cursor = null;
		session.policy = state.policy;
		this.ctx.sessions.save(session);
		this.ctx.audit.write(session.id, { kind: 'turn-end', turn: session.turnIndex });
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
		const source = this.ctx.settings.get().graph || DEFAULT_GRAPH_SOURCE;
		if (this.compiled && this.compiledSource === source) {
			return this.compiled;
		}
		try {
			const parsed = parseGraphSource(source);
			this.compiled = compileGraphs(parsed, this.graphRegistry()).get(parsed.default)!;
		} catch (error) {
			this.ctx.log.message(`graph error: ${describe(error)}; using the default graph`);
			const parsed = parseGraphSource(DEFAULT_GRAPH_SOURCE);
			this.compiled = compileGraphs(parsed, this.graphRegistry()).get(parsed.default)!;
		}
		this.compiledSource = source;
		return this.compiled;
	}

	private graphRegistry(): GraphRegistry<RunState> {
		const nodes = new Map<string, NodeFn<RunState>>();
		const routes = new Map<string, RouteFn<RunState>>();

		nodes.set('llm.complete', async (state, runtime) => {
			// A subagent is shown only the read-only tools on its list; the model never learns of a write tool.
			const visible = this.ctx.tools
				.visible(state.policy)
				.filter((tool) => !state.filter || (SUBAGENT_CAPABILITIES.has(tool.capability) && (!state.filter.allow || state.filter.allow.includes(tool.name))));
			const live = this.live.get(state.sessionId);
			const session = live ?? this.ctx.sessions.get(state.sessionId);
			// The window of this model round trip is what the UI shows as "thinking for Ns".
			const startedAt = Date.now();
			const completion = await this.ctx.llm.chat(
				state.policy.model,
				state.messages,
				visible,
				{
					onToken: (text) => this.ctx.emit('agent/token', state.ref, text),
					onReasoning: (text) => this.ctx.emit('agent/reasoning', state.ref, text),
					onToolDelta: (call) => this.ctx.emit('agent/tool-delta', state.ref, call),
				},
				runtime.signal,
				{ reasoningEffort: session?.reasoningEffort, ...state.samplers },
			);
			if (completion.usage && session) {
				session.usage.inputTokens += completion.usage.input;
				session.usage.outputTokens += completion.usage.output;
				session.usage.requests += 1;
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
			const message = completion.message;
			if (message.content || message.toolCalls?.length) {				this.ctx.audit.write(state.sessionId, {
					kind: 'assistant',
					text: clip(message.content, 2_000),
					tools: message.toolCalls?.map((call) => call.name),
				});
			}
			if (message.content || message.toolCalls?.length || message.reasoning) {
				return {
					...state,
					messages: [...state.messages, message],
					transcript: [...state.transcript, { ...message, at: Date.now(), startedAt }],
					toolCalls: completion.toolCalls,
				};
			}
			return { ...state, toolCalls: completion.toolCalls };
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
			return { ...state, toolCalls: [], messages: [...state.messages, ...messages], transcript: [...state.transcript, ...messages] };
		});

		nodes.set('agent.tools', async (state, runtime) => {
			const results = new Array<Message | null>(state.toolCalls.length).fill(null);
			const runCall = async (call: ToolCall, index: number): Promise<void> => {
				// The second line of defence: a subagent's call is refused if the tool is not on its list, or
				// if the tool writes, whatever the model asked for.
				const capability = this.ctx.tools.get(call.name)?.capability;
				if (state.filter && (!state.filter.allow?.includes(call.name) || (capability !== undefined && !SUBAGENT_CAPABILITIES.has(capability)))) {
					results[index] = { role: 'tool', toolCallId: call.id, content: `Error: tool ${call.name} is not available to this subagent`, at: Date.now() };
					return;
				}
				let args = call.arguments;
				const pre = await this.ctx.hooks.fire('PreToolUse', call.name, {
					session_id: state.sessionId,
					tool_name: call.name,
					tool_input: parseArguments(call.arguments),
				});
				if (pre.updatedInput) {
					args = JSON.stringify(pre.updatedInput);
				}
				this.ctx.emit('agent/tool-start', state.ref, { ...call, arguments: args });
				let output: string;
				if (pre.blocked) {
					output = `Error: blocked by hook: ${pre.reason ?? 'no reason given'}`;
				} else {
					output = await this.ctx.tools.invoke({ ...call, arguments: args }, this.toolContext(state, runtime.signal));
					const post = await this.ctx.hooks.fire(output.startsWith('Error:') ? 'PostToolUseFailure' : 'PostToolUse', call.name, {
						session_id: state.sessionId,
						tool_name: call.name,
						tool_input: parseArguments(args),
						tool_response: output,
					});
					if (post.contexts.length) {
						output = `${output}\n\n[hook] ${post.contexts.join('\n[hook] ')}`;
					}
				}
				this.ctx.emit('agent/tool-result', state.ref, { ...call, arguments: args }, output);
				this.ctx.audit.write(state.sessionId, { kind: 'tool', tool: call.name, arguments: clip(args, 500), output: clip(output, 500) });
					results[index] = { role: 'tool', toolCallId: call.id, content: output, at: Date.now() };
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
			const messages = results.filter((message): message is Message => message !== null);
			return { ...state, toolCalls: [], messages: [...state.messages, ...messages], transcript: [...state.transcript, ...messages] };
		});

		routes.set('agent.after-llm', (state) => {
			if (state.toolCalls.length === 0) {
				return 'end';
			}
			const gate = gateCalls(state.toolCalls, (name) => this.ctx.tools.get(name), state.policy, this.ctx.settings.rules());
			state.gateReason = gate.reason;
			if (gate.decision === 'allow') {
				return 'tools';
			}
			// A subagent runs inside a pre-approved, filtered tool set: confirmations are resolved by delegation.
			if (gate.decision === 'confirm' && state.filter) {
				return 'tools';
			}
			if (gate.decision === 'reject') {
				return 'reject';
			}
			return 'confirm';
		});

		routes.set('agent.after-confirm', (state) => (state.confirmed ? 'tools' : 'reject'));

		return { nodes, routes };
	}

	private toolContext(state: RunState, signal: AbortSignal): ToolContext {
		return {
			sessionId: state.sessionId,
			workspace: state.policy.workingDirectory,
			policy: state.policy,
			signal,
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
		};
	}

	/**
	 * Runs one file write and journals its content before and after. The first write of a path in a
	 * turn records the earlier content; later writes in the same turn only move the after-hash.
	 * Nothing is recorded when there is no workspace, when checkpoints are off, or when the write fails.
	 */
	private async journalEdit(state: RunState, path: string, write: () => Promise<void>): Promise<void> {
		const workspace = state.policy.workingDirectory;
		// The turn saves its own copy of the session when it ends. A mark written to any other copy is
		// overwritten by that save, so the mark goes on the live object the turn is running with.
		const session = this.live.get(state.sessionId) ?? this.ctx.sessions.get(state.sessionId);
		// The journal is a feature of its own, not a part of the agent: without its plugin (or with
		// checkpoints switched off) a write is simply a write, and nothing is recorded.
		const journal = this.ctx.get('checkpoints') as JournalApi | undefined;
		if (!workspace || !session || !journal || !this.ctx.settings.get().checkpoints || !isInside(workspace, path)) {
			return write();
		}
		const rel = relative(resolve(workspace), resolve(path)).split(sep).join('/');
		// The turn's rewind point is taken before its first write: rewinding to it undoes the whole turn.
		// `length` is the transcript as it stood before this turn's prompt, which is what `truncate` keeps.
		if (!session.marks.some((mark) => mark.turn === session.turnIndex)) {
			const entries = await journal.entries(workspace, session.id);
			const prompt = session.transcript.findLastIndex((message) => message.role === 'user');
			session.marks.push({
				turn: session.turnIndex,
				entryCount: entries.length,
				length: Math.max(0, prompt),
				at: Date.now(),
				text: (session.transcript[prompt]?.content ?? '').slice(0, 80),
			});
			this.ctx.sessions.save(session);
		}
		const before = await journal.store(workspace, state.sessionId, rel);
		await write();
		const after = await journal.store(workspace, state.sessionId, rel);
		await journal.record(workspace, state.sessionId, session.turnIndex, rel, before, after);
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
		const agent = definition ?? this.ctx.catalog.agents[0];
		const policy: SessionPolicy = { ...parent.policy, model: agent?.model || parent.policy.model };
		// A subagent never writes: only read-only capabilities are offered, whatever its definition lists.
		const visible = this.ctx.tools
			.visible(policy)
			.filter((tool) => SUBAGENT_CAPABILITIES.has(tool.capability))
			.map((tool) => tool.name)
			.filter((name) => name !== 'agent' || depth + 1 < MAX_SUBAGENT_DEPTH);
		const allow = agent ? allowedToolsFor(agent, visible) : visible;
		const run = async (): Promise<string> => {
			this.activeSubagents += 1;
			this.depths.set(parent.sessionId, depth + 1);
			try {
				const system = [
					`You are the ${agent?.name ?? 'explore'} subagent of Comonad.`,
					agent?.prompt ?? 'Complete the delegated task and return a concise report.',
					agentIndex(this.ctx.catalog.agents),
				].join('\n\n');
				const parentSession = request.fork ? this.ctx.sessions.get(parent.sessionId) : undefined;
				const base = request.fork && parentSession ? parentSession.transcript : [];
				const inherited = request.fork ? parent.messages.filter((message) => message.role !== 'system') : [];
				const subId = `sub-${randomUUID()}`;
				const subTranscript: Message[] = [...base, { role: 'user', content: request.prompt }];
				const state: RunState = {
					ref: { sessionId: subId },
					sessionId: subId,
					policy,
					transcript: subTranscript,
					messages: [{ role: 'system', content: system }, ...inherited, { role: 'user', content: request.prompt }],
					toolCalls: [],
					gateReason: '',
					confirmed: null,
					filter: { allow },
					// A subagent is an ordinary generation of its own; nothing about it is swiped or quieted.
					trigger: 'normal',
					prior: [...base],
				};
				const abort = new AbortController();
				const link = () => abort.abort();
				request.signal.addEventListener('abort', link, { once: true });
				try {
					const outcome = await runGraph(this.graph(), state, {
						maxSteps: Math.max(4, (agent?.maxTurns ?? 20) * 2),
						signal: abort.signal,
						choose: (soft: SoftRequest) => this.ctx.llm.choose(policy.model, soft, abort.signal),
					});
					return lastAssistant(outcome.state.transcript)?.content ?? '(no report)';
				} finally {
					request.signal.removeEventListener('abort', link);
				}
			} finally {
				this.activeSubagents -= 1;
				this.depths.delete(parent.sessionId);
			}
		};
		if (request.background) {
			void run()
				.then((text) => {
					this.pushContext(parent.sessionId, `Subagent "${request.description ?? agent?.name ?? 'task'}" finished:\n${clip(text, 4_000)}`);
					this.ctx.host.notify(`Subagent ${request.description ?? agent?.name ?? ''} finished`);
				})
				.catch((error) => this.ctx.log.message(`subagent failed: ${describe(error)}`));
			return `Started in the background: ${request.description ?? request.prompt.slice(0, 60)}`;
		}
		try {
			return await run();
		} catch (error) {
			return `Error: ${describe(error)}`;
		}
	}

	/**
	 * The tavern layer's contribution to one turn: the chat's character, persona, world books and
	 * preset composed around the agent's identity block. Returns `undefined` when the layer is off.
	 */
	private async tavernTurn(
		session: Session,
		transcript: Message[],
		history: Message[],
		identity: string,
		config: Config,
		trigger: GenerationTrigger,
	): Promise<ComposeResult | undefined> {
		const tavern = this.tavern();
		if (!config.tavernEnabled || !tavern) {
			return undefined;
		}
		try {
			const scan = [...transcript]
				.slice(-40)
				.reverse()
				.filter((message): message is Message & { role: 'user' | 'assistant' } => message.role === 'user' || message.role === 'assistant')
				.map((message) => ({ role: message.role, text: message.content }));
			const binding = {
				character: session.character ?? config.tavernCharacter,
				persona: session.persona ?? config.tavernPersona,
				lorebooks: session.lorebooks ?? config.tavernLorebooks,
				preset: session.preset ?? config.tavernPreset,
				authorNote: session.authorNote,
				effects: session.tavernEffects,
			};
			const external = await this.vectorHits(session, scan);
			const composed = tavern.compose({
				identity,
				history,
				binding,
				scan,
				turn: transcript.length,
				trigger,
				external,
				model: session.policy.model,
				contextSize: session.contextLimit || config.contextLimit || 0,
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
	 * The entries a vector search picks for this turn, as `<book>.<uid>`, which is the shape the scan's
	 * buffer uses. Nothing here can fail the turn: with the vectors off, or an endpoint that will not
	 * answer, the set is simply empty and the scan runs on keys alone.
	 */
	private async vectorHits(session: Session, scan: readonly { role: 'user' | 'assistant'; text: string }[]): Promise<ReadonlySet<string> | undefined> {
		const settings = this.ctx.settings.vectors();
		if (!settings.enabled) {
			return undefined;
		}
		const books = this.tavern()?.booksFor(session.id);
		if (!books?.length) {
			return undefined;
		}
		const found = await this.ctx.vectors.activate({ books, messages: scan }, settings);
		if (!found.size) {
			return undefined;
		}
		const keys = new Set<string>();
		for (const [book, uids] of found) {
			for (const uid of uids) {
				keys.add(`${book}.${uid}`);
			}
		}
		return keys;
	}

	/**
	 * Upstream's *Automation ID*: when an entry that names one activates, that automation runs — a
	 * Quick Reply in SillyTavern, and here the `WorldInfoActivated` hook plus a slash command of the
	 * same name. A name nothing is registered under is simply ignored, and the whole thing is off
	 * unless the setting says otherwise: a name is enough to run a command.
	 */
	private async automate(session: Session, composed: ComposeResult, ref: TurnRef): Promise<void> {
		if (!this.ctx.settings.get().wiAutomation) {
			return;
		}
		const surface = {
			markdown: (text: string) => this.notice(ref, text),
			progress: (text: string) => this.notice(ref, text),
		};
		const seen = new Set<string>();
		for (const hit of composed.activated) {
			const id = (hit.entry.automationId ?? '').trim();
			if (!id || seen.has(id)) {
				continue;
			}
			seen.add(id);
			try {
				await this.ctx.hooks.fire('WorldInfoActivated', undefined, {
					session_id: session.id,
					automation_id: id,
					book: hit.book,
					uid: hit.entry.uid,
					comment: (hit.entry.comment ?? '').trim(),
				});
				if (!this.ctx.commands.get(id) && !this.ctx.catalog.command(id)) {
					continue;
				}
				const outcome = await this.ctx.commands.handle(id, '', surface);
				if (outcome.done) {
					if (outcome.result) {
						this.notice(ref, outcome.result);
					}
					continue;
				}
				// An automation that asked for a generation cannot start one from inside a turn.
				this.notice(ref, `Automation "${id}" belongs to a generation type — run /${id} to use it.`);
			} catch (error) {
				this.notice(ref, `Automation "${id}" failed: ${describe(error)}`);
			}
		}
	}

	private async systemPrompt(session: Session, contexts: string[]): Promise<string> {
		return promptText(await this.promptBlocks(session, contexts));
	}

	/**
	 * The blocks of the system prompt this chat sends, in order, each with the name of what it is — so a
	 * panel can show the model's instructions and where each came from. `contexts` is the turn's own
	 * attached context, which only exists while a turn is being built.
	 */
	async promptBlocks(session: Session, contexts: string[] = []): Promise<PromptBlock[]> {
		const config = this.ctx.settings.get();
		const host = this.ctx.host;
		const identity = [
			'You are Comonad, an agentic coding assistant running inside VS Code.',
			MODE_CAPS[session.policy.workMode].size
				? 'Inspect the workspace with the provided tools before editing. Prefer apply_edits for precise changes and write_file for new files or full rewrites.'
				: 'This chat has no tools: answer from the conversation and your own knowledge.',
			'Never ask the user for permission in your reply; the host asks whenever a tool needs approval.',
			`Mode: ${MODE_LABELS[session.policy.workMode] ?? session.policy.workMode}; approval: ${session.policy.approval}; network: ${session.policy.network ? 'on' : 'off'}.`,
			`Today: ${new Date().toISOString().slice(0, 10)}.`,
		];
		if (!session.policy.workingDirectory) {
			identity.push('This session has no working directory: file, shell and task tools are unavailable.');
		}
		const blocks: PromptBlock[] = [{ name: 'Identity', text: identity.join('\n') }];
		if (config.instructions) {
			const layers = await loadInstructions(session.policy.workingDirectory, host.home(), host.trusted());
			session.instructions = layers.map((layer) => layer.source);
			const text = formatInstructions(layers);
			if (text) {
				blocks.push({ name: 'Instructions', text });
			}
		}
		if (config.memory) {
			const memory = await readMemory(memoryDir(host.storage.root, session.policy.workingDirectory));
			if (memory.trim()) {
				blocks.push({ name: 'Memory', text: `Memory from earlier sessions:\n${memory}` });
			}
		}
		const todos = this.todoLists.get(session.id) ?? [];
		if (todos.length) {
			blocks.push({ name: 'Todos', text: `Current todo list:\n${formatTodos(todos)}` });
		}
		if (config.skills) {
			const index = skillIndex(this.ctx.catalog.skills);
			if (index) {
				blocks.push({ name: 'Skills', text: index });
			}
		}
		const agents = agentIndex(this.ctx.catalog.agents);
		if (agents) {
			blocks.push({ name: 'Sub-agents', text: agents });
		}
		// The books a chat can look up: without this the model cannot know `lore_lookup` has anything.
		const lore = config.tavernEnabled ? this.tavern()?.loreIndex(session.id) : undefined;
		if (lore) {
			blocks.push({ name: 'Lore index', text: lore });
		}
		if (contexts.length) {
			blocks.push({ name: 'Context', text: `Context:\n${contexts.join('\n\n')}` });
		}
		return blocks;
	}

	private notice(ref: TurnRef, text: string): void {
		this.ctx.emit('agent/notice', ref, text);
	}
}

/** One named part of the system prompt, in the order the model receives it. */
export interface PromptBlock {
	name: string;
	text: string;
}

/** The wire text of a block list: the blocks separated by a blank line, as the model receives them. */
export function promptText(blocks: readonly PromptBlock[]): string {
	return blocks.map((block) => block.text).join('\n\n');
}

export const agentPlugin = Agent;

/** Whether a path lies inside the workspace; anything outside is not journaled. */
function isInside(workspace: string, path: string): boolean {
	const root = resolve(workspace);
	const target = resolve(path);
	const rel = relative(root, target);
	return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
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
