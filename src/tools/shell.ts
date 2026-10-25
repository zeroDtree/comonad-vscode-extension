// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, statSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { missingAncestor } from '../lib/created';
import { formatResult, runCommand, shellArgv, sandboxKind, type SandboxKind, type WriteScope } from '../lib/sandbox';
import { creationTargets, directoryTargets, rmTargets } from '../lib/shell';
import { objectSchema, type Confinement, type SessionPolicy, type ToolContext } from '../lib/types';
import { toolset } from '../services/tools';

/** Shell tools with OS sandboxing (sandbox-exec on macOS, bwrap on Linux). */

/** The model may choose a foreground deadline, but not one that can hang a turn. */
export const MIN_SHELL_TIMEOUT_SECONDS = 1;
export const MAX_SHELL_TIMEOUT_SECONDS = 300;
/** Mirrors the settings default, for a corrupt stored policy. */
const DEFAULT_SHELL_TIMEOUT_SECONDS = 60;
/** setTimeout treats delays above 2^31-1 ms as immediate; keep the human value inside its range. */
const TIMER_SAFE_SECONDS = Math.floor(0x7fff_ffff / 1000);

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

async function createdDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** A numeric timeout from tool arguments; numeric strings count, everything else is absent. */
function seconds(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isNaN(value) ? undefined : value;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

/**
 * The deadline for one foreground shell call, in seconds. The model's `timeout` is clamped to
 * 1–300; an absent or non-numeric value falls back to the configured `commandTimeout`. With
 * `commandTimeoutOverride` on, the model's value is discarded. The configured value is the human's
 * decision, so it is not held to the model's cap, only to setTimeout's range.
 */
export function shellTimeoutSeconds(
	policy: Pick<SessionPolicy, 'commandTimeout'> & { commandTimeoutOverride?: boolean },
	requested?: unknown,
): number {
	const configured = seconds(policy.commandTimeout);
	const fallback =
		configured === undefined || configured < MIN_SHELL_TIMEOUT_SECONDS
			? DEFAULT_SHELL_TIMEOUT_SECONDS
			: Math.min(TIMER_SAFE_SECONDS, configured);
	if (policy.commandTimeoutOverride === true) {
		return fallback;
	}
	const asked = seconds(requested);
	return asked === undefined
		? fallback
		: Math.min(MAX_SHELL_TIMEOUT_SECONDS, Math.max(MIN_SHELL_TIMEOUT_SECONDS, asked));
}

async function run(ctx: ToolContext, command: string, writeScope: WriteScope, requestedTimeout?: unknown): Promise<string> {
	const workspace = ctx.policy.workingDirectory;
	// A test shell cannot create workspace files, so its redirections must not become provenance.
	const track = process.platform !== 'win32' && Boolean(workspace.trim()) && writeScope !== 'scratch';
	const creates = track ? creationTargets(command, workspace) : [];
	const removals = track ? rmTargets(command, workspace) : [];
	const before = await Promise.all(creates.map(presence));
	// A literal mkdir names a directory the session may own; remembering the highest missing
	// ancestor before the command keeps the whole subtree owned even for `mkdir -p a/b/c`.
	const directories = track ? await Promise.all(directoryTargets(command, workspace).map((dir) => missingAncestor(dir, workspace))) : [];
	const result = await runCommand(shellArgv(command), workspace, shellOptions(ctx, writeScope, requestedTimeout));
	for (let index = 0; index < creates.length; index += 1) {
		const path = creates[index]!;
		if (before[index] === 'absent' && (await createdFile(path))) {
			ctx.noteCreated?.(path);
		}
	}
	for (const dir of directories) {
		if (dir && (await createdDirectory(dir))) {
			ctx.noteCreatedDir?.(dir);
		}
	}
	// A parsed rm that actually removed the path makes its provenance stale: a later user file at
	// the same path must not inherit the exemption.
	for (const path of removals) {
		if ((await presence(path)) === 'absent') {
			ctx.noteDeleted?.(path);
		}
	}
	const output = formatResult(result);
	// The model has to know where it may put a report; the path is the same inside the sandbox.
	return writeScope === 'scratch' && ctx.scratchDirectory ? `scratch: ${ctx.scratchDirectory}\n${output}` : output;
}

/** A full shell writes the workspace when confined, and the host when the boundary is off. */
function shellScope(policy: SessionPolicy): WriteScope {
	return policy.confinement.write ? 'workspace' : 'all';
}

/** The boundary a shell tool runs under, from the session policy. */
function shellOptions(ctx: ToolContext, writeScope: WriteScope, requestedTimeout?: unknown) {
	const workspace = ctx.policy.workingDirectory;
	return {
		writeScope,
		scratch: ctx.scratchDirectory,
		confinement: ctx.policy.confinement,
		network: ctx.policy.network,
		denyReadPaths: deniedFiles(workspace, ctx.policy.denyReadPaths),
		// Only runCommand reads these; start_shell spawns without a deadline or a turn signal.
		timeoutMs: shellTimeoutSeconds(ctx.policy, requestedTimeout) * 1000,
		signal: ctx.signal,
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

/** The optional per-call deadline both foreground tools share. */
const timeoutParameter = {
	type: 'number',
	minimum: MIN_SHELL_TIMEOUT_SECONDS,
	maximum: MAX_SHELL_TIMEOUT_SECONDS,
	description:
		'Seconds before the command is killed. Defaults to the configured command timeout; clamped to 1–300. The user can pin a fixed value, in which case this is ignored. Use start_shell for work that should keep running.',
};

/** The one-line title the chat card shows; the command itself is the summary below it. */
const descriptionParameter = {
	type: 'string',
	description:
		'A 5–10 word title for this call, shown on the tool card. Describe the intent (e.g. "Run the unit tests"), not the command syntax.',
};

export const shellTools = toolset([
	{
		name: 'run_shell_readonly',
		description:
			'Run a shell command in a read-only sandbox of the workspace. Use for inspection: git, ls, tests that do not write. For a test or build that needs temp space, use run_shell_test. Pass timeout (seconds) to give a slow command more time; the maximum is 300.',
		capability: 'shell_ro',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema(
			{ command: { type: 'string' }, description: descriptionParameter, timeout: timeoutParameter },
			['command', 'description'],
		),
		execute(args, ctx) {
			const { command, timeout } = args as { command: string; timeout?: unknown };
			return run(ctx, command, 'none', timeout);
		},
	},
	{
		name: 'run_shell_test',
		description:
			'Run a command with the workspace read-only and only the scratch directory writable. Use for tests, linters and builds; TMPDIR, HOME, XDG_CACHE_HOME and COMONAD_SCRATCH already point into that directory. Writes to the workspace fail. Pass timeout (seconds) for a slow command; the maximum is 300.',
		capability: 'shell_test',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema(
			{ command: { type: 'string' }, description: descriptionParameter, timeout: timeoutParameter },
			['command', 'description'],
		),
		async execute(args, ctx) {
			const { command, timeout } = args as { command: string; timeout?: unknown };
			// The sandbox is the capability's whole contract. Without one the command would run
			// unconfined, so this refuses even when a gate or a direct caller let the call through.
			if (sandboxKind() === 'none') {
				return 'Error: run_shell_test needs an OS sandbox (sandbox-exec on macOS, bwrap on Linux); none is available';
			}
			if (!ctx.scratchDirectory?.trim()) {
				return 'Error: no scratch directory is configured for this session';
			}
			return run(ctx, command, 'scratch', timeout);
		},
	},
	{
		name: 'run_shell',
		description:
			'Run a shell command in a sandbox that can write inside the workspace. Use for builds, tests and formatters. Pass timeout (seconds) for a slow command; the maximum is 300. Use start_shell for servers and watchers that should keep running.',
		capability: 'shell_rw',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema(
			{ command: { type: 'string' }, description: descriptionParameter, timeout: timeoutParameter },
			['command', 'description'],
		),
		execute(args, ctx) {
			const { command, timeout } = args as { command: string; timeout?: unknown };
			return run(ctx, command, shellScope(ctx.policy), timeout);
		},
	},
	{
		name: 'start_shell',
		description:
			'Start a long-running shell command in the background; it has no timeout. Read output with shell_output.',
		capability: 'shell_rw',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ command: { type: 'string' }, description: descriptionParameter }, ['command', 'description']),
		async execute(args, ctx) {
			const { command } = args as { command: string };
			const task = await ctx.tasks.start(command, ctx.policy.workingDirectory, shellOptions(ctx, shellScope(ctx.policy)));
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
		capability: 'shell_rw',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema({ id: { type: 'string' } }, ['id']),
		async execute(args, ctx) {
			const { id } = args as { id: string };
			return ctx.tasks.stop(id) ? `stopped ${id}` : `task ${id} is not running`;
		},
	},
]);
