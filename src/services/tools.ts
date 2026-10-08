import { Service, type Context, type Plugin } from 'cordis';
import { capabilityAllowed } from '../lib/policy';
import { hasWorkspace, type SessionPolicy, type ToolCall, type ToolContext, type ToolSpec } from '../lib/types';

export interface ToolFilter {
	allow?: string[];
	deny?: string[];
}

declare module 'cordis' {
	interface Context {
		tools: Tools;
	}
}

/**
 * The tool registry. `register()` is called from a tool plugin's apply and is an
 * effect of that plugin: unmount the plugin and its tools disappear.
 */
export class Tools extends Service {
	private readonly specs = new Map<string, ToolSpec>();

	constructor(ctx: Context) {
		super(ctx, 'tools');
	}

	register(spec: ToolSpec): void {
		this.ctx.effect(
			() => {
				this.specs.set(spec.name, spec);
				this.ctx.emit('tools/changed');
				return () => {
					this.specs.delete(spec.name);
					this.ctx.emit('tools/changed');
				};
			},
			`ctx.tools.register(${JSON.stringify(spec.name)})`,
		);
	}

	get(name: string): ToolSpec | undefined {
		return this.specs.get(name);
	}

	all(): ToolSpec[] {
		return [...this.specs.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	visible(policy: SessionPolicy, filter?: ToolFilter): ToolSpec[] {
		return this.all().filter((tool) => {
			if (!capabilityAllowed(tool.capability, policy.workMode)) {
				return false;
			}
			if (tool.needsNetwork && !policy.network) {
				return false;
			}
			if (tool.needsWorkspace && !hasWorkspace(policy)) {
				return false;
			}
			if (filter?.allow && !filter.allow.includes(tool.name)) {
				return false;
			}
			if (filter?.deny?.includes(tool.name)) {
				return false;
			}
			return true;
		});
	}

	async invoke(call: ToolCall, ctx: ToolContext): Promise<string> {
		const tool = this.get(call.name);
		if (!tool) {
			return `Error: unknown tool ${call.name}`;
		}
		if (!capabilityAllowed(tool.capability, ctx.policy.workMode)) {
			return `Error: tool ${call.name} is not allowed in mode ${ctx.policy.workMode}`;
		}
		if (tool.needsNetwork && !ctx.policy.network) {
			return 'Error: network is disabled for this session';
		}
		if (tool.needsWorkspace && !hasWorkspace(ctx.policy)) {
			return 'Error: this session has no working directory';
		}
		let args: unknown = {};
		if (call.arguments.trim()) {
			try {
				args = JSON.parse(call.arguments) as unknown;
			} catch {
				return `Error: arguments for ${call.name} are not valid JSON`;
			}
		}
		try {
			const output = await tool.execute(args, ctx);
			return output.length > 60_000 ? `${output.slice(0, 60_000)}\n[...truncated, ${output.length} chars]` : output;
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}

export const toolsPlugin = Tools;

/** Wraps a list of tool specs into a plugin that registers them on mount. */
export function toolset(specs: readonly ToolSpec[]): Plugin.Function {
	const plugin: Plugin.Function = (ctx) => {
		for (const spec of specs) {
			ctx.tools.register(spec);
		}
	};
	plugin.inject = ['tools'];
	return plugin;
}
