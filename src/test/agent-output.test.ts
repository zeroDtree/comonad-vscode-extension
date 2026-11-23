// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { collectShellEvidence, commandMatches, mergeEvidence, readEvidence } from '../lib/agent-evidence';
import { parseAgentEnvelope } from '../lib/agent-output';
import type { Message } from '../lib/types';

const incidentEvidence = Array.from({ length: 20 }, (_, index) => {
	switch (index % 4) {
		case 0:
			return { kind: 'command', command: `command-${index}`, exitCode: 0, output: 'ok' };
		case 1:
			return { kind: 'search', query: `query-${index}` };
		case 2:
			return { kind: 'file', path: `src/file-${index}.ts` };
		default:
			return { kind: 'note', text: `note-${index}` };
	}
});

const envelope = (patch: Record<string, unknown> = {}): string =>
	JSON.stringify({
		status: 'ok',
		summary: 'did the work',
		evidence: [{ kind: 'file', path: 'src/a.ts' }],
		acceptance: [{ id: 'check', met: true }],
		...patch,
	});

suite('Agent envelope tolerance', () => {
	test('a 20-item evidence list is trimmed, not rejected', () => {
		const parsed = parseAgentEnvelope(envelope({ evidence: incidentEvidence }));
		assert.strictEqual(parsed.ok, true);
		if (!parsed.ok) {
			return;
		}
		assert.strictEqual(parsed.value.evidence.length, 16);
		assert.ok(parsed.value.evidence.every((item) => item.kind === 'command') === false);
		assert.ok(parsed.warnings.some((warning) => warning.includes('20 items')));
	});

	test('one malformed evidence item is dropped with a warning', () => {
		const parsed = parseAgentEnvelope(
			envelope({
				evidence: [
					{ kind: 'file', path: 'src/a.ts' },
					{ kind: 'command', command: 'true' },
					{ kind: 'search', query: 'wanted' },
				],
			}),
		);
		assert.strictEqual(parsed.ok, true);
		if (!parsed.ok) {
			return;
		}
		assert.deepStrictEqual(parsed.value.evidence, [
			{ kind: 'file', path: 'src/a.ts' },
			{ kind: 'search', query: 'wanted' },
		]);
		assert.ok(parsed.warnings.some((warning) => warning.includes('evidence[1]')));
	});

	test('numeric strings and aliases are normalized', () => {
		const parsed = parseAgentEnvelope(
			envelope({ evidence: [{ kind: 'COMMAND', cmd: 'npm test', exit_code: '0', output: 'ok' }] }),
		);
		assert.strictEqual(parsed.ok, true);
		if (!parsed.ok) {
			return;
		}
		assert.deepStrictEqual(parsed.value.evidence, [
			{ kind: 'command', command: 'npm test', exitCode: 0, output: 'ok' },
		]);
	});

	test('non-array evidence is ignored, while a bad status remains fatal', () => {
		const tolerated = parseAgentEnvelope(envelope({ evidence: 'nope' }));
		assert.strictEqual(tolerated.ok, true);
		if (tolerated.ok) {
			assert.deepStrictEqual(tolerated.value.evidence, []);
			assert.ok(tolerated.warnings.some((warning) => warning.includes('not an array')));
		}
		const fatal = parseAgentEnvelope(envelope({ status: 'success' }));
		assert.strictEqual(fatal.ok, false);
	});

	test('acceptance strings are coerced and bad entries are dropped', () => {
		const parsed = parseAgentEnvelope(
			envelope({
				acceptance: [
					{ id: 'check', met: 'true' },
					{ id: 'other' },
					{ id: 'build', met: false, note: 'failed' },
				],
			}),
		);
		assert.strictEqual(parsed.ok, true);
		if (!parsed.ok) {
			return;
		}
		assert.deepStrictEqual(parsed.value.acceptance, [
			{ id: 'check', met: true },
			{ id: 'build', met: false, note: 'failed' },
		]);
		assert.ok(parsed.warnings.some((warning) => warning.includes('acceptance[1]')));
	});

	test('readEvidence keeps command evidence when trimming', () => {
		const read = readEvidence([
			...Array.from({ length: 17 }, (_, index) => ({ kind: 'file', path: `f-${index}` })),
			{ kind: 'command', command: 'true', exitCode: 0 },
		]);
		assert.strictEqual(read.items.length, 16);
		assert.strictEqual(read.items[0]?.kind, 'command');
	});
});

suite('Runtime command evidence', () => {
	const messages: Message[] = [
		{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run_shell_test', arguments: '{"command":"npm test"}' }] },
		{ role: 'tool', toolCallId: 'c1', content: 'exit_code: 1\nstdout:\nfailed' },
		{ role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'run_shell_test', arguments: '{"command":"npm test"}' }] },
		{ role: 'tool', toolCallId: 'c2', content: 'scratch: /tmp/scratch\nexit_code: 0\nstdout:\nok' },
		{ role: 'assistant', content: '', toolCalls: [{ id: 'c3', name: 'read_file', arguments: '{"path":"a.ts"}' }] },
		{ role: 'tool', toolCallId: 'c3', content: 'exit_code: 0' },
	];

	test('harvests shell tool calls and keeps the last run of a command', () => {
		assert.deepStrictEqual(collectShellEvidence(messages), [
			{ kind: 'command', command: 'npm test', exitCode: 0, output: 'scratch: /tmp/scratch\nexit_code: 0\nstdout:\nok' },
		]);
	});

	test('observed commands replace the model transcription', () => {
		const merged = mergeEvidence(
			[
				{ kind: 'command', command: 'npm test', exitCode: 0 },
				{ kind: 'file', path: 'src/a.ts' },
			],
			[{ kind: 'command', command: 'npm test', exitCode: 1 }],
		);
		assert.deepStrictEqual(merged.items, [
			{ kind: 'command', command: 'npm test', exitCode: 1 },
			{ kind: 'file', path: 'src/a.ts' },
		]);
		assert.ok(merged.warnings.some((warning) => warning.includes('self-reported')));
	});

	test('an older caller without observations keeps declared commands', () => {
		const merged = mergeEvidence([{ kind: 'command', command: 'true', exitCode: 0 }], undefined);
		assert.deepStrictEqual(merged.items, [{ kind: 'command', command: 'true', exitCode: 0 }]);
	});

	test('a decisive command ordered first survives the cap', () => {
		const observed = [
			{ kind: 'command' as const, command: 'wanted', exitCode: 0 },
			...Array.from({ length: 20 }, (_, index) => ({
				kind: 'command' as const,
				command: `noise-${index}`,
				exitCode: 0,
			})),
		];
		const merged = mergeEvidence([], observed);
		assert.ok(merged.items.some((item) => item.kind === 'command' && item.command === 'wanted'));
	});

	test('a mirror wrapper still matches the criterion command', () => {
		assert.strictEqual(commandMatches('cd /tmp/mirror && npm test', 'npm test'), true);
		assert.strictEqual(commandMatches('cd /tmp/mirror && npm run test && npm run lint', 'npm run test'), false);
		assert.strictEqual(commandMatches('npm test', 'npm test'), true);
	});
});
