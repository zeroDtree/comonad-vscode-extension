// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { evaluatePolicy, type PolicyInput } from '../lib/policy';
import { DEFAULT_SANDBOX_MODE } from '../lib/sandbox';
import type { SessionPolicy, ToolCall, ToolSpec } from '../lib/types';

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

const lookup = (name: string): ToolSpec | undefined =>
	[readTool, writeTool].find((tool) => tool.name === name);

const policy = (patch: Partial<SessionPolicy> = {}): SessionPolicy => ({
	workMode: 'sw',
	approval: 'universal_accept',
	approvalResponse: 'ask',
	network: false,
	sandboxMode: DEFAULT_SANDBOX_MODE,
	workingDirectory: '/tmp/workspace',
	commandTimeout: 60,
	commandTimeoutOverride: false,
	denyReadPaths: [],
	model: 'auto',
	...patch,
});

const call = (id: string, name: string): ToolCall => ({ id, name, arguments: '{}' });

const rules = { allow: [], ask: [], deny: [] };

const input = (patch: Partial<PolicyInput> = {}): PolicyInput => ({
	calls: [call('c1', 'read_file')],
	lookup,
	policy: policy(),
	rules,
	env: { sandbox: 'bwrap' },
	toolsEnabled: true,
	toolEnabled: () => true,
	...patch,
});

suite('Tool policy', () => {
	test('allow, confirm and reject are the only outcomes', () => {
		assert.strictEqual(evaluatePolicy(input()).outcome, 'allow');
		assert.strictEqual(
			evaluatePolicy(input({ policy: policy({ approval: 'manual' }) })).outcome,
			'confirm',
		);
		assert.strictEqual(
			evaluatePolicy(input({ policy: policy({ approval: 'universal_reject' }) })).outcome,
			'reject',
		);
	});

	test('each call keeps its own decision and a matching trace', () => {
		const result = evaluatePolicy(
			input({
				calls: [call('c1', 'read_file'), call('c2', 'write_file')],
				policy: policy({ approval: 'whitelist_accept' }),
			}),
		);
		assert.strictEqual(result.outcome, 'confirm');
		assert.deepStrictEqual(
			result.calls.map((entry) => [entry.callId, entry.decision]),
			[
				['c1', 'allow'],
				['c2', 'confirm'],
			],
		);
		assert.ok(result.calls.every((entry) => entry.traces.length > 0));
	});

	test('a rejection anywhere rejects the batch', () => {
		const result = evaluatePolicy(
			input({
				calls: [call('c1', 'read_file'), call('c2', 'write_file')],
				policy: policy({ workMode: 'ro' }),
			}),
		);
		assert.strictEqual(result.outcome, 'reject');
		assert.deepStrictEqual(
			result.calls.map((entry) => entry.decision),
			['allow', 'reject'],
		);
	});

	test('turn-level switches reject before any per-call layer runs', () => {
		const off = evaluatePolicy(input({ toolsEnabled: false }));
		assert.strictEqual(off.outcome, 'reject');
		assert.strictEqual(off.calls[0]?.traces.at(-1)?.matchedRule, 'tools-switch');

		const disabled = evaluatePolicy(input({ toolEnabled: () => false }));
		assert.strictEqual(disabled.outcome, 'reject');
		assert.strictEqual(disabled.calls[0]?.traces.at(-1)?.matchedRule, 'tool-switch');
	});

	test('a delegated agent cannot call a tool outside its grant', () => {
		const result = evaluatePolicy(
			input({
				calls: [call('c1', 'write_file')],
				delegated: (tool) => tool.name === 'read_file',
			}),
		);
		assert.strictEqual(result.outcome, 'reject');
		assert.strictEqual(result.calls[0]?.traces.at(-1)?.matchedRule, 'subagent');
	});

	test('a delegated confirmation is denied without asking', () => {
		const result = evaluatePolicy(
			input({
				policy: policy({ approval: 'manual' }),
				delegated: () => true,
			}),
		);
		assert.strictEqual(result.outcome, 'reject');
		assert.strictEqual(result.calls[0]?.decision, 'reject');
		assert.strictEqual(result.calls[0]?.traces.at(-1)?.layer, 'response');
		assert.match(result.reason, /subagent approval response policy denies/);
	});
});
