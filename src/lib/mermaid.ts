import { GraphError, type GraphsConfig, type NodeConfig } from './graph';

/** Parses the Mermaid flowchart dialect used to describe the agent loop. Pure module. */

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export const DEFAULT_GRAPH_SOURCE = `flowchart TD
  %% start: llm
  llm["llm.complete"] -->|route: agent.after-llm| reject["agent.reject"]
  llm -->|route: agent.after-llm| confirm["agent.confirm"]
  llm -->|route: agent.after-llm| tools["agent.tools"]
  llm -->|route: agent.after-llm| End
  reject --> llm
  confirm -->|route: agent.after-confirm| tools
  confirm -->|route: agent.after-confirm| reject
  tools --> llm
`;

interface DraftNode {
	use?: string;
	kind?: 'next' | 'route' | 'soft';
	next?: string;
	route?: string;
	targets: string[];
	choices: { id: string; description: string }[];
}

interface DraftGraph {
	name: string;
	nodes: Map<string, DraftNode>;
	start?: string;
	soft: Map<string, string>;
}

export function parseGraphSource(text: string): GraphsConfig {
	const graphs: DraftGraph[] = [];
	let current: DraftGraph | null = null;
	let pendingName: string | undefined;
	let defaultName: string | undefined;

	for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) {
			continue;
		}
		if (line.startsWith('%%')) {
			const directive = readDirective(line);
			if (!directive) {
				continue;
			}
			if (directive.kind === 'graph') {
				if (pendingName) {
					throw new GraphError('%% graph: name');
				}
				pendingName = directive.value;
				continue;
			}
			if (directive.kind === 'default') {
				if (defaultName && defaultName !== directive.value) {
					throw new GraphError('%% default is already set');
				}
				defaultName = directive.value;
				continue;
			}
			if (!current) {
				throw new GraphError(`flowchart TD is required before %% ${directive.kind}`);
			}
			if (directive.kind === 'start') {
				if (current.start && current.start !== directive.value) {
					throw new GraphError(`graph ${current.name} already has a start`);
				}
				current.start = directive.value;
				continue;
			}
			const previous = current.soft.get(directive.value);
			if (previous !== undefined && previous !== directive.instruct) {
				throw new GraphError(`%% soft ${directive.value} is already set`);
			}
			current.soft.set(directive.value, directive.instruct ?? '');
			continue;
		}
		if (/^flowchart\s+(TD|TB|LR|RL|BT)\s*$/i.test(line)) {
			const name = pendingName ?? (graphs.length === 0 ? 'agent' : undefined);
			pendingName = undefined;
			if (!name) {
				throw new GraphError('name this graph with %% graph: id');
			}
			if (graphs.some((graph) => graph.name === name)) {
				throw new GraphError(`duplicate graph ${name}`);
			}
			current = { name, nodes: new Map(), soft: new Map() };
			graphs.push(current);
			continue;
		}
		if (!current) {
			throw new GraphError('flowchart TD is required');
		}
		const arrows = line.split('-->').length - 1;
		if (arrows > 1) {
			throw new GraphError('one edge per line');
		}
		if (arrows === 0) {
			throw new GraphError('expected an edge');
		}
		readEdge(current, line);
	}

	if (graphs.length === 0) {
		throw new GraphError('flowchart TD is required');
	}
	if (pendingName) {
		throw new GraphError('%% graph: name');
	}
	const fallback = graphs.length === 1 ? graphs[0]!.name : graphs.some((graph) => graph.name === 'agent') ? 'agent' : undefined;
	const selected = defaultName ?? fallback;
	if (!selected || !graphs.some((graph) => graph.name === selected)) {
		throw new GraphError(defaultName ? `unknown graph ${defaultName}` : 'add %% default: name');
	}
	return {
		default: selected,
		graphs: Object.fromEntries(graphs.map((graph) => [graph.name, finishGraph(graph)])),
	};
}

