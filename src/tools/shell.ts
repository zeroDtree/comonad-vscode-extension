// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, statSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { formatResult, runCommand, shellArgv, sandboxKind, type SandboxKind } from '../lib/sandbox';
import { creationTargets, rmTargets } from '../lib/shell';
import { objectSchema, type Confinement, type ToolContext } from '../lib/types';
import { toolset } from '../services/tools';

/** Shell tools with OS sandboxing (sandbox-exec on macOS, bwrap on Linux). */

type Presence = 'present' | 'absent' | 'unknown';

/** Only ENOENT proves a path absent; a permission error must not become provenance. */
async function presence(path: string): Promise<Presence> {
	try {
		await lstat(path);
		return 'present';
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
	}
}

async function createdFile(path: string): Promise<boolean> {
	try {
		return !(await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function run(ctx: ToolContext, command: string, writable: boolean): Promise<string> {
	const workspace = ctx.policy.workingDirectory;
	const track = process.platform !== 'win32' && Boolean(workspace.trim());
	const creates = track ? creationTargets(command, workspace) : [];
	const removals = track ? rmTargets(command, workspace) : [];
	const before = await Promise.all(creates.map(presence));
	const result = await runCommand(shellArgv(command), workspace, shellOptions(ctx, writable));
	for (let index = 0; index < creates.length; index += 1) {
		const path = creates[index]!;
		if (before[index] === 'absent' && (await createdFile(path))) {
			ctx.noteCreated?.(path);
		}
	}
	// A parsed rm that actually removed the path makes its provenance stale: a later user file at
	// the same path must not inherit the exemption.
	for (const path of removals) {
		if ((await presence(path)) === 'absent') {
			ctx.noteDeleted?.(path);
		}
	}
	return formatResult(result);
}

/** The boundary a shell tool runs under, from the session policy. */
function shellOptions(ctx: ToolContext, writable: boolean) {
	const workspace = ctx.policy.workingDirectory;
	return {
		writable,
		confinement: ctx.policy.confinement,
		network: ctx.policy.network,
		denyReadPaths: deniedFiles(workspace, ctx.policy.denyReadPaths),
		timeoutMs: ctx.policy.commandTimeout * 1000,
		filterEnv: ctx.sensitiveEnv !== false,
	};
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

/** Reports the OS sandbox in use and what the workspace boundary currently covers. */
export function sandboxStatus(confinement: Confinement, kind: SandboxKind = sandboxKind()): string {
	const engine = kind === 'none' ? 'no OS sandbox available' : `sandbox: ${kind === 'macos' ? 'sandbox-exec' : kind}`;
	const boundary = [
		confinement.read ? 'reads' : null,
		confinement.write ? 'writes' : null,
	].filter(Boolean).join(' and ') || 'nothing';
	return `${engine} · confined to the workspace: ${boundary}`;
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
		name: 'start_shell',
		description:
			'Start a long-running shell command in the background. Read output with shell_output.',
		capability: 'shell_rw',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ command: { type: 'string' } }, ['command']),
		async execute(args, ctx) {
			const { command } = args as { command: string };
			const task = await ctx.tasks.start(command, ctx.policy.workingDirectory, shellOptions(ctx, true));
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
