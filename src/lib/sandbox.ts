import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { platform } from 'node:os';
import type { Confinement } from './types';

/** Path guards, OS sandboxing and process helpers. Pure module (Node only, no vscode). */

export class PathEscapeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PathEscapeError';
	}
}

export function resolveInside(root: string, input: string): string {
	const base = resolve(root);
	const target = resolve(base, input);
	const rel = relative(base, target);
	if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
		return target;
	}
	throw new PathEscapeError(`path escapes the workspace: ${input}`);
}

/** Whether `target` sits at or under `root`. Both sides must already be resolved. */
export function isInside(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isDeniedRead(workspace: string, target: string, patterns: readonly string[]): boolean {
	const rel = relative(resolve(workspace), resolve(target)).replaceAll('\\', '/');
	if (rel.startsWith('..') || isAbsolute(rel)) {
		return false;
	}
	const name = target.replaceAll('\\', '/').split('/').pop() ?? '';
	return patterns.some((pattern) => {
		if (pattern === '.env') {
			return rel === '.env';
		}
		if (pattern === '**/.env') {
			return name === '.env';
		}
		return rel === pattern || name === pattern;
	});
}

/** How a path argument is resolved and how far it may reach. */
export interface GuardOptions {
	access: 'read' | 'write';
	confinement: Confinement;
	denyReadPaths: readonly string[];
}

/** The workspace root with symlinks resolved, so containment compares real path with real path. */
async function realRoot(workspace: string): Promise<string> {
	const base = resolve(workspace);
	try {
		return await realpath(base);
	} catch {
		return base;
	}
}

/**
 * The real path of `target`. A path that does not exist yet is resolved through its nearest existing
 * ancestor, so a symlinked parent is caught before the write lands behind it.
 */
async function realTarget(target: string): Promise<string> {
	try {
		return await realpath(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	const missing: string[] = [];
	let current = target;
	for (;;) {
		const parent = dirname(current);
		if (parent === current) {
			return target;
		}
		missing.unshift(basename(current));
		current = parent;
		try {
			return join(await realpath(current), ...missing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
	}
}

/**
 * Resolves a tool's path argument for the workspace boundary. The boundary is checked against real
 * paths — which is what makes it hold, since a link inside the workspace cannot reach outside it —
 * while the path handed back is the one the rest of the app knows: resolved against the workspace as
 * configured, so the journal, the editor and the checkpoint repo keep speaking the same paths.
 */
export async function guardPath(workspace: string, input: string, options: GuardOptions): Promise<string> {
	if (!workspace.trim()) {
		throw new PathEscapeError(`no working directory is set for ${input}`);
	}
	const target = resolve(resolve(workspace), input);
	const real = await realTarget(target);
	const root = await realRoot(workspace);
	const confine = options.access === 'read' ? options.confinement.read : options.confinement.write;
	if (confine && !isInside(root, real)) {
		throw new PathEscapeError(`path escapes the workspace: ${input}`);
	}
	if (isDeniedRead(root, real, options.denyReadPaths)) {
		throw new PathEscapeError(`${options.access === 'read' ? 'reading' : 'writing'} ${input} is denied by policy`);
	}
	if (options.access === 'write' && isProtectedPath(root, real)) {
		throw new PathEscapeError('the .git directory is protected; use git commands through the shell for repository changes');
	}
	return target;
}

export interface SandboxOptions {
	writable: boolean;
	/** How far outside the working directory reads and writes may reach. */
	confinement: Confinement;
	network: boolean;
	denyReadPaths: readonly string[];
	timeoutMs: number;
	/** `direct` skips the OS sandbox; the policy gate forces confirmation for such tools. */
	mode?: 'sandbox' | 'direct';
	/** Remove secret-shaped environment variables before spawning. Defaults to true. */
	filterEnv?: boolean;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export type SandboxKind = 'macos' | 'bwrap' | 'none';

export function sandboxKind(): SandboxKind {
	if (platform() === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
		return 'macos';
	}
	if (platform() === 'linux' && existsSync('/usr/bin/bwrap')) {
		return 'bwrap';
	}
	return 'none';
}

export function shellArgv(command: string): string[] {
	if (platform() === 'win32') {
		return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command];
	}
	return ['/bin/sh', '-c', command];
}

const SENSITIVE_ENV = /(api[_-]?key|secret|token|password|passwd|credential|auth)/i;

/** Copy of the environment without secret-shaped variables (API keys, tokens, passwords). */
export function sanitizedEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!SENSITIVE_ENV.test(key)) {
			env[key] = value;
		}
	}
	return env;
}

/** `.git` is never writable by agent tools, even inside the workspace. */
export function isProtectedPath(workspace: string, target: string): boolean {
	const rel = relative(resolve(workspace), resolve(target)).replaceAll('\\', '/');
	return rel === '.git' || rel.startsWith('.git/');
}

/** The environment a sandboxed child gets: secrets stripped, unless the user turned that off. */
function sandboxEnv(options: SandboxOptions): NodeJS.ProcessEnv | undefined {
	return options.filterEnv === false ? undefined : sanitizedEnv();
}

/** The argv that runs `argv` under the OS sandbox, or `null` when there is none to apply. */
function sandboxArgv(argv: string[], cwd: string, options: SandboxOptions): string[] | null {
	if (options.mode === 'direct') {
		return null;
	}
	const kind = sandboxKind();
	if (kind === 'macos') {
		return ['/usr/bin/sandbox-exec', '-p', buildSbpl(cwd, options), '--', ...argv];
	}
	if (kind === 'bwrap') {
		return bwrapArguments('/usr/bin/bwrap', argv, cwd, options);
	}
	return null;
}

export async function runCommand(argv: string[], cwd: string, options: SandboxOptions): Promise<RunResult> {
	const sandboxed = sandboxArgv(argv, cwd, options) ?? argv;
	return runProcess(sandboxed, cwd, options.timeoutMs, sandboxEnv(options));
}

/**
 * Starts a command under the OS sandbox and hands back the running child, for callers that read its
 * output as it arrives instead of waiting for it to exit.
 */
export function spawnSandboxed(argv: string[], cwd: string, options: SandboxOptions): ChildProcess {
	const sandboxed = sandboxArgv(argv, cwd, options) ?? argv;
	return spawn(sandboxed[0]!, sandboxed.slice(1), { cwd, env: sandboxEnv(options), stdio: ['ignore', 'pipe', 'pipe'] });
}

export function runProcess(argv: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<RunResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, Math.max(250, timeoutMs));
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolvePromise({ code: code ?? 1, stdout, stderr, timedOut });
		});
	});
}

