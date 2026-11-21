// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import {
	buildOrchestratorBody,
	buildSubagentSystemPrompt,
	buildVerifierPrompt,
	buildWorkerTaskPrompt,
} from '../lib/agent-prompts';
import { planRules } from '../lib/plan-rules';
import type { Capability } from '../lib/types';
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
			assert.ok(!('workMode' in role), `${role.id} carries only capabilities, no mode label`);
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

	test('the role index is one line per role with its capabilities, network and budget', () => {
		const lines = agentLines(BUILTIN_ROLES);
		assert.strictEqual(lines.split('\n').length, 14);
		assert.match(lines, /- researcher \[ro, network; 10 turns, 40 tools\]:/);
		assert.match(lines, /- coder \[ro, rw, shell_ro, shell_test; 16 turns, 60 tools\]:/);
	});
});

suite('Orchestrator prompt', () => {
	interface BodyPatch {
		planMode?: boolean;
		canWrite?: boolean;
		createPlan?: boolean;
		editPlan?: boolean;
		canCommand?: boolean;
	}

	const body = (patch: BodyPatch = {}) => {
		const planMode = patch.planMode ?? false;
		const canWrite = patch.canWrite ?? true;
		const canCommand = patch.canCommand ?? canWrite;
		const createPlan = patch.createPlan ?? planMode;
		const editPlan = patch.editPlan ?? planMode;
		const capabilities: Capability[] = planMode
			? ['ro', 'shell_ro', 'ro_plan', ...(createPlan || editPlan ? (['rw_plan'] as Capability[]) : [])]
			: canWrite
				? ['ro', 'rw', 'shell_ro', ...(canCommand ? (['shell_test'] as Capability[]) : [])]
				: ['ro', 'shell_ro'];
		const visible = new Set<string>();
		if (planMode) {
			visible.add('delegate');
			visible.add('list_plans');
			visible.add('read_plan');
		}
		if (canWrite) {
			visible.add('write_file');
			visible.add('edit_text');
			visible.add('delegate');
		}
		if (canCommand) {
			visible.add('run_shell_test');
		}
		if (createPlan) {
			visible.add('write_plan');
		}
		if (editPlan) {
			visible.add('edit_plan');
		}
		return buildOrchestratorBody({
			roles: BUILTIN_ROLES,
			rules: planRules({ policy: { workMode: planMode ? 'plan' : canWrite ? 'sw' : 'ro', capabilities }, visible }),
		});
	};

	test('Plan mode delegates read-only research and stops after a plan write or edit', () => {
		const text = body({ planMode: true, canWrite: false });
		assert.match(text, /This is Plan mode: the session is read-only/);
		assert.match(text, /delegate only read-only research nodes/);
		assert.match(text, /Record the implementation plan yourself with write_plan, or revise a recorded plan with edit_plan/);
		assert.match(text, /After write_plan or edit_plan, stop and summarize/);
		assert.ok(!text.includes('Independent tasks, including independent write tasks'), 'the write protocol is replaced');
		assert.ok(!text.includes('needs at least one review or command criterion'), 'write-task criteria do not apply');
	});

	test('Plan mode with only write_plan names only the creator', () => {
		const text = body({ planMode: true, canWrite: false, editPlan: false });
		assert.match(text, /Record the implementation plan yourself with write_plan/);
		assert.match(text, /After write_plan, stop and summarize/);
		assert.ok(!text.includes('edit_plan'), 'a hidden editor is never named');
	});

	test('Plan mode with only edit_plan revises an existing plan', () => {
		const text = body({ planMode: true, canWrite: false, createPlan: false });
		assert.match(text, /Revise the recorded plan yourself with edit_plan/);
		assert.match(text, /edit_plan edits only an existing plan/);
		assert.match(text, /After edit_plan, stop and summarize/);
		assert.ok(!text.includes('write_plan'), 'a hidden creator is never named');
	});

	test('Plan mode without a plan writer delivers the plan in the summary', () => {
		const text = body({ planMode: true, canWrite: false, createPlan: false, editPlan: false });
		assert.match(text, /put the implementation plan in your final summary/);
		assert.ok(!text.includes('Record the implementation plan yourself'));
		assert.ok(!text.includes('edit_plan'));
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
		assert.match(text, /needs at least one review or command criterion/);
	});

	test('the planner role is read-only and admissible in Plan mode', () => {
		const planner = BUILTIN_ROLE_BY_ID.get('planner')!;
		assert.deepStrictEqual(planner.capabilities, ['ro', 'ro_plan', 'shell_ro']);
		assert.ok(!planner.capabilities.includes('rw'));
		assert.ok(!planner.capabilities.includes('shell_test'));
	});

	test('the budget and resume protocol refuses shrinking segments and copied role defaults', () => {
		const text = body();
		assert.match(text, /A task budget is only an upper bound: omit it for substantive work/);
		assert.match(text, /Never pass a smaller segment budget than the previous segment/);
		assert.match(text, /Available roles \(the numbers in brackets are the role's default budget/);
	});

	test('command criteria are described as scratch-only only when the session can run them', () => {
		assert.match(body({ canCommand: true }), /A command criterion runs in a read-only workspace/);
		assert.ok(!body({ canCommand: false }).includes('A command criterion runs in a read-only workspace'));
	});
});

suite('Subagent contracts', () => {
	const role = BUILTIN_ROLE_BY_ID.get('coder')!;
	const subagent = (contract: 'worker' | 'verifier') =>
		buildSubagentSystemPrompt({
			role,
			contract,
			network: false,
			sandbox: 'workspace-write',
			capabilities: ['ro', 'rw'],
		});

	test('the contracts no longer teach invented acceptance ids', () => {
		for (const contract of ['worker', 'verifier'] as const) {
			const text = subagent(contract);
			assert.ok(!text.includes('"id":"a1"'), `${contract} must not show a1`);
			assert.match(text, /Use the exact acceptance ids/);
			assert.match(text, /never invent ids such as a1/);
		}
		const verifier = subagent('verifier');
		assert.match(verifier, /ignore any acceptance ids quoted in the worker report/);
		assert.match(verifier, /run_shell_test/);
		assert.match(verifier, /mirror: <path>/);
		assert.match(verifier, /Never report exit code 0 for a command that failed/);
	});

	test('the task prompts restate the real acceptance ids', () => {
		const acceptance = [
			{ id: 'check', description: 'typecheck passes', check: 'command' as const, command: 'npx tsc --noEmit' },
			{ id: 'build', description: 'artifacts exist', check: 'command' as const, command: 'test -f dist/index.js' },
		];
		const rule = /Use these exact acceptance ids, one entry per criterion: check, build\./;
		const worker = buildWorkerTaskPrompt({ taskId: 'code', title: 'Code', objective: 'x', acceptance });
		assert.match(worker, rule);
		const verifier = buildVerifierPrompt({
			taskId: 'code',
			title: 'Code',
			role: 'coder',
			objective: 'x',
			acceptance,
			workerReport: 'ok',
			workerWrites: [],
		});
		assert.match(verifier, rule);
	});
});
