import * as assert from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileGraphs, runGraph, type GraphRuntime } from '../lib/graph';
import { DEFAULT_GRAPH_SOURCE, parseGraphSource } from '../lib/mermaid';
import { APPROVAL_LABELS, gateCalls, gateFlow, isDangerous, modeCapabilities, MODE_CAPS, MODE_LABELS, parseRule, parseRules, presetPolicy, ruleMatches, suggestAllowRule } from '../lib/policy';
import { applyContextForm, applyContextLimit } from '../lib/prompt';
import { isProtectedPath, PathEscapeError, resolveInside, sanitizedEnv } from '../lib/sandbox';
import { parseFrontmatter } from '../lib/frontmatter';
import { listEndpointModels, openAiChat } from '../lib/openai';
import type { ApprovalRequest, Message, SessionPolicy, ToolCall, ToolSpec, WorkMode } from '../lib/types';
import { objectSchema } from '../lib/types';
import { turnsOf } from '../lib/turns';
import { parseUnified } from '../services/checkpoints';
import { SessionStore, unusedChat } from '../services/sessions';
import { formatModelId, parseModelId, shapeModels } from '../services/llm';
import { profileKeyEnvs } from '../services/settings';
import { toolset } from '../services/tools';
import { cardTextFromPng, characterToCard, greetingsOf, loadCard, normaliseCard, parseCard, readPngText, writePngText } from '../lib/tavern/card';
import { adoptBook, adoptCharacter, adoptPersona, adoptPreset, blankBook, blankCharacter, blankPersona, blankPreset } from '../lib/tavern/authoring';
import { readBookFile } from '../services/tavern';
import { parseExamples, substituteMacros } from '../lib/tavern/macro';
import { parsePreset, presetSamplers, presetToJson } from '../lib/tavern/preset';
import { DEFAULT_ORDER, IDENTITY_PROMPT, movePrompt, promptCollection, setEnabled } from '../lib/tavern/prompts';
import { activateLore, toWorldBook, worldInfoToBook, type LoreBook, type LoreInput } from '../lib/tavern/lore';
import { assemble, exampleMessages, injectAtDepth } from '../lib/tavern/assemble';
import { applyRegex, makeScript } from '../lib/tavern/regex';
import { REGEX_PLACEMENT, WI_LOGIC, WI_POSITION, WI_ROLE, WI_SETTINGS_DEFAULTS, WI_STRATEGY, worldEntry, type WorldEntry } from '../lib/tavern/types';
import { createTestKernel } from './harness';

const readTool: ToolSpec = {
	name: 'read_file',
	description: '',
	parameters: { type: 'object', properties: {} },
	capability: 'ro',
	needsNetwork: false,
	needsWorkspace: true,
	execute: async () => '',
};

const writeTool: ToolSpec = { ...readTool, name: 'write_file', capability: 'rw' };

const shellTool: ToolSpec = { ...readTool, name: 'run_shell', capability: 'shell_rw' };

const unsandboxedTool: ToolSpec = { ...readTool, name: 'run_shell_unsandboxed', capability: 'shell_rw' };

const lookup = (name: string): ToolSpec | undefined => [readTool, writeTool, shellTool, unsandboxedTool].find((tool) => tool.name === name);

const policy = (patch: Partial<SessionPolicy> = {}): SessionPolicy => ({
	workMode: 'sw',
	approval: 'manual',
	network: false,
	workingDirectory: '/tmp/workspace',
	commandTimeout: 60,
	denyReadPaths: [],
	model: 'auto',
	...patch,
});

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: '1', name, arguments: JSON.stringify(args) });

suite('Comonad domain', () => {
	test('policy presets', () => {
		assert.deepStrictEqual(presetPolicy('plan'), { workMode: 'pl', approval: 'whitelist_accept', network: false });
		assert.deepStrictEqual(presetPolicy('auto'), { workMode: 'aw', approval: 'universal_accept', network: false });
		assert.strictEqual(presetPolicy('full').network, true);
	});

	test('manual approval confirms and universal reject rejects', () => {
		const manual = gateCalls([call('read_file', { path: 'a.ts' })], lookup, policy(), { allow: [], ask: [], deny: [] });
		assert.strictEqual(manual.decision, 'confirm');
		const rejected = gateCalls([call('read_file', { path: 'a.ts' })], lookup, policy({ approval: 'universal_reject' }), {
			allow: [],
			ask: [],
			deny: [],
		});
		assert.strictEqual(rejected.decision, 'reject');
	});

	test('whitelist accepts reads and asks for writes', () => {
		const rules = { allow: [], ask: [], deny: [] };
		assert.strictEqual(gateCalls([call('read_file', { path: 'a.ts' })], lookup, policy({ approval: 'whitelist_accept' }), rules).decision, 'allow');
		assert.strictEqual(gateCalls([call('write_file', { path: 'a.ts' })], lookup, policy({ approval: 'whitelist_accept' }), rules).decision, 'confirm');
	});

	test('the whitelist is the allow list, not a read/write split', () => {
		const rules = parseRules({ allow: ['write_file(a.ts)'] });
		const whitelist = policy({ approval: 'whitelist_accept' });
		assert.strictEqual(gateCalls([call('write_file', { path: 'a.ts' })], lookup, whitelist, rules).decision, 'allow');
		assert.strictEqual(gateCalls([call('write_file', { path: 'b.ts' })], lookup, whitelist, rules).decision, 'confirm');
	});

	test('the blacklist starts with the write-capable tools', () => {
		const empty = { allow: [], ask: [], deny: [] };
		const blacklist = policy({ approval: 'blacklist_reject' });
		assert.strictEqual(gateCalls([call('read_file', { path: 'a.ts' })], lookup, blacklist, empty).decision, 'allow');
		assert.strictEqual(gateCalls([call('write_file', { path: 'a.ts' })], lookup, blacklist, empty).decision, 'reject');
		assert.strictEqual(gateCalls([call('run_shell', { command: 'ls' })], lookup, blacklist, empty).decision, 'reject');
		// A `permissions.deny` rule adds to the blacklist and rejects in every policy.
		const rules = parseRules({ deny: ['read_file(secret.ts)'] });
		assert.strictEqual(gateCalls([call('read_file', { path: 'secret.ts' })], lookup, blacklist, rules).decision, 'reject');
		assert.strictEqual(gateCalls([call('read_file', { path: 'secret.ts' })], lookup, policy({ approval: 'universal_accept' }), rules).decision, 'reject');
	});

	test('mode capabilities gate tools', () => {
		const rejected = gateCalls([call('write_file', { path: 'a.ts' })], lookup, policy({ workMode: 'ro' }), { allow: [], ask: [], deny: [] });
		assert.strictEqual(rejected.decision, 'reject');
		assert.match(rejected.reason, /not allowed in mode ro/);
	});

	test('every work mode grants exactly the capabilities its label promises', () => {
		const caps = (mode: WorkMode) => [...MODE_CAPS[mode]].sort();
		assert.deepStrictEqual(caps('chat'), [], 'chat only has no tools at all');
		assert.deepStrictEqual(caps('ro'), ['ro', 'shell_ro']);
		assert.deepStrictEqual(caps('sw'), ['ro', 'rw', 'shell_ro']);
		assert.deepStrictEqual(caps('aw'), ['ro', 'rw', 'shell_ro', 'shell_rw']);
		assert.deepStrictEqual(caps('pl'), ['ro', 'rw_plan', 'shell_ro']);
		assert.match(MODE_LABELS.chat, /Chat Only — no tools/);
		assert.match(MODE_LABELS.ro, /Read-Only — read files, read-only shell/);
		assert.match(MODE_LABELS.sw, /Semi-Write — write files, read-only shell/);
		assert.match(MODE_LABELS.aw, /Full Access — write files, full shell/);
		assert.match(MODE_LABELS.pl, /Plan — read files, read-only shell, writes plan files only/);
	});

	test('deny rules win over accept policies', () => {
		const rules = parseRules({ deny: ['run_shell(rm:*)'] });
		const result = gateCalls([call('run_shell', { command: 'rm -rf build' })], lookup, policy({ approval: 'universal_accept', workMode: 'aw' }), rules);
		assert.strictEqual(result.decision, 'reject');
	});

	test('allow rules satisfy manual approval when they match', () => {
		const rules = parseRules({ allow: ['read_file(./src/**)'] });
		assert.strictEqual(gateCalls([call('read_file', { path: 'src/a.ts' })], lookup, policy(), rules).decision, 'allow');
		assert.strictEqual(gateCalls([call('read_file', { path: 'docs/a.md' })], lookup, policy(), rules).decision, 'confirm');
	});

	test('rule syntax matches commands, paths and domains', () => {
		assert.ok(ruleMatches(parseRule('run_shell(npm run test:*)')!, call('run_shell', { command: 'npm run test:unit' }), shellTool));
		assert.ok(ruleMatches(parseRule('read_file(./.env)')!, call('read_file', { path: '.env' }), readTool));
		assert.ok(!ruleMatches(parseRule('read_file(./.env)')!, call('read_file', { path: 'src/.env.local' }), readTool));
		assert.ok(ruleMatches(parseRule('fetch_url(domain:example.com)')!, call('fetch_url', { url: 'https://example.com/docs' }), undefined));
	});

	test('suggestAllowRule builds usable rules', () => {
		assert.strictEqual(suggestAllowRule(call('run_shell', { command: 'npm run build' }), shellTool), 'run_shell(npm run:*)');
		assert.strictEqual(suggestAllowRule(call('write_file', { path: 'src/a.ts' }), writeTool), 'write_file(src/a.ts)');
	});

	test('default graph parses and compiles', () => {
		const config = parseGraphSource(DEFAULT_GRAPH_SOURCE);
		assert.strictEqual(config.default, 'agent');
		const graph = compileGraphs(config, { nodes: new Map(), routes: new Map() }, { ignoreMissing: true });
		assert.ok(graph.get('agent')?.nodes.has('llm'));
	});

	test('graphs run, suspend and resume', async () => {
		const source = `flowchart TD
  %% start: step
  step["gate"] --> endNode["finish"]
  endNode --> End
`;
		const config = parseGraphSource(source);
		let suspended = false;
		const registry = {
			nodes: new Map<string, (state: { value: number }, runtime: GraphRuntime) => Promise<{ value: number }>>([
				[
					'gate',
					async (state, runtime) => {
						if (!runtime.resuming) {
							suspended = true;
							runtime.suspend('ask');
						}
						return { value: state.value + 1 };
					},
				],
				['finish', async (state) => ({ value: state.value + 10 })],
			]),
			routes: new Map(),
		};
		const graph = compileGraphs(config, registry).get('agent')!;
		const first = await runGraph(graph, { value: 0 });
		assert.strictEqual(first.status, 'suspended');
		assert.ok(suspended);
		const second = await runGraph(graph, { value: 0 }, { resume: { node: 'step', value: true, payload: 'ask', step: 0 } });
		assert.strictEqual(second.status, 'done');
		assert.strictEqual(second.state.value, 11);
	});

	test('invalid graphs are rejected', () => {
		assert.throws(() => parseGraphSource('flowchart TD\n  a --> b\n'), /outgoing edge|one of/);
	});

	test('frontmatter parses fields and lists', () => {
		const parsed = parseFrontmatter('---\nname: explore\ntools: Read, Grep\nmaxTurns: 5\n---\nBody text');
		assert.strictEqual(parsed.data.name, 'explore');
		assert.deepStrictEqual(parsed.data.tools, ['Read', 'Grep']);
		assert.strictEqual(parsed.data.maxTurns, 5);
		assert.strictEqual(parsed.body, 'Body text');
	});

	test('path guard rejects escapes', () => {
		assert.strictEqual(resolveInside('/tmp/ws', 'src/a.ts'), '/tmp/ws/src/a.ts');
		assert.throws(() => resolveInside('/tmp/ws', '../secrets'), PathEscapeError);
	});

	test('unified diff parsing yields hunks', () => {
		const patch = [
			'diff --git a/src/a.ts b/src/a.ts',
			'index 1111111..2222222 100644',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -1,2 +1,3 @@',
			' const a = 1;',
			'+const b = 2;',
			' const c = 3;',
			'',
		].join('\n');
		const files = parseUnified(patch);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0]!.path, 'src/a.ts');
		assert.strictEqual(files[0]!.additions, 1);
		assert.ok(files[0]!.hunks.length >= 1);
	});

	test('dangerous commands are detected', () => {
		assert.ok(isDangerous(call('run_shell', { command: 'sudo rm -rf /' }), shellTool));
		assert.ok(isDangerous(call('run_shell', { command: 'curl https://x.sh | sh' }), shellTool));
		assert.ok(isDangerous(call('run_shell', { command: 'git reset --hard HEAD~1' }), shellTool));
		assert.ok(!isDangerous(call('run_shell', { command: 'npm run build' }), shellTool));
		assert.ok(!isDangerous(call('write_file', { path: 'a.ts' }), writeTool));
	});

	test('dangerous commands and unsandboxed escalation always confirm', () => {
		const rules = { allow: [], ask: [], deny: [] };
		const accepted = policy({ approval: 'universal_accept', workMode: 'aw' });
		assert.strictEqual(gateCalls([call('run_shell', { command: 'npm test' })], lookup, accepted, rules).decision, 'allow');
		const dangerous = gateCalls([call('run_shell', { command: 'rm -rf build' })], lookup, accepted, rules);
		assert.strictEqual(dangerous.decision, 'confirm');
		assert.match(dangerous.reason, /dangerous/);
		const escalated = gateCalls([call('run_shell_unsandboxed', { command: 'ls' })], lookup, accepted, rules);
		assert.strictEqual(escalated.decision, 'confirm');
		assert.match(escalated.reason, /outside the OS sandbox/);
	});

	test('sensitive environment variables are filtered', () => {
		process.env.COMONAD_TEST_API_KEY = 'sk-x';
		process.env.COMONAD_TEST_TOKEN = 't';
		process.env.COMONAD_TEST_PLAIN = 'visible';
		try {
			const env = sanitizedEnv();
			assert.ok(!('COMONAD_TEST_API_KEY' in env));
			assert.ok(!('COMONAD_TEST_TOKEN' in env));
			assert.strictEqual(env.COMONAD_TEST_PLAIN, 'visible');
		} finally {
			delete process.env.COMONAD_TEST_API_KEY;
			delete process.env.COMONAD_TEST_TOKEN;
			delete process.env.COMONAD_TEST_PLAIN;
		}
	});

	test('.git paths are protected', () => {
		assert.ok(isProtectedPath('/tmp/ws', '/tmp/ws/.git/config'));
		assert.ok(isProtectedPath('/tmp/ws', '/tmp/ws/.git'));
		assert.ok(!isProtectedPath('/tmp/ws', '/tmp/ws/src/git.ts'));
	});

	test('the chain of thought is captured and passed back with the tools', async () => {
		const bodies: Record<string, unknown>[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (_url: string, init: { body: string }): Promise<Response> => {
			bodies.push(JSON.parse(init.body) as Record<string, unknown>);
			const sse = [
				'data: {"choices":[{"delta":{"reasoning_content":"thinking hard"}}]}',
				'data: {"choices":[{"delta":{"content":"the answer"}}]}',
				'data: {"choices":[{"delta":{}}]}',
				'data: [DONE]',
				'',
			].join('\n\n');
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(sse));
						controller.close();
					},
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		try {
			const first = await openAiChat({
				base: 'https://api.example.com/v1',
				key: 'k',
				model: 'm',
				messages: [{ role: 'user', content: 'hi' }],
				tools: [],
				signal: new AbortController().signal,
			});
			assert.strictEqual(first.message.reasoning, 'thinking hard', 'the reasoning is kept for the transcript');
			assert.strictEqual(first.message.content, 'the answer');

			// The next round of the tool loop carries that assistant message back. DeepSeek demands the
			// `reasoning_content` of every earlier turn when the request carries tools (400 otherwise),
			// and endpoints that do not know the field ignore it.
			await openAiChat({
				base: 'https://api.example.com/v1',
				key: 'k',
				model: 'm',
				messages: [{ role: 'user', content: 'hi' }, first.message],
				tools: [],
				signal: new AbortController().signal,
			});
			const sent = (bodies[1]!.messages as Record<string, unknown>[])[1]!;
			assert.strictEqual(sent.role, 'assistant');
			assert.strictEqual(sent.content, 'the answer');
			assert.strictEqual(sent.reasoning_content, 'thinking hard', 'thinking mode with tools requires it back');
		} finally {
			globalThis.fetch = original;
		}
	});

	test('the reasoning effort maps onto each provider\u2019s thinking switch', async () => {
		const bodies: Record<string, unknown>[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (_url: string, init: { body: string }): Promise<Response> => {
			bodies.push(JSON.parse(init.body) as Record<string, unknown>);
			return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
		}) as unknown as typeof fetch;
		const request = (effort: string, thinkingOff?: 'thinking' | 'effort'): Parameters<typeof openAiChat>[0] => ({
			base: 'https://api.deepseek.com',
			key: 'k',
			model: 'deepseek-flash',
			messages: [{ role: 'user', content: 'hi' }],
			tools: [],
			reasoningEffort: effort,
			thinkingOff,
			signal: new AbortController().signal,
		});
		try {
			await openAiChat(request('auto', 'thinking'));
			assert.ok(!('reasoning_effort' in bodies[0]!) && !('thinking' in bodies[0]!), 'auto leaves the provider default');
			await openAiChat(request('high', 'thinking'));
			assert.strictEqual(bodies[1]!.reasoning_effort, 'high');
			// DeepSeek enables thinking by default; only its own field turns it off.
			await openAiChat(request('none', 'thinking'));
			assert.deepStrictEqual(bodies[2]!.thinking, { type: 'disabled' });
			assert.ok(!('reasoning_effort' in bodies[2]!));
			// Gemini takes `reasoning_effort: "none"` instead.
			await openAiChat(request('none', 'effort'));
			assert.strictEqual(bodies[3]!.reasoning_effort, 'none');
			assert.ok(!('thinking' in bodies[3]!));
			// A provider that declares neither is left alone rather than sent a field it may reject.
			await openAiChat(request('none'));
			assert.ok(!('thinking' in bodies[4]!) && !('reasoning_effort' in bodies[4]!));
		} finally {
			globalThis.fetch = original;
		}
	});

	test('the endpoint model list is read in either shape', async () => {
		const original = globalThis.fetch;
		const calls: string[] = [];
		let payload: unknown = { object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] };
		globalThis.fetch = (async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
			calls.push(`${init.method} ${url} ${init.headers?.authorization ?? ''}`);
			return new Response(JSON.stringify(payload), { status: 200 });
		}) as unknown as typeof fetch;
		try {
			// OpenAI and Gemini wrap the ids in `data`; some compatible servers return a bare array.
			const wrapped = await listEndpointModels({ base: 'https://api.deepseek.com/', key: 'k', signal: new AbortController().signal });
			assert.deepStrictEqual(wrapped, ['deepseek-flash', 'deepseek-v4-pro'], 'sorted, without the duplicate');
			assert.strictEqual(calls[0], 'GET https://api.deepseek.com/models Bearer k');
			payload = [{ id: 'a' }, 'b'];
			assert.deepStrictEqual(await listEndpointModels({ base: 'http://localhost:11434/v1', key: '', signal: new AbortController().signal }), ['a', 'b']);
			assert.strictEqual(calls[1], 'GET http://localhost:11434/v1/models ', 'no key, no authorization header');
			assert.deepStrictEqual(await listEndpointModels({ base: '', key: 'k', signal: new AbortController().signal }), [], 'no base URL, no request');
		} finally {
			globalThis.fetch = original;
		}
	});

	test('an endpoint list is shaped by the profile, not by provider code', () => {
		// Gemini answers its native `models/<id>` form and lists plenty that cannot run a chat turn;
		// both rules are data on the profile.
		const gemini = {
			id: 'gemini',
			model: 'gemini-3.8-flash',
			modelPrefix: 'models/',
			modelSkip: 'computer-use|deep-research|antigravity|aqa|-image|imagen|veo|embedding|-tts|live',
		};
		const reported = [
			'models/antigravity-preview-05-2026',
			'models/aqa',
			'models/deep-research-max-preview',
			'models/gemini-2.5-flash',
			'models/gemini-2.5-flash-image',
			'models/gemini-3.8-flash',
			'models/gemini-3.9-pro',
			'models/gemini-2.5-computer-use-preview',
			'models/text-embedding-005',
			'models/gemini-3.8-flash',
		];
		assert.deepStrictEqual(shapeModels(reported, gemini), ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.9-pro'], 'the prefix goes, non-chat models stay out, duplicates collapse');
		// A profile without a prefix keeps what the endpoint said, and a broken regex hides nothing.
		const deepseek = { id: 'deepseek', model: 'deepseek-flash', modelSkip: '([' };
		assert.deepStrictEqual(shapeModels(['deepseek-flash', 'deepseek-v4-pro'], deepseek), ['deepseek-flash', 'deepseek-v4-pro']);
		assert.deepStrictEqual(shapeModels([], deepseek), []);
		// The two id forms the menu and `comonad.model` use.
		assert.deepStrictEqual(parseModelId('gemini:gemini-3.9-pro'), { profile: 'gemini', model: 'gemini-3.9-pro' });
		assert.deepStrictEqual(parseModelId('auto'), { profile: 'auto' });
		assert.strictEqual(formatModelId('gemini', 'gemini-3.9-pro'), 'gemini:gemini-3.9-pro');
	});

	test('context forms shape the message list', () => {
		const transcript: Message[] = [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello' },
			{ role: 'tool', toolCallId: '1', content: 'x'.repeat(9_000) },
		];
		assert.strictEqual(applyContextForm(transcript, 'token').length, 2);
		const rendered = applyContextForm(transcript, 'rendered');
		assert.strictEqual(rendered.length, 3);
		assert.ok(rendered[2]!.content.length < 9_000);
		const raw = applyContextForm(transcript, 'raw');
		assert.strictEqual(raw[2]!.content.length, 9_000);
		assert.notStrictEqual(raw, transcript);
	});

	test('context limits trim whole turns', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'a'.repeat(400) },
			{ role: 'assistant', content: 'b'.repeat(400) },
			{ role: 'user', content: 'c'.repeat(400) },
			{ role: 'assistant', content: 'd'.repeat(400) },
		];
		assert.strictEqual(applyContextLimit(messages, 0).length, 4);
		assert.deepStrictEqual(applyContextLimit(messages, 250).map((message) => message.content[0]), ['c', 'd']);
		assert.deepStrictEqual(applyContextLimit(messages, 150).map((message) => message.content[0]), ['c', 'd']);
	});
});

