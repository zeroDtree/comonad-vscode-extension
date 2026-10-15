import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
import { ChangedOutsideError, Checkpoints, DirtyEditorError, parseDiffs } from '../services/checkpoints';
import { fsTools } from '../tools/fs';
import { agentTools } from '../tools/misc';
import { hostStorage, type Host } from '../services/host';
import { Context, Service, type Plugin } from 'cordis';
import { SessionStore, unusedChat } from '../services/sessions';
import { formatModelId, parseModelId, shapeModels, type AdapterRequest } from '../services/llm';
import { CONFIG_KEYS, DEPRECATED_CONFIG_KEYS, profileKeyEnvs } from '../services/settings';
import { toolset } from '../services/tools';
import { promptText } from '../services/agent';
import { PLUGINS, ROWS } from '../app';
import * as ComonadApp from '../app';
import type { Plugins, PluginDependency, PluginState } from '../services/plugins';
import { pluginNodeStatus, pluginTree, type PluginNode } from '../lib/plugins';
import { slashCommands } from '../ui/slash';
import { harnessAliases, harnessCompat } from '../plugins/harness';
import { pluginHost, readRows, writeRow } from '../services/plugins';
import { blankPng, cardTextFromPng, characterToCard, greetingsOf, loadCard, normaliseCard, parseCard, readPngText, writePngText } from 'comonad-plugin-tavern/lib/card';
import { adoptBook, adoptCharacter, adoptPersona, adoptPreset, blankBook, blankCharacter, blankPersona, blankPreset, entryToJson } from 'comonad-plugin-tavern/lib/authoring';
import { readBookFile } from 'comonad-plugin-tavern/services/tavern';
import { convertCharacterToPersona } from 'comonad-plugin-tavern/lib/personas';
import { parseExamples, substituteMacros } from 'comonad-plugin-tavern/lib/macro';
import { parsePreset, presetSamplers, presetToJson } from 'comonad-plugin-tavern/lib/preset';
import { builtInBlocks, librarySeed, mergeBuiltIn, parsePromptLibrary, promptLibraryJson, sanitisePromptLibrary } from 'comonad-plugin-tavern/lib/library';
import { PRESET_TEMPLATES } from 'comonad-plugin-tavern/lib/templates/presets';
import { PROMPT_BLOCKS } from 'comonad-plugin-tavern/lib/templates/blocks';
import { DEFAULT_ORDER, DEFAULT_PROMPTS, IDENTITY_PROMPT, movePrompt, promptCollection, setEnabled, shippedPrompt, triggersGeneration, withoutIdentityBlock } from 'comonad-plugin-tavern/lib/prompts';
import { activateLore, toWorldBook, worldInfoToBook, type LoreBook, type LoreInput } from 'comonad-plugin-tavern/lib/lore';
import type { TavernPreset } from '../lib/tavern/types';
import { assemble, exampleMessages, injectAtDepth } from 'comonad-plugin-tavern/lib/assemble';
import { applyRegex, makeScript } from 'comonad-plugin-tavern/lib/regex';
import { ruleOf, searchEntries, visibleEntries } from 'comonad-plugin-tavern/lib/search';
import {
	ANTI_TROLL_MAX_TAGS,
	TAG_IMPORT,
	addTags,
	applyTagImport,
	byId,
	deleteTag,
	emptyStore,
	ensureTag,
	mergeStores,
	planTagImport,
	pruneTags,
	readStore,
	renameTag,
	storeJson,
	tagIdsOf,
	tagsOf,
} from 'comonad-plugin-tavern/lib/tags';
import { REGEX_PLACEMENT, PROMPT_LIBRARY_KEY, WI_LOGIC, WI_POSITION, WI_ROLE, WI_SETTINGS_DEFAULTS, WI_STRATEGY, worldEntry, type GenerationTrigger, type WorldEntry } from '../lib/tavern/types';
/** The tavern plugin is a package beside the host: its files are read from there, not from `src/`. */
const PACKAGE = join(__dirname, '..', '..', 'packages', 'comonad-plugin-tavern');
const PACKAGE_SRC = join(PACKAGE, 'src');
const PACKAGE_RESOURCES = join(PACKAGE, 'resources');
import tavernEntry from 'comonad-plugin-tavern';
import { tavernPane } from 'comonad-plugin-tavern/panel/pane';
import { settingsDocument } from '../ui/settings-panel';
import { panesPlugin } from '../services/panes';
import { createTestKernel } from './harness';
import { BYTES_PER_TOKEN, TOKENS_PER_MESSAGE, TOKENS_PADDING, countMessages, countRaw, countTokens, encodingForModel, guesstimate, setEncoder } from '../lib/tokens';
import { planFor } from '../services/tokenizers';

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

