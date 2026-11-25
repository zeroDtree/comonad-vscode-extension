// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestKernel } from './harness';
import { BUILTIN_ROLES } from '../lib/agents';
import { COMONAD_BLOCK } from '../lib/blocks';
import { clampResumeBudget } from '../lib/budget';
import { reconcileTaskGraph, taskChildrenOf, type TaskBoard } from '../lib/task-graph';
import { fsTools } from '../tools/fs';
import { messageTools } from '../tools/message';
import { orchestrateTools } from '../tools/orchestrate';
import { planTools } from '../tools/plan';
import { shellTools } from '../tools/shell';
import type { Message, ToolCall } from '../lib/types';

const reply = (content: string, toolCalls: ToolCall[] = []) => ({
	message: { role: 'assistant' as const, content, toolCalls },
	toolCalls,
	usage: { input: 1, output: 1 },
});

const graphCall = (tasks: unknown[]): ToolCall => ({
	id: 'plan-1',
	name: 'task_graph',
	arguments: JSON.stringify({ objective: 'ship the change', nodes: tasks }),
});

const delegateCall = (ids: string[]): ToolCall => ({
	id: 'delegate',
	name: 'delegate',
	arguments: JSON.stringify({ tasks: ids }),
});

const resumeCall = (ids: string[], budget: unknown): ToolCall => ({
	id: 'resume',
	name: 'resume',
	arguments: JSON.stringify({ tasks: ids, budget }),
});

function rootStep(request: { messages: Array<{ role: string; toolCalls?: ToolCall[] }> }): ToolCall['name'] | undefined {
	const calls = request.messages.filter((message) => message.role === 'assistant').flatMap((message) => message.toolCalls ?? []);
	return calls[calls.length - 1]?.name;
}

