// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { BUILTIN_ROLES } from '../lib/agents';
import {
	boardOf,
	checkTaskPlan,
	formatBoard,
	readyNodes,
	reconcileTaskGraph,
	sanitizeTaskGraph,
	satisfiesAcceptance,
	type AcceptanceCriterion,
	type TaskGraph,
	type TaskNode,
	type TaskNodeInput,
	type TaskPlanInput,
} from '../lib/task-graph';

const roles = new Map(BUILTIN_ROLES.map((role) => [role.id, role]));

const evidence = (id = 'a1'): AcceptanceCriterion => ({ id, description: 'the fact is present', check: 'evidence' });
const review = (id = 'a1'): AcceptanceCriterion => ({ id, description: 'the change is correct', check: 'review' });
const command = (id = 'a1', program = 'true'): AcceptanceCriterion => ({
	id,
	description: 'the command succeeds',
	check: 'command',
	command: program,
});

const node = (patch: Partial<TaskNodeInput> = {}): TaskNodeInput => ({
	id: 'code',
	title: 'Code the change',
	role: 'coder',
	objective: 'write the file',
	acceptance: [review()],
	...patch,
});

const plan = (...nodes: TaskNodeInput[]): TaskPlanInput => ({ objective: 'ship it', nodes });

function graphOf(...nodes: TaskNodeInput[]): TaskGraph {
	const result = reconcileTaskGraph(undefined, plan(...(nodes.length ? nodes : [node()])), roles, 1, 1);
	assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
	return result.graph;
}

function accept(node: TaskNode): TaskNode {
	node.status = 'accepted';
	node.result = {
		status: 'ok',
		summary: 'done',
		evidence: [{ kind: 'note', text: 'checked' }],
		criteria: node.acceptance.filter((criterion) => criterion.check === 'evidence').map((criterion) => ({ id: criterion.id, met: true })),
		writes: [],
		at: 1,
	};
	const checks = node.acceptance
		.filter((criterion) => criterion.check !== 'evidence')
		.map((criterion) => {
			const evidenceList =
				criterion.check === 'command'
					? [{ kind: 'command' as const, command: criterion.command!, exitCode: 0 }]
					: undefined;
			return { id: criterion.id, met: true, by: criterion.check === 'command' ? ('tester' as const) : ('reviewer' as const), ...(evidenceList ? { evidence: evidenceList } : {}) };
		});
	if (checks.length) {
		node.verification = { summary: 'verified', checks, at: 2 };
	}
	return node;
}

suite('Task graph validation', () => {
	test('a valid read plan and a write plan with independent verification pass', () => {
		const read = checkTaskPlan(plan(node({ id: 'find', role: 'explorer', acceptance: [evidence()] })), roles);
		assert.deepStrictEqual(read.errors, []);
		const write = checkTaskPlan(plan(node()), roles);
		assert.deepStrictEqual(write.errors, []);
	});

	test('unknown roles, duplicate ids, self-dependencies and cycles are refused', () => {
		assert.ok(checkTaskPlan(plan(node({ role: 'nope' })), roles).errors.some((error) => /unknown role/.test(error)));
		assert.ok(checkTaskPlan(plan(node(), node()), roles).errors.some((error) => /duplicate node id/.test(error)));
		assert.ok(checkTaskPlan(plan(node({ dependsOn: ['code'] })), roles).errors.some((error) => /depend on itself/.test(error)));
		const cycle = checkTaskPlan(
			plan(node({ id: 'a', dependsOn: ['b'] }), node({ id: 'b', dependsOn: ['a'] })),
			roles,
		);
		assert.ok(cycle.errors.some((error) => /dependency cycle/.test(error)));
		assert.ok(checkTaskPlan(plan(node({ dependsOn: ['missing'] })), roles).errors.some((error) => /unknown dependency/.test(error)));
	});

	test('a write task needs a review or command criterion', () => {
		const errors = checkTaskPlan(plan(node({ acceptance: [evidence()] })), roles).errors;
		assert.ok(errors.some((error) => /write task needs at least one review or command/.test(error)));
	});

	test('a command criterion needs a command, and capabilities cannot widen the role', () => {
		assert.ok(
			checkTaskPlan(plan(node({ acceptance: [{ id: 'a1', description: 'runs', check: 'command' }] })), roles).errors.some((error) =>
				/command is required/.test(error),
			),
		);
		assert.ok(
			checkTaskPlan(plan(node({ capabilities: ['shell_rw'] })), roles).errors.some((error) => /subset of the role/.test(error)),
		);
		assert.ok(checkTaskPlan(plan(node({ network: true })), roles).errors.some((error) => /does not allow network/.test(error)));
	});

	test('bounds, bad paths and attempt/budget ranges are refused', () => {
		assert.ok(checkTaskPlan(plan(node({ maxAttempts: 0 })), roles).errors.some((error) => /maxAttempts/.test(error)));
		assert.ok(checkTaskPlan(plan(node({ budget: 0 })), roles).errors.some((error) => /budget/.test(error)));
		assert.ok(checkTaskPlan(plan(node({ writes: ['../escape'] })), roles).errors.some((error) => /workspace-relative/.test(error)));
		assert.ok(checkTaskPlan(plan(node({ acceptance: [] })), roles).errors.some((error) => /acceptance criteria/.test(error)));
	});

	test('independent write nodes with overlapping paths warn, dependent ones do not', () => {
		const overlapping = checkTaskPlan(plan(node({ id: 'a', writes: ['src/x.ts'] }), node({ id: 'b', writes: ['src'] })), roles);
		assert.ok(overlapping.warnings.some((warning) => /overlapping write paths/.test(warning)));
		const ordered = checkTaskPlan(plan(node({ id: 'a', writes: ['src/a.ts'] }), node({ id: 'b', writes: ['src/b.ts'], dependsOn: ['a'] })), roles);
		assert.deepStrictEqual(ordered.warnings, []);
	});
});

