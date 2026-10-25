// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	afterCheck,
	beginCheck,
	enterStage,
	finishStage,
	looksLikeCodingTask,
	normalizeWorkflowLibrary,
	resolveWorkflow,
	shippedWorkflowLibrary,
	stagePolicy,
	stageMode,
	startRun,
	validateLibrary,
	type CheckReport,
} from '../lib/workflow';
import type { ApprovalRequest, SessionPolicy } from '../lib/types';
import {
	DEFAULT_GRAPH_SOURCE,
	addGraphBlock,
	composeGraphBlocks,
	duplicateGraphBlock,
	parseGraphSource,
	removeGraphBlock,
	setDefaultGraph,
	splitGraphBlocks,
} from '../lib/mermaid';
import { fsTools } from '../tools/fs';
import { createTestKernel } from './harness';

const policy = (patch: Partial<SessionPolicy> = {}): SessionPolicy => ({
	workMode: 'sw',
	approval: 'manual',
	network: false,
	workingDirectory: '/workspace',
	commandTimeout: 60,
	commandTimeoutOverride: false,
	denyReadPaths: [],
	confinement: { read: false, write: true },
	model: 'auto',
	maxSteps: 12,
	...patch,
});

const resolve = (patch: Partial<Parameters<typeof resolveWorkflow>[0]> = {}) =>
	resolveWorkflow({
		library: shippedWorkflowLibrary(),
		override: 'always',
		prompt: 'Add a retry to the uploader',
		trigger: 'normal',
		policy: policy(),
		toolsEnabled: true,
		subagent: false,
		composed: false,
		hasTools: true,
		graphIds: ['agent'],
		...patch,
	});

suite('Graph source blocks', () => {
	test('splits, composes and edits named graphs', () => {
		const parsed = parseGraphSource(DEFAULT_GRAPH_SOURCE);
		assert.strictEqual(parsed.default, 'agent');
		const blocks = splitGraphBlocks(DEFAULT_GRAPH_SOURCE);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0]?.id, 'agent');
		assert.match(blocks[0]?.source ?? '', /%% graph: agent/);

		const added = addGraphBlock(
			DEFAULT_GRAPH_SOURCE,
			'review',
			blocks[0]!.source.replace(/%%\s*graph\s*:\s*\S+/, '%% graph: review'),
		);
		const two = parseGraphSource(added);
		assert.deepStrictEqual(Object.keys(two.graphs).sort(), ['agent', 'review']);
		assert.strictEqual(two.default, 'agent');

		const defaulted = setDefaultGraph(added, 'review');
		assert.strictEqual(parseGraphSource(defaulted).default, 'review');

		const duplicated = duplicateGraphBlock(added, 'agent', 'agent-2');
		assert.ok(parseGraphSource(duplicated).graphs['agent-2']);

		const removed = removeGraphBlock(duplicated, 'agent-2');
		assert.deepStrictEqual(Object.keys(parseGraphSource(removed).graphs).sort(), ['agent', 'review']);
		const withoutDefault = removeGraphBlock(added, 'agent');
		assert.strictEqual(parseGraphSource(withoutDefault).default, 'review');

		const roundTrip = composeGraphBlocks(splitGraphBlocks(added), 'agent');
		assert.deepStrictEqual(Object.keys(parseGraphSource(roundTrip).graphs).sort(), ['agent', 'review']);
	});
});

