// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'cordis';
import { effectiveCapabilities } from '../lib/agents';
import { clampResumeBudget, type BudgetDimension, type BudgetInput } from '../lib/budget';
import { buildVerifierPrompt, buildWorkerTaskPrompt } from '../lib/agent-prompts';
import { parseAgentEnvelope } from '../lib/agent-output';
import { planRules } from '../lib/plan-rules';
import { SUBAGENT_CAPABILITIES } from '../lib/subagent';
import {
	ACCEPTANCE_CHECKS,
	WRITE_TASK_CRITERION_RULE,
	boardOf,
	formatBoard,
	mapReportedCriteria,
	type TaskGraphAccess,
	type TaskNode,
	type TaskNodeInput,
	type TaskResult,
	type TaskVerificationCheck,
} from '../lib/task-graph';
import { objectSchema, type ToolContext } from '../lib/types';

/** The Orchestrator's task tools and the shared coordination mailbox. */

const FAILED = (error: unknown): string => `Error: ${error instanceof Error ? error.message : String(error)}`;

/** The phase rules for the current tool context, from the one visible tool set. */
function rulesOf(ctx: Context, toolCtx: ToolContext) {
	return planRules({
		policy: toolCtx.policy,
		visible: new Set(ctx.tools.visible(toolCtx.policy).map((tool) => tool.name)),
	});
}

const budgetSchema = {
	type: 'object',
	properties: {
		turns: { type: 'integer', minimum: 0, description: 'Model round trips. 0 = no limit.' },
		tools: { type: 'integer', minimum: 0, description: 'Tool calls. 0 = no limit.' },
		tokens: { type: 'integer', minimum: 0, description: 'Input + output tokens. 0 = no limit.' },
		milliseconds: { type: 'integer', minimum: 0, description: 'Wall-clock milliseconds. 0 = no limit.' },
	},
	additionalProperties: false,
	description:
		'Per-task native budget; each dimension can only tighten the role/global default. On resume, a dimension below the previous segment is raised to it.',
};

const acceptanceSchema = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'Slug, unique within the node.' },
		description: { type: 'string', description: 'What must be true; testable by a reviewer.' },
		check: { type: 'string', enum: [...ACCEPTANCE_CHECKS] },
		command: { type: 'string', description: 'Required for a command criterion; the tester runs it exactly.' },
		files: { type: 'array', items: { type: 'string' }, description: 'Context for the verifier.' },
	},
	required: ['id', 'description', 'check'],
	additionalProperties: false,
};

const nodeSchema = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'Slug, unique in the task graph.' },
		title: { type: 'string' },
		role: { type: 'string', description: 'One of the roles in the Orchestration block or a custom role.' },
		objective: { type: 'string', description: 'A self-contained brief for one worker.' },
		inputs: { type: 'string', description: 'Facts, files or prior results the worker needs.' },
		outputs: { type: 'string', description: 'The deliverable the worker should produce.' },
		writes: {
			type: 'array',
			items: { type: 'string' },
			description: 'Workspace-relative paths or globs this task expects to modify; used for coordination.',
		},
		capabilities: {
			type: 'array',
			items: { type: 'string', enum: [...SUBAGENT_CAPABILITIES] },
			description: 'Further narrow the role capabilities; never widen them.',
		},
		network: { type: 'boolean', description: 'false narrows network off; true only when the role allows it.' },
		dependsOn: { type: 'array', items: { type: 'string' } },
		acceptance: { type: 'array', minItems: 1, maxItems: 8, items: acceptanceSchema },
		maxAttempts: { type: 'integer', minimum: 1, maximum: 3 },
		maxResumes: { type: 'integer', minimum: 0, maximum: 10, description: 'How many times a paused budget run may be resumed. Default 3.' },
		budget: budgetSchema,
	},
	required: ['id', 'title', 'role', 'objective', 'acceptance'],
	additionalProperties: false,
};