suite('Orchestrator task loop', () => {
	test('a write task plans, delegates, verifies through the pinned reviewer, and accepts', async () => {
		const kernel = await createTestKernel({ config: { checkpoints: true } });
		try {
			const workspace = kernel.host.workspace();
			let coderOffered: string[] = [];
			let coderApproval: string | undefined;
			kernel.ctx.llm.use({
				name: 'orchestrator',
				async chat(request) {
					const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
					if (system.includes('You are the coder subagent of Comonad')) {
						coderOffered = (request.tools ?? []).map((tool) => tool.name);
						const last = request.messages[request.messages.length - 1];
						if (last?.role !== 'tool') {
							return reply('', [{ id: 'write-1', name: 'write_file', arguments: JSON.stringify({ path: 'made.txt', content: 'made\n' }) }]);
						}
						return reply(
							JSON.stringify({
								status: 'ok',
								summary: 'wrote made.txt',
								evidence: [{ kind: 'file', path: 'made.txt' }],
								acceptance: [{ id: 'a1', met: true }],
							}),
						);
					}
					if (system.includes('You are the reviewer subagent of Comonad')) {
						return reply(
							JSON.stringify({
								verdict: 'pass',
								summary: 'made.txt exists and matches the criterion',
								evidence: [{ kind: 'file', path: 'made.txt' }],
								acceptance: [{ id: 'a1', met: true }],
							}),
						);
					}
					const last = rootStep(request);
					if (!last) {
						return reply('', [
							graphCall([
								{
									id: 'code',
									title: 'Write made.txt',
									role: 'coder',
									objective: 'Create made.txt containing made.',
									writes: ['made.txt'],
									acceptance: [{ id: 'a1', description: 'made.txt contains made', check: 'review', files: ['made.txt'] }],
								},
							]),
						]);
					}
					if (last === 'task_graph') {
						return reply('', [delegateCall(['code'])]);
					}
					return reply('done');
				},
			});
			await kernel.ctx.plugin(fsTools);
			await kernel.ctx.plugin(orchestrateTools);
			const starts: Array<{ callId?: string; id: string; name: string }> = [];
			kernel.ctx.on('agent/subagent-start', (_ref, info) => starts.push(info));
			const estimates: string[] = [];
			kernel.ctx.on('agent/estimate', (ref) => estimates.push(ref.sessionId));

			await kernel.ctx.agent.runTurn({ text: 'make made.txt', surface: 'test' });

			assert.strictEqual(readFileSync(join(workspace, 'made.txt'), 'utf8'), 'made\n');
			const parent = kernel.ctx.sessions.active()!;
			assert.deepStrictEqual(estimates, [parent.id], 'a child request never paints the parent status line');
			const graph = parent.taskGraph!;
			assert.ok(graph, 'the task graph is persisted');
			const node = graph.nodes[0]!;
			assert.strictEqual(node.status, 'accepted');
			assert.strictEqual(node.attempts, 1);
			assert.strictEqual(node.verification?.checks[0]?.met, true);
			assert.strictEqual(node.verification?.checks[0]?.by, 'reviewer');

			const childId = parent.subagents?.delegate;
			assert.ok(childId, 'a single delegated task links its child to the tool card');
			const child = kernel.ctx.sessions.require(childId);
			assert.strictEqual(child.subagent, 'coder');
			assert.strictEqual(child.parentId, parent.id);
			assert.strictEqual(child.subagentDone, true);
			coderApproval = child.policy.approval;
			assert.strictEqual(coderApproval, 'universal_accept', 'the child inherits the parent approval');
			assert.ok(!coderOffered.includes('delegate'), `delegate is not offered to a child: ${coderOffered.join(', ')}`);
			assert.ok(!coderOffered.includes('task_graph'));
			assert.ok(!coderOffered.includes('task_status'));
			assert.ok(!coderOffered.includes('agent'));

			const verifierId = node.verificationSessionIds?.[0];
			assert.ok(verifierId, 'the reviewer has a hidden session');
			assert.strictEqual(kernel.ctx.sessions.require(verifierId).subagent, 'reviewer');
			assert.deepStrictEqual(
				taskChildrenOf(node, (id) => kernel.ctx.sessions.get(id)),
				[
					{ id: childId, role: 'coder', done: true },
					{ id: verifierId, role: 'reviewer', done: true },
				],
				'the overlay lists the worker and its verifier',
			);
			assert.deepStrictEqual(
				starts.map((start) => start.name),
				['coder', 'reviewer'],
			);
			assert.strictEqual(starts[0]?.callId, 'delegate');

			const pending = await kernel.ctx.checkpoints.pending(workspace, parent.id);
			assert.ok(pending.files.some((file) => file.path === 'made.txt'), 'the child write lands in the parent journal');
		} finally {
			await kernel.dispose();
		}
	});

	test('a tool-budget pause keeps the child transcript and resume finishes the task', async () => {
		const kernel = await createTestKernel({ config: { checkpoints: true } });
		try {
			const workspace = kernel.host.workspace();
			let childCalls = 0;
			const childSystems: string[] = [];
			kernel.ctx.llm.use({
				name: 'budget-orchestrator',
				async chat(request) {
					const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
					if (system.includes('You are the coder subagent of Comonad')) {
						childCalls += 1;
						childSystems.push(system);
						const last = request.messages[request.messages.length - 1];
						if (last?.role === 'tool') {
							return reply(
								JSON.stringify({
									status: 'ok',
									summary: 'wrote a.txt',
									evidence: [{ kind: 'file', path: 'a.txt' }],
									acceptance: [{ id: 'a1', met: true }],
								}),
							);
						}
						return reply('', [
							{ id: 'write-a', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'a\n' }) },
							{ id: 'write-b', name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'b\n' }) },
						]);
					}
					if (system.includes('You are the reviewer subagent of Comonad')) {
						return reply(
							JSON.stringify({
								verdict: 'pass',
								summary: 'a.txt exists',
								evidence: [{ kind: 'file', path: 'a.txt' }],
								acceptance: [{ id: 'a1', met: true }],
							}),
						);
					}
					const last = rootStep(request);
					if (!last) {
						return reply('', [
							graphCall([
								{
									id: 'code',
									title: 'Write a.txt',
									role: 'coder',
									objective: 'Create a.txt.',
									writes: ['a.txt'],
									budget: { tools: 1 },
									acceptance: [{ id: 'a1', description: 'a.txt contains a', check: 'review', files: ['a.txt'] }],
								},
							]),
						]);
					}
					if (last === 'task_graph') {
						return reply('', [delegateCall(['code'])]);
					}
					if (last === 'delegate') {
						const paused = request.messages.find(
							(message) => message.role === 'tool' && (message.content ?? '').includes('budget_exhausted'),
						);
						assert.ok(paused, 'the delegate result reports the pause');
						return reply('', [resumeCall(['code'], { turns: 4, tools: 4 })]);
					}
					return reply('done');
				},
			});
			await kernel.ctx.plugin(fsTools);
			await kernel.ctx.plugin(orchestrateTools);
			await kernel.ctx.agent.runTurn({ text: 'make a.txt', surface: 'test' });

			const parent = kernel.ctx.sessions.active()!;
			const node = parent.taskGraph!.nodes[0]!;
			assert.strictEqual(node.status, 'accepted');
			assert.strictEqual(node.attempts, 1);
			assert.strictEqual(node.resumes, 1);
			assert.ok(node.subagentSessionId, 'the child session survives the pause');
			assert.strictEqual(childCalls, 2, 'the resumed child asks the model again in the same session');
			assert.strictEqual(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'a\n');
			assert.ok(!existsSync(join(workspace, 'b.txt')), 'the second call was denied by the tool budget');

			const child = kernel.ctx.sessions.require(node.subagentSessionId!);
			assert.strictEqual(child.subagentDone, true);
			assert.ok(
				child.transcript.some((message) => message.role === 'tool' && (message.content ?? '').includes('tool budget')),
				'the paused transcript carries a synthetic result for the denied call',
			);
			const resumed = parent.transcript.find((message) => message.role === 'tool' && message.toolCallId === 'resume');
			assert.ok(resumed, 'the root saw the resume result');
			assert.match(resumed.content ?? '', /Resume budgets raised/);
			assert.match(resumed.content ?? '', /turns 4 -> 16/);
			assert.match(childSystems[1] ?? '', /16 turns, 4 tools/, 'the resumed segment gets the raised turn limit');
		} finally {
			await kernel.dispose();
		}
	});

	test('inherit mode gives the child the parent limits, not its role or default budget', async () => {
		const kernel = await createTestKernel({
			config: {
				budget: { turns: 40, tools: 50, tokens: 0, milliseconds: 0 },
				subagentBudget: { turns: 1, tools: 1, tokens: 0, milliseconds: 0 },
				subagentBudgetMode: 'inherit',
			},
		});
		try {
			let childSystem = '';
			kernel.ctx.llm.use({
				name: 'inherit-budget',
				async chat(request) {
					const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
					if (system.includes('You are the explorer subagent of Comonad')) {
						childSystem = system;
						return reply(
							JSON.stringify({
								status: 'ok',
								summary: 'mapped the entry points',
								evidence: [{ kind: 'note', text: 'entry points found' }],
								acceptance: [{ id: 'a1', met: true }],
							}),
						);
					}
					const last = rootStep(request);
					if (!last) {
						return reply('', [
							graphCall([
								{
									id: 'look',
									title: 'Map the entry points',
									role: 'explorer',
									objective: 'List the entry points.',
									acceptance: [{ id: 'a1', description: 'Entry points listed', check: 'evidence' }],
								},
							]),
						]);
					}
					if (last === 'task_graph') {
						return reply('', [delegateCall(['look'])]);
					}
					return reply('done');
				},
			});
			await kernel.ctx.plugin(orchestrateTools);
			await kernel.ctx.agent.runTurn({ text: 'map it', surface: 'test' });
			assert.match(childSystem, /Native run budget: 40 turns, 50 tools\./, 'the child copies the root limits');
			assert.doesNotMatch(childSystem, /Native run budget: 1 turns, 1 tools\./, 'the child default is ignored');
			assert.doesNotMatch(childSystem, /Native run budget: 6 turns, 25 tools\./, 'the role default is ignored under inherit');
			assert.strictEqual(kernel.ctx.sessions.active()!.taskGraph!.nodes[0]!.status, 'accepted');
		} finally {
			await kernel.dispose();
		}
	});

	test('parallel write tasks run together and coordinate through the mailbox', async () => {
		const kernel = await createTestKernel({ config: { checkpoints: true } });
		try {
			const workspace = kernel.host.workspace();
			const messages: string[] = [];
			kernel.ctx.llm.use({
				name: 'parallel',
				async chat(request) {
					const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
					if (system.includes('You are the coder subagent of Comonad')) {
						const prompt = request.messages.find((message) => message.role === 'user')?.content ?? '';
						const task = prompt.includes('# Task a') ? 'a' : prompt.includes('# Task b') ? 'b' : '';
						const last = request.messages[request.messages.length - 1];
						if (last?.role !== 'tool') {
							return reply('', [
								{ id: `message-${task}`, name: 'message', arguments: JSON.stringify({ action: 'send', to: 'all', text: `writing ${task}.txt` }) },
								{ id: `write-${task}`, name: 'write_file', arguments: JSON.stringify({ path: `${task}.txt`, content: `${task}\n` }) },
							]);
						}
						return reply(
							JSON.stringify({
								status: 'ok',
								summary: `wrote ${task}.txt`,
								evidence: [{ kind: 'file', path: `${task}.txt` }],
								acceptance: [{ id: 'a1', met: true }],
							}),
						);
					}
					if (system.includes('You are the reviewer subagent of Comonad')) {
						return reply(
							JSON.stringify({
								verdict: 'pass',
								summary: 'the file exists',
								evidence: [{ kind: 'note', text: 'checked' }],
								acceptance: [{ id: 'a1', met: true }],
							}),
						);
					}
					const last = rootStep(request);
					if (!last) {
						return reply('', [
							graphCall([
								{
									id: 'a',
									title: 'Write a.txt',
									role: 'coder',
									objective: 'Create a.txt.',
									writes: ['a.txt'],
									acceptance: [{ id: 'a1', description: 'a.txt exists', check: 'review' }],
								},
								{
									id: 'b',
									title: 'Write b.txt',
									role: 'coder',
									objective: 'Create b.txt.',
									writes: ['b.txt'],
									acceptance: [{ id: 'a1', description: 'b.txt exists', check: 'review' }],
								},
							]),
						]);
					}
					if (last === 'task_graph') {
						return reply('', [delegateCall(['a', 'b'])]);
					}
					return reply('done');
				},
			});
			await kernel.ctx.plugin(fsTools);
			await kernel.ctx.plugin(messageTools);
			await kernel.ctx.plugin(orchestrateTools);

			await kernel.ctx.agent.runTurn({ text: 'make both files', surface: 'test' });

			assert.strictEqual(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'a\n');
			assert.strictEqual(readFileSync(join(workspace, 'b.txt'), 'utf8'), 'b\n');
			const parent = kernel.ctx.sessions.active()!;
			const graph = parent.taskGraph!;
			assert.deepStrictEqual(
				graph.nodes.map((node) => [node.id, node.status]),
				[
					['a', 'accepted'],
					['b', 'accepted'],
				],
			);
			for (const node of graph.nodes) {
				assert.ok(node.subagentSessionId, `${node.id} has a child session`);
				assert.deepStrictEqual(node.verification?.checks.map((check) => check.by), ['reviewer']);
			}
			const mailbox = kernel.ctx.mailbox.recent(parent.id);
			assert.deepStrictEqual(
				mailbox.map((record) => record.text).sort(),
				['writing a.txt', 'writing b.txt'],
			);
			assert.deepStrictEqual(
				mailbox.map((record) => record.from.task).sort(),
				['a', 'b'],
			);
			messages.push(...mailbox.map((record) => record.text));
			assert.strictEqual(messages.length, 2);
		} finally {
			await kernel.dispose();
		}
	});

	test('a finished worker is recorded while its batch peer still runs', async () => {
		const kernel = await createTestKernel();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			kernel.ctx.llm.use({
				name: 'settle-early',
				async chat(request) {
					const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
					if (system.includes('You are the explorer subagent of Comonad')) {
						const prompt = request.messages.find((message) => message.role === 'user')?.content ?? '';
						if (prompt.includes('# Task beta')) {
							await gate;
						}
						return reply(
							JSON.stringify({
								status: 'ok',
								summary: 'read the facts',
								evidence: [{ kind: 'note', text: 'read' }],
								acceptance: [{ id: 'a1', met: true }],
							}),
						);
					}
					const last = rootStep(request);
					if (!last) {
						return reply('', [
							graphCall([
								{
									id: 'alpha',
									title: 'Read alpha',
									role: 'explorer',
									objective: 'Read alpha.',
									acceptance: [{ id: 'a1', description: 'alpha is read', check: 'evidence' }],
								},
								{
									id: 'beta',
									title: 'Read beta',
									role: 'explorer',
									objective: 'Read beta.',
									acceptance: [{ id: 'a1', description: 'beta is read', check: 'evidence' }],
								},
							]),
						]);
					}
					if (last === 'task_graph') {
						return reply('', [delegateCall(['alpha', 'beta'])]);
					}
					return reply('done');
				},
			});
			await kernel.ctx.plugin(fsTools);
			await kernel.ctx.plugin(orchestrateTools);

			let intermediate: TaskBoard | undefined;
			let observe!: () => void;
			const seen = new Promise<void>((resolve) => {
				observe = resolve;
			});
			kernel.ctx.on('orchestrator/changed', (_id, board) => {
				if (!board) {
					return;
				}
				const alpha = board.nodes.find((task) => task.id === 'alpha');
				const beta = board.nodes.find((task) => task.id === 'beta');
				if (alpha?.status === 'accepted' && alpha.finishedAt !== undefined && beta?.status === 'running') {
					intermediate = board;
					observe();
				}
			});
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('alpha was not recorded while beta still ran')), 1_500);
			});
			const turn = kernel.ctx.agent.runTurn({ text: 'read both', surface: 'test' });
			try {
				await Promise.race([seen, timeout]);
			} finally {
				clearTimeout(timer);
				release();
			}
			await turn;
			assert.ok(intermediate, 'the board saw alpha accepted before beta settled');
			const final = kernel.ctx.sessions.active()!.taskGraph!;
			assert.deepStrictEqual(
				final.nodes.map((task) => [task.id, task.status]),
				[
					['alpha', 'accepted'],
					['beta', 'accepted'],
				],
			);
			for (const task of final.nodes) {
				assert.ok(task.subagentSessionId, `${task.id} has a child session`);
			}
		} finally {
			release();
			await kernel.dispose();
		}
	});

	test('recover marks stale in-flight nodes interrupted and a fork drops the graph', async () => {
		const kernel = await createTestKernel();
		try {
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'recover-test');
			const result = reconcileTaskGraph(
				undefined,
				{
					objective: 'recover a stale turn',
					nodes: [
						{
							id: 'code',
							title: 'Code',
							role: 'coder',
							objective: 'do the work',
							acceptance: [{ id: 'a1', description: 'it is correct', check: 'review' }],
						},
					],
				},
				new Map(BUILTIN_ROLES.map((role) => [role.id, role])),
				0,
				1,
			);
			assert.ok(result.ok);
			result.graph.nodes[0]!.status = 'running';
			session.taskGraph = result.graph;
			kernel.ctx.sessions.save(session);

			kernel.ctx.orchestrator.recover(session);
			assert.strictEqual(session.taskGraph!.nodes[0]!.status, 'rejected');
			assert.strictEqual(session.taskGraph!.nodes[0]!.rejection?.code, 'interrupted');

			const fork = kernel.ctx.sessions.fork(session.id);
			assert.strictEqual(fork.taskGraph, undefined, 'a fork is a new chat and inherits no tasks');
		} finally {
			await kernel.dispose();
		}
	});

	test('Build archives the task graph and starts a fresh one', async () => {
		const kernel = await createTestKernel();
		try {
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'archive-test');
			const result = reconcileTaskGraph(
				undefined,
				{
					objective: 'archive the research',
					nodes: [
						{
							id: 'code',
							title: 'Code',
							role: 'coder',
							objective: 'do the work',
							acceptance: [{ id: 'a1', description: 'it is correct', check: 'review' }],
						},
					],
				},
				new Map(BUILTIN_ROLES.map((role) => [role.id, role])),
				0,
				1,
			);
			assert.ok(result.ok);
			session.taskGraph = result.graph;
			kernel.ctx.sessions.save(session);

			const changes: unknown[] = [];
			kernel.ctx.on('orchestrator/changed', (_id, board) => changes.push(board));
			assert.strictEqual(kernel.ctx.orchestrator.archiveTaskGraph(session), true);
			assert.strictEqual(session.taskGraph, undefined, 'the active graph is cleared');
			assert.strictEqual(session.archivedTaskGraphs?.length, 1, 'the research graph is kept as history');
			assert.ok(changes.includes(undefined), 'the board is cleared');
			const reloaded = kernel.ctx.sessions.get(session.id)!;
			assert.strictEqual(reloaded.archivedTaskGraphs?.length, 1, 'the archive survives a reload');

			const fresh = reconcileTaskGraph(undefined, { objective: 'build it', nodes: result.graph.nodes.map((node) => ({
				id: node.id,
				title: node.title,
				role: node.role,
				objective: node.objective,
				acceptance: node.acceptance,
			})) }, new Map(BUILTIN_ROLES.map((role) => [role.id, role])), 1, 2);
			assert.ok(fresh.ok);
			assert.strictEqual(fresh.graph.version, 1, 'a fresh graph starts at version 1');
			assert.strictEqual(fresh.graph.replans, 0, 'and spends no replans');

			const fork = kernel.ctx.sessions.fork(session.id);
			assert.strictEqual(fork.archivedTaskGraphs, undefined, 'a fork inherits no archive');
		} finally {
			await kernel.dispose();
		}
	});

	test('Plan mode delegates read-only research and stops after the plan is recorded', async () => {
		const kernel = await createTestKernel({ config: { mode: 'plan' } });
		try {
			await kernel.ctx.plugin(orchestrateTools);
			await kernel.ctx.plugin(planTools);
			const session = kernel.ctx.sessions.ensureActive(kernel.ctx.agent.policyFor());
			const names = kernel.ctx.tools.visible(session.policy).map((tool) => tool.name);
			assert.ok(names.includes('delegate'), 'read-only delegation stays available');
			assert.ok(names.includes('write_plan'), 'the plan creator stays available');
			assert.ok(names.includes('edit_plan'), 'the plan editor stays available');

			const blocks = await kernel.ctx.agent.promptBlocks(session);
			const orchestrator = blocks.find((block) => block.id === COMONAD_BLOCK.orchestrator);
			assert.ok(orchestrator, 'the Orchestration block is still present');
			assert.match(orchestrator.text, /This is Plan mode: the session is read-only/);
			assert.match(orchestrator.text, /delegate only read-only research nodes/);
			assert.match(orchestrator.text, /After write_plan or edit_plan, stop and summarize/);
			assert.ok(!orchestrator.text.includes('Independent tasks, including independent write tasks'));

			const tools = blocks.find((block) => block.id === COMONAD_BLOCK.tools);
			assert.ok(tools);
			assert.match(tools.text, /then stop and summarize/);
			assert.match(tools.text, /Do not implement or delegate write work/);
		} finally {
			await kernel.dispose();
		}
	});

	test('Read-Only mode keeps delegation and adds the read-only rule', async () => {
		const kernel = await createTestKernel({ config: { mode: 'ro' } });
		try {
			await kernel.ctx.plugin(orchestrateTools);
			const session = kernel.ctx.sessions.ensureActive(kernel.ctx.agent.policyFor());
			const blocks = await kernel.ctx.agent.promptBlocks(session);
			const orchestrator = blocks.find((block) => block.id === COMONAD_BLOCK.orchestrator);
			assert.ok(orchestrator);
			assert.match(orchestrator.text, /This session is read-only: delegate only read-only tasks/);
			assert.ok(!orchestrator.text.includes('This is Plan mode'));
		} finally {
			await kernel.dispose();
		}
	});

	test('Plan mode without a plan writer asks for the plan in the summary', async () => {
		const kernel = await createTestKernel({ config: { mode: 'plan', sandboxMode: 'read-only' } });
		try {
			await kernel.ctx.plugin(orchestrateTools);
			await kernel.ctx.plugin(planTools);
			const session = kernel.ctx.sessions.ensureActive(kernel.ctx.agent.policyFor());
			const names = kernel.ctx.tools.visible(session.policy).map((tool) => tool.name);
			assert.ok(!names.includes('write_plan'), 'a write-refusing sandbox hides the plan creator');
			assert.ok(!names.includes('edit_plan'), 'a write-refusing sandbox hides the plan editor');
			const blocks = await kernel.ctx.agent.promptBlocks(session);
			const orchestrator = blocks.find((block) => block.id === COMONAD_BLOCK.orchestrator);
			assert.ok(orchestrator);
			assert.match(orchestrator.text, /put the implementation plan in your final summary/);
			assert.ok(!orchestrator.text.includes('Record the implementation plan yourself'));
		} finally {
			await kernel.dispose();
		}
	});

	test('Plan mode refuses a write task when the plan is recorded', async () => {
		const kernel = await createTestKernel();
		try {
			kernel.ctx.llm.use({
				name: 'plan-refusal',
				async chat(request) {
					const last = rootStep(request);
					if (!last) {
						return reply('', [
							graphCall([
								{
									id: 'code',
									title: 'Code',
									role: 'coder',
									objective: 'Write x.txt.',
									writes: ['x.txt'],
									acceptance: [{ id: 'a1', description: 'x.txt exists', check: 'review' }],
								},
							]),
						]);
					}
					return reply('done');
				},
			});
			await kernel.ctx.plugin(orchestrateTools);
			await kernel.ctx.plugin(planTools);
			await kernel.ctx.agent.runTurn({
				text: 'plan it',
				surface: 'test',
				policy: { workMode: 'plan', approval: 'whitelist_accept', network: false },
			});

			const session = kernel.ctx.sessions.active()!;
			assert.strictEqual(session.taskGraph, undefined, 'the write plan was not recorded');
			const result = session.transcript.find((message) => message.role === 'tool' && message.toolCallId === 'plan-1');
			assert.ok(result, 'the model saw the refusal');
			assert.match(result.content ?? '', /Plan mode delegates only read-only research/);
			assert.match(result.content ?? '', /write_plan or edit_plan/);
		} finally {
			await kernel.dispose();
		}
	});

	test('Plan mode delegates a planner and records its plan', async () => {
		const kernel = await createTestKernel({ config: { mode: 'plan' } });
		try {
			const workspace = kernel.host.workspace();
			let plannerOffered: string[] = [];
			kernel.ctx.llm.use({
				name: 'plan-orchestrator',
				async chat(request) {
					const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
					if (system.includes('You are the planner subagent of Comonad')) {
						plannerOffered = (request.tools ?? []).map((tool) => tool.name);
						return reply(
							JSON.stringify({
								status: 'ok',
								summary: '1. Read the module. 2. Change the parser.',
								evidence: [{ kind: 'note', text: 'mapped the parser' }],
								acceptance: [{ id: 'a1', met: true }],
							}),
						);
					}
					const last = rootStep(request);
					if (!last) {
						return reply('', [
							graphCall([
								{
									id: 'research',
									title: 'Draft the plan',
									role: 'planner',
									objective: 'Draft an implementation plan for the change.',
									acceptance: [{ id: 'a1', description: 'Ordered steps are returned', check: 'evidence' }],
								},
							]),
						]);
					}
					if (last === 'task_graph') {
						return reply('', [delegateCall(['research'])]);
					}
					if (last === 'delegate') {
						return reply('', [
							{
								id: 'write-plan',
								name: 'write_plan',
								arguments: JSON.stringify({
									name: 'plan.md',
									content: '# Plan\n\n1. Read the module.\n2. Change the parser.\n',
								}),
							},
						]);
					}
					return reply('Plan recorded; ready to build.');
				},
			});
			await kernel.ctx.plugin(fsTools);
			await kernel.ctx.plugin(orchestrateTools);
			await kernel.ctx.plugin(planTools);
			await kernel.ctx.agent.runTurn({ text: 'plan it', surface: 'test' });

			const parent = kernel.ctx.sessions.active()!;
			const node = parent.taskGraph!.nodes[0]!;
			assert.strictEqual(node.status, 'accepted');
			assert.ok(node.subagentSessionId, 'the planner has a child session');
			const child = kernel.ctx.sessions.require(node.subagentSessionId!);
			assert.strictEqual(child.subagent, 'planner');
			assert.deepStrictEqual([...(child.policy.capabilities ?? [])].sort(), ['ro', 'ro_plan', 'shell_ro']);
			assert.ok(plannerOffered.includes('list_plans'));
			assert.ok(plannerOffered.includes('read_plan'));
			assert.ok(!plannerOffered.includes('write_plan'), 'a child never creates plan files');
			assert.ok(!plannerOffered.includes('edit_plan'), 'a child never edits plan files');

			const planPath = join(workspace, '.comonad', 'plans', parent.id, 'plan.md');
			assert.ok(existsSync(planPath), 'the root recorded the returned plan');
			assert.match(readFileSync(planPath, 'utf8'), /Change the parser/);
			const result = parent.transcript.find((message) => message.role === 'tool' && message.toolCallId === 'write-plan');
			assert.ok(result);
			assert.match(result.content ?? '', /^wrote plan plan\.md/);
			assert.match(result.content ?? '', /Stop here and summarize it/);
		} finally {
			await kernel.dispose();
		}
	});

	test('Plan mode records a plan and then revises it in place', async () => {
		const kernel = await createTestKernel({ config: { mode: 'plan' } });
		try {
			const workspace = kernel.host.workspace();
			kernel.ctx.llm.use({
				name: 'plan-revision',
				async chat(request) {
					const last = rootStep(request);
					if (!last) {
						return reply('', [
							{
								id: 'write-plan',
								name: 'write_plan',
								arguments: JSON.stringify({ name: 'plan.md', content: '# Plan\n\n1. Old\n' }),
							},
						]);
					}
					if (last === 'write_plan') {
						return reply('', [
							{
								id: 'edit-plan',
								name: 'edit_plan',
								arguments: JSON.stringify({
									name: 'plan.md',
									edits: [
										{ old: '1. Old', new: '1. New' },
										{ old: '1. New\n', new: '1. New\n2. Added\n' },
									],
								}),
							},
						]);
					}
					return reply('Plan updated.');
				},
			});
			await kernel.ctx.plugin(orchestrateTools);
			await kernel.ctx.plugin(planTools);
			await kernel.ctx.agent.runTurn({ text: 'plan it', surface: 'test' });

			const session = kernel.ctx.sessions.active()!;
			const planPath = join(workspace, '.comonad', 'plans', session.id, 'plan.md');
			assert.ok(existsSync(planPath));
			assert.strictEqual(readFileSync(planPath, 'utf8'), '# Plan\n\n1. New\n2. Added\n');
			const written = session.transcript.find((message) => message.role === 'tool' && message.toolCallId === 'write-plan');
			assert.ok(written);
			assert.match(written.content ?? '', /^wrote plan plan\.md/);
			const revised = session.transcript.find((message) => message.role === 'tool' && message.toolCallId === 'edit-plan');
			assert.ok(revised);
			assert.match(revised.content ?? '', /^edited plan plan\.md/);
			assert.match(revised.content ?? '', /2 edits applied/);
			assert.match(revised.content ?? '', /Stop here and summarize it/);
		} finally {
			await kernel.dispose();
		}
	});

	test('Plan mode refuses to delegate a write task with a plan-first message', async () => {
		const kernel = await createTestKernel();
		try {
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'plan-delegate-refusal');
			const planned = reconcileTaskGraph(
				undefined,
				{
					objective: 'write it',
					nodes: [
						{
							id: 'code',
							title: 'Code',
							role: 'coder',
							objective: 'Write x.txt.',
							writes: ['x.txt'],
							acceptance: [{ id: 'a1', description: 'x.txt exists', check: 'review' }],
						},
					],
				},
				new Map(BUILTIN_ROLES.map((role) => [role.id, role])),
				0,
				1,
			);
			assert.ok(planned.ok);
			session.taskGraph = planned.graph;
			kernel.ctx.sessions.save(session);

			const starts: string[] = [];
			kernel.ctx.on('agent/subagent-start', (_ref, info) => starts.push(info.name));
			kernel.ctx.llm.use({
				name: 'delegate-refusal',
				async chat(request) {
					const last = rootStep(request);
					if (!last) {
						return reply('', [delegateCall(['code'])]);
					}
					return reply('done');
				},
			});
			await kernel.ctx.plugin(orchestrateTools);
			await kernel.ctx.agent.runTurn({
				text: 'do it',
				sessionId: session.id,
				surface: 'test',
				policy: { workMode: 'plan', approval: 'whitelist_accept', network: false },
			});

			const result = session.transcript.find((message) => message.role === 'tool' && message.toolCallId === 'delegate');
			assert.ok(result);
			assert.match(result.content ?? '', /Plan mode delegates only read-only research/);
			assert.strictEqual(session.taskGraph!.nodes[0]!.status, 'pending', 'the task did not start');
			assert.deepStrictEqual(starts, [], 'no child session was spawned');
		} finally {
			await kernel.dispose();
		}
	});
});

