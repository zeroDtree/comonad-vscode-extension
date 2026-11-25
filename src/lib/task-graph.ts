// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentRisk, AgentRole } from './agents';
import { effectiveCapabilities, roleRisk } from './agents';
import { commandMatches, sanitizeEvidence } from './agent-evidence';
import { normalizeBudget, type BudgetDimension, type BudgetInput, type BudgetReport, type BudgetUsage } from './budget';
import type { Capability } from './types';

/**
 * The persistent task DAG the Orchestrator records and the runtime executes. This module is pure:
 * validation, reconciliation, readiness and acceptance are deterministic; the service only owns
 * persistence, spawning and audit.
 */

export type TaskStatus = 'pending' | 'running' | 'verifying' | 'accepted' | 'rejected' | 'paused';
export type AcceptanceCheck = 'evidence' | 'review' | 'command';

export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'running', 'verifying', 'accepted', 'rejected', 'paused'];
export const ACCEPTANCE_CHECKS: readonly AcceptanceCheck[] = ['evidence', 'review', 'command'];

/** The one wording for the write-task acceptance rule; the validator, tool description and prompt share it. */
export const WRITE_TASK_CRITERION_RULE = 'A write task needs at least one review or command criterion';

export const MAX_TASKS = 32;
export const MAX_ACCEPTANCE = 8;
export const MAX_DEPENDENCIES = 16;
export const MAX_WRITES = 64;
export const MAX_ATTEMPTS = 3;
export const MAX_REPLANS = 6;
/** Per-dimension task graph bounds; `0` is unlimited and is the common value. */
export const MAX_BUDGET_VALUE = 1_000_000_000;
export const DEFAULT_MAX_RESUMES = 3;

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface AcceptanceCriterion {
	id: string;
	description: string;
	check: AcceptanceCheck;
	/** Required iff `check === 'command'`; the tester runs exactly this command. */
	command?: string;
	/** Context for the verifier; not a deterministic check. */
	files?: string[];
}

export interface TaskNodeInput {
	id: string;
	title: string;
	role: string;
	objective: string;
	inputs?: string;
	outputs?: string;
	/** Workspace-relative paths/globs the task expects to modify; advisory and used for warnings. */
	writes?: string[];
	/** Further narrows the role's capabilities; never widens them. */
	capabilities?: Capability[];
	/** `false` narrows the role's network off; `true` is allowed only when the role allows it. */
	network?: boolean;
	dependsOn?: string[];
	acceptance: AcceptanceCriterion[];
	maxAttempts?: number;
	/** Per-task native budget; each dimension can only tighten the role/global default. */
	budget?: BudgetInput;
	maxResumes?: number;
}

export interface TaskNode extends Omit<TaskNodeInput, 'dependsOn' | 'maxAttempts'> {
	dependsOn: string[];
	risk: AgentRisk;
	status: TaskStatus;
	attempts: number;
	maxAttempts: number;
	/** How many times a paused budget run was resumed; resuming is not a new attempt. */
	resumes: number;
	maxResumes: number;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	subagentSessionId?: string;
	verificationSessionIds?: string[];
	result?: TaskResult;
	verification?: TaskVerification;
	rejection?: TaskRejection;
}

export interface TaskGraph {
	version: number;
	objective: string;
	nodes: TaskNode[];
	replans: number;
	turn: number;
	createdAt: number;
	updatedAt: number;
}

export interface TaskGraphInput {
	objective: string;
	nodes: TaskNodeInput[];
}

/** The live-session accessor the Agent gives the orchestration tools; the only write path. */
export interface TaskGraphAccess {
	readonly sessionId: string;
	readonly turn: number;
	get(): TaskGraph | undefined;
	set(graph: TaskGraph | undefined): void;
}

export type AgentEvidence =
	| { kind: 'file'; path: string; note?: string }
	| { kind: 'search'; query: string; note?: string }
	| { kind: 'command'; command: string; exitCode: number; output?: string }
	| { kind: 'note'; text: string };

export interface CriterionResult {
	id: string;
	met: boolean;
	note?: string;
}

export interface TaskResult {
	status: 'ok' | 'blocked' | 'failed';
	summary: string;
	evidence: AgentEvidence[];
	criteria: CriterionResult[];
	/** Authoritative tracked writes from `Agent.spawnAgent`, not the worker's claims. */
	writes: string[];
	sessionId?: string;
	/** Present when a native budget stopped the worker; the result is partial. */
	budget?: BudgetReport;
	at: number;
}

export interface TaskVerificationCheck extends CriterionResult {
	by: 'reviewer' | 'tester';
	sessionId?: string;
	evidence?: AgentEvidence[];
}

export interface TaskVerification {
	summary: string;
	checks: TaskVerificationCheck[];
	at: number;
}

