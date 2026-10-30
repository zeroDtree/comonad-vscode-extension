// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { parseRules, type RuleSet } from '../lib/policy';
import {
	buildSubagentPolicy,
	intersectCapabilities,
	meetSandboxMode,
	parentFacts,
	tightenRules,
	tightenSubagentPolicy,
	type ParentFacts,
} from '../lib/subagent';
import type { SessionPolicy } from '../lib/types';

const rules = (patch: Partial<RuleSet> = {}): RuleSet => ({ allow: [], ask: [], deny: [], ...patch });

const policy = (patch: Partial<SessionPolicy> = {}): SessionPolicy => ({
	workMode: 'aw',
	capabilities: ['ro', 'rw', 'shell_ro', 'shell_test', 'shell_rw'],
	rules: rules(),
	approval: 'universal_accept',
	approvalResponse: 'ask',
	network: true,
	sandboxMode: 'workspace-write',
	workingDirectory: '/ws',
	commandTimeout: 60,
	commandTimeoutOverride: false,
	denyReadPaths: [],
	model: 'auto',
	...patch,
});

suite('Subagent policy algebra', () => {
	test('sandbox modes meet at the stricter read and write scope', () => {
		assert.strictEqual(meetSandboxMode('danger-full-access', 'workspace-write'), 'workspace-write');
		assert.strictEqual(meetSandboxMode('workspace-write', 'read-only'), 'read-only');
		assert.strictEqual(meetSandboxMode('workspace-write', 'workspace-read'), 'workspace-read');
		assert.strictEqual(meetSandboxMode('read-only', 'workspace-read'), 'workspace-read');
		assert.strictEqual(meetSandboxMode('danger-full-access', 'danger-full-access'), 'danger-full-access');
	});

	test('capabilities intersect in the canonical order', () => {
		assert.deepStrictEqual(intersectCapabilities(['rw', 'ro', 'shell_test'], ['ro', 'shell_test', 'shell_rw']), [
			'ro',
			'shell_test',
		]);
		assert.deepStrictEqual(intersectCapabilities(['ro'], ['rw']), []);
	});

	test('deny/ask accumulate and allow only shrinks', () => {
		const previous = parseRules({ deny: ['a'], ask: ['b'], allow: ['x', 'y'] });
		const parent = parseRules({ deny: ['a', 'c'], ask: ['d'], allow: ['y', 'z'] });
		const next = tightenRules(previous, parent);
		assert.deepStrictEqual(
			next.deny.map((rule) => rule.tool),
			['a', 'c'],
		);
		assert.deepStrictEqual(
			next.ask.map((rule) => rule.tool),
			['b', 'd'],
		);
		assert.deepStrictEqual(
			next.allow.map((rule) => rule.tool),
			['y'],
			'a removed allow is gone; a new parent allow is not granted',
		);
	});

	test('a child inherits, narrows and never widens', () => {
		const parent = policy({
			capabilities: ['ro', 'rw', 'shell_ro', 'shell_test'],
			rules: parseRules({ allow: ['keep'], deny: ['blocked'] }),
		});
		const child = buildSubagentPolicy(
			parent,
			{ capabilities: ['ro', 'rw', 'shell_rw'], network: false, sandboxMode: 'read-only', approval: 'blacklist_reject' },
			['read_file', 'write_file'],
			'child-model',
		);
		assert.deepStrictEqual(child.capabilities, ['ro', 'rw']);
		assert.strictEqual(child.network, false, 'the delegation turned network off');
		assert.strictEqual(child.sandboxMode, 'read-only');
		assert.strictEqual(child.approval, 'blacklist_reject');
		assert.strictEqual(child.approvalResponse, 'never', 'a child can never ask');
		assert.strictEqual(child.model, 'child-model');
		assert.deepStrictEqual(child.tools, ['read_file', 'write_file']);
		assert.deepStrictEqual(
			child.rules?.allow.map((rule) => rule.tool),
			['keep'],
		);
		assert.deepStrictEqual(
			child.rules?.deny.map((rule) => rule.tool),
			['blocked'],
		);
	});

	test('the default child approval is whitelist_accept and network never turns on', () => {
		const child = buildSubagentPolicy(policy({ network: false }), { network: true }, ['read_file']);
		assert.strictEqual(child.approval, 'whitelist_accept');
		assert.strictEqual(child.approvalResponse, 'never');
		assert.strictEqual(child.network, false, 'a delegation cannot turn network on for a child');
	});

	test('tightening narrows tools and is idempotent under a looser parent', () => {
		const child = buildSubagentPolicy(
			policy({ capabilities: ['ro', 'rw', 'shell_ro'], rules: parseRules({ allow: ['a', 'b'], deny: ['d'] }) }),
			{},
			['read_file', 'write_file', 'run_shell_readonly'],
		);
		const facts: ParentFacts = {
			capabilities: ['ro', 'rw', 'shell_ro'],
			network: true,
			sandboxMode: 'workspace-write',
			rules: parseRules({ allow: ['a'], deny: ['d', 'e'] }),
		};
		const tightened = tightenSubagentPolicy(child, facts, (next) =>
			next.capabilities?.includes('rw') ? ['read_file', 'write_file'] : ['read_file'],
		);
		assert.deepStrictEqual(tightened.capabilities, ['ro', 'rw', 'shell_ro']);
		assert.deepStrictEqual(tightened.tools, ['read_file', 'write_file']);
		assert.deepStrictEqual(
			tightened.rules?.allow.map((rule) => rule.tool),
			['a'],
		);
		assert.deepStrictEqual(
			tightened.rules?.deny.map((rule) => rule.tool),
			['d', 'e'],
		);

		// A parent that has relaxed since does not widen the child: same facts, same policy.
		const again = tightenSubagentPolicy(tightened, facts, () => ['read_file', 'write_file', 'extra']);
		assert.deepStrictEqual(again.capabilities, tightened.capabilities);
		assert.deepStrictEqual(again.tools, tightened.tools);
		assert.deepStrictEqual(again.rules, tightened.rules);
	});

	test('parent facts combine the parent snapshot with the current settings', () => {
		const parent = policy({
			capabilities: ['ro', 'rw', 'shell_ro', 'shell_test'],
			network: true,
			sandboxMode: 'workspace-write',
			rules: parseRules({ allow: ['old', 'keep'], deny: [] }),
		});
		const current = policy({
			capabilities: ['ro', 'shell_ro'],
			network: false,
			sandboxMode: 'read-only',
			rules: parseRules({ allow: ['keep', 'new'], deny: ['blocked'] }),
		});
		const facts = parentFacts(parent, current);
		assert.deepStrictEqual(facts.capabilities, ['ro', 'shell_ro']);
		assert.strictEqual(facts.network, false);
		assert.strictEqual(facts.sandboxMode, 'read-only');
		assert.deepStrictEqual(
			facts.rules.allow.map((rule) => rule.tool),
			['keep'],
			'the parent snapshot allow is intersected with the current one',
		);
		assert.deepStrictEqual(
			facts.rules.deny.map((rule) => rule.tool),
			['blocked'],
		);
	});
});
