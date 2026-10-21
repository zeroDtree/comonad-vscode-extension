// SPDX-License-Identifier: AGPL-3.0-only
import { Service, type Context, type Plugin } from 'cordis';
import { abortable } from '../lib/cancel';
import { capabilityAllowed } from '../lib/policy';
import { mergeToolLayout } from '../lib/prompt-layout';
import { hasWorkspace, type SessionPolicy, type ToolCall, type ToolContext, type ToolImage, type ToolSpec } from '../lib/types';

export interface ToolFilter {
	allow?: string[];
	deny?: string[];
}

/**
 * One call, as the policy pipeline sees it: the shape the DeepSeek Harness hands to its
 * `tools/pre-execute` and friends, so a plugin written for one runs on the other.
 */
export interface ToolExecution {
	/** The model's call id. */
	readonly callId: string;
	/** The root call, for a nested dispatch: the same id here, because Comonad dispatches flat. */
	readonly rootCallId: string;
	readonly name: string;
	/** Parsed arguments, frozen: a policy layer may refuse a call, never rewrite what was logged. */
	readonly arguments: unknown;
	readonly sessionId: string;
	/** This call's cancellation. A `tools/execute` wrapper may replace it; nothing else may. */
	signal: AbortSignal;
}

/** A settled call: what the model is told, whether it was a failure, and any images it carries. */
export interface ToolOutcome {
	content: string;
	isError: boolean;
	images?: ToolImage[];
}

/** Model-facing text: Comonad speaks strings, the harness speaks content blocks; both are read. */
export type ToolContent = string | readonly { text?: string }[] | undefined;

/** `allow` runs the call; `deny` materializes its reason; `ask` goes to the approval surfaces first. */
export type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string };

/** `accept` may replace what the model sees; `block` turns the result into a failure it must read. */
export type PostToolDecision = { kind: 'accept'; content?: ToolContent } | { kind: 'block'; feedback: ToolContent };

