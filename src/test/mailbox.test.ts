// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import {
	addressedTo,
	formatMailboxRecord,
	normalizeTarget,
	recordKey,
	sanitizeMailboxRecord,
} from '../lib/mailbox';

suite('Coordination mailbox', () => {
	test('targets are a task slug, all, or the orchestrator', () => {
		assert.strictEqual(normalizeTarget('all'), 'all');
		assert.strictEqual(normalizeTarget('Orchestrator'), 'orchestrator');
		assert.strictEqual(normalizeTarget('code-1'), 'code-1');
		assert.strictEqual(normalizeTarget('bad target'), undefined);
		assert.strictEqual(normalizeTarget('__proto__'), undefined);
	});

	test('a record is bounded and needs a sender, target and text', () => {
		const record = sanitizeMailboxRecord({
			at: 10,
			from: { task: 'code-1', agent: 'coder', session: 'sub-1' },
			to: 'all',
			text: 'writing made.txt',
			files: ['made.txt'],
		});
		assert.deepStrictEqual(record, {
			at: 10,
			from: { task: 'code-1', agent: 'coder', session: 'sub-1' },
			to: 'all',
			text: 'writing made.txt',
			files: ['made.txt'],
		});
		assert.strictEqual(sanitizeMailboxRecord({ from: 'coder', to: 'all', text: 'hi' })?.from.task, 'coder');
		assert.strictEqual(sanitizeMailboxRecord({ from: { session: 's' }, to: 'bad target', text: 'hi' }), undefined);
		assert.strictEqual(sanitizeMailboxRecord({ from: { session: 's' }, to: 'all', text: '   ' }), undefined);
		assert.strictEqual(sanitizeMailboxRecord({ from: {}, to: 'all', text: 'hi' }), undefined);
		assert.strictEqual(sanitizeMailboxRecord({ from: { session: 's' }, to: 'all', text: 'hi', files: new Array(30).fill('a') })?.files?.length, 16);
	});

	test('addressing and formatting are stable', () => {
		const record = sanitizeMailboxRecord({ from: { task: 'code-1' }, to: 'all', text: 'hello', files: ['a.ts'] })!;
		assert.ok(addressedTo(record, 'code-2'));
		assert.ok(addressedTo(record, undefined));
		const direct = sanitizeMailboxRecord({ from: { task: 'code-1' }, to: 'code-2', text: 'hello' })!;
		assert.ok(addressedTo(direct, 'code-2'));
		assert.ok(!addressedTo(direct, 'code-3'));
		assert.ok(!addressedTo(direct, undefined));
		const toOrchestrator = sanitizeMailboxRecord({ from: { task: 'code-1' }, to: 'orchestrator', text: 'done' })!;
		assert.ok(addressedTo(toOrchestrator, undefined));
		assert.ok(!addressedTo(toOrchestrator, 'code-1'));
		assert.strictEqual(formatMailboxRecord(record), 'code-1 -> all: hello [a.ts]');
		assert.ok(recordKey(record, 3) > record.at);
	});
});