export function orchestrateTools(ctx: Context): void {
	ctx.tools.register({
		name: 'task_graph',
		description:
			`Record or revise the Orchestrator task graph. Send the complete desired node set on every revision. ${WRITE_TASK_CRITERION_RULE}. Dependencies must be acyclic; only pending, ready nodes can be delegated. The runtime derives a fixed independent reviewer/tester for review/command criteria, so you cannot mark a task accepted yourself. The runtime refuses a new or revised task the session cannot run; accepted tasks are kept as history.`,
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		serial: true,
		parameters: objectSchema(
			{
				objective: { type: 'string', description: 'The user goal this task graph serves.' },
				nodes: { type: 'array', minItems: 1, maxItems: 32, items: nodeSchema },
			},
			['objective', 'nodes'],
		),
		async execute(args, toolCtx) {
			const access = toolCtx.taskGraph;
			if (!access) {
				return 'Error: the task graph is only available to the Orchestrator';
			}
			const input = args as { objective: string; nodes: TaskNodeInput[] };
			const rules = rulesOf(ctx, toolCtx);
			try {
				return await ctx.orchestrator.run(access, async () => {
					const result = ctx.orchestrator.recordTaskGraph(
						access,
						{ objective: input.objective, nodes: input.nodes },
						rules,
					);
					const warnings = result.warnings.length
						? `\n\nWarnings:\n${result.warnings.map((warning) => `- ${warning}`).join('\n')}`
						: '';
					return `${formatBoard(boardOf(result.graph))}${warnings}`;
				});
			} catch (error) {
				return FAILED(error);
			}
		},
	});

	ctx.tools.register({
		name: 'delegate',
		description:
			'Run 1..8 ready tasks from the current task graph in parallel. All selected tasks must be pending and ready; a batch may not contain dependencies within itself. Read and write tasks may run together; the runtime serialises writes to the same file and parallel workers can coordinate through the message tool. A worker that exhausts a native budget is paused, not rejected: use resume to continue its session when it has resumes left. After the workers finish, the runtime derives fixed independent reviewer/tester children for review/command criteria. You cannot mark a task accepted; read the board and verifier results, then replan rejected work within its attempt budget.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		serial: true,
		parameters: objectSchema(
			{
				tasks: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' }, description: 'Task ids from the current task graph.' },
			},
			['tasks'],
		),
		async execute(args, toolCtx) {
			const access = toolCtx.taskGraph;
			if (!access) {
				return 'Error: delegation is only available to the Orchestrator';
			}
			const ids = (args as { tasks?: unknown }).tasks;
			const tasks = Array.isArray(ids)
				? ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
				: [];
			if (!tasks.length) {
				return 'Error: tasks must name at least one task id';
			}
			try {
				return await ctx.orchestrator.run(access, async () => {
					const graph = access.get();
					if (!graph) {
						return 'Error: no task graph exists; call task_graph first';
					}
					const roles = ctx.orchestrator.roles();
					const rules = rulesOf(ctx, toolCtx);
					for (const id of tasks) {
						const node = graph.nodes.find((candidate) => candidate.id === id);
						if (!node) {
							return `Error: unknown task ${id}`;
						}
						const role = roles.get(node.role);
						if (!role) {
							return `Error: ${id}: role ${node.role} is not available`;
						}
						const caps = effectiveCapabilities(role, node.capabilities);
						const write = rules.writeRefusal(id, caps);
						if (write) {
							return `Error: ${write}`;
						}
						const network = node.network ?? role.network;
						if (network && !toolCtx.policy.network) {
							return `Error: ${id} needs network, but the session has network off`;
						}
						const command = rules.commandRefusal(id, node.acceptance);
						if (command) {
							return `Error: ${command}`;
						}
					}
					const runs = ctx.orchestrator.begin(access, tasks);
					const peersOf = (self: string) =>
						runs
							.filter((run) => run.node.id !== self)
							.map((run) => ({ id: run.node.id, role: run.role.id, writes: run.node.writes ?? [] }));
					const settled = await Promise.all(
						runs.map(async (run) => {
							const node = run.node;
							const outcome = await toolCtx.spawnAgent({
								prompt: buildWorkerTaskPrompt({
									taskId: node.id,
									title: node.title,
									objective: node.objective,
									inputs: node.inputs,
									outputs: node.outputs,
									acceptance: node.acceptance,
									peers: peersOf(node.id),
								}),
								agent: run.role.id,
								taskId: node.id,
								contract: 'worker',
								capabilities: effectiveCapabilities(run.role, node.capabilities),
								network: node.network ?? run.role.network,
								budget: node.budget,
								description: node.title,
								...(tasks.length === 1 && toolCtx.callId ? { callId: toolCtx.callId } : {}),
								onStart: (sessionId) => ctx.orchestrator.attach(access, node.id, sessionId),
								signal: toolCtx.signal,
							});
							return { run, outcome };
						}),
					);
					const pendingVerification: Array<{ node: TaskNode; report: string; writes: string[] }> = [];
					for (const { run, outcome } of settled) {
						const node = run.node;
						if (outcome.paused) {
							ctx.orchestrator.pause(
								access,
								node.id,
								outcome.budget ?? {
									limits: { turns: 0, tools: 0, tokens: 0, milliseconds: 0 },
									usage: { turns: 0, tools: 0, tokens: 0, milliseconds: 0 },
								},
								outcome.report,
								outcome.lastTool,
								outcome.writes,
							);
							continue;
						}
						if (!outcome.ok) {
							ctx.orchestrator.reject(access, node.id, {
								code: outcome.stopped ? 'stopped' : 'worker_failed',
								reason: outcome.error ?? outcome.report ?? 'the worker failed',
								at: Date.now(),
							});
							continue;
						}
						const parsed = parseAgentEnvelope(outcome.report);
						if (!parsed.ok) {
							ctx.orchestrator.reject(access, node.id, { code: 'invalid_output', reason: parsed.reason, at: Date.now() });
							continue;
						}
						const envelope = parsed.value;
						const result: TaskResult = {
							status: envelope.status === 'blocked' || envelope.status === 'failed' ? envelope.status : 'ok',
							summary: envelope.summary,
							evidence: envelope.evidence,
							criteria: envelope.acceptance ?? [],
							writes: outcome.writes,
							...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
							at: Date.now(),
						};
						ctx.orchestrator.recordWorker(access, node.id, result);
						if (result.status !== 'ok') {
							ctx.orchestrator.finish(access, node.id);
							continue;
						}
						if (node.acceptance.every((criterion) => criterion.check === 'evidence')) {
							ctx.orchestrator.finish(access, node.id);
							continue;
						}
						pendingVerification.push({ node, report: outcome.report, writes: outcome.writes });
					}
					// Review verifiers run in parallel; command verifiers run one at a time so two test
					// processes cannot fight over the same scratch or build outputs.
					const review = pendingVerification.filter((item) => item.node.acceptance.some((criterion) => criterion.check === 'review'));
					await Promise.all(review.map((item) => runVerifier(ctx, toolCtx, access, item, 'reviewer')));
					for (const item of pendingVerification.filter((entry) => entry.node.acceptance.some((criterion) => criterion.check === 'command'))) {
						await runVerifier(ctx, toolCtx, access, item, 'tester');
					}
					for (const item of pendingVerification) {
						const node = access.get()?.nodes.find((candidate) => candidate.id === item.node.id);
						if (node?.status === 'verifying' || node?.status === 'running') {
							ctx.orchestrator.finish(access, node.id);
						}
					}
					const final = access.get();
					return final ? `${formatBoard(boardOf(final))}\n\n${detailsOf(final, tasks)}` : 'The task graph disappeared.';
				});
			} catch (error) {
				return FAILED(error);
			}
		},
	});

	ctx.tools.register({
		name: 'task_status',
		description:
			'Read the current task board, ready nodes, rejection reasons, paused budgets, child/verifier session ids and recent coordination messages. Use it before delivering, after a rejection before replanning, and before resuming a paused task.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema({
			tasks: { type: 'array', items: { type: 'string' }, description: 'Only show these task ids; omit for the whole task graph.' },
		}),
		async execute(args, toolCtx) {
			const access = toolCtx.taskGraph;
			if (!access) {
				return 'Error: task status is only available to the Orchestrator';
			}
			const graph = access.get();
			if (!graph) {
				return 'No task graph exists for this chat.';
			}
			const wanted = (args as { tasks?: unknown }).tasks;
			const ids = Array.isArray(wanted) ? wanted.filter((id): id is string => typeof id === 'string') : [];
			const messages = ctx.mailbox.recent(access.sessionId, 10).map((record) => ({
				at: record.at,
				from: record.from.task ?? record.from.agent ?? record.from.session ?? 'unknown',
				to: record.to,
				text: record.text,
			}));
			const board = formatBoard(boardOf(graph, messages));
			return ids.length ? `${board}\n\n${detailsOf(graph, ids)}` : `${board}\n\n${detailsOf(graph, graph.nodes.map((node) => node.id))}`;
		},
	});

	ctx.tools.register({
		name: 'resume',
		description:
			'Resume 1..8 paused tasks with a new segment budget. Resuming continues the same child session and transcript; it does not spend an attempt. A segment budget is an upper bound and cannot be smaller than the previous segment: smaller dimensions are raised to its limits and reported in the result. Omit budget to use the node or default budget. If the pause reason says the resume limit is spent, replan instead.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		serial: true,
		parameters: objectSchema(
			{
				tasks: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' }, description: 'Paused task ids from the current task graph.' },
				budget: budgetSchema,
			},
			['tasks'],
		),
		async execute(args, toolCtx) {
			const access = toolCtx.taskGraph;
			if (!access) {
				return 'Error: resuming is only available to the Orchestrator';
			}
			const input = args as { tasks?: unknown; budget?: BudgetInput };
			const tasks = Array.isArray(input.tasks)
				? input.tasks.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
				: [];
			if (!tasks.length) {
				return 'Error: tasks must name at least one paused task id';
			}
			try {
				return await ctx.orchestrator.run(access, async () => {
					const graph = access.get();
					if (!graph) {
						return 'Error: no task graph exists; call task_graph first';
					}
					const roles = ctx.orchestrator.roles();
					const rules = rulesOf(ctx, toolCtx);
					const priorWrites = new Map<string, string[]>();
					const budgets = new Map<string, BudgetInput | undefined>();
					const raised: Array<{ id: string; dimensions: BudgetDimension[]; from: BudgetInput; to: BudgetInput }> = [];
					for (const id of tasks) {
						const node = graph.nodes.find((candidate) => candidate.id === id);
						if (!node) {
							return `Error: unknown task ${id}`;
						}
						if (node.status !== 'paused') {
							return `Error: ${id} is ${node.status}, not paused`;
						}
						if (!node.subagentSessionId) {
							return `Error: ${id} has no child session to resume`;
						}
						const role = roles.get(node.role);
						if (!role) {
							return `Error: ${id}: role ${node.role} is not available`;
						}
						const caps = effectiveCapabilities(role, node.capabilities);
						const write = rules.writeRefusal(id, caps);
						if (write) {
							return `Error: ${write}`;
						}
						if ((node.network ?? role.network) && !toolCtx.policy.network) {
							return `Error: ${id} needs network, but the session has network off`;
						}
						const command = rules.commandRefusal(id, node.acceptance);
						if (command) {
							return `Error: ${command}`;
						}
						priorWrites.set(id, [...(node.rejection?.writes ?? [])]);
						const requested = input.budget ?? node.budget;
						const adjusted = clampResumeBudget(node.rejection?.budget?.limits, requested);
						budgets.set(id, adjusted.budget);
						if (adjusted.clamped.length && adjusted.budget) {
							raised.push({ id, dimensions: adjusted.clamped, from: requested ?? {}, to: adjusted.budget });
						}
					}
					const runs = ctx.orchestrator.resume(access, tasks);
					const settled = await Promise.all(
						runs.map(async (run) => {
							const node = run.node;
							const outcome = await toolCtx.spawnAgent({
								prompt: buildWorkerTaskPrompt({
									taskId: node.id,
									title: node.title,
									objective: node.objective,
									inputs: node.inputs,
									outputs: node.outputs,
									acceptance: node.acceptance,
								}),
								agent: run.role.id,
								taskId: node.id,
								contract: 'worker',
								capabilities: effectiveCapabilities(run.role, node.capabilities),
								network: node.network ?? run.role.network,
								budget: budgets.get(node.id),
								resumeSessionId: node.subagentSessionId,
								description: node.title,
								...(tasks.length === 1 && toolCtx.callId ? { callId: toolCtx.callId } : {}),
								onStart: (sessionId) => ctx.orchestrator.attach(access, node.id, sessionId),
								signal: toolCtx.signal,
							});
							return { run, outcome, prior: priorWrites.get(node.id) ?? [] };
						}),
					);
					const pendingVerification: Array<{ node: TaskNode; report: string; writes: string[] }> = [];
					for (const { run, outcome, prior } of settled) {
						const node = run.node;
						if (outcome.paused) {
							ctx.orchestrator.pause(
								access,
								node.id,
								outcome.budget ?? {
									limits: { turns: 0, tools: 0, tokens: 0, milliseconds: 0 },
									usage: { turns: 0, tools: 0, tokens: 0, milliseconds: 0 },
								},
								outcome.report,
								outcome.lastTool,
								[...new Set([...prior, ...outcome.writes])],
							);
							continue;
						}
						if (!outcome.ok) {
							ctx.orchestrator.reject(access, node.id, {
								code: outcome.error?.startsWith('cannot resume')
									? 'resume_unavailable'
									: outcome.stopped
										? 'stopped'
										: 'worker_failed',
								reason: outcome.error ?? outcome.report ?? 'the worker failed',
								at: Date.now(),
							});
							continue;
						}
						const parsed = parseAgentEnvelope(outcome.report);
						if (!parsed.ok) {
							ctx.orchestrator.reject(access, node.id, { code: 'invalid_output', reason: parsed.reason, at: Date.now() });
							continue;
						}
						const envelope = parsed.value;
						const writes = [...new Set([...prior, ...outcome.writes])];
						const result: TaskResult = {
							status: envelope.status === 'blocked' || envelope.status === 'failed' ? envelope.status : 'ok',
							summary: envelope.summary,
							evidence: envelope.evidence,
							criteria: envelope.acceptance ?? [],
							writes,
							...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
							at: Date.now(),
						};
						ctx.orchestrator.recordWorker(access, node.id, result);
						if (result.status !== 'ok') {
							ctx.orchestrator.finish(access, node.id);
							continue;
						}
						if (node.acceptance.every((criterion) => criterion.check === 'evidence')) {
							ctx.orchestrator.finish(access, node.id);
							continue;
						}
						pendingVerification.push({ node, report: outcome.report, writes });
					}
					const review = pendingVerification.filter((item) => item.node.acceptance.some((criterion) => criterion.check === 'review'));
					await Promise.all(review.map((item) => runVerifier(ctx, toolCtx, access, item, 'reviewer')));
					for (const item of pendingVerification.filter((entry) => entry.node.acceptance.some((criterion) => criterion.check === 'command'))) {
						await runVerifier(ctx, toolCtx, access, item, 'tester');
					}
					for (const item of pendingVerification) {
						const node = access.get()?.nodes.find((candidate) => candidate.id === item.node.id);
						if (node?.status === 'verifying' || node?.status === 'running') {
							ctx.orchestrator.finish(access, node.id);
						}
					}
					const limitText = (value: number | undefined): string => (value && value > 0 ? String(value) : '∞');
					const notice = raised.length
						? `\n\nResume budgets raised (a segment cannot shrink the previous segment):\n${raised
								.map(
									({ id, dimensions, from, to }) =>
										`- ${id}: ${dimensions
											.map((dimension) => `${dimension} ${limitText(from[dimension])} -> ${limitText(to[dimension])}`)
											.join(', ')}`,
								)
								.join('\n')}`
						: '';
					const final = access.get();
					return final ? `${formatBoard(boardOf(final))}\n\n${detailsOf(final, tasks)}${notice}` : 'The task graph disappeared.';
				});
			} catch (error) {
				return FAILED(error);
			}
		},
	});
}
orchestrateTools.inject = ['tools', 'orchestrator', 'mailbox'];

