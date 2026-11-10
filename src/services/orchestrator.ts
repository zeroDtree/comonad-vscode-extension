// SPDX-License-Identifier: AGPL-3.0-only
import { Service, type Context } from 'cordis';
import { BUILTIN_ROLE_BY_ID, effectiveCapabilities, roleRisk, type AgentRole } from '../lib/agents';
import { buildOrchestratorBody } from '../lib/agent-prompts';
import { KeyedMutex } from '../lib/locks';
import { labelOf } from '../lib/mailbox';
import {
	boardOf,
	formatBoard,
	readyNodes,
	reconcileTaskGraph,
	satisfiesAcceptance,
	type TaskBoard,
	type TaskBoardMessage,
	type TaskGraph,
	type TaskGraphAccess,
	type TaskNode,
	type TaskPlanInput,
	type TaskRejection,
	type TaskResult,
	type TaskVerificationCheck,
} from '../lib/task-graph';
import type { Session } from './sessions';

/**
 * Owns the persistent task graph and its transitions. The tools call these methods inside `run`,
 * which serialises graph mutations per root chat; the service never spawns a model itself.
 */

declare module 'cordis' {
	interface Context {
		orchestrator: Orchestrator;
	}
}

export class Orchestrator extends Service {
	static inject = ['catalog', 'sessions', 'audit', 'mailbox', 'log'];

	private readonly chains = new KeyedMutex();

	constructor(ctx: Context) {
		super(ctx, 'orchestrator');
	}

	/** The roles a plan may name: the 14 built-ins plus project/user custom roles. */
	roles(): Map<string, AgentRole> {
		return new Map(this.ctx.catalog.agents.map((role) => [role.id, role]));
	}

	/** The code-owned role used by an acceptance verifier; a custom file cannot shadow it. */
	pinned(id: string): AgentRole | undefined {
		return BUILTIN_ROLE_BY_ID.get(id);
	}

	/** Serialises every graph mutation for one root chat. */
	run<T>(access: TaskGraphAccess, work: () => Promise<T>): Promise<T> {
		return this.chains.run(access.sessionId, work);
	}

	/** Marks nodes left in flight by a stopped or crashed turn as interrupted. */
	recover(session: Session): void {
		if (!session.taskGraph || session.parentId || session.subagent) {
			return;
		}
		let changed = false;
		const now = Date.now();
		for (const node of session.taskGraph.nodes) {
			if (node.status !== 'running' && node.status !== 'verifying') {
				continue;
			}
			// A root turn cannot still be running when a new one starts, so any in-flight node was
			// left behind by a stopped or crashed turn. Its child may look done, but the parent never
			// recorded the result; accepting the stale node would skip verification.
			node.status = 'rejected';
			node.finishedAt = now;
			node.rejection = { code: 'interrupted', reason: 'the turn ended before the task was recorded', at: now };
			changed = true;
		}
		if (changed) {
			session.taskGraph.updatedAt = now;
			this.ctx.sessions.save(session);
			this.ctx.emit('orchestrator/changed', session.id, this.board(session));
		}
	}

	/** Reconciles a declarative plan with the current graph. */
	plan(access: TaskGraphAccess, input: TaskPlanInput): { graph: TaskGraph; warnings: string[] } {
		const result = reconcileTaskGraph(access.get(), input, this.roles(), access.turn);
		if (!result.ok) {
			throw new Error(result.errors.join('\n'));
		}
		access.set(result.graph);
		this.audit(access.sessionId, {
			kind: 'task-plan',
			version: result.graph.version,
			replans: result.graph.replans,
			nodes: result.graph.nodes.map((node) => ({ id: node.id, role: node.role, risk: node.risk, dependsOn: node.dependsOn })),
		});
		this.emit(access, result.graph);
		return { graph: result.graph, warnings: result.warnings };
	}

