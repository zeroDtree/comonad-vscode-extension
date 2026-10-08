import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { platform } from 'node:os';

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

export function assertReadable(workspace: string, target: string, patterns: readonly string[]): void {
	if (isDeniedRead(workspace, target, patterns)) {
		throw new PathEscapeError(`reading ${target} is denied by policy`);
	}
}

export interface SandboxOptions {
	writable: boolean;
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

export async function runCommand(argv: string[], cwd: string, options: SandboxOptions): Promise<RunResult> {
	const env = options.filterEnv === false ? undefined : sanitizedEnv();
	if (options.mode === 'direct') {
		return runProcess(argv, cwd, options.timeoutMs, env);
	}
	const kind = sandboxKind();
	if (kind === 'macos') {
		const profile = buildSbpl(cwd, options);
		return runProcess(['/usr/bin/sandbox-exec', '-p', profile, '--', ...argv], cwd, options.timeoutMs, env);
	}
	if (kind === 'bwrap') {
		return runProcess(bwrapArguments('/usr/bin/bwrap', argv, cwd, options), cwd, options.timeoutMs, env);
	}
	return runProcess(argv, cwd, options.timeoutMs, env);
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
	} else {
		lines.push(`(allow file-write* (subpath "${quote(workspace)}"))`);
	}
	lines.push('(allow file-write* (literal "/dev/null"))');
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

export function bwrapArguments(bwrap: string, command: string[], cwd: string, options: SandboxOptions): string[] {
	const args = [bwrap, '--die-with-parent', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
	if (!options.network) {
		args.push('--unshare-net');
	}
	for (const prefix of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/System', '/opt/homebrew']) {
		if (existsSync(prefix)) {
			args.push('--ro-bind', prefix, prefix);
		}
	}
	for (const entry of (process.env.PATH ?? '').split(':').filter(Boolean)) {
		if (existsSync(entry)) {
			args.push('--ro-bind', entry, entry);
		}
	}
	args.push(options.writable ? '--bind' : '--ro-bind', cwd, cwd);
	args.push('--chdir', cwd, '--', ...command);
	return args;
}