/** Content blocks, or a string, as the text the model reads. */
export function contentText(content: ToolContent): string {
	if (typeof content === 'string') {
		return content;
	}
	return (content ?? []).map((block) => block?.text ?? '').join('');
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

	/**
	 * Registers a tool. Both shapes are accepted: Comonad's own `ToolSpec`, and the DeepSeek
	 * Harness's `ToolDefinition` (see `harnessSpec`), so a tool plugin written for the harness
	 * works here unchanged. Registration is an effect of the calling plugin: unmount it and its
	 * tools disappear.
	 */
	register(spec: ToolSpec): void;
	/** The DeepSeek Harness's own definition shape (`defineTool`), adapted (`harnessSpec`). */
	register(spec: HarnessToolDefinition): void;
	register(spec: ToolSpec | HarnessToolDefinition): void {
		const tool = 'execute' in spec && !('capability' in spec) ? harnessSpec(spec) : (spec as ToolSpec);
		this.ctx.effect(
			() => {
				this.specs.set(tool.name, tool);
				this.ctx.emit('tools/changed');
				return () => {
					this.specs.delete(tool.name);
					this.ctx.emit('tools/changed');
				};
			},
			`ctx.tools.register(${JSON.stringify(tool.name)})`,
		);
	}

	get(name: string): ToolSpec | undefined {
		return this.specs.get(name);
	}

	all(): ToolSpec[] {
		return [...this.specs.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * Every registered tool in the user's order, with its switch from the Prompts tab. A tool the
	 * saved layout does not mention yet follows the configured ones, switched on, alphabetically.
	 */
	layout(): { tool: ToolSpec; enabled: boolean }[] {
		const entries = this.ctx.get('settings')?.get().toolPrompts ?? [];
		return mergeToolLayout(this.all(), entries);
	}

	/** Whether the Prompts tab's switch lets this tool be offered. A tool not in the layout is on. */
	isEnabled(name: string): boolean {
		return this.layout().find((entry) => entry.tool.name === name)?.enabled !== false;
	}

	visible(policy: SessionPolicy, filter?: ToolFilter): ToolSpec[] {
		return this.layout()
			.filter((entry) => entry.enabled)
			.map((entry) => entry.tool)
			.filter((tool) => {
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

	async invoke(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
		ctx.signal.throwIfAborted();
		const tool = this.get(call.name);
		if (!tool) {
			return { content: `Error: unknown tool ${call.name}`, isError: true };
		}
		if (!this.isEnabled(call.name)) {
			return { content: `Error: tool ${call.name} is switched off in Prompts`, isError: true };
		}
		if (!capabilityAllowed(tool.capability, ctx.policy.workMode)) {
			return { content: `Error: tool ${call.name} is not allowed in mode ${ctx.policy.workMode}`, isError: true };
		}
		if (tool.needsNetwork && !ctx.policy.network) {
			return { content: 'Error: network is disabled for this session', isError: true };
		}
		if (tool.needsWorkspace && !hasWorkspace(ctx.policy)) {
			return { content: 'Error: this session has no working directory', isError: true };
		}
		let args: unknown = {};
		if (call.arguments.trim()) {
			try {
				args = JSON.parse(call.arguments) as unknown;
			} catch {
				return { content: `Error: arguments for ${call.name} are not valid JSON`, isError: true };
			}
		}
		// The policy pipeline, named and shaped as the harness names and shapes it: a plugin may
		// refuse the call before it runs, wrap the dispatch, reshape the result, or just watch.
		const exec: ToolExecution = {
			callId: call.id,
			rootCallId: call.id,
			name: call.name,
			arguments: Object.freeze(args),
			sessionId: ctx.sessionId,
			signal: ctx.signal,
		};
		const decision = await abortable(
			exec.signal,
			Promise.resolve(this.ctx.waterfall('tools/pre-execute', exec, () => ({ kind: 'allow' }) as PreToolDecision)),
		);
		if (decision.kind === 'deny') {
			return this.refuse(exec, decision.reason);
		}
		if (decision.kind === 'ask') {
			// No surface is claimed: whichever surface is up answers, and with none up this denies.
			const answer = await this.ctx.approval.request({
				calls: [call],
				reason: decision.reason ?? `confirm ${call.name}`,
				signal: exec.signal,
				sessionId: ctx.sessionId,
			});
			if (answer === 'deny') {
				return this.refuse(exec, decision.reason ?? `${call.name} was not approved`);
			}
		}
		const outcome = await abortable(
			exec.signal,
			Promise.resolve(this.ctx.waterfall('tools/execute', exec, () => this.dispatch(tool, exec, args, ctx))),
		);
		const post = await abortable(
			exec.signal,
			Promise.resolve(this.ctx.waterfall('tools/post-execute', exec, outcome, () => ({ kind: 'accept' }) as PostToolDecision)),
		);
		exec.signal.throwIfAborted();
		if (post.kind === 'block') {
			// A result a hook blocked is an error the model must read, not a picture it should look at.
			outcome.content = `Error: ${contentText(post.feedback)}`;
			outcome.isError = true;
			outcome.images = undefined;
		} else if (post.content !== undefined) {
			// Hooks reshape text only; the images a tool returned are still the tool's answer.
			outcome.content = contentText(post.content);
		}
		this.ctx.emit('tools/result', exec, outcome);
		const text = outcome.content;
		return {
			...outcome,
			content: text.length > 60_000 ? `${text.slice(0, 60_000)}\n[...truncated, ${text.length} chars]` : text,
		};
	}

	/** One dispatch: the tool body, and the failure that stands in for a thrown one. */
	private async dispatch(tool: ToolSpec, exec: ToolExecution, args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
		try {
			// The context carries this execution's signal: a `tools/execute` wrapper that replaced it is
			// the one the tool honours.
			const output = await tool.execute(args, { ...ctx, signal: exec.signal });
			return typeof output === 'string'
				? { content: output, isError: false }
				: { content: output.content, isError: false, images: output.images };
		} catch (error) {
			// A stop is not a failed tool: let it end the turn instead of becoming model-readable text.
			if (exec.signal.aborted) {
				throw error;
			}
			return { content: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
		}
	}

	/**
	 * A refusal the pipeline made: the model is told why, because the model is the one who has to try
	 * something else, and observers see it settle like any other call.
	 */
	private refuse(exec: ToolExecution, reason: string): ToolOutcome {
		const outcome: ToolOutcome = { content: `Error: ${reason}`, isError: true };
		this.ctx.emit('tools/result', exec, outcome);
		return outcome;
	}
}

export const toolsPlugin = Tools;

/**
 * A DeepSeek Harness tool definition, as far as a Comonad tool needs to know: the parts Comonad has
 * no say in are optional, and the parts the harness has no say in get the safe default.
 */
export interface HarnessToolDefinition {
	name: string;
	description?: string;
	parameters?: unknown;
	/** Harness-only metadata (`output`, projections, timeouts): read where it can be, ignored where not. */
	output?: unknown;
	execute: (args: unknown, exec: Record<string, unknown>) => Promise<unknown> | unknown;
	capability?: ToolSpec['capability'];
	needsNetwork?: boolean;
	needsWorkspace?: boolean;
}

/**
 * One harness definition as a Comonad spec. What it returns is stringified unless it is already
 * text, a capability it did not declare is assumed to write (`rw`: visible, but only when the mode
 * allows writing), and a workspace it did not ask for is not required of the session.
 */
export function harnessSpec(definition: HarnessToolDefinition): ToolSpec {
	return {
		name: definition.name,
		description: definition.description ?? '',
		parameters: (definition.parameters ?? { type: 'object' }) as ToolSpec['parameters'],
		capability: definition.capability ?? 'rw',
		needsNetwork: definition.needsNetwork ?? false,
		needsWorkspace: definition.needsWorkspace ?? false,
		async execute(args, ctx) {
			const value = await definition.execute(args, {
				sessionId: ctx.sessionId,
				workspace: ctx.workspace,
				signal: ctx.signal,
				log: ctx.log,
				ask: ctx.ask,
			});
			if (typeof value === 'string') {
				return value;
			}
			try {
				return JSON.stringify(value ?? null, null, 2) ?? '';
			} catch {
				return String(value);
			}
		},
	};
}

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