	/** Claims ready nodes for one delegate batch; every node becomes running. */
	begin(access: TaskGraphAccess, ids: string[]): Array<{ node: TaskNode; role: AgentRole }> {
		const graph = this.require(access);
		if (ids.length < 1 || ids.length > 8) {
			throw new Error('a delegate batch needs 1..8 task ids');
		}
		if (new Set(ids).size !== ids.length) {
			throw new Error('a delegate batch contains a duplicate task id');
		}
		const byId = new Map(graph.nodes.map((node) => [node.id, node]));
		const ready = new Set(readyNodes(graph).map((node) => node.id));
		const roles = this.roles();
		const runs: Array<{ node: TaskNode; role: AgentRole }> = [];
		for (const id of ids) {
			const node = byId.get(id);
			if (!node) {
				throw new Error(`unknown task ${id}`);
			}
			if (node.status !== 'pending') {
				throw new Error(`${id} is ${node.status}, not pending`);
			}
			if (!ready.has(id)) {
				throw new Error(`${id} is not ready; complete its dependencies first`);
			}
			if (node.dependsOn.some((dependency) => ids.includes(dependency))) {
				throw new Error(`${id} depends on another task in this batch; run them in separate calls`);
			}
			if (node.attempts >= node.maxAttempts) {
				throw new Error(`${id} has spent its ${node.maxAttempts} attempts; replan with a new definition`);
			}
			const role = roles.get(node.role);
			if (!role) {
				throw new Error(`${id}: role ${node.role} is no longer available`);
			}
			if (node.capabilities?.some((capability) => !role.capabilities.includes(capability))) {
				throw new Error(`${id}: the role no longer allows its declared capabilities`);
			}
			if (roleRisk(effectiveCapabilities(role, node.capabilities)) !== node.risk) {
				throw new Error(`${id}: the role's risk changed since the plan was made; replan`);
			}
			runs.push({ node, role });
		}
		const now = Date.now();
		for (const { node } of runs) {
			node.status = 'running';
			node.attempts += 1;
			node.startedAt = now;
			node.finishedAt = undefined;
			node.subagentSessionId = undefined;
			node.verificationSessionIds = [];
			node.result = undefined;
			node.verification = undefined;
			node.rejection = undefined;
		}
		graph.updatedAt = now;
		access.set(graph);
		for (const { node, role } of runs) {
			this.audit(access.sessionId, {
				kind: 'task-start',
				node: node.id,
				role: role.id,
				attempt: node.attempts,
			});
		}
		this.emit(access, graph);
		return runs;
	}

	/** Records the child session as soon as it exists, so the board can link it while it runs. */
	attach(access: TaskGraphAccess, id: string, sessionId: string): void {
		const graph = this.require(access);
		const node = this.nodeOf(graph, id);
		node.subagentSessionId = sessionId;
		graph.updatedAt = Date.now();
		access.set(graph);
		this.emit(access, graph);
	}

	/** Stores the worker's structured result; acceptance is still computed by `finish`. */
	recordWorker(access: TaskGraphAccess, id: string, result: TaskResult): TaskNode {
		const graph = this.require(access);
		const node = this.nodeOf(graph, id);
		node.result = result;
		node.startedAt ??= result.at;
		if (result.status === 'ok' && node.acceptance.some((criterion) => criterion.check !== 'evidence')) {
			node.status = 'verifying';
		}
		graph.updatedAt = Date.now();
		access.set(graph);
		this.audit(access.sessionId, {
			kind: 'task-result',
			node: id,
			status: result.status,
			writes: result.writes,
			criteria: result.criteria,
		});
		this.emit(access, graph);
		return node;
	}

	recordVerification(
		access: TaskGraphAccess,
		id: string,
		checks: TaskVerificationCheck[],
		summary: string,
		sessionId: string,
	): TaskNode {
		const graph = this.require(access);
		const node = this.nodeOf(graph, id);
		// A task may need a review verifier and a command verifier; merge their checks rather than
		// letting the second run replace the first.
		const previous = node.verification?.checks ?? [];
		const merged = [...previous.filter((check) => !checks.some((next) => next.id === check.id)), ...checks];
		const summaries = [node.verification?.summary, summary].filter((text): text is string => Boolean(text?.trim()));
		node.verification = { summary: summaries.join('\n'), checks: merged, at: Date.now() };
		if (sessionId) {
			node.verificationSessionIds = [...(node.verificationSessionIds ?? []), sessionId];
		}
		graph.updatedAt = Date.now();
		access.set(graph);
		this.audit(access.sessionId, { kind: 'task-verify', node: id, sessionId, checks });
		this.emit(access, graph);
		return node;
	}

