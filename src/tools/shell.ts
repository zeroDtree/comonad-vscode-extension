import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatResult, runCommand, shellArgv, sandboxKind } from '../lib/sandbox';
import { objectSchema, type ToolContext } from '../lib/types';
import { toolset } from '../services/tools';

/** Shell tools with OS sandboxing (sandbox-exec on macOS, bwrap on Linux). */

async function run(ctx: ToolContext, command: string, writable: boolean, mode: 'sandbox' | 'direct' = 'sandbox'): Promise<string> {
	const workspace = ctx.policy.workingDirectory;
	const result = await runCommand(shellArgv(command), workspace, {
		writable,
		network: ctx.policy.network,
		denyReadPaths: deniedFiles(workspace, ctx.policy.denyReadPaths),
		timeoutMs: ctx.policy.commandTimeout * 1000,
		mode,
		filterEnv: ctx.sensitiveEnv !== false,
	});
	return formatResult(result);
}

/** Resolves deny patterns to absolute paths so the OS sandbox can enforce them. */
function deniedFiles(workspace: string, patterns: readonly string[]): string[] {
	const found = new Set<string>();
	if (patterns.includes('.env')) {
		const direct = join(workspace, '.env');
		if (existsSync(direct)) {
			found.add(direct);
		}
	}
	if (patterns.includes('**/.env')) {
		collect(workspace, found, 0);
	}
	for (const pattern of patterns) {
		if (pattern !== '.env' && pattern !== '**/.env' && !pattern.includes('*') && pattern.includes('/')) {
			found.add(join(workspace, pattern));
		}
	}
	return [...found];
}

function collect(dir: string, found: Set<string>, depth: number): void {
	if (depth > 4) {
		return;
	}
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (name === 'node_modules' || name === '.git' || name === 'dist') {
			continue;
		}
		const path = join(dir, name);
		if (name === '.env') {
			found.add(path);
		} else {
			try {
				if (statSync(path).isDirectory()) {
					collect(path, found, depth + 1);
				}
			} catch {
				// unreadable entries are skipped
			}
		}
	}
}

export function sandboxStatus(): string {
	const kind = sandboxKind();
	return kind === 'none' ? 'no OS sandbox available; commands run with your account' : `sandbox: ${kind}`;
}

export const shellTools = toolset([
	{
		name: 'run_shell_readonly',
		description: 'Run a shell command in a read-only sandbox of the workspace. Use for inspection: git, ls, tests that do not write.',
		capability: 'shell_ro',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ command: { type: 'string' } }, ['command']),
		execute(args, ctx) {
			const { command } = args as { command: string };
			return run(ctx, command, false);
		},
	},
	{
		name: 'run_shell',
		description: 'Run a shell command in a sandbox that can write inside the workspace. Use for builds, tests and formatters.',
		capability: 'shell_rw',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ command: { type: 'string' } }, ['command']),
		execute(args, ctx) {
			const { command } = args as { command: string };
			return run(ctx, command, true);
		},
	},
	{
		name: 'run_shell_unsandboxed',
		description:
			'Run a shell command without the OS sandbox. The user approves every call unless an explicit allow rule exists. Use only when the sandbox blocks a legitimate command.',
		capability: 'shell_rw',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ command: { type: 'string' } }, ['command']),
		execute(args, ctx) {
			const { command } = args as { command: string };
			return run(ctx, command, true, 'direct');
		},
	},
	{
		name: 'start_shell',
		description:
			'Start a long-running shell command in the background. It runs with your user account, outside the sandbox, so prefer foreground commands when possible. Read output with shell_output.',
		capability: 'shell_rw',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ command: { type: 'string' } }, ['command']),
		async execute(args, ctx) {
			const { command } = args as { command: string };
			const task = ctx.tasks.start(command, ctx.policy.workingDirectory);
			return `started task ${task.id}: ${command}`;
		},
	},
	{
		name: 'shell_output',
		description: 'Read the output of a background task started with start_shell.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema({ id: { type: 'string' }, tail: { type: 'number' } }, ['id']),
		async execute(args, ctx) {
			const { id, tail } = args as { id: string; tail?: number };
			return ctx.tasks.read(id, tail);
		},
	},
	{
		name: 'stop_shell',
		description: 'Stop a background task started with start_shell.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema({ id: { type: 'string' } }, ['id']),
		async execute(args, ctx) {
			const { id } = args as { id: string };
			return ctx.tasks.stop(id) ? `stopped ${id}` : `task ${id} is not running`;
		},
	},
]);
