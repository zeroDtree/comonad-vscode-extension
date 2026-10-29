// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import {
	DEFAULT_GRAPH_SOURCE,
	addGraphBlock,
	composeGraphBlocks,
	duplicateGraphBlock,
	parseGraphSource,
	removeGraphBlock,
	setDefaultGraph,
	splitGraphBlocks,
} from '../lib/mermaid';

suite('Graph source blocks', () => {
	test('splits, composes and edits named graphs', () => {
		const parsed = parseGraphSource(DEFAULT_GRAPH_SOURCE);
		assert.strictEqual(parsed.default, 'agent');
		const blocks = splitGraphBlocks(DEFAULT_GRAPH_SOURCE);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0]?.id, 'agent');
		assert.match(blocks[0]?.source ?? '', /%% graph: agent/);

		const added = addGraphBlock(
			DEFAULT_GRAPH_SOURCE,
			'review',
			blocks[0]!.source.replace(/%%\s*graph\s*:\s*\S+/, '%% graph: review'),
		);
		const two = parseGraphSource(added);
		assert.deepStrictEqual(Object.keys(two.graphs).sort(), ['agent', 'review']);
		assert.strictEqual(two.default, 'agent');

		const defaulted = setDefaultGraph(added, 'review');
		assert.strictEqual(parseGraphSource(defaulted).default, 'review');

		const duplicated = duplicateGraphBlock(added, 'agent', 'agent-2');
		assert.ok(parseGraphSource(duplicated).graphs['agent-2']);

		const removed = removeGraphBlock(duplicated, 'agent-2');
		assert.deepStrictEqual(Object.keys(parseGraphSource(removed).graphs).sort(), ['agent', 'review']);
		const withoutDefault = removeGraphBlock(added, 'agent');
		assert.strictEqual(parseGraphSource(withoutDefault).default, 'review');

		const roundTrip = composeGraphBlocks(splitGraphBlocks(added), 'agent');
		assert.deepStrictEqual(Object.keys(parseGraphSource(roundTrip).graphs).sort(), ['agent', 'review']);
	});
});
