// SPDX-License-Identifier: AGPL-3.0-only
import { Service, type Context } from 'cordis';
import {
	compileGraphs,
	GraphError,
	type CompiledGraph,
	type GraphRegistry,
	type NodeFn,
	type RouteFn,
} from '../lib/graph';
import { DEFAULT_GRAPH_SOURCE, parseGraphSource } from '../lib/mermaid';

/** The settings key this plugin owns. The manifest declares it; the kernel no longer reads it. */
export const GRAPH_SETTING_KEYS = ['graph'] as const;

interface Cache {
	source: string;
	version: number;
	compiled: Map<string, CompiledGraph<unknown>>;
}

declare module 'cordis' {
	interface Context {
		graphs: Graphs;
	}
}

/**
 * The graph engine, as its own plugin. It owns the Mermaid source, the node/route registry, parsing
 * and compilation. The agent registers its node implementations here and asks for the compiled graph
 * each turn; another plugin may register more nodes for a custom graph.
 */
export class Graphs extends Service {
	static inject = ['host', 'log'];

	private readonly nodes = new Map<string, NodeFn<unknown>>();
	private readonly routes = new Map<string, RouteFn<unknown>>();
	private version = 0;
	private cache: Cache | null = null;

	constructor(ctx: Context) {
		super(ctx, 'graphs');
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

	/** The configured source, or the shipped one when `comonad.graph` is empty. */
	source(): string {
		const raw = this.ctx.host.config().graph;
		return typeof raw === 'string' && raw.trim() ? raw : DEFAULT_GRAPH_SOURCE;
	}

	/**
	 * Compiles the configured source and returns one graph. With no id the turn's own loop is asked
	 * for: a broken source is logged and the shipped graph runs instead, which is what a user editing
	 * `comonad.graph` by hand expects. A named graph lookup gets the real error.
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
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const graphPlugin = Graphs;
