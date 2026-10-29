// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateCall, parseRules } from '../lib/policy';
import { policyRevision, policySnapshot, type PolicySnapshot } from '../lib/trace';
import type { Completion } from '../lib/openai';
import { objectSchema, type Message, type SessionPolicy, type ToolCall, type ToolSpec } from '../lib/types';
import { auditText } from '../ui/slash';
import { createTestKernel } from './harness';

const readTool: ToolSpec = {
	name: 'probe_read',
	description: '',
	parameters: objectSchema({}),
	capability: 'ro',
	needsNetwork: false,
	needsWorkspace: false,
	execute: async () => 'read',
};

const writeTool: ToolSpec = { ...readTool, name: 'probe_write', capability: 'rw' };
const networkTool: ToolSpec = { ...readTool, name: 'probe_network', needsNetwork: true };

const tools = new Map([readTool, writeTool, networkTool].map((tool) => [tool.name, tool]));
const lookup = (name: string): ToolSpec | undefined => tools.get(name);
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: name, name, arguments: JSON.stringify(args) });

const policy = (patch: Partial<SessionPolicy> = {}): SessionPolicy => ({
	workMode: 'aw',
	approval: 'manual',
	approvalResponse: 'ask',
	network: false,
	sandboxMode: 'workspace-write',
	workingDirectory: '/tmp/workspace',
	commandTimeout: 60,
	commandTimeoutOverride: false,
	denyReadPaths: [],
	model: 'auto',
	...patch,
});

const rules = (patch: Partial<ReturnType<typeof parseRules>> = {}) => ({ allow: [], ask: [], deny: [], ...patch });

suite('Policy revision', () => {
	test('a revision is stable for the same facts and changes with each policy field', () => {
		const base = policySnapshot(policy(), parseRules({}));
		assert.strictEqual(policyRevision(base), policyRevision(policySnapshot(policy(), parseRules({}))));
		const changed: PolicySnapshot[] = [
			policySnapshot(policy({ workMode: 'sw' }), parseRules({})),
			policySnapshot(policy({ approval: 'universal_accept' }), parseRules({})),
			policySnapshot(policy({ approvalResponse: 'never' }), parseRules({})),
			policySnapshot(policy({ network: true }), parseRules({})),
			policySnapshot(policy({ sandboxMode: 'read-only' }), parseRules({})),
			policySnapshot(policy(), parseRules({ deny: ['probe_read'] })),
			policySnapshot(policy({ denyReadPaths: ['.env'] }), parseRules({})),
		];
		for (const snapshot of changed) {
			assert.notStrictEqual(policyRevision(snapshot), policyRevision(base));
		}
		// Rule order is part of the effective policy and therefore part of its identity.
		assert.notStrictEqual(
			policyRevision(policySnapshot(policy(), parseRules({ allow: ['a', 'b'] }))),
			policyRevision(policySnapshot(policy(), parseRules({ allow: ['b', 'a'] }))),
		);
	});
});

suite('Policy steps', () => {
	const gate = (name: string, patch: Partial<SessionPolicy> = {}, ruleSet = rules()) => {
		const probe = call(name);
		return gateCall(probe, lookup(name), policy(patch), ruleSet, { sandbox: 'bwrap' });
	};

	test('a capability denial is the only step', () => {
		const result = gate('probe_write', { workMode: 'ro' });
		assert.strictEqual(result.decision, 'reject');
		assert.deepStrictEqual(
			result.steps.map((step) => [step.layer, step.decision, step.matchedRule]),
			[['capability', 'deny', 'rw']],
		);
	});

	test('network is recorded as no_match when a tool does not use it', () => {
		const result = gate('probe_read', { approval: 'universal_accept' });
		assert.deepStrictEqual(
			result.steps.map((step) => [step.layer, step.decision]),
			[
				['capability', 'allow'],
				['network', 'no_match'],
				['rules', 'no_match'],
				['approval', 'allow'],
			],
		);
	});

	test('an ask rule ends the chain before the approval policy', () => {
		const result = gate('probe_read', { approval: 'universal_accept' }, parseRules({ ask: ['probe_read'] }));
		assert.strictEqual(result.decision, 'confirm');
		assert.deepStrictEqual(
			result.steps.map((step) => [step.layer, step.decision, step.matchedRule]),
			[
				['capability', 'allow', 'ro'],
				['network', 'no_match', ''],
				['rules', 'ask', 'probe_read'],
			],
		);
	});

	test('an allow rule skips the approval policy', () => {
		const result = gate('probe_read', {}, parseRules({ allow: ['probe_read'] }));
		assert.strictEqual(result.decision, 'allow');
		assert.deepStrictEqual(
			result.steps.map((step) => step.layer),
			['capability', 'network', 'rules'],
		);
	});

	test('a network denial names the network layer after capability', () => {
		const result = gate('probe_network');
		assert.strictEqual(result.decision, 'reject');
		assert.deepStrictEqual(
			result.steps.map((step) => [step.layer, step.decision, step.matchedRule]),
			[
				['capability', 'allow', 'ro'],
				['network', 'deny', 'off'],
			],
		);
	});
});