suite('Resume budget clamp', () => {
	test('a resume segment cannot shrink the previous segment', () => {
		const previous = { turns: 16, tools: 50, tokens: 0, milliseconds: 0 };
		assert.deepStrictEqual(clampResumeBudget(previous, { turns: 12, tools: 30, tokens: 5 }), {
			budget: { turns: 16, tools: 50, tokens: 0 },
			clamped: ['turns', 'tools', 'tokens'],
		});
		assert.deepStrictEqual(clampResumeBudget(previous, { turns: 32, tools: 60 }), {
			budget: { turns: 32, tools: 60 },
			clamped: [],
		});
		assert.deepStrictEqual(clampResumeBudget(undefined, { turns: 1 }), { budget: { turns: 1 }, clamped: [] });
		assert.deepStrictEqual(clampResumeBudget(previous, undefined), { budget: undefined, clamped: [] });
	});
});

suite('Verifier acceptance mapping', () => {
	async function commandTaskKernel(tester: {
		acceptance: unknown[];
		evidence: unknown[];
		verdict?: string;
		call?: ToolCall;
		repair?: { acceptance: unknown[]; evidence: unknown[] };
	}) {
		const kernel = await createTestKernel();
		kernel.ctx.llm.use({
			name: `command-orchestrator-${Math.random()}`,
			async chat(request) {
				const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
				if (system.includes('You are the coder subagent of Comonad')) {
					const last = request.messages[request.messages.length - 1];
					if (last?.role === 'tool') {
						return reply(
							JSON.stringify({
								status: 'ok',
								summary: 'wrote made.txt',
								evidence: [{ kind: 'file', path: 'made.txt' }],
								acceptance: [],
							}),
						);
					}
					return reply('', [
						{ id: 'write-made', name: 'write_file', arguments: JSON.stringify({ path: 'made.txt', content: 'made\n' }) },
					]);
				}
				if (system.includes('You are the tester subagent of Comonad')) {
					const last = request.messages[request.messages.length - 1];
					if (last?.role === 'user' && String(last.content).includes('failed the contract') && tester.repair) {
						return reply(
							JSON.stringify({
								verdict: 'pass',
								summary: 'repaired the report',
								evidence: tester.repair.evidence,
								acceptance: tester.repair.acceptance,
							}),
						);
					}
					if (tester.call && last?.role !== 'tool') {
						return reply('', [tester.call]);
					}
					return reply(
						JSON.stringify({
							verdict: tester.verdict ?? 'pass',
							summary: 'ran the command',
							evidence: tester.evidence,
							acceptance: tester.acceptance,
						}),
					);
				}
				const last = rootStep(request);
				if (!last) {
					return reply('', [
						graphCall([
							{
								id: 'code',
								title: 'Write made.txt',
								role: 'coder',
								objective: 'Create made.txt.',
								writes: ['made.txt'],
								acceptance: [{ id: 'check', description: 'true exits 0', check: 'command', command: 'true' }],
							},
						]),
					]);
				}
				if (last === 'task_graph') {
					return reply('', [delegateCall(['code'])]);
				}
				return reply('done');
			},
		});
		await kernel.ctx.plugin(fsTools);
		await kernel.ctx.plugin(shellTools);
		await kernel.ctx.plugin(orchestrateTools);
		return kernel;
	}

	test('an equal-length all-different id list maps positionally and accepts', async () => {
		const kernel = await commandTaskKernel({
			acceptance: [{ id: 'a1', met: true, note: 'ran true' }],
			evidence: [{ kind: 'command', command: 'true', exitCode: 0 }],
			call: { id: 'run-check', name: 'run_shell_test', arguments: JSON.stringify({ command: 'true', description: 'run the check' }) },
		});
		try {
			await kernel.ctx.agent.runTurn({ text: 'make made.txt', surface: 'test' });
			const node = kernel.ctx.sessions.active()!.taskGraph!.nodes[0]!;
			assert.strictEqual(node.status, 'accepted');
			assert.strictEqual(node.verification?.checks[0]?.id, 'check');
			assert.match(node.verification?.checks[0]?.note ?? '', /mapped positionally to check/);
			assert.match(node.verification?.summary ?? '', /mapped positionally/);
		} finally {
			await kernel.dispose();
		}
	});

	test('incomplete coverage is a verification_unavailable rejection, not a silent zero-check pass', async () => {
		const kernel = await commandTaskKernel({
			acceptance: [
				{ id: 'a1', met: true },
				{ id: 'a2', met: true },
			],
			evidence: [{ kind: 'command', command: 'true', exitCode: 0 }],
		});
		try {
			await kernel.ctx.agent.runTurn({ text: 'make made.txt', surface: 'test' });
			const node = kernel.ctx.sessions.active()!.taskGraph!.nodes[0]!;
			assert.strictEqual(node.status, 'rejected');
			assert.strictEqual(node.rejection?.code, 'verification_unavailable');
			assert.match(node.rejection?.reason ?? '', /expected acceptance ids check but got a1, a2/);
			assert.match(node.rejection?.reason ?? '', /not judged/);
			assert.strictEqual(node.verificationSessionIds?.length, 1, 'the failed verifier is still linked');
		} finally {
			await kernel.dispose();
		}
	});

	test('a 20-item evidence list is trimmed and still accepts', async () => {
		const evidence = [
			{ kind: 'command', command: 'true', exitCode: 0 },
			...Array.from({ length: 19 }, (_, index) => ({ kind: 'file', path: `src/file-${index}.ts` })),
		];
		const kernel = await commandTaskKernel({
			acceptance: [{ id: 'check', met: true }],
			evidence,
			call: { id: 'run-check', name: 'run_shell_test', arguments: JSON.stringify({ command: 'true', description: 'run the check' }) },
		});
		try {
			await kernel.ctx.agent.runTurn({ text: 'make made.txt', surface: 'test' });
			const node = kernel.ctx.sessions.active()!.taskGraph!.nodes[0]!;
			assert.strictEqual(node.status, 'accepted');
			assert.strictEqual(node.verification?.checks[0]?.evidence?.length, 16);
		} finally {
			await kernel.dispose();
		}
	});

	test('a contract failure is repaired in the same verifier session', async () => {
		const kernel = await commandTaskKernel({
			acceptance: [],
			evidence: [{ kind: 'command', command: 'true', exitCode: 0 }],
			call: { id: 'run-check', name: 'run_shell_test', arguments: JSON.stringify({ command: 'true', description: 'run the check' }) },
			repair: {
				acceptance: [{ id: 'check', met: true }],
				evidence: [{ kind: 'command', command: 'true', exitCode: 0 }],
			},
		});
		try {
			await kernel.ctx.agent.runTurn({ text: 'make made.txt', surface: 'test' });
			const node = kernel.ctx.sessions.active()!.taskGraph!.nodes[0]!;
			assert.strictEqual(node.status, 'accepted');
			assert.strictEqual(node.attempts, 1, 'the repair does not spend an attempt');
			assert.match(node.verification?.summary ?? '', /repaired the report/);
		} finally {
			await kernel.dispose();
		}
	});

	test('a real shell run supplies command evidence even when the report omits it', async () => {
		const kernel = await commandTaskKernel({
			acceptance: [{ id: 'check', met: true }],
			evidence: [],
			call: { id: 'run-check', name: 'run_shell_test', arguments: JSON.stringify({ command: 'true', description: 'run the check' }) },
		});
		try {
			await kernel.ctx.agent.runTurn({ text: 'make made.txt', surface: 'test' });
			const node = kernel.ctx.sessions.active()!.taskGraph!.nodes[0]!;
			assert.strictEqual(node.status, 'accepted');
			const evidence = node.verification?.checks[0]?.evidence ?? [];
			assert.ok(
				evidence.some((item) => item.kind === 'command' && item.command === 'true' && item.exitCode === 0),
				'the transcript command is recorded as evidence',
			);
		} finally {
			await kernel.dispose();
		}
	});
});