suite('Workflow domain', () => {
	test('the manifest default matches the shipped preset', () => {
		const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
		};
		assert.deepStrictEqual(
			manifest.contributes.configuration.properties['comonad.workflows']?.default,
			shippedWorkflowLibrary(),
			'a manifest default that drifted from the code would ship a different preset than the tests',
		);
	});

	test('normalizes a partial library over the shipped preset', () => {
		const library = normalizeWorkflowLibrary({ enabled: false });
		assert.strictEqual(library.enabled, false);
		assert.strictEqual(library.default, 'standard');
		assert.strictEqual(library.workflows[0]?.id, 'standard');
		assert.strictEqual(library.workflows[0]?.stages.length, 5);

		const custom = normalizeWorkflowLibrary({
			enabled: false,
			workflows: [
				{
					id: 'quick',
					name: 'Quick fix',
					when: 'manual',
					stages: [
						{ id: 'implement', title: 'Implement', run: 'agent', graph: 'agent' },
						{ id: 'verify', title: 'Verify', run: 'checks', checks: { diagnostics: true } },
					],
				},
			],
		});
		assert.strictEqual(custom.default, 'quick', 'the first auto workflow, else the first workflow, becomes default');
		assert.strictEqual(custom.workflows[0]?.stages[1]?.checks?.timeout, 120);
		assert.deepStrictEqual(validateLibrary(custom, ['agent']).errors, []);
	});

	test('validates graph references and repair targets', () => {
		const library = normalizeWorkflowLibrary({
			default: 'bad',
			workflows: [
				{
					id: 'bad',
					name: 'Bad',
					when: 'manual',
					stages: [
						{ id: 'verify', title: 'Verify', run: 'checks', checks: { repairTo: 'later' } },
						{ id: 'later', title: 'Later', run: 'agent', graph: 'missing' },
					],
				},
			],
		});
		const errors = validateLibrary(library, ['agent']).errors.join('\n');
		assert.match(errors, /needs at least one agent stage|unknown graph|not an earlier agent stage|repairs to/);
	});

	test('only starts a coding task in auto mode', () => {
		assert.strictEqual(looksLikeCodingTask('What does this parser do?'), false);
		assert.strictEqual(looksLikeCodingTask('Can you fix this parser?'), true);
		assert.strictEqual(looksLikeCodingTask('解释一下这个函数'), false);
		assert.strictEqual(looksLikeCodingTask('修复这个解析器'), true);
		const auto = shippedWorkflowLibrary();
		assert.ok(resolve({ library: auto, override: undefined, prompt: 'Add a retry' }));
		assert.strictEqual(resolve({ library: auto, override: undefined, prompt: 'What does this do?' }), undefined);
		assert.strictEqual(resolve({ library: auto, override: 'off' }), undefined);
		assert.ok(resolve({ library: auto, override: 'standard' }), 'a named override runs even when auto would not');
	});

	test('clamps stage modes and approvals to the session', () => {
		assert.strictEqual(stageMode('sw', 'pl'), 'pl', 'plan writes are the one addition');
		assert.strictEqual(stageMode('ro', 'pl'), 'ro');
		assert.strictEqual(stageMode('sw', 'aw'), 'sw');
		assert.strictEqual(stageMode('aw', 'sw'), 'sw');
		assert.strictEqual(stagePolicy(policy(), { id: 'p', title: 'P', run: 'agent', mode: 'pl' }).approval, 'whitelist_accept');
		assert.strictEqual(stagePolicy(policy(), { id: 'i', title: 'I', run: 'agent', mode: 'inherit' }).approval, 'manual');
		assert.strictEqual(stagePolicy(policy({ workMode: 'ro' }), { id: 'p', title: 'P', run: 'agent', mode: 'pl' }).workMode, 'ro');
	});

	test('a failed checks stage rewinds and stops after its repairs', () => {
		const definition = shippedWorkflowLibrary().workflows[0]!;
		let run = startRun(definition, 'Fix it');
		run = finishStage(run, 'plan', 'plan');
		run = { ...run, pendingGate: undefined, status: 'running' };
		run = beginCheck(run, 'verify');
		const failed: CheckReport = {
			passed: false,
			checks: [{ kind: 'command', label: 'npm test', status: 'failed', exitCode: 1, output: 'boom' }],
		};
		run = afterCheck(run, definition.stages.find((stage) => stage.id === 'verify')!, failed);
		assert.strictEqual(run.stages.verify?.status, 'pending', 'the checks stage runs again after the repair');
		assert.strictEqual(run.stages.verify?.check?.passed, false, 'the failed report stays for the repair directive');
		assert.strictEqual(run.stages.implement?.status, 'pending', 'the repair target is pending again');
		assert.strictEqual(run.stages.plan?.status, 'done', 'stages before the target are untouched');
		assert.strictEqual(run.repairs, 1);

		// The driver re-runs the repair target before checking again.
		run = enterStage(run, 'implement');
		run = finishStage(run, 'implement', 'fixed');
		run = beginCheck(run, 'verify');
		run = afterCheck(run, definition.stages.find((stage) => stage.id === 'verify')!, failed);
		assert.strictEqual(run.stages.verify?.status, 'failed');
		assert.strictEqual(run.stages.implement?.status, 'done', 'the second failure is not repaired again');
		assert.strictEqual(run.repairs, 1);
	});

	test('a gate parks only the gated stage', () => {
		const definition = shippedWorkflowLibrary().workflows[0]!;
		let run = startRun(definition, 'Fix it');
		run = finishStage(run, 'plan', 'the plan');
		run.pendingGate = { after: 'plan', title: 'Approve Plan', body: 'the plan' };
		assert.strictEqual(run.status, 'waiting');
	});
});