export function formatResult(result: RunResult, limit = 30_000): string {
	const clipText = (text: string) => (text.length > limit ? `${text.slice(0, limit)}\n[...truncated, ${text.length} chars]` : text);
	const parts = [`exit_code: ${result.code}`];
	if (result.timedOut) {
		parts.push('timed_out: true');
	}
	if (result.stdout) {
		parts.push(`stdout:\n${clipText(result.stdout)}`);
	}
	if (result.stderr) {
		parts.push(`stderr:\n${clipText(result.stderr)}`);
	}
	return parts.join('\n');
}

const SYSTEM_READ_PREFIXES = [
	'/usr',
	'/bin',
	'/sbin',
	'/private/tmp',
	'/var',
	'/etc',
	'/opt',
	'/Library',
	'/System',
	'/Applications',
	'/dev',
];

function quote(path: string): string {
	return path.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function buildSbpl(workspace: string, options: SandboxOptions): string {
	const lines = ['(version 1)', '(allow default)'];
	if (!options.writable) {
		lines.push('(deny file-write*)');
	} else if (options.confinement.write) {
		lines.push(`(allow file-write* (subpath "${quote(workspace)}"))`);
	}
	lines.push('(allow file-write* (literal "/dev/null"))');
	if (options.confinement.read) {
		// Reads start closed, so the boundary is the allow-list below rather than a deny-list.
		lines.push('(deny file-read*)');
	}
	lines.push(`(allow file-read* (subpath "${quote(workspace)}"))`);
	for (const denyPath of options.denyReadPaths) {
		if (denyPath && denyPath.includes('/')) {
			lines.push(`(deny file-read* (subpath "${quote(denyPath)}"))`);
			lines.push(`(deny file-write* (subpath "${quote(denyPath)}"))`);
		}
	}
	for (const prefix of [...SYSTEM_READ_PREFIXES, process.execPath.replace(/\/[^/]+$/, '')]) {
		if (prefix) {
			lines.push(`(allow file-read* (subpath "${quote(prefix)}"))`);
		}
	}
	if (options.network) {
		lines.push('(allow network*)');
	} else {
		lines.push('(deny network*)');
		lines.push('(allow network* (local unix-socket))');
	}
	return lines.join('\n');
}

/** Read-only system mounts a confined shell needs to run at all. */
const SYSTEM_BIND_PREFIXES = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/System', '/opt/homebrew'];

export function bwrapArguments(bwrap: string, command: string[], cwd: string, options: SandboxOptions): string[] {
	const args = [bwrap, '--die-with-parent'];
	if (!options.network) {
		args.push('--unshare-net');
	}
	// The base view goes on first: a later mount wins over an earlier one for the same destination,
	// so everything below it — the special mounts and the workspace — is what the shell actually sees.
	const openRead = !options.confinement.read;
	const openWrite = !options.confinement.write && options.writable;
	if (openWrite) {
		args.push('--bind', '/', '/');
	} else if (openRead) {
		args.push('--ro-bind', '/', '/');
	} else {
		for (const prefix of SYSTEM_BIND_PREFIXES) {
			if (existsSync(prefix)) {
				args.push('--ro-bind', prefix, prefix);
			}
		}
		for (const entry of (process.env.PATH ?? '').split(':').filter(Boolean)) {
			if (existsSync(entry)) {
				args.push('--ro-bind', entry, entry);
			}
		}
	}
	args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
	args.push(options.writable ? '--bind' : '--ro-bind', cwd, cwd);
	for (const denyPath of options.denyReadPaths) {
		if (existsSync(denyPath)) {
			args.push('--ro-bind', '/dev/null', denyPath);
		}
	}
	args.push('--chdir', cwd, '--', ...command);
	return args;
}
