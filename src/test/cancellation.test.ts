// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abortable } from '../lib/cancel';
import { runGraph, type CompiledGraph } from '../lib/graph';
import { runProcess } from '../lib/sandbox';
import { objectSchema, type Message, type ToolContext } from '../lib/types';
import { shellTools } from '../tools/shell';
import { createTestKernel } from './harness';

/** Waits for a condition, so a test never depends on a fixed sleep. */
async function until(check: () => boolean, ms = 4_000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > ms) {
			throw new Error('condition was not met in time');
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	}
}

/** Fails a promise that outlives its budget instead of letting the suite hang. */
function within<T>(promise: Promise<T>, ms = 4_000): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)),
	]);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function context(kernel: Awaited<ReturnType<typeof createTestKernel>>, signal: AbortSignal): ToolContext {
	return {
		sessionId: 'cancel',
		workspace: kernel.host.workspace(),
		policy: kernel.ctx.agent.policyFor(),
		signal,
		log: () => undefined,
		ask: async () => [],
		todos: () => [],
		tasks: kernel.ctx.tasks,
		spawnAgent: async () => '',
	};
}

suite('Cancellation', () => {
	test('an abort between graph nodes ends the turn before routing', async () => {
		const controller = new AbortController();
		let exits = 0;
		const graph: CompiledGraph<Record<string, never>> = {
			id: 'cancel',
			start: 'first',
			maxSteps: 4,
			nodes: new Map([
				[
					'first',
					{
						run: async (state) => {
							controller.abort();
							return state;
						},
						exit: async () => {
							exits += 1;
							return 'end';
						},
					},
				],
			]),
		};
		const outcome = await runGraph(graph, {}, { signal: controller.signal });
		assert.strictEqual(outcome.status, 'aborted');
		assert.strictEqual(exits, 0, 'the routing step did not run after the stop');
	});

	test('abortable settles at once and observes the work’s later failure', async () => {
		const controller = new AbortController();
		let failed = false;
		const work = new Promise<string>((_resolve, reject) =>
			setTimeout(() => {
				failed = true;
				reject(new Error('late'));
			}, 50),
		);
		const raced = abortable(controller.signal, work);
		controller.abort();
		await assert.rejects(raced);
		await until(() => failed);
		assert.ok(true, 'the late rejection was handled');
	});

	test('already-aborted input starts no work and reports stopped', async () => {
		const kernel = await createTestKernel();
		try {
			let chats = 0;
			kernel.ctx.llm.use({
				name: 'cancel-test',
				async chat() {
					chats += 1;
					return { message: { role: 'assistant', content: 'reply' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const controller = new AbortController();
			controller.abort();
			const result = await kernel.ctx.agent.runTurn({ text: 'go', surface: 'test', signal: controller.signal });
			assert.strictEqual(result.stopped, true);
			assert.strictEqual(chats, 0, 'the model was never asked');
		} finally {
			await kernel.dispose();
		}
	});

	test('stop during prompt building cancels the turn before the model', async () => {
		const kernel = await createTestKernel();
		try {
			let chats = 0;
			kernel.ctx.llm.use({
				name: 'cancel-test',
				async chat() {
					chats += 1;
					return { message: { role: 'assistant', content: 'reply' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			let entered!: () => void;
			const building = new Promise<void>((resolvePromise) => {
				entered = resolvePromise;
			});
			const turn = kernel.ctx.agent.runTurn({
				text: 'go',
				surface: 'test',
				resolveAttachments: async () => {
					entered();
					await new Promise(() => undefined);
					return undefined;
				},
			});
			await building;
			assert.strictEqual(kernel.ctx.agent.stop(), true, 'the turn is owned before prompt building finishes');
			const result = await within(turn);
			assert.strictEqual(result.stopped, true);
			assert.strictEqual(chats, 0, 'the model was never asked');
			// The panel drew the prompt as soon as Send was pressed; a stop must not make it vanish
			// from the chat on the next reload.
			assert.deepStrictEqual(
				kernel.ctx.sessions.active()?.transcript.map((message) => message.content),
				['go'],
				'the prompt that was shown is kept',
			);
		} finally {
			await kernel.dispose();
		}
	});

	test('stopping a swipe leaves the exchange it replaced in place', async () => {
		const kernel = await createTestKernel();
		try {
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'swipe-stop');
			session.transcript = [
				{ role: 'user', content: 'hello', at: 1 },
				{ role: 'assistant', content: 'hi', at: 2, swipes: ['hi'], swipeId: 0 },
			];
			kernel.ctx.sessions.save(session);
			const turn = kernel.ctx.agent.runTurn({
				text: '',
				trigger: 'swipe',
				sessionId: 'swipe-stop',
				surface: 'test',
			});
			assert.strictEqual(kernel.ctx.agent.stop(), true, 'the turn is owned as soon as runTurn starts');
			const result = await within(turn);
			assert.strictEqual(result.stopped, true);
			const after = kernel.ctx.sessions.require('swipe-stop').transcript;
			assert.deepStrictEqual(
				after.map((message) => message.content),
				['hello', 'hi'],
				'the prompt and the reply are both back',
			);
			assert.deepStrictEqual(after[1]?.swipes, ['hi'], 'and so are the variants');
		} finally {
			await kernel.dispose();
		}
	});

	test('turn-start names the prompt that opened the turn', async () => {
		const kernel = await createTestKernel();
		try {
			kernel.ctx.llm.use({
				name: 'cancel-test',
				async chat() {
					return { message: { role: 'assistant', content: 'reply' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const seen: string[] = [];
			kernel.ctx.on('agent/turn-start', (_ref, text) => {
				seen.push(text);
			});
			await kernel.ctx.agent.runTurn({ text: 'the prompt', surface: 'test' });
			assert.deepStrictEqual(seen, ['the prompt'], 'a subscriber gets the prompt, not the previous reply');
		} finally {
			await kernel.dispose();
		}
	});

	test('a failing approval surface is reported, not read as a denial', async () => {
		const kernel = await createTestKernel();
		try {
			kernel.ctx.on('approval/request', async () => {
				throw new Error('broken surface');
			});
			await assert.rejects(
				kernel.ctx.approval.request({
					calls: [],
					reason: 'probe',
					sessionId: 's',
					signal: new AbortController().signal,
				}),
				/broken surface/,
			);
		} finally {
			await kernel.dispose();
		}
	});

	test('the approval response policy never denies without reaching a surface', async () => {
		const kernel = await createTestKernel();
		try {
			let seen = 0;
			kernel.ctx.on('approval/request', () => {
				seen += 1;
				return 'allow';
			});
			const answer = await kernel.ctx.approval.request({
				calls: [],
				reason: 'probe',
				sessionId: 's',
				signal: new AbortController().signal,
				response: 'never',
			});
			assert.strictEqual(answer, 'deny');
			assert.strictEqual(seen, 0, 'no surface was asked');
		} finally {
			await kernel.dispose();
		}
	});

	test('stop during a tool writes a stopped result and ends the turn', async () => {
		const kernel = await createTestKernel({ config: { mode: 'aw', approval: 'universal_accept' } });
		try {
			let entered!: () => void;
			const running = new Promise<void>((resolvePromise) => {
				entered = resolvePromise;
			});
			kernel.ctx.tools.register({
				name: 'hang',
				description: 'wait until stopped',
				capability: 'ro',
				needsNetwork: false,
				needsWorkspace: false,
				parameters: objectSchema({}, []),
				execute: async (_args, ctx) => {
					entered();
					await new Promise((_resolve, reject) => {
						ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
					});
					return 'never';
				},
			});
			kernel.ctx.llm.use({
				name: 'cancel-test',
				async chat() {
					const call = { id: 'c1', name: 'hang', arguments: '{}' };
					return {
						message: { role: 'assistant', content: '', toolCalls: [call] },
						toolCalls: [call],
						usage: { input: 1, output: 1 },
					};
				},
			});
			const turn = kernel.ctx.agent.runTurn({ text: 'go', surface: 'test' });
			await running;
			assert.strictEqual(kernel.ctx.agent.stop(), true);
			const result = await within(turn);
			assert.strictEqual(result.stopped, true);
			const session = kernel.ctx.sessions.active();
			assert.ok(session);
			const tool = session.transcript.find((message): message is Message => message.role === 'tool');
			assert.strictEqual(tool?.content, 'Stopped by the user.');
			assert.strictEqual(session.cursor, null);
		} finally {
			await kernel.dispose();
		}
	});

	test('stop during an approval resolves deny and clears the suspension', async () => {
		const kernel = await createTestKernel({ config: { mode: 'aw', approval: 'manual' } });
		try {
			kernel.ctx.tools.register({
				name: 'probe',
				description: 'needs approval',
				capability: 'ro',
				needsNetwork: false,
				needsWorkspace: false,
				parameters: objectSchema({}, []),
				execute: async () => 'ran',
			});
			kernel.ctx.llm.use({
				name: 'cancel-test',
				async chat() {
					const call = { id: 'c1', name: 'probe', arguments: '{}' };
					return {
						message: { role: 'assistant', content: '', toolCalls: [call] },
						toolCalls: [call],
						usage: { input: 1, output: 1 },
					};
				},
			});
			// A surface that never answers: only the turn's signal can settle this request.
			kernel.ctx.on('approval/request', () => new Promise(() => undefined));
			const turn = kernel.ctx.agent.runTurn({ text: 'go', surface: 'test' });
			await until(() => Boolean(kernel.ctx.sessions.active()?.cursor));
			assert.strictEqual(kernel.ctx.agent.stop(), true);
			const result = await within(turn);
			assert.strictEqual(result.stopped, true);
			const session = kernel.ctx.sessions.active();
			assert.strictEqual(session?.cursor, null);
			const tool = session?.transcript.find((message): message is Message => message.role === 'tool');
			assert.strictEqual(tool?.content, 'Stopped by the user.', 'the pending call still has a result');
		} finally {
			await kernel.dispose();
		}
	});

	test('a reused synthetic call id still gets a result when the turn is stopped', async () => {
		const kernel = await createTestKernel({ config: { mode: 'aw', approval: 'manual' } });
		try {
			kernel.ctx.tools.register({
				name: 'probe',
				description: 'needs approval',
				capability: 'ro',
				needsNetwork: false,
				needsWorkspace: false,
				parameters: objectSchema({}, []),
				execute: async () => 'ran',
			});
			kernel.ctx.llm.use({
				name: 'cancel-test',
				async chat() {
					const call = { id: 'call_0', name: 'probe', arguments: '{}' };
					return {
						message: { role: 'assistant', content: '', toolCalls: [call] },
						toolCalls: [call],
						usage: { input: 1, output: 1 },
					};
				},
			});
			// An endpoint that omits ids gives every response its own call_0. An older turn already
			// answered one, and that result must not be mistaken for this turn's pending call.
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'reused-id');
			session.transcript = [
				{ role: 'user', content: 'one', at: 1 },
				{ role: 'assistant', content: '', at: 2, toolCalls: [{ id: 'call_0', name: 'probe', arguments: '{}' }] },
				{ role: 'tool', toolCallId: 'call_0', content: 'old result', at: 3 },
				{ role: 'assistant', content: 'done', at: 4 },
			];
			kernel.ctx.sessions.save(session);
			kernel.ctx.on('approval/request', () => new Promise(() => undefined));
			const turn = kernel.ctx.agent.runTurn({ text: 'two', sessionId: 'reused-id', surface: 'test' });
			await until(() => Boolean(kernel.ctx.sessions.require('reused-id').cursor));
			assert.strictEqual(kernel.ctx.agent.stop(), true);
			const result = await within(turn);
			assert.strictEqual(result.stopped, true);
			const transcript = kernel.ctx.sessions.require('reused-id').transcript;
			assert.strictEqual(transcript[transcript.length - 1]?.role, 'tool', 'the answer ends with a tool result');
			assert.strictEqual(transcript[transcript.length - 1]?.content, 'Stopped by the user.');
			assert.strictEqual(
				transcript.filter((message) => message.role === 'tool' && message.toolCallId === 'call_0').length,
				2,
				'both the old and the pending call were answered',
			);
		} finally {
			await kernel.dispose();
		}
	});

	test('an already-aborted approval never reaches a surface', async () => {
		const kernel = await createTestKernel();
		try {
			let asked = 0;
			kernel.ctx.on('approval/request', () => {
				asked += 1;
				return 'allow';
			});
			const controller = new AbortController();
			controller.abort();
			const answer = await kernel.ctx.approval.request({
				calls: [],
				reason: 'none',
				sessionId: 's',
				signal: controller.signal,
			});
			assert.strictEqual(answer, 'deny');
			assert.strictEqual(asked, 0);
		} finally {
			await kernel.dispose();
		}
	});

	test('run_shell stops a command when the turn signal aborts', async () => {
		const kernel = await createTestKernel();
		try {
			await kernel.ctx.plugin(shellTools);
			const spec = kernel.ctx.tools.get('run_shell');
			assert.ok(spec);
			const controller = new AbortController();
			const started = Date.now();
			const running = spec.execute({ command: 'sleep 30' }, context(kernel, controller.signal));
			setTimeout(() => controller.abort(), 100);
			const result = await within(running, 3_000);
			assert.match(String(result), /exit_code:/);
			assert.ok(Date.now() - started < 3_000, 'the command did not run to its own timeout');
		} finally {
			await kernel.dispose();
		}
	});

	test('runProcess aborts the whole process group, including a background child', async () => {
		if (process.platform === 'win32') {
			return;
		}
		const dir = mkdtempSync(join(tmpdir(), 'comonad-cancel-'));
		const pidFile = join(dir, 'child.pid');
		const controller = new AbortController();
		try {
			const running = runProcess(
				['/bin/sh', '-c', `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`],
				dir,
				60_000,
				process.env,
				controller.signal,
			);
			await until(() => existsSync(pidFile));
			const child = Number(readFileSync(pidFile, 'utf8').trim());
			assert.ok(alive(child), 'the background child is running');
			controller.abort();
			const result = await within(running, 3_000);
			assert.strictEqual(result.aborted, true);
			await until(() => !alive(child));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('the webview turns Stop into a stopping state and withdraws approvals', () => {
		const guest = readFileSync(join(__dirname, '..', '..', 'resources', 'chat.js'), 'utf8');
		assert.match(guest, /function requestStop/);
		assert.match(guest, /Stopping…/);
		assert.match(guest, /A turn is still running in this chat/);
		assert.match(guest, /case 'approval-withdraw'/);
		assert.match(guest, /function withdrawApprovals/);
		const css = readFileSync(join(__dirname, '..', '..', 'resources', 'chat.css'), 'utf8');
		assert.match(css, /#stop:disabled/);
	});
});