suite('Decision trace service', () => {
	const context = (callId = 'call_0') => ({ sessionId: 'session-1', turn: 2, providerCallId: callId, toolName: 'probe_read' });

	test('nodes link through parent_id and the terminal names the head', async () => {
		const kernel = await createTestKernel();
		try {
			const snapshot = policySnapshot(policy({ approval: 'universal_accept' }), parseRules({}));
			let trace = kernel.ctx.decisions.begin(context(), [
				{ layer: 'capability', decision: 'allow', matchedRule: 'ro', reason: 'granted' },
				{ layer: 'network', decision: 'no_match', matchedRule: '', reason: 'not used' },
			], snapshot);
			trace = kernel.ctx.decisions.extend(trace, {
				layer: 'sandbox',
				decision: 'allow',
				matchedRule: 'workspace-write',
				reason: 'dispatch',
			});
			kernel.ctx.decisions.terminal(trace, 'dispatch_started');
			const view = kernel.ctx.decisions.reconstruct(trace.callId);
			assert.ok(view);
			assert.strictEqual(view.nodes.length, 3);
			assert.deepStrictEqual(view.nodes.map((node) => node.layer), ['capability', 'network', 'sandbox']);
			assert.strictEqual(view.nodes[0]!.parent_id, null);
			assert.strictEqual(view.nodes[1]!.parent_id, view.nodes[0]!.node_id);
			assert.strictEqual(view.nodes[2]!.parent_id, view.nodes[1]!.node_id);
			assert.strictEqual(view.terminal?.event, 'dispatch_started');
			assert.strictEqual(view.terminal?.trace_head_id, view.nodes[2]!.node_id);
			assert.strictEqual(view.context?.providerCallId, 'call_0');
			assert.strictEqual(view.policy?.sandboxMode, 'workspace-write');
			// A second terminal never overwrites the first.
			kernel.ctx.decisions.terminal(trace, 'denied', 'late');
			assert.strictEqual(kernel.ctx.decisions.reconstruct(trace.callId)?.terminal?.event, 'dispatch_started');
		} finally {
			await kernel.dispose();
		}
	});

	test('one policy snapshot is written per revision, and a damaged line is skipped', async () => {
		const kernel = await createTestKernel();
		try {
			const snapshot = policySnapshot(policy(), parseRules({}));
			const steps = [{ layer: 'capability' as const, decision: 'allow' as const, matchedRule: 'ro', reason: 'ok' }];
			const first = kernel.ctx.decisions.begin(context('one'), steps, snapshot);
			const second = kernel.ctx.decisions.begin(context('two'), steps, snapshot);
			const file = join(kernel.host.storage.audit, 'decisions', `${first.day}.jsonl`);
			assert.strictEqual((readFileSync(file, 'utf8').match(/"kind":"policy"/g) ?? []).length, 1);
			appendFileSync(file, '{not json}\n');
			assert.ok(kernel.ctx.decisions.reconstruct(first.callId));
			assert.ok(kernel.ctx.decisions.reconstruct(second.callId));
			assert.strictEqual(kernel.ctx.decisions.reconstruct('missing'), undefined);
			assert.strictEqual(kernel.ctx.decisions.policyOf(first.revision)?.approval, 'manual');
		} finally {
			await kernel.dispose();
		}
	});

	test('recent lists the newest terminals and an incomplete chain has no terminal', async () => {
		const kernel = await createTestKernel();
		try {
			const snapshot = policySnapshot(policy(), parseRules({}));
			const steps = [{ layer: 'capability' as const, decision: 'allow' as const, matchedRule: 'ro', reason: 'ok' }];
			const first = kernel.ctx.decisions.begin(context('one'), steps, snapshot);
			kernel.ctx.decisions.terminal(first, 'denied', 'policy');
			await new Promise((resolve) => setTimeout(resolve, 2));
			const second = kernel.ctx.decisions.begin(context('two'), steps, snapshot);
			kernel.ctx.decisions.terminal(second, 'dispatch_started');
			const recent = kernel.ctx.decisions.recent(1);
			assert.strictEqual(recent.length, 1);
			assert.strictEqual(recent[0]!.call_id, second.callId);
			const pending = kernel.ctx.decisions.begin(context('three'), steps, snapshot);
			const view = kernel.ctx.decisions.reconstruct(pending.callId);
			assert.ok(view);
			assert.strictEqual(view.terminal, undefined);
			assert.strictEqual(view.nodes.length, 1);
		} finally {
			await kernel.dispose();
		}
	});
});

