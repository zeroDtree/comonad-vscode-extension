import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Service, type Context } from 'cordis';
import { parseRule, ruleMatches } from '../lib/policy';
import { shellArgv } from '../lib/sandbox';
import type { ToolCall } from '../lib/types';

/**
 * Lifecycle hooks. Configuration is JSON with Claude Code style events:
 * `{ "PreToolUse": [{ "matcher": "run_shell", "hooks": [...] }] }`.
 */

export interface CommandHook {
	type: 'command';
	command: string;
	args?: string[];
	async?: boolean;
	timeout?: number;
	if?: string;
}

export interface HttpHook {
	type: 'http';
	url: string;
	headers?: Record<string, string>;
	timeout?: number;
	if?: string;
}

export interface McpToolHook {
	type: 'mcp_tool';
	server: string;
	tool: string;
	input?: Record<string, unknown>;
	if?: string;
}

export interface PromptHook {
	type: 'prompt';
	prompt: string;
	model?: string;
	if?: string;
}

export type HookHandler = CommandHook | HttpHook | McpToolHook | PromptHook;

export interface HookGroup {
	matcher?: string;
	hooks: HookHandler[];
}

export type HookConfig = Record<string, HookGroup[]>;

export interface HookOutcome {
	blocked?: boolean;
	reason?: string;
	decision?: 'allow' | 'deny' | 'ask';
	contexts: string[];
	updatedInput?: Record<string, unknown>;
}

const DEFAULT_TIMEOUT = 30_000;

interface HookContext {
	event: string;
	matchValue: string | undefined;
	input: object;
	cwd: string;
}

declare module 'cordis' {
	interface Context {
		hooks: Hooks;
	}
}

export class Hooks extends Service {
	static inject = ['settings', 'llm', 'host', 'log'];

	private queued: string[] = [];

	constructor(ctx: Context) {
		super(ctx, 'hooks');
	}

	/** Contexts produced by async hooks since the last drain. */
	drainContexts(): string[] {
		const contexts = this.queued;
		this.queued = [];
		return contexts;
	}

	async fire(event: string, matchValue: string | undefined, input: object): Promise<HookOutcome> {
		const config = this.load();
		const groups = (config[event] ?? []).filter((group) => matcherMatches(group.matcher, matchValue));
		const handlers = groups.flatMap((group) => group.hooks ?? []);
		if (handlers.length === 0) {
			return { contexts: [] };
		}
		const context: HookContext = { event, matchValue, input, cwd: this.ctx.host.workspace() };
		const outcomes = await Promise.all(handlers.map((handler) => this.run(handler, context)));
		const merged: HookOutcome = { contexts: [] };
		for (const outcome of outcomes) {
			if (!outcome) {
				continue;
			}
			merged.contexts.push(...outcome.contexts);
			if (outcome.blocked) {
				merged.blocked = true;
				merged.reason = outcome.reason ?? merged.reason;
				continue;
			}
			if (outcome.decision === 'deny') {
				merged.blocked = true;
				merged.reason = outcome.reason ?? merged.reason;
			} else if (outcome.decision === 'ask' && !merged.blocked) {
				merged.decision = merged.decision === 'deny' ? 'deny' : 'ask';
				merged.reason = merged.reason ?? outcome.reason;
			} else if (outcome.decision === 'allow' && !merged.decision) {
				merged.decision = 'allow';
			}
			if (outcome.updatedInput) {
				merged.updatedInput = { ...merged.updatedInput, ...outcome.updatedInput };
			}
		}
		return merged;
	}

	/** User hooks, project hooks (trusted workspaces only), project last. */
	load(): HookConfig {
		const merged: HookConfig = {};
		const host = this.ctx.host;
		const files = [join(host.storage.root, 'hooks.json')];
		if (host.trusted() && host.workspace()) {
			files.push(join(host.workspace(), '.comonad', 'hooks.json'));
		}
		for (const file of files) {
			try {
				const parsed = JSON.parse(readFileSync(file, 'utf8')) as HookConfig;
				for (const [event, groups] of Object.entries(parsed)) {
					if (Array.isArray(groups)) {
						merged[event] = [...(merged[event] ?? []), ...groups];
					}
				}
			} catch {
				// missing or malformed hook files are ignored
			}
		}
		return merged;
	}

