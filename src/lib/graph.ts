// SPDX-License-Identifier: AGPL-3.0-only
/** Graph runtime: nodes, routes, soft routes, suspend/resume. Pure module. */

export interface SoftChoice {
	id: string;
	description: string;
}

export interface SoftRequest {
	instruct: string;
	choices: SoftChoice[];
	state: unknown;
}

export interface GraphRuntime {
	resuming: boolean;
	resume: unknown;
	signal: AbortSignal;
	suspend(payload: unknown): never;
	choose(request: SoftRequest): Promise<string>;
}

export type NodeFn<S> = (state: S, runtime: GraphRuntime) => Promise<S>;
export type RouteFn<S> = (state: S, runtime: GraphRuntime) => string | Promise<string>;

export interface NodeConfig {
	use: string;
	next?: string;
	route?: string;
	targets?: string[];
	soft?: { instruct: string; choices: SoftChoice[] };
}

export interface GraphConfig {
	start: string;
	maxSteps?: number;
	nodes: Record<string, NodeConfig>;
}

export interface GraphsConfig {
	default: string;
	graphs: Record<string, GraphConfig>;
}

export interface GraphRegistry<S> {
	nodes: Map<string, NodeFn<S>>;
	routes: Map<string, RouteFn<S>>;
}

export interface CompiledNode<S> {
	run: NodeFn<S>;
	exit(state: S, runtime: GraphRuntime): Promise<string>;
}

export interface CompiledGraph<S> {
	id: string;
	start: string;
	maxSteps: number;
	nodes: Map<string, CompiledNode<S>>;
}

export interface Finished<S> {
	status: 'done';
	state: S;
	step: number;
}

export interface Suspended<S> {
	status: 'suspended';
	node: string;
	state: S;
	payload: unknown;
	step: number;
}

/** The turn's signal aborted: the graph stopped between nodes, before routing another one. */
export interface Aborted<S> {
	status: 'aborted';
	state: S;
	step: number;
}

export type Outcome<S> = Finished<S> | Suspended<S> | Aborted<S>;

export interface ResumeCursor {
	node: string;
	value: unknown;
	payload: unknown;
	step: number;
}

export interface RunOptions {
	maxSteps?: number;
	choose?: GraphRuntime['choose'];
	resume?: ResumeCursor;
	signal?: AbortSignal;
}

export const DEFAULT_MAX_STEPS = 48;

export class GraphError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GraphError';
	}
}

class SuspendSignal {
	constructor(public payload: unknown) {}
}

const END = 'end';

function exitCount(node: NodeConfig): number {
	return [node.next, node.route, node.soft].filter((value) => value !== undefined).length;
}

function assertTarget(graphId: string, nodeId: string, target: string, nodes: Record<string, NodeConfig>): void {
	if (target === END) {
		return;
	}
	if (!nodes[target]) {
		throw new GraphError(`graph ${graphId} node ${nodeId} points at unknown node ${target}`);
	}
}

export interface CompileOptions {
	/** Validation mode: missing implementations become pass-through stubs. */
	ignoreMissing?: boolean;
}

export function compileGraphs<S>(
	config: GraphsConfig,
	registry: GraphRegistry<S>,
	options: CompileOptions = {},
): Map<string, CompiledGraph<S>> {
	if (!config.graphs[config.default]) {
		throw new GraphError(`default graph ${config.default} is not defined`);
	}
	const compiled = new Map<string, CompiledGraph<S>>();
	for (const [id, graph] of Object.entries(config.graphs)) {
		if (!graph.nodes[graph.start]) {
			throw new GraphError(`graph ${id} starts at unknown node ${graph.start}`);
		}
		compiled.set(id, { id, start: graph.start, maxSteps: graph.maxSteps ?? DEFAULT_MAX_STEPS, nodes: new Map() });
	}
	for (const [id, graph] of Object.entries(config.graphs)) {
		const target = compiled.get(id)!;
		for (const [nodeId, node] of Object.entries(graph.nodes)) {
			if (exitCount(node) !== 1) {
				throw new GraphError(`graph ${id} node ${nodeId} needs exactly one of next, route, or soft`);
			}
			target.nodes.set(nodeId, compileNode(id, nodeId, node, graph.nodes, registry, options));
		}
	}
	return compiled;
}