suite('Token counting', () => {
	test('a model name picks the same tokenizer SillyTavern picks', () => {
		assert.strictEqual(planFor('deepseek-chat').kind, 'download');
		assert.deepStrictEqual(planFor('deepseek-reasoner'), { kind: 'download', file: 'deepseek.json.gz' });
		assert.deepStrictEqual(planFor('gemini-2.5-flash'), { kind: 'local', file: 'gemma.model' });
		assert.deepStrictEqual(planFor('claude-3-5-sonnet'), { kind: 'local', file: 'claude.json' });
		assert.deepStrictEqual(planFor('llama-3.1-70b'), { kind: 'local', file: 'llama3.json' });
		assert.deepStrictEqual(planFor('qwen2.5-72b'), { kind: 'download', file: 'qwen2.json.gz' });
		assert.deepStrictEqual(planFor('gpt-4o'), { kind: 'tiktoken', encoding: 'o200k_base' });
		// An unknown name is an OpenAI-compatible model, which is where upstream's default ends too.
		assert.deepStrictEqual(planFor('some-local-model'), { kind: 'tiktoken', encoding: 'cl100k_base' });
		assert.strictEqual(planFor('').kind, 'none');
	});

	test('the encoding table follows the model families that matter', () => {
		assert.strictEqual(encodingForModel('gpt-4o-mini'), 'o200k_base');
		assert.strictEqual(encodingForModel('o3-mini'), 'o200k_base');
		assert.strictEqual(encodingForModel('gpt-4.1'), 'o200k_base');
		assert.strictEqual(encodingForModel('gpt-4-turbo'), 'cl100k_base');
		assert.strictEqual(encodingForModel('gpt-3.5-turbo'), 'cl100k_base');
		assert.strictEqual(encodingForModel('text-embedding-ada-002'), 'cl100k_base');
		assert.strictEqual(encodingForModel('text-davinci-003'), 'r50k_base');
	});

	test('a count is the encoding plus the message framing SillyTavern adds', async () => {
		const kernel = await createTestKernel();
		try {
			setEncoder(null);
			setEncoder(() => 7);
			assert.strictEqual(countRaw('anything'), 7);
			// Upstream counts a string as a message of its own: 3 per message, 3 of padding.
			assert.strictEqual(countTokens('anything'), 13);
			assert.strictEqual(countTokens(''), 0, 'an empty field costs nothing');

			// Without an encoder it degrades to upstream's own estimate rather than to zero.
			setEncoder(null);
			assert.strictEqual(guesstimate('abcd'), Math.ceil(4 / BYTES_PER_TOKEN));
			assert.ok(countTokens('四字漢字') > 0, 'multibyte text is measured in bytes');
			assert.strictEqual(countMessages([{ content: 'a' }, { content: 'b' }]), 2 * (TOKENS_PER_MESSAGE + 1) + TOKENS_PADDING);

			// The real thing: the kernel's tokenizer service installs a BPE for the model.
			setEncoder(null);
			const status = await kernel.ctx.tokenizers.warm('gpt-4o');
			assert.strictEqual(status.kind, 'tiktoken');
			assert.strictEqual(status.label, 'o200k_base');
			assert.strictEqual(countRaw('Hello world'), 2, 'o200k counts this in two tokens');
			assert.strictEqual(countTokens('Hello world'), 8, 'and the field shows two plus the framing');
			assert.strictEqual(kernel.ctx.tokenizers.describe().kind, 'tiktoken');
		} finally {
			setEncoder(null);
			await kernel.dispose();
		}
	});
});

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
		const files = parseDiffs(patch);
		assert.strictEqual(files.size, 1);
		const file = files.get('src/a.ts');
		assert.ok(file, 'the diff is keyed by its path');
		assert.strictEqual(file.additions, 1);
		assert.ok(file.hunks.length >= 1);
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

	test('a thinking model\u2019s function-call signature is kept and sent back with the call', async () => {
		const bodies: Record<string, unknown>[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (_url: string, init: { body: string }): Promise<Response> => {
			bodies.push(JSON.parse(init.body) as Record<string, unknown>);
			// Gemini hands the signature over with the function call, in `extra_content` — and often in an
			// earlier chunk than the call's own name and arguments.
			const sse = [
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","extra_content":{"google":{"thought_signature":"SIG-1"}}}]}}]}',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"run_shell_readonly","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}',
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
		const request = (messages: Message[]): Parameters<typeof openAiChat>[0] => ({
			base: 'https://generativelanguage.googleapis.com/v1beta/openai',
			key: 'k',
			model: 'gemini-3.8-flash',
			messages,
			tools: [],
			signal: new AbortController().signal,
		});
		const sentCalls = (index: number): Record<string, unknown>[] =>
			((bodies[index]!.messages as Record<string, unknown>[])[1]!.tool_calls ?? []) as Record<string, unknown>[];
		try {
			const first = await openAiChat(request([{ role: 'user', content: 'ls it' }]));
			assert.strictEqual(first.toolCalls[0]?.name, 'run_shell_readonly');
			assert.deepStrictEqual(
				first.toolCalls[0]?.extraContent,
				{ google: { thought_signature: 'SIG-1' } },
				'the signature stays with the call it came on',
			);

			// The tool result goes back with that assistant turn, and the signature goes with it: without
			// it Gemini 3 fails the whole turn with "Function call is missing a thought_signature".
			await openAiChat(
				request([
					{ role: 'user', content: 'ls it' },
					{ role: 'assistant', content: '', toolCalls: first.toolCalls },
					{ role: 'tool', toolCallId: 'call_1', content: 'a.txt' },
				]),
			);
			assert.deepStrictEqual(sentCalls(1)[0]!.extra_content, { google: { thought_signature: 'SIG-1' } }, 'sent back the way it came');

			// A call that never had one — an older transcript, or one another provider wrote — carries
			// Google's own bypass rather than losing the turn.
			await openAiChat(
				request([
					{ role: 'user', content: 'ls it' },
					{ role: 'assistant', content: '', toolCalls: [{ id: 'c9', name: 'run_shell_readonly', arguments: '{}' }] },
					{ role: 'tool', toolCallId: 'c9', content: 'a.txt' },
				]),
			);
			assert.deepStrictEqual(sentCalls(2)[0]!.extra_content, { google: { thought_signature: 'skip_thought_signature_validator' } });

			// A model that does not demand one is never sent the bypass, and keeps what it was given.
			await openAiChat({
				...request([{ role: 'user', content: 'hi' }]),
				base: 'https://api.deepseek.com',
				model: 'deepseek-flash',
				messages: [
					{ role: 'user', content: 'ls it' },
					{ role: 'assistant', content: '', toolCalls: [{ id: 'c9', name: 'run_shell_readonly', arguments: '{}' }] },
					{ role: 'tool', toolCallId: 'c9', content: 'a.txt' },
				],
			});
			assert.ok(!('extra_content' in sentCalls(3)[0]!), 'no signature demanded, none invented');
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

	test('a `hidden` attribute hides, in both webview documents', () => {
		// A user-agent style is the weakest kind: `[hidden] { display: none }` loses to any class that
		// sets `display`, so an element toggled with the attribute simply stays visible. That is how the
		// world-book entry editor refused to fold — and how a folded entry's fields were still on screen
		// while nothing had wired them.
		for (const file of ['settings.css', 'chat.css']) {
			const css = readFileSync(join(__dirname, '..', '..', 'resources', file), 'utf8');
			assert.match(
				css,
				/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
				`${file} must force \`[hidden]\` to hide, or every module in that document that toggles it breaks`,
			);
		}
	});

	test('the persona page takes the personas kind over, and the item list steps aside', () => {
		const dir = PACKAGE_RESOURCES;
		// The persona page is a guest module of its own, like the world-book page: it saves as it is
		// edited, so it owns the tile list and the connection editor while the kind is showing.
		const pane = readFileSync(join(dir, 'persona.js'), 'utf8');
		assert.match(pane, /window\.comonadPersonas/, 'the page is its own guest module');
		for (const verb of ['personaAvatar', 'personaClearAvatar', 'personaConnect', 'personaDisconnect', 'personaBackup', 'personaRestore', 'personaFromCharacter', 'personaDuplicate', 'personaDelete', 'personaSetting']) {
			assert.ok(pane.includes(verb), `the persona page sends ${verb}`);
		}
		// Upstream offers *None (disabled)* first, and it is the only way to say "send no description".
		assert.match(pane, /\[\s*9,\s*'None \(disabled\)'\s*\]/, 'the position list carries NONE');
		assert.match(pane, /In-chat @ Depth/, 'and upstream’s own words for the other four');

		const css = readFileSync(join(dir, 'persona.css'), 'utf8');
		assert.match(css, /#pf-panel\s*\{[^}]*display:\s*none/, 'the page is hidden until its kind shows');
		assert.match(css, /#st-pane\[data-kind='personas'\]\s*#pf-panel\s*\{[^}]*display:\s*flex/, 'and shown for personas');
		assert.match(css, /#st-pane\[data-kind='personas'\]\s*#st-split/, 'the item list steps aside for it');
		assert.match(css, /#st-pane\[data-view='settings'\]\s*#pf-panel/, 'and the settings view still hides it');

		const host = readFileSync(join(dir, 'content.js'), 'utf8');
		assert.match(host, /window\.comonadPersonas/, 'the content pane loads it');
		assert.match(host, /kind === 'personas' && personaPane/, 'and hands the kind over');
	});

	test('the prompt pane saves before it inserts, and keeps both libraries straight', () => {
		const dir = PACKAGE_RESOURCES;
		const pane = readFileSync(join(dir, 'content.js'), 'utf8');
		// A new entry is *saved* first: the two entry boxes carry *+ New*, and only their *Insert* puts a
		// saved one into the list, at the top, right after Comonad’s own block.
		assert.match(pane, /'Built-in'/, 'the built-in library is a labelled entry box');
		assert.match(pane, /'Custom'/, 'and this preset’s custom library is one too');
		assert.match(pane, /addToPresetLibrary/, 'the custom box’s *+ New* saves rather than inserts');
		assert.match(pane, /insertFromLibrary/, 'inserting copies a library entry into the list');
		assert.match(pane, /promptLibrarySave/, 'a system-library change is written straight through');
		assert.match(pane, /editingLibrary/, 'each library entry has an editor of its own');
		assert.match(pane, /builtInPrompts/, 'the built-in library comes from the top-level host slice, whatever kind is showing');
		const serviceSource = readFileSync(join(PACKAGE_SRC, 'services', 'tavern.ts'), 'utf8');
		assert.match(serviceSource, /prompts\.filter\(\(prompt\) => prompt\.identifier !== IDENTITY_PROMPT\)/, 'a saved preset never carries the identity block');
		assert.match(pane, /block\.draggable = true/, 'a prompt card can be dragged to reorder the list');
		assert.match(pane, /moveTo\(from, index\)/, 'a drop moves the card to its new index');
		assert.match(readFileSync(join(dir, 'content.css'), 'utf8'), /is-drop-target/, 'the drop target is shown while dragging');
		const host = readFileSync(join(PACKAGE_SRC, 'panel', 'controller.ts'), 'utf8');
		assert.match(host, /builtInPrompts:\s*ctx\.tavern\.promptLibrary/, 'the host sends it at the top level, not inside the presets-only slice');
		assert.doesNotMatch(host, /systemPrompts/, 'the old kind-gated field is gone');
		assert.match(pane, /uniqueId\(/, 'an inserted identifier is made unique');
		// The item the pane is editing has to survive a push: the shared library saves while the preset
		// may still be dirty, and the panel answers every content message with a fresh state.
		assert.match(pane, /item = dirty && same \? item : incoming;/, 'a dirty form keeps the item it is editing');

		const css = readFileSync(join(dir, 'content.css'), 'utf8');
		assert.match(css, /\.library-head\s*\{/, 'the library section has a header of its own');
		// One entry box holds both libraries: a picker, *+ New* and *Insert*, with the picked entry edited
		// in the space right below it — there is no separate list to keep in step.
		assert.match(css, /\.library-box\s*\{/, 'the entry box is styled');
		assert.match(css, /\.library-scope\s*\{/, 'and its small button switches which library it shows');
		assert.match(css, /\.library-edit\s*\{/, 'and the picked entry gets a framed editor of its own');
		assert.match(pane, /libraryScope/, 'the box remembers the library it is showing');
	});

	test('the agent’s system prompt is named blocks, joined exactly as the model receives it', async () => {
		const kernel = await createTestKernel();
		try {
			const session = kernel.ctx.sessions.ensureActive(kernel.ctx.agent.policyFor());
			const blocks = await kernel.ctx.agent.promptBlocks(session);
			assert.ok(blocks.length, 'there is always at least the identity block');
			assert.strictEqual(blocks[0].name, 'Identity', 'and it leads');
			assert.strictEqual(new Set(blocks.map((block) => block.name)).size, blocks.length, 'no block is named twice');
			// The identity block is the part a refactor must never disturb: its lines are the agent’s contract.
			const identity = blocks[0].text.split('\n');
			assert.strictEqual(identity[0], 'You are Comonad, an agentic coding assistant running inside VS Code.');
			assert.match(identity[1], /Inspect the workspace with the provided tools/);
			assert.strictEqual(identity[2], 'Never ask the user for permission in your reply; the host asks whenever a tool needs approval.');
			assert.match(identity[3], /^Mode: .+; approval: .+; network: (on|off)\.$/);
			assert.match(identity[4], /^Today: \d{4}-\d{2}-\d{2}\.$/);
			// The joiner is the only thing that turns blocks into wire text, and it is one blank line.
			assert.strictEqual(promptText(blocks), blocks.map((block) => block.text).join('\n\n'));
			assert.ok(!promptText(blocks).includes('\n\n\n'), 'blocks are separated by exactly one blank line');
			assert.ok(!promptText(blocks).startsWith('\n') && !promptText(blocks).endsWith('\n'), 'with no padding');
		} finally {
			await kernel.dispose();
		}
	});

	test('the Inspect tab holds the tool policy flow and every prompt the model can be given', () => {
		const panel = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'settings-panel.ts'), 'utf8');
		// One top-level tab, two sub-tabs: the flow and the prompt list live together under Inspect.
		assert.match(panel, /data-tab="inspect"/, 'the panel has an Inspect tab');
		assert.match(panel, /data-pane="inspect"/, 'and a pane for it');
		assert.match(panel, /data-inspect="flow"[^>]*>Tool Policy Flow \(TPF\)</, 'the flow is its first sub-tab, under its new name');
		assert.match(panel, /data-inspect="prompts"/, 'and Prompts is the second');
		assert.match(panel, /data-inspect-pane="flow"/, 'the flow has a pane of its own');
		assert.match(panel, /data-inspect-pane="prompts" hidden/, 'so does the prompt list, hidden to start');
		assert.ok(!/data-tab="flow"/.test(panel) && !/data-tab="prompts"/.test(panel), 'and neither is a top-level tab any more');

		assert.match(panel, /case 'prompts'/, 'the host answers the prompt list’s request on demand');
		assert.match(panel, /ctx\.agent\.promptBlocks/, 'with the agent’s own named blocks');
		assert.match(panel, /tavern\(\)\?\.promptsFor/, 'the SillyTavern collection the chat would send, when its plugin is loaded');
		assert.match(panel, /parameters: tool\.parameters/, 'and each tool’s definition, schema included');

		const guest = readFileSync(join(__dirname, '..', '..', 'resources', 'settings.js'), 'utf8');
		assert.match(guest, /function showInspect/, 'the guest switches the sub-tabs');
		assert.match(guest, /function renderPrompts/, 'renders the prompt list');
		assert.match(guest, /case 'prompts':/, 'and handles the reply');
		for (const group of ['Comonad', 'Tools', 'SillyTavern']) {
			assert.ok(guest.includes(`group: '${group}'`), `the list is grouped: ${group}`);
		}
		// Mermaid measures its container, so the flow may only be drawn while it is on screen.
		assert.match(guest, /activeTab !== 'inspect' \|\| activeInspect !== 'flow'/, 'the flow only draws while its sub-tab shows');

		const css = readFileSync(join(__dirname, '..', '..', 'resources', 'settings.css'), 'utf8');
		assert.match(css, /#inspect-tabs\s*\{/, 'the sub-tab strip has its own rule');
		assert.match(css, /#pr-wrap\s*\{/, 'the pane has its own layout');
		assert.match(css, /\.pr-row\s*\{/, 'with a row per prompt');
	});

	test('every setting the manifest declares is one the code actually reads', () => {
		const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes: { configuration: { properties: Record<string, unknown> } };
		};
		const declared = new Set(Object.keys(manifest.contributes.configuration.properties).map((key) => key.replace(/^comonad\./, '')));
		const read = new Set<string>(CONFIG_KEYS);
		const deprecated = new Set<string>(DEPRECATED_CONFIG_KEYS);
		// `Host.config()` only reports the keys it is handed, so a setting the manifest declares but the
		// code never reads is a setting the user cannot change: the panel writes it and nothing comes
		// back. Every `comonad.tavern*` and `comonad.wi*` setting was in exactly that state.
		assert.deepStrictEqual(
			[...declared].filter((key) => !read.has(key) && !deprecated.has(key)).sort(),
			[],
			'the manifest declares settings nothing reads',
		);
		assert.deepStrictEqual(
			[...read].filter((key) => !declared.has(key)).sort(),
			[],
			'the code reads settings the manifest does not declare',
		);
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

	test('a continue and an impersonation ask as the user, never ending on the model\u2019s own turn', async () => {
		const kernel = await createTestKernel();
		try {
			const seen: { role: string; content: string }[][] = [];
			kernel.ctx.llm.use({
				name: 'test',
				async chat(request: AdapterRequest) {
					seen.push(request.messages.map((message) => ({ role: message.role, content: message.content })));
					return { message: { role: 'assistant' as const, content: 'grown.' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'ask');
			kernel.ctx.sessions.save(session);
			await kernel.ctx.agent.runTurn({ text: '你好', sessionId: 'ask' });

			// Gemini refuses a request whose last turn is the model's own ("Requests ending with a model
			// turn are not supported"), which is exactly what a continue and an impersonation look like
			// until the ask is said as the user.
			await kernel.ctx.agent.runTurn({ text: '', trigger: 'continue', sessionId: 'ask' });
			const continued = seen[1]!;
			assert.strictEqual(continued[continued.length - 1]!.role, 'user', 'a continue ends on the user');
			assert.match(continued[continued.length - 1]!.content, /Continue the last message/);
			assert.strictEqual(continued[0]!.role, 'system');
			assert.match(continued[0]!.content, /Continue the last message/, 'the system prompt keeps the standing instruction');

			await kernel.ctx.agent.runTurn({ text: '', trigger: 'impersonate', sessionId: 'ask' });
			const asked = seen[2]!;
			assert.strictEqual(asked[asked.length - 1]!.role, 'user', 'an impersonation ends on the user');
			assert.match(asked[asked.length - 1]!.content, /Write the next message of this conversation/);

			// Quiet answers the prompt it was given, so that is the turn the request ends on — and the
			// transcript is still left exactly as it was.
			const before = kernel.ctx.sessions.require('ask').transcript;
			await kernel.ctx.agent.runTurn({ text: 'answer this privately', trigger: 'quiet', sessionId: 'ask' });
			const quiet = seen[3]!;
			assert.deepStrictEqual(quiet[quiet.length - 1], { role: 'user', content: 'answer this privately' });
			assert.deepStrictEqual(kernel.ctx.sessions.require('ask').transcript, before, 'a quiet prompt is never written down');
		} finally {
			await kernel.dispose();
		}
	});

	test('an impersonation is offered no tools, runs none, and is not a turn of the chat', async () => {
		const kernel = await createTestKernel();
		try {
			let executed = 0;
			kernel.ctx.tools.register({
				name: 'read_file',
				description: 'a write-capable probe',
				capability: 'rw',
				needsNetwork: false,
				needsWorkspace: false,
				parameters: { type: 'object', properties: {}, required: [], additionalProperties: true },
				execute: async () => {
					executed += 1;
					return 'body';
				},
			} as never);
			const offered: number[] = [];
			const replies: { content: string; toolCalls?: { id: string; name: string; arguments: string }[] }[] = [
				{ content: 'hi.' },
				// The model asks for the tool anyway: the impersonation is not offered it, so the call is dropped.
				{ content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
			];
			kernel.ctx.llm.use({
				name: 'test',
				async chat(request: AdapterRequest) {
					offered.push(request.tools.length);
					const reply = replies.shift() ?? { content: 'x' };
					return { message: { role: 'assistant' as const, content: reply.content, toolCalls: reply.toolCalls }, toolCalls: reply.toolCalls ?? [], usage: { input: 1, output: 1 } };
				},
			});
			const policy = { approval: 'universal_accept' as const, workMode: 'sw' as const };
			kernel.ctx.sessions.save(kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'impersonate'));
			await kernel.ctx.agent.runTurn({ text: 'hello', sessionId: 'impersonate', policy });
			const turns = kernel.ctx.sessions.require('impersonate').turnIndex;

			const result = await kernel.ctx.agent.runTurn({ text: '', trigger: 'impersonate', sessionId: 'impersonate', policy });
			assert.ok(offered[0]! > 0, 'a normal turn is still offered its tools');
			assert.strictEqual(offered[1], 0, 'an impersonation is offered no tools');
			assert.strictEqual(executed, 0, 'and a tool call it makes anyway is not run');
			assert.strictEqual(result.text, '', 'the turn ends on what it wrote, which is nothing here');
			assert.strictEqual(kernel.ctx.sessions.require('impersonate').turnIndex, turns, 'and it is not counted as a turn of the chat');
		} finally {
			await kernel.dispose();
		}
	});

	test('a quiet turn is offered no tools, runs none, and leaves the chat as it was', async () => {
		const kernel = await createTestKernel();
		try {
			let executed = 0;
			kernel.ctx.tools.register({
				name: 'read_file',
				description: 'a write-capable probe',
				capability: 'rw',
				needsNetwork: false,
				needsWorkspace: false,
				parameters: { type: 'object', properties: {}, required: [], additionalProperties: true },
				execute: async () => {
					executed += 1;
					return 'body';
				},
			} as never);
			const offered: number[] = [];
			const replies: { content: string; toolCalls?: { id: string; name: string; arguments: string }[] }[] = [
				{ content: 'hi.' },
				// The model asks for the tool anyway: a quiet turn is not offered it, so the call is dropped.
				{ content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
			];
			kernel.ctx.llm.use({
				name: 'test',
				async chat(request: AdapterRequest) {
					offered.push(request.tools.length);
					const reply = replies.shift() ?? { content: 'x' };
					return { message: { role: 'assistant' as const, content: reply.content, toolCalls: reply.toolCalls }, toolCalls: reply.toolCalls ?? [], usage: { input: 1, output: 1 } };
				},
			});
			const policy = { approval: 'universal_accept' as const, workMode: 'sw' as const };
			kernel.ctx.sessions.save(kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'quiet'));
			await kernel.ctx.agent.runTurn({ text: 'hello', sessionId: 'quiet', policy });
			const before = kernel.ctx.sessions.require('quiet');
			const transcript = before.transcript;
			const turns = before.turnIndex;

			const result = await kernel.ctx.agent.runTurn({ text: 'answer this privately', trigger: 'quiet', sessionId: 'quiet', policy });
			assert.ok(offered[0]! > 0, 'a normal turn is still offered its tools');
			assert.strictEqual(offered[1], 0, 'a quiet turn is offered no tools');
			assert.strictEqual(executed, 0, 'and a tool call it makes anyway is not run');
			assert.strictEqual(result.text, '', 'the turn ends on what it wrote, which is nothing here');
			assert.deepStrictEqual(kernel.ctx.sessions.require('quiet').transcript, transcript, 'the transcript is left exactly as it was');
			assert.strictEqual(kernel.ctx.sessions.require('quiet').turnIndex, turns, 'and it is not counted as a turn of the chat');
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

			// The fork the panel offers is per turn: from the middle turn of three, the copy stops where
			// that turn ended and the turns after it stay behind.
			const three = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'three');
			three.transcript.push(
				{ role: 'user', content: 'q1' },
				{ role: 'assistant', content: 'a1' },
				{ role: 'user', content: 'q2' },
				{ role: 'assistant', content: 'a2' },
				{ role: 'user', content: 'q3' },
				{ role: 'assistant', content: 'a3' },
			);
			kernel.ctx.sessions.save(three);
			const middle = turnsOf(kernel.ctx.sessions.get('three')!.transcript)[1]!;
			assert.strictEqual(middle.at, 4, 'the boundary sits at the end of the turn that was clicked');
			const half = kernel.ctx.sessions.forkAt('three', middle.at);
			assert.deepStrictEqual(half.transcript.map((message) => message.content), ['q1', 'a1', 'q2', 'a2']);
			assert.strictEqual(kernel.ctx.sessions.get('three')?.transcript.length, 6, 'and the chat it came from is whole');
		} finally {
			await kernel.dispose();
		}
	});

	test('the plugin host mounts rows, and a cordis.yml is what decides them', async () => {
		const kernel = await createTestKernel();
		try {
			// A probe plugin: registering a tool is an effect, so it is visible while the row is loaded
			// and gone the moment it is not — which is the whole promise of a plugin row.
			const probe = (tool: string, log: string[]): Plugin => ({
				name: tool,
				// Injection is declared, never inferred: cordis refuses a property that was not asked for.
				inject: ['tools'],
				apply: (ctx: Context) => {
					log.push(`load ${tool}`);
					ctx.effect(() => () => void log.push(`unload ${tool}`));
					ctx.tools.register({
						name: tool,
						description: 'probe',
						capability: 'ro',
						needsNetwork: false,
						needsWorkspace: false,
						parameters: objectSchema({}),
						execute: async () => 'ok',
					});
				},
			});
			const log: string[] = [];
			await kernel.ctx.plugin(pluginHost, {
				rows: [{ id: 'alpha' }, { id: 'beta' }],
				plugins: { alpha: probe('probe_alpha', log), beta: probe('probe_beta', log) },
			});
			const plugins = kernel.ctx.plugins;
			assert.deepStrictEqual(log, ['load probe_alpha', 'load probe_beta']);
			assert.ok(kernel.ctx.tools.get('probe_alpha'), 'a row provides what its plugin provides');
			assert.deepStrictEqual(
				plugins.state().map((state) => [state.id, state.source, state.loaded]),
				[['alpha', 'builtin', true], ['beta', 'builtin', true]],
			);

			// A user's list turns a row off, gives another a config, and adds one of its own — the file
			// beside the yml, exactly as a Cordis row names it.
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(library, { recursive: true });
			writeFileSync(
				join(library, 'probe.js'),
				`module.exports = { name: 'gamma', inject: ['tools'], apply: (ctx) => { ctx.tools.register({ name: 'probe_gamma', description: 'probe', capability: 'ro', needsNetwork: false, needsWorkspace: false, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute: async () => 'ok' }); } };`,
			);
			writeRow(join(library, 'cordis.yml'), { id: 'gamma', name: './probe.js' });
			writeRow(join(library, 'cordis.yml'), { id: 'beta', disabled: true });
			assert.deepStrictEqual(
				readRows(join(library, 'cordis.yml')).map((row) => [row.id, row.name, row.disabled]),
				[['gamma', './probe.js', false], ['beta', undefined, true]],
			);

			await plugins.reload();
			assert.deepStrictEqual(
				log.slice(2),
				['unload probe_beta', 'unload probe_alpha', 'load probe_alpha'],
				'only the rows that are on are loaded',
			);
			assert.ok(kernel.ctx.tools.get('probe_alpha'), 'the row that is on is back');
			assert.ok(!kernel.ctx.tools.get('probe_beta'), 'a disabled row is not loaded');
			assert.ok(kernel.ctx.tools.get('probe_gamma'), 'a plugin from the workspace is loaded beside the built-ins');
			const gamma = plugins.state().find((state) => state.id === 'gamma');
			assert.deepStrictEqual([gamma?.source, gamma?.loaded], ['project', true]);

			// Turning a row back on is written into the project's own yml, and applied at once.
			await plugins.set('beta', { disabled: false });
			assert.ok(kernel.ctx.tools.get('probe_beta'));
			assert.strictEqual(readRows(join(library, 'cordis.yml')).find((row) => row.id === 'beta')?.disabled, false);
		} finally {
			await kernel.dispose();
		}
	});

	test('a plugin is only loaded from the workspace once the workspace is trusted', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(library, { recursive: true });
			writeFileSync(join(library, 'probe.js'), `module.exports = { name: 'probe', apply: () => {} };`);
			writeRow(join(library, 'cordis.yml'), { id: 'gamma', name: './probe.js' });

			kernel.host.trusted = () => false;
			await kernel.ctx.plugin(pluginHost, { rows: [], plugins: {} });
			const plugins = kernel.ctx.plugins;
			assert.deepStrictEqual(plugins.state(), [], 'an untrusted workspace contributes no rows');

			kernel.host.trusted = () => true;
			await plugins.mount();
			assert.strictEqual(plugins.state()[0]?.id, 'gamma', 'and a trusted one does');
		} finally {
			await kernel.dispose();
		}
	});

	test('the dependency graph reads what each row provides, needs and is needed by', async () => {
		const kernel = await createTestKernel();
		try {
			// A service is provided either by the row itself or by a plugin the row mounts; both are rows
			// as far as the graph is concerned.
			class Shelf extends Service {
				constructor(ctx: Context) {
					super(ctx, 'shelf');
				}
			}
			class Ledger extends Service {
				constructor(ctx: Context) {
					super(ctx, 'ledger');
				}
			}
			await kernel.ctx.plugin(pluginHost, {
				rows: [{ id: 'service' }, { id: 'nested', group: 'kernel' }, { id: 'consumer' }, { id: 'pending' }, { id: 'lonely' }],
				plugins: {
					service: Shelf,
					nested: { name: 'nested', inject: ['tools'], apply: (ctx: Context) => void ctx.plugin(Ledger) },
					consumer: { name: 'consumer', inject: ['ledger'], apply: () => void 0 },
					pending: { name: 'pending', inject: ['not-provided'], apply: () => void 0 },
					lonely: () => void 0,
				},
			});
			const graph = new Map(kernel.ctx.plugins.dependencies().map((row) => [row.id, row]));
			assert.deepStrictEqual(graph.get('service')?.provides, ['shelf'], 'a service row says what it provides');
			assert.deepStrictEqual(graph.get('nested')?.provides, ['ledger'], 'so does a row whose own plugin provides one');
			assert.deepStrictEqual(graph.get('nested')?.usedBy, ['consumer'], 'and who needs it');
			assert.deepStrictEqual(
				graph.get('consumer')?.requires,
				[{ name: 'ledger', provider: 'nested' }],
				'the arrow carries the service name and the row that provides it',
			);
			assert.deepStrictEqual(graph.get('pending')?.requires, [{ name: 'not-provided' }], 'a service nobody provides has no source');
			// What the kernel provides is not a hole in the tree: the platform is not a row.
			assert.deepStrictEqual(
				graph.get('nested')?.requires,
				[{ name: 'tools', external: true }],
				'a service the platform provides is marked as external rather than as missing',
			);
			assert.deepStrictEqual(graph.get('nested')?.usedBy, ['consumer'], 'and a row names the rows that stop with it');
			assert.deepStrictEqual(graph.get('pending')?.injects, ['not-provided']);
			assert.deepStrictEqual(graph.get('lonely')?.requires, [], 'a row that needs nothing depends on nothing');
			assert.strictEqual(graph.get('nested')?.group, 'kernel', 'and a row keeps the layer it declared');

			// A row that is turned off still says what it provides: that is what its dependents wait for.
			await kernel.ctx.plugins.set('nested', { disabled: true });
			const off = new Map(kernel.ctx.plugins.dependencies().map((row) => [row.id, row]));
			assert.deepStrictEqual(off.get('nested')?.provides, ['ledger'], 'the service it provided is remembered');
			assert.deepStrictEqual(off.get('consumer')?.requires, [{ name: 'ledger', provider: 'nested' }], 'so the arrow still has a source');
			assert.deepStrictEqual(off.get('nested')?.usedBy, ['consumer'], 'and what it would stop');
		} finally {
			await kernel.dispose();
		}
	});

	test('the dependency tree says what a row stands on, and the whole chain that stops with it', () => {
		const nodes: PluginNode[] = [
			{ id: 'tavern', status: 'off', provides: ['tavern'], requires: [], usedBy: ['ui-tavern-commands'] },
			{
				id: 'ui-tavern-commands',
				status: 'waiting',
				provides: [],
				requires: [{ name: 'tavern', provider: 'tavern' }, { name: 'sessions', provider: 'sessions' }, { name: 'bookkeeping', provider: 'ledger' }],
				usedBy: [],
			},
			{ id: 'sessions', status: 'loaded', provides: ['sessions'], requires: [], usedBy: ['ui-tavern-commands'] },
			{ id: 'ledger', status: 'loaded', provides: ['ledger'], requires: [], usedBy: ['ui-tavern-commands'] },
			{ id: 'mine', status: 'failed', provides: [], requires: [{ name: 'nobody-makes-this' }], usedBy: [] },
		];

		const tree = pluginTree(nodes, 'tavern');
		assert.match(tree, /^tavern — off — provides tavern/, 'the tree starts with the row itself');
		assert.match(tree, /used by\n  └─ ui-tavern-commands/, 'then what stands on it');
		assert.match(pluginTree(nodes, 'mine'), /waits for \?nobody-makes-this — nobody provides it/, 'and a service nothing provides is named as such');
		assert.ok(!pluginTree(nodes, 'mine').includes('requires'), 'a row that needs nothing has nothing to require');
		assert.strictEqual(pluginTree(nodes, 'nope'), '', 'a row that is not there has no tree');

		// The chain, not one hop: a row two rows away still stops with this one.
		const chain = pluginTree(
			[
				{ id: 'a', status: 'loaded', provides: ['a'], requires: [], usedBy: ['b'] },
				{ id: 'b', status: 'loaded', provides: [], requires: [{ name: 'a', provider: 'a' }], usedBy: ['c'] },
				{ id: 'c', status: 'waiting', provides: [], requires: [{ name: 'b', provider: 'b' }], usedBy: [] },
			],
			'a',
		);
		assert.match(chain, /turning this row off also stops\n  └─ b, c/, 'the whole chain, not one hop');

		// What the table colours: off, waiting on a service, failed on its own.
		assert.strictEqual(pluginNodeStatus({ enabled: false, loaded: false }), 'off');
		assert.strictEqual(pluginNodeStatus({ enabled: true, loaded: true }), 'loaded');
		assert.strictEqual(pluginNodeStatus({ enabled: true, loaded: false, error: 'pending: waiting for tools' }), 'waiting');
		assert.strictEqual(pluginNodeStatus({ enabled: true, loaded: false, error: 'boom' }), 'failed');
	});

	test('a toggle applies that row on its own, and a row that others inject takes them with it', async () => {
		const kernel = await createTestKernel();
		try {
			const log: string[] = [];
			// A service of a plugin's own, the way the tavern layer is one: rows that want it declare it.
			class Ledger extends Service {
				constructor(ctx: Context) {
					super(ctx, 'ledger');
				}
			}
			const plugins = () =>
				(
					[
						['provider', true],
						['dependent', true],
						['independent', true],
					] as const
				).map(([id, expected]) => [id, kernel.ctx.plugins.state().find((row) => row.id === id)?.loaded === expected]);
			await kernel.ctx.plugin(pluginHost, {
				rows: [{ id: 'provider' }, { id: 'dependent' }, { id: 'independent' }],
				plugins: {
					provider: {
						name: 'provider',
						apply: (ctx: Context) => {
							ctx.plugin(Ledger);
							ctx.effect(() => () => void log.push('unload provider'));
						},
					},
					dependent: { name: 'dependent', inject: ['ledger'], apply: () => void log.push('load dependent') },
					independent: {
						name: 'independent',
						apply: (ctx: Context) => ctx.effect(() => () => void log.push('unload independent')),
					},
				},
			});
			assert.deepStrictEqual(
				kernel.ctx.plugins.state().map((row) => [row.id, row.loaded]),
				[['provider', true], ['dependent', true], ['independent', true]],
			);

			// Turning a row off is that row's business: the surface asking for it — the settings panel, in
			// the real tree — is a row of the same tree and must survive the click.
			await kernel.ctx.plugins.set('provider', { disabled: true });
			const after = kernel.ctx.plugins.state();
			assert.deepStrictEqual(
				after.map((row) => [row.id, row.enabled, row.loaded]),
				[['provider', false, false], ['dependent', true, false], ['independent', true, true]],
				'a row that was turned off takes the rows that inject it with it',
			);
			assert.match(after[1]?.error ?? '', /waiting for ledger/, 'and the row says what it is waiting for');
			assert.deepStrictEqual(log, ['load dependent', 'unload provider'], 'the row that was turned off went, and nothing else did');

			// And it comes back the same way, with the rows that want it.
			await kernel.ctx.plugins.set('provider', { disabled: false });
			assert.deepStrictEqual(
				kernel.ctx.plugins.state().map((row) => [row.id, row.loaded]),
				[['provider', true], ['dependent', true], ['independent', true]],
				'a row that came back brought its dependents back',
			);
			assert.deepStrictEqual(log, ['load dependent', 'unload provider', 'load dependent'], 'so the row was applied again');

			// The host's own write reaches the watcher too, and is not mistaken for someone editing the file.
			await kernel.ctx.plugins.fileChanged(kernel.ctx.plugins.patchFile);
			assert.deepStrictEqual(log, ['load dependent', 'unload provider', 'load dependent'], 'and the list was not applied a second time for it');

			// A file someone else wrote is applied line by line: the row that changed moves, and the rows
			// that did not are left running — an open panel is not collateral of someone's editor.
			writeRow(kernel.ctx.plugins.patchFile, { id: 'independent', disabled: true });
			await kernel.ctx.plugins.fileChanged(kernel.ctx.plugins.patchFile);
			const edited = kernel.ctx.plugins.state();
			assert.strictEqual(edited.find((row) => row.id === 'independent')?.enabled, false, 'the edited row was applied');
			assert.deepStrictEqual(
				edited.map((row) => [row.id, row.loaded]),
				[['provider', true], ['dependent', true], ['independent', false]],
				'and the rows the edit did not mention are exactly where they were',
			);
			assert.deepStrictEqual(
				log,
				['load dependent', 'unload provider', 'load dependent', 'unload independent'],
				'only the edited row was applied, and the rows the edit did not mention were left running',
			);

			// The button is the blunt one: a plugin's own file may have changed, which no diff can see.
			await kernel.ctx.plugins.reload();
			assert.ok(log.includes('unload provider'), 'a reload takes the whole list down and applies it again');
		} finally {
			await kernel.dispose();
		}
	});

	test('a toggle is written where it can be read: the project when trusted, your own list when not', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(library, { recursive: true });
			kernel.host.trusted = () => false;
			await kernel.ctx.plugin(pluginHost, { rows: [{ id: 'probe' }], plugins: { probe: () => void 0 } });
			const plugins = kernel.ctx.plugins;

			// An untrusted workspace's own list is not read *and* not written: the toggle lands in the
			// user's library, which is the list that is read there.
			assert.strictEqual(plugins.projectFile, join(library, 'cordis.yml'));
			assert.strictEqual(plugins.patchFile, plugins.userFile);
			await plugins.set('probe', { disabled: true });
			assert.deepStrictEqual(readRows(plugins.userFile).map((row) => [row.id, row.disabled]), [['probe', true]]);
			assert.ok(!existsSync(plugins.projectFile), 'nothing was written into the workspace');
			assert.strictEqual(plugins.state().find((row) => row.id === 'probe')?.loaded, false, 'and the list was applied again');

			// Once the workspace is trusted, a row the project declares is toggled in the project.
			kernel.host.trusted = () => true;
			assert.strictEqual(plugins.patchFile, plugins.projectFile);
			writeRow(plugins.projectFile, { id: 'probe' });
			await plugins.set('probe', { disabled: false });
			assert.deepStrictEqual(readRows(plugins.projectFile).map((row) => [row.id, row.disabled]), [['probe', false]]);
			assert.strictEqual(plugins.state().find((row) => row.id === 'probe')?.loaded, true);

		} finally {
			await kernel.dispose();
		}
	});

	test('a toggle of an installed row is written back to your list, not copied into the project', async () => {
		const kernel = await createTestKernel();
		try {
			kernel.host.trusted = () => true;
			const userList = join(kernel.root, 'home', '.comonad');
			const projectList = join(kernel.root, 'ws', '.comonad');
			mkdirSync(userList, { recursive: true });
			writeFileSync(join(userList, 'delta.js'), `module.exports = { apply: () => void 0 };`);
			writeRow(join(userList, 'cordis.yml'), { id: 'delta', name: './delta.js' });
			await kernel.ctx.plugin(pluginHost, { rows: [], plugins: {} });
			const plugins = kernel.ctx.plugins;
			await plugins.set('delta', { disabled: true });
			assert.deepStrictEqual(readRows(join(userList, 'cordis.yml')).map((row) => [row.id, row.disabled]), [['delta', true]]);
			assert.ok(!existsSync(join(projectList, 'cordis.yml')), 'nothing was written into the project');
		} finally {
			await kernel.dispose();
		}
	});

	test('a row named by a file of your own is read from your folder, even when a project toggles it', async () => {
		const kernel = await createTestKernel();
		try {
			kernel.host.trusted = () => true;
			const userList = join(kernel.root, 'home', '.comonad');
			const projectList = join(kernel.root, 'ws', '.comonad');
			mkdirSync(userList, { recursive: true });
			writeFileSync(join(userList, 'delta.js'), `module.exports = { apply: () => void 0 };`);
			writeRow(join(userList, 'cordis.yml'), { id: 'delta', name: './delta.js' });
			await kernel.ctx.plugin(pluginHost, { rows: [], plugins: {} });
			const plugins = kernel.ctx.plugins;
			assert.strictEqual(plugins.state().find((row) => row.id === 'delta')?.loaded, true);

			// The project only says on or off: the name stays with the list that declared it, so the path is
			// read from the user's folder rather than the project's.
			await plugins.set('delta', { disabled: true });
			await plugins.set('delta', { disabled: false });
			assert.ok(!existsSync(join(projectList, 'cordis.yml')), 'the project is not written for a row it does not declare');
			assert.deepStrictEqual(
				readRows(join(userList, 'cordis.yml')).map((row) => [row.id, row.name, row.disabled]),
				[['delta', './delta.js', false]],
			);
			assert.strictEqual(plugins.state().find((row) => row.id === 'delta')?.loaded, true, 'and the row still loads');
		} finally {
			await kernel.dispose();
		}
	});

	test('a row may name its plugin by an absolute path or by ~/, and both are read as files', async () => {
		const kernel = await createTestKernel();
		const home = process.env.HOME;
		try {
			kernel.host.trusted = () => true;
			const userList = join(kernel.root, 'home', '.comonad');
			const elsewhere = join(kernel.root, 'elsewhere');
			mkdirSync(userList, { recursive: true });
			mkdirSync(elsewhere, { recursive: true });
			writeFileSync(join(elsewhere, 'abs.js'), `module.exports = { apply: () => void 0 };`);
			writeFileSync(join(kernel.root, 'home', 'tilde.js'), `module.exports = { apply: () => void 0 };`);
			// `~` is the user's home folder, which the test points at its own root for the duration.
			process.env.HOME = join(kernel.root, 'home');
			writeRow(join(userList, 'cordis.yml'), { id: 'abs', name: join(elsewhere, 'abs.js') });
			writeRow(join(userList, 'cordis.yml'), { id: 'tilde', name: '~/tilde.js' });
			await kernel.ctx.plugin(pluginHost, { rows: [], plugins: {} });
			const plugins = kernel.ctx.plugins;
			assert.deepStrictEqual(
				plugins.state().filter((row) => ['abs', 'tilde'].includes(row.id)).map((row) => [row.id, row.loaded, row.error]),
				[['abs', true, undefined], ['tilde', true, undefined]],
			);
			// The list shows where a file is by the same rule: `~/` inside the home folder, absolute outside it.
			assert.deepStrictEqual(
				plugins.state().filter((row) => ['abs', 'tilde'].includes(row.id)).map((row) => row.target),
				[join(elsewhere, 'abs.js'), '~/tilde.js'],
			);
		} finally {
			if (home === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = home;
			}
			await kernel.dispose();
		}
	});

	test('a relative name in a project list is read from the project folder, and a missing file is reported', async () => {
		const kernel = await createTestKernel();
		try {
			kernel.host.trusted = () => true;
			const userList = join(kernel.root, 'home', '.comonad');
			const projectList = join(kernel.root, 'ws', '.comonad');
			mkdirSync(userList, { recursive: true });
			mkdirSync(projectList, { recursive: true });
			writeFileSync(join(userList, 'delta.js'), `module.exports = { apply: () => void 0 };`);
			writeRow(join(userList, 'cordis.yml'), { id: 'delta', name: './delta.js' });
			// The same relative path, written in the project: there is no `delta.js` beside it.
			writeRow(join(projectList, 'cordis.yml'), { id: 'delta', name: './delta.js' });
			await kernel.ctx.plugin(pluginHost, { rows: [], plugins: {} });
			const delta = kernel.ctx.plugins.state().find((row) => row.id === 'delta');
			assert.strictEqual(delta?.loaded, false);
			assert.ok(delta?.error?.includes(join(projectList, 'delta.js')), 'the error names the file the project asked for');
		} finally {
			await kernel.dispose();
		}
	});

	test('a row mounted while the tree is still being applied is up by the time the list says so', async () => {
		const kernel = await createTestKernel();
		try {
			// The shape of Comonad's own activation: the application's `apply` mounts the plugin host, and
			// the host mounts the rows — so a row is created while its own parent fiber is still loading.
			class Library extends Service {
				constructor(ctx: Context) {
					super(ctx, 'library');
				}
			}
			let rows: PluginState[] = [];
			await kernel.ctx.plugin(async function app(ctx: Context) {
				await ctx.plugin(pluginHost, {
					rows: [{ id: 'content' }],
					plugins: {
						content: async (row: Context) => {
							await row.plugin(Library);
						},
					},
				});
				rows = (ctx.get('plugins') as Plugins).state();
			});
			assert.deepStrictEqual(
				rows.map((row) => [row.id, row.loaded, row.error]),
				[['content', true, undefined]],
				'a row that has loaded is not reported as loading',
			);
			assert.ok(kernel.ctx.get('library'), 'and what it provided is there');
		} finally {
			await kernel.dispose();
		}
	});

	test('the settings panel is where the plugin list is read and changed', () => {
		const panel = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'settings-panel.ts'), 'utf8');
		const script = readFileSync(join(__dirname, '..', '..', 'resources', 'settings.js'), 'utf8');
		assert.match(panel, /data-tab="plugins"/, 'the panel has a Plugins tab');
		assert.match(panel, /data-pane="plugins"/, 'and a pane for it');
		// The host is what mounts this row, so the list has to be read when the tab is drawn.
		assert.match(panel, /ctx\.get\('plugins'\)/, 'the row that draws it does not inject the host’s own service');
		assert.match(panel, /case 'plugins'/, 'the host answers the pane');
		assert.match(panel, /pluginHost\(\)\?\.set\(/, 'a toggle goes through the host, so it is written down');
		assert.match(script, /function renderPlugins\(/, 'the pane renders the list');
		assert.match(script, /action: 'toggle'/, 'with a button per row');
		assert.match(script, /plugin-error/, 'and a row that did not load says so');
	});

	test('the Inspect tab holds the dependency table, and no diagram of it', () => {
		const panel = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'settings-panel.ts'), 'utf8');
		const script = readFileSync(join(__dirname, '..', '..', 'resources', 'settings.js'), 'utf8');
		assert.match(panel, /data-inspect="plugins"/, 'Inspect has a Plugins sub-tab');
		assert.match(panel, /data-inspect-pane="plugins" hidden/, 'and a pane for it');
		assert.match(panel, /case 'pluginTree'/, 'the host answers the per-row drill-down');
		assert.match(panel, /dependencies: pluginDependencies\(\)/, 'and pushes what the table is built from');
		assert.match(script, /function renderPluginDeps\(/, 'the pane is a table');
		assert.match(script, /action: \'pluginTree\'|type: 'pluginTree'/, 'whose rows can be picked');
		// The diagram was asked for and then not wanted: nothing here may draw the tree as Mermaid.
		assert.ok(!/pg-graph|pluginGraph|schedulePluginGraph/.test(panel), 'the host sends no diagram');
		assert.ok(!/pg-graph|pluginGraph|schedulePluginGraph|pg-focus/.test(script), 'and the pane draws none');
	});

	test('a plugin that cannot be loaded is reported rather than fatal', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(library, { recursive: true });
			writeRow(join(library, 'cordis.yml'), { id: 'missing', name: './not-there.js' });
			await kernel.ctx.plugin(pluginHost, { rows: [{ id: 'good' }], plugins: { good: () => void 0 } });
			const plugins = kernel.ctx.plugins;
			const state = new Map(plugins.state().map((row) => [row.id, row]));
			assert.match(state.get('missing')?.error ?? '', /no plugin at/);
			assert.strictEqual(state.get('missing')?.loaded, false);
			assert.strictEqual(state.get('good')?.loaded, true, 'the rest of the tree is mounted anyway');
		} finally {
			await kernel.dispose();
		}
	});

	test('a plugin is installed by copying its folder and writing a row, and it requires the host’s modules', async () => {
		const kernel = await createTestKernel();
		try {
			await kernel.ctx.plugin(pluginHost, { rows: [], plugins: {} });
			// What a plugin author hands over: a folder with a manifest and its build, requiring the
			// modules a plugin is loaded *with* rather than carrying a copy of them.
			const source = join(kernel.root, 'download', 'mine');
			mkdirSync(join(source, 'dist'), { recursive: true });
			writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'mine', main: './dist/index.js', comonad: { plugin: true } }));
			writeFileSync(
				join(source, 'dist', 'index.js'),
				[
					"const { Service } = require('cordis');",
					'class Ledger extends Service {',
					"	constructor(ctx) { super(ctx, 'ledger'); this.rows = []; }",
					'}',
					'module.exports = function plugin(ctx) { ctx.plugin(Ledger); };',
					'module.exports.inject = [];',
				].join('\n'),
			);

			const state = await kernel.ctx.plugins.install(source);
			const row = state.find((entry) => entry.id === 'mine');
			assert.ok(row, 'the row is part of the list now');
			assert.strictEqual(row?.loaded, true, 'and it is loaded: `install` applies the list again');
			assert.ok(kernel.ctx.get('ledger'), 'its service came up, from the host’s own cordis');
			// The two things an install does, both visible on disk: the files, and the row.
			assert.ok(existsSync(join(kernel.ctx.plugins.library, 'mine', 'dist', 'index.js')), 'the folder is copied into the library');
			assert.ok(existsSync(join(kernel.ctx.plugins.library, 'node_modules', 'cordis', 'package.json')), 'and the modules it requires are lent beside it');
			const written = readRows(join(kernel.host.home(), '.comonad', 'cordis.yml'));
			assert.deepStrictEqual(written.map((entry) => [entry.id, entry.name]), [['mine', './plugins/mine/dist/index.js']], 'the row names the copy in your library');

			// Uninstalling is deleting the row, exactly as the tab writes it.
			await kernel.ctx.plugins.set('mine', { disabled: true });
			assert.strictEqual(kernel.ctx.get('ledger'), undefined, 'a disabled row provides nothing');
		} finally {
			await kernel.dispose();
		}
	});

	test('a harness plugin runs as written: its imports resolve, its hooks fire, its tools register', async () => {
		const kernel = await createTestKernel({ config: { checkpoints: true } });
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(library, { recursive: true });
			// An ES module plugin, imports and all, as the harness cookbook writes one.
			writeFileSync(
				join(library, 'policy.mjs'),
				[
					"import { Service } from '@deepseek-ai/cordis';",
					"import { defineTool } from '@deepseek-ai/dsh-tools';",
					'',
					"export const name = 'policy';",
					"export const inject = ['tools'];",
					'',
					'class Ledger extends Service {',
					"\tconstructor(ctx) { super(ctx, 'ledger'); this.calls = []; }",
					'}',
					'',
					'export function apply(ctx) {',
					'\tctx.plugin(Ledger);',
					"\tctx.on('tools/pre-execute', (exec, next) =>",
					"\t\texec.name === 'write_file' && String(exec.arguments?.path ?? '').endsWith('sealed.txt')",
					"\t\t\t? { kind: 'deny', reason: 'sealed.txt is sealed by the policy plugin' }",
					'\t\t\t: next(),',
					'\t);',
					'\tctx.tools.register(defineTool({',
					"\t\tname: 'harness_echo',",
					"\t\tdescription: 'Echo a value back.',",
					'\t\tparameters: { type: "object", properties: { value: { type: "string" } } },',
					'\t\toutput: { schema: { type: "string" } },',
					'\t\texecute: async (args) => ({ echoed: args.value }),',
					'\t}));',
					'}',
					'',
				].join('\n'),
			);
			// A CommonJS plugin, which resolves by `require`, through the other half of the redirection.
			writeFileSync(
				join(library, 'ledger.cjs'),
				[
					"const { Service } = require('@deepseek-ai/cordis');",
					'',
					'module.exports = {',
					"\tname: 'ledger',",
					"\tinject: ['tools'],",
					'\tapply(ctx) {',
					'\t\tconst seen = [];',
					'\t\tclass Book extends Service { constructor(ctx) { super(ctx, "book"); this.seen = seen; } }',
					'\t\tctx.plugin(Book);',
					"\t\t// The listener keeps the array it owns: reading the service back needs an inject of its own.",
					"\t\tctx.on('tools/result', (exec, result) => seen.push(`${exec.name}:${result.isError}`));",
					'\t},',
					'};',
					'',
				].join('\n'),
			);
			writeRow(join(library, 'cordis.yml'), { id: 'policy', name: './policy.mjs' });
			writeRow(join(library, 'cordis.yml'), { id: 'ledger', name: './ledger.cjs' });

			writeFileSync(join(kernel.host.workspace(), 'sealed.txt'), 'original\n');
			await kernel.ctx.plugin(pluginHost, {
				rows: [{ id: 'harness', config: { shimDirectory: join(kernel.root, 'shims') } }],
				plugins: { harness: harnessCompat },
			});
			const plugins = kernel.ctx.plugins;
			assert.deepStrictEqual(
				plugins.state().map((state) => [state.id, state.loaded]),
				[['harness', true], ['policy', true], ['ledger', true]],
				`both plugins loaded, and the shims were in place before their first import ran — ${JSON.stringify(plugins.state().filter((state) => !state.loaded))}`,
			);
			assert.deepStrictEqual(
				harnessAliases().map((alias) => alias.name),
				['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm'],
			);
			// The services the plugins built are real services, which they are only if `Service` was ours.
			assert.strictEqual((kernel.ctx.get('ledger') as { constructor: { name: string } } | undefined)?.constructor.name, 'Ledger');
			assert.strictEqual((kernel.ctx.get('book') as { constructor: { name: string } } | undefined)?.constructor.name, 'Book');

			let told = '';
			kernel.ctx.llm.use({
				name: 'caller',
				async chat(request) {
					const last = request.messages[request.messages.length - 1];
					if (last?.role === 'tool') {
						told = last.content;
						return { message: { role: 'assistant', content: 'done' }, toolCalls: [], usage: { input: 1, output: 1 } };
					}
					const asked = request.messages.filter((message) => message.role === 'user').length;
					const call: ToolCall =
						asked === 1
							? { id: 'w', name: 'write_file', arguments: JSON.stringify({ path: 'sealed.txt', content: 'hacked\n' }) }
							: { id: 'e', name: 'harness_echo', arguments: JSON.stringify({ value: 'hi' }) };
					return { message: { role: 'assistant', content: '', toolCalls: [call] }, toolCalls: [call], usage: { input: 1, output: 1 } };
				},
			});
			await kernel.ctx.plugin(fsTools);
			const turn = await kernel.ctx.agent.runTurn({ text: 'write it', surface: 'test' });
			assert.strictEqual(readFileSync(join(kernel.host.workspace(), 'sealed.txt'), 'utf8'), 'original\n', 'the policy plugin refused the write');
			assert.ok(
				/sealed by the policy plugin/.test(told),
				`the model reads the plugin's reason: told=${JSON.stringify(told)} turn=${JSON.stringify(turn)} transcript=${JSON.stringify(
					kernel.ctx.sessions.require(turn.sessionId).transcript.map((message) => `${message.role}:${message.content.slice(0, 80)}`),
				)}`,
			);

			await kernel.ctx.agent.runTurn({ text: 'echo it', surface: 'test' });
			assert.ok(/echoed/.test(told), `a tool from a harness definition answers as JSON text: ${told}`);
			assert.deepStrictEqual(
				(kernel.ctx.get('book') as { seen: string[] }).seen,
				['write_file:true', 'harness_echo:false'],
				'a plugin that only imports and observes saw every settled call',
			);
		} finally {
			await kernel.dispose();
		}
	});

	test('the tavern feature is a plugin: without it a turn is plain and the commands are gone', async () => {
		const kernel = await createTestKernel({ skip: ['tavern', 'lore'] });
		try {
			assert.strictEqual(kernel.ctx.get('tavern'), undefined, 'the row is off, so nothing provides the library');
			// The agent composes a request without the layer: a system prompt and the history, nothing else.
			let asked: Message[] = [];
			kernel.ctx.llm.use({
				name: 'plain',
				async chat(request) {
					asked = request.messages;
					return { message: { role: 'assistant', content: 'hello', toolCalls: [] }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const turn = await kernel.ctx.agent.runTurn({ text: 'hello', surface: 'test' });
			assert.deepStrictEqual(asked.map((message) => message.role), ['system', 'user'], 'a plain request, in one system prompt and the user’s turn');
			assert.match(kernel.ctx.sessions.require(turn.sessionId).transcript[1]?.content ?? '', /hello/, 'and the turn still ran');

			// A continue still has words of its own, because the fallback is not the preset's to provide.
			asked = [];
			await kernel.ctx.agent.runTurn({ text: '', trigger: 'continue', surface: 'test' });
			assert.strictEqual(asked[asked.length - 1]?.role, 'user', 'a request never ends on the model’s own turn');

			// What the plugin adds is missing, and what Comonad ships is not.
			await kernel.ctx.plugin(slashCommands);
			const slash = kernel.ctx.commands.list().map((command) => command.name);
			assert.ok(slash.includes('help'), 'the slash commands loaded without the tavern plugin');
			for (const name of ['status', 'rewind', 'continue']) {
				assert.ok(slash.includes(name), `/${name} is still there`);
			}
			for (const name of ['char', 'persona', 'lore', 'preset']) {
				assert.ok(!slash.includes(name), `/${name} came with the tavern plugin, so it is gone`);
			}
		} finally {
			await kernel.dispose();
		}
	});

	test('the tavern is an installable plugin: the shipped tree has no row for it, and mounting one brings it back', async () => {
		const kernel = await createTestKernel({ skip: ['tavern', 'lore'] });
		try {
			// Not built in: nothing in the shipped tree names it, so a fresh window has no library, no
			// tool and no ST tab — and nothing to turn off, either.
			assert.ok(!ROWS.some((row) => row.id === 'tavern'), 'the shipped rows mount no tavern');
			assert.strictEqual(PLUGINS.tavern, undefined, 'and no built-in plugin to name');
			assert.strictEqual(kernel.ctx.get('tavern'), undefined, 'so a tree without the row has no library');
			assert.ok(!kernel.ctx.tools.all().some((tool) => tool.name === 'lore_lookup'), 'and no lore tool');

			// A row of one's own, mounted the way a `cordis.yml` mounts it: the plugin package's entry.
			await kernel.ctx.plugin(panesPlugin);
			assert.ok(kernel.ctx.panes, 'the panel’s pane list is its own service, and it is mounted first');
			await kernel.ctx.plugin(tavernEntry);
			assert.ok(kernel.ctx.tavern, 'the row provides the library');
			assert.ok(kernel.ctx.tools.all().some((tool) => tool.name === 'lore_lookup'), 'and its tool');

			const pane = kernel.ctx.panes.list().find((spec) => spec.id === 'st');
			assert.ok(pane, 'the row draws the ST tab');
			assert.strictEqual(pane?.label, 'ST');
			assert.strictEqual(pane?.command, 'comonad.openContent', 'with the command that reveals it');
			// The client files travel beside the package's build: a separately installed plugin is one
			// folder, and `__dirname` inside its own bundle is what finds them.
			assert.deepStrictEqual(
				(pane?.scripts ?? []).map((file) => basename(file)),
				['worldinfo.js', 'persona.js', 'content.js', 'st.js'],
				'the pane loads its guest pages first, and registers itself last',
			);
			assert.deepStrictEqual((pane?.styles ?? []).map((file) => basename(file)), ['content.css', 'worldinfo.css', 'persona.css']);
			for (const file of [...(pane?.scripts ?? []), ...(pane?.styles ?? [])]) {
				assert.ok(existsSync(join(PACKAGE_RESOURCES, basename(file))), `${basename(file)} ships with the plugin`);
			}
			assert.match(pane?.markup ?? '', /id="st-pane"/, 'the markup the panel writes verbatim is the package’s');

			// The pane owns its settings keys: it validates what the webview sent and claims nothing else.
			const host = { uri: () => '', refresh: () => undefined };
			const controller = pane?.controller?.(host);
			assert.ok(controller, 'the pane brings an editor');
			const owned = controller?.patch?.(
				{ tavernCharacter: '  kestrel ', tavernLorebooks: 'one\ntwo, three', tavernNoteDepth: '4', wiRecursive: true, mode: 'full' },
				kernel.ctx.settings.get(),
			) ?? {};
			assert.strictEqual(owned.tavernCharacter, 'kestrel', 'text is trimmed');
			assert.deepStrictEqual(owned.tavernLorebooks, ['one', 'two', 'three'], 'a book list takes lines and commas');
			assert.strictEqual(owned.tavernNoteDepth, 4, 'a count is read as a number');
			assert.strictEqual(owned.wiRecursive, true, 'a checkbox is a boolean');
			assert.ok(!('mode' in owned), 'the panel’s own keys are left to the panel');
			const slice = controller?.state?.() ?? {};
			assert.deepStrictEqual(Object.keys(slice).sort(), ['catalog', 'content', 'tavern'], 'the slices it pushes');
			assert.ok('wi' in (slice.tavern as Record<string, unknown>), 'the catalog and the settings travel together');
		} finally {
			await kernel.dispose();
		}
	});

	test('the plugin that ships with Comonad installs from its own folder and loads', async () => {
		// The real thing, end to end: the package as it is packaged (its `dist` bundle, built by
		// `npm run compile`), copied into the library the way the panel's Install… does it, and loaded by
		// the host from there — so the bundle's own `require('cordis')` and `require('vscode')` are the
		// modules Comonad lends it, and its resources are found beside its build.
		const extension = vscode.extensions.getExtension('comonad.comonad');
		assert.ok(extension, 'the extension is installed in the test host');
		const source = join(extension!.extensionUri.fsPath, 'packages', 'comonad-plugin-tavern');
		assert.ok(existsSync(join(source, 'dist', 'index.js')), 'the plugin bundle is built beside the extension');

		const kernel = await createTestKernel({ skip: ['tavern', 'lore'] });
		try {
			await kernel.ctx.plugin(pluginHost, { rows: [], plugins: {} });
			await kernel.ctx.plugin(panesPlugin);
			const state = await kernel.ctx.plugins.install(source);
			const row = state.find((entry) => entry.id === 'comonad-plugin-tavern');
			assert.strictEqual(row?.loaded, true, `the shipped plugin loads from the library (${row?.error ?? ''})`);
			assert.ok(kernel.ctx.get('tavern'), 'and it brought the content library with it');
			const pane = kernel.ctx.panes.list().find((spec) => spec.id === 'st');
			assert.ok(pane, 'and its ST tab');
			for (const file of [...(pane?.scripts ?? []), ...(pane?.styles ?? [])]) {
				assert.ok(existsSync(file), `${basename(file)} is found beside the installed build`);
			}
			assert.ok(kernel.ctx.tools.all().some((tool) => tool.name === 'lore_lookup'), 'and the lore tool');
		} finally {
			await kernel.dispose();
		}
	});

	test('the settings document is built from the panes the tree registered', async () => {
		const kernel = await createTestKernel();
		const root = join(__dirname, '..', '..');
		const panel = vscode.window.createWebviewPanel('comonad.test.settings', 'settings', vscode.ViewColumn.Active, {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(root)],
		});
		try {
			const pane = tavernPane(kernel.ctx);
			// Nothing but a plain pane in the host's document: its tab, its markup, its styles and its
			// scripts, with the host's client loaded first because it is what hands a pane its channel.
			const document = settingsDocument(panel.webview, vscode.Uri.file(root), 'agent', [pane]);
			assert.match(document, /<button class="tab" type="button" role="tab" data-tab="st" title="ST —/, 'the pane is a tab');
			assert.match(document, /<section data-pane="st" hidden>/, 'and a section of its own');
			assert.match(document, /id="st-pane"/, 'holding the markup it brought');
			const scripts = [...document.matchAll(/<script nonce="[^"]*" src="([^"]+)"/g)].map((match) => basename(decodeURIComponent(match[1])));
			assert.deepStrictEqual(scripts, ['settings.js', 'worldinfo.js', 'persona.js', 'content.js', 'st.js'], 'the host’s client comes first, and the pane’s last');
			assert.match(document, /id="plugins-install"/, 'and the host’s own tabs are still there');

			// A tab and its markup are the pane's own strings, so they are escaped rather than trusted.
			const hostile = { ...pane, id: 'x"><script>alert(1)</script>', label: '<b>no</b>', title: '" onload="alert(1)' };
			const escaped = settingsDocument(panel.webview, vscode.Uri.file(root), 'agent', [hostile]);
			assert.ok(!escaped.includes('<script>alert(1)</script>'), 'a pane cannot close the attribute and open a script');
			assert.match(escaped, /&lt;b&gt;no&lt;\/b&gt;/, 'and its label is text, not markup');
		} finally {
			panel.dispose();
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
					// One block for a character of our own, and one SillyTavern index we cannot map.
					{ character_id: 'Kestrel', order: [{ identifier: 'chatHistory', enabled: true }, { identifier: 'main', enabled: true }] },
					{ character_id: 7, order: [{ identifier: 'main', enabled: false }] },
				],
				unknown_key: 'kept',
				new_chat_prompt: '[Start a new Chat]',
				continue_nudge_prompt: '[Carry on from {{lastChatMessage}}.]',
				send_if_empty: '[Say something.]',
				seed: 42,
				frequency_penalty: 0.3,
				bias_preset_selected: 'Tidy',
				logit_bias: [{ id: 'b1', name: 'Tidy', value: { '1234': -100 } }, { id: 'b2', name: 'Loose', value: {} }],
				stream_openai: false,
				max_context_unlocked: true,
				use_sysprompt: true,
			}),
			'Test preset',
			'test',
		);
		assert.strictEqual(preset.temperature, 1.1);
		assert.strictEqual(preset.maxContext, 8192);
		assert.strictEqual(preset.wi_format, 'Lore: {0}');
		assert.strictEqual(preset.new_chat_prompt, '[Start a new Chat]');
		assert.strictEqual(preset.continue_nudge_prompt, '[Carry on from {{lastChatMessage}}.]');
		assert.strictEqual(preset.stream, false);
		assert.strictEqual(preset.maxContextUnlocked, true);
		assert.strictEqual(preset.useSysprompt, true);
		assert.deepStrictEqual(Object.keys(preset.promptOrders ?? {}), ['Kestrel'], 'only a character we know gets its own order');
		assert.deepStrictEqual(presetSamplers(preset), {
			temperature: 1.1,
			topP: 0.9,
			maxTokens: 512,
			frequencyPenalty: 0.3,
			seed: 42,
			logitBias: { '1234': -100 },
		}, 'only an endpoint-compatible sampler is sent, and the selected bias set comes along');

		const messages = promptCollection(preset);
		assert.strictEqual(messages[0].identifier, IDENTITY_PROMPT, 'the agent identity leads');
		assert.deepStrictEqual(messages.slice(1, 4).map((item) => item.identifier), ['main', 'chatHistory', 'authorsNote']);
		assert.deepStrictEqual(messages.filter((item) => item.identifier === 'authorsNote').map((item) => item.enabled), [false]);
		assert.ok(messages.some((item) => item.identifier === 'jailbreak'), 'the shipped blocks still ride along');
		// A character with an order of its own uses it instead of the preset's default block.
		assert.deepStrictEqual(
			promptCollection(preset, 'Kestrel').slice(2, 3).map((item) => item.identifier),
			['main'],
			'a character’s own order is used for that character',
		);
		// A preset is written back with its blocks kept: ours first, the one we cannot map last.
		const written = JSON.parse(presetToJson(preset)) as { prompt_order: { character_id: unknown }[]; unknown_key: string };
		assert.deepStrictEqual(written.prompt_order.map((block) => block.character_id), [100000, 'Kestrel', 7]);
		assert.strictEqual(written.unknown_key, 'kept', 'and the keys we do not model are kept');
		// The preset's own text replaced the shipped block of the same identifier.
		assert.strictEqual(messages.find((item) => item.identifier === 'main')?.content, 'Speak as {{char}}.');

		const saved = JSON.parse(presetToJson(preset)) as Record<string, unknown>;
		assert.strictEqual(saved.unknown_key, 'kept');
		assert.strictEqual((saved.prompt_order as Array<{ order: unknown[] }>)[0].order.length, 3);
	});

	test('a preset keeps its own prompt library, and Comonad’s shared library is seeded', async () => {
		// The key is Comonad's own: SillyTavern never writes it, so a save keeps every ST field beside it.
		const preset = parsePreset(
			JSON.stringify({
				temperature: 0.8,
				prompts: [{ identifier: 'main', content: 'hi' }],
				[PROMPT_LIBRARY_KEY]: [
					{ identifier: 'loreVoice', name: 'Lore voice', role: 'system', content: 'Keep the lore factual.' },
					{ nope: true },
				],
				unknown_key: 'kept',
			}),
			'Saved',
			'saved',
		);
		assert.deepStrictEqual(preset.promptLibrary?.map((entry) => entry.identifier), ['loreVoice'], 'an entry with no identifier is not a prompt');
		const written = JSON.parse(presetToJson(preset)) as Record<string, unknown>;
		assert.strictEqual(written.unknown_key, 'kept', 'the keys we do not model are kept');
		assert.deepStrictEqual((written[PROMPT_LIBRARY_KEY] as Array<{ identifier: string }>).map((entry) => entry.identifier), ['loreVoice']);
		// A preset that never used a library does not grow the key.
		const bare = parsePreset(JSON.stringify({ prompts: [{ identifier: 'main', content: 'hi' }] }), 'Bare', 'bare');
		assert.strictEqual(bare.promptLibrary, undefined);
		assert.ok(!(PROMPT_LIBRARY_KEY in (JSON.parse(presetToJson(bare)) as Record<string, unknown>)), 'an unused library is not written');

		// A preset saved before the identity block stopped being written: the block is taken out of every
		// order and the prompt list, and a preset without it is handed back untouched.
		const stale = { id: 'stale', name: 'Stale', raw: {}, prompts: [{ identifier: 'comonad', role: 'system' as const, marker: true }, { identifier: 'main', role: 'system' as const, content: 'hi' }], promptOrder: [{ identifier: 'comonad', enabled: true }, { identifier: 'main', enabled: true }], promptOrders: { 'Alice': [{ identifier: 'comonad', enabled: true }] } } as unknown as TavernPreset;
		const cleaned = withoutIdentityBlock(stale);
		assert.deepStrictEqual(cleaned.prompts?.map((prompt) => prompt.identifier), ['main'], 'the list keeps every other block');
		assert.deepStrictEqual(cleaned.promptOrder?.map((entry) => entry.identifier), ['main']);
		assert.deepStrictEqual(cleaned.promptOrders?.Alice, [], 'a character order loses it too');
		assert.strictEqual(withoutIdentityBlock(cleaned), cleaned, 'a clean preset is returned as it is');

		// A pane is untrusted input: what it sends back is filtered before it can be written.
		assert.deepStrictEqual(sanitisePromptLibrary([{ identifier: 'ok', content: 'x' }, { content: 'no id' }, null]).map((entry) => entry.identifier), ['ok']);

		// The built-in library is the blocks the templates carry beyond the defaults, and its file round-trips them.
		const seed = librarySeed();
		assert.deepStrictEqual(seed.map((entry) => entry.identifier), PROMPT_BLOCKS.map((block) => block.id));
		assert.ok(seed.every((entry) => !DEFAULT_PROMPTS.some((prompt) => prompt.identifier === entry.identifier)), 'the shipped defaults are not in the library');
		assert.ok(seed.every((entry) => entry.description && entry.content), 'every seeded block explains itself and says something');
		assert.deepStrictEqual(parsePromptLibrary(promptLibraryJson(seed)).map((entry) => entry.identifier), seed.map((entry) => entry.identifier));
		assert.deepStrictEqual(parsePromptLibrary('[]'), [], 'a bare array is tolerated');

		const kernel = await createTestKernel();
		try {
			// The service reads its library as it is constructed. A window that never sees a `.comonad`
			// change must still find the shared library seeded — without this the ST pane opened on an
			// empty system library and the seed file was never written.
			await kernel.ctx.tavern.ready;
			const file = kernel.ctx.tavern.promptLibraryFile();
			assert.ok(existsSync(file), 'the shared library is seeded as the service loads, so the file exists to be edited');
			assert.deepStrictEqual(kernel.ctx.tavern.promptLibrary.map((entry) => entry.identifier), PROMPT_BLOCKS.map((block) => block.id));

			// The built-in library can be edited but not grown: an added entry is dropped on save, and an
			// edit to a built-in one is kept across a reload.
			const first = kernel.ctx.tavern.promptLibrary[0]!;
			const writtenFile = await kernel.ctx.tavern.savePromptLibrary([
				{ ...first, content: 'Edited text.' },
				{ identifier: 'mine', name: 'Mine', role: 'system', content: 'Keep it short.' },
			]);
			assert.strictEqual(writtenFile, file);
			assert.ok(!kernel.ctx.tavern.promptLibrary.some((entry) => entry.identifier === 'mine'), 'a new entry cannot be added to the built-in library');
			await kernel.ctx.tavern.reload();
			assert.strictEqual(kernel.ctx.tavern.promptLibrary.find((entry) => entry.identifier === first.identifier)?.content, 'Edited text.', 'an edit to a built-in entry survives a reload');
			assert.deepStrictEqual(kernel.ctx.tavern.promptLibrary.map((entry) => entry.identifier), builtInBlocks().map((entry) => entry.identifier), 'the set stays the same');
		} finally {
			await kernel.dispose();
		}
	});

	test('a reload waits for the read before it instead of racing it', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'characters'), { recursive: true });
			writeFileSync(
				join(library, 'characters', 'late.json'),
				JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Late', description: 'Late is here.' } }),
			);
			// The service's own first read started before that card existed. This reload has to settle after
			// it, not beside it: two reads in flight can finish in either order, and the older one — the one
			// that saw an empty library — would then be the state every pane reads until something else
			// happens to reload it.
			await Promise.all([kernel.ctx.tavern.reload(), kernel.ctx.tavern.ready]);
			assert.ok(kernel.ctx.tavern.character('late'), 'the card is there once both reads are done');
		} finally {
			await kernel.dispose();
		}
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
		// At one depth upstream reads: `order` low first, and within an order assistant, user, system.
		assert.deepStrictEqual(
			injectAtDepth(
				[
					{ role: 'user', content: 'a' },
					{ role: 'assistant', content: 'b' },
					{ role: 'user', content: 'c' },
				],
				[
					{ depth: 1, role: WI_ROLE.system, content: 'late-system', order: 200 },
					{ depth: 1, role: WI_ROLE.system, content: 'early-system', order: 10 },
					{ depth: 1, role: WI_ROLE.user, content: 'early-user', order: 10 },
					{ depth: 1, role: WI_ROLE.assistant, content: 'early-assistant', order: 10 },
				],
			).map((message) => message.content),
			['a', 'b', 'early-assistant', 'early-user', 'early-system', 'late-system', 'c'],
		);
		// Two depths: the deeper one ends up further up, and depth 0 sits after the last message.
		assert.deepStrictEqual(
			injectAtDepth(
				[
					{ role: 'user', content: 'a' },
					{ role: 'assistant', content: 'b' },
				],
				[
					{ depth: 0, role: WI_ROLE.system, content: 'after' },
					{ depth: 1, role: WI_ROLE.system, content: 'before-last' },
				],
			).map((message) => message.content),
			['a', 'before-last', 'b', 'after'],
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

	test('a persona at NONE names the user and sends no description', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'personas'), { recursive: true });
			mkdirSync(join(library, 'characters'), { recursive: true });
			writeFileSync(
				join(library, 'personas', 'Ada.json'),
				JSON.stringify({ name: 'Ada', description: 'You are Ada, holding the lamp.', position: 9 }),
			);
			writeFileSync(join(library, 'characters', 'kestrel.json'), JSON.stringify({ name: 'Kestrel', description: 'A cartographer.' }));
			await kernel.ctx.tavern.reload();
			assert.strictEqual(kernel.ctx.tavern.persona('Ada')?.position, 9, 'upstream’s NONE position survives the read');

			const composed = kernel.ctx.tavern.compose({
				identity: 'identity',
				history: [{ role: 'user', content: 'Here.' }],
				binding: { character: 'kestrel', persona: 'Ada' },
				scan: [{ role: 'user', text: 'hi' }],
				turn: 1,
			});
			const texts = composed.messages.map((message) => message.content).join('\n');
			assert.ok(!texts.includes('holding the lamp'), 'the description is left out of the request');
			assert.ok(texts.includes('Ada'), 'but the name still resolves wherever the persona supplies {{user}}');
		} finally {
			await kernel.dispose();
		}
	});

	test('a persona is written in SillyTavern’s own shape, picture and all', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			const picture = join(kernel.root, 'ada.png');
			writeFileSync(picture, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
			const persona = blankPersona('Ada', 'Ada');
			persona.description = 'You are Ada.';
			persona.connections = [{ type: 'character', id: 'Kestrel' }];
			const file = await kernel.ctx.tavern.savePersona(persona);
			assert.strictEqual(file, join(library, 'personas', 'Ada.json'));
			const written = JSON.parse(readFileSync(file, 'utf8')) as { connections: unknown; depth: number };
			assert.deepStrictEqual(written.connections, [{ type: 'character', id: 'Kestrel' }], 'the file holds upstream’s connection objects');
			assert.strictEqual(written.depth, 2);

			const avatar = await kernel.ctx.tavern.setPersonaAvatar('Ada', picture);
			assert.strictEqual(avatar, join(library, 'personas', 'Ada.png'), 'the picture is a file beside the persona');
			assert.strictEqual(kernel.ctx.tavern.persona('Ada')?.avatar, avatar, 'and the catalog finds it by the persona’s id');
			assert.strictEqual(await kernel.ctx.tavern.clearPersonaAvatar('Ada'), true);
			assert.strictEqual(kernel.ctx.tavern.persona('Ada')?.avatar, undefined);
			// Deleting a persona takes its picture: no file is left naming a persona that is gone.
			await kernel.ctx.tavern.setPersonaAvatar('Ada', picture);
			assert.strictEqual(await kernel.ctx.tavern.deletePersona('Ada'), true);
			assert.strictEqual(existsSync(join(library, 'personas', 'Ada.png')), false);
		} finally {
			await kernel.dispose();
		}
	});

	test('every persona backs up into upstream’s document, and restores from one', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			const ada = blankPersona('Ada', 'Ada');
			ada.description = 'You are Ada.';
			ada.connections = [{ type: 'group', id: 'The Crew' }];
			await kernel.ctx.tavern.savePersona(ada);
			await kernel.ctx.settings.update('tavernPersona', 'Ada');

			const backup = kernel.ctx.tavern.exportPersonas();
			assert.deepStrictEqual(Object.keys(backup.personas), ['Ada'], 'the names are keyed by persona id');
			assert.strictEqual(backup.personas['Ada'], 'Ada');
			assert.strictEqual(backup.persona_descriptions['Ada']?.description, 'You are Ada.');
			assert.deepStrictEqual(backup.persona_descriptions['Ada']?.connections, [{ type: 'group', id: 'The Crew' }]);
			assert.strictEqual(backup.default_persona, 'Ada');

			// Restoring is a merge: what is already here is left exactly as it is.
			const again = await kernel.ctx.tavern.importPersonas(backup);
			assert.deepStrictEqual(again.personas, []);
			assert.ok(again.skipped.some((line) => line.includes('already exists')), 'and it says what it skipped');

			const restore = await kernel.ctx.tavern.importPersonas({
				personas: { 'The Narrator': 'Narrator', 'Odd (Persona)': 'Odd' },
				persona_descriptions: {
					'The Narrator': { description: 'You narrate.', position: 4, depth: 3, role: 2, connections: [{ type: 'character', id: 'Kestrel' }] },
					'Odd (Persona)': { description: 'You are odd.' },
					Orphan: { description: 'there is no persona for this one' },
				},
				default_persona: 'The Narrator',
			});
			assert.deepStrictEqual(
				restore.personas.map((persona) => persona.id),
				['The-Narrator', 'Odd-Persona'],
				'an id that is not file-safe is renamed along with its file',
			);
			assert.strictEqual(restore.defaultPersona, 'The-Narrator', 'and the document’s default follows the rename');
			assert.ok(restore.skipped.some((line) => line.includes('Orphan')), 'a description without a persona is skipped, as upstream does');
			assert.ok(existsSync(join(library, 'personas', 'The-Narrator.json')));
			assert.strictEqual(kernel.ctx.tavern.persona('The-Narrator')?.position, 4);
			assert.strictEqual(kernel.ctx.tavern.persona('The-Narrator')?.connections[0]?.id, 'Kestrel');
			assert.strictEqual(kernel.ctx.settings.get().tavernPersona, 'The-Narrator', 'the document’s own default is adopted with it');
		} finally {
			await kernel.dispose();
		}
	});

	test('a character converts into a persona, macros and all', () => {
		const character = blankCharacter('Kestrel', 'Kestrel');
		character.description = '{{char}} is a cartographer. {{user}} holds the lamp.';
		const kept = convertCharacterToPersona(character, 'Kestrel-Persona', '', false);
		assert.strictEqual(kept.name, 'Kestrel');
		assert.strictEqual(kept.description, character.description, 'the description comes across untouched when the macros are kept');
		const swapped = convertCharacterToPersona(character, 'Kestrel-Persona', '', true);
		assert.strictEqual(swapped.description, '{{user}} is a cartographer. {{char}} holds the lamp.', 'a swap trades the two macros');
		assert.strictEqual(swapped.depth, 2);
		assert.deepStrictEqual(swapped.connections, [], 'upstream binds nothing on conversion either');
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

		const persona = adoptPersona({
			name: 'Ada',
			connections: ['Kestrel', '', { type: 'character', id: 'Kestrel' }, { type: 'group', id: 'The Crew' }, { id: 'Astra' }, { nope: true }],
			position: 4,
			depth: 2,
			role: 1,
		});
		assert.deepStrictEqual(
			persona.connections,
			[
				{ type: 'character', id: 'Kestrel' },
				{ type: 'group', id: 'The Crew' },
				{ type: 'character', id: 'Astra' },
			],
			'a bare name reads as a character connection, upstream’s objects keep their type, and a repeat is dropped',
		);
		assert.strictEqual(persona.title, '', 'a missing title stays empty');
		assert.strictEqual(persona.position, 4);
		assert.strictEqual(adoptPersona({ name: 'Bare' }).depth, 2, 'a fresh persona is at SillyTavern’s own default depth');
		assert.strictEqual(blankPersona('Ada', 'Ada').depth, 2);
		assert.strictEqual(blankPersona('Ada', 'Ada').title, '', 'the picker shows the name until a title is given');

		const preset = adoptPreset({
			name: 'Edited',
			prompts: [{ identifier: 'main', content: 'hi' }, { nope: true }],
			promptLibrary: [{ identifier: 'saved', name: 'Saved', role: 'system', content: 'Keep it short.' }, { content: 'no identifier' }],
			temperature: 0.5,
			top_p: 'high',
			maxTokens: 800,
		});
		assert.strictEqual(preset.id, 'Edited');
		assert.deepStrictEqual(preset.prompts?.map((prompt) => prompt.identifier), ['main'], 'a prompt without an identifier is dropped');
		assert.deepStrictEqual(preset.promptLibrary?.map((entry) => entry.identifier), ['saved'], 'a library entry is sanitised like a prompt');
		assert.deepStrictEqual(preset.promptOrder, [{ identifier: 'main', enabled: true }]);
		assert.strictEqual(preset.temperature, 0.5);
		assert.strictEqual(preset.top_p, undefined, 'a sampler with the wrong type is not written');
		assert.strictEqual(preset.maxTokens, 800);
	});

	test('a card keeps upstream’s own fields, and the card verbs move what they say they move', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'characters'), { recursive: true });
			// A V1 card: `fav` and `talkativeness` live at the root there, and `create_date` always does.
			writeFileSync(
				join(library, 'characters', 'kestrel.json'),
				JSON.stringify({
					name: 'Kestrel',
					description: 'A cartographer.',
					fav: true,
					talkativeness: 0.9,
					create_date: '2024-01-02T03:04:05.000Z',
					data: { extensions: { source_url: 'https://example.invalid/kestrel' } },
				}),
			);
			// A card that carries a book of its own, which is what upstream's *Import Card Lore* reads.
			writeFileSync(
				join(library, 'characters', 'city.json'),
				JSON.stringify({
					name: 'City',
					data: {
						name: 'City',
						character_book: { name: 'City Lore', entries: [{ id: 0, keys: ['salt'], content: 'The flats drink sound.' }] },
					},
				}),
			);
			writeFileSync(join(library, 'characters', 'plain.json'), JSON.stringify({ name: 'Plain', data: { name: 'Plain' } }));
			await kernel.ctx.tavern.reload();

			const card = kernel.ctx.tavern.character('kestrel')!;
			assert.strictEqual(card.favourite, true, '`fav` at the root of a V1 card is the favourite');
			assert.strictEqual(card.talkativeness, 0.9);
			assert.strictEqual(card.createdAt, '2024-01-02T03:04:05.000Z');
			assert.strictEqual(card.sourceLink, 'https://example.invalid/kestrel');
			assert.strictEqual(kernel.ctx.tavern.character('plain')?.talkativeness, 0.5, 'a card without one speaks at upstream’s default');

			// The new fields are written where upstream writes them: `extensions` in V2, the root in V1.
			const written = JSON.parse(await (async () => {
				await kernel.ctx.tavern.saveCharacter({ ...kernel.ctx.tavern.character('plain')!, favourite: true, talkativeness: 0.2 });
				return readFileSync(join(library, 'characters', 'plain.json'), 'utf8');
			})()) as { fav?: boolean; talkativeness?: number; data: { extensions: { fav?: boolean; talkativeness?: number } } };
			assert.strictEqual(written.fav, true, 'a V1 reader sees the root flag');
			assert.strictEqual(written.talkativeness, 0.2);
			assert.strictEqual(written.data.extensions.fav, true, 'and a V2 reader sees the extension');
			assert.strictEqual(written.data.extensions.talkativeness, 0.2);

			// A picture becomes the card: the JSON goes, the PNG carries the same document.
			const picture = join(kernel.root, 'kestrel.png');
			writeFileSync(picture, blankPng(8, 8));
			const file = await kernel.ctx.tavern.setCharacterAvatar('kestrel', picture);
			assert.strictEqual(file, join(library, 'characters', 'kestrel.png'));
			assert.strictEqual(existsSync(join(library, 'characters', 'kestrel.json')), false, 'the JSON card is gone');
			const reread = kernel.ctx.tavern.character('kestrel')!;
			assert.strictEqual(reread.name, 'Kestrel', 'the document came along into the PNG');
			assert.strictEqual(reread.favourite, true);
			assert.strictEqual(reread.description, 'A cartographer.');

			// Import Card Lore: the embedded book becomes a library book, and the card links to it.
			const imported = await kernel.ctx.tavern.importCardLore('city');
			assert.deepStrictEqual(imported, { name: 'City Lore', entries: 1 });
			assert.ok(existsSync(join(library, 'lorebooks', 'City-Lore.json')), 'the book is a file of its own, named after it');
			assert.strictEqual(kernel.ctx.tavern.character('city')?.world, 'City Lore', 'and the card is linked to it');
			assert.strictEqual(kernel.ctx.tavern.book('City Lore')?.book.entries['0']?.content, 'The flats drink sound.');
			// The same book is not scanned twice: the embedded copy is the world that is now linked.
			const books = kernel.ctx.tavern.booksFor('no-chat').map((book) => book.name);
			assert.deepStrictEqual(books, [], 'a chat with nothing selected scans nothing');

			// Rename: the file, the tag key and a persona's connection all move with the character.
			const store = kernel.ctx.tavern.tags;
			addTags(store, 'plain', [ensureTag(store, 'Scenery')!]);
			await kernel.ctx.tavern.saveTags();
			const persona = blankPersona('Ada', 'Ada');
			persona.connections = [{ type: 'character', id: 'plain' }];
			await kernel.ctx.tavern.savePersona(persona);
			assert.strictEqual(await kernel.ctx.tavern.renameCharacter('plain', 'Plain Sight'), 'Plain-Sight');
			assert.ok(existsSync(join(library, 'characters', 'Plain-Sight.json')));
			assert.strictEqual(existsSync(join(library, 'characters', 'plain.json')), false, 'the old file is renamed, not copied');
			assert.strictEqual(kernel.ctx.tavern.character('Plain Sight')?.name, 'Plain Sight');
			assert.deepStrictEqual(kernel.ctx.tavern.tagIdsFor('Plain-Sight').length, 1, 'the tags followed the file');
			assert.deepStrictEqual(kernel.ctx.tavern.persona('Ada')?.connections, [{ type: 'character', id: 'Plain-Sight' }]);
		} finally {
			await kernel.dispose();
		}
	});

	test('Comonad’s own preset templates are presets, and each one is written like any other', async () => {
		const kernel = await createTestKernel();
		try {
			assert.ok(PRESET_TEMPLATES.length >= 4, 'there are templates to start from');
			for (const template of PRESET_TEMPLATES) {
				assert.ok(template.preset.prompts?.length, `${template.name} ships the prompt list`);
				assert.ok(template.preset.promptOrder?.length, `${template.name} ships its order`);
				assert.ok(template.preset.new_chat_prompt, `${template.name} marks a new chat`);
				const file = await kernel.ctx.tavern.savePresetValue({ ...template.preset, source: '' });
				const back = kernel.ctx.tavern.preset(template.id);
				assert.ok(back, `${template.name} lands in the library as ${template.id}`);
				assert.strictEqual(existsSync(file), true);
				assert.deepStrictEqual(presetSamplers(back), presetSamplers(template.preset), 'and reads back with its samplers');
				assert.strictEqual(back.new_chat_prompt, template.preset.new_chat_prompt, 'and with its nudges');
			}
			// A block's identifier is its own, so inserting one never collides with a shipped block.
			const shipped = new Set(['main', 'nsfw', 'chatHistory', 'jailbreak', 'worldInfoBefore', 'worldInfoAfter', 'dialogueExamples']);
			for (const block of PROMPT_BLOCKS) {
				assert.ok(!shipped.has(block.id), `${block.name} uses an identifier of its own`);
				assert.ok(block.content.trim().length > 40, `${block.name} says something`);
			}
		} finally {
			await kernel.dispose();
		}
	});

	test('a preset heads the history, fills an empty turn, and nudges a continue', async () => {
		const kernel = await createTestKernel();
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'presets'), { recursive: true });
			mkdirSync(join(library, 'characters'), { recursive: true });
			writeFileSync(join(library, 'characters', 'kestrel.json'), JSON.stringify({ name: 'Kestrel', description: 'A cartographer.' }));
			writeFileSync(
				join(library, 'presets', 'Nudges.json'),
				JSON.stringify({
					new_chat_prompt: '[A new chat begins.]',
					send_if_empty: '[Say something.]',
					continue_nudge_prompt: '[Carry on from {{lastChatMessage}}.]',
					// The shipped main prompt is written with `{{charIfNotGroup}}`, which a solo chat reads
					// as the character's name.
					prompts: [{ identifier: 'main', name: 'Main Prompt', role: 'system', system_prompt: true, content: 'Write for {{charIfNotGroup}} and {{user}}.' }],
					prompt_order: [
						{
							character_id: 100000,
							order: [
								{ identifier: 'main', enabled: true },
								{ identifier: 'chatHistory', enabled: true },
							],
						},
					],
				}),
			);
			await kernel.ctx.tavern.reload();
			assert.ok(presetSamplers(kernel.ctx.tavern.preset('Nudges')) !== undefined);

			const composed = kernel.ctx.tavern.compose({
				identity: 'identity',
				history: [
					{ role: 'user', content: 'hi' },
					{ role: 'assistant', content: 'hm.' },
				],
				binding: { character: 'kestrel', preset: 'Nudges' },
				scan: [],
				turn: 2,
				trigger: 'continue',
			});
			const texts = composed.messages.map((message) => message.content);
			assert.strictEqual(texts[0], 'identity', 'the agent identity still leads');
			assert.ok(texts.some((text) => text.includes('Write for Kestrel and')), '{{charIfNotGroup}} is the character in a solo chat');
			assert.ok(texts.includes('[A new chat begins.]'), 'the new-chat marker heads the history');
			assert.ok(texts.some((text) => text.includes('Carry on from hm.')), 'the continue nudge carries the last message');
			assert.ok(
				composed.messages.findIndex((message) => message.content.includes('Carry on from')) >
					composed.messages.findIndex((message) => message.content === 'hm.'),
				'and it is said after the message it carries on from',
			);
			// Upstream checks the *history* for `send_if_empty`, and a continue's history also ends on a
			// reply, so both are said — the nudge and the filled turn. That is upstream's own behaviour.
			assert.ok(texts.includes('[Say something.]'), 'the empty turn is filled when the history ends on a reply');
			assert.ok(
				composed.messages.findIndex((message) => message.content.includes('Carry on from')) <
					composed.messages.findIndex((message) => message.content === '[Say something.]'),
				'and the nudge comes before it, as upstream adds it',
			);

			// `send_if_empty` fills a turn the history would otherwise end on.
			const filled = kernel.ctx.tavern.compose({
				identity: 'identity',
				history: [{ role: 'assistant', content: 'hm.' }],
				binding: { character: 'kestrel', preset: 'Nudges' },
				scan: [],
				turn: 2,
			});
			assert.ok(
				filled.messages.some((message) => message.role === 'user' && message.content === '[Say something.]'),
				'the empty turn is filled as the user',
			);
		} finally {
			await kernel.dispose();
		}
	});

	test('an edited prompt keeps its triggers, its depth and its order, and Reset has the shipped one', () => {
		// Upstream's `shouldTrigger`: a list of generation types, and nothing in the list means all of them.
		assert.ok(triggersGeneration({}, 'continue'), 'no trigger list means every generation type');
		assert.ok(triggersGeneration({ injection_trigger: [] }, 'continue'), 'and so does an empty one');
		assert.ok(!triggersGeneration({ injection_trigger: ['normal'] }, 'continue'));

		const preset = parsePreset(
			JSON.stringify({
				prompts: [
					// A block limited to some generation types is left out of the others.
					{ identifier: 'main', name: 'Main Prompt', content: 'Main.', injection_trigger: ['normal', 'telepathy'] },
					// An in-chat block: its own text is spliced into the history at its depth and its order.
					{ identifier: 'assistantPrefill', name: 'Prefill', role: 'assistant', content: 'A prefill.', injection_position: 1, injection_depth: 0, injection_order: 50 },
					{ identifier: 'quiet', name: 'Quiet', role: 'system', content: '', injection_position: 1, injection_depth: 1, injection_order: 10 },
				],
			}),
			'Prompts',
			'prompts',
		);
		assert.deepStrictEqual(preset.prompts?.[0].injection_trigger, ['normal'], 'a generation type upstream does not have is dropped as it is read');
		assert.ok(promptCollection(preset, '', 'normal').some((prompt) => prompt.identifier === 'main'), 'the block is sent for the type it names');
		assert.ok(!promptCollection(preset, '', 'continue').some((prompt) => prompt.identifier === 'main'), 'and left out of the ones it does not');
		assert.strictEqual(promptCollection(preset, '', 'continue')[0].identifier, IDENTITY_PROMPT, 'the identity block is never filtered away');

		const history = [
			{ role: 'user' as const, content: 'one' },
			{ role: 'assistant' as const, content: 'two' },
			{ role: 'user' as const, content: 'three' },
		];
		const messages = assemble(promptCollection(preset), { identity: 'identity' }, history);
		assert.strictEqual(messages.find((message) => message.content === 'A prefill.')?.role, 'assistant', 'an in-chat block keeps the role it was given');
		assert.deepStrictEqual(
			messages.filter((message) => ['one', 'two', 'three', 'A prefill.'].includes(message.content)).map((message) => message.content),
			['one', 'two', 'three', 'A prefill.'],
			'it lands at depth 0, after the last message, and the block that was emptied sends nothing at all',
		);

		// *Reset* in the pane reads the shipped block, and a block of your own has nothing to go back to.
		const shipped = shippedPrompt('main');
		assert.deepStrictEqual(shipped, DEFAULT_PROMPTS.find((prompt) => prompt.identifier === 'main'), 'the shipped block is the one upstream ships');
		assert.strictEqual(shippedPrompt('my-own-block'), undefined);
	});

	test('a character, its book and a preset shape the request without displacing the agent', async () => {		const card = {
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

	test('an entry that names a character or a tag is left out of every other chat', () => {
		const books = [
			loreBookOf([
				{ uid: 0, key: ['salt'], content: 'Only for Kestrel.', comment: 'only', characterFilter: { names: ['kestrel'] } },
				{ uid: 1, key: ['salt'], content: 'For everyone else.', comment: 'except', characterFilter: { names: ['kestrel'], isExclude: true } },
				{ uid: 2, key: ['salt'], content: 'For a tagged character.', comment: 'tagged', characterFilter: { tags: ['wilderness'] } },
			]),
		];
		const activated = (patch: Partial<LoreInput>): string[] =>
			activateLore(lore({ books, ...patch })).activated.map((hit) => hit.entry.comment ?? '');
		assert.deepStrictEqual(
			activated({ character: { name: 'kestrel', tags: ['wilderness'] } }),
			['only', 'tagged'],
			'the named card gets its own entry, and the tagged one gets the tag entry',
		);
		assert.deepStrictEqual(activated({ character: { name: 'other', tags: ['city'] } }), ['except'], 'the name check turns around, the tags miss');
		assert.deepStrictEqual(activated({ character: { name: 'other', tags: ['wilderness'] } }), ['except', 'tagged'], 'a matching tag lets the third entry through');
		assert.deepStrictEqual(activated({ character: { name: 'other' } }), ['except'], 'a character with no tags carries none of them, so the tag filter still applies');
		assert.deepStrictEqual(activated({}), ['except', 'tagged'], 'with no card at all only the exclusion keeps its meaning');
	});

	test('an outlet entry is not injected where it sits: {{outlet::Name}} is how it lands', () => {
		const books = [
			loreBookOf([
				{ uid: 0, key: ['salt'], content: 'Sign: the flats.', position: WI_POSITION.outlet, outletName: 'sign' },
				{ uid: 1, key: ['salt'], content: 'In the prompt.', position: WI_POSITION.before },
			]),
		];
		const result = activateLore(lore({ books }));
		assert.deepStrictEqual(result.outlets, { sign: ['Sign: the flats.'] }, 'the scan collects outlets instead of injecting them');
		assert.deepStrictEqual(result.before, ['In the prompt.'], 'the outlet entry is not in the before bucket');
		assert.deepStrictEqual(result.after, []);
		assert.deepStrictEqual(result.atDepth, []);
		const macro = { char: 'Kestrel', user: 'You', outlets: result.outlets };
		assert.strictEqual(substituteMacros('a {{outlet::sign}} b', macro), 'a Sign: the flats. b');
		assert.strictEqual(substituteMacros('a {{outlet:sign}} b', macro), 'a Sign: the flats. b', 'the single-colon form is read too');
		assert.strictEqual(substituteMacros('a {{outlet::nobody}} b', macro), 'a  b', 'an unknown outlet is empty, not left as a macro');
	});

	test('the budget says which entries it dropped, and the alert is said once per chat', async () => {
		const kernel = await createTestKernel({
			config: { tavernLorebooks: ['Big'], contextLimit: 400, wiBudget: 2, wiOverflowAlert: true },
		});
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'lorebooks'), { recursive: true });
			const entry = (uid: number): Record<string, unknown> => ({ uid, key: ['salt'], content: `${uid} `.repeat(120), position: 0 });
			writeFileSync(join(library, 'lorebooks', 'Big.json'), JSON.stringify({ name: 'Big', entries: { '0': entry(0), '1': entry(1) } }));
			await kernel.ctx.tavern.reload();
			kernel.ctx.llm.use({
				name: 'test',
				async chat() {
					return { message: { role: 'assistant' as const, content: 'ok' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const notices: string[] = [];
			kernel.ctx.on('agent/notice', (_ref, text) => notices.push(text));
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'big');
			session.transcript.push({ role: 'user', content: 'salt', at: 1 });
			kernel.ctx.sessions.save(session);
			await kernel.ctx.agent.runTurn({ text: 'tell me about the salt', sessionId: 'big' });
			assert.strictEqual(kernel.ctx.sessions.require('big').tavernOverflow, true, 'the scan reports that it ran out');
			assert.strictEqual(notices.filter((text) => text.includes('budget')).length, 1, 'the alert is said once');
			await kernel.ctx.agent.runTurn({ text: 'and again about the salt', sessionId: 'big' });
			assert.strictEqual(notices.filter((text) => text.includes('budget')).length, 1, 'and not again on the next turn');
		} finally {
			await kernel.dispose();
		}
	});

	test('a book keeps its display order and the fields the editor does not show', () => {
		const entry = worldEntry({
			uid: 3,
			key: ['salt'],
			content: 'x',
			displayIndex: 7,
			vectorized: true,
			automationId: 'qr-1',
			triggers: ['continue'],
			addMemo: true,
			characterFilter: { names: ['kestrel'], tags: [], isExclude: false },
		});
		const json = entryToJson(entry);
		assert.strictEqual(json.displayIndex, 7, 'the display order is written where upstream keeps it');
		assert.strictEqual(json.vectorized, true);
		assert.strictEqual(json.automationId, 'qr-1');
		assert.deepStrictEqual(json.triggers, ['continue']);
		assert.strictEqual(json.addMemo, true);
		assert.deepStrictEqual(json.character_filter, { isExclude: false, names: ['kestrel'], tags: [] }, 'the filter keeps SillyTavern’s own key and shape');
		assert.ok(!('characterFilterNames' in json), 'and the flat keys an early file carried are gone');
		assert.strictEqual((json.extensions as Record<string, unknown>).display_index, 7, 'and the mirror stays in step');
	});

	test('the entry list searches and sorts the way the panel offers', () => {
		const book = [
			worldEntry({ uid: 1, key: ['eldoria'], content: 'nothing here', comment: 'The forest', order: 100 }),
			worldEntry({ uid: 2, key: [], content: 'the eldoria road', comment: '', order: 300 }),
			worldEntry({ uid: 3, key: ['salt'], content: 'x', comment: '', order: 200, constant: true }),
			worldEntry({ uid: 4, key: ['salt'], content: 'x', comment: '', order: 400, disable: true }),
			worldEntry({ uid: 5, key: ['glade'], content: 'the forest floor', comment: '', order: 400 }),
		];
		const hits = (query: string) => [...searchEntries(book, query).keys()].sort((left, right) => left - right);
		// The query goes through Fuse with upstream's own keys and weights: a key beats a body match…
		assert.deepStrictEqual(hits('eldoria'), [1, 2]);
		assert.ok(
			(searchEntries(book, 'eldoria').get(1) ?? 1) < (searchEntries(book, 'eldoria').get(2) ?? 1),
			'a key match outranks a body match, which is what the weights are for',
		);
		assert.deepStrictEqual(hits('forest'), [1, 5]);
		assert.deepStrictEqual(hits('salt'), [3, 4], 'a group of entries shares a key');
		// …and the fields that are not prose are searchable too, as upstream allows.
		assert.deepStrictEqual(hits('5'), [5], 'the uid is a field');
		assert.deepStrictEqual(hits('nothing'), [1], 'a match in the body alone is still a hit');
		// Extended search is on upstream's list of options, so `'exact` and `!not` are understood.
		assert.deepStrictEqual(hits("'the forest"), [1, 5]);
		assert.deepStrictEqual(hits('!forest'), [], 'a negated term is not a hit by itself');
		assert.deepStrictEqual(hits('zzzz'), [], 'a query nothing matches returns nothing');
		// No query: the rule decides, and every rule falls back to order descending, then uid.
		assert.deepStrictEqual(
			visibleEntries(book, '', 'priority').map((entry) => entry.uid),
			[3, 5, 2, 1, 4],
			'constant first, then ordinary, then disabled',
		);
		assert.deepStrictEqual(
			visibleEntries(book, '', 'uid-asc').map((entry) => entry.uid),
			[1, 2, 3, 4, 5],
			'a field sort orders by that field',
		);
		assert.deepStrictEqual(
			visibleEntries(book, '', 'depth-asc').map((entry) => entry.uid),
			[4, 5, 2, 3, 1],
			'a field every entry ties on falls back to order descending, then uid',
		);
		assert.deepStrictEqual(
			visibleEntries(book, '', 'custom').map((entry) => entry.uid),
			[1, 2, 3, 4, 5],
			'custom follows the display index, which defaults to the uid',
		);
		// A query filters and switches the order to the scores, whatever the select says.
		assert.deepStrictEqual(
			visibleEntries(book, 'forest', 'uid-asc').map((entry) => entry.uid),
			[1, 5],
			'only the hits, best first',
		);
		assert.strictEqual(ruleOf('nonsense').value, 'priority', 'an unknown rule is the default');
	});

	test('the tag registry is a list of ids with a map from entity to tags', () => {
		const store = emptyStore();
		const first = ensureTag(store, 'Fantasy')!;
		assert.strictEqual(store.tags.length, 1);
		assert.strictEqual(ensureTag(store, 'fantasy')!.id, first.id, 'a name matches in any case, so nothing is duplicated');
		const second = ensureTag(store, 'Other')!;
		assert.ok((second.sort_order ?? 0) > (first.sort_order ?? 0), 'the sort key lands after the tags that exist');
		assert.strictEqual(addTags(store, 'kestrel', [first, second]), 2);
		assert.strictEqual(addTags(store, 'kestrel', [first]), 0, 'assigning a tag twice adds nothing');
		assert.deepStrictEqual(tagsOf(store, 'kestrel').map((tag) => tag.name), ['Fantasy', 'Other'], 'in the registry order');
		// A rename keeps the id, which is why every reference survives it.
		assert.strictEqual(renameTag(store, first.id, 'High fantasy'), true);
		assert.deepStrictEqual(tagIdsOf(store, 'kestrel'), [first.id, second.id], 'the ids are untouched');
		// Delete with a merge hands over everything that carried it.
		assert.strictEqual(deleteTag(store, second.id, first.id), true);
		assert.deepStrictEqual(tagIdsOf(store, 'kestrel'), [first.id], 'the carrier moved to the tag it was merged into');
		assert.ok(!byId(store, second.id), 'and the deleted tag is gone');
		assert.deepStrictEqual(readStore(JSON.parse(storeJson(store)) as unknown), store, 'the file round-trips');
		// A registry copied out of SillyTavern keys the map by the avatar's file name.
		const theirs = readStore({ tags: [{ id: 'a', name: 'A' }], tag_map: { 'kestrel.png': ['a'] } });
		assert.deepStrictEqual(tagIdsOf(theirs, 'kestrel'), ['a'], 'the file name is found by its stem');
	});

	test("a card's own tags are imported exactly the way the setting says", () => {
		const store = readStore({ tags: [{ id: 'a', name: 'Fantasy' }], tag_map: {} });
		const card = ['Fantasy', 'TAVERN', 'Adventure', '', 'adventure'];
		assert.deepStrictEqual(planTagImport(store, 'kestrel', card, TAG_IMPORT.NONE), { names: [], existing: [], fresh: [] });
		const only = planTagImport(store, 'kestrel', card, TAG_IMPORT.ONLY_EXISTING);
		assert.deepStrictEqual(only.names, ['Fantasy'], 'only the tag that is already in the registry');
		assert.deepStrictEqual(applyTagImport(store, 'kestrel', only), ['Fantasy']);
		assert.deepStrictEqual(store.tags.map((tag) => tag.name), ['Fantasy'], 'and nothing was created');
		const all = planTagImport(store, 'kestrel', card, TAG_IMPORT.ALL);
		assert.deepStrictEqual(all.names, ['Adventure'], 'the generator tag and the assigned tag are both left out');
		assert.deepStrictEqual(all.fresh, ['Adventure'], 'a second spelling of a name is not a second tag');
		assert.deepStrictEqual(applyTagImport(store, 'kestrel', all), ['Adventure']);
		assert.deepStrictEqual(tagsOf(store, 'kestrel').map((tag) => tag.name), ['Fantasy', 'Adventure']);
		assert.deepStrictEqual(planTagImport(store, 'kestrel', card, TAG_IMPORT.ALL).names, [], 'importing again has nothing left to do');
		// A card may carry hundreds of junk tags, which is why upstream caps the import.
		const many = Array.from({ length: 80 }, (_, index) => `tag ${index}`);
		assert.strictEqual(planTagImport(emptyStore(), 'kestrel', many, TAG_IMPORT.ALL).names.length, ANTI_TROLL_MAX_TAGS);
		// Pruning is the cleanup for a library that had tags imported into it and then emptied.
		const busy = readStore({ tags: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], tag_map: { kestrel: ['a'] } });
		assert.strictEqual(pruneTags(busy), 1);
		assert.deepStrictEqual(busy.tags.map((tag) => tag.name), ['A']);
	});

	test('the project registry overlays the user one instead of replacing it', () => {
		const project = readStore({ tags: [{ id: 'a', name: 'Shared', color: '#123' }], tag_map: { kestrel: ['a'] } });
		const user = readStore({ tags: [{ id: 'a', name: 'Shared (user)' }, { id: 'b', name: 'Theirs' }], tag_map: { kestrel: ['b'], other: ['b'] } });
		const merged = mergeStores(project, user);
		assert.strictEqual(merged.tags.length, 2, 'one tag per id');
		assert.strictEqual(byId(merged, 'a')!.name, 'Shared', 'the project root wins');
		assert.strictEqual(byId(merged, 'a')!.color, '#123', 'including the fields of the tag');
		assert.deepStrictEqual(merged.tag_map.kestrel, ['a', 'b'], 'an entity keeps what both files gave it');
		assert.deepStrictEqual(merged.tag_map.other, ['b']);
	});

	test('an entry filtered to a tag reaches only the characters that carry it', async () => {
		const kernel = await createTestKernel({ config: { tavernCharacter: 'kestrel', tavernLorebooks: ['Salt'] } });
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'characters'), { recursive: true });
			mkdirSync(join(library, 'lorebooks'), { recursive: true });
			const card = (name: string): string => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: `${name} is here.` } });
			writeFileSync(join(library, 'characters', 'kestrel.json'), card('Kestrel'));
			writeFileSync(join(library, 'characters', 'other.json'), card('Other'));
			// The registry first, because the entry below filters on a tag id and the id has to exist.
			writeFileSync(join(library, 'tags.json'), JSON.stringify({ tags: [{ id: 'wild', name: 'Wilderness' }], tag_map: { kestrel: ['wild'] } }));
			writeFileSync(
				join(library, 'lorebooks', 'Salt.json'),
				JSON.stringify({
					name: 'Salt',
					entries: { '0': { uid: 0, key: ['salt'], content: 'Only the wild ones know.', character_filter: { names: [], tags: ['wild'], isExclude: false } } },
				}),
			);
			await kernel.ctx.tavern.reload();
			assert.deepStrictEqual(kernel.ctx.tavern.tagIdsFor('kestrel'), ['wild'], 'the registry is read from the library');
			assert.deepStrictEqual(kernel.ctx.tavern.tagIdsFor('other'), [], 'a card without tags carries none');
			assert.strictEqual(kernel.ctx.tavern.tagFile(), join(library, 'tags.json'), 'the registry is written into the library');

			let seen: Message[] = [];
			kernel.ctx.llm.use({
				name: 'test',
				async chat(request) {
					seen = request.messages;
					return { message: { role: 'assistant', content: 'ok' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'tagged');
			kernel.ctx.sessions.save(session);
			await kernel.ctx.agent.runTurn({ text: 'tell me about the salt', sessionId: 'tagged' });
			const said = (): boolean => seen.some((message) => message.content.includes('Only the wild ones know.'));
			assert.strictEqual(said(), true, 'the tagged card gets the entry');

			const stored = kernel.ctx.sessions.require('tagged');
			stored.character = 'other';
			kernel.ctx.sessions.save(stored);
			await kernel.ctx.agent.runTurn({ text: 'and again about the salt', sessionId: 'tagged' });
			assert.strictEqual(said(), false, 'the untagged card does not, even though the key matches');

			// The pane's write path: a tag assigned to the other card lands in the file and comes back.
			const store = kernel.ctx.tavern.tags;
			addTags(store, 'other', [byId(store, 'wild')!]);
			await kernel.ctx.tavern.saveTags();
			const written = JSON.parse(readFileSync(join(library, 'tags.json'), 'utf8')) as { tag_map: Record<string, string[]> };
			assert.deepStrictEqual(written.tag_map.other, ['wild'], 'a tag assigned in the pane is written to tags.json');
			assert.deepStrictEqual(kernel.ctx.tavern.tagIdsFor('other'), ['wild'], 'and read back from it');
		} finally {
			await kernel.dispose();
		}
	});

	test('an entry automation fires the hook and runs the command it names', async () => {
		// `/cost` is registered by the extension, so it is exactly what a book can automate by name.
		const kernel = await createTestKernel({ config: { tavernLorebooks: ['Auto'], wiAutomation: true } });
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'lorebooks'), { recursive: true });
			writeFileSync(
				join(library, 'lorebooks', 'Auto.json'),
				JSON.stringify({
					name: 'Auto',
					entries: {
						'0': { uid: 0, key: ['salt'], content: 'Pickled.', automationId: 'test-automation' },
						'1': { uid: 1, key: ['salt'], content: 'Also pickled.', automationId: 'test-automation' },
						'2': { uid: 2, key: ['salt'], content: 'Nothing to run here.', automationId: 'no-such-automation' },
					},
				}),
			);
			await kernel.ctx.tavern.reload();
			// A book can automate any command by name: this one is the test's own stand-in for a QR.
			let ran = 0;
			kernel.ctx.commands.register({
				name: 'test-automation',
				description: '',
				run: () => {
					ran += 1;
					return { done: true, result: 'the automation ran' };
				},
			});
			kernel.ctx.llm.use({
				name: 'test',
				async chat() {
					return { message: { role: 'assistant' as const, content: 'ok' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const notices: string[] = [];
			kernel.ctx.on('agent/notice', (_ref, text) => notices.push(text));
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'auto');
			kernel.ctx.sessions.save(session);
			await kernel.ctx.agent.runTurn({ text: 'tell me about the salt', sessionId: 'auto' });
			// The automation runs in the background of the turn, so give it a tick to finish.
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.strictEqual(ran, 1, 'two entries naming one automation share a single run for the batch');
			assert.strictEqual(notices.filter((text) => text.includes('the automation ran')).length, 1, 'and its output is said once');
		} finally {
			await kernel.dispose();
		}
	});

	test('a vectorized entry is found by the chat’s meaning, not by its keys', async () => {
		const kernel = await createTestKernel({ config: { tavernLorebooks: ['Salt'], wiVectorEnabled: true, wiVectorThreshold: 0.5, wiVectorMaxEntries: 1 } });
		try {
			const library = join(kernel.root, 'ws', '.comonad');
			mkdirSync(join(library, 'lorebooks'), { recursive: true });
			writeFileSync(
				join(library, 'lorebooks', 'Salt.json'),
				JSON.stringify({
					name: 'Salt',
					entries: {
						// Three entries, two of them vectorized: the search may bring back one (max entries 1).
						'0': { uid: 0, key: [], content: 'The flats drink sound.', vectorized: true },
						'1': { uid: 1, key: [], content: 'A caravan went north.', vectorized: true },
						'2': { uid: 2, key: ['salt'], content: 'Keys still work.', vectorized: false },
					},
				}),
			);
			await kernel.ctx.tavern.reload();
			// A stand-in endpoint: the vector of a text is its length, which is enough to rank two texts.
			const asked: string[][] = [];
			let seen: Message[] = [];
			kernel.ctx.vectors.use({
				name: 'http::text-embedding-3-small',
				embed: async (texts) => {
					asked.push([...texts]);
					return texts.map((text) => [text.length, 1]);
				},
			});
			kernel.ctx.llm.use({
				name: 'test',
				async chat(request) {
					seen = request.messages;
					return { message: { role: 'assistant' as const, content: 'ok' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'vectors');
			kernel.ctx.sessions.save(session);
			await kernel.ctx.agent.runTurn({ text: 'the salt flats are quiet today, they say', sessionId: 'vectors' });
			const hits = kernel.ctx.sessions.require('vectors').tavernActivated ?? [];
			assert.deepStrictEqual(
				hits.map((hit) => hit.reason).sort(),
				['key', 'vector'],
				'the keyed entry matched and the closest vectorized one was injected',
			);
			const said = seen.map((message) => message.content).join('\n');
			assert.ok(said.includes('The flats drink sound.'), 'the entry the search picked reached the prompt');
			assert.ok(!said.includes('A caravan went north.'), 'the one it did not pick is not there: one book contributes one entry');
			assert.ok(asked.length >= 1, 'the endpoint was asked for the query and the missing vectors');
			assert.strictEqual(asked[0]?.length, 3, 'the query and the two unindexed entries went in one call');
			// The second turn asks only for the query: the index is on disk now.
			asked.length = 0;
			await kernel.ctx.agent.runTurn({ text: 'and the caravan?', sessionId: 'vectors' });
			assert.strictEqual(asked[0]?.length, 1, 'the entries are embedded once, then read from the index');
		} finally {
			await kernel.dispose();
		}
	});

	test('a world-info entry fires only for the generation types it names', () => {
		const books = [
			loreBookOf([
				{ uid: 0, key: ['salt'], content: 'Always.', triggers: [] },
				{ uid: 1, key: ['salt'], content: 'On a swipe.', triggers: ['swipe'] },
				{ uid: 2, key: ['salt'], content: 'On a continue.', triggers: ['continue'] },
			]),
		];
		const activated = (trigger?: GenerationTrigger): string[] =>
			activateLore(lore({ books, trigger })).activated.map((hit) => hit.entry.content ?? '');
		// `normal` is what an ordinary prompt is, so an entry tied to another type stays out of it.
		assert.deepStrictEqual(activated(), ['Always.'], 'a plain turn is upstream’s normal generation');
		assert.deepStrictEqual(activated('normal'), ['Always.']);
		assert.deepStrictEqual(activated('swipe'), ['Always.', 'On a swipe.']);
		assert.deepStrictEqual(activated('continue'), ['Always.', 'On a continue.']);
		assert.deepStrictEqual(activated('regenerate'), ['Always.']);
		assert.deepStrictEqual(activated('quiet'), ['Always.']);
	});

	test('a continue extends one message, while a quiet turn and an impersonation write none', async () => {
		const kernel = await createTestKernel();
		try {
			const replies = ['first.', 'second.', 'yours.', 'unwritten.'];
			kernel.ctx.llm.use({
				name: 'test',
				async chat() {
					return { message: { role: 'assistant' as const, content: replies.shift() ?? 'x' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'types');
			kernel.ctx.sessions.save(session);
			await kernel.ctx.agent.runTurn({ text: 'tell me about the salt', sessionId: 'types' });
			const written = (): string[] => kernel.ctx.sessions.require('types').transcript.map((message) => `${message.role}:${message.content}`);
			assert.deepStrictEqual(written(), ['user:tell me about the salt', 'assistant:first.']);

			// Continue: no prompt of its own, and the text lands in the message it carries on.
			await kernel.ctx.agent.runTurn({ text: '', trigger: 'continue', sessionId: 'types' });
			assert.deepStrictEqual(written(), ['user:tell me about the salt', 'assistant:first. second.']);
			assert.strictEqual(kernel.ctx.sessions.require('types').transcript[1]?.continued, true);
			assert.deepStrictEqual(
				turnsOf(kernel.ctx.sessions.require('types').transcript).map((turn) => turn.continued),
				[true],
				'a continuation belongs to the turn it continues',
			);

			// Quiet: the reply comes back to the caller and the transcript is left exactly as it was.
			const before = kernel.ctx.sessions.require('types').transcript;
			const quiet = await kernel.ctx.agent.runTurn({ text: 'answer this privately', trigger: 'quiet', sessionId: 'types' });
			assert.strictEqual(quiet.text, 'yours.', 'a quiet generation still answers');
			assert.deepStrictEqual(kernel.ctx.sessions.require('types').transcript, before, 'and leaves no trace');

			// Impersonate: upstream streams your next message into the composer, so the chat keeps
			// exactly what it had and the text comes back to the caller to edit and send.
			const beforeImpersonation = kernel.ctx.sessions.require('types').transcript;
			const impersonated = await kernel.ctx.agent.runTurn({ text: '', trigger: 'impersonate', sessionId: 'types' });
			assert.strictEqual(impersonated.text, 'unwritten.', 'the text the model wrote for you comes back to the caller');
			assert.deepStrictEqual(kernel.ctx.sessions.require('types').transcript, beforeImpersonation, 'and the chat is left alone until you send it');
		} finally {
			await kernel.dispose();
		}
	});

	test('a continue grows only the last reply, and never cuts the transcript', async () => {
		const kernel = await createTestKernel();
		try {
			const replies = ['still here.'];
			kernel.ctx.llm.use({
				name: 'test',
				async chat() {
					return { message: { role: 'assistant' as const, content: replies.shift() ?? 'x' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const written = (id: string): string[] => kernel.ctx.sessions.require(id).transcript.map((message) => `${message.role}:${message.content}`);

			// A turn waiting on a tool call has no reply of its own. Merging the continuation into an
			// *older* reply would slice away everything the turn did leave behind.
			const cut = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'cut');
			cut.transcript = [
				{ role: 'user', content: 'the first thing' },
				{ role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
			];
			kernel.ctx.sessions.save(cut);
			await kernel.ctx.agent.runTurn({ text: '', trigger: 'continue', sessionId: 'cut' });
			assert.deepStrictEqual(written('cut'), ['user:the first thing', 'assistant:', 'assistant:still here.'], 'the answer is a turn of its own');

			// A chat that has said nothing has nothing to carry on: a reply with no prompt to hang on
			// is a reply no view can draw.
			const empty = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'empty');
			kernel.ctx.sessions.save(empty);
			const refused = await kernel.ctx.agent.runTurn({ text: '', trigger: 'continue', sessionId: 'empty' });
			assert.strictEqual(refused.text, 'There is nothing to continue yet.');
			assert.deepStrictEqual(written('empty'), [], 'and nothing was written');
		} finally {
			await kernel.dispose();
		}
	});

	test('a swipe switches the turn the nav belongs to, not whatever replied last', async () => {
		const kernel = await createTestKernel();
		try {
			const replies = ['one.', 'two.', 'later.'];
			kernel.ctx.llm.use({
				name: 'test',
				async chat() {
					return { message: { role: 'assistant' as const, content: replies.shift() ?? 'x' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'nav');
			kernel.ctx.sessions.save(session);
			await kernel.ctx.agent.runTurn({ text: 'the first question', sessionId: 'nav' });
			await kernel.ctx.agent.runTurn({ text: '', trigger: 'swipe', sessionId: 'nav' });
			await kernel.ctx.agent.runTurn({ text: 'a second question', sessionId: 'nav' });

			const transcript = (): Message[] => kernel.ctx.sessions.require('nav').transcript;
			const first = turnsOf(transcript())[0]!;
			assert.deepStrictEqual(first.swipes, ['one.', 'two.'], 'the nav is drawn on the turn that carries the versions');
			assert.strictEqual(kernel.ctx.sessions.setSwipe('nav', 0, first.index), true);
			assert.strictEqual(transcript()[1]!.content, 'one.', 'the reply with the versions is the one the nav moves');
			assert.strictEqual(transcript()[transcript().length - 1]!.content, 'later.', 'and the last reply is left alone');
			assert.strictEqual(kernel.ctx.sessions.setSwipe('nav', 7, first.index), false, 'there is no eighth version of that reply');
			assert.strictEqual(transcript()[1]!.content, 'one.', 'a refused switch writes nothing');
		} finally {
			await kernel.dispose();
		}
	});

	test('a swipe keeps every version of a reply, and the first one is the only one replaced', async () => {
		const kernel = await createTestKernel();
		try {
			const replies = ['one.', 'two.', 'three.', 'again.', 'again again.'];
			kernel.ctx.llm.use({
				name: 'test',
				async chat() {
					return { message: { role: 'assistant' as const, content: replies.shift() ?? 'x' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			const session = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'swipes');
			kernel.ctx.sessions.save(session);
			await kernel.ctx.agent.runTurn({ text: 'hello there', sessionId: 'swipes' });
			assert.deepStrictEqual(kernel.ctx.sessions.swipeCarry('swipes')?.swipes, ['one.'], 'the first reply is the only version so far');

			await kernel.ctx.agent.runTurn({ text: '', trigger: 'swipe', sessionId: 'swipes' });
			const reply = (id: string): Message => {
				const transcript = kernel.ctx.sessions.require(id).transcript;
				return transcript[transcript.length - 1]!;
			};
			assert.deepStrictEqual(reply('swipes').swipes, ['one.', 'two.'], 'a swipe grows the list instead of replacing it');
			assert.strictEqual(reply('swipes').swipeId, 1);
			assert.strictEqual(reply('swipes').content, 'two.', 'and the version it generated is the one showing');
			assert.strictEqual(reply('swipes').swipeInfo?.length, 2, 'upstream keeps one record per version');
			assert.strictEqual(
				kernel.ctx.sessions.require('swipes').transcript.filter((message) => message.role === 'user').length,
				1,
				'the prompt was not written down twice',
			);
			assert.deepStrictEqual(
				turnsOf(kernel.ctx.sessions.require('swipes').transcript).slice(-1)[0]?.swipes,
				['one.', 'two.'],
				'the turn carries the versions, which is what the panel walks',
			);

			assert.strictEqual(kernel.ctx.sessions.setSwipe('swipes', 0), true);
			assert.strictEqual(reply('swipes').content, 'one.', 'going back shows the version that was there first');
			assert.strictEqual(kernel.ctx.sessions.setSwipe('swipes', 7), false, 'there is no eighth version');

			await kernel.ctx.agent.runTurn({ text: '', trigger: 'regenerate', sessionId: 'swipes' });
			assert.deepStrictEqual(reply('swipes').swipes, ['one.', 'two.', 'three.'], 'a regenerate on a reply with versions adds one');
			assert.strictEqual(kernel.ctx.sessions.require('swipes').transcript.filter((message) => message.role === 'user').length, 1);

			// The very first regenerate has nothing to keep, so it replaces the reply it was given.
			const fresh = kernel.ctx.sessions.create(kernel.ctx.agent.policyFor(), 'fresh');
			kernel.ctx.sessions.save(fresh);
			await kernel.ctx.agent.runTurn({ text: 'hello again', sessionId: 'fresh' });
			await kernel.ctx.agent.runTurn({ text: '', trigger: 'regenerate', sessionId: 'fresh' });
			assert.deepStrictEqual(reply('fresh').swipes, ['again again.'], 'one version, replaced');
			assert.strictEqual(reply('fresh').swipeId, 0);
		} finally {
			await kernel.dispose();
		}
	});
});
/**
 * The per-file journal against a real shadow repository on a temporary disk. These tests cover
 * what the review relies on: nothing outside the journal is touched, unsaved text and outside
 * edits refuse before any write, and rewinds restore exactly the files written after a point.
 */

interface Harness {
	ctx: Context;
	root: string;
	work: string;
	checkpoints: Checkpoints;
	dispose(): void;
}

async function harness(): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), 'comonad-journal-'));
	const work = join(root, 'ws');
	mkdirSync(work, { recursive: true });
	const host = {
		storage: hostStorage(join(root, 'storage')),
		extensionUri: undefined,
		home: () => root,
		workspace: () => work,
		trusted: () => true,
		config: () => ({}),
		update: async () => undefined,
		secret: async () => undefined,
		setSecret: async () => undefined,
		env: () => undefined,
		ask: async () => [],
		notify: () => undefined,
	} as unknown as Host;
	const ctx = new Context();
	ctx.provide('host', host);
	const fiber = ctx.plugin(
		function journal(child: Context) {
			child.plugin(Checkpoints);
		},
	);
	await fiber;
	const checkpoints = ctx.checkpoints;
	return {
		ctx,
		root,
		work,
		checkpoints,
		dispose() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Writes a file the way the agent's tools do: journal the before, write, journal the after. */
async function agentWrite(h: Harness, sessionId: string, turn: number, rel: string, content: string | null): Promise<void> {
	const before = await h.checkpoints.store(h.work, sessionId, rel);
	if (content === null) {
		rmSync(join(h.work, rel), { force: true });
	} else {
		mkdirSync(join(h.work, rel, '..'), { recursive: true });
		writeFileSync(join(h.work, rel), content);
	}
	const after = await h.checkpoints.store(h.work, sessionId, rel);
	await h.checkpoints.record(h.work, sessionId, turn, rel, before, after);
}

suite('Per-file checkpoints', () => {
	test('a file the agent wrote shows up as pending, with its own diff, and nothing else', async () => {
		const h = await harness();
		try {
			writeFileSync(join(h.work, 'untouched.txt'), 'the user wrote this\n');
			writeFileSync(join(h.work, 'a.txt'), 'one\n');
			await agentWrite(h, 's', 1, 'a.txt', 'one\ntwo\n');
			const pending = await h.checkpoints.pending(h.work, 's');
			assert.strictEqual(pending.available, true);
			assert.deepStrictEqual(
				pending.files.map((file) => file.path),
				['a.txt'],
				'only the journaled path is reviewed',
			);
			assert.strictEqual(pending.files[0]!.additions, 1);
			assert.strictEqual(pending.files[0]!.deletions, 0);
			assert.strictEqual(pending.files[0]!.created, false);
		} finally {
			h.dispose();
		}
	});

	test('a file created by the agent is pending as new, and undo deletes it', async () => {
		const h = await harness();
		try {
			await agentWrite(h, 's', 1, 'fresh.txt', 'hello\n');
			const [file] = (await h.checkpoints.pending(h.work, 's')).files;
			assert.strictEqual(file?.created, true);
			await h.checkpoints.undo(h.work, 's', ['fresh.txt']);
			assert.strictEqual(existsSync(join(h.work, 'fresh.txt')), false, 'the agent-made file is gone');
		} finally {
			h.dispose();
		}
	});

	test('keep makes the current content the baseline, and the file leaves the pending list', async () => {
		const h = await harness();
		try {
			writeFileSync(join(h.work, 'a.txt'), 'one\n');
			await agentWrite(h, 's', 1, 'a.txt', 'one\ntwo\n');
			await h.checkpoints.keep(h.work, 's', ['a.txt']);
			assert.strictEqual((await h.checkpoints.pending(h.work, 's')).files.length, 0);
			// A later write by the agent is pending again, against the accepted baseline.
			await agentWrite(h, 's', 2, 'a.txt', 'one\ntwo\nthree\n');
			const [again] = (await h.checkpoints.pending(h.work, 's')).files;
			assert.strictEqual(again?.additions, 1, 'only the write after the accept is pending');
		} finally {
			h.dispose();
		}
	});

	test('undo restores the content from before the agent first wrote the file', async () => {
		const h = await harness();
		try {
			writeFileSync(join(h.work, 'a.txt'), 'original\n');
			await agentWrite(h, 's', 1, 'a.txt', 'first\n');
			await agentWrite(h, 's', 1, 'a.txt', 'second\n');
			await h.checkpoints.undo(h.work, 's', ['a.txt']);
			assert.strictEqual(readFileSync(join(h.work, 'a.txt'), 'utf8'), 'original\n', 'back to before the first write of the turn');
		} finally {
			h.dispose();
		}
	});

	test('undo refuses, writing nothing, when the disk changed since the agent last wrote', async () => {
		const h = await harness();
		try {
			writeFileSync(join(h.work, 'a.txt'), 'original\n');
			await agentWrite(h, 's', 1, 'a.txt', 'agent\n');
			writeFileSync(join(h.work, 'a.txt'), 'the user edited this\n');
			await assert.rejects(
				h.checkpoints.undo(h.work, 's', ['a.txt']),
				(error: unknown) => error instanceof ChangedOutsideError && error.paths[0] === 'a.txt',
			);
			assert.strictEqual(readFileSync(join(h.work, 'a.txt'), 'utf8'), 'the user edited this\n', 'the user edit survives the refusal');
			await h.checkpoints.undo(h.work, 's', ['a.txt'], { overwrite: 'all' });
			assert.strictEqual(readFileSync(join(h.work, 'a.txt'), 'utf8'), 'original\n', 'an explicit overwrite restores it');
		} finally {
			h.dispose();
		}
	});

	test('undo refuses an unsaved editor document, and writes nothing', async () => {
		const h = await harness();
		try {
			writeFileSync(join(h.work, 'a.txt'), 'original\n');
			await agentWrite(h, 's', 1, 'a.txt', 'agent\n');
			await assert.rejects(
				h.checkpoints.undo(h.work, 's', ['a.txt'], { isDirty: (path) => path === 'a.txt' }),
				(error: unknown) => error instanceof DirtyEditorError,
			);
			assert.strictEqual(readFileSync(join(h.work, 'a.txt'), 'utf8'), 'agent\n', 'the file was not touched');
		} finally {
			h.dispose();
		}
	});

	test('a rewind restores exactly the files written after its point, and keeps earlier ones', async () => {
		const h = await harness();
		try {
			writeFileSync(join(h.work, 'a.txt'), 'a0\n');
			writeFileSync(join(h.work, 'b.txt'), 'b0\n');
			await agentWrite(h, 's', 1, 'a.txt', 'a1\n');
			const mark = { entryCount: (await h.checkpoints.entries(h.work, 's')).length };
			await agentWrite(h, 's', 2, 'a.txt', 'a2\n');
			await agentWrite(h, 's', 2, 'b.txt', 'b2\n');
			const report = await h.checkpoints.revert(h.work, 's', mark);
			assert.deepStrictEqual(report.restored.sort(), ['a.txt', 'b.txt']);
			assert.strictEqual(readFileSync(join(h.work, 'a.txt'), 'utf8'), 'a1\n', 'a goes back to the point, not to the start');
			assert.strictEqual(readFileSync(join(h.work, 'b.txt'), 'utf8'), 'b0\n', 'b goes back to its content before turn 2');
		} finally {
			h.dispose();
		}
	});

	test('a rewind refuses as one unit when any file would be overwritten, and writes none', async () => {
		const h = await harness();
		try {
			writeFileSync(join(h.work, 'a.txt'), 'a0\n');
			writeFileSync(join(h.work, 'b.txt'), 'b0\n');
			const mark = { entryCount: 0 };
			await agentWrite(h, 's', 1, 'a.txt', 'a1\n');
			await agentWrite(h, 's', 1, 'b.txt', 'b1\n');
			writeFileSync(join(h.work, 'b.txt'), 'the user edited b\n');
			await assert.rejects(h.checkpoints.revert(h.work, 's', mark), ChangedOutsideError);
			assert.strictEqual(readFileSync(join(h.work, 'a.txt'), 'utf8'), 'a1\n', 'a was not rewound either');
		} finally {
			h.dispose();
		}
	});

	test('a rewind can skip one file and keep its later entries', async () => {
		const h = await harness();
		try {
			writeFileSync(join(h.work, 'a.txt'), 'a0\n');
			writeFileSync(join(h.work, 'b.txt'), 'b0\n');
			const mark = { entryCount: 0 };
			await agentWrite(h, 's', 1, 'a.txt', 'a1\n');
			await agentWrite(h, 's', 1, 'b.txt', 'b1\n');
			writeFileSync(join(h.work, 'b.txt'), 'the user edited b\n');
			const report = await h.checkpoints.revert(h.work, 's', mark, { skip: ['b.txt'] });
			assert.deepStrictEqual(report.restored, ['a.txt']);
			assert.strictEqual(readFileSync(join(h.work, 'b.txt'), 'utf8'), 'the user edited b\n', 'the skipped file keeps the user edit');
			assert.strictEqual((await h.checkpoints.pending(h.work, 's')).files.map((file) => file.path).join(','), 'b.txt', 'and it stays pending');
		} finally {
			h.dispose();
		}
	});

	test('a rewind refuses an unsaved document before anything is written', async () => {
		const h = await harness();
		try {
			writeFileSync(join(h.work, 'a.txt'), 'a0\n');
			const mark = { entryCount: 0 };
			await agentWrite(h, 's', 1, 'a.txt', 'a1\n');
			await assert.rejects(h.checkpoints.revert(h.work, 's', mark, { isDirty: () => true }), DirtyEditorError);
			assert.strictEqual(readFileSync(join(h.work, 'a.txt'), 'utf8'), 'a1\n');
		} finally {
			h.dispose();
		}
	});

	test('the review diff comes from one pass: created, changed and deleted files in a single listing', async () => {
		const h = await harness();
		try {
			writeFileSync(join(h.work, 'changed.txt'), 'old\n');
			writeFileSync(join(h.work, 'gone.txt'), 'bye\n');
			await agentWrite(h, 's', 1, 'changed.txt', 'new\n');
			await agentWrite(h, 's', 1, 'made.txt', 'made\n');
			await agentWrite(h, 's', 1, 'gone.txt', null);
			const files = (await h.checkpoints.pending(h.work, 's')).files;
			const byPath = new Map(files.map((file) => [file.path, file]));
			assert.strictEqual(byPath.get('changed.txt')?.deletions, 1);
			assert.strictEqual(byPath.get('made.txt')?.created, true);
			assert.strictEqual(byPath.get('gone.txt')?.deleted, true);
			assert.strictEqual(files.length, 3);
		} finally {
			h.dispose();
		}
	});

	test('the journal is append-only: no entry is ever dropped by a keep', async () => {
		const h = await harness();
		try {
			writeFileSync(join(h.work, 'a.txt'), 'a0\n');
			await agentWrite(h, 's', 1, 'a.txt', 'a1\n');
			await h.checkpoints.keep(h.work, 's', ['a.txt']);
			await agentWrite(h, 's', 2, 'a.txt', 'a2\n');
			assert.strictEqual((await h.checkpoints.entries(h.work, 's')).length, 2, 'both writes stay recorded');
		} finally {
			h.dispose();
		}
	});

	test('a subagent cannot write: its write tools are not offered, and a forced write is refused', async () => {
		const kernel = await createTestKernel({ config: { checkpoints: true } });
		try {
			const workspace = kernel.host.workspace();
			writeFileSync(join(workspace, 'guarded.txt'), 'original\n');
			let subagentOffered: string[] = [];
			let subagentResult = '';
			let subagentRuns = 0;
			kernel.ctx.llm.use({
				name: 'delegator',
				async chat(request) {
					const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
					// The subagent is told it is a subagent; it tries to write anyway, and reports what came back.
					if (system.includes('subagent of Comonad')) {
						subagentRuns += 1;
						subagentOffered = (request.tools ?? []).map((tool) => tool.name);
						const last = [...request.messages].reverse().find((message) => message.role === 'tool');
						if (!last) {
							const toolCall: ToolCall = { id: 'forced', name: 'write_file', arguments: JSON.stringify({ path: 'guarded.txt', content: 'hacked\n' }) };
							return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, toolCalls: [toolCall], usage: { input: 1, output: 1 } };
						}
						subagentResult = last.content;
						return { message: { role: 'assistant', content: 'report' }, toolCalls: [], usage: { input: 1, output: 1 } };
					}
					// The parent delegates once, then reports.
					const last = request.messages[request.messages.length - 1];
					if (last?.role === 'user') {
						const toolCall: ToolCall = { id: 'delegate', name: 'agent', arguments: JSON.stringify({ prompt: 'try to write', description: 'write' }) };
						return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, toolCalls: [toolCall], usage: { input: 1, output: 1 } };
					}
					return { message: { role: 'assistant', content: 'done' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			await kernel.ctx.plugin(fsTools);
			await kernel.ctx.plugin(agentTools);
			await kernel.ctx.agent.runTurn({ text: 'delegate it', surface: 'test' });

			// Without this the next assertions could pass vacuously: the subagent must actually have run.
			assert.ok(subagentRuns > 0, `the subagent ran (${subagentRuns} times)`);
			assert.ok(subagentOffered.length > 0, 'the subagent was offered at least one tool');
			assert.ok(!subagentOffered.includes('write_file'), `write_file is not offered to a subagent: ${subagentOffered.join(', ')}`);
			assert.ok(!subagentOffered.includes('apply_patch'), 'apply_patch is not offered either');
			assert.ok(/not available to this subagent/.test(subagentResult), `a forced write is refused: ${subagentResult}`);
			assert.strictEqual(readFileSync(join(workspace, 'guarded.txt'), 'utf8'), 'original\n', 'the file was not written');
		} finally {
			await kernel.dispose();
		}
	});

	test('the journal is a feature plugin: without it, a write is just a write', async () => {
		const kernel = await createTestKernel({ config: { checkpoints: true }, skip: ['checkpoints'] });
		try {
			assert.strictEqual(kernel.ctx.get('checkpoints'), undefined, 'the row is off, so nothing provides the journal');
			const workspace = kernel.host.workspace();
			kernel.ctx.llm.use({
				name: 'writer',
				async chat(request) {
					const last = request.messages[request.messages.length - 1];
					if (last?.role === 'user') {
						const toolCall: ToolCall = { id: `w${request.messages.length}`, name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'written\n' }) };
						return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, toolCalls: [toolCall], usage: { input: 1, output: 1 } };
					}
					return { message: { role: 'assistant', content: 'done' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			await kernel.ctx.plugin(fsTools);
			await kernel.ctx.agent.runTurn({ text: 'write it', surface: 'test' });
			assert.strictEqual(readFileSync(join(workspace, 'note.txt'), 'utf8'), 'written\n', 'the write itself is unaffected');
			assert.deepStrictEqual(kernel.ctx.sessions.require(kernel.ctx.sessions.active()?.id ?? '').marks, [], 'and nothing is journaled');
		} finally {
			await kernel.dispose();
		}
	});

	test('the tool pipeline is the harness pipeline: a plugin refuses, wraps, reshapes and observes', async () => {
		const kernel = await createTestKernel();
		try {
			const workspace = kernel.host.workspace();
			writeFileSync(join(workspace, 'guarded.txt'), 'original\n');
			// Written the way the harness cookbook writes a policy plugin.
			kernel.ctx.on('tools/pre-execute', (exec, next) => {
				const path = (exec.arguments as { path?: string }).path ?? '';
				return exec.name === 'write_file' && path.includes('guarded') ? { kind: 'deny', reason: 'guarded.txt is under policy' } : next();
			});
			// A wrapper around dispatch: what a timeout or a metrics plugin does.
			const wrapped: string[] = [];
			kernel.ctx.on('tools/execute', async (exec, next) => {
				wrapped.push(exec.name);
				return next();
			});
			// A result shaper, and an observer that must see refusals too.
			kernel.ctx.on('tools/post-execute', (exec, result, next) => (exec.name === 'read_file' ? { kind: 'accept', content: [{ text: `reshaped: ${result.content.length} chars` }] } : next()));
			const observed: string[] = [];
			kernel.ctx.on('tools/result', (exec, result) => observed.push(`${exec.name}:${result.isError}:${result.content.split('\n')[0] ?? ''}`));
			// The tool definitions themselves came from the harness shape, not Comonad's.
			kernel.ctx.tools.register({
				name: 'echo',
				description: 'Echo a value back.',
				parameters: { type: 'object', properties: { value: { type: 'string' } } },
				output: { schema: { type: 'string' } },
				execute: (args) => ({ echoed: (args as { value?: string }).value ?? '' }),
			});
			let told = '';
			kernel.ctx.llm.use({
				name: 'caller',
				async chat(request) {
					const last = request.messages[request.messages.length - 1];
					if (last?.role === 'tool') {
						told = last.content;
						return { message: { role: 'assistant', content: 'done' }, toolCalls: [], usage: { input: 1, output: 1 } };
					}
					const asked = request.messages.filter((message) => message.role === 'user').length;
					const call: ToolCall =
						asked === 1
							? { id: 'w', name: 'write_file', arguments: JSON.stringify({ path: 'guarded.txt', content: 'hacked\n' }) }
							: asked === 2
								? { id: 'r', name: 'read_file', arguments: JSON.stringify({ path: 'guarded.txt' }) }
								: { id: 'e', name: 'echo', arguments: JSON.stringify({ value: 'hi' }) };
					return { message: { role: 'assistant', content: '', toolCalls: [call] }, toolCalls: [call], usage: { input: 1, output: 1 } };
				},
			});
			await kernel.ctx.plugin(fsTools);
			await kernel.ctx.agent.runTurn({ text: 'write it', surface: 'test' });
			assert.strictEqual(readFileSync(join(workspace, 'guarded.txt'), 'utf8'), 'original\n', 'the refused write never ran');
			assert.ok(/under policy/.test(told), `the model reads the reason: ${told}`);

			await kernel.ctx.agent.runTurn({ text: 'read it', surface: 'test' });
			assert.ok(/^reshaped: \d+ chars$/.test(told), `post-execute replaced what the model sees: ${told}`);

			await kernel.ctx.agent.runTurn({ text: 'echo it', surface: 'test' });
			assert.ok(/echoed/.test(told), `a harness-shaped tool answers as JSON text: ${told}`);

			assert.deepStrictEqual(wrapped, ['read_file', 'echo'], 'the wrapper saw exactly the calls that were dispatched');
			assert.strictEqual(observed[0], 'write_file:true:Error: guarded.txt is under policy', 'a refusal is observed, not hidden');
			assert.deepStrictEqual(
				observed.map((line) => line.split(':').slice(0, 2).join(':')),
				['write_file:true', 'read_file:false', 'echo:false'],
				'every settled call is observed once',
			);
		} finally {
			await kernel.dispose();
		}
	});

	test('the agent journals its own writes: one rewind point per turn, cut at the prompt', async () => {
		const kernel = await createTestKernel({ config: { checkpoints: true } });
		try {
			const workspace = kernel.host.workspace();
			writeFileSync(join(workspace, 'note.txt'), 'start\n');
			kernel.ctx.llm.use({
				name: 'writer',
				async chat(request) {
					const last = request.messages[request.messages.length - 1];
					// A fresh user prompt asks for a write; once the tool has answered, the model stops.
					if (last?.role === 'user') {
						const toolCall: ToolCall = { id: `w${request.messages.length}`, name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: `${last.content}\n` }) };
						return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, toolCalls: [toolCall], usage: { input: 1, output: 1 } };
					}
					return { message: { role: 'assistant', content: 'done' }, toolCalls: [], usage: { input: 1, output: 1 } };
				},
			});
			await kernel.ctx.plugin(fsTools);
			const first = await kernel.ctx.agent.runTurn({ text: 'one', surface: 'test' });
			const second = await kernel.ctx.agent.runTurn({ text: 'two', surface: 'test' });

			const id = first.sessionId;
			const session = kernel.ctx.sessions.require(id);
			// Diagnostic: what the agent actually did, so a missing mark is explained, not guessed at.
			assert.strictEqual(session.marks.length, 2, 'each turn that wrote a file has a rewind point');
			assert.strictEqual(session.marks[0]!.length, 0, 'turn one cuts to an empty transcript: its prompt is the first message');
			// Turn one is user, assistant, tool, assistant (four messages); turn two's prompt is the fifth.
			// Cutting at the prompt keeps all four and drops turn two.
			assert.strictEqual(session.marks[1]!.length, 4, 'turn two cuts before its own prompt, keeping all of turn one');
			assert.strictEqual(session.marks[0]!.entryCount, 0, 'no journal entry existed before turn one');
			assert.strictEqual(session.marks[1]!.entryCount, 1, 'turn two starts after turn one’s single entry');

			const pending = await kernel.ctx.checkpoints.pending(workspace, id);
			assert.deepStrictEqual(pending.files.map((file) => file.path), ['note.txt'], 'the agent’s writes are pending');
			assert.strictEqual(pending.files[0]!.created, false, 'note.txt existed before the agent');

			// Rewinding to turn two restores what the file was before turn two's write.
			await kernel.ctx.checkpoints.revert(workspace, id, { entryCount: session.marks[1]!.entryCount });
			assert.strictEqual(readFileSync(join(workspace, 'note.txt'), 'utf8'), 'one\n', 'the file is back to its content before turn two');
		} finally {
			await kernel.dispose();
		}
	});

	test('diff parsing counts additions and deletions per path, from one multi-file diff', () => {
		const text = [
			'diff --git a/x.txt b/x.txt',
			'--- a/x.txt',
			'+++ b/x.txt',
			'@@ -1 +1 @@',
			'-old',
			'+new',
			'diff --git a/y.txt b/y.txt',
			'--- a/y.txt',
			'+++ b/y.txt',
			'@@ -0,0 +1 @@',
			'+added',
			'',
		].join('\n');
		const parsed = parseDiffs(text);
		assert.strictEqual(parsed.get('x.txt')?.additions, 1);
		assert.strictEqual(parsed.get('x.txt')?.deletions, 1);
		assert.strictEqual(parsed.get('y.txt')?.additions, 1);
		assert.strictEqual(parsed.get('y.txt')?.deletions, 0);
	});
});