async function runVerifier(
	ctx: Context,
	toolCtx: ToolContext,
	access: TaskGraphAccess,
	item: { node: TaskNode; report: string; writes: string[] },
	roleId: 'reviewer' | 'tester',
): Promise<void> {
	const node = access.get()?.nodes.find((candidate) => candidate.id === item.node.id);
	if (!node || node.status !== 'verifying') {
		return;
	}
	const role = ctx.orchestrator.pinned(roleId);
	if (!role) {
		ctx.orchestrator.reject(access, node.id, {
			code: 'verification_unavailable',
			reason: `the built-in ${roleId} role is unavailable`,
			at: Date.now(),
		});
		return;
	}
	// Each fixed verifier judges only its own kind of criterion: the reviewer never pretends to have
	// run a command, and the tester never replaces the reviewer's judgement.
	const group = roleId === 'reviewer' ? 'review' : 'command';
	const criteria = node.acceptance.filter((criterion) => criterion.check === group);
	const outcome = await toolCtx.spawnAgent({
		prompt: buildVerifierPrompt({
			taskId: node.id,
			title: node.title,
			role: node.role,
			objective: node.objective,
			acceptance: criteria,
			workerReport: item.report,
			workerWrites: item.writes,
		}),
		agent: role.id,
		pinned: true,
		taskId: node.id,
		contract: 'verifier',
		// A verifier may inspect and, for command criteria, run the scratch-only test shell; it never writes.
		capabilities: role.capabilities.filter((capability) => capability !== 'rw'),
		network: role.network,
		description: `Verify ${node.id}`,
		signal: toolCtx.signal,
	});
	if (!outcome.ok) {
		ctx.orchestrator.reject(access, node.id, {
			code: outcome.paused ? 'budget_exhausted' : outcome.stopped ? 'stopped' : 'verification_unavailable',
			reason: outcome.error ?? outcome.report ?? `the ${roleId} verifier failed`,
			...(outcome.budget ? { budget: outcome.budget } : {}),
			...(outcome.paused ? { partial: outcome.report } : {}),
			at: Date.now(),
		});
		return;
	}
	const parsed = parseAgentEnvelope(outcome.report);
	if (!parsed.ok) {
		ctx.orchestrator.reject(access, node.id, { code: 'invalid_output', reason: parsed.reason, at: Date.now() });
		return;
	}
	const envelope = parsed.value;
	const match = mapReportedCriteria(criteria, envelope.acceptance ?? []);
	if (!match.ok) {
		const summary = envelope.summary.trim();
		ctx.orchestrator.reject(access, node.id, {
			code: 'invalid_output',
			reason: `the ${roleId} acceptance does not cover the criteria: ${match.reason}${
				summary ? `; verifier summary: ${summary.slice(0, 300)}` : ''
			}`,
			at: Date.now(),
		});
		return;
	}
	const checks: TaskVerificationCheck[] = match.criteria.map((criterion) => ({
		id: criterion.id,
		met: criterion.met,
		...(criterion.note ? { note: criterion.note } : {}),
		by: roleId,
		...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
		...(envelope.evidence.length ? { evidence: envelope.evidence } : {}),
	}));
	const summary = [envelope.summary, match.positional ? 'acceptance ids were mapped positionally to the task criteria' : '']
		.filter(Boolean)
		.join(' ');
	ctx.orchestrator.recordVerification(access, node.id, checks, summary, outcome.sessionId ?? '');
}