suite('Decision trace in a turn', () => {
	const answer =
		(calls: ToolCall[] | null) =>
		async (request: { messages: Message[] }): Promise<Completion> => {
			const hasTool = request.messages.some((message) => message.role === 'tool');
			if (!hasTool && calls) {
				return { message: { role: 'assistant', content: 'working', toolCalls: calls }, toolCalls: calls };
			}
			return { message: { role: 'assistant', content: 'done' }, toolCalls: [] };
		};

	const probe = (name = 'probe_read', capability: 'ro' | 'rw' = 'ro'): ToolSpec => ({
		name,
		description: '',
		parameters: objectSchema({}),
		capability,
		needsNetwork: false,
		needsWorkspace: false,
		execute: async () => 'ran',
	});

	test('an allowed call has capability, network, rules, approval and sandbox before dispatch', async () => {
		const kernel = await createTestKernel({ config: { approval: 'universal_accept', mode: 'aw' } });
		try {
			kernel.ctx.tools.register(probe());
			kernel.ctx.llm.use({ name: 'test', chat: answer([call('probe_read')]) });
			await kernel.ctx.agent.runTurn({ text: 'go', surface: 'test' });
			const event = kernel.ctx.decisions.recent(10).find((entry) => entry.tool_name === 'probe_read');
			assert.ok(event);
			assert.strictEqual(event.event, 'dispatch_started');
			const view = kernel.ctx.decisions.reconstruct(event.call_id);
			assert.ok(view);
			assert.deepStrictEqual(view.nodes.map((node) => node.layer), ['capability', 'network', 'rules', 'approval', 'sandbox']);
			assert.deepStrictEqual(view.nodes.map((node) => node.decision), ['allow', 'no_match', 'no_match', 'allow', 'allow']);
			const markdown = auditText(kernel.ctx, event.call_id);
			assert.match(markdown, /\| 1 \| capability \| allow \| ro \|/);
			assert.match(markdown, /dispatch_started/);
			assert.match(markdown, /Policy revision/);
		} finally {
			await kernel.dispose();
		}
	});

	test('a plugin refusal is a terminal after the policy layers', async () => {
		const kernel = await createTestKernel({ config: { approval: 'universal_accept', mode: 'aw' } });
		try {
			kernel.ctx.tools.register(probe());
			kernel.ctx.llm.use({ name: 'test', chat: answer([call('probe_read')]) });
			kernel.ctx.on('tools/pre-execute', (exec, next) => (exec.name === 'probe_read' ? { kind: 'deny', reason: 'plugin says no' } : next()));
			await kernel.ctx.agent.runTurn({ text: 'go', surface: 'test' });
			const event = kernel.ctx.decisions.recent(10).find((entry) => entry.tool_name === 'probe_read');
			assert.ok(event);
			assert.strictEqual(event.event, 'denied');
			assert.match(event.reason ?? '', /plugin says no/);
			const view = kernel.ctx.decisions.reconstruct(event.call_id);
			assert.ok(view);
			assert.strictEqual(view.nodes.at(-1)?.layer, 'plugin');
			assert.strictEqual(view.nodes.at(-1)?.decision, 'deny');
			assert.strictEqual(view.nodes.at(-1)?.matched_rule, 'tools/pre-execute');
		} finally {
			await kernel.dispose();
		}
	});

	test('a plugin ask obeys the approval response policy and is traced', async () => {
		const kernel = await createTestKernel({ config: { approval: 'universal_accept', approvalResponse: 'never', mode: 'aw' } });
		try {
			kernel.ctx.tools.register(probe());
			kernel.ctx.llm.use({ name: 'test', chat: answer([call('probe_read')]) });
			kernel.ctx.on('tools/pre-execute', (exec, next) => (exec.name === 'probe_read' ? { kind: 'ask', reason: 'plugin asks' } : next()));
			let asked = 0;
			kernel.ctx.on('approval/request', (request, next) => {
				asked += 1;
				return next();
			});
			await kernel.ctx.agent.runTurn({ text: 'go', surface: 'test' });
			assert.strictEqual(asked, 0, 'the approval response policy never reached a surface');
			const event = kernel.ctx.decisions.recent(10).find((entry) => entry.tool_name === 'probe_read');
			assert.ok(event);
			assert.strictEqual(event.event, 'denied');
			const view = kernel.ctx.decisions.reconstruct(event.call_id);
			assert.deepStrictEqual(view?.nodes.slice(-2).map((node) => [node.layer, node.decision, node.matched_rule]), [
				['plugin', 'ask', 'tools/pre-execute'],
				['response', 'deny', 'never'],
			]);
		} finally {
			await kernel.dispose();
		}
	});

	test('a manual denial records the response layer and a denied terminal', async () => {
		const kernel = await createTestKernel({ config: { approval: 'manual', mode: 'aw' } });
		try {
			kernel.ctx.tools.register(probe());
			kernel.ctx.llm.use({ name: 'test', chat: answer([call('probe_read')]) });
			kernel.ctx.on('approval/request', (request, next) => (request.surface === 'test' ? 'deny' : next()));
			await kernel.ctx.agent.runTurn({ text: 'go', surface: 'test' });
			const event = kernel.ctx.decisions.recent(10).find((entry) => entry.tool_name === 'probe_read');
			assert.ok(event);
			assert.strictEqual(event.event, 'denied');
			const view = kernel.ctx.decisions.reconstruct(event.call_id);
			assert.ok(view);
			assert.deepStrictEqual(view.nodes.map((node) => [node.layer, node.decision]), [
				['capability', 'allow'],
				['network', 'no_match'],
				['rules', 'no_match'],
				['approval', 'ask'],
				['response', 'deny'],
			]);
			assert.strictEqual(view.nodes.at(-1)?.matched_rule, 'ask');
		} finally {
			await kernel.dispose();
		}
	});

	test('approval response never denies with matched_rule never and no surface', async () => {
		const kernel = await createTestKernel({ config: { approval: 'manual', approvalResponse: 'never', mode: 'aw' } });
		try {
			kernel.ctx.tools.register(probe());
			kernel.ctx.llm.use({ name: 'test', chat: answer([call('probe_read')]) });
			let asked = 0;
			kernel.ctx.on('approval/request', (request, next) => {
				asked += 1;
				return next();
			});
			await kernel.ctx.agent.runTurn({ text: 'go', surface: 'test' });
			assert.strictEqual(asked, 0);
			const event = kernel.ctx.decisions.recent(10).find((entry) => entry.tool_name === 'probe_read');
			assert.ok(event);
			assert.strictEqual(event.event, 'denied');
			const view = kernel.ctx.decisions.reconstruct(event.call_id);
			assert.strictEqual(view?.nodes.at(-1)?.layer, 'response');
			assert.strictEqual(view?.nodes.at(-1)?.decision, 'deny');
			assert.strictEqual(view?.nodes.at(-1)?.matched_rule, 'never');
		} finally {
			await kernel.dispose();
		}
	});

	test('an allow rule skips the approval layer entirely', async () => {
		const kernel = await createTestKernel({ config: { approval: 'manual', mode: 'aw', permissions: { allow: ['probe_read'], ask: [], deny: [] } } });
		try {
			kernel.ctx.tools.register(probe());
			kernel.ctx.llm.use({ name: 'test', chat: answer([call('probe_read')]) });
			await kernel.ctx.agent.runTurn({ text: 'go', surface: 'test' });
			const event = kernel.ctx.decisions.recent(10).find((entry) => entry.tool_name === 'probe_read');
			assert.ok(event);
			assert.strictEqual(event.event, 'dispatch_started');
			const view = kernel.ctx.decisions.reconstruct(event.call_id);
			assert.deepStrictEqual(view?.nodes.map((node) => [node.layer, node.decision]), [
				['capability', 'allow'],
				['network', 'no_match'],
				['rules', 'allow'],
				['sandbox', 'allow'],
			]);
		} finally {
			await kernel.dispose();
		}
	});

	test('a batch rejection gives every call its own terminal', async () => {
		const kernel = await createTestKernel({ config: { approval: 'universal_accept', mode: 'aw', permissions: { allow: [], ask: [], deny: ['probe_deny'] } } });
		try {
			kernel.ctx.tools.register(probe('probe_keep'));
			kernel.ctx.tools.register(probe('probe_deny'));
			kernel.ctx.llm.use({ name: 'test', chat: answer([call('probe_keep'), call('probe_deny')]) });
			await kernel.ctx.agent.runTurn({ text: 'go', surface: 'test' });
			const events = kernel.ctx.decisions.recent(10).filter((entry) => entry.tool_name === 'probe_keep' || entry.tool_name === 'probe_deny');
			assert.strictEqual(events.length, 2);
			for (const event of events) {
				assert.strictEqual(event.event, 'denied');
				assert.ok(kernel.ctx.decisions.reconstruct(event.call_id));
			}
			const denied = events.find((entry) => entry.tool_name === 'probe_deny');
			const sibling = events.find((entry) => entry.tool_name === 'probe_keep');
			assert.match(sibling?.reason ?? '', /batch rejected/);
			assert.match(denied?.reason ?? '', /deny rule/);
		} finally {
			await kernel.dispose();
		}
	});
});