	private async run(handler: HookHandler, context: HookContext): Promise<HookOutcome | null> {
		if (!this.allowed(handler, context.input)) {
			return null;
		}
		if (handler.type === 'command' && handler.async) {
			void this.runCommand(handler, context).then((outcome) => {
				if (outcome?.contexts.length) {
					this.queued.push(...outcome.contexts);
				}
			});
			return null;
		}
		try {
			switch (handler.type) {
				case 'command':
					return await this.runCommand(handler, context);
				case 'http':
					return await this.runHttp(handler, context);
				case 'mcp_tool':
					return await this.runMcp(handler, context);
				case 'prompt':
					return await this.runPrompt(handler, context);
				default:
					return null;
			}
		} catch (error) {
			this.ctx.log.message(`hook ${handler.type} failed: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	private allowed(handler: HookHandler, input: object): boolean {
		if (!handler.if) {
			return true;
		}
		const record = input as { tool_name?: unknown; tool_input?: unknown };
		const name = typeof record.tool_name === 'string' ? record.tool_name : '';
		if (!name) {
			return false;
		}
		const call: ToolCall = { id: 'hook', name, arguments: JSON.stringify(record.tool_input ?? {}) };
		const rule = parseRule(handler.if);
		return rule ? ruleMatches(rule, call, undefined) : false;
	}

	private async runCommand(handler: CommandHook, context: HookContext): Promise<HookOutcome> {
		const argv = handler.args?.length ? [handler.command, ...handler.args] : shellArgv(handler.command);
		const timeout = handler.timeout ?? DEFAULT_TIMEOUT;
		const result = await withStdin(argv, context.cwd, JSON.stringify(context.input), timeout);
		const outcome: HookOutcome = { contexts: [] };
		if (result.code === 2) {
			outcome.blocked = true;
			outcome.reason = result.stderr.trim() || 'blocked by hook';
			return outcome;
		}
		const parsed = parseHookJson(result.stdout);
		if (!parsed) {
			return outcome;
		}
		applyHookJson(parsed, outcome);
		return outcome;
	}

	private async runHttp(handler: HttpHook, context: HookContext): Promise<HookOutcome> {
		const response = await fetch(handler.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(handler.headers ?? {}) },
			body: JSON.stringify(context.input),
			signal: AbortSignal.timeout(handler.timeout ?? DEFAULT_TIMEOUT),
		});
		const outcome: HookOutcome = { contexts: [] };
		if (!response.ok) {
			return outcome;
		}
		const text = await response.text();
		const parsed = parseHookJson(text);
		if (parsed) {
			applyHookJson(parsed, outcome);
		}
		return outcome;
	}

	private async runMcp(handler: McpToolHook, context: HookContext): Promise<HookOutcome> {
		const outcome: HookOutcome = { contexts: [] };
		const mcp = this.ctx.get('mcp');
		if (!mcp) {
			return outcome;
		}
		const input = Object.fromEntries(
			Object.entries(handler.input ?? {}).map(([key, value]) => [
				key,
				typeof value === 'string' ? value.replace('${tool_input}', JSON.stringify((context.input as { tool_input?: unknown }).tool_input ?? {})) : value,
			]),
		);
		const parsed = parseHookJson(await mcp.callTool(handler.server, handler.tool, input));
		if (parsed) {
			applyHookJson(parsed, outcome);
		}
		return outcome;
	}

	private async runPrompt(handler: PromptHook, context: HookContext): Promise<HookOutcome> {
		const outcome: HookOutcome = { contexts: [] };
		const prompt = handler.prompt.includes('$ARGUMENTS')
			? handler.prompt.replaceAll('$ARGUMENTS', JSON.stringify(context.input))
			: `${handler.prompt}\n\n${JSON.stringify(context.input)}`;
		const text = await this.ctx.llm.complete(
			handler.model ?? this.ctx.settings.get().model,
			'You are a policy evaluator for a coding agent. Reply with JSON {"ok": true} or {"ok": false, "reason": "..."} only.',
			prompt,
			60_000,
		);
		const parsed = parseHookJson(text);
		if (parsed && parsed.ok === false) {
			outcome.blocked = true;
			outcome.reason = typeof parsed.reason === 'string' ? parsed.reason : 'blocked by prompt hook';
			return outcome;
		}
		if (parsed && typeof parsed.additionalContext === 'string') {
			outcome.contexts.push(parsed.additionalContext);
		}
		return outcome;
	}
}

export const hooksPlugin = Hooks;

export function matcherMatches(matcher: string | undefined, value: string | undefined): boolean {
	if (!matcher || matcher === '*') {
		return true;
	}
	const target = value ?? '';
	if (/^[\w\s,|-]+$/.test(matcher)) {
		return matcher
			.split(/[|,]/)
			.map((item) => item.trim())
			.filter(Boolean)
			.includes(target);
	}
	try {
		return new RegExp(matcher).test(target);
	} catch {
		return false;
	}
}

function parseHookJson(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith('{')) {
		return null;
	}
	try {
		return JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		const match = trimmed.match(/\{[\s\S]*\}/);
		if (!match) {
			return null;
		}
		try {
			return JSON.parse(match[0]) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
}

function applyHookJson(parsed: Record<string, unknown>, outcome: HookOutcome): void {
	const specific = (parsed.hookSpecificOutput ?? {}) as Record<string, unknown>;
	const decision = specific.permissionDecision ?? parsed.permissionDecision;
	if (decision === 'deny' || decision === 'ask' || decision === 'allow') {
		outcome.decision = decision;
		const reason = specific.permissionDecisionReason ?? parsed.permissionDecisionReason;
		if (typeof reason === 'string' && reason) {
			outcome.reason = reason;
		}
	}
	if (parsed.decision === 'block') {
		outcome.blocked = true;
		outcome.reason = typeof parsed.reason === 'string' ? parsed.reason : 'blocked by hook';
	}
	if (typeof specific.additionalContext === 'string' && specific.additionalContext) {
		outcome.contexts.push(specific.additionalContext);
	}
	if (specific.updatedInput && typeof specific.updatedInput === 'object') {
		outcome.updatedInput = specific.updatedInput as Record<string, unknown>;
	}
}

function withStdin(argv: string[], cwd: string, input: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		const finish = (code: number) => {
			clearTimeout(timer);
			resolvePromise({ code, stdout, stderr });
		};
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('error', () => finish(1));
		child.on('close', (code) => finish(code ?? 1));
		child.stdin.end(input);
	});
}