suite('Task graph reconciliation', () => {
	test('the first plan is pending and the next version preserves accepted nodes', () => {
		const first = graphOf();
		assert.strictEqual(first.version, 1);
		assert.strictEqual(first.replans, 0);
		assert.strictEqual(first.nodes[0]!.status, 'pending');
		assert.strictEqual(first.nodes[0]!.risk, 'write');

		const done = { ...first, nodes: [accept({ ...first.nodes[0]! })] };
		const second = reconcileTaskGraph(done, plan(node()), roles, 2, 2);
		assert.ok(second.ok, second.ok ? '' : second.errors.join('\n'));
		assert.strictEqual(second.graph.version, 2);
		assert.strictEqual(second.graph.nodes[0]!.status, 'accepted');
		assert.strictEqual(second.graph.nodes[0]!.result?.summary, 'done');
	});

	test('an accepted task cannot be redefined, while a rejected one resets and keeps its attempts', () => {
		const first = graphOf();
		const done = { ...first, nodes: [accept({ ...first.nodes[0]! })] };
		const changed = reconcileTaskGraph(done, plan(node({ title: 'Other' })), roles, 2, 2);
		assert.ok(!changed.ok);
		assert.ok(changed.errors.some((error) => /accepted task cannot be redefined/.test(error)));

		const rejected: TaskGraph = {
			...first,
			nodes: [{ ...first.nodes[0]!, status: 'rejected', attempts: 1, rejection: { code: 'verification_failed', reason: 'no', at: 1 } }],
		};
		const reset = reconcileTaskGraph(rejected, plan(node({ objective: 'try again' })), roles, 2, 2);
		assert.ok(reset.ok, reset.ok ? '' : reset.errors.join('\n'));
		assert.strictEqual(reset.graph.nodes[0]!.status, 'pending');
		assert.strictEqual(reset.graph.nodes[0]!.attempts, 1);
		assert.strictEqual(reset.graph.nodes[0]!.rejection, undefined);
	});

	test('running tasks and the replan cap stop a revision', () => {
		const first = graphOf();
		const running = { ...first, nodes: [{ ...first.nodes[0]!, status: 'running' as const }] };
		const refused = reconcileTaskGraph(running, plan(node()), roles, 2, 2);
		assert.ok(!refused.ok);
		assert.ok(refused.errors.some((error) => /running or being verified/.test(error)));

		const capped = { ...first, replans: 6 };
		const limited = reconcileTaskGraph(capped, plan(node()), roles, 2, 2);
		assert.ok(!limited.ok);
		assert.ok(limited.errors.some((error) => /replan limit/.test(error)));
	});

	test('ready nodes wait for every dependency to be accepted', () => {
		const graph = graphOf(
			node({ id: 'a', acceptance: [evidence()], role: 'explorer', writes: undefined }),
			node({ id: 'b', dependsOn: ['a'] }),
		);
		assert.deepStrictEqual(readyNodes(graph).map((entry) => entry.id), ['a']);
		graph.nodes[0]!.status = 'accepted';
		assert.deepStrictEqual(readyNodes(graph).map((entry) => entry.id), ['b']);
	});
});