suite('Workflow runtime', () => {
	test('runs the shipped pipeline through research, plan, implement and review', async () => {
		const kernel = await createTestKernel({ config: { tavernEnabled: false, workflows: shippedWorkflowLibrary() } });
		try {
			const seen: string[] = [];
			kernel.ctx.llm.use({
				name: 'workflow-test',
				async chat(request) {
					const last = request.messages[request.messages.length - 1];
					const text = last?.content ?? '';
					seen.push(text);
					if (text.includes('Stage 1/5: Research')) {
						return { message: { role: 'assistant', content: 'research notes' }, toolCalls: [] };
					}
					if (text.includes('Stage 2/5: Plan')) {
						return { message: { role: 'assistant', content: 'plan body' }, toolCalls: [] };
					}
					if (text.includes('Stage 3/5: Implement')) {
						return { message: { role: 'assistant', content: 'implemented' }, toolCalls: [] };
					}
					return { message: { role: 'assistant', content: 'final report' }, toolCalls: [] };
				},
			});
			const gates: ApprovalRequest[] = [];
			let updates = 0;
			kernel.ctx.on('agent/workflow', () => {
				updates += 1;
			});
			kernel.ctx.on('approval/request', (request, next) => {
				if (request.surface !== 'test') {
					return next();
				}
				if (request.gate) {
					gates.push(request);
					return 'allow';
				}
				return next();
			});

			const result = await kernel.ctx.agent.runTurn({ text: 'Add a retry to the uploader', surface: 'test' });
			const session = kernel.ctx.sessions.require(result.sessionId);
			assert.strictEqual(result.text, 'final report');
			assert.strictEqual(session.workflow?.status, 'done');
			assert.deepStrictEqual(
				Object.fromEntries(Object.entries(session.workflow?.stages ?? {}).map(([id, stage]) => [id, stage.status])),
				{ research: 'done', plan: 'done', implement: 'done', verify: 'skipped', review: 'done' },
			);
			assert.strictEqual(session.workflow?.plan, 'plan body');
			assert.strictEqual(gates.length, 1);
			assert.strictEqual(gates[0]?.gate?.title, 'Approve Plan');
			assert.strictEqual(gates[0]?.gate?.body, 'plan body');
			assert.strictEqual(seen.length, 4);
			assert.match(seen[1] ?? '', /research notes/);
			assert.match(seen[2] ?? '', /plan body/);
			assert.strictEqual(session.policy.workMode, 'sw', 'the base policy is what the chat keeps');
			assert.strictEqual(session.cursor, null);
			assert.ok(updates >= 6, `the stage strip saw the run: ${updates}`);
		} finally {
			await kernel.dispose();
		}
	});

	test('a failing checks stage sends the run back to the repair stage', async () => {
		const library = {
			version: 1,
			enabled: true,
			default: 'fix',
			workflows: [
				{
					id: 'fix',
					name: 'Fix',
					when: 'manual',
					stages: [
						{ id: 'implement', title: 'Implement', run: 'agent', graph: 'agent', mode: 'inherit', objective: 'Write the file.' },
						{
							id: 'verify',
							title: 'Verify',
							run: 'checks',
							checks: { diagnostics: true, commands: [], timeout: 120, repairs: 1, repairTo: 'implement' },
						},
						{ id: 'review', title: 'Review', run: 'agent', graph: 'agent', mode: 'ro', objective: 'Report.' },
					],
				},
			],
		};
		const kernel = await createTestKernel({ config: { tavernEnabled: false, workflows: library } });
		try {
			await kernel.ctx.plugin(fsTools);
			const target = join(kernel.host.workspace(), 'out.txt');
			let calls = 0;
			kernel.ctx.llm.use({
				name: 'repair',
				async chat(request) {
					calls += 1;
					const last = request.messages[request.messages.length - 1];
					const text = last?.content ?? '';
					if (text.includes('Stage 3/3: Review')) {
						return { message: { role: 'assistant', content: 'final report' }, toolCalls: [] };
					}
					if (text.includes('verification failed')) {
						kernel.host.diagnosticsValue = [];
						return { message: { role: 'assistant', content: 'fixed' }, toolCalls: [] };
					}
					if (last?.role === 'tool') {
						kernel.host.diagnosticsValue = [{ file: target, line: 1, column: 1, message: 'broken' }];
						return { message: { role: 'assistant', content: 'wrote' }, toolCalls: [] };
					}
					const call = { id: 'w1', name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'hello' }) };
					return { message: { role: 'assistant', content: '', toolCalls: [call] }, toolCalls: [call] };
				},
			});
			const result = await kernel.ctx.agent.runTurn({ text: 'Create out.txt', surface: 'test', workflow: 'fix' });
			const session = kernel.ctx.sessions.require(result.sessionId);
			assert.strictEqual(result.text, 'final report', JSON.stringify(session.workflow, null, 2));
			assert.strictEqual(session.workflow?.status, 'done');
			assert.strictEqual(session.workflow?.stages.implement?.attempts, 2, 'the repair target ran again');
			assert.strictEqual(session.workflow?.stages.verify?.attempts, 2, 'checks ran again');
			assert.strictEqual(session.workflow?.repairs, 1);
			assert.strictEqual(session.workflow?.stages.verify?.status, 'done');
			assert.strictEqual(session.workflow?.stages.verify?.check?.passed, true);
			assert.strictEqual(calls, 4, 'implement, repair, review (plus the tool round trip)');
		} finally {
			await kernel.dispose();
		}
	});

	test('without the workflow plugin a turn stays direct', async () => {
		const kernel = await createTestKernel({
			skip: ['workflows'],
			config: { tavernEnabled: false, workflows: shippedWorkflowLibrary() },
		});
		try {
			let calls = 0;
			kernel.ctx.llm.use({
				name: 'direct',
				async chat() {
					calls += 1;
					return { message: { role: 'assistant', content: 'direct answer' }, toolCalls: [] };
				},
			});
			const result = await kernel.ctx.agent.runTurn({ text: 'Add a thing', surface: 'test' });
			assert.strictEqual(result.text, 'direct answer');
			assert.strictEqual(calls, 1, 'no stage calls without the plugin');
			assert.strictEqual(kernel.ctx.sessions.require(result.sessionId).workflow, undefined);
		} finally {
			await kernel.dispose();
		}
	});

	test('a denied gate stops after the plan and keeps it', async () => {
		const kernel = await createTestKernel({ config: { tavernEnabled: false, workflows: shippedWorkflowLibrary() } });
		try {
			let calls = 0;
			kernel.ctx.llm.use({
				name: 'workflow-deny',
				async chat(request) {
					const text = request.messages[request.messages.length - 1]?.content ?? '';
					calls += 1;
					return { message: { role: 'assistant', content: text.includes('Plan') ? 'plan body' : 'research notes' }, toolCalls: [] };
				},
			});
			kernel.ctx.on('approval/request', (request, next) => (request.gate && request.surface === 'test' ? 'deny' : next()));
			const result = await kernel.ctx.agent.runTurn({ text: 'Add a retry', surface: 'test' });
			const session = kernel.ctx.sessions.require(result.sessionId);
			assert.strictEqual(result.text, 'plan body');
			assert.strictEqual(calls, 2, 'implementation and review never ran');
			assert.strictEqual(session.workflow?.status, 'stopped');
			assert.strictEqual(session.workflow?.stages.implement?.status, 'pending');
			assert.strictEqual(session.workflow?.plan, 'plan body');
			assert.strictEqual(session.policy.workMode, 'sw');
		} finally {
			await kernel.dispose();
		}
	});
});