export interface TaskRejection {
	code:
		| 'worker_failed'
		| 'worker_blocked'
		| 'invalid_output'
		| 'verification_failed'
		| 'verification_unavailable'
		| 'stopped'
		| 'interrupted'
		| 'limit'
		| 'budget_exhausted'
		| 'resume_unavailable';
	reason: string;
	/** The partial budget result when a worker was cut off by a native limit. */
	budget?: BudgetReport;
	partial?: string;
	resumable?: boolean;
	/** Tracked writes from the paused segment, carried into the resume's verifier context. */
	writes?: string[];
	at: number;
}

export interface TaskBoardMessage {
	at: number;
	from: string;
	to: string;
	text: string;
}

export interface TaskBoardNode {
	id: string;
	title: string;
	role: string;
	status: TaskStatus;
	risk: AgentRisk;
	dependsOn: string[];
	writes: string[];
	subagentSessionId?: string;
	verificationSessionIds?: string[];
	rejection?: TaskRejection;
}

export interface TaskBoard {
	objective: string;
	counts: Record<TaskStatus, number>;
	nodes: TaskBoardNode[];
	ready: string[];
	messages?: TaskBoardMessage[];
}

/** A task's child session as the UI lists it: the worker first, then the verifiers in start order. */
export interface TaskChildSession {
	id: string;
	role: string;
	done: boolean;
}

/** The task node that owns a child session, if the graph still names it. */
export function taskNodeOfChild(graph: TaskGraph, childId: string): TaskNode | undefined {
	return graph.nodes.find(
		(node) => node.subagentSessionId === childId || (node.verificationSessionIds ?? []).includes(childId),
	);
}

/**
 * A task's child sessions, with the role each one ran as. A session that is gone is skipped: an
 * overlay chip would have nothing to open. A resumed worker keeps its old `subagentDone: true`
 * until its first step, so a running node wins over the stored flag.
 */
export function taskChildrenOf(
	source: Pick<TaskNode, 'role' | 'status' | 'subagentSessionId' | 'verificationSessionIds'>,
	lookup: (id: string) => { subagent?: string; subagentDone?: boolean } | undefined,
): TaskChildSession[] {
	const children: TaskChildSession[] = [];
	const seen = new Set<string>();
	for (const id of [source.subagentSessionId, ...(source.verificationSessionIds ?? [])]) {
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		const session = lookup(id);
		if (!session) {
			continue;
		}
		const worker = id === source.subagentSessionId;
		children.push({
			id,
			role: session.subagent ?? (worker ? source.role : 'verifier'),
			done: session.subagentDone === true && !(worker && source.status === 'running'),
		});
	}
	return children;
}

export interface GraphCheck {
	errors: string[];
	warnings: string[];
}

export type ReconcileResult =
	| { ok: true; graph: TaskGraph; warnings: string[] }
	| { ok: false; errors: string[] };

const clean = (value: unknown, limit: number): string => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

function stringList(value: unknown, limit: number, max: number): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string') {
			continue;
		}
		const text = item.trim();
		if (text && text.length <= limit) {
			out.push(text);
		}
		if (out.length >= max) {
			break;
		}
	}
	return out;
}

function unique<T>(list: readonly T[]): T[] {
	return [...new Set(list)];
}

function integer(value: unknown, minimum: number, maximum: number, fallback: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function validPath(value: string): boolean {
	if (!value || value.length > 256 || value.includes('\0')) {
		return false;
	}
	if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) {
		return false;
	}
	return !value.split(/[\\/]/).includes('..');
}

function criteriaOf(value: unknown): AcceptanceCriterion[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: AcceptanceCriterion[] = [];
	for (const item of value.slice(0, MAX_ACCEPTANCE)) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const raw = item as Record<string, unknown>;
		const id = clean(raw.id, 64);
		const description = clean(raw.description, 1000);
		const check = raw.check;
		if (!ID.test(id) || !description || typeof check !== 'string' || !ACCEPTANCE_CHECKS.includes(check as AcceptanceCheck)) {
			continue;
		}
		const files = stringList(raw.files, 256, 16).filter(validPath);
		out.push({
			id,
			description,
			check: check as AcceptanceCheck,
			...(typeof raw.command === 'string' && raw.command.trim() ? { command: raw.command.trim().slice(0, 2000) } : {}),
			...(files.length ? { files } : {}),
		});
	}
	return out;
}

function normalizeCapabilities(value: unknown): Capability[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return unique(value.filter((item): item is Capability => typeof item === 'string')).slice(0, 8);
}

