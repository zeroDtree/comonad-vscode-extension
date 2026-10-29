// SPDX-License-Identifier: AGPL-3.0-only
import { Service, type Context } from 'cordis';
import {
	compileGraphs,
	GraphError,
	type CompiledGraph,
	type GraphRegistry,
	type GraphsConfig,
	type NodeFn,
	type RouteFn,
} from '../lib/graph';
import {
	DEFAULT_GRAPH_SOURCE,
	parseGraphSource,
	splitGraphBlocks,
	type GraphBlock,
} from '../lib/mermaid';
import { graphPane } from '../ui/graph-pane';

/** The settings key this plugin owns. The manifest declares it; the kernel no longer reads it. */
export const GRAPH_SETTING_KEYS = ['graph'] as const;

/** One graph in the edited source, as the Graph pane lists it. */
export interface GraphInfo {
	id: string;
	default: boolean;
	start: string;
	nodes: string[];
	routes: string[];
}

export interface InspectResult {
	/** The source that was inspected: the configured one when the caller passed none. */
	source: string;
	default: string;
	graphs: GraphInfo[];
	blocks: GraphBlock[];
	error?: string;
}

interface Cache {
	source: string;
	version: number;
	compiled: Map<string, CompiledGraph<unknown>>;
}

declare module 'cordis' {
	interface Context {
		graphs: Graphs;
	}
	interface Events {
		/** The source or the node registry moved: a pane's list and preview are stale. */
		'graphs/changed'(): void;
	}
}

/**
 * The graph engine, as its own plugin. It owns the Mermaid source, the node/route registry, parsing,
 * compilation and the Graph pane's data. The agent registers its node implementations here and asks
 * for the compiled graph each turn; another plugin may register more nodes for a custom graph.
 */
export class Graphs extends Service {
	static inject = ['host', 'settings', 'log'];

	private readonly nodes = new Map<string, NodeFn<unknown>>();
	private readonly routes = new Map<string, RouteFn<unknown>>();
	private version = 0;
	private cache: Cache | null = null;

	constructor(ctx: Context) {
		super(ctx, 'graphs');
		// A settings panel is a UI row, not a requirement of the engine: without it (e.g. a headless
		// kernel) the graph service still compiles turns and registers no tab.
		ctx.inject(['panes'], (scope) => scope.panes.register(graphPane(ctx)));
	}

	registerNode<S>(name: string, fn: NodeFn<S>): () => void {
		this.nodes.set(name, fn as unknown as NodeFn<unknown>);
		this.touch();
		return () => {
			if (this.nodes.get(name) === (fn as unknown as NodeFn<unknown>)) {
				this.nodes.delete(name);
				this.touch();
			}
		};
	}

	registerRoute<S>(name: string, fn: RouteFn<S>): () => void {
		this.routes.set(name, fn as unknown as RouteFn<unknown>);
		this.touch();
		return () => {
			if (this.routes.get(name) === (fn as unknown as RouteFn<unknown>)) {
				this.routes.delete(name);
				this.touch();
			}
		};
	}

	/** The configured source, or the shipped one when the setting is empty. */
	source(): string {
		const raw = this.ctx.host.config().graph;
		return typeof raw === 'string' && raw.trim() ? raw : DEFAULT_GRAPH_SOURCE;
	}

	/** Writes the source. The shipped source is stored as empty, as the old Graph tab did. */
	async setSource(source: string): Promise<void> {
		const value = source.trim() === DEFAULT_GRAPH_SOURCE.trim() ? '' : source;
		await this.ctx.settings.update('graph', value);
		this.touch();
	}

	/** The graph names the Graph pane may reference. */
	names(): string[] {
		return this.inspect().graphs.map((graph) => graph.id);
	}

	/** Registered node implementations, for the pane's insertion palette. */
	nodeNames(): string[] {
		return [...this.nodes.keys()].sort();
	}

	/** Registered route functions, for the same palette. */
	routeNames(): string[] {
		return [...this.routes.keys()].sort();
	}

	/** Parses and validates a source without requiring the node implementations to be loaded. */
	inspect(source: string = this.source()): InspectResult {
		const blocks = splitGraphBlocks(source);
		let parsed: GraphsConfig;
		try {
			parsed = parseGraphSource(source);
		} catch (error) {
			return { source, default: '', graphs: [], blocks, error: describe(error) };
		}
		let error: string | undefined;
		try {
			// The pane validates structure even before the agent registered its nodes.
			compileGraphs(parsed, { nodes: new Map(), routes: new Map() }, { ignoreMissing: true });
		} catch (caught) {
			error = describe(caught);
		}
		const graphs = Object.entries(parsed.graphs).map(([id, graph]): GraphInfo => ({
			id,
			default: id === parsed.default,
			start: graph.start,
			nodes: [...new Set(Object.values(graph.nodes).map((node) => node.use))].sort(),
			routes: [...new Set(Object.values(graph.nodes).flatMap((node) => (node.route ? [node.route] : [])))].sort(),
		}));
		return { source, default: parsed.default, graphs, blocks, error };
	}

	blocks(source: string = this.source()): GraphBlock[] {
		return splitGraphBlocks(source);
	}

	/**
	 * Compiles the configured source and returns one graph. With no id the turn's own loop is asked
	 * for: a broken source is logged and the shipped graph runs instead, which is what a user typing
	 * a half-finished graph expects. A named graph lookup gets the real error.
	 */
	get<S>(id?: string): CompiledGraph<S> {
		const source = this.source();
		try {
			const parsed = parseGraphSource(source);
			const wanted = id ?? parsed.default;
			const graph = this.compile(source).get(wanted);
			if (!graph) {
				throw new GraphError(`graph ${wanted} is not defined`);
			}
			return graph as CompiledGraph<S>;
		} catch (error) {
			if (id !== undefined) {
				throw error;
			}
			this.ctx.log.message(`graph error: ${describe(error)}; using the default graph`);
			const fallback = parseGraphSource(DEFAULT_GRAPH_SOURCE);
			const graph = this.compile(DEFAULT_GRAPH_SOURCE).get(fallback.default);
			if (!graph) {
				throw error;
			}
			return graph as CompiledGraph<S>;
		}
	}

	private compile(source: string): Map<string, CompiledGraph<unknown>> {
		if (this.cache && this.cache.source === source && this.cache.version === this.version) {
			return this.cache.compiled;
		}
		const parsed = parseGraphSource(source);
		const registry = {
			nodes: this.nodes as unknown as Map<string, NodeFn<unknown>>,
			routes: this.routes as unknown as Map<string, RouteFn<unknown>>,
		} satisfies GraphRegistry<unknown>;
		const compiled = compileGraphs(parsed, registry) as Map<string, CompiledGraph<unknown>>;
		this.cache = { source, version: this.version, compiled };
		return compiled;
	}

	private touch(): void {
		this.version += 1;
		this.cache = null;
		this.ctx.emit('graphs/changed');
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const graphPlugin = Graphs;