function compileNode<S>(
	graphId: string,
	nodeId: string,
	node: NodeConfig,
	siblings: Record<string, NodeConfig>,
	registry: GraphRegistry<S>,
	options: CompileOptions,
): CompiledNode<S> {
	const implementation = registry.nodes.get(node.use) ?? (options.ignoreMissing ? async (state: S) => state : undefined);
	if (!implementation) {
		throw new GraphError(`graph ${graphId} node ${nodeId}: unknown node implementation ${node.use}`);
	}
	let exit: CompiledNode<S>['exit'];
	if (node.next !== undefined) {
		assertTarget(graphId, nodeId, node.next, siblings);
		const next = node.next;
		exit = async () => next;
	} else if (node.route !== undefined) {
		const route = registry.routes.get(node.route) ?? (options.ignoreMissing ? async () => END : undefined);
		if (!route) {
			throw new GraphError(`graph ${graphId} node ${nodeId}: unknown route ${node.route}`);
		}
		const allowed = node.targets;
		for (const target of allowed ?? []) {
			assertTarget(graphId, nodeId, target, siblings);
		}
		exit = async (state, runtime) => {
			const picked = await route(state, runtime);
			if (picked !== END && !siblings[picked]) {
				throw new GraphError(`route ${node.route} returned unknown node ${picked}`);
			}
			if (allowed && !allowed.includes(picked)) {
				throw new GraphError(`route ${node.route} returned undeclared node ${picked}`);
			}
			return picked;
		};
	} else {
		const soft = node.soft!;
		if (soft.choices.length === 0) {
			throw new GraphError(`graph ${graphId} node ${nodeId} soft route has no choices`);
		}
		for (const choice of soft.choices) {
			if (choice.id !== END && !siblings[choice.id]) {
				throw new GraphError(`graph ${graphId} node ${nodeId} soft choice ${choice.id} is not a node or end`);
			}
		}
		const allowed = new Set(soft.choices.map((choice) => choice.id));
		exit = async (state, runtime) => {
			const picked = await runtime.choose({ instruct: soft.instruct, choices: soft.choices, state });
			if (!allowed.has(picked)) {
				throw new GraphError(`soft route rejected undeclared id: ${picked}`);
			}
			return picked;
		};
	}
	return { run: implementation, exit };
}

export async function runGraph<S>(graph: CompiledGraph<S>, state: S, options: RunOptions = {}): Promise<Outcome<S>> {
	const maxSteps = options.maxSteps ?? graph.maxSteps;
	const signal = options.signal ?? new AbortController().signal;
	let step = options.resume?.step ?? 0;
	let current = options.resume?.node ?? graph.start;
	let pending = options.resume;
	while (current !== END) {
		if (signal.aborted) {
			return { status: 'aborted', state, step };
		}
		if (step >= maxSteps) {
			throw new GraphError(`graph exceeded maxSteps (${maxSteps})`);
		}
		const node = graph.nodes.get(current);
		if (!node) {
			throw new GraphError(`unknown node ${current}`);
		}
		const resuming = pending?.node === current;
		const runtime: GraphRuntime = {
			resuming,
			resume: resuming ? pending?.value : undefined,
			signal,
			suspend(payload: unknown): never {
				throw new SuspendSignal(payload);
			},
			choose:
				options.choose ??
				(async () => {
					throw new GraphError('soft route requires a chooser');
				}),
		};
		pending = undefined;
		try {
			state = await node.run(state, runtime);
		} catch (error) {
			if (error instanceof SuspendSignal) {
				// A stop that lands as the graph suspends wins: never park a turn the user just stopped.
				return signal.aborted
					? { status: 'aborted', state, step }
					: { status: 'suspended', node: current, state, payload: error.payload, step };
			}
			if (signal.aborted) {
				return { status: 'aborted', state, step };
			}
			throw error;
		}
		if (signal.aborted) {
			return { status: 'aborted', state, step };
		}
		step += 1;
		if (signal.aborted) {
			return { status: 'aborted', state, step };
		}
		try {
			current = await node.exit(state, runtime);
		} catch (error) {
			if (signal.aborted) {
				return { status: 'aborted', state, step };
			}
			throw error;
		}
	}
	return { status: 'done', state, step };
}
