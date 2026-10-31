// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { DEFAULT_GRAPH_SOURCE, parseGraphSource } from '../lib/mermaid';

suite('Graph source', () => {
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
});
