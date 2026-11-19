// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { BUILTIN_ROLE_BY_ID, BUILTIN_ROLES, effectiveCapabilities } from '../lib/agents';
import { capabilitiesOf } from '../lib/policy';
import { planRules } from '../lib/plan-rules';
import { reconcileTaskGraph } from '../lib/task-graph';
import type { SessionPolicy } from '../lib/types';

const policy = (patch: Partial<SessionPolicy> = {}): SessionPolicy => ({
	workMode: 'sw',
	approval: 'manual',
	approvalResponse: 'ask',
	network: false,
	sandboxMode: 'workspace-write',
	workingDirectory: '/repo',
	commandTimeout: 60,
	commandTimeoutOverride: false,
	denyReadPaths: [],
	model: 'auto',
	...patch,
});

const rules = (patch: Partial<SessionPolicy> = {}, ...tools: string[]) =>
	planRules({ policy: policy(patch), visible: new Set(tools) });

const roles = new Map(BUILTIN_ROLES.map((role) => [role.id, role]));
const coder = effectiveCapabilities(BUILTIN_ROLE_BY_ID.get('coder')!);

suite('Plan rules', () => {
	test('the mode is a hard ceiling for explicit capabilities', () => {
		assert.deepStrictEqual([...capabilitiesOf(policy({ workMode: 'ro', capabilities: ['ro', 'rw'] }))].sort(), ['ro']);
		assert.deepStrictEqual(
			[...capabilitiesOf(policy({ workMode: 'plan', capabilities: ['ro', 'rw', 'shell_test', 'rw_plan'] }))].sort(),
			['ro', 'rw_plan'],
		);
	});

	test('deliverables follow the visible tools', () => {
		assert.strictEqual(rules({ workMode: 'plan' }, 'write_plan').deliverable, 'plan-file');
		assert.strictEqual(rules({ workMode: 'plan' }, 'list_plans').deliverable, 'plan-summary');
		assert.strictEqual(rules({ workMode: 'sw' }, 'write_file', 'delegate', 'run_shell_test').deliverable, 'implementation');
		assert.strictEqual(rules({ workMode: 'ro' }).deliverable, 'research');
	});

	test('Plan mode with explicit rw cannot write, delegate or command', () => {
		const plan = rules(
			{ workMode: 'plan', capabilities: ['ro', 'rw', 'shell_test', 'rw_plan'] },
			'write_file',
			'delegate',
			'run_shell_test',
			'write_plan',
			'list_plans',
		);
		assert.strictEqual(plan.canWrite, false);
		assert.strictEqual(plan.canDelegateWrites, false);
		assert.strictEqual(plan.canCommandCriteria, false);
		assert.match(plan.writeRefusal('code', coder) ?? '', /record the implementation plan with write_plan/);
		assert.match(
			plan.commandRefusal('code', [{ id: 'a1', description: 'runs', check: 'command', command: 'npm test' }]) ?? '',
			/Plan mode has no test shell/,
		);
	});

	test('a hidden writer asks for a summary, never a hidden tool', () => {
		const plan = rules(
			{ workMode: 'plan', capabilities: ['ro', 'ro_plan', 'shell_ro', 'rw_plan'] },
			'delegate',
			'list_plans',
		);
		assert.strictEqual(plan.deliverable, 'plan-summary');
		const message = plan.writeRefusal('code', coder) ?? '';
		assert.match(message, /put the implementation plan in your summary/);
		assert.ok(!message.includes('write_plan'), 'a hidden writer is never named');
	});

	test('a granted rw with the write tools switched off says what to enable', () => {
		const write = rules({ workMode: 'sw', capabilities: ['ro', 'rw', 'shell_ro'] }, 'delegate');
		assert.strictEqual(write.canWrite, false);
		assert.match(write.writeRefusal('code', ['rw']) ?? '', /tracked write tools are switched off/);
	});

	test('accepted nodes are history; new or revised write nodes are refused', () => {
		const graph = reconcileTaskGraph(
			undefined,
			{
				objective: 'ship it',
				nodes: [
					{
						id: 'code',
						title: 'Code',
						role: 'coder',
						objective: 'write it',
						acceptance: [{ id: 'a1', description: 'it is correct', check: 'review' }],
					},
				],
			},
			roles,
			0,
			1,
		);
		assert.ok(graph.ok);
		const plan = rules({ workMode: 'plan', capabilities: ['ro', 'ro_plan', 'shell_ro', 'rw_plan'] }, 'write_plan', 'delegate');
		graph.graph.nodes[0]!.status = 'accepted';
		assert.deepStrictEqual(plan.refuseGraph(graph.graph, roles), [], 'accepted history does not invalidate the graph');
		graph.graph.nodes[0]!.status = 'pending';
		assert.match(plan.refuseGraph(graph.graph, roles)[0] ?? '', /Plan mode delegates only read-only research/);
	});
});
