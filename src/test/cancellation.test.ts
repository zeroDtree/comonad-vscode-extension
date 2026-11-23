// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abortable } from '../lib/cancel';
import { runGraph, type CompiledGraph } from '../lib/graph';
import { runProcess } from '../lib/sandbox';
import { objectSchema, type Message, type ToolCall, type ToolContext } from '../lib/types';
import { shellTools } from '../tools/shell';
import { todoTools } from '../tools/todo';
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
		batch: 0,
		workspace: kernel.host.workspace(),
		policy: kernel.ctx.agent.policyFor(),
		signal,
		log: () => undefined,
		ask: async () => [],
		todos: () => [],
		tasks: kernel.ctx.tasks,
		spawnAgent: async () => ({ ok: true, report: '', writes: [] }),
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
		// This checks the abort path, not the sandbox; full access keeps it runnable without bwrap.
		const kernel = await createTestKernel({ config: { sandboxMode: 'danger-full-access', network: true } });
		try {
			await kernel.ctx.plugin(shellTools);
			const spec = kernel.ctx.tools.get('run_shell');
			assert.ok(spec);
			const controller = new AbortController();
			const started = Date.now();
			const base = context(kernel, controller.signal);
			// Pass the full-access policy on the call itself as well: this test needs a runnable
			// command on a CI host with no bwrap, and it is about the abort, not the sandbox.
			const running = spec.execute(
				{ command: 'sleep 30' },
				{ ...base, policy: { ...base.policy, sandboxMode: 'danger-full-access', network: true } },
			);
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

	test('the webview turns Stop into a stopping state and withdraws approvals and questions', () => {
		const guest = readFileSync(join(__dirname, '..', '..', 'resources', 'chat.js'), 'utf8');
		assert.match(guest, /function requestStop/);
		assert.match(guest, /Stopping…/);
		assert.match(guest, /A turn is still running in this chat/);
		assert.match(guest, /case 'approval-withdraw'/);
		assert.match(guest, /function withdrawApprovals/);
		assert.match(guest, /function question\(/);
		assert.match(guest, /function settleQuestion/);
		assert.match(guest, /function withdrawQuestions/);
		assert.match(guest, /case 'question'/);
		assert.match(guest, /case 'question-withdraw'/);
		assert.match(guest, /type: 'answer'/);
		const css = readFileSync(join(__dirname, '..', '..', 'resources', 'chat.css'), 'utf8');
		assert.match(css, /#stop:disabled/);
		assert.match(css, /\.question-card/);
		assert.match(css, /\.q-option/);
		assert.match(css, /\.q-input/);
		const panel = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'chat-panel.ts'), 'utf8');
		assert.match(panel, /question\/request/);
		assert.match(panel, /case 'answer':/);
		assert.match(panel, /postPendingQuestions/);
	});

	test('the question card accepts a typed answer beside its options', () => {
		const root = join(__dirname, '..', '..');
		const guest = readFileSync(join(root, 'resources', 'chat.js'), 'utf8');
		assert.match(guest, /q-manual/);
		assert.match(guest, /function submitQuestion/);
		assert.match(guest, /type: 'answer', id: card\.dataset\.id, answers, \.\.\.\(manual \? \{ manual \} : \{\}\)/);
		const css = readFileSync(join(root, 'resources', 'chat.css'), 'utf8');
		assert.match(css, /\.q-manual/);
		const panel = readFileSync(join(root, 'src', 'ui', 'chat-panel.ts'), 'utf8');
		assert.match(panel, /sanitizeQuestionAnswers\(message\.answers, pending\.options, pending\.multi, message\.manual\)/);
	});

	test('a state snapshot cannot outlive the turn it describes', () => {
		const panel = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'chat-panel.ts'), 'utf8');
		assert.match(panel, /const state = \(\): Record<string, unknown> => \{/);
		const start = panel.indexOf('const state = ');
		const end = panel.indexOf('/** run_shell_readonly', start);
		assert.ok(start >= 0 && end > start, 'state() sits before the shell helpers');
		const body = panel.slice(start, end);
		assert.ok(!/\bawait\b/.test(body), 'the snapshot has no suspension point');
		assert.ok(!body.includes('availableModels'), 'the model list is not part of the snapshot');
		const refresh = panel.slice(panel.indexOf('const refreshState ='), panel.indexOf('// Pending checkpoint changes'));
		assert.match(refresh, /post\(state\(\)\)/, 'the snapshot is posted, not awaited');
		assert.ok(!panel.includes('await state()'), 'no sender waits before posting a snapshot');
	});

	test('a finished model step repaints the status line without rebuilding the snapshot', () => {
		const root = join(__dirname, '..', '..');
		const guest = readFileSync(join(root, 'resources', 'chat.js'), 'utf8');
		const mark = guest.indexOf('function renderStatus()');
		const render = guest.indexOf('function renderState()');
		assert.ok(mark >= 0 && mark < render, 'renderStatus is defined before renderState');
		const status = guest.slice(mark, render);
		assert.match(status, /state\.suspended/);
		assert.match(status, /\$\('status'\)\.textContent = detail/);
		const renderBody = guest.slice(render, guest.indexOf('/** The pending or reviewed changes'));
		assert.match(renderBody, /renderStatus\(\)/);
		assert.ok(!renderBody.includes("$('status').textContent"), 'the snapshot paints through the helper');
		const handler = guest.slice(guest.indexOf("case 'status':"), guest.indexOf("case 'models':"));
		assert.match(handler, /message\.sessionId === state\.sessionId/);
		assert.match(handler, /state\.detail = typeof message\.detail === 'string'/);
		assert.match(handler, /renderStatus\(\)/);
		assert.ok(!handler.includes('renderState()'), 'a status message never rebuilds the snapshot');

		const panel = readFileSync(join(root, 'src', 'ui', 'chat-panel.ts'), 'utf8');
		const listener = panel.slice(panel.indexOf("ctx.on('agent/usage'"), panel.indexOf("ctx.on('agent/subagent-start'"));
		assert.match(listener, /type: 'status'/);
		assert.match(listener, /sessionId: ref\.sessionId/);
		assert.match(listener, /statusDetail\(measured, measured\.window\)/);
		assert.ok(!listener.includes('refreshState'), 'the update is not a full refresh');
		assert.ok(!listener.includes('sessions.active'), 'the update does not read the chat back from disk');
	});

	test('the model list is fetched off the state path and posted on its own', () => {
		const root = join(__dirname, '..', '..');
		const panel = readFileSync(join(root, 'src', 'ui', 'chat-panel.ts'), 'utf8');
		assert.match(panel, /const refreshModels = \(\): void => \{/);
		assert.match(panel, /modelsInFlight/);
		assert.match(panel, /modelsDirty/);
		assert.match(panel, /type: 'models', models: lastModels/);
		const refresh = panel.slice(panel.indexOf('const refresh = '), panel.indexOf('const resyncClient'));
		assert.match(refresh, /refreshModels\(\)/, 'a refresh also refreshes the list');
		const guest = readFileSync(join(root, 'resources', 'chat.js'), 'utf8');
		assert.match(guest, /case 'models':/);
		assert.match(guest, /modelState\.models = Array\.isArray\(message\.models\)/);
		assert.match(guest, /function planModelChoices\(\) \{\s*return modelState\.models;/);
		assert.ok(!/modelState\.models\s*=\s*state\.models/.test(guest), 'a state message cannot clear a newer list');
	});

	test('a chat panel resyncs from the session when it is shown again', () => {
		const panel = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'chat-panel.ts'), 'utf8');
		const opened = panel.slice(panel.indexOf('const openPanel ='), panel.indexOf('// The chat view lives'));
		assert.match(opened, /onDidChangeViewState/);
		assert.match(opened, /created\.visible === shown/, 'an active change in a visible tab does not replay');
		assert.match(opened, /resyncClient\(created\.webview\)/);
		const view = panel.slice(panel.indexOf('onDidChangeVisibility'), panel.indexOf('attach(webviewView.webview)'));
		assert.match(view, /resyncClient\(webviewView\.webview\)/, 'one resync path for view and panel');
	});

	test('a stop the host could not perform clears the guest turn instead of wedging it', () => {
		const root = join(__dirname, '..', '..');
		const guest = readFileSync(join(root, 'resources', 'chat.js'), 'utf8');
		const ack = guest.slice(guest.indexOf("case 'stop-ack':"), guest.indexOf("case 'turn-end':"));
		assert.match(ack, /message\.running/);
		assert.match(ack, /runningSession = null/);
		assert.match(ack, /setRunning\(false\)/);
		assert.match(ack, /requestResync\(true\)/);
		const panel = readFileSync(join(root, 'src', 'ui', 'chat-panel.ts'), 'utf8');
		assert.match(panel, /post\(\{ type: 'stop-ack', ok, running \}, source\)/);
		assert.match(panel, /stopped \|\|= ok/, 'a second Stop cannot un-stop a stopped turn');
	});

	test('a waiting question survives a closed panel and notifies once', () => {
		const panel = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'chat-panel.ts'), 'utf8');
		assert.match(panel, /if \(request\.signal\.aborted\) \{\s*return \[\];/);
		assert.ok(!/!clients\.size \|\| request\.signal\.aborted/.test(panel), 'a closed panel does not answer');
		assert.match(panel, /if \(!clients\.size\) \{\s*notifyQuestion\(pending\);/);
		assert.match(panel, /notifyQuestion\(question\)/, 'detach notifies instead of resolving');
		assert.ok(!/question\.resolve\(\[\]\)/.test(panel), 'a pending question is not discarded');
		assert.ok(!/questions\.clear\(\)/.test(panel), 'the pending map survives a detach');
		assert.match(panel, /approval\.resolve\('deny'\)/, 'approvals still fail closed');
		assert.match(panel, /pending\.notified/);
		assert.match(panel, /questionNotification/);
		assert.match(panel, /showInformationMessage\([\s\S]*?'Open Chat'/);
		assert.match(panel, /sessions\.setActive\(pending\.sessionId\)/);
		assert.match(panel, /executeCommand\('comonad\.openChat'\)/);
	});

	test('a first turn names the chat it runs in before the panel draws it', () => {
		const panel = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'chat-panel.ts'), 'utf8');
		const start = panel.indexOf('const send = async');
		const end = panel.indexOf('const generate = async');
		assert.ok(start >= 0 && end > start, 'send() sits before generate()');
		const body = panel.slice(start, end);
		const ensure = body.indexOf('ensureActive(ctx.agent.policyFor())');
		const assign = body.indexOf('runningSessionId = session.id');
		const draw = body.indexOf("type: 'turn-start'");
		assert.ok(ensure >= 0, 'send resolves the chat a first prompt runs in');
		assert.ok(assign > ensure && draw > assign, 'the drawn turn carries that chat id');
		assert.match(body, /sessionId: session\.id/, 'the turn runs in the chat it announced');
	});

	test('the webview re-links tool cards after a redraw and reuses a re-attached call', () => {
		const guest = readFileSync(join(__dirname, '..', '..', 'resources', 'chat.js'), 'utf8');
		assert.match(guest, /function mapToolCards\(turn\)/);
		const resume = guest.slice(guest.indexOf('function resumeLive(turn)'), guest.indexOf('subagent overlay'));
		assert.match(resume, /mapToolCards\(turn\)/, 'a resumed turn maps its cards');
		const end = guest.slice(guest.indexOf('function endTurn(message)'), guest.indexOf('approvals */'));
		assert.match(end, /mapToolCards\(turn\)/, 'a settled redraw maps its cards');
		const start = guest.slice(guest.indexOf('function toolStart(message)'), guest.indexOf('function toolResult(message)'));
		assert.match(start, /step\.id === message\.id/);
		assert.match(start, /step\.result === undefined/);
		assert.match(start, /toolCards\.set\(message\.id, known\)/, 'a re-attached call keeps its card');
	});

	test('a pre-announced draft is the chat the turn writes to', async () => {
		const kernel = await createTestKernel();
		try {
			assert.strictEqual(kernel.ctx.sessions.active(), undefined, 'the workspace starts with no chat');
			assert.strictEqual(kernel.ctx.sessions.list().length, 0);
			const session = kernel.ctx.sessions.ensureActive(kernel.ctx.agent.policyFor());
			assert.strictEqual(kernel.ctx.sessions.active()?.id, session.id, 'the draft is the active chat');
			assert.strictEqual(kernel.ctx.sessions.list().length, 0, 'an unused draft is not history');
			kernel.ctx.llm.use({
				name: 'draft-test',
				async chat() {
					return { message: { role: 'assistant', content: 'ok' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const announced: string[] = [];
			kernel.ctx.on('agent/turn-start', (ref) => announced.push(ref.sessionId));
			const result = await kernel.ctx.agent.runTurn({ text: 'go', sessionId: session.id, surface: 'panel' });
			assert.deepStrictEqual(announced, [session.id], 'the turn runs in the chat the panel was told about');
			assert.strictEqual(result.sessionId, session.id);
			assert.deepStrictEqual(kernel.ctx.sessions.list().map((item) => item.id), [session.id], 'the used draft is now history');
		} finally {
			await kernel.dispose();
		}
	});
});

suite('Turn settlement', () => {
	const todoCall = (id: string, items: Array<{ text: string; status: string }>): ToolCall => ({
		id,
		name: 'todo_write',
		arguments: JSON.stringify({ items }),
	});

	const reply = (content: string): { message: Message; toolCalls: ToolCall[]; usage: { input: number; output: number } } => ({
		message: { role: 'assistant', content },
		toolCalls: [],
		usage: { input: 1, output: 1 },
	});

	test('a turn that finishes with an item in progress asks the model to close the list', async () => {
		const kernel = await createTestKernel({ config: { mode: 'aw', approval: 'universal_accept' } });
		try {
			await kernel.ctx.plugin(todoTools);
			const requests: Message[][] = [];
			kernel.ctx.llm.use({
				name: 'todo-reminder',
				async chat(request) {
					requests.push(request.messages);
					if (requests.length === 1) {
						return {
							...reply(''),
							toolCalls: [todoCall('w1', [{ text: 'review the diff', status: 'in_progress' }, { text: 'summarize', status: 'pending' }])],
						};
					}
					if (requests.length === 2) {
						return reply('Summary.');
					}
					if (requests.length === 3) {
						return {
							...reply(''),
							toolCalls: [todoCall('w2', [{ text: 'review the diff', status: 'completed' }, { text: 'summarize', status: 'pending' }])],
						};
					}
					return reply('Done.');
				},
			});
			const session = kernel.ctx.sessions.ensureActive(kernel.ctx.agent.policyFor());
			const result = await kernel.ctx.agent.runTurn({ text: 'go', sessionId: session.id, surface: 'test' });
			assert.strictEqual(result.stopped, undefined);
			assert.strictEqual(requests.length, 4, 'a reminder round and the tool round it asks for');
			assert.ok(
				requests[2].some((message) => /\(hook\).*todo list still has/i.test(message.content)),
				'the reminder names the unfinished list',
			);
			assert.deepStrictEqual(kernel.ctx.agent.todos(session.id).map((item) => item.status), ['completed', 'pending']);
		} finally {
			await kernel.dispose();
		}
	});

	test('the reminder is one round, not a loop, and never rewrites the list itself', async () => {
		const kernel = await createTestKernel({ config: { mode: 'aw', approval: 'universal_accept' } });
		try {
			await kernel.ctx.plugin(todoTools);
			let requests = 0;
			kernel.ctx.llm.use({
				name: 'todo-reminder-ignored',
				async chat() {
					requests += 1;
					if (requests === 1) {
						return { ...reply(''), toolCalls: [todoCall('w1', [{ text: 'review the diff', status: 'in_progress' }])] };
					}
					return reply('Summary.');
				},
			});
			const session = kernel.ctx.sessions.ensureActive(kernel.ctx.agent.policyFor());
			const result = await kernel.ctx.agent.runTurn({ text: 'go', sessionId: session.id, surface: 'test' });
			assert.strictEqual(result.stopped, undefined);
			assert.strictEqual(requests, 3, 'one reminder, then the turn settles even if the model ignores it');
			assert.deepStrictEqual(kernel.ctx.agent.todos(session.id).map((item) => item.status), ['in_progress'], 'the host does not rewrite statuses');
		} finally {
			await kernel.dispose();
		}
	});

	test('a list with nothing in progress costs no extra round', async () => {
		const kernel = await createTestKernel({ config: { mode: 'aw', approval: 'universal_accept' } });
		try {
			await kernel.ctx.plugin(todoTools);
			let requests = 0;
			kernel.ctx.llm.use({
				name: 'todo-reminder-quiet',
				async chat() {
					requests += 1;
					if (requests === 1) {
						return { ...reply(''), toolCalls: [todoCall('w1', [{ text: 'review the diff', status: 'completed' }])] };
					}
					return reply('Summary.');
				},
			});
			const session = kernel.ctx.sessions.ensureActive(kernel.ctx.agent.policyFor());
			await kernel.ctx.agent.runTurn({ text: 'go', sessionId: session.id, surface: 'test' });
			assert.strictEqual(requests, 2);
		} finally {
			await kernel.dispose();
		}
	});
});

suite('Idle chat panel', () => {
	test('a replay re-attaches only when the host says the chat is running', () => {
		const root = join(__dirname, '..', '..');
		const guest = readFileSync(join(root, 'resources', 'chat.js'), 'utf8');
		const render = guest.slice(guest.indexOf('function renderTurns('), guest.indexOf('/** Registers a drawn turn'));
		assert.match(render, /function renderTurns\(list, sessionId, summary, page, runningHere\)/);
		assert.match(render, /if \(runningHere && lastTurn && lastTurn\.live\) \{\s*resumeLive\(lastTurn\);/);
		assert.ok(!/\brunningSession\b/.test(render), 'the guest cannot re-arm a drawn turn from stale memory');
		const turns = guest.slice(guest.indexOf("case 'turns':"), guest.indexOf("case 'summary':"));
		assert.match(turns, /message\.running === true/);
		const state = guest.slice(guest.indexOf('function renderState()'), guest.indexOf('/** The pending or reviewed changes'));
		assert.match(state, /renderTurns\(turns, state && state\.sessionId, summaryInfo, pageInfo, false\)/);
		assert.match(state, /runningSession = state\.running \? state\.runningSessionId \|\| runningSession : null;/);
		const end = guest.slice(guest.indexOf("case 'turn-end':"), guest.indexOf("case 'insertReference':"));
		assert.match(end, /!live\.turn\.sessionId/);

		const panel = readFileSync(join(root, 'src', 'ui', 'chat-panel.ts'), 'utf8');
		const published = panel.slice(panel.indexOf('const publishTurns ='), panel.indexOf('/** A subagent'));
		assert.match(published, /running: session !== undefined && running && runningSessionId === session\.id/);
		const history = panel.slice(panel.indexOf('const history = '), panel.indexOf('/** The turn that just finished'));
		assert.match(history, /sessionId: session\.id/);
	});

	test('a mid-turn summary cannot fold the live turn', () => {
		const root = join(__dirname, '..', '..');
		const guest = readFileSync(join(root, 'resources', 'chat.js'), 'utf8');
		// A live turn has no transcript boundary; inventing one let updateSummaryDetails treat it
		// as covered and hide it (with its approval/question cards) under "Show original messages".
		const begin = guest.slice(guest.indexOf('function beginTurn('), guest.indexOf('function paint('));
		assert.doesNotMatch(begin, /at: 0\b/, 'a live turn has no transcript boundary to be covered');

		const details = guest.slice(guest.indexOf('function updateSummaryDetails('), guest.indexOf('function renderLoadOlder('));
		assert.match(details, /if \(summary && Number\.isFinite\(turn\.at\) && turn\.at <= covers\)\s*\{/);

		// The boundary the host reports at turn-end is what lets a later summary fold a settled turn.
		const end = guest.slice(guest.indexOf('function endTurn('), guest.indexOf('approvals */'));
		assert.match(end, /if \(Number\.isFinite\(message\.at\)\) \{\s*turn\.at = message\.at;/);

		const panel = readFileSync(join(root, 'src', 'ui', 'chat-panel.ts'), 'utf8');
		const settled = panel.slice(panel.indexOf('const settledTurn ='), panel.indexOf('/** The transcript each panel'));
		assert.match(settled, /at\?: number/);
		assert.match(settled, /at: last\.at/, 'turn-end carries the settled transcript boundary');
	});
});