suite('Context compaction', () => {
	test('the new prompt reaches disk before the summary request', async () => {
		const kernel = await createTestKernel();
		try {
			const session = kernel.ctx.sessions.ensureActive(kernel.ctx.agent.policyFor());
			session.contextWindow = 32_768;
			const older: Message[] = [];
			for (let index = 0; index < 30; index += 1) {
				older.push({ role: 'user', content: `older question ${index} ${'x'.repeat(2_000)}`, at: 1_000 + index * 2 });
				older.push({ role: 'assistant', content: `older answer ${index} ${'y'.repeat(2_000)}`, at: 1_001 + index * 2 });
			}
			session.transcript = older;
			kernel.ctx.sessions.save(session);
			let sawPrompt = false;
			let summaryRequest: { reasoningEffort?: string; maxTokens?: number } | undefined;
			kernel.ctx.llm.use({
				name: 'compaction-fake',
				async chat(request) {
					const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
					if (system.includes('You summarize agent conversations')) {
						summaryRequest = request;
						const file = join(kernel.host.storage.root, 'sessions', `${session.id}.json`);
						const stored = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { transcript?: Message[] }) : undefined;
						sawPrompt = Boolean(
							stored?.transcript?.some((message) => message.role === 'user' && message.content === 'new prompt'),
						);
						return reply('older turns summarized');
					}
					return reply('answered');
				},
			});
			const result = await kernel.ctx.agent.runTurn({ text: 'new prompt', surface: 'test' });
			assert.strictEqual(result.text, 'answered');
			assert.strictEqual(sawPrompt, true, 'the prompt is on disk before the summarizer starts');
			assert.strictEqual(summaryRequest?.reasoningEffort, 'none');
			assert.strictEqual(summaryRequest?.maxTokens, 3_072);
			assert.ok(
				kernel.ctx.sessions.active()!.transcript.some((message) => message.role === 'user' && message.content === 'new prompt'),
			);
			assert.strictEqual(kernel.ctx.sessions.active()!.usage.requests, 2, 'the summary and the answer are both charged');
		} finally {
			await kernel.dispose();
		}
	});
});