interface Directive {
	kind: 'graph' | 'default' | 'start' | 'soft';
	value: string;
	instruct?: string;
}

function readDirective(line: string): Directive | null {
	const known = line.match(/^%%\s*(graph|default|start|soft)\b(.*)$/);
	if (!known) {
		return null;
	}
	const kind = known[1] as Directive['kind'];
	const rest = known[2] ?? '';
	if (kind === 'soft') {
		const match = rest.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\S.*)$/);
		if (!match) {
			throw new GraphError('%% soft id: instruct');
		}
		return { kind, value: match[1]!, instruct: match[2]!.trim() };
	}
	const match = rest.match(/^:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/);
	if (!match) {
		throw new GraphError(`%% ${kind}: name`);
	}
	return { kind, value: match[1]! };
}

function readEdge(graph: DraftGraph, line: string): void {
	const arrow = line.indexOf('-->');
	const left = readNode(line.slice(0, arrow).trim());
	if (left.rest) {
		throw new GraphError(`unexpected text after ${left.id}`);
	}
	if (left.id === 'End') {
		throw new GraphError('End is not a node');
	}
	let rightText = line.slice(arrow + 3).trim();
	let label: string | undefined;
	if (rightText.startsWith('|')) {
		const close = rightText.indexOf('|', 1);
		if (close < 0) {
			throw new GraphError('unclosed edge label');
		}
		label = rightText.slice(1, close).trim();
		if (!label) {
			throw new GraphError('edge label must start with route: or soft:');
		}
		rightText = rightText.slice(close + 1).trim();
	}
	const right = readNode(rightText);
	if (right.rest) {
		throw new GraphError(`unexpected text after ${right.id}`);
	}
	const source = touch(graph, left.id, left.label);
	touch(graph, right.id, right.label);
	const target = right.id === 'End' ? 'end' : right.id;
	connect(source, left.id, target, label);
}

function readNode(input: string): { id: string; label?: string; rest: string } {
	const match = input.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
	if (!match?.[1]) {
		throw new GraphError('expected a node id');
	}
	const id = match[1];
	let rest = input.slice(id.length);
	if (!rest.startsWith('[')) {
		return { id, rest: rest.trim() };
	}
	let label = '';
	let end = -1;
	if (rest.startsWith('["')) {
		end = rest.indexOf('"]', 2);
	} else if (rest.startsWith("['")) {
		end = rest.indexOf("']", 2);
	} else {
		end = rest.indexOf(']');
	}
	if (end < 0) {
		throw new GraphError('unclosed node label');
	}
	if (rest.startsWith('["') || rest.startsWith("['")) {
		label = rest.slice(2, end);
		rest = rest.slice(end + 2);
	} else {
		label = rest.slice(1, end).trim();
		rest = rest.slice(end + 1);
	}
	return { id, label, rest: rest.trim() };
}

function touch(graph: DraftGraph, id: string, label?: string): DraftNode | undefined {
	if (id === 'end') {
		throw new GraphError('use End instead of end');
	}
	if (id === 'End') {
		if (label !== undefined) {
			throw new GraphError('End has no implementation');
		}
		return undefined;
	}
	let node = graph.nodes.get(id);
	if (!node) {
		node = { targets: [], choices: [] };
		graph.nodes.set(id, node);
	}
	if (label !== undefined) {
		if (!NAME.test(label)) {
			throw new GraphError(`invalid implementation ${label}`);
		}
		node.use = label;
	}
	return node;
}

