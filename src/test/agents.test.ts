// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { buildOrchestratorBody } from '../lib/agent-prompts';
import {
	agentLines,
	allowedToolsFor,
	BUILTIN_ROLES,
	BUILTIN_ROLE_BY_ID,
	effectiveCapabilities,
	SUBAGENT_EXCLUDED_TOOLS,
} from '../lib/agents';
import { SUBAGENT_CAPABILITIES } from '../lib/subagent';

const IDS = [
	'general-purpose',
	'researcher',
	'math-researcher',
	'explorer',
	'planner',
	'coder',
	'tester',
	'reviewer',
	'debugger',
	'security-auditor',
	'data-analyst',
	'scientist',
	'technical-writer',
	'architect',
];

suite('Agent roles', () => {
	test('the shipped roles are exactly the fourteen specified ids', () => {
		assert.strictEqual(BUILTIN_ROLES.length, 14);
		assert.deepStrictEqual(
			BUILTIN_ROLES.map((role) => role.id).sort(),
			[...IDS].sort(),
		);
		assert.strictEqual(new Set(BUILTIN_ROLES.map((role) => role.id)).size, 14);
		assert.strictEqual(BUILTIN_ROLE_BY_ID.size, 14);
	});

	test('every role stays inside the subagent hard cap and never lists a forbidden tool', () => {
		for (const role of BUILTIN_ROLES) {
			assert.ok(role.builtin, `${role.id} is builtin`);
			assert.ok(role.capabilities.length > 0, `${role.id} has capabilities`);
			for (const capability of role.capabilities) {
				assert.ok(SUBAGENT_CAPABILITIES.includes(capability), `${role.id} capability ${capability}`);
			}
			assert.ok(role.tools && role.tools.length > 0, `${role.id} lists tools`);
			for (const forbidden of SUBAGENT_EXCLUDED_TOOLS) {
				assert.ok(!role.tools!.includes(forbidden), `${role.id} must not offer ${forbidden}`);
			}
			assert.strictEqual(role.risk, role.capabilities.includes('rw') ? 'write' : 'read');
		}
	});

	test('only the researcher turns network on, and only write roles grant files', () => {
		assert.deepStrictEqual(
			BUILTIN_ROLES.filter((role) => role.network).map((role) => role.id),
			['researcher'],
		);
		for (const role of BUILTIN_ROLES) {
			if (role.grant.files) {
				assert.ok(role.capabilities.includes('rw'), `${role.id} grants files without rw`);
			}
			if (role.grant.test) {
				assert.ok(role.capabilities.includes('shell_test'), `${role.id} grants test without shell_test`);
			}
		}
	});

	test('the task-level capability filter only narrows the role', () => {
		const coder = BUILTIN_ROLE_BY_ID.get('coder')!;
		assert.deepStrictEqual(effectiveCapabilities(coder, ['ro', 'rw']), ['ro', 'rw']);
		assert.deepStrictEqual(effectiveCapabilities(coder, ['ro', 'shell_rw']), ['ro']);
		assert.deepStrictEqual(effectiveCapabilities(coder), coder.capabilities);
	});

	test('allowedToolsFor selects the role list or filters disallowed tools', () => {
		const coder = BUILTIN_ROLE_BY_ID.get('coder')!;
		const available = ['read_file', 'write_file', 'run_shell', 'delegate'];
		assert.deepStrictEqual(allowedToolsFor(coder, available), ['read_file', 'write_file']);
		assert.deepStrictEqual(allowedToolsFor({ disallowed: ['run_shell'] }, available), ['read_file', 'write_file', 'delegate']);
		assert.deepStrictEqual(allowedToolsFor({}, available), available);
	});

	test('the role index is one line per role with its mode, network and budget', () => {
		const lines = agentLines(BUILTIN_ROLES);
		assert.strictEqual(lines.split('\n').length, 14);
		assert.match(lines, /- researcher \[ro, network; 10 turns, 40 tools\]:/);
		assert.match(lines, /- coder \[sw; 16 turns, 60 tools\]:/);
	});
});

suite('Orchestrator prompt', () => {
	const body = (patch: Partial<Parameters<typeof buildOrchestratorBody>[0]> = {}) =>
		buildOrchestratorBody({
			roles: BUILTIN_ROLES,
			canWrite: true,
			planMode: false,
			writePlanVisible: true,
			...patch,
		});

	test('Plan mode delegates read-only research and stops after write_plan', () => {
		const text = body({ planMode: true, canWrite: false });
		assert.match(text, /This is Plan mode: the session is read-only/);
		assert.match(text, /delegate only read-only research nodes/);
		assert.match(text, /Record the implementation plan yourself with write_plan/);
		assert.match(text, /After write_plan, stop and summarize/);
		assert.ok(!text.includes('Independent tasks, including independent write tasks'), 'the write protocol is replaced');
		assert.ok(!text.includes('must have at least one review or command criterion'), 'write-task criteria do not apply');
	});

	test('Plan mode without a plan writer delivers the plan in the summary', () => {
		const text = body({ planMode: true, canWrite: false, writePlanVisible: false });
		assert.match(text, /put the implementation plan in your final summary/);
		assert.ok(!text.includes('Record the implementation plan yourself with write_plan'));
	});

	test('a read-only session keeps the full protocol and adds the read-only rule', () => {
		const text = body({ canWrite: false });
		assert.match(text, /This session is read-only: delegate only read-only tasks/);
		assert.match(text, /Independent tasks, including independent write tasks/, 'the full protocol is kept');
		assert.ok(!text.includes('This is Plan mode'));
	});

	test('a write-capable session keeps the full protocol unchanged', () => {
		const text = body();
		assert.ok(!text.includes('This session is read-only'));
		assert.ok(!text.includes('This is Plan mode'));
		assert.match(text, /Delegate only ready nodes/);
		assert.match(text, /must have at least one review or command criterion/);
	});

	test('the planner role is read-only and admissible in Plan mode', () => {
		const planner = BUILTIN_ROLE_BY_ID.get('planner')!;
		assert.deepStrictEqual(planner.capabilities, ['ro', 'ro_plan', 'shell_ro']);
		assert.ok(!planner.capabilities.includes('rw'));
		assert.ok(!planner.capabilities.includes('shell_test'));
	});
});
