// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'cordis';
import { effectiveCapabilities } from '../lib/agents';
import { buildVerifierPrompt, buildWorkerTaskPrompt } from '../lib/agent-prompts';
import { parseAgentEnvelope } from '../lib/agent-output';
import { capabilitiesOf } from '../lib/policy';
import {
	boardOf,
	formatBoard,
	type TaskGraphAccess,
	type TaskNode,
	type TaskNodeInput,
	type TaskResult,
	type TaskVerificationCheck,
} from '../lib/task-graph';
import { objectSchema, type ToolContext } from '../lib/types';

/** The Orchestrator's task tools and the shared coordination mailbox. */

const FAILED = (error: unknown): string => `Error: ${error instanceof Error ? error.message : String(error)}`;

const acceptanceSchema = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'Slug, unique within the node.' },
		description: { type: 'string', description: 'What must be true; testable by a reviewer.' },
		check: { type: 'string', enum: ['evidence', 'review', 'command'] },
		command: { type: 'string', description: 'Required for a command criterion; the tester runs it exactly.' },
		files: { type: 'array', items: { type: 'string' }, description: 'Context for the verifier.' },
	},
	required: ['id', 'description', 'check'],
	additionalProperties: false,
};

const nodeSchema = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'Slug, unique in the plan.' },
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
			items: { type: 'string', enum: ['ro', 'ro_plan', 'rw', 'shell_ro', 'shell_test'] },
			description: 'Further narrow the role capabilities; never widen them.',
		},
		network: { type: 'boolean', description: 'false narrows network off; true only when the role allows it.' },
		dependsOn: { type: 'array', items: { type: 'string' } },
		acceptance: { type: 'array', minItems: 1, maxItems: 8, items: acceptanceSchema },
		maxAttempts: { type: 'integer', minimum: 1, maximum: 3 },
		budget: { type: 'integer', minimum: 1, maximum: 64, description: 'Maximum model steps for this task.' },
	},
	required: ['id', 'title', 'role', 'objective', 'acceptance'],
	additionalProperties: false,
};

export function orchestrateTools(ctx: Context): void {
	ctx.tools.register({
		name: 'task_plan',
		description:
			'Record or revise the Orchestrator task DAG. Send the complete desired node set on every revision. A task whose effective capabilities include rw needs at least one review or command criterion. Dependencies must be acyclic; only pending, ready nodes can be delegated. The runtime derives a fixed independent reviewer/tester for review/command criteria, so you cannot mark a task accepted yourself.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		serial: true,
		parameters: objectSchema(
			{
				objective: { type: 'string', description: 'The user goal this plan serves.' },
				nodes: { type: 'array', minItems: 1, maxItems: 32, items: nodeSchema },
			},
			['objective', 'nodes'],
		),
		async execute(args, toolCtx) {
			const access = toolCtx.taskGraph;
			if (!access) {
				return 'Error: task planning is only available to the Orchestrator';
			}
			const input = args as { objective: string; nodes: TaskNodeInput[] };
			try {
				const result = await ctx.orchestrator.run(access, async () =>
					ctx.orchestrator.plan(access, { objective: input.objective, nodes: input.nodes }),
				);
				const warnings = result.warnings.length
					? `\n\nWarnings:\n${result.warnings.map((warning) => `- ${warning}`).join('\n')}`
					: '';
				return `${formatBoard(boardOf(result.graph))}${warnings}`;
			} catch (error) {
				return FAILED(error);
			}
		},
	});

	ctx.tools.register({
		name: 'delegate',
		description:
			'Run 1..8 ready tasks from the current plan in parallel. All selected tasks must be pending and ready; a batch may not contain dependencies within itself. Read and write tasks may run together; the runtime serialises writes to the same file and parallel workers can coordinate through the message tool. After the workers finish, the runtime derives fixed independent reviewer/tester children for review/command criteria. You cannot mark a task accepted; read the board and verdicts, then replan rejected work within its attempt budget.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		serial: true,
		parameters: objectSchema(
			{
				tasks: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' }, description: 'Task ids from the current plan.' },
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
						return 'Error: no task plan exists; call task_plan first';
					}
					const roles = ctx.orchestrator.roles();
					const parentCaps = new Set(capabilitiesOf(toolCtx.policy));
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
						if (caps.includes('rw') && !parentCaps.has('rw')) {
							return `Error: ${id} writes, but this session has no rw capability; switch to Semi-Write/Full Access or do the write in the main thread`;
						}
						const network = node.network ?? role.network;
						if (network && !toolCtx.policy.network) {
							return `Error: ${id} needs network, but the session has network off`;
						}
						if (node.acceptance.some((criterion) => criterion.check === 'command') && !parentCaps.has('shell_test')) {
							return `Error: ${id} needs command verification, but this session has no shell_test capability`;
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
								maxTurns: node.budget,
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
			'Read the current task board, ready nodes, rejection reasons, child/verifier session ids and recent coordination messages. Use it before delivering and after a rejection before replanning.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema({
			tasks: { type: 'array', items: { type: 'string' }, description: 'Only show these task ids; omit for the whole plan.' },
		}),
		async execute(args, toolCtx) {
			const access = toolCtx.taskGraph;
			if (!access) {
				return 'Error: task status is only available to the Orchestrator';
			}
			const graph = access.get();
			if (!graph) {
				return 'No task plan exists for this chat.';
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
			code: outcome.stopped ? 'stopped' : 'verification_unavailable',
			reason: outcome.error ?? outcome.report ?? `the ${roleId} verifier failed`,
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
	const checks: TaskVerificationCheck[] = (envelope.acceptance ?? [])
		.filter((criterion) => criteria.some((expected) => expected.id === criterion.id))
		.map((criterion) => ({
			id: criterion.id,
			met: criterion.met,
			...(criterion.note ? { note: criterion.note } : {}),
			by: roleId,
			...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
			...(envelope.evidence.length ? { evidence: envelope.evidence } : {}),
		}));
	ctx.orchestrator.recordVerification(access, node.id, checks, envelope.summary, outcome.sessionId ?? '');
}

function detailsOf(graph: { nodes: TaskNode[] }, ids: readonly string[]): string {
	const lines = ['Results:'];
	for (const id of ids) {
		const node = graph.nodes.find((candidate) => candidate.id === id);
		if (!node) {
			lines.push(`- ${id}: (not in the plan)`);
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
		if (node.verification?.checks.length) {
			lines.push(
				`  verified: ${node.verification.checks.map((check) => `${check.id}:${check.met ? 'pass' : 'fail'}`).join(', ')}`,
			);
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