function connect(node: DraftNode | undefined, id: string, target: string, label?: string): void {
	if (!node) {
		return;
	}
	const kind = classify(label);
	if (node.kind && node.kind !== kind.kind) {
		throw new GraphError(`node ${id} has two exit kinds`);
	}
	node.kind = kind.kind;
	if (kind.kind === 'next') {
		if (node.next) {
			throw new GraphError(`node ${id} has two next edges`);
		}
		node.next = target;
		return;
	}
	if (kind.kind === 'route') {
		if (node.route && node.route !== kind.name) {
			throw new GraphError(`node ${id} route edges must share one route name`);
		}
		if (node.targets.includes(target)) {
			throw new GraphError(`node ${id} already points at ${target}`);
		}
		node.route = kind.name;
		node.targets.push(target);
		return;
	}
	if (node.choices.some((choice) => choice.id === target)) {
		throw new GraphError(`node ${id} already points at ${target}`);
	}
	node.choices.push({ id: target, description: kind.description });
}

function classify(label?: string): { kind: 'next' } | { kind: 'route'; name: string } | { kind: 'soft'; description: string } {
	if (label === undefined) {
		return { kind: 'next' };
	}
	if (label.startsWith('route:')) {
		const name = label.slice('route:'.length).trim();
		if (!NAME.test(name)) {
			throw new GraphError(`invalid route ${name || label}`);
		}
		return { kind: 'route', name };
	}
	if (label.startsWith('soft:')) {
		const description = label.slice('soft:'.length).trim();
		if (!description) {
			throw new GraphError('soft edge needs a description');
		}
		return { kind: 'soft', description };
	}
	throw new GraphError('edge label must start with route: or soft:');
}

function finishGraph(graph: DraftGraph): GraphsConfig['graphs'][string] {
	if (graph.nodes.size === 0) {
		throw new GraphError('flowchart has no nodes');
	}
	const nodes: Record<string, NodeConfig> = {};
	const incoming = new Map<string, number>();
	for (const id of graph.nodes.keys()) {
		incoming.set(id, 0);
	}
	for (const node of graph.nodes.values()) {
		for (const target of exits(node)) {
			if (target !== 'end') {
				incoming.set(target, (incoming.get(target) ?? 0) + 1);
			}
		}
	}
	for (const [id, node] of graph.nodes) {
		if (!node.kind) {
			throw new GraphError(`node ${id} needs an outgoing edge`);
		}
		const instruct = graph.soft.get(id);
		if (node.kind === 'soft' && !instruct) {
			throw new GraphError(`node ${id} needs %% soft ${id}: instruct`);
		}
		if (instruct !== undefined && node.kind !== 'soft') {
			throw new GraphError(`%% soft ${id} needs soft edges`);
		}
		const config: NodeConfig = { use: node.use ?? id };
		if (node.kind === 'next') {
			config.next = node.next;
		}
		if (node.kind === 'route') {
			config.route = node.route;
			config.targets = [...node.targets];
		}
		if (node.kind === 'soft') {
			config.soft = { instruct: instruct!, choices: node.choices };
		}
		nodes[id] = config;
	}
	for (const [id, instruct] of graph.soft) {
		if (!graph.nodes.has(id)) {
			throw new GraphError(`%% soft ${id} needs soft edges`);
		}
		if (!instruct.trim()) {
			throw new GraphError(`node ${id} needs %% soft ${id}: instruct`);
		}
	}
	const open = [...graph.nodes.keys()].filter((id) => incoming.get(id) === 0);
	let start = graph.start;
	if (start) {
		if (!graph.nodes.has(start)) {
			throw new GraphError(`unknown node ${start}`);
		}
	} else if (open.length === 1) {
		start = open[0];
	} else if (open.length === 0) {
		throw new GraphError(`graph ${graph.name} has no start; add %% start: id`);
	} else {
		throw new GraphError(`graph ${graph.name} has more than one start (${open.join(', ')}); add %% start: id`);
	}
	return { start: start!, nodes };
}

function exits(node: DraftNode): string[] {
	if (node.kind === 'next' && node.next) {
		return [node.next];
	}
	if (node.kind === 'route') {
		return node.targets;
	}
	if (node.kind === 'soft') {
		return node.choices.map((choice) => choice.id);
	}
	return [];
}