	/** Computes acceptance deterministically and records the terminal status. */
	finish(access: TaskGraphAccess, id: string): TaskNode {
		const graph = this.require(access);
		const node = this.nodeOf(graph, id);
		const verdict = satisfiesAcceptance(node);
		const now = Date.now();
		node.finishedAt = now;
		if (verdict.accepted) {
			node.status = 'accepted';
			node.rejection = undefined;
		} else {
			const code: TaskRejection['code'] =
				node.result?.status === 'blocked'
					? 'worker_blocked'
					: node.result?.status === 'failed'
						? 'worker_failed'
						: node.verification
							? 'verification_failed'
							: 'worker_failed';
			const spent = node.attempts >= node.maxAttempts;
			node.status = 'rejected';
			node.rejection = {
				code,
				reason: `${verdict.reason ?? 'not accepted'}${spent ? ' (attempt budget spent; replan with a new definition)' : ''}`,
				at: now,
			};
		}
		graph.updatedAt = now;
		access.set(graph);
		this.audit(access.sessionId, {
			kind: 'task-end',
			node: id,
			status: node.status,
			attempts: node.attempts,
			...(node.rejection ? { rejection: node.rejection } : {}),
		});
		this.emit(access, graph);
		return node;
	}

	/** A terminal rejection that did not come from an acceptance check (spawn, parse, stop). */
	reject(access: TaskGraphAccess, id: string, rejection: TaskRejection): TaskNode {
		const graph = this.require(access);
		const node = this.nodeOf(graph, id);
		const now = Date.now();
		node.status = 'rejected';
		node.finishedAt = now;
		node.rejection = { ...rejection, at: now };
		graph.updatedAt = now;
		access.set(graph);
		this.audit(access.sessionId, { kind: 'task-end', node: id, status: node.status, attempts: node.attempts, rejection: node.rejection });
		this.emit(access, graph);
		return node;
	}

	/** The dynamic body of the Orchestration prompt block. */
	prompt(session: Session): string {
		const graph = session.taskGraph;
		const messages = this.messages(session.id);
		return buildOrchestratorBody({
			roles: [...this.roles().values()],
			...(graph ? { board: formatBoard(boardOf(graph, messages)) } : {}),
			messages: messages.map((message) => `${message.from} -> ${message.to}: ${message.text}`),
		});
	}

	/** The current board for the chat webview. */
	board(session: Session): TaskBoard | undefined {
		return session.taskGraph ? boardOf(session.taskGraph, this.messages(session.id)) : undefined;
	}

	private require(access: TaskGraphAccess): TaskGraph {
		const graph = access.get();
		if (!graph) {
			throw new Error('no task plan exists; call task_plan first');
		}
		return graph;
	}

	private nodeOf(graph: TaskGraph, id: string): TaskNode {
		const node = graph.nodes.find((candidate) => candidate.id === id);
		if (!node) {
			throw new Error(`unknown task ${id}`);
		}
		return node;
	}

	private messages(rootSessionId: string): TaskBoardMessage[] {
		return this.ctx.mailbox.recent(rootSessionId, 10).map((record) => ({
			at: record.at,
			from: labelOf(record.from),
			to: record.to,
			text: record.text,
		}));
	}

	private emit(access: TaskGraphAccess, graph: TaskGraph): void {
		this.ctx.emit('orchestrator/changed', access.sessionId, boardOf(graph, this.messages(access.sessionId)));
	}

	private audit(sessionId: string, entry: Record<string, unknown>): void {
		this.ctx.audit.write(sessionId, entry);
	}
}

export const orchestratorPlugin = Orchestrator;