function normalizeInput(node: TaskNodeInput): TaskNodeInput {
	const writes = unique((node.writes ?? []).map((path) => path.replaceAll('\\', '/').replace(/^\.\//, '').trim()));
	return {
		id: node.id,
		title: node.title,
		role: node.role,
		objective: node.objective,
		...(node.inputs !== undefined ? { inputs: node.inputs } : {}),
		...(node.outputs !== undefined ? { outputs: node.outputs } : {}),
		...(writes.length ? { writes } : {}),
		...(node.capabilities !== undefined ? { capabilities: node.capabilities } : {}),
		...(node.network !== undefined ? { network: node.network } : {}),
		dependsOn: unique(node.dependsOn ?? []),
		acceptance: node.acceptance,
		...(node.maxAttempts !== undefined ? { maxAttempts: node.maxAttempts } : {}),
		...(node.maxResumes !== undefined ? { maxResumes: node.maxResumes } : {}),
		...(node.budget !== undefined ? { budget: normalizeBudget(node.budget) } : {}),
	};
}

function effectiveRisk(node: TaskNodeInput, role: AgentRole): AgentRisk {
	return roleRisk(effectiveCapabilities(role, node.capabilities));
}

/** Validates one task graph and computes independent-write warnings. */
export function checkTaskGraph(input: TaskGraphInput, roles: ReadonlyMap<string, AgentRole>): GraphCheck {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!input || typeof input !== 'object') {
		return { errors: ['the task graph must be an object'], warnings };
	}
	if (!clean(input.objective, 4000)) {
		errors.push('the task graph objective is required');
	}
	if (!Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > MAX_TASKS) {
		errors.push(`a task graph needs 1..${MAX_TASKS} nodes`);
		return { errors, warnings };
	}
	const ids = new Set<string>();
	const rolesOf = new Map<string, AgentRole>();
	for (const raw of input.nodes) {
		if (!raw || typeof raw !== 'object') {
			errors.push('every node must be an object');
			continue;
		}
		const node = raw as TaskNodeInput;
		if (typeof node.id !== 'string' || !ID.test(node.id)) {
			errors.push(`invalid node id: ${String(node.id)}`);
			continue;
		}
		if (ids.has(node.id)) {
			errors.push(`duplicate node id: ${node.id}`);
			continue;
		}
		ids.add(node.id);
		if (!clean(node.title, 200)) {
			errors.push(`${node.id}: a title is required`);
		} else if (String(node.title).length > 200) {
			errors.push(`${node.id}: the title is too long`);
		}
		const role = typeof node.role === 'string' ? roles.get(node.role) : undefined;
		if (!role) {
			errors.push(`${node.id}: unknown role ${String(node.role)}`);
			continue;
		}
		rolesOf.set(node.id, role);
		if (!clean(node.objective, 4000)) {
			errors.push(`${node.id}: an objective is required`);
		} else if (String(node.objective).length > 4000) {
			errors.push(`${node.id}: the objective is too long`);
		}
		if (node.inputs !== undefined && String(node.inputs).length > 4000) {
			errors.push(`${node.id}: inputs are too long`);
		}
		if (node.outputs !== undefined && String(node.outputs).length > 4000) {
			errors.push(`${node.id}: outputs are too long`);
		}
		const writes = node.writes ?? [];
		if (!Array.isArray(writes) || writes.length > MAX_WRITES || writes.some((path) => typeof path !== 'string' || !validPath(path))) {
			errors.push(`${node.id}: writes must be at most ${MAX_WRITES} workspace-relative paths`);
		}
		const capabilities = node.capabilities;
		if (capabilities !== undefined) {
			if (!Array.isArray(capabilities) || capabilities.some((capability) => !role.capabilities.includes(capability))) {
				errors.push(`${node.id}: capabilities must be a subset of the role's capabilities`);
			}
		}
		if (node.network === true && !role.network) {
			errors.push(`${node.id}: the role does not allow network`);
		}
		const acceptance = node.acceptance;
		if (!Array.isArray(acceptance) || acceptance.length === 0 || acceptance.length > MAX_ACCEPTANCE) {
			errors.push(`${node.id}: 1..${MAX_ACCEPTANCE} acceptance criteria are required`);
		} else {
			const criterionIds = new Set<string>();
			for (const criterion of acceptance) {
				if (!criterion || typeof criterion.id !== 'string' || !ID.test(criterion.id)) {
					errors.push(`${node.id}: invalid acceptance id`);
					continue;
				}
				if (criterionIds.has(criterion.id)) {
					errors.push(`${node.id}: duplicate acceptance id ${criterion.id}`);
				}
				criterionIds.add(criterion.id);
				if (!clean(criterion.description, 1000)) {
					errors.push(`${node.id}/${criterion.id}: a description is required`);
				}
				if (!ACCEPTANCE_CHECKS.includes(criterion.check)) {
					errors.push(`${node.id}/${criterion.id}: invalid check`);
				}
				if (criterion.check === 'command' && !clean(criterion.command, 2000)) {
					errors.push(`${node.id}/${criterion.id}: a command is required for a command criterion`);
				}
			}
			if (effectiveRisk(node, role) === 'write' && !acceptance.some((criterion) => criterion?.check === 'review' || criterion?.check === 'command')) {
				errors.push(`${node.id}: ${WRITE_TASK_CRITERION_RULE}`);
			}
			// A standalone verification node would itself be verified: acceptance belongs on the node
			// that produces the work, or on a read-only node with evidence criteria.
			if (
				(role.id === 'tester' || role.id === 'reviewer') &&
				!(Array.isArray(writes) && writes.length) &&
				acceptance.some((criterion) => criterion?.check === 'review' || criterion?.check === 'command')
			) {
				warnings.push(
					`${node.id}: a ${role.id} verification node with no writes will be verified again; put acceptance on the producing node or use evidence criteria`,
				);
			}
		}
		const maxAttempts = node.maxAttempts;
		if (maxAttempts !== undefined && (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS)) {
			errors.push(`${node.id}: maxAttempts must be 1..${MAX_ATTEMPTS}`);
		}
		const budget = node.budget;
		if (budget !== undefined) {
			if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
				errors.push(`${node.id}: budget must be an object of turns/tools/tokens/milliseconds`);
			} else {
				for (const [dimension, value] of Object.entries(budget)) {
					if (!['turns', 'tools', 'tokens', 'milliseconds'].includes(dimension)) {
						errors.push(`${node.id}: unknown budget dimension ${dimension}`);
					} else if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_BUDGET_VALUE)) {
						errors.push(`${node.id}: budget.${dimension} must be 0..${MAX_BUDGET_VALUE}`);
					}
				}
			}
		}
		const maxResumes = node.maxResumes;
		if (maxResumes !== undefined && (typeof maxResumes !== 'number' || !Number.isInteger(maxResumes) || maxResumes < 0 || maxResumes > 10)) {
			errors.push(`${node.id}: maxResumes must be 0..10`);
		}
		const deps = node.dependsOn ?? [];
		if (!Array.isArray(deps) || deps.length > MAX_DEPENDENCIES || deps.some((dep) => typeof dep !== 'string')) {
			errors.push(`${node.id}: dependsOn must be at most ${MAX_DEPENDENCIES} ids`);
		} else if (new Set(deps).size !== deps.length) {
			errors.push(`${node.id}: duplicate dependency`);
		} else if (deps.includes(node.id)) {
			errors.push(`${node.id}: a node cannot depend on itself`);
		}
	}
	if (errors.length) {
		return { errors, warnings };
	}
	for (const node of input.nodes) {
		for (const dep of node.dependsOn ?? []) {
			if (!ids.has(dep)) {
				errors.push(`${node.id}: unknown dependency ${dep}`);
			}
		}
	}
	if (errors.length) {
		return { errors, warnings };
	}
	const cycle = findCycle(input.nodes);
	if (cycle) {
		errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
		return { errors, warnings };
	}
	warnings.push(...overlapWarnings(input.nodes, rolesOf));
	return { errors, warnings };
}

