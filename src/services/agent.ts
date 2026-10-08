import { randomUUID } from 'node:crypto';
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
import type { AgentSpawnRequest, Message, SessionPolicy, TodoItem, ToolCall, ToolContext } from '../lib/types';
import { describe, formatTodos, lastAssistant } from '../lib/util';
import { agentIndex, allowedToolsFor, skillIndex } from './catalog';
import type { Config } from './settings';
import { threadTitle, type Session } from './sessions';
import type { ComposeResult } from './tavern';

export interface TurnInput {
	text: string;
	sessionId?: string;
	systemContext?: string;
	policy?: Partial<SessionPolicy>;
	/** Identifies the calling surface; events and approvals are routed by it. */
	surface?: string;
	signal?: AbortSignal;
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
	samplers?: { temperature?: number; topP?: number; maxTokens?: number };
}

const MAX_SUBAGENT_DEPTH = 2;
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
	static inject = ['host', 'settings', 'sessions', 'checkpoints', 'tools', 'llm', 'hooks', 'catalog', 'tavern', 'usage', 'tasks', 'approval', 'audit', 'log'];

	private readonly stops = new Map<string, AbortController>();
	/** The live Session object per running turn; usage is mutated here and saved by finish(). */
	private readonly live = new Map<string, Session>();
	private readonly todoLists = new Map<string, TodoItem[]>();
	private readonly pending = new Map<string, string[]>();
	private readonly greeted = new Set<string>();
	private readonly depths = new Map<string, number>();
	private readonly budgetWarned = new Set<string>();
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
		const text = input.text.trim();
		const session = input.sessionId ? (this.ctx.sessions.get(input.sessionId) ?? this.ctx.sessions.ensureActive(this.policyFor())) : this.ctx.sessions.ensureActive(this.policyFor());
		if (!text) {
			return { sessionId: session.id, text: '' };
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
		if (session.title === 'New session') {
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
		if (config.checkpoints && session.policy.workingDirectory) {
			const checkpointId = randomUUID();
			try {
				await this.ctx.checkpoints.capture(session.policy.workingDirectory, session.id, checkpointId);
				this.ctx.sessions.addMark(session.id, {
					turn: session.turnIndex,
					checkpointId,
					length: session.transcript.length,
					at: Date.now(),
					text: text.slice(0, 80),
				});
			} catch (error) {
				this.ctx.log.message(`checkpoint failed: ${describe(error)}`);
			}
		}
		const transcript = [...session.transcript, { role: 'user', content: text, at: Date.now() } as Message];
		const system = await this.systemPrompt(session, contexts);
		const ref: TurnRef = { sessionId: session.id, surface: input.surface };
		const history = applyContextLimit(
			applyContextForm(transcript, session.contextForm ?? config.contextForm),
			session.contextLimit ?? config.contextLimit,
		);
		const tavern = this.tavernTurn(session, transcript, history, system, config);
		const state: RunState = {
			ref,
			sessionId: session.id,
			policy: session.policy,
			transcript,
			// With no tavern content configured this is exactly `[system, …history]`, so the port is
			// invisible until a character, book, persona or preset is actually selected.
			messages: tavern && !tavern.inert ? tavern.messages : [{ role: 'system', content: system }, ...history],
			toolCalls: [],
			gateReason: '',
			confirmed: null,
			samplers: tavern?.samplers,
		};
		session.transcript = transcript;
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
		session.transcript = state.transcript;
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
			const visible = this.ctx.tools.visible(state.policy).filter((tool) => !state.filter?.allow || state.filter.allow.includes(tool.name));
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
				if (state.filter?.allow && !state.filter.allow.includes(call.name)) {
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
		};
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
		const visible = this.ctx.tools
			.visible(policy)
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
				const state: RunState = {
					ref: { sessionId: subId },
					sessionId: subId,
					policy,
					transcript: [...base, { role: 'user', content: request.prompt }],
					messages: [{ role: 'system', content: system }, ...inherited, { role: 'user', content: request.prompt }],
					toolCalls: [],
					gateReason: '',
					confirmed: null,
					filter: { allow },
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
	private tavernTurn(
		session: Session,
		transcript: Message[],
		history: Message[],
		identity: string,
		config: Config,
	): ComposeResult | undefined {
		if (!config.tavernEnabled) {
			return undefined;
		}
		try {
			const scan = [...transcript]
				.slice(-40)
				.reverse()
				.filter((message): message is Message & { role: 'user' | 'assistant' } => message.role === 'user' || message.role === 'assistant')
				.map((message) => ({ role: message.role, text: message.content }));
			const composed = this.ctx.tavern.compose({
				identity,
				history,
				binding: {
					character: session.character ?? config.tavernCharacter,
					persona: session.persona ?? config.tavernPersona,
					lorebooks: session.lorebooks ?? config.tavernLorebooks,
					preset: session.preset ?? config.tavernPreset,
					authorNote: session.authorNote,
					effects: session.tavernEffects,
				},
				scan,
				turn: transcript.length,
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
			return composed;
		} catch (error) {
			// A broken card or book must never cost the user a turn.
			this.ctx.log.message(`tavern: compose failed: ${describe(error)}`);
			return undefined;
		}
	}

	private async systemPrompt(session: Session, contexts: string[]): Promise<string> {		const config = this.ctx.settings.get();
		const host = this.ctx.host;
		const lines = [
			'You are Comonad, an agentic coding assistant running inside VS Code.',
			MODE_CAPS[session.policy.workMode].size
				? 'Inspect the workspace with the provided tools before editing. Prefer apply_edits for precise changes and write_file for new files or full rewrites.'
				: 'This chat has no tools: answer from the conversation and your own knowledge.',
			'Never ask the user for permission in your reply; the host asks whenever a tool needs approval.',
			`Mode: ${MODE_LABELS[session.policy.workMode] ?? session.policy.workMode}; approval: ${session.policy.approval}; network: ${session.policy.network ? 'on' : 'off'}.`,
			`Today: ${new Date().toISOString().slice(0, 10)}.`,
		];
		if (!session.policy.workingDirectory) {
			lines.push('This session has no working directory: file, shell and task tools are unavailable.');
		}
		if (config.instructions) {
			const layers = await loadInstructions(session.policy.workingDirectory, host.home(), host.trusted());
			session.instructions = layers.map((layer) => layer.source);
			const text = formatInstructions(layers);
			if (text) {
				lines.push('', text);
			}
		}
		if (config.memory) {
			const memory = await readMemory(memoryDir(host.storage.root, session.policy.workingDirectory));
			if (memory.trim()) {
				lines.push('', `Memory from earlier sessions:\n${memory}`);
			}
		}
		const todos = this.todoLists.get(session.id) ?? [];
		if (todos.length) {
			lines.push('', `Current todo list:\n${formatTodos(todos)}`);
		}
		if (config.skills) {
			const index = skillIndex(this.ctx.catalog.skills);
			if (index) {
				lines.push('', index);
			}
		}
		const agents = agentIndex(this.ctx.catalog.agents);
		if (agents) {
			lines.push('', agents);
		}
		if (config.tavernEnabled) {
			// The books a chat can look up: without this the model cannot know `lore_lookup` has anything.
			const books = this.ctx.tavern.loreIndex(session.id);
			if (books) {
				lines.push('', books);
			}
		}
		if (contexts.length) {
			lines.push('', `Context:\n${contexts.join('\n\n')}`);
		}
		return lines.join('\n');
	}

	private notice(ref: TurnRef, text: string): void {
		this.ctx.emit('agent/notice', ref, text);
	}
}

export const agentPlugin = Agent;

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