function detailsOf(graph: { nodes: TaskNode[] }, ids: readonly string[]): string {
	const lines = ['Results:'];
	for (const id of ids) {
		const node = graph.nodes.find((candidate) => candidate.id === id);
		if (!node) {
			lines.push(`- ${id}: (not in the task graph)`);
			continue;
		}
		lines.push(
			`- ${id} (${node.role}): ${node.status}${node.rejection ? ` — ${node.rejection.code}: ${node.rejection.reason}` : ''}`,
		);
		if (node.result?.summary) {
			lines.push(`  ${node.result.summary.slice(0, 1000)}`);
		}
		if (node.result?.writes.length) {
			lines.push(`  writes: ${node.result.writes.join(', ')}`);
		}
		if (node.rejection?.budget) {
			const { limits, usage, stopped } = node.rejection.budget;
			const limit = (value: number): string => (value > 0 ? String(value) : '∞');
			lines.push(
				`  budget: ${usage.turns}/${limit(limits.turns)} turns, ${usage.tools}/${limit(limits.tools)} tools, ${usage.tokens}/${limit(limits.tokens)} tokens, ${usage.milliseconds}/${limit(limits.milliseconds)} ms${stopped ? `; stopped by ${stopped}` : ''}`,
			);
		}
		if (node.rejection?.partial) {
			lines.push(`  partial: ${node.rejection.partial.slice(0, 1000)}`);
		}
		if (node.rejection?.writes?.length) {
			lines.push(`  previous writes: ${node.rejection.writes.join(', ')}`);
		}
		if (node.resumes > 0) {
			lines.push(`  resumes: ${node.resumes}/${node.maxResumes}`);
		}
		if (node.verification?.checks.length) {
			lines.push(
				`  verified: ${node.verification.checks.map((check) => `${check.id}:${check.met ? 'pass' : 'fail'}`).join(', ')}`,
			);
		}
		if (node.verification?.summary) {
			lines.push(`  verifier: ${node.verification.summary.replace(/\s+/g, ' ').slice(0, 600)}`);
		}
		if (node.subagentSessionId) {
			lines.push(`  child: ${node.subagentSessionId}`);
		}
		if (node.verificationSessionIds?.length) {
			lines.push(`  verifiers: ${node.verificationSessionIds.join(', ')}`);
		}
	}
	return lines.join('\n');
}