function findCycle(nodes: TaskNodeInput[]): string[] | undefined {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const visiting = new Set<string>();
	const done = new Set<string>();
	const path: string[] = [];
	const visit = (id: string): string[] | undefined => {
		if (done.has(id)) {
			return undefined;
		}
		if (visiting.has(id)) {
			const start = path.indexOf(id);
			return [...path.slice(start), id];
		}
		const node = byId.get(id);
		if (!node) {
			return undefined;
		}
		visiting.add(id);
		path.push(id);
		for (const dep of node.dependsOn ?? []) {
			const cycle = visit(dep);
			if (cycle) {
				return cycle;
			}
		}
		path.pop();
		visiting.delete(id);
		done.add(id);
		return undefined;
	};
	for (const node of nodes) {
		const cycle = visit(node.id);
		if (cycle) {
			return cycle;
		}
	}
	return undefined;
}

function ancestor(a: TaskNodeInput, b: TaskNodeInput, byId: Map<string, TaskNodeInput>): boolean {
	const seen = new Set<string>();
	const queue = [...(a.dependsOn ?? [])];
	while (queue.length) {
		const id = queue.pop()!;
		if (id === b.id) {
			return true;
		}
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		const node = byId.get(id);
		if (node) {
			queue.push(...(node.dependsOn ?? []));
		}
	}
	return false;
}

const wildcard = /[*?[\]{}]/;

function pathPrefix(value: string): string {
	const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
	const hit = normalized.search(wildcard);
	return hit === -1 ? normalized : normalized.slice(0, hit).replace(/\/+$/, '');
}