suite('Task acceptance', () => {
	test('a read task is accepted from a structured envelope with evidence', () => {
		const graph = graphOf(node({ id: 'find', role: 'explorer', acceptance: [evidence()] }));
		const read = graph.nodes[0]!;
		read.status = 'accepted';
		read.result = { status: 'ok', summary: 'found', evidence: [{ kind: 'note', text: 'x' }], criteria: [{ id: 'a1', met: true }], writes: [], at: 1 };
		assert.strictEqual(satisfiesAcceptance(read).accepted, true);
		read.result.criteria = [];
		assert.ok(!satisfiesAcceptance(read).accepted, 'a missing criterion result is refused');
		read.result = undefined;
		assert.ok(!satisfiesAcceptance(read).accepted);
	});

	test('a write task is never accepted without an independent verification record', () => {
		const nodeValue = graphOf().nodes[0]!;
		nodeValue.result = { status: 'ok', summary: 'x', evidence: [{ kind: 'note', text: 'x' }], criteria: [{ id: 'a1', met: true }], writes: ['x'], at: 1 };
		assert.ok(!satisfiesAcceptance(nodeValue).accepted);
		nodeValue.verification = { summary: 'ok', checks: [{ id: 'a1', met: true, by: 'reviewer' }], at: 2 };
		assert.strictEqual(satisfiesAcceptance(nodeValue).accepted, true);
		nodeValue.verification.checks[0]!.met = false;
		assert.ok(!satisfiesAcceptance(nodeValue).accepted);
	});

	test('command acceptance needs a matching successful command evidence', () => {
		const nodeValue = graphOf(node({ acceptance: [command('a1', 'true')] })).nodes[0]!;
		nodeValue.result = { status: 'ok', summary: 'x', evidence: [{ kind: 'note', text: 'x' }], criteria: [], writes: [], at: 1 };
		nodeValue.verification = {
			summary: 'ok',
			checks: [{ id: 'a1', met: true, by: 'tester', evidence: [{ kind: 'command', command: 'true', exitCode: 0 }] }],
			at: 2,
		};
		assert.strictEqual(satisfiesAcceptance(nodeValue).accepted, true);
		nodeValue.verification.checks[0]!.evidence = [{ kind: 'command', command: 'true', exitCode: 1 }];
		assert.ok(!satisfiesAcceptance(nodeValue).accepted, 'a failed command is not accepted');
		nodeValue.verification.checks[0]!.evidence = [{ kind: 'command', command: 'false', exitCode: 0 }];
		assert.ok(!satisfiesAcceptance(nodeValue).accepted, 'a different command is not accepted');
	});
});

suite('Task graph persistence helpers', () => {
	test('a sanitized graph round-trips and keeps its statuses', () => {
		const graph = graphOf(node());
		graph.nodes[0]!.status = 'running';
		const copy = sanitizeTaskGraph(JSON.parse(JSON.stringify(graph)));
		assert.ok(copy);
		assert.strictEqual(copy.nodes[0]!.status, 'running');
		assert.strictEqual(copy.nodes[0]!.risk, 'write');
		assert.strictEqual(copy.objective, graph.objective);
	});

	test('malformed stored graphs are dropped rather than half-trusted', () => {
		assert.strictEqual(sanitizeTaskGraph(undefined), undefined);
		assert.strictEqual(sanitizeTaskGraph({ objective: 'x', nodes: 'no' }), undefined);
		assert.strictEqual(sanitizeTaskGraph({ objective: 'x', nodes: [{ id: 'a' }] }), undefined);
		const graph = graphOf(node());
		const altered = JSON.parse(JSON.stringify(graph));
		altered.nodes[0].dependsOn = ['missing'];
		assert.strictEqual(sanitizeTaskGraph(altered), undefined);
	});

	test('the board exposes counts, ready nodes and rejection reasons', () => {
		const graph = graphOf(node());
		graph.nodes[0]!.status = 'rejected';
		graph.nodes[0]!.rejection = { code: 'verification_failed', reason: 'no', at: 3 };
		const board = boardOf(graph);
		assert.strictEqual(board.counts.rejected, 1);
		assert.deepStrictEqual(board.ready, []);
		const text = formatBoard(board);
		assert.match(text, /Goal: ship it/);
		assert.match(text, /0\/1 accepted/);
		assert.match(text, /verification_failed: no/);
	});
});
