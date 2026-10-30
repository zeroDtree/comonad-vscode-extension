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
	test('the shipped loop gates every tool batch and ends only at the model', () => {
		const { default: id, graphs } = parseGraphSource(DEFAULT_GRAPH_SOURCE);
		assert.strictEqual(id, 'agent');
		const graph = graphs.agent!;
		assert.strictEqual(graph.start, 'llm');
		assert.deepStrictEqual(
			Object.keys(graph.nodes).sort(),
			['approval', 'calls', 'gate', 'llm', 'reject', 'tools'],
		);
		assert.strictEqual(graph.nodes.llm!.use, 'llm.complete');
		assert.strictEqual(graph.nodes.calls!.use, 'agent.calls');
		assert.strictEqual(graph.nodes.gate!.use, 'agent.gate');
		assert.strictEqual(graph.nodes.approval!.use, 'agent.approval');
		assert.strictEqual(graph.nodes.tools!.use, 'agent.tools');
		assert.strictEqual(graph.nodes.reject!.use, 'agent.reject');
		assert.strictEqual(graph.nodes.llm!.route, 'agent.after-llm');
		assert.deepStrictEqual(graph.nodes.llm!.targets, ['calls', 'end']);
		assert.strictEqual(graph.nodes.gate!.route, 'agent.gate');
		assert.deepStrictEqual(graph.nodes.gate!.targets, ['tools', 'approval', 'reject']);
		assert.strictEqual(graph.nodes.calls!.next, 'gate');
		assert.strictEqual(graph.nodes.approval!.next, 'gate');
		assert.strictEqual(graph.nodes.tools!.next, 'llm');
		assert.strictEqual(graph.nodes.reject!.next, 'llm');
		const predecessors = (target: string): string[] =>
			Object.entries(graph.nodes)
				.filter(([, node]) => node.next === target || node.targets?.includes(target))
				.map(([nodeId]) => nodeId)
				.sort();
		assert.deepStrictEqual(predecessors('tools'), ['gate'], 'the gate is the only way into the executor');
	});

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