function overlaps(left: string, right: string): boolean {
	const a = pathPrefix(left);
	const b = pathPrefix(right);
	if (!a || !b) {
		return true;
	}
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function overlapWarnings(nodes: TaskNodeInput[], roles: Map<string, AgentRole>): string[] {
	const warnings: string[] = [];
	const byId = new Map(nodes.map((node) => [node.id, node]));
	for (let index = 0; index < nodes.length; index += 1) {
		const left = nodes[index]!;
		const leftRole = roles.get(left.id);
		if (!leftRole || effectiveRisk(left, leftRole) !== 'write' || !left.writes?.length) {
			continue;
		}
		for (let other = index + 1; other < nodes.length; other += 1) {
			const right = nodes[other]!;
			const rightRole = roles.get(right.id);
			if (!rightRole || effectiveRisk(right, rightRole) !== 'write' || !right.writes?.length) {
				continue;
			}
			if (ancestor(left, right, byId) || ancestor(right, left, byId)) {
				continue;
			}
			if (left.writes.some((a) => right.writes!.some((b) => overlaps(a, b)))) {
				warnings.push(
					`${left.id} and ${right.id} declare overlapping write paths; add a dependency or coordinate via the message tool`,
				);
			}
		}
	}
	return warnings;
}

function definition(node: TaskNodeInput | TaskNode, risk: AgentRisk): string {
	const acceptance = [...node.acceptance]
		.map((criterion) => ({
			id: criterion.id,
			description: criterion.description,
			check: criterion.check,
			command: criterion.command ?? '',
			files: [...(criterion.files ?? [])].sort(),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	return JSON.stringify({
		title: node.title,
		role: node.role,
		objective: node.objective,
		inputs: node.inputs ?? '',
		outputs: node.outputs ?? '',
		writes: [...(node.writes ?? [])].sort(),
		capabilities: [...(node.capabilities ?? [])].sort(),
		network: node.network ?? false,
		dependsOn: [...(node.dependsOn ?? [])].sort(),
		acceptance,
		maxAttempts: node.maxAttempts ?? 2,
		maxResumes: node.maxResumes ?? DEFAULT_MAX_RESUMES,
		budget: normalizeBudget(node.budget),
		risk,
	});
}

function nodeOf(input: TaskNodeInput, role: AgentRole, now: number, previous?: TaskNode): TaskNode {
	const normalized = normalizeInput(input);
	const risk = effectiveRisk(normalized, role);
	const reset: TaskNode = {
		...normalized,
		dependsOn: normalized.dependsOn ?? [],
		risk,
		status: 'pending',
		attempts: previous?.attempts ?? 0,
		maxAttempts: normalized.maxAttempts ?? 2,
		resumes: previous?.resumes ?? 0,
		maxResumes: normalized.maxResumes ?? previous?.maxResumes ?? DEFAULT_MAX_RESUMES,
		createdAt: previous?.createdAt ?? now,
	};
	return reset;
}

/** Applies a declarative task graph to the existing graph; refused while a node is in flight. */
export function reconcileTaskGraph(
	existing: TaskGraph | undefined,
	input: TaskGraphInput,
	roles: ReadonlyMap<string, AgentRole>,
	turn: number,
	now = Date.now(),
): ReconcileResult {
	const check = checkTaskGraph(input, roles);
	if (check.errors.length) {
		return { ok: false, errors: check.errors };
	}
	if (existing?.nodes.some((node) => node.status === 'running' || node.status === 'verifying')) {
		return { ok: false, errors: ['cannot revise the task graph while a task is running or being verified'] };
	}
	if (existing && existing.replans >= MAX_REPLANS) {
		return { ok: false, errors: [`the task graph has reached its ${MAX_REPLANS}-replan limit`] };
	}
	const previous = new Map((existing?.nodes ?? []).map((node) => [node.id, node]));
	const nodes: TaskNode[] = [];
	for (const raw of input.nodes) {
		const node = normalizeInput(raw);
		const role = roles.get(node.role)!;
		const before = previous.get(node.id);
		if (!before) {
			nodes.push(nodeOf(node, role, now));
			continue;
		}
		const candidate = nodeOf(node, role, now, before);
		const changed = definition(candidate, candidate.risk) !== definition(before, before.risk);
		if (before.status === 'accepted') {
			if (changed) {
				return { ok: false, errors: [`${node.id}: an accepted task cannot be redefined; add a new node instead`] };
			}
			nodes.push(before);
			continue;
		}
		if (before.status === 'rejected' || before.status === 'paused') {
			if (!changed) {
				nodes.push(before);
				continue;
			}
			// A materially changed definition is new work under the same id: give it its full resume
			// budget again, but keep attempts, which are the node's real cost record.
			candidate.resumes = 0;
			if (candidate.attempts >= candidate.maxAttempts) {
				const advice =
					candidate.attempts >= MAX_ATTEMPTS ? 'add a new node id' : 'raise maxAttempts or add a new node id';
				check.warnings.push(
					`${node.id}: the changed definition resets resumes, but the node has spent its ${candidate.attempts} attempts; ${advice}`,
				);
			}
			nodes.push(candidate);
			continue;
		}
		// pending: update the definition but keep the attempt and resume history.
		nodes.push(candidate);
	}
	const graph: TaskGraph = {
		version: (existing?.version ?? 0) + 1,
		objective: input.objective,
		nodes,
		replans: existing ? existing.replans + 1 : 0,
		turn,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
	return { ok: true, graph, warnings: check.warnings };
}

/** Pending nodes whose dependencies are all accepted. */
export function readyNodes(graph: TaskGraph): TaskNode[] {
	const status = new Map(graph.nodes.map((node) => [node.id, node.status]));
	return graph.nodes.filter(
		(node) => node.status === 'pending' && node.dependsOn.every((id) => status.get(id) === 'accepted'),
	);
}

/**
 * Map a worker/verifier acceptance list onto the expected criterion ids. Exact ids win. When the
 * counts agree and no id matches, position is the only deterministic correspondence, so use it and
 * record the original id in the note. Anything else is an explicit mismatch, never a silent drop.
 */
export function mapReportedCriteria(
	expected: readonly Pick<AcceptanceCriterion, 'id'>[],
	reported: readonly CriterionResult[],
): { ok: true; criteria: CriterionResult[]; positional: boolean } | { ok: false; reason: string } {
	const expectedIds = expected.map((criterion) => criterion.id);
	const reportedIds = reported.map((criterion) => criterion.id);
	const seen = new Set<string>();
	for (const id of reportedIds) {
		if (seen.has(id)) {
			return { ok: false, reason: `the acceptance list repeats id ${id}` };
		}
		seen.add(id);
	}
	const byId = new Map(reported.map((criterion) => [criterion.id, criterion]));
	if (expectedIds.every((id) => byId.has(id))) {
		return { ok: true, positional: false, criteria: expectedIds.map((id) => byId.get(id)!) };
	}
	const expectedSet = new Set(expectedIds);
	const disjoint = reported.every((criterion) => !expectedSet.has(criterion.id));
	if (disjoint && reported.length === expected.length && expected.length > 0) {
		return {
			ok: true,
			positional: true,
			criteria: expected.map((criterion, index) => {
				const actual = reported[index]!;
				const mapping = `reported id ${actual.id} mapped positionally to ${criterion.id}`;
				return { id: criterion.id, met: actual.met, note: [actual.note, mapping].filter(Boolean).join('; ') };
			}),
		};
	}
	const got = reportedIds.length ? reportedIds.join(', ') : '(none)';
	return { ok: false, reason: `expected acceptance ids ${expectedIds.join(', ')} but got ${got}` };
}

/** The deterministic acceptance rule; a verifier's self-declared verdict is never consulted. */
export function satisfiesAcceptance(node: TaskNode): { accepted: boolean; reason?: string } {
	if (!node.result) {
		return { accepted: false, reason: 'no worker result' };
	}
	if (node.result.status !== 'ok') {
		return { accepted: false, reason: `worker reported ${node.result.status}` };
	}
	if (node.result.evidence.length === 0) {
		return { accepted: false, reason: 'the worker returned no evidence' };
	}
	if (node.risk === 'write' && !node.verification) {
		return { accepted: false, reason: 'a write task needs independent verification' };
	}
	const results = new Map(node.result.criteria.map((criterion) => [criterion.id, criterion]));
	const checks = new Map((node.verification?.checks ?? []).map((check) => [check.id, check]));
	for (const criterion of node.acceptance) {
		if (criterion.check === 'evidence') {
			if (results.get(criterion.id)?.met !== true) {
				return { accepted: false, reason: `criterion ${criterion.id} is not met` };
			}
			continue;
		}
		const check = checks.get(criterion.id);
		if (!check) {
			return {
				accepted: false,
				reason: `criterion ${criterion.id} was not reported by the ${criterion.check === 'command' ? 'tester' : 'reviewer'}`,
			};
		}
		if (check.met !== true) {
			return {
				accepted: false,
				reason: `criterion ${criterion.id} is not met${check.note ? `: ${clean(check.note, 300)}` : ''}`,
			};
		}
		if (criterion.check === 'command') {
			const command = (check.evidence ?? []).find(
				(evidence) =>
					evidence.kind === 'command' && commandMatches(evidence.command, criterion.command ?? '') && evidence.exitCode === 0,
			);
			if (!command) {
				const observed = (check.evidence ?? [])
					.filter((evidence): evidence is Extract<AgentEvidence, { kind: 'command' }> => evidence.kind === 'command')
					.slice(0, 3)
					.map((evidence) => `"${clean(evidence.command, 200)}" exited ${evidence.exitCode}`);
				return {
					accepted: false,
					reason: `criterion ${criterion.id} has no successful command evidence for "${clean(criterion.command ?? '', 300)}"${
						observed.length ? `; the tester reported ${observed.join(', ')}` : ''
					}${check.note ? `; note: ${clean(check.note, 300)}` : ''}`,
				};
			}
		}
	}
	return { accepted: true };
}

export function taskCounts(graph: TaskGraph): Record<TaskStatus, number> {
	const counts: Record<TaskStatus, number> = { pending: 0, running: 0, verifying: 0, accepted: 0, rejected: 0, paused: 0 };
	for (const node of graph.nodes) {
		counts[node.status] += 1;
	}
	return counts;
}

export function boardOf(graph: TaskGraph, messages?: readonly TaskBoardMessage[]): TaskBoard {
	return {
		objective: graph.objective,
		counts: taskCounts(graph),
		nodes: graph.nodes.map((node) => ({
			id: node.id,
			title: node.title,
			role: node.role,
			status: node.status,
			risk: node.risk,
			dependsOn: [...node.dependsOn],
			writes: [...(node.writes ?? [])],
			...(node.subagentSessionId ? { subagentSessionId: node.subagentSessionId } : {}),
			...(node.verificationSessionIds?.length ? { verificationSessionIds: [...node.verificationSessionIds] } : {}),
			...(node.rejection ? { rejection: node.rejection } : {}),
		})),
		ready: readyNodes(graph).map((node) => node.id),
		...(messages?.length ? { messages: messages.map((message) => ({ ...message })) } : {}),
	};
}

export function formatBoard(board: TaskBoard): string {
	const counts = board.counts;
	const total = TASK_STATUSES.reduce((sum, status) => sum + counts[status], 0);
	const head = `${counts.accepted}/${total} accepted · ${counts.running} running · ${counts.verifying} verifying · ${counts.paused} paused · ${counts.rejected} rejected · ${counts.pending} pending`;
	const lines = [`Goal: ${board.objective}`, head];
	for (const node of board.nodes) {
		const suffix = node.rejection ? ` — ${node.rejection.code}: ${node.rejection.reason}` : '';
		const writes = node.writes.length ? ` [${node.writes.join(', ')}]` : '';
		lines.push(`- [${node.status}] ${node.id} (${node.role}, ${node.risk})${writes}${suffix}`);
	}
	if (board.ready.length) {
		lines.push(`Ready: ${board.ready.join(', ')}`);
	}
	if (board.messages?.length) {
		lines.push('Recent messages:');
		for (const message of board.messages) {
			lines.push(`- ${message.from} -> ${message.to}: ${message.text}`);
		}
	}
	return lines.join('\n');
}

/** Defensive read of a graph saved in a session: bounds only, never a status rewrite. */
export function sanitizeTaskGraph(value: unknown): TaskGraph | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const objective = clean(raw.objective, 4000);
	const nodesRaw = raw.nodes;
	if (!objective || !Array.isArray(nodesRaw) || nodesRaw.length === 0 || nodesRaw.length > MAX_TASKS) {
		return undefined;
	}
	const nodes: TaskNode[] = [];
	for (const item of nodesRaw) {
		if (!item || typeof item !== 'object') {
			return undefined;
		}
		const node = item as Record<string, unknown>;
		const id = clean(node.id, 64);
		const title = clean(node.title, 200);
		const role = clean(node.role, 64);
		const taskObjective = clean(node.objective, 4000);
		const status = node.status;
		const risk = node.risk;
		if (
			!ID.test(id) ||
			!title ||
			!role ||
			!taskObjective ||
			typeof status !== 'string' ||
			!TASK_STATUSES.includes(status as TaskStatus) ||
			(risk !== 'read' && risk !== 'write')
		) {
			return undefined;
		}
		const acceptance = criteriaOf(node.acceptance);
		if (!acceptance.length) {
			return undefined;
		}
		const result = sanitizeResult(node.result);
		const verification = sanitizeVerification(node.verification);
		const rejection = sanitizeRejection(node.rejection);
		nodes.push({
			id,
			title,
			role,
			objective: taskObjective,
			...(typeof node.inputs === 'string' ? { inputs: clean(node.inputs, 4000) } : {}),
			...(typeof node.outputs === 'string' ? { outputs: clean(node.outputs, 4000) } : {}),
			...(Array.isArray(node.writes) ? { writes: stringList(node.writes, 256, MAX_WRITES) } : {}),
			...(Array.isArray(node.capabilities) ? { capabilities: normalizeCapabilities(node.capabilities) } : {}),
			...(typeof node.network === 'boolean' ? { network: node.network } : {}),
			dependsOn: stringList(node.dependsOn, 64, MAX_DEPENDENCIES),
			acceptance,
			...(node.budget && typeof node.budget === 'object' && !Array.isArray(node.budget)
				? { budget: normalizeBudget(node.budget as BudgetInput) }
				: {}),
			risk: risk as AgentRisk,
			status: status as TaskStatus,
			attempts: integer(node.attempts, 0, MAX_ATTEMPTS, 0),
			maxAttempts: integer(node.maxAttempts, 1, MAX_ATTEMPTS, 2),
			resumes: integer(node.resumes, 0, 10, 0),
			maxResumes: integer(node.maxResumes, 0, 10, DEFAULT_MAX_RESUMES),
			createdAt: integer(node.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
			...(typeof node.startedAt === 'number' ? { startedAt: node.startedAt } : {}),
			...(typeof node.finishedAt === 'number' ? { finishedAt: node.finishedAt } : {}),
			...(typeof node.subagentSessionId === 'string' ? { subagentSessionId: clean(node.subagentSessionId, 200) } : {}),
			...(Array.isArray(node.verificationSessionIds)
				? { verificationSessionIds: stringList(node.verificationSessionIds, 200, 8) }
				: {}),
			...(result ? { result } : {}),
			...(verification ? { verification } : {}),
			...(rejection ? { rejection } : {}),
		});
	}
	const ids = new Set(nodes.map((node) => node.id));
	if (ids.size !== nodes.length) {
		return undefined;
	}
	for (const node of nodes) {
		if (node.dependsOn.some((id) => !ids.has(id)) || node.dependsOn.includes(node.id)) {
			return undefined;
		}
	}
	if (findCycle(nodes)) {
		return undefined;
	}
	return {
		version: integer(raw.version, 1, Number.MAX_SAFE_INTEGER, 1),
		objective,
		nodes,
		replans: integer(raw.replans, 0, MAX_REPLANS, 0),
		turn: integer(raw.turn, 0, Number.MAX_SAFE_INTEGER, 0),
		createdAt: integer(raw.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
		updatedAt: integer(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0),
	};
}

function sanitizeCriteria(value: unknown): CriterionResult[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: CriterionResult[] = [];
	for (const item of value.slice(0, MAX_ACCEPTANCE)) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const raw = item as Record<string, unknown>;
		const id = clean(raw.id, 64);
		if (!ID.test(id) || typeof raw.met !== 'boolean') {
			continue;
		}
		out.push({ id, met: raw.met, ...(typeof raw.note === 'string' ? { note: clean(raw.note, 1000) } : {}) });
	}
	return out;
}

function sanitizeBudgetReport(value: unknown): BudgetReport | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const usageRaw = raw.usage && typeof raw.usage === 'object' ? (raw.usage as Record<string, unknown>) : {};
	const usage: BudgetUsage = {
		turns: integer(usageRaw.turns, 0, MAX_BUDGET_VALUE, 0),
		tools: integer(usageRaw.tools, 0, MAX_BUDGET_VALUE, 0),
		tokens: integer(usageRaw.tokens, 0, MAX_BUDGET_VALUE, 0),
		milliseconds: integer(usageRaw.milliseconds, 0, MAX_BUDGET_VALUE, 0),
	};
	const stopped = raw.stopped;
	return {
		limits: normalizeBudget(raw.limits as BudgetInput),
		usage,
		...(typeof stopped === 'string' && ['turns', 'tools', 'tokens', 'milliseconds'].includes(stopped)
			? { stopped: stopped as BudgetDimension }
			: {}),
	};
}

function sanitizeResult(value: unknown): TaskResult | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const status = raw.status;
	if (status !== 'ok' && status !== 'blocked' && status !== 'failed') {
		return undefined;
	}
	const budget = sanitizeBudgetReport(raw.budget);
	return {
		status,
		summary: clean(raw.summary, 2000),
		evidence: sanitizeEvidence(raw.evidence),
		criteria: sanitizeCriteria(raw.criteria),
		writes: stringList(raw.writes, 256, MAX_WRITES),
		...(typeof raw.sessionId === 'string' ? { sessionId: clean(raw.sessionId, 200) } : {}),
		...(budget ? { budget } : {}),
		at: integer(raw.at, 0, Number.MAX_SAFE_INTEGER, 0),
	};
}

function sanitizeVerification(value: unknown): TaskVerification | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.checks)) {
		return undefined;
	}
	const checks: TaskVerificationCheck[] = [];
	for (const item of raw.checks.slice(0, MAX_ACCEPTANCE)) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const check = item as Record<string, unknown>;
		const id = clean(check.id, 64);
		if (!ID.test(id) || typeof check.met !== 'boolean' || (check.by !== 'reviewer' && check.by !== 'tester')) {
			continue;
		}
		checks.push({
			id,
			met: check.met,
			...(typeof check.note === 'string' ? { note: clean(check.note, 1000) } : {}),
			by: check.by,
			...(typeof check.sessionId === 'string' ? { sessionId: clean(check.sessionId, 200) } : {}),
			...(Array.isArray(check.evidence) ? { evidence: sanitizeEvidence(check.evidence) } : {}),
		});
	}
	return { summary: clean(raw.summary, 2000), checks, at: integer(raw.at, 0, Number.MAX_SAFE_INTEGER, 0) };
}

function sanitizeRejection(value: unknown): TaskRejection | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const code = raw.code;
	if (
		code !== 'worker_failed' &&
		code !== 'worker_blocked' &&
		code !== 'invalid_output' &&
		code !== 'verification_failed' &&
		code !== 'verification_unavailable' &&
		code !== 'stopped' &&
		code !== 'interrupted' &&
		code !== 'limit' &&
		code !== 'budget_exhausted' &&
		code !== 'resume_unavailable'
	) {
		return undefined;
	}
	const budget = sanitizeBudgetReport(raw.budget);
	return {
		code,
		reason: clean(raw.reason, 2000),
		...(budget ? { budget } : {}),
		...(typeof raw.partial === 'string' ? { partial: clean(raw.partial, 4000) } : {}),
		...(typeof raw.resumable === 'boolean' ? { resumable: raw.resumable } : {}),
		...(Array.isArray(raw.writes) ? { writes: stringList(raw.writes, 256, MAX_WRITES) } : {}),
		at: integer(raw.at, 0, Number.MAX_SAFE_INTEGER, 0),
	};
}