suite('Cordis kernel', () => {
	test('tools register as plugin effects and unwind on dispose', async () => {
		const kernel = await createTestKernel();
		try {
			const fiber = kernel.ctx.plugin(
				toolset([
					{
						name: 'probe',
						description: 'probe tool',
						parameters: objectSchema({}),
						capability: 'ro',
						needsNetwork: false,
						needsWorkspace: false,
						execute: async () => 'ok',
					},
				]),
			);
			await fiber;
			assert.ok(kernel.ctx.tools.get('probe'));
			await fiber.dispose();
			assert.strictEqual(kernel.ctx.tools.get('probe'), undefined);
		} finally {
			await kernel.dispose();
		}
	});

	test('visible() filters by mode, network and workspace', async () => {
		const kernel = await createTestKernel();
		try {
			await kernel.ctx.plugin(
				toolset([
					{ name: 'a_ro', description: '', parameters: objectSchema({}), capability: 'ro', needsNetwork: false, needsWorkspace: false, execute: async () => '' },
					{ name: 'b_rw', description: '', parameters: objectSchema({}), capability: 'rw', needsNetwork: false, needsWorkspace: false, execute: async () => '' },
					{ name: 'c_net', description: '', parameters: objectSchema({}), capability: 'ro', needsNetwork: true, needsWorkspace: false, execute: async () => '' },
				]),
			);
			const names = (patch: Partial<SessionPolicy>) => kernel.ctx.tools.visible(policy(patch)).map((tool) => tool.name);
			// `lore_lookup` rides along: the kernel mounts it read-only for every chat.
			assert.deepStrictEqual(names({ workMode: 'chat', network: true }), [], 'chat only exposes no tool');
			assert.deepStrictEqual(names({ workMode: 'ro', network: false }), ['a_ro', 'lore_lookup']);
			assert.deepStrictEqual(names({ workMode: 'sw', network: true }), ['a_ro', 'b_rw', 'c_net', 'lore_lookup']);
		} finally {
			await kernel.dispose();
		}
	});

	test('sessions create, persist and fork through the service', async () => {
		const kernel = await createTestKernel();
		try {
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'main');
			session.title = 'hello';
			session.transcript.push({ role: 'user', content: 'hello' });
			kernel.ctx.sessions.save(session);
			assert.strictEqual(kernel.ctx.sessions.get('main')?.transcript.length, 1);
			const copy = kernel.ctx.sessions.fork('main');
			assert.notStrictEqual(copy.id, 'main');
			assert.strictEqual(copy.title, 'hello (fork 1)', 'the first fork of a chat is "(fork 1)"');
			assert.strictEqual(kernel.ctx.sessions.fork('main').title, 'hello (fork 2)', 'the next fork counts up');
			assert.strictEqual(kernel.ctx.sessions.fork(copy.id).title, 'hello (fork 3)', 'a fork of a fork keeps one series');
			assert.strictEqual(copy.transcript.length, 1);
			assert.strictEqual(copy.cursor, null);
			copy.transcript.push({ role: 'user', content: 'more' });
			assert.strictEqual(kernel.ctx.sessions.get('main')?.transcript.length, 1);
		} finally {
			await kernel.dispose();
		}
	});

	test('a chat can be forked from a turn and have its last turn replayed', async () => {
		const kernel = await createTestKernel();
		try {
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'main');
			session.transcript.push(
				{ role: 'user', content: 'one' },
				{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
				{ role: 'tool', content: 'body', toolCallId: 'c1' },
				{ role: 'assistant', content: 'a1' },
				{ role: 'user', content: 'two' },
				{ role: 'assistant', content: 'a2' },
			);
			kernel.ctx.sessions.save(session);

			// Fork from the first turn: the copy keeps the conversation through the end of that turn,
			// so a fork can never hold a tool call without the result that answers it.
			const turns = turnsOf(session.transcript);
			assert.strictEqual(turns[0]!.at, 4, 'the boundary sits after the whole turn');
			const forked = kernel.ctx.sessions.forkAt('main', turns[0]!.at);
			assert.deepStrictEqual(forked.transcript.map((message) => message.content), ['one', '', 'body', 'a1']);
			assert.strictEqual(kernel.ctx.sessions.active()?.id, forked.id, 'the fork becomes the active chat');
			assert.strictEqual(kernel.ctx.sessions.get('main')?.transcript.length, 6, 'the source chat is untouched');

			// Regenerate: the last prompt comes back and its output is gone.
			assert.strictEqual(kernel.ctx.sessions.replayLast('main'), 'two');
			assert.deepStrictEqual(kernel.ctx.sessions.get('main')?.transcript.map((message) => message.content), ['one', '', 'body', 'a1']);
			// An empty chat has nothing to re-run, and says so instead of throwing.
			kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'empty');
			assert.strictEqual(kernel.ctx.sessions.replayLast('empty'), '');
		} finally {
			await kernel.dispose();
		}
	});

	test('turns group a transcript into prompts with ordered steps', () => {
		const transcript: Message[] = [
			{ role: 'user', content: 'one', at: 1_000 },
			{ role: 'assistant', content: '', reasoning: 'hmm', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }], at: 2_000 },
			{ role: 'tool', content: 'file body', toolCallId: 'c1', at: 3_000 },
			{ role: 'assistant', content: 'done', at: 4_000 },
			{ role: 'user', content: 'two', at: 9_000 },
		];
		const turns = turnsOf(transcript);
		assert.strictEqual(turns.length, 2);
		assert.deepStrictEqual(turns.map((turn) => turn.prompt), ['one', 'two']);
		// A turn is one prompt plus every step the agent took for it, in order, whatever the number
		// of model round trips: thinking, the call, its result and the closing text.
		assert.deepStrictEqual(turns[0]!.steps.map((step) => step.kind), ['thought', 'tool', 'text']);
		assert.strictEqual(turns[0]!.steps[1]!.result, 'file body', 'the result is folded into the call it answers');
		assert.strictEqual(turns[0]!.steps[1]!.status, 'ok');
		assert.deepStrictEqual([turns[0]!.startedAt, turns[0]!.endedAt], [1_000, 4_000]);
		// `at` is the fork boundary: the end of the turn, never between a call and its result.
		assert.deepStrictEqual(turns.map((turn) => turn.at), [4, 5]);
		assert.deepStrictEqual(turns.map((turn) => turn.index), [0, 1]);
		// A turn that has not finished (suspended on approval) keeps its call unresolved.
		assert.strictEqual(turnsOf([{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c9', name: 'shell', arguments: '{}' }] }])[0]!.steps[0]!.status, 'running');
		assert.strictEqual(turnsOf([{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c9', name: 'shell', arguments: '{}' }] }, { role: 'tool', content: 'Error: nope', toolCallId: 'c9' }])[0]!.steps[0]!.status, 'error');
		assert.deepStrictEqual(turnsOf([]), []);
	});

	test('a step reports how long it took, when the transcript can tell', () => {
		const transcript: Message[] = [
			{ role: 'user', content: 'go', at: 500 },
			{ role: 'assistant', content: '', reasoning: 'weighing options', startedAt: 1_000, at: 4_000, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
			{ role: 'tool', content: 'body', toolCallId: 'c1', at: 4_600 },
			{ role: 'assistant', content: 'done', startedAt: 5_000, at: 6_200 },
		];
		const steps = turnsOf(transcript)[0]!.steps;
		assert.deepStrictEqual(steps.map((step) => step.kind), ['thought', 'tool', 'text']);
		assert.strictEqual(steps[0]!.ms, 3_000, 'the round trip that produced the thinking');
		assert.strictEqual(steps[1]!.ms, 600, 'the call itself: result minus request');
		assert.strictEqual(steps[2]!.ms, 1_200, 'a plain answer times its own round trip');
		// One timer per round trip, so an answer that followed thinking does not repeat the number.
		const both = turnsOf([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'answer', reasoning: 'thought', startedAt: 0, at: 900 }])[0]!.steps;
		assert.deepStrictEqual(both.map((step) => [step.kind, step.ms]), [['thought', 900], ['text', undefined]]);
		// Never a fabricated duration: no timestamps, no badge. And none for a call still running.
		assert.deepStrictEqual(
			turnsOf([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'a' }])[0]!.steps.map((step) => step.ms),
			[undefined],
		);
		assert.strictEqual(turnsOf([{ role: 'user', content: 'x' }, { role: 'assistant', content: '', startedAt: 0, at: 10, toolCalls: [{ id: 'c9', name: 'shell', arguments: '{}' }] }])[0]!.steps[0]!.ms, undefined);
	});

	test('legacy “(fork)” titles are renumbered on the first store access', async () => {
		const kernel = await createTestKernel();
		try {
			// Three chats from an older version, all forks of the same conversation.
			const store = new SessionStore(kernel.host.storage.sessions);
			const legacy = [
				['a', '你好'],
				['b', '你好 (fork)'],
				['c', '你好 (fork) (fork)'],
			] as const;
			for (const [id, title] of legacy) {
				const session = store.build(kernel.ctx.agent.policyFor(), id);
				session.title = title;
				session.createdAt = id.charCodeAt(0);
				session.transcript.push({ role: 'user', content: 'hi' });
				store.save(session);
			}
			const renamed = store.tidyForkTitles();
			assert.strictEqual(renamed, 2, 'only the legacy forks are rewritten');
			assert.deepStrictEqual(
				store.list().map((session) => session.title).sort(),
				['你好', '你好 (fork 1)', '你好 (fork 2)'],
			);
			// Forks made from here on continue the same series.
			assert.strictEqual(kernel.ctx.sessions.fork('a').title, '你好 (fork 3)');
			// A title with no fork marker is left alone.
			const plain = store.build(kernel.ctx.agent.policyFor(), 'd');
			plain.title = 'README';
			plain.transcript.push({ role: 'user', content: 'hi' });
			store.save(plain);
			assert.strictEqual(store.tidyForkTitles(), 0);
		} finally {
			await kernel.dispose();
		}
	});

	test('unused chats stay out of the history and stored junk is pruned', async () => {
		const kernel = await createTestKernel();
		try {
			const store = new SessionStore(kernel.host.storage.sessions);
			store.save(store.build(kernel.ctx.agent.policyFor(), 'junk'));
			assert.strictEqual(kernel.ctx.sessions.list().length, 0, 'an unused chat on disk is pruned');

			const draft = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'draft');
			kernel.ctx.sessions.save(draft);
			assert.strictEqual(kernel.ctx.sessions.list().length, 0, 'creating a chat does not persist it');
			assert.strictEqual(kernel.ctx.sessions.active()?.id, 'draft', 'the unused chat is still the active one');

			draft.transcript.push({ role: 'user', content: 'hi' });
			kernel.ctx.sessions.save(draft);
			assert.deepStrictEqual(
				kernel.ctx.sessions.list().map((session) => session.id),
				['draft'],
				'the first message turns the chat into history',
			);
		} finally {
			await kernel.dispose();
		}
	});

	test('chats can be searched by title and message text', async () => {
		const kernel = await createTestKernel();
		try {
			const paper = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'paper');
			paper.title = 'ICML paper';
			paper.transcript.push({ role: 'user', content: 'we settled the NMA scheduler' });
			kernel.ctx.sessions.save(paper);
			await new Promise((resolve) => setTimeout(resolve, 5));
			const notes = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'notes');
			notes.title = 'scheduler notes';
			notes.transcript.push({ role: 'user', content: 'unrelated text' });
			kernel.ctx.sessions.save(notes);

			assert.deepStrictEqual(kernel.ctx.sessions.search('icml').map((hit) => hit.id), ['paper']);
			assert.deepStrictEqual(kernel.ctx.sessions.search('scheduler').map((hit) => hit.id), ['notes', 'paper']);
			assert.match(String(kernel.ctx.sessions.search('nma')[0]?.snippet), /NMA scheduler/);
			assert.deepStrictEqual(kernel.ctx.sessions.search('   '), []);
		} finally {
			await kernel.dispose();
		}
	});

	test('the plan directory setting reaches the session policy', async () => {
		const kernel = await createTestKernel({ config: { planDirectory: 'notes/plans' } });
		try {
			assert.strictEqual(kernel.ctx.settings.get().planDirectory, 'notes/plans');
			assert.strictEqual(kernel.ctx.agent.policyFor().planDirectory, 'notes/plans');
			await kernel.ctx.settings.update('planDirectory', '');
			assert.strictEqual(kernel.ctx.agent.policyFor().planDirectory, '');
		} finally {
			await kernel.dispose();
		}
	});

	test('every gate in the flow diagram owns its outcome', () => {
		const flow = gateFlow();
		assert.match(flow, /^flowchart TD\n/);
		for (const gate of ['work mode set', 'network ok', 'workspace ok', 'deny rule', 'ask rule', 'allow rule', 'dangerous', 'no rule matched']) {
			assert.ok(flow.includes(gate), `flow covers ${gate}`);
		}
		assert.ok(flow.includes('in the whitelist?') && flow.includes('in the blacklist?'), 'flow covers both rule lists');
		// Every approval policy is a node of its own, named after the setting value.
		for (const policy of Object.keys(APPROVAL_LABELS)) {
			assert.ok(flow.includes(`["${policy}"]`), `flow has a ${policy} policy node`);
		}
		// `call` and `end` are mermaid keywords: the source must not use them as node ids.
		assert.ok(!/^\s*call[\s[(]/.test(flow) && !/^\s*end\[/m.test(flow), 'flow avoids mermaid keywords');

		// Two frames: the user's own rules, then the approval policy for the calls they left open.
		const box = (id: string): string => {
			const start = flow.indexOf(`  subgraph ${id}[`);
			assert.ok(start >= 0, `flow has a ${id} subgraph`);
			return flow.slice(start, flow.indexOf('\n  end', start));
		};
		const rules = box('rules');
		const policy = box('policy');
		for (const gate of ['deny rule matches?', 'ask rule matches?', 'allow rule matches?']) {
			assert.ok(rules.includes(gate), `the rules frame holds ${gate}`);
		}
		// The policy frame holds the policy question and the five policy nodes; their consequences
		// (the list questions and every outcome) flow out below it.
		assert.ok(policy.includes('no rule matched'), 'the policy frame holds the policy question');
		for (const id of ['policyManual', 'policyReject', 'policyAccept', 'policyWhitelist', 'policyBlacklist']) {
			assert.ok(policy.includes(`    ${id}["`), `the policy frame holds ${id}`);
		}
		assert.strictEqual((policy.match(/^    approval --> /gm) ?? []).length, 5, 'the policy question offers five policies');
		assert.ok(!policy.includes('in the whitelist?') && !policy.includes('in the blacklist?'), 'the list questions sit outside the frame');
		assert.ok(!policy.includes('deny rule'), 'the rules frame does not hold the policy gates');
		// The safety escalation sits between the two frames: it is neither a rule nor a policy.
		assert.ok(!rules.includes('unsandboxed') && !policy.includes('unsandboxed'), 'the escalation sits between the frames');

		// One outcome node per gate, directly below it: no shared sink, so no edge runs across the
		// chart — every target of an edge is reached exactly once.
		const declared = [...flow.matchAll(/(\w+)\(\["(Rejected|Asks you|Runs)"\]\)/g)].map((match) => [match[1]!, match[2]!] as const);
		assert.ok(declared.length >= 12, `every gate owns an outcome, got ${declared.length}`);
		for (const kind of ['Rejected', 'Asks you', 'Runs']) {
			assert.ok(declared.filter(([, label]) => label === kind).length >= 3, `several ${kind} nodes`);
		}
		const targets = (flow.match(/-->\s*\w+/g) ?? []).map((edge) => edge.replace(/-->\s*/, ''));
		for (const [id] of declared) {
			assert.strictEqual(targets.filter((target) => target === id).length, 1, `${id} is the outcome of exactly one gate`);
		}
		// …and every outcome is coloured by what it means.
		const coloured = (flow.match(/^  class ([\w,]+) (reject|confirm|run)$/gm) ?? []).flatMap((line) => /^  class ([\w,]+) /.exec(line)![1]!.split(','));
		const byKind: Record<string, string> = { Rejected: 'reject', 'Asks you': 'confirm', Runs: 'run' };
		const expected = declared.map(([id, label]) => `${id}:${byKind[label]!}`).sort();
		const actual = coloured
			.map((id) => {
				const kind = (flow.match(new RegExp(`^  class [\\w,]*\\b${id}\\b[\\w,]* (reject|confirm|run)$`, 'm')) ?? [])[1]!;
				return `${id}:${kind}`;
			})
			.sort();
		assert.deepStrictEqual(actual, expected, 'each outcome carries its own colour');

		const legend = modeCapabilities();
		assert.strictEqual(legend.length, Object.keys(MODE_CAPS).length);
		for (const mode of Object.keys(MODE_CAPS) as WorkMode[]) {
			const name = MODE_LABELS[mode].split(' — ')[0]!;
			assert.ok(legend.some((line) => line.startsWith(`${name} — `)), `legend names mode ${mode}`);
		}
		assert.ok(legend.some((line) => line.endsWith('no tools')), 'legend says the chat mode has no tools');
	});

	test('the chat controls are title-bar commands with icons', () => {
		// The header row inside the webview was dropped on the user's request ("能把这些合并到一行么");
		// its three controls must stay reachable from the view title bar.
		const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes: { commands: { command: string; icon?: string }[]; menus: Record<string, { command: string; when?: string }[]> };
		};
		const icons = new Map(manifest.contributes.commands.map((entry) => [entry.command, String(entry.icon ?? '')]));
		const chatEntries = [...(manifest.contributes.menus['view/title'] ?? []), ...(manifest.contributes.menus['editor/title'] ?? [])].filter((entry) => String(entry.when).includes('comonad.chat'));
		for (const id of ['comonad.toggleHistory', 'comonad.openSettings', 'comonad.newSession']) {
			assert.ok(chatEntries.some((entry) => entry.command === id), `${id} is contributed to the chat title bar`);
			assert.match(icons.get(id) ?? '', /^\$\(\w+\)$/, `${id} has a codicon`);
		}
		assert.ok(
			[...(manifest.contributes.menus['view/title'] ?? []), ...(manifest.contributes.menus['editor/title'] ?? [])].some((entry) => entry.command === 'comonad.toggleHistory'),
			'the chat list is reachable from both chat surfaces',
		);
	});

	test('the new-chat control is Cmd+N, and only on the chat surfaces', () => {
		// The user asked for "只要有一个新建会话就可以，默认快捷键为cmd+N": one control, one chord.
		const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes: { keybindings: { command: string; key: string; mac?: string; when?: string }[] };
		};
		const binding = manifest.contributes.keybindings.find((entry) => entry.command === 'comonad.newSession');
		assert.ok(binding, 'comonad.newSession is bound');
		assert.strictEqual(binding.mac, 'cmd+n');
		assert.strictEqual(binding.key, 'ctrl+alt+n');
		// It must not take Cmd+N away from the editor: the chord fires only while a Comonad surface
		// has focus, so New Text File still owns it everywhere else.
		for (const surface of ['comonad.chat', 'comonad.sessions', 'comonad.tasks']) {
			assert.ok(String(binding.when).includes(surface), `the chord fires from ${surface}`);
		}
		// A chord pressed inside a webview is resolved against the workbench's root context, where
		// `focusedView` and `auxiliaryBarFocus` are out of scope: the chat has to publish its own
		// focus (webview `focusState` → `setContext`), or the chord falls through to New Text File.
		assert.ok(String(binding.when).includes('comonad.chatFocused'), 'the chat publishes its own focus');
	});

	test('the rule lists the Rules tab edits are the ones the gate uses', async () => {
		const kernel = await createTestKernel();
		try {
			// What the panel writes: three string lists, validated with `parseRule`.
			assert.strictEqual(parseRule('run_shell(npm run test:*)')?.pattern, 'npm run test:*');
			assert.strictEqual(parseRule('run shell'), null, 'the panel rejects a line that is not a rule');
			await kernel.ctx.settings.update('permissions', {
				allow: ['run_shell(npm run test:*)'],
				ask: ['run_shell(git push:*)'],
				deny: ['read_file(./.env)'],
			});
			const rules = kernel.ctx.settings.rules();
			assert.deepStrictEqual(rules.allow.map((rule) => rule.tool), ['run_shell']);
			assert.deepStrictEqual(rules.ask.map((rule) => rule.pattern), ['git push:*']);
			assert.deepStrictEqual(rules.deny.map((rule) => rule.pattern), ['./.env']);
			// And they gate a call: the deny rule wins even under an accept-all policy.
			const accepted = policy({ approval: 'universal_accept', workMode: 'aw', network: true });
			assert.strictEqual(gateCalls([call('read_file', { path: './.env' })], lookup, accepted, rules).decision, 'reject');
			assert.strictEqual(gateCalls([call('run_shell', { command: 'npm run test:unit' })], lookup, accepted, rules).decision, 'allow');
		} finally {
			await kernel.dispose();
		}
	});

	test('generation settings are stored per chat and start from the settings', async () => {
		const kernel = await createTestKernel();
		try {
			await kernel.ctx.settings.update('contextForm', 'raw');
			await kernel.ctx.settings.update('reasoningEffort', 'low');
			await kernel.ctx.settings.update('contextLimit', 65_536);
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'ctx');
			assert.strictEqual(session.contextForm, 'raw');
			assert.strictEqual(session.reasoningEffort, 'low');
			assert.strictEqual(session.contextLimit, 65_536);
			session.contextForm = 'token';
			session.reasoningEffort = 'high';
			session.contextLimit = 0;
			session.transcript.push({ role: 'user', content: 'hi' });
			kernel.ctx.sessions.save(session);
			const saved = kernel.ctx.sessions.get('ctx');
			assert.strictEqual(saved?.contextForm, 'token');
			assert.strictEqual(saved?.reasoningEffort, 'high');
			assert.strictEqual(saved?.contextLimit, 0);
		} finally {
			await kernel.dispose();
		}
	});

	test('chat only runs a turn without offering the model any tool', async () => {
		const kernel = await createTestKernel({ config: { mode: 'chat' } });
		try {
			let offered: string[] = [];
			kernel.ctx.llm.use({
				name: 'test',
				async chat(request) {
					offered = request.tools.map((tool) => tool.name);
					return { message: { role: 'assistant', content: 'hello' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const result = await kernel.ctx.agent.runTurn({ text: 'hi' });
			assert.strictEqual(result.text, 'hello');
			assert.deepStrictEqual(offered, []);
		} finally {
			await kernel.dispose();
		}
	});

	test('the agent applies the chat context form to model messages', async () => {
		const kernel = await createTestKernel();
		try {
			let seen: Message[] = [];
			kernel.ctx.llm.use({
				name: 'test',
				async chat(request) {
					seen = request.messages;
					return { message: { role: 'assistant', content: 'ok' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'form');
			session.contextForm = 'token';
			session.transcript.push({ role: 'tool', content: 'tool-output', toolCallId: 'x' });
			kernel.ctx.sessions.save(session);
			await kernel.ctx.agent.runTurn({ text: 'hi', sessionId: 'form' });
			assert.ok(seen.some((message) => message.role === 'user'));
			assert.ok(!seen.some((message) => message.role === 'tool'), 'token form drops tool traffic');
		} finally {
			await kernel.dispose();
		}
	});

	test('the agent forwards the chat reasoning effort and drops over-budget turns', async () => {
		const kernel = await createTestKernel();
		try {
			let seen: Message[] = [];
			let effort: string | undefined;
			kernel.ctx.llm.use({
				name: 'test',
				async chat(request) {
					seen = request.messages;
					effort = request.reasoningEffort;
					return { message: { role: 'assistant', content: 'ok' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'gen');
			session.reasoningEffort = 'high';
			session.contextLimit = 50;
			session.transcript.push({ role: 'user', content: 'a'.repeat(400) }, { role: 'assistant', content: 'b'.repeat(400) });
			kernel.ctx.sessions.save(session);
			await kernel.ctx.agent.runTurn({ text: 'hi', sessionId: 'gen' });
			assert.strictEqual(effort, 'high');
			assert.ok(!seen.some((message) => message.content.startsWith('a')), 'the over-budget turn is dropped');
		} finally {
			await kernel.dispose();
		}
	});

	test('the model menu is read from the endpoints, then whatever you configure', async () => {
		const kernel = await createTestKernel();
		try {
			// With no adapter loaded the menu still renders: every profile offers the model it declares.
			const shipped = await kernel.ctx.llm.availableModels();
			assert.deepStrictEqual(shipped.map((choice) => choice.label), ['deepseek-flash', 'deepseek-v4-pro', 'gemini-3.8-flash', 'Auto']);
			assert.strictEqual(
				shipped[0]!.description,
				'DeepSeek Flash · https://api.deepseek.com · models not listed · no key — set DEEPSEEK_API_KEY',
			);
			assert.strictEqual(shipped[0]!.id, 'deepseek:deepseek-flash', 'a choice names profile and model');
			assert.match(shipped[3]!.description, /DeepSeek Flash — the first profile, model deepseek-flash/);
			const shippedProfiles = kernel.ctx.settings.get().profiles;
			assert.deepStrictEqual(profileKeyEnvs(shippedProfiles[0]!), ['DEEPSEEK_API_KEY'], 'a single name is still a list');
			// The shipped prices are DeepSeek's peak cache-miss input and output rates, with the much
			// cheaper cache-hit rate, so /cost is an upper bound rather than a guess.
			assert.deepStrictEqual(
				[shippedProfiles[0]!.pricingIn, shippedProfiles[0]!.pricingCachedIn, shippedProfiles[0]!.pricingOut],
				[0.3, 0.006, 1.2],
			);
			assert.deepStrictEqual([shippedProfiles[1]!.pricingIn, shippedProfiles[1]!.pricingOut], [1.32, 3.96]);

			// With an adapter, the list is whatever the endpoint reports — a new model needs no release.
			let asked = 0;
			kernel.ctx.llm.use({
				name: 'openai',
				async chat() {
					return { message: { role: 'assistant', content: '' }, toolCalls: [] };
				},
				async listModels(request) {
					asked += 1;
					return request.profile.base?.includes('googleapis') ? ['gemini-3.8-flash', 'gemini-3.9-pro'] : ['deepseek-v5-preview', 'deepseek-flash'];
				},
			});
			kernel.host.envValues.DEEPSEEK_API_KEY = 'sk-env';
			const live = await kernel.ctx.llm.availableModels({ refresh: true });
			assert.deepStrictEqual(live.map((choice) => choice.label), ['deepseek-v5-preview', 'deepseek-flash', 'gemini-3.8-flash', 'gemini-3.9-pro', 'Auto']);
			assert.ok(!live[0]!.description.includes('no key'), 'the DeepSeek endpoint has a key now');
			assert.match(live[2]!.description, /no key — set GEMINI_API_KEY or GOOGLE_API_KEY/, 'Gemini still has none');
			assert.strictEqual(asked, 3, 'one request per endpoint');
			// The list is cached, so opening the menu is not a request storm; refresh asks again.
			await kernel.ctx.llm.availableModels();
			assert.strictEqual(asked, 3, 'the cache answers the next call');
			await kernel.ctx.llm.availableModels({ refresh: true });
			assert.strictEqual(asked, 6, 'a refresh re-reads the endpoints');

			// An explicit model id selects that model; a bare profile id keeps its declared default.
			assert.strictEqual(kernel.ctx.llm.describe('deepseek:deepseek-v5-preview'), 'deepseek-v5-preview');
			assert.strictEqual(kernel.ctx.llm.describe('deepseek'), 'DeepSeek Flash');
			assert.strictEqual(kernel.ctx.llm.known('gemini:gemini-3.9-pro'), true);
			assert.strictEqual(kernel.ctx.llm.known('nope:any'), false);

			// An explicitly empty list still means "nothing configured", so the defaults stand in.
			await kernel.ctx.settings.update('profiles', []);
			assert.deepStrictEqual(kernel.ctx.settings.get().profiles.map((profile) => profile.id), ['deepseek', 'deepseek-pro', 'gemini']);
		} finally {
			await kernel.dispose();
		}
	});

	test('a profile resolves, and its key comes from the environment', async () => {
		const kernel = await createTestKernel();
		try {
			let seen: { model: string; key?: string; base?: string } | undefined;
			kernel.ctx.llm.use({
				name: 'openai',
				async chat(request) {
					seen = { model: request.model, key: request.key, base: request.profile.base };
					return { message: { role: 'assistant', content: 'ok' }, toolCalls: [] };
				},
			});
			// The first DeepSeek profile, with no key anywhere: the empty key reaches the adapter,
			// which turns it into a message that names the variables to set.
			assert.strictEqual(kernel.ctx.llm.describe('auto'), 'DeepSeek Flash');
			assert.strictEqual(kernel.ctx.llm.describe('deepseek-pro'), 'DeepSeek V4 Pro');
			assert.strictEqual(kernel.ctx.llm.describe('gemini'), 'Gemini 3.8 Flash');
			await kernel.ctx.llm.chat('auto', [{ role: 'user', content: 'hi' }], [], {}, new AbortController().signal);
			assert.deepStrictEqual(seen, { model: 'deepseek-flash', key: '', base: 'https://api.deepseek.com' });

			// Cached input is billed at the cache rate: 1M fresh + 1M cached + 1M out, peak prices.
			assert.strictEqual(
				Number(
					kernel.ctx.llm
						.costFor('deepseek', { input: 2_000_000, output: 1_000_000, cached: 1_000_000 })
						.toFixed(3),
				),
				0.3 + 0.006 + 1.2,
				'cache hits cost 2 % of a fresh prompt',
			);
			assert.strictEqual(kernel.ctx.llm.costFor('gemini', { input: 1_000_000, output: 1_000_000 }), 0, 'no prices, no estimate');

			// A stored key wins over the environment; the environment is the fallback.
			await kernel.ctx.llm.setSecret('deepseek', 'sk-stored');
			await kernel.ctx.llm.chat('deepseek', [], [], {}, new AbortController().signal);
			assert.strictEqual(seen?.key, 'sk-stored');
			kernel.host.envValues.DEEPSEEK_API_KEY = 'sk-env';
			const profiles = kernel.ctx.settings.get().profiles.map((profile) => ({ ...profile }));
			await kernel.ctx.settings.update('profiles', profiles.map((profile) => ({ ...profile, id: `${profile.id}-x`, keyEnv: 'DEEPSEEK_API_KEY' })));
			await kernel.ctx.llm.chat('deepseek-x', [], [], {}, new AbortController().signal);
			assert.strictEqual(seen?.key, 'sk-env', 'the environment variable is read when nothing is stored');

			// A chat that still remembers the removed Copilot provider keeps working on the first
			// profile, and the turn says so once instead of failing.
			const notices: string[] = [];
			kernel.ctx.on('agent/notice', (_ref, text) => notices.push(text));
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'legacy');
			session.policy = { ...session.policy, model: 'copilot:deepseek-flash' };
			kernel.ctx.sessions.save(session);
			await kernel.ctx.agent.runTurn({ text: 'hello', sessionId: 'legacy', policy: { model: 'copilot:deepseek-flash' } });
			assert.strictEqual(seen?.model, 'deepseek-flash', 'the stale id runs on the shipped default');
			assert.deepStrictEqual(notices, ['model profile "copilot:deepseek-flash" is gone — using DeepSeek Flash. Pick one from the model menu.']);
			assert.strictEqual(kernel.ctx.llm.known('copilot:deepseek-flash'), false);
			assert.strictEqual(kernel.ctx.llm.known('auto'), true);

			// A profile may name several variables; the first one that is set wins.
			await kernel.ctx.settings.update('profiles', [
				{ id: 'multi', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
			]);
			kernel.host.envValues.GOOGLE_API_KEY = 'sk-google';
			await kernel.ctx.llm.chat('multi', [], [], {}, new AbortController().signal);
			assert.strictEqual(seen?.key, 'sk-google');
			kernel.host.envValues.GEMINI_API_KEY = 'sk-gemini';
			await kernel.ctx.llm.chat('multi', [], [], {}, new AbortController().signal);
			assert.strictEqual(seen?.key, 'sk-gemini', 'the first variable in the list wins');
		} finally {
			await kernel.dispose();
		}
	});

	test('a missing key names the variable to set', async () => {
		await assert.rejects(
			() =>
				openAiChat({
					base: 'https://api.deepseek.com',
					key: '',
					keyEnv: 'DEEPSEEK_API_KEY',
					model: 'deepseek-flash',
					messages: [{ role: 'user', content: 'hi' }],
					tools: [],
					signal: new AbortController().signal,
				}),
			/DEEPSEEK_API_KEY/,
		);
	});

	test('agent runs the tool loop, streams events and records the transcript', async () => {
		const kernel = await createTestKernel();
		try {
			let calls = 0;
			kernel.ctx.llm.use({
				name: 'test',
				async chat(request) {
					calls += 1;
					if (calls === 1) {
						const toolCall: ToolCall = { id: 'c1', name: 'probe', arguments: JSON.stringify({ value: '42' }) };
						request.sink.onToken?.('working');
						return { message: { role: 'assistant', content: 'working', toolCalls: [toolCall] }, toolCalls: [toolCall], usage: { input: 5, output: 3 } };
					}
					const last = [...request.messages].reverse().find((message) => message.role === 'tool');
					const text = `done: ${last?.content ?? ''}`;
					request.sink.onToken?.(text);
					return { message: { role: 'assistant', content: text }, toolCalls: [], usage: { input: 2, output: 2 } };
				},
			});
			await kernel.ctx.plugin(
				toolset([
					{
						name: 'probe',
						description: 'probe tool',
						parameters: objectSchema({ value: { type: 'string' } }, ['value']),
						capability: 'ro',
						needsNetwork: false,
						needsWorkspace: false,
						async execute(args) {
							const { value } = args as { value: string };
							return `probe:${value}`;
						},
					},
				]),
			);
			const events: string[] = [];
			kernel.ctx.on('agent/token', () => events.push('token'));
			kernel.ctx.on('agent/tool-start', () => events.push('tool-start'));
			kernel.ctx.on('agent/tool-result', () => events.push('tool-result'));
			kernel.ctx.on('agent/turn-end', () => events.push('turn-end'));
			const result = await kernel.ctx.agent.runTurn({ text: 'go', surface: 'test' });
			assert.strictEqual(result.text, 'done: probe:42');
			assert.deepStrictEqual(events, ['token', 'tool-start', 'tool-result', 'token', 'turn-end']);
			const session = kernel.ctx.sessions.require(result.sessionId);
			assert.deepStrictEqual(
				session.transcript.map((message) => message.role),
				['user', 'assistant', 'tool', 'assistant'],
			);
			assert.strictEqual(session.usage.requests, 2);
		} finally {
			await kernel.dispose();
		}
	});

	test('approval waterfall routes by surface: deny rejects, allow executes', async () => {
		const kernel = await createTestKernel({ config: { approval: 'manual' } });
		try {
			let calls = 0;
			kernel.ctx.llm.use({
				name: 'test',
				async chat(request) {
					calls += 1;
					const last = request.messages[request.messages.length - 1];
					if (last?.role === 'user') {
						const toolCall: ToolCall = { id: `c${calls}`, name: 'probe', arguments: '{}' };
						return { message: { role: 'assistant', content: 'working', toolCalls: [toolCall] }, toolCalls: [toolCall] };
					}
					const text = last?.content.startsWith('Rejected') ? 'rejected ok' : 'executed ok';
					return { message: { role: 'assistant', content: text }, toolCalls: [] };
				},
			});
			await kernel.ctx.plugin(
				toolset([
					{
						name: 'probe',
						description: '',
						parameters: objectSchema({}),
						capability: 'ro',
						needsNetwork: false,
						needsWorkspace: false,
						execute: async () => 'ran',
					},
				]),
			);
			const requests: ApprovalRequest[] = [];
			let decision: 'allow' | 'deny' = 'deny';
			kernel.ctx.on('approval/request', (request, next) => {
				if (request.surface !== 'test') {
					return next();
				}
				requests.push(request);
				return decision;
			});
			let toolStarts = 0;
			kernel.ctx.on('agent/tool-start', () => {
				toolStarts += 1;
			});

			const rejected = await kernel.ctx.agent.runTurn({ text: 'go', surface: 'test' });
			assert.strictEqual(requests.length, 1);
			assert.strictEqual(toolStarts, 0);
			assert.strictEqual(rejected.text, 'rejected ok');
			assert.strictEqual(kernel.ctx.sessions.require(rejected.sessionId).cursor, null);

			decision = 'allow';
			const allowed = await kernel.ctx.agent.runTurn({ text: 'go', surface: 'test' });
			assert.strictEqual(requests.length, 2);
			assert.strictEqual(toolStarts, 1);
			assert.strictEqual(allowed.text, 'executed ok');
		} finally {
			await kernel.dispose();
		}
	});
});

/* ------------------------------------------------------------------ the SillyTavern port */

// Every fixture here is authored for this test file: the extension never ships SillyTavern's own
// content, and its own card/book/preset shapes are only ever read from the user's installation.

const CARD_V2 = {
	spec: 'chara_card_v2',
	spec_version: '2.0',
	name: 'Kestrel',
	description: 'A cartographer of dead cities.',
	personality: 'Terse, watchful.',
	scenario: 'The salt flats, at dusk.',
	first_mes: '{{char}} looks up. "You are late."',
	mes_example: '<START>\n{{user}}: hello\n{{char}}: hm.',
	system_prompt: 'Stay in character.',
	post_history_instructions: 'Never break the fourth wall.',
	alternate_greetings: ['A second opening.', 'A third.'],
	tags: ['fantasy'],
	creator: 'us',
	character_version: '1.0',
	extensions: { depth_prompt: { depth: 2, prompt: 'Remember the map.', role: 'system' }, unknown_extension: 42 },
	character_book: {
		name: 'Salt Flats',
		entries: [
			{
				id: 0,
				keys: ['salt', 'flats'],
				content: 'The flats drink sound.',
				comment: 'salt',
				insertion_order: 20,
				position: 'after_char',
				enabled: true,
				extensions: { probability: 100, depth: 4, group: '', group_weight: 100, selectiveLogic: 0 },
			},
		],
	},
	unknown_field: { keep: true },
};

/** A chunk with a zero CRC: enough for a reader that never validates one. */
function rawChunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, 'latin1');
	return Buffer.concat([head, data, Buffer.alloc(4)]);
}

function barePng(): Buffer {
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		rawChunk('IHDR', Buffer.alloc(13)),
		rawChunk('IDAT', Buffer.from([1, 2, 3])),
		rawChunk('IEND', Buffer.alloc(0)),
	]);
}

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

function loreBookOf(entries: Array<Partial<WorldEntry> & { uid: number; content: string }>, kind: LoreBook['kind'] = 'character'): LoreBook {
	return {
		name: 'Book',
		kind,
		book: {
			name: 'Book',
			entries: Object.fromEntries(entries.map((entry, index) => [String(entry.uid ?? index), worldEntry(entry)])),
		},
	};
}

const lore = (patch: Partial<LoreInput> = {}): LoreInput => ({
	books: [],
	messages: [{ speaker: 'You', text: 'Tell me about the salt flats' }],
	settings: { ...WI_SETTINGS_DEFAULTS },
	contextSize: 8192,
	turn: 0,
	random: () => 0,
	...patch,
});

suite('Tavern content', () => {
	test('a card is read from a PNG, V3 ahead of V2', () => {
		const v3 = JSON.stringify({ ...CARD_V2, spec: 'chara_card_v3', spec_version: '3.0' });
		const png = writePngText(barePng(), [
			{ keyword: 'chara', text: base64(JSON.stringify(CARD_V2)) },
			{ keyword: 'ccv3', text: base64(v3) },
		]);
		assert.deepStrictEqual(readPngText(png).map((chunk) => chunk.keyword), ['chara', 'ccv3']);
		assert.strictEqual((JSON.parse(cardTextFromPng(png)) as { spec: string }).spec, 'chara_card_v3');
		// Writing again replaces the card chunks instead of stacking copies of them.
		const rewritten = writePngText(png, [{ keyword: 'chara', text: base64(JSON.stringify(CARD_V2)) }]);
		assert.deepStrictEqual(readPngText(rewritten).map((chunk) => chunk.keyword), ['chara']);
	});

	test('a card normalises V1 and V2 without losing a field', () => {
		const v1 = JSON.stringify({ name: 'Old', description: 'd', first_mes: 'hi', creatorcomment: 'notes', tags: ['t'] });
		const old = normaliseCard(parseCard(v1), 'old', 'memory');
		assert.strictEqual(old.name, 'Old');
		assert.strictEqual(old.greeting, 'hi');
		assert.strictEqual(old.creatorNotes, 'notes');
		assert.deepStrictEqual(old.tags, ['t']);
		assert.deepStrictEqual(old.alternateGreetings, []);

		const kestrel = normaliseCard(parseCard(JSON.stringify(CARD_V2)), 'kestrel', 'memory');
		assert.strictEqual(kestrel.name, 'Kestrel');
		assert.deepStrictEqual(kestrel.alternateGreetings, ['A second opening.', 'A third.']);
		assert.deepStrictEqual(kestrel.depthPrompt, { depth: 2, prompt: 'Remember the map.', role: 'system' });
		assert.strictEqual(kestrel.systemPrompt, 'Stay in character.');
		assert.strictEqual(kestrel.postHistoryInstructions, 'Never break the fourth wall.');
		assert.ok(kestrel.book, 'the card carries its own world book');

		// Round trip: fields we do not model, at the root and inside `extensions`, survive.
		const back = characterToCard(kestrel) as unknown as Record<string, unknown>;
		assert.strictEqual(back.spec, 'chara_card_v2');
		assert.deepStrictEqual(back.unknown_field, { keep: true });
		const extensions = (back.data as { extensions: Record<string, unknown> }).extensions;
		assert.strictEqual(extensions.unknown_extension, 42);
		assert.deepStrictEqual(extensions.regex_scripts, undefined);
	});

	test('macros fill what they know and leave the rest alone', () => {
		const ctx = { char: 'Kestrel', user: 'You', persona: 'A reader.', description: 'tall' };
		assert.strictEqual(substituteMacros('{{char}} meets {{user}}: {{persona}}', ctx), 'Kestrel meets You: A reader.');
		assert.strictEqual(substituteMacros('{{ description }}', ctx), 'tall');
		assert.strictEqual(substituteMacros('{{charPrompt}}', ctx), '{{charPrompt}}');
		assert.strictEqual(substituteMacros('{{words}} and {{unknown}}', ctx), '{{words}} and {{unknown}}');
		assert.strictEqual(substituteMacros('a\n\n{{trim}}', ctx), 'a');
		assert.strictEqual(substituteMacros('{{//note}}kept', ctx), 'kept');
		assert.strictEqual(substituteMacros('x{{noop}}y{{newline}}z', ctx), 'xy\nz');
		assert.strictEqual(substituteMacros('{{random:a,b,c}}', ctx, { random: () => 0.99 }), 'c');
		assert.strictEqual(substituteMacros('{{roll:2d2+1}}', ctx, { random: () => 0 }), '3');

		// `{{pick}}` is stable within one pass, so a preset cannot disagree with itself.
		let calls = 0;
		const flip = (): number => {
			calls += 1;
			return calls === 1 ? 0 : 0.99;
		};
		assert.strictEqual(substituteMacros('{{pick:a,b}} then {{pick:a,b}}', ctx, { random: flip }), 'a then a');
		assert.strictEqual(calls, 1);

		assert.deepStrictEqual(parseExamples('<START>\none\n<START>\ntwo'), ['one', 'two']);
		assert.deepStrictEqual(parseExamples('   '), []);
	});

	test('a preset keeps its samplers, its prompts and its order', () => {
		const preset = parsePreset(
			JSON.stringify({
				temperature: 1.1,
				top_p: 0.9,
				openai_max_context: 8192,
				openai_max_tokens: 512,
				wi_format: 'Lore: {0}',
				prompts: [
					{ identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: 'Speak as {{char}}.' },
					{ identifier: 'authorsNote', name: 'Note', role: 'system', content: 'Be brief.' },
				],
				prompt_order: [
					{
						character_id: 100000,
						order: [
							{ identifier: 'main', enabled: true },
							{ identifier: 'chatHistory', enabled: true },
							{ identifier: 'authorsNote', enabled: false },
						],
					},
				],
				unknown_key: 'kept',
			}),
			'Test preset',
			'test',
		);
		assert.strictEqual(preset.temperature, 1.1);
		assert.strictEqual(preset.maxContext, 8192);
		assert.strictEqual(preset.wi_format, 'Lore: {0}');
		assert.deepStrictEqual(presetSamplers(preset), { temperature: 1.1, topP: 0.9, maxTokens: 512 });

		const messages = promptCollection(preset);
		assert.strictEqual(messages[0].identifier, IDENTITY_PROMPT, 'the agent identity leads');
		assert.deepStrictEqual(messages.slice(1, 4).map((item) => item.identifier), ['main', 'chatHistory', 'authorsNote']);
		assert.deepStrictEqual(messages.filter((item) => item.identifier === 'authorsNote').map((item) => item.enabled), [false]);
		assert.ok(messages.some((item) => item.identifier === 'jailbreak'), 'the shipped blocks still ride along');
		// The preset's own text replaced the shipped block of the same identifier.
		assert.strictEqual(messages.find((item) => item.identifier === 'main')?.content, 'Speak as {{char}}.');

		const saved = JSON.parse(presetToJson(preset)) as Record<string, unknown>;
		assert.strictEqual(saved.unknown_key, 'kept');
		assert.strictEqual((saved.prompt_order as Array<{ order: unknown[] }>)[0].order.length, 3);
	});

	test('the prompt collection can be switched and reordered, the identity block cannot', () => {
		const collection = promptCollection();
		assert.deepStrictEqual(collection.slice(1, 4).map((item) => item.identifier), DEFAULT_ORDER.slice(0, 3).map((entry) => entry.identifier));
		const off = setEnabled(collection, 'charPersonality', false);
		assert.strictEqual(off.find((item) => item.identifier === 'charPersonality')?.enabled, false);
		const moved = movePrompt(collection, 'jailbreak', -2);
		const index = moved.findIndex((item) => item.identifier === 'jailbreak');
		assert.strictEqual(index, 10, 'jailbreak moved two places earlier');
		assert.strictEqual(moved[index + 1].identifier, 'dialogueExamples');
		assert.strictEqual(moved[index - 1].identifier, 'worldInfoAfter');
		assert.strictEqual(movePrompt(collection, IDENTITY_PROMPT, 3)[0].identifier, IDENTITY_PROMPT, 'the identity block stays first');
	});

	test('an entry activates by key, by constant, by decorator — never after @@dont_activate', () => {
		const keyed = lore({ books: [loreBookOf([{ uid: 0, key: ['salt'], content: 'The flats drink sound.' }])] });
		const hit = activateLore(keyed);
		assert.deepStrictEqual(hit.before, ['The flats drink sound.']);
		assert.strictEqual(hit.activated.length, 1);
		assert.strictEqual(hit.activated[0].reason, 'key');
		assert.strictEqual(hit.activated[0].book, 'Book');

		const missed = activateLore(lore({ books: [loreBookOf([{ uid: 0, key: ['volcano'], content: 'nope' }])] }));
		assert.deepStrictEqual(missed.before, []);

		const constant = activateLore(lore({ books: [loreBookOf([{ uid: 1, key: [], content: 'Always here.', constant: true }])] }));
		assert.deepStrictEqual(constant.before, ['Always here.']);
		assert.strictEqual(constant.activated[0].reason, 'constant');

		const forced = activateLore(lore({ books: [loreBookOf([{ uid: 2, key: ['nothing'], content: '@@activate Forced.' }])] }));
		assert.deepStrictEqual(forced.before, ['Forced.']);
		assert.strictEqual(forced.activated[0].reason, '@@activate');

		const refused = activateLore(lore({ books: [loreBookOf([{ uid: 3, key: [], content: '@@dont_activate Never.', constant: true }])] }));
		assert.deepStrictEqual(refused.before, []);
	});

	test('the four secondary-key logics decide together with the primary match', () => {
		const run = (logic: number, secondary: string[]): string[] =>
			activateLore(
				lore({
					books: [loreBookOf([{ uid: 0, key: ['salt'], keysecondary: secondary, selectiveLogic: logic, content: 'Hit.' }])],
				}),
			).before;

		assert.deepStrictEqual(run(WI_LOGIC.andAny, ['flats']), ['Hit.']);
		assert.deepStrictEqual(run(WI_LOGIC.andAny, ['volcano']), []);
		assert.deepStrictEqual(run(WI_LOGIC.notAll, ['volcano']), ['Hit.']);
		assert.deepStrictEqual(run(WI_LOGIC.notAll, ['flats']), []);
		assert.deepStrictEqual(run(WI_LOGIC.notAny, ['volcano']), ['Hit.']);
		assert.deepStrictEqual(run(WI_LOGIC.notAny, ['flats']), []);
		assert.deepStrictEqual(run(WI_LOGIC.andAll, ['salt', 'flats']), ['Hit.']);
		assert.deepStrictEqual(run(WI_LOGIC.andAll, ['salt', 'volcano']), []);
		// `selective: false` drops the secondary requirement altogether.
		const loose = activateLore(
			lore({ books: [loreBookOf([{ uid: 0, key: ['salt'], keysecondary: ['volcano'], selective: false, content: 'Hit.' }])] }),
		);
		assert.deepStrictEqual(loose.before, ['Hit.']);
	});

	test('keys match as patterns, as whole words, and case-sensitively when asked', () => {
		const withKey = (patch: Partial<WorldEntry>, text = 'Tell me about the salt flats'): string[] =>
			activateLore(lore({ books: [loreBookOf([{ uid: 0, content: 'Hit.', ...patch }])], messages: [{ text }] })).before;

		assert.deepStrictEqual(withKey({ key: ['/flat(s)?/i'] }), ['Hit.']);
		assert.deepStrictEqual(withKey({ key: ['/^salt/'] }), [], 'anchored patterns see the whole scan text');
		assert.deepStrictEqual(withKey({ key: ['salt'] }, 'salty'), ['Hit.']);
		assert.deepStrictEqual(withKey({ key: ['salt'], matchWholeWords: true }, 'salty'), []);
		assert.deepStrictEqual(withKey({ key: ['salty'], matchWholeWords: true }, 'salty'), ['Hit.']);
		assert.deepStrictEqual(withKey({ key: ['SALT'], caseSensitive: true }), []);
		assert.deepStrictEqual(withKey({ key: ['SALT'], caseSensitive: false }), ['Hit.']);
		// A pattern that does not compile is a plain substring, never an exception.
		assert.deepStrictEqual(withKey({ key: ['/[/'] }), []);
		// Keys are substituted before matching, so a macro key sees the real name.
		assert.deepStrictEqual(
			activateLore(
				lore({
					books: [loreBookOf([{ uid: 0, key: ['{{char}}'], content: 'Hit.' }])],
					messages: [{ text: 'Kestrel, hello' }],
					substitute: (text) => text.replace('{{char}}', 'Kestrel'),
				}),
			).before,
			['Hit.'],
		);
	});

	test('the scan depth, sticky, cooldown, delay and recursion gate activation', () => {
		const entry = (patch: Partial<WorldEntry>): LoreBook => loreBookOf([{ uid: 0, key: ['salt'], content: 'Hit.', ...patch }]);
		// Newest first, as the scan is handed them: the keyword is one message back.
		const twoBack = [{ text: 'nothing' }, { text: 'salt' }];

		// Only `scanDepth` messages back are read; the shipped default is two.
		assert.deepStrictEqual(activateLore(lore({ books: [entry({})], messages: twoBack })).before, ['Hit.']);
		assert.deepStrictEqual(
			activateLore(lore({ books: [entry({})], messages: twoBack, settings: { ...WI_SETTINGS_DEFAULTS, scanDepth: 1 } })).before,
			[],
		);

		// Sticky keeps it alive once the words are gone; cooldown holds it back while they remain.
		const first = activateLore(lore({ books: [entry({ sticky: 2 })], turn: 0 }));
		assert.deepStrictEqual(first.before, ['Hit.']);
		const later = activateLore(lore({ books: [entry({ sticky: 2 })], messages: [{ text: 'nothing' }], turn: 1, effects: first.effects }));
		assert.deepStrictEqual(later.before, ['Hit.'], 'sticky outlives the message that triggered it');
		assert.strictEqual(later.activated[0].reason, 'sticky');

		const cooled = activateLore(lore({ books: [entry({ cooldown: 2 })], turn: 0 }));
		const again = activateLore(lore({ books: [entry({ cooldown: 2 })], turn: 1, effects: cooled.effects }));
		assert.deepStrictEqual(again.before, [], 'cooldown suppresses a repeat');

		const delayed = activateLore(lore({ books: [entry({ delay: 2 })], turn: 0 }));
		const suppressed = activateLore(lore({ books: [entry({ delay: 2 })], turn: 1, effects: delayed.effects }));
		assert.deepStrictEqual(suppressed.before, [], 'delay holds the entry back for that many messages');
		const released = activateLore(lore({ books: [entry({ delay: 2 })], turn: 2, effects: delayed.effects }));
		assert.deepStrictEqual(released.before, ['Hit.'], 'the delay expires on its own');

		// Recursion: only after something activated may the recursive scan use its text.
		const chain: LoreBook = {
			name: 'Chain',
			kind: 'character',
			book: {
				name: 'Chain',
				entries: {
					a: worldEntry({ uid: 0, key: ['salt'], content: 'The tide is out.' }),
					b: worldEntry({ uid: 1, key: ['tide'], content: 'Tide lore.' }),
				},
			},
		};
		assert.deepStrictEqual(activateLore(lore({ books: [chain] })).before, ['The tide is out.']);
		const recursive = activateLore(lore({ books: [chain], settings: { ...WI_SETTINGS_DEFAULTS, recursive: true } }));
		assert.deepStrictEqual(recursive.before, ['The tide is out.', 'Tide lore.']);
		// `delayUntilRecursion` keeps an entry out of the first pass entirely.
		const delayedChain: LoreBook = {
			name: 'Chain',
			kind: 'character',
			book: {
				name: 'Chain',
				entries: {
					a: worldEntry({ uid: 0, key: ['salt'], content: 'The tide is out.' }),
					b: worldEntry({ uid: 1, key: ['tide'], content: 'Tide lore.', delayUntilRecursion: 1 }),
				},
			},
		};
		assert.deepStrictEqual(activateLore(lore({ books: [delayedChain] })).before, ['The tide is out.']);
		assert.deepStrictEqual(
			activateLore(lore({ books: [delayedChain], settings: { ...WI_SETTINGS_DEFAULTS, recursive: true } })).before,
			['The tide is out.', 'Tide lore.'],
		);
	});

	test('probability, the token budget and minimum activations decide what survives', () => {
		const long = (uid: number, order: number): Partial<WorldEntry> & { uid: number; content: string } => ({
			uid,
			key: ['salt'],
			order,
			content: `Entry ${uid} ${'x'.repeat(39)}`,
		});

		// Probability: `random() * 100 > probability` is a miss, and a miss is not retried.
		let calls = 0;
		const miss = activateLore(
			lore({
				books: [loreBookOf([{ uid: 0, key: ['salt'], content: 'Hit.', probability: 50 }])],
				random: () => {
					calls += 1;
					return 0.99;
				},
			}),
		);
		assert.deepStrictEqual(miss.before, []);
		assert.strictEqual(miss.activated.length, 0);

		// Budget: 1% of 100 tokens. The first entry is always let through, the second is not.
		const tight = activateLore(
			lore({
				books: [loreBookOf([long(0, 150), long(1, 100)])],
				contextSize: 100,
				settings: { ...WI_SETTINGS_DEFAULTS, budget: 1 },
			}),
		);
		assert.strictEqual(tight.activated.length, 1);
		assert.strictEqual(tight.overflowed, true);
		// `ignoreBudget` is exempt from the gate.
		const exempt = activateLore(
			lore({
				books: [loreBookOf([{ ...long(0, 150) }, { ...long(1, 100), ignoreBudget: true }])],
				contextSize: 100,
				settings: { ...WI_SETTINGS_DEFAULTS, budget: 1 },
			}),
		);
		assert.strictEqual(exempt.activated.length, 2);

		// Minimum activations: the scan reaches deeper until enough entries fired.
		const deep: LoreInput = lore({
			books: [loreBookOf([{ uid: 0, key: ['ancient'], content: 'Deep lore.' }])],
			messages: [{ text: 'nothing here' }, { text: 'ancient history' }],
			settings: { ...WI_SETTINGS_DEFAULTS, scanDepth: 1, minActivations: 1, maxActivationsDepth: 2 },
		});
		assert.deepStrictEqual(deep.messages.length, 2);
		assert.deepStrictEqual(activateLore(deep).before, ['Deep lore.']);
	});

	test('groups keep only their strongest member', () => {
		const byWeight = activateLore(
			lore({
				books: [
					loreBookOf([
						{ uid: 0, key: ['salt'], content: 'Weak.', group: 'g', groupWeight: 100 },
						{ uid: 1, key: ['salt'], content: 'Strong.', group: 'g', groupWeight: 200 },
					]),
				],
			}),
		);
		assert.deepStrictEqual(byWeight.before, ['Strong.']);

		const override = activateLore(
			lore({
				books: [
					loreBookOf([
						{ uid: 0, key: ['salt'], content: 'Weak.', group: 'g', groupWeight: 100, groupOverride: true },
						{ uid: 1, key: ['salt'], content: 'Strong.', group: 'g', groupWeight: 200 },
					]),
				],
			}),
		);
		assert.deepStrictEqual(override.before, ['Weak.']);

		// Scoring by matched keys needs both the entry and the settings to opt in.
		const byScore = activateLore(
			lore({
				books: [
					loreBookOf([
						{ uid: 0, key: ['salt'], content: 'One key.', group: 'g', groupWeight: 200, useGroupScoring: true },
						{ uid: 1, key: ['salt', 'flats'], content: 'Two keys.', group: 'g', groupWeight: 100, useGroupScoring: true },
					]),
				],
			}),
		);
		assert.deepStrictEqual(byScore.before, ['Two keys.']);
	});

	test('positions bucket the activated entries, lowest order first', () => {
		const books = [
			loreBookOf([
				{ uid: 0, key: ['salt'], content: 'Second.', order: 150, position: WI_POSITION.before },
				{ uid: 1, key: ['salt'], content: 'First.', order: 50, position: WI_POSITION.before },
				{ uid: 2, key: ['salt'], content: 'After.', position: WI_POSITION.after },
				{ uid: 3, key: ['salt'], content: 'Note top.', position: WI_POSITION.anTop },
				{ uid: 4, key: ['salt'], content: 'Note bottom.', position: WI_POSITION.anBottom },
				{ uid: 5, key: ['salt'], content: 'Example top.', position: WI_POSITION.emTop },
				{ uid: 6, key: ['salt'], content: 'Example bottom.', position: WI_POSITION.emBottom },
				{ uid: 7, key: ['salt'], content: 'Deep.', position: WI_POSITION.atDepth, depth: 2, role: WI_ROLE.user },
				{ uid: 8, key: ['salt'], content: 'Shallow.', position: WI_POSITION.atDepth, depth: 1 },
				{ uid: 9, key: ['salt'], content: 'Out.', position: WI_POSITION.outlet, outletName: 'sign' },
			]),
		];
		const result = activateLore(lore({ books }));
		assert.deepStrictEqual(result.before, ['First.', 'Second.']);
		assert.deepStrictEqual(result.after, ['After.']);
		assert.deepStrictEqual(result.anTop, ['Note top.']);
		assert.deepStrictEqual(result.anBottom, ['Note bottom.']);
		assert.deepStrictEqual(result.examplesBefore, ['Example top.']);
		assert.deepStrictEqual(result.examplesAfter, ['Example bottom.']);
		assert.deepStrictEqual(result.outlets, { sign: ['Out.'] });
		assert.deepStrictEqual(result.atDepth.map((injection) => [injection.depth, injection.content]), [
			[2, 'Deep.'],
			[1, 'Shallow.'],
		]);
		assert.strictEqual(result.atDepth[0].role, WI_ROLE.user);
	});

	test('books are scanned chat first, then persona, then character before global', () => {
		const make = (kind: LoreBook['kind'], content: string, order: number): LoreBook => ({
			name: kind,
			kind,
			book: { name: kind, entries: { a: worldEntry({ uid: 0, key: ['salt'], content, order }) } },
		});
		const result = activateLore(
			lore({
				books: [make('global', 'Global.', 100), make('chat', 'Chat.', 1), make('persona', 'Persona.', 100), make('character', 'Character.', 100)],
			}),
		);
		assert.deepStrictEqual(result.before, ['Chat.', 'Persona.', 'Character.', 'Global.']);

		const globalFirst = activateLore(
			lore({
				books: [make('global', 'Global.', 100), make('character', 'Character.', 100)],
				settings: { ...WI_SETTINGS_DEFAULTS, characterStrategy: WI_STRATEGY.globalFirst },
			}),
		);
		assert.deepStrictEqual(globalFirst.before, ['Global.', 'Character.']);
	});

	test('a card’s own book becomes a scannable world book', () => {
		const card = normaliseCard(parseCard(JSON.stringify(CARD_V2)), 'kestrel', 'memory');
		const book = toWorldBook(card.book, 'Kestrel');
		assert.strictEqual(book.name, 'Salt Flats');
		const entry = book.entries['0'];
		assert.deepStrictEqual(entry.key, ['salt', 'flats']);
		assert.strictEqual(entry.order, 20);
		assert.strictEqual(entry.position, WI_POSITION.after);
		assert.strictEqual(entry.disable, false);
		const result = activateLore(lore({ books: [{ name: 'Kestrel', kind: 'character', book }] }));
		assert.deepStrictEqual(result.after, ['The flats drink sound.']);
	});

	test('the assembler orders the blocks, the history and the in-chat injections', () => {
		const messages = assemble(
			promptCollection(),
			{
				identity: 'You are Comonad.',
				charDescription: 'A cartographer.',
				charPersonality: 'Terse.',
				scenario: 'Dusk.',
				personaDescription: 'A reader.',
				worldInfoBefore: 'Lore: the flats.',
				examples: '<START>\nYou: hi\nKestrel: hm.',
				atDepth: [{ depth: 0, role: WI_ROLE.system, content: 'Deep note.' }],
			},
			[
				{ role: 'user', content: 'hello' },
				{ role: 'assistant', content: 'hm' },
			],
			{ wiFormat: '{0}' },
		);
		const texts = messages.map((message) => message.content);
		const at = (needle: string): number => texts.findIndex((text) => text.startsWith(needle));
		assert.strictEqual(texts[0], 'You are Comonad.', 'the agent identity leads');
		assert.ok(at('Lore: the flats.') > 0 && at('Lore: the flats.') < at('A reader.'));
		assert.ok(at('A reader.') < at('A cartographer.'));
		assert.ok(at('A cartographer.') < at('Terse.'));
		assert.ok(at('Terse.') < at('Dusk.'));
		assert.ok(at('<START>') < at('hello'), 'examples come before the history');
		assert.strictEqual(texts[texts.length - 1], 'Deep note.', 'a depth-0 injection follows the last message');
		assert.deepStrictEqual(messages.filter((message) => message.content === 'hm').map((message) => message.role), ['assistant']);

		// Switching a block off removes it, and an empty block is never sent.
		const trimmed = assemble(setEnabled(promptCollection(), 'charPersonality', false), { identity: 'You are Comonad.', charPersonality: 'Terse.' }, []);
		assert.ok(!trimmed.some((message) => message.content === 'Terse.'));
		assert.strictEqual(trimmed[0].content, 'You are Comonad.');
		assert.ok(trimmed.length <= 2, 'only the identity and the main prompt have text of their own');

		// `wi_format` wraps the world-info blocks.
		const wrapped = assemble(promptCollection(), { identity: 'i', worldInfoBefore: 'the flats' }, [], { wiFormat: 'Lore: {0}' });
		assert.ok(wrapped.some((message) => message.content === 'Lore: the flats'));

		// A collection that never mentions the history still gets the conversation.
		const noHistory = promptCollection().filter((prompt) => prompt.identifier !== 'chatHistory');
		const withHistory = assemble(noHistory, { identity: 'i' }, [{ role: 'user', content: 'kept' }]);
		assert.ok(withHistory.some((message) => message.content === 'kept'));

		assert.deepStrictEqual(
			injectAtDepth(
				[
					{ role: 'user', content: 'a' },
					{ role: 'assistant', content: 'b' },
					{ role: 'user', content: 'c' },
				],
				[{ depth: 1, role: WI_ROLE.user, content: 'X' }],
			).map((message) => message.content),
			['a', 'b', 'X', 'c'],
		);
		assert.deepStrictEqual(exampleMessages('<START>\none').map((message) => message.content), ['<START>\none\n']);
	});

	test('regex scripts honour placement, depth, markdown/prompt gates and trim strings', () => {		const script = makeScript({ scriptName: 's', findRegex: '/\\bfoo\\b/g', replaceString: 'bar', placement: [REGEX_PLACEMENT.aiOutput] });
		assert.strictEqual(applyRegex([script], 'foo foo', { placement: REGEX_PLACEMENT.aiOutput }), 'bar bar');
		assert.strictEqual(applyRegex([script], 'foo', { placement: REGEX_PLACEMENT.userInput }), 'foo');
		assert.strictEqual(applyRegex([{ ...script, disabled: true }], 'foo', { placement: REGEX_PLACEMENT.aiOutput }), 'foo');

		const deep = makeScript({ ...script, minDepth: 3 });
		assert.strictEqual(applyRegex([deep], 'foo', { placement: REGEX_PLACEMENT.aiOutput, depth: 1 }), 'foo');
		assert.strictEqual(applyRegex([deep], 'foo', { placement: REGEX_PLACEMENT.aiOutput, depth: 4 }), 'bar');
		const shallow = makeScript({ ...script, maxDepth: 1 });
		assert.strictEqual(applyRegex([shallow], 'foo', { placement: REGEX_PLACEMENT.aiOutput, depth: 2 }), 'foo');

		const markdown = makeScript({ ...script, markdownOnly: true });
		assert.strictEqual(applyRegex([markdown], 'foo', { placement: REGEX_PLACEMENT.aiOutput, isPrompt: true }), 'foo');
		assert.strictEqual(applyRegex([markdown], 'foo', { placement: REGEX_PLACEMENT.aiOutput, isMarkdown: true }), 'bar');

		// Editing only runs the scripts that opt in.
		assert.strictEqual(applyRegex([script], 'foo', { placement: REGEX_PLACEMENT.userInput, isEdit: true }), 'foo');
		const onEdit = makeScript({ ...script, placement: [REGEX_PLACEMENT.userInput], runOnEdit: true });
		assert.strictEqual(applyRegex([onEdit], 'foo', { placement: REGEX_PLACEMENT.userInput, isEdit: true }), 'bar');

		// {{match}} is the whole match, `$1` and `$<name>` are capture groups, trimStrings are removed.
		assert.strictEqual(
			applyRegex([makeScript({ findRegex: 'a(b)c', replaceString: '[{{match}}|$1]' })], 'abc', { placement: REGEX_PLACEMENT.aiOutput }),
			'[abc|b]',
		);
		assert.strictEqual(applyRegex([makeScript({ findRegex: '/o+/g', replaceString: '0', trimStrings: ['x'] })], 'xoxo', { placement: REGEX_PLACEMENT.aiOutput }), '00');
		// A plain pattern carries no flags, so only its first match is replaced — as upstream.
		assert.strictEqual(applyRegex([makeScript({ findRegex: 'foo', replaceString: 'bar' })], 'foo foo', { placement: REGEX_PLACEMENT.aiOutput }), 'bar foo');
	});

	test('with no content selected the request is the agent prompt plus the history, nothing else', async () => {
		const kernel = await createTestKernel();
		try {
			let seen: Message[] = [];
			kernel.ctx.llm.use({
				name: 'test',
				async chat(request) {
					seen = request.messages;
					return { message: { role: 'assistant', content: 'ok' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			await kernel.ctx.agent.runTurn({ text: 'hi', sessionId: 'plain' });
			// The guard that makes the whole port risk-free: an idle tavern layer changes nothing.
			assert.strictEqual(seen.length, 2, `expected the identity and the prompt, got ${JSON.stringify(seen)}`);
			assert.strictEqual(seen[0].role, 'system');
			assert.ok(seen[0].content.startsWith('You are Comonad'), 'the identity block still leads');
			assert.ok(!seen[0].content.includes('lore_lookup'), 'and never advertises a tool with no books behind it');
			assert.strictEqual(seen[1].role, 'user');
			assert.strictEqual(seen[1].content, 'hi');

			const inert = kernel.ctx.tavern.compose({
				identity: 'identity',
				history: [{ role: 'user', content: 'hi' }],
				binding: {},
				scan: [{ role: 'user', text: 'hi' }],
				turn: 1,
			});
			assert.strictEqual(inert.inert, true);
			assert.deepStrictEqual(inert.activated, []);
			assert.deepStrictEqual(inert.messages.map((message) => message.content), ['identity', 'hi']);
		} finally {
			await kernel.dispose();
		}
	});

	test('a greeting is a turn of its own: no prompt, no regenerate, never trimmed away', async () => {
		// A leading assistant message used to be dropped as traffic with nothing to attach it to.
		const turns = turnsOf([
			{ role: 'assistant', content: 'Kestrel looks up.', greeting: true, at: 1, startedAt: 0 },
			{ role: 'user', content: 'hello', at: 2 },
			{ role: 'assistant', content: 'hm', at: 3 },
		]);
		assert.strictEqual(turns.length, 2);
		assert.strictEqual(turns[0].greeting, true);
		assert.strictEqual(turns[0].prompt, '');
		assert.deepStrictEqual(turns[0].steps.map((step) => step.text), ['Kestrel looks up.']);
		assert.strictEqual(turns[1].prompt, 'hello');

		// The opening line is pinned, so a growing chat does not silently lose the character's premise.
		const long = [
			{ role: 'assistant', content: 'Kestrel looks up.', greeting: true } as Message,
			...Array.from({ length: 6 }, (_, index) => ({ role: 'user', content: `turn ${index} ${'x'.repeat(400)}` }) as Message),
		];
		const trimmed = applyContextLimit(long, 200);
		assert.strictEqual(trimmed[0].greeting, true, 'the greeting survives the trim');
		assert.ok(trimmed.length < long.length, 'and the trim still happened');

		const kernel = await createTestKernel();
		try {
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'greet');
			assert.strictEqual(kernel.ctx.sessions.greet('greet', 'Kestrel looks up.', 1), true);
			assert.strictEqual(kernel.ctx.sessions.greeted('greet'), 1);
			assert.strictEqual(kernel.ctx.sessions.require('greet').transcript.length, 1);
			// The opening line is content: the chat is filed, so a reload finds it again.
			assert.strictEqual(unusedChat(kernel.ctx.sessions.require('greet')), false);
			assert.deepStrictEqual(kernel.ctx.sessions.list().map((entry) => entry.id), ['greet']);
			assert.strictEqual(kernel.ctx.sessions.replayLast('greet'), '', 'there is no prompt to run again');

			// A chat that already said something is never rewritten.
			session.transcript.push({ role: 'user', content: 'hello', at: 2 });
			kernel.ctx.sessions.save(session);
			assert.strictEqual(kernel.ctx.sessions.greet('greet', 'A second opening.'), false);
			assert.strictEqual(kernel.ctx.sessions.require('greet').transcript[0].content, 'Kestrel looks up.');
		} finally {
			await kernel.dispose();
		}
	});

	test('lore_lookup searches the active books and never changes what gets injected', async () => {
		const kernel = await createTestKernel({ config: { tavernLorebooks: ['Salt'], tavernCharacter: 'kestrel' } });
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'characters'), { recursive: true });
			mkdirSync(join(library, 'lorebooks'), { recursive: true });
			writeFileSync(
				join(library, 'characters', 'kestrel.json'),
				JSON.stringify({
					spec: 'chara_card_v2',
					spec_version: '2.0',
					data: {
						name: 'Kestrel',
						description: 'A cartographer.',
						first_mes: 'Kestrel looks up.',
						character_book: {
							name: 'Kestrel notes',
							entries: [{ keys: ['atlas'], comment: 'Her atlas', content: 'Her atlas is water-stained.' }],
						},
					},
				}),
			);
			writeFileSync(
				join(library, 'lorebooks', 'Salt.json'),
				JSON.stringify({
					name: 'Salt',
					entries: {
						'0': { uid: 0, key: ['salt'], comment: 'The flats', content: 'The flats drink sound.' },
						'1': { uid: 1, key: ['/shadowfang(s)?/i'], comment: 'Beasts', content: 'They came from the east.', disable: true },
						'2': { uid: 2, key: ['glade'], comment: 'The glade', content: 'A sanctuary of peace.' },
					},
				}),
			);
			await kernel.ctx.tavern.reload();
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'lore');
			kernel.ctx.sessions.save(session);

			const tool = kernel.ctx.tools.get('lore_lookup');
			assert.ok(tool, 'the tool is registered');
			const context = {
				sessionId: 'lore',
				workspace: '',
				policy: policy(),
				signal: new AbortController().signal,
				log: () => undefined,
				ask: async () => [],
				todos: () => [],
				tasks: {
					start: () => ({ id: 't', command: '', cwd: '', startedAt: 0, output: '', exitCode: null }),
					read: () => '',
					stop: () => false,
					list: () => [],
				},
				spawnAgent: async () => '',
			};
			const hit = await tool.execute({ query: 'salt' }, context);
			assert.ok(hit.includes('The flats drink sound.'), hit);
			assert.ok(hit.includes('### The flats — Salt (matched key)'), hit);
			assert.ok(hit.includes('keys: salt'), hit);
			// The card's own book is searchable too, beside the library book the chat selected.
			const card = await tool.execute({ query: 'atlas' }, context);
			assert.ok(card.includes('### Her atlas — Kestrel (card)'), card);
			assert.ok(card.includes('Her atlas is water-stained.'), card);
			assert.ok(!(await tool.execute({ query: 'east' }, context)).includes('They came from the east.'), 'a disabled entry is not returned');
			assert.ok((await tool.execute({ query: 'zzz' }, context)).startsWith('No entry in'), 'a miss says so');
			assert.ok((await tool.execute({ query: 'x', book: 'Nope' }, context)).startsWith('Error: no world book named'), 'an unknown book is an error');
			assert.strictEqual(await tool.execute({}, context), 'Error: lore_lookup needs a query.');
			// It is a read-only capability: offered in the read modes, never in a tool-less chat.
			assert.ok(kernel.ctx.tools.visible(policy({ workMode: 'ro' })).some((spec) => spec.name === 'lore_lookup'));
			assert.ok(!kernel.ctx.tools.visible(policy({ workMode: 'chat' })).some((spec) => spec.name === 'lore_lookup'));
			assert.ok(kernel.ctx.tools.visible(policy({ workingDirectory: '' })).some((spec) => spec.name === 'lore_lookup'), 'no workspace needed');

			// A lookup writes nothing: what the chat's last scan activated must survive it untouched.
			const stored = kernel.ctx.sessions.require('lore');
			stored.tavernActivated = [{ book: 'Salt', comment: 'The glade', reason: 'key' }];
			kernel.ctx.sessions.save(stored);
			const before = kernel.ctx.tavern.booksFor('lore').map((book) => book.name).sort();
			await tool.execute({ query: 'glade' }, context);
			assert.deepStrictEqual(kernel.ctx.tavern.booksFor('lore').map((book) => book.name).sort(), before);
			assert.deepStrictEqual(kernel.ctx.sessions.require('lore').tavernActivated, [{ book: 'Salt', comment: 'The glade', reason: 'key' }]);
		} finally {
			await kernel.dispose();
		}
	});

	test('the catalog answers by name, and binding a character opens the chat with its greeting', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'characters'), { recursive: true });
			mkdirSync(join(library, 'lorebooks'), { recursive: true });
			mkdirSync(join(library, 'personas'), { recursive: true });
			writeFileSync(
				join(library, 'characters', 'kestrel.json'),
				JSON.stringify({ name: 'Kestrel', first_mes: 'Kestrel looks up.', alternate_greetings: ['Kestrel is asleep.'] }),
			);
			writeFileSync(join(library, 'lorebooks', 'Salt.json'), JSON.stringify({ name: 'Salt', entries: {} }));
			writeFileSync(join(library, 'personas', 'Narrator.json'), JSON.stringify({ name: 'Narrator', title: 'The Narrator', description: 'Second person.' }));
			await kernel.ctx.tavern.reload();

			// A slash command is typed by hand, so every lookup is case-insensitive and accepts an id.
			assert.strictEqual(kernel.ctx.tavern.findCharacter('kestrel')?.name, 'Kestrel');
			assert.strictEqual(kernel.ctx.tavern.findCharacter('KESTREL')?.id, 'kestrel');
			assert.strictEqual(kernel.ctx.tavern.findCharacter('nobody'), undefined);
			assert.strictEqual(kernel.ctx.tavern.findPersona('the narrator')?.id, 'Narrator');
			assert.deepStrictEqual(kernel.ctx.tavern.resolveBooks(['salt', ' Missing ']), { found: ['Salt'], missing: ['Missing'] });

			// The greeting list is the card's own line first, then the alternates — and the index is recorded.
			const character = kernel.ctx.tavern.findCharacter('kestrel')!;
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'bound');
			const greetings = greetingsOf(character);
			assert.deepStrictEqual(greetings, ['Kestrel looks up.', 'Kestrel is asleep.']);
			session.character = character.id;
			kernel.ctx.sessions.save(session);
			assert.strictEqual(kernel.ctx.sessions.greet(session.id, greetings[1]!, 1), true);
			assert.strictEqual(kernel.ctx.sessions.require('bound').character, 'kestrel');
			assert.strictEqual(kernel.ctx.sessions.require('bound').transcript[0].content, 'Kestrel is asleep.');
			assert.strictEqual(kernel.ctx.sessions.greeted('bound'), 1);
		} finally {
			await kernel.dispose();
		}
	});

	test('a prompt collection saves as a preset in the native store and reads back', async () => {
		const kernel = await createTestKernel({ config: { tavernPreset: 'Test' } });
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'presets'), { recursive: true });
			writeFileSync(join(library, 'presets', 'Test.json'), JSON.stringify({ temperature: 0.5, prompts: [], prompt_order: [] }));
			await kernel.ctx.tavern.reload();

			const collection = kernel.ctx.tavern.promptsFor();
			const defaultOrder = collection.map((prompt) => prompt.identifier);
			assert.deepStrictEqual(defaultOrder.slice(0, 3), ['comonad', 'main', 'worldInfoBefore'], 'the shipped order is what the panel edits');

			// Rearrange and switch one block off, the way the Prompts table does.
			const edited = collection.map((prompt) => (prompt.identifier === 'nsfw' ? { ...prompt, enabled: false } : prompt));
			const moved = [
				edited[0]!,
				edited[2]!,
				edited[1]!,
				...edited.slice(3),
			].map((prompt, index) => (prompt.identifier === 'dialogueExamples' ? { ...prompt, injection_position: 1, injection_depth: 2 } : prompt));
			const id = await kernel.ctx.tavern.savePreset('Edited', moved, kernel.ctx.tavern.preset('Test'));
			assert.strictEqual(id, 'Edited');

			const saved = kernel.ctx.tavern.preset('Edited');
			assert.ok(saved, 'the preset is in the catalog after the reload the save performs');
			assert.strictEqual(saved?.temperature, 0.5, 'the samplers of the base preset survive');
			// A chat that selects the new preset reads the edited collection back.
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor());
			session.preset = 'Edited';
			kernel.ctx.sessions.save(session);
			const reread = kernel.ctx.tavern.promptsFor(session.id);
			assert.strictEqual(reread[0]?.identifier, 'comonad', 'the identity block still leads');
			assert.strictEqual(reread[1]?.identifier, 'worldInfoBefore', 'the move is what the file stores');
			assert.strictEqual(reread.find((prompt) => prompt.identifier === 'nsfw')?.enabled, false);
			assert.strictEqual(reread.find((prompt) => prompt.identifier === 'dialogueExamples')?.injection_depth, 2);
			// The file is Comonad's own: a name with spaces becomes a safe file name.
			assert.ok(existsSync(join(library, 'presets', 'Edited.json')));
			assert.strictEqual(await kernel.ctx.tavern.savePreset('My Preset!', moved), 'My-Preset');
		} finally {
			await kernel.dispose();
		}
	});

	test('content is created, edited and deleted in Comonad’s own library', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			// The library folders are Comonad's own: nothing here is a SillyTavern directory.
			assert.deepStrictEqual(kernel.ctx.tavern.roots(), [library, join(kernel.ctx.settings.home(), '.comonad')]);

			// A new character: a V2 JSON card in `.comonad/characters`.
			const character = blankCharacter('Kestrel', 'Kestrel');
			character.description = 'A cartographer.';
			character.greeting = 'Kestrel looks up.';
			const cardFile = await kernel.ctx.tavern.saveCharacter(character);
			assert.strictEqual(cardFile, join(library, 'characters', 'Kestrel.json'));
			const cardJson = JSON.parse(readFileSync(cardFile, 'utf8')) as { spec: string; data: { first_mes: string } };
			assert.strictEqual(cardJson.spec, 'chara_card_v2', 'a card is written in the V2 shape SillyTavern reads');
			assert.strictEqual(cardJson.data.first_mes, 'Kestrel looks up.');
			assert.strictEqual(kernel.ctx.tavern.character('Kestrel')?.description, 'A cartographer.', 'and comes back in the catalog');

			// Editing writes the same file back, with the fields the editor changed.
			const edited = kernel.ctx.tavern.character('Kestrel')!;
			edited.description = 'A cartographer of dead cities.';
			await kernel.ctx.tavern.saveCharacter(edited);
			assert.strictEqual(kernel.ctx.tavern.character('Kestrel')?.description, 'A cartographer of dead cities.');

			// Books, personas and presets work the same way, in their own folders.
			const book = blankBook('Salt');
			book.entries['0'] = worldEntry({ uid: 0, key: ['salt'], content: 'The flats drink sound.', position: 1, depth: 2 });
			const bookFile = await kernel.ctx.tavern.saveBook('Salt', book);
			assert.strictEqual(bookFile, join(library, 'lorebooks', 'Salt.json'));
			assert.ok(kernel.ctx.tavern.book('Salt'));
			const personaFile = await kernel.ctx.tavern.savePersona(blankPersona('Narrator', 'Narrator'));
			assert.strictEqual(personaFile, join(library, 'personas', 'Narrator.json'));
			assert.ok(kernel.ctx.tavern.persona('Narrator'));
			const promptFile = await kernel.ctx.tavern.savePresetValue(blankPreset('Test', 'Test'));
			assert.strictEqual(promptFile, join(library, 'presets', 'Test.json'));
			assert.ok(kernel.ctx.tavern.preset('Test'));

			// Deleting removes the file, and only ever inside our own library.
			assert.strictEqual(await kernel.ctx.tavern.deleteCharacter('Kestrel'), true);
			assert.strictEqual(existsSync(cardFile), false);
			assert.strictEqual(kernel.ctx.tavern.character('Kestrel'), undefined);
			assert.strictEqual(await kernel.ctx.tavern.deleteBook('Salt'), true);
			assert.strictEqual(await kernel.ctx.tavern.deletePersona('Narrator'), true);
			assert.strictEqual(await kernel.ctx.tavern.deletePreset('Test'), true);
			assert.deepStrictEqual(kernel.ctx.tavern.characters, []);
			assert.deepStrictEqual(kernel.ctx.tavern.books, []);
			assert.deepStrictEqual(kernel.ctx.tavern.personas, []);
			assert.deepStrictEqual(kernel.ctx.tavern.presets, []);

			// A card the user keeps outside `.comonad` is read but never written or deleted.
			const outside = join(kernel.root, 'elsewhere');
			mkdirSync(outside, { recursive: true });
			const stray = join(outside, 'Stray.json');
			writeFileSync(stray, JSON.stringify({ name: 'Stray', description: 'Read only.' }));
			await kernel.ctx.tavern.reload();
			assert.strictEqual(kernel.ctx.tavern.characters.length, 0, 'the library reads its own folders only');
			const loaded = await loadCard(stray);
			assert.strictEqual(await kernel.ctx.tavern.saveCharacter(loaded), join(library, 'characters', 'Stray.json'));
			assert.strictEqual(existsSync(stray), true, 'the original file is left where it was');
		} finally {
			await kernel.dispose();
		}
	});

	test('a world book round-trips through SillyTavern’s own file shape', async () => {
		const kernel = await createTestKernel();
		try {
			const file = join(kernel.root, 'ws', '.comonad', 'lorebooks', 'Full.json');
			const book = blankBook('Full');
			book.entries['0'] = worldEntry({
					uid: 0,
					key: ['salt'],
					keysecondary: ['flat'],
					comment: 'The flats',
					content: 'The flats drink sound.',
					constant: true,
					selectiveLogic: 3,
					order: 42,
					position: 4,
					depth: 2,
					role: 1,
					probability: 80,
					group: 'geography',
					groupWeight: 120,
					sticky: 3,
					cooldown: 2,
					delay: 1,
					scanDepth: 6,
					caseSensitive: true,
					triggers: ['normal'],
			});
			await kernel.ctx.tavern.saveBook('Full', book);

			// The file uses SillyTavern's names, mirrored the way it mirrors them.
			const json = JSON.parse(readFileSync(file, 'utf8')) as { entries: Record<string, Record<string, unknown>> };
			const entry = json.entries['0']!;
			assert.strictEqual(entry.position, 4);
			assert.strictEqual(entry.sticky, 3);
			assert.deepStrictEqual(entry.key, ['salt']);
			assert.deepStrictEqual(entry.keysecondary, ['flat']);
			assert.strictEqual(entry.order, 42);
			assert.deepStrictEqual(entry.triggers, ['normal']);
			const extensions = entry.extensions as Record<string, unknown>;
			assert.strictEqual(extensions.position, 4, 'and mirrored under extensions, as SillyTavern writes it');
			assert.strictEqual(extensions.sticky, 3);
			assert.strictEqual(extensions.role, 1);
			assert.strictEqual(extensions.scan_depth, 6);
			assert.strictEqual(extensions.selectiveLogic, 3);
			assert.strictEqual(extensions.ignore_budget, false);

			// Reading it back gives every field the writer was given.
			const reread = await readBookFile(file);
			assert.ok(reread);
			const back = worldEntry(reread.entries['0']!);
			for (const field of ['constant', 'selectiveLogic', 'order', 'position', 'depth', 'role', 'probability', 'group', 'groupWeight', 'sticky', 'cooldown', 'delay', 'scanDepth', 'caseSensitive'] as const) {
				assert.deepStrictEqual(back[field], book.entries['0']![field], `${field} survives the round trip`);
			}
			assert.deepStrictEqual(back.keysecondary, ['flat']);
			assert.deepStrictEqual(back.triggers, ['normal']);
		} finally {
			await kernel.dispose();
		}
	});

	test('a card’s bound book and depth prompt reach the request', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'characters'), { recursive: true });
			mkdirSync(join(library, 'lorebooks'), { recursive: true });
			writeFileSync(
				join(library, 'lorebooks', 'Salt.json'),
				JSON.stringify({ name: 'Salt', entries: { '0': { uid: 0, key: ['salt'], content: 'The flats drink sound.' } } }),
			);
			writeFileSync(
				join(library, 'characters', 'kestrel.json'),
				JSON.stringify({
					spec: 'chara_card_v2',
					spec_version: '2.0',
					data: {
						name: 'Kestrel',
						description: 'A cartographer.',
						first_mes: 'Kestrel looks up.',
						extensions: { world: 'Salt', depth_prompt: { prompt: 'Remember the map.', depth: 1, role: 'user' } },
					},
				}),
			);
			await kernel.ctx.tavern.reload();
			assert.strictEqual(kernel.ctx.tavern.character('kestrel')?.world, 'Salt', 'the card binds a world book');
			// The bound book is scanned for a chat that speaks as the card, without being listed.
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'salt-chat');
			session.character = 'kestrel';
			kernel.ctx.sessions.save(session);
			assert.deepStrictEqual(kernel.ctx.tavern.booksFor(session.id).map((book) => book.name), ['Salt']);

			const composed = kernel.ctx.tavern.compose({
				identity: 'identity',
				history: [
					{ role: 'user', content: 'About the salt?' },
					{ role: 'assistant', content: 'hm.' },
				],
				binding: { character: 'kestrel' },
				scan: [{ role: 'user', text: 'What do you know about the salt?' }],
				turn: 3,
			});
			const texts = composed.messages.map((message) => message.content);
			assert.ok(texts.some((text) => text.includes('The flats drink sound.')), 'the bound book activated');
			// A depth prompt is a character-specific author's note: spliced in at its own depth and role.
			const at = texts.findIndex((text) => text.includes('Remember the map.'));
			assert.ok(at >= 0, 'the depth prompt is in the request');
			assert.strictEqual(texts[at + 1], 'hm.', 'spliced in one message from the end of the history');
			assert.strictEqual(composed.messages[at]?.role, 'user', 'with the role the card asked for');
		} finally {
			await kernel.dispose();
		}
	});

	test('a persona bound to a character is used without being picked', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'personas'), { recursive: true });
			mkdirSync(join(library, 'characters'), { recursive: true });
			writeFileSync(
				join(library, 'personas', 'Cartographer.json'),
				JSON.stringify({ name: 'Ada', title: 'The apprentice', description: 'You are Ada, holding the lamp.', connections: ['Kestrel'] }),
			);
			writeFileSync(join(library, 'characters', 'kestrel.json'), JSON.stringify({ name: 'Kestrel', description: 'A cartographer.' }));
			await kernel.ctx.tavern.reload();

			const character = kernel.ctx.tavern.character('kestrel')!;
			const persona = kernel.ctx.tavern.personaFor(undefined, character);
			assert.strictEqual(persona?.id, 'Cartographer', 'the connection binds it to the card');
			assert.strictEqual(kernel.ctx.tavern.personaFor(undefined, undefined), undefined, 'and it is not used elsewhere');
			assert.strictEqual(kernel.ctx.tavern.personaFor('Ada', character)?.id, 'Cartographer', 'a pick by name still wins');
			// A stale pick falls back to the link: losing a persona because a file was renamed is worse.
			assert.strictEqual(kernel.ctx.tavern.personaFor('nobody', character)?.id, 'Cartographer');

			const composed = kernel.ctx.tavern.compose({
				identity: 'identity',
				history: [{ role: 'user', content: '{{user}} here.' }],
				binding: { character: 'kestrel' },
				scan: [{ role: 'user', text: 'hi' }],
				turn: 1,
			});
			assert.ok(
				composed.messages.some((message) => message.content.includes('You are Ada, holding the lamp.')),
				'the persona description is a block in the request',
			);
		} finally {
			await kernel.dispose();
		}
	});

	test('edited items are sanitised before they are written', async () => {
		// What a webview sends is untrusted: a bad value here becomes a corrupt file on disk.
		const character = adoptCharacter({
			name: 'Kestrel',
			description: 42,
			tags: ['one', '', 'two'],
			alternateGreetings: ['A', '   '],
			depthPrompt: { prompt: '   ', depth: 'deep', role: 'narrator' },
			book: { name: 'inner', entries: [] },
			raw: { spec: 'chara_card_v2', keep_me: true },
		});
		assert.strictEqual(character.id, 'Kestrel', 'the id falls back to the slugged name');
		assert.strictEqual(character.description, '', 'a non-string is not written as a string');
		assert.deepStrictEqual(character.tags, ['one', 'two']);
		assert.deepStrictEqual(character.alternateGreetings, ['A']);
		assert.strictEqual(character.depthPrompt, null, 'an empty depth prompt is no depth prompt');
		assert.deepStrictEqual(character.book, { name: 'inner', entries: [] }, 'the card’s own book is carried through');
		assert.deepStrictEqual(character.raw, { spec: 'chara_card_v2', keep_me: true }, 'and the document is never dropped');

		const depth = adoptCharacter({ name: 'K', depthPrompt: { prompt: 'Remember.', depth: 2, role: 'user' } });
		assert.deepStrictEqual(depth.depthPrompt, { prompt: 'Remember.', depth: 2, role: 'user' });

		const book = adoptBook({
			name: 'Salt',
			source: '/tmp/Salt.json',
			entries: {
				'0': {
					uid: 0,
					key: 'salt, flat',
					content: 'The flats drink sound.',
					position: 'after',
					depth: '2',
					sticky: null,
					cooldown: 5,
					caseSensitive: true,
					selective: false,
					useProbability: false,
					unknown_field: 'kept',
				},
			},
		});
		const entry = book.entries['0']!;
		assert.deepStrictEqual(entry.key, ['salt', 'flat'], 'a list sent as text is split');
		assert.strictEqual(entry.position, WI_POSITION.before, 'a wrong type keeps the default');
		assert.strictEqual(entry.depth, 4);
		assert.strictEqual(entry.sticky, null, 'an empty turn count stays empty rather than becoming 0');
		assert.strictEqual(entry.cooldown, 5);
		assert.strictEqual(entry.caseSensitive, true);
		assert.strictEqual(entry.selective, false);
		assert.strictEqual(entry.useProbability, false);
		assert.strictEqual((entry as unknown as Record<string, unknown>).unknown_field, 'kept', 'unknown keys survive an edit');
		assert.strictEqual(book.source, '/tmp/Salt.json');

		const persona = adoptPersona({ name: 'Ada', connections: ['Kestrel', ''], position: 4, depth: 2, role: 1 });
		assert.deepStrictEqual(persona.connections, ['Kestrel']);
		assert.strictEqual(persona.title, '', 'a missing title stays empty');
		assert.strictEqual(persona.position, 4);

		const preset = adoptPreset({
			name: 'Edited',
			prompts: [{ identifier: 'main', content: 'hi' }, { nope: true }],
			temperature: 0.5,
			top_p: 'high',
			maxTokens: 800,
		});
		assert.strictEqual(preset.id, 'Edited');
		assert.deepStrictEqual(preset.prompts?.map((prompt) => prompt.identifier), ['main'], 'a prompt without an identifier is dropped');
		assert.deepStrictEqual(preset.promptOrder, [{ identifier: 'main', enabled: true }]);
		assert.strictEqual(preset.temperature, 0.5);
		assert.strictEqual(preset.top_p, undefined, 'a sampler with the wrong type is not written');
		assert.strictEqual(preset.maxTokens, 800);
	});

	test('a character, its book and a preset shape the request without displacing the agent', async () => {
		const card = {
			spec: 'chara_card_v2',
			spec_version: '2.0',
			data: {
				name: 'Kestrel',
				description: 'A cartographer of dead cities.',
				personality: 'Terse, watchful.',
				scenario: 'The salt flats, at dusk.',
				first_mes: 'Kestrel looks up.',
				system_prompt: 'Stay in character.',
				post_history_instructions: 'Never break the fourth wall.',
				mes_example: '<START>\nYou: hi\nKestrel: hm.',
				character_book: {
					name: 'Card book',
					entries: [{ id: 0, keys: ['kestrel'], content: 'The atlas is incomplete.', position: 'before_char', insertion_order: 100 }],
				},
			},
		};
		const kernel = await createTestKernel({
			config: { tavernCharacter: 'kestrel', tavernLorebooks: ['Salt'], tavernPreset: 'Test' },
		});
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'characters'), { recursive: true });
			mkdirSync(join(library, 'lorebooks'), { recursive: true });
			mkdirSync(join(library, 'presets'), { recursive: true });
			writeFileSync(join(library, 'characters', 'kestrel.json'), JSON.stringify(card));
			writeFileSync(
				join(library, 'lorebooks', 'Salt.json'),
				JSON.stringify({ name: 'Salt', entries: { '0': { uid: 0, key: ['salt'], content: 'The flats drink sound.', position: 1 } } }),
			);
			writeFileSync(join(library, 'presets', 'Test.json'), JSON.stringify({ temperature: 0.5, top_p: 0.8 }));
			await kernel.ctx.tavern.reload();
			assert.deepStrictEqual(kernel.ctx.tavern.characters.map((character) => character.name), ['Kestrel']);
			assert.strictEqual(kernel.ctx.tavern.character('kestrel')?.greeting, 'Kestrel looks up.');

			let seen: Message[] = [];
			let temperature: number | undefined;
			let topP: number | undefined;
			kernel.ctx.llm.use({
				name: 'test',
				async chat(request) {
					seen = request.messages;
					temperature = request.temperature;
					topP = request.topP;
					return { message: { role: 'assistant', content: 'ok' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'kestrel-chat');
			session.transcript.push({ role: 'assistant', content: 'Kestrel looks up.', at: 1 });
			kernel.ctx.sessions.save(session);
			await kernel.ctx.agent.runTurn({ text: 'What do you know about the salt?', sessionId: 'kestrel-chat' });

			const texts = seen.map((message) => message.content);
			const at = (needle: string): number => texts.findIndex((text) => text.includes(needle));
			assert.ok(texts[0].startsWith('You are Comonad'), 'the agent identity still leads');
			assert.ok(texts[0].includes('lore_lookup'), 'the identity block says the books can be looked up');
			assert.ok(texts[0].includes('- Salt: salt'), 'and names the entries it may ask about');
			assert.ok(at('A cartographer of dead cities.') > 0, 'the card description is in the prompt');
			assert.ok(at('Terse, watchful.') > 0, 'the card personality is in the prompt');
			assert.ok(at('The salt flats, at dusk.') > 0, 'the scenario is in the prompt');
			assert.ok(at('Stay in character.') > 0, "the card's own system prompt is a block");
			assert.ok(at('The flats drink sound.') > 0, 'the world book entry the message triggered is injected');
			assert.ok(at('The atlas is incomplete.') > 0, "the card's own book is scanned too");
			assert.ok(at('Kestrel looks up.') > 0, 'the transcript keeps the greeting');
			assert.ok(at('Never break the fourth wall.') > at('Kestrel looks up.'), 'post-history instructions land after the history');
			assert.strictEqual(temperature, 0.5, 'the preset sets the temperature');
			assert.strictEqual(topP, 0.8, 'the preset sets top_p');
			// The turn mutates the stored session, which is the object the next turn reads again.
			const stored = kernel.ctx.sessions.require('kestrel-chat');
			assert.strictEqual(stored.tavernActivated?.length, 2, 'the readout lists what activated');
			assert.deepStrictEqual(
				stored.tavernActivated?.map((hit) => hit.reason),
				['key', 'key'],
			);
		} finally {
			await kernel.dispose();
		}
	});
});
