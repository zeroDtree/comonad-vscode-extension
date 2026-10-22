// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { abortable } from './cancel';
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
	const inside = !rel.startsWith('..') && !isAbsolute(rel);
	const name = target.replaceAll('\\', '/').split('/').pop() ?? '';
	return patterns.some((pattern) => {
		// An absolute pattern names a place on disk, not a path inside the workspace: it must apply
		// even when the target itself is outside (the resolver reads outside when confinement allows it).
		if (isAbsolute(pattern)) {
			if (isInside(pattern, target)) {
				return true;
			}
			// Temp directories are symlinked on macOS (`/var` → `/private/var`), and `guardPath`
			// compares real paths. Match the pattern's real path as well, without failing on a
			// pattern that does not exist.
			try {
				return isInside(realpathSync(pattern), target);
			} catch {
				return false;
			}
		}
		if (!inside) {
			return false;
		}
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
	/** The turn's cancellation for foreground commands. Background tasks never receive it. */
	signal?: AbortSignal;
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
	/** Killed because the turn was stopped, not because the deadline passed. */
	aborted: boolean;
}

export type SandboxKind = 'macos' | 'bwrap' | 'none';

/**
 * The path a sandbox should mount. bwrap cannot create a mount point below a symlinked path
 * component (`Can't mkdir …: No such file or directory`), and seatbelt profiles the real path the
 * kernel checks, so both builders take the canonical spelling. A missing path stays as given: the
 * sandbox will report its own failure rather than a fabricated one.
 */
function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * An executable on PATH, with the system folders as a fallback: an extension host launched by a
 * window manager can carry a PATH that misses `/usr/bin`, and a sandbox that exists must not look
 * absent because of it. The scan is cheap and deliberately uncached — a stale cache would be worse.
 */
function findExecutable(name: string, path = process.env.PATH): string | undefined {
	for (const dir of [...(path ?? '').split(delimiter), '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
		if (!dir) {
			continue;
		}
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not in this folder.
		}
	}
	return undefined;
}

export function sandboxKind(): SandboxKind {
	if (platform() === 'darwin' && findExecutable('sandbox-exec')) {
		return 'macos';
	}
	if (platform() === 'linux' && findExecutable('bwrap')) {
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

/**
 * Secret-shaped names, not values: the test is the variable's role, not the word "auth" inside
 * `GIT_AUTHOR_NAME` or `SSH_AUTH_SOCK`, which a sandboxed git still needs.
 */
const SENSITIVE_ENV =
	/(?:^|_)(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|AUTH[_-]?(?:TOKEN|KEY|SECRET))(?:_|$)/i;

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

const LOGIN_START = '<<<COMONAD_PATH_START>>>';
const LOGIN_END = '<<<COMONAD_PATH_END>>>';
const LOGIN_TIMEOUT_MS = 4_000;
const LOGIN_RETRY_MS = 30_000;

/**
 * The argv that asks a login shell for its PATH. `-lic` reads the rc files an interactive login
 * shell reads — where users put `PATH` — and the sentinels let banners and prompts be ignored.
 * The extension host is not started by that shell (Remote-SSH, a window manager), so its own PATH
 * is the wrong answer for the user's commands.
 */
export function loginShellArgv(
	shell = process.env.SHELL || (platform() === 'darwin' ? '/bin/zsh' : '/bin/bash'),
	flags = '-lic',
): string[] | null {
	if (platform() === 'win32' || !shell || !isAbsolute(shell)) {
		return null;
	}
	const script = `printf '%s' '${LOGIN_START}'; printenv PATH; printf '%s' '${LOGIN_END}'`;
	return [shell, flags, script];
}

/** The PATH between the last pair of sentinels; banners before and after it are ignored. */
export function parseLoginPath(output: string): string | undefined {
	const end = output.lastIndexOf(LOGIN_END);
	if (end < 0) {
		return undefined;
	}
	const start = output.lastIndexOf(LOGIN_START, end);
	const value = start < 0 ? '' : output.slice(start + LOGIN_START.length, end).trim();
	return value.includes('/') ? value : undefined;
}

/** The user's own entries first, then anything only the extension host had — order preserved. */
export function mergePath(login: string | undefined, base: string | undefined): string | undefined {
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const value of [login, base]) {
		for (const entry of (value ?? '').split(delimiter)) {
			if (entry && !seen.has(entry)) {
				seen.add(entry);
				parts.push(entry);
			}
		}
	}
	return parts.length ? parts.join(delimiter) : undefined;
}

let resolvedLoginPath: string | undefined;
let loginWarm: Promise<string | undefined> | undefined;
let loginFailedAt = 0;

/** The login shell's PATH once resolved; `undefined` until then or when the shell could not answer. */
export function loginPathNow(): string | undefined {
	return resolvedLoginPath;
}

/** One probe: the PATH it read, and whether a second flag spelling is worth trying. */
interface LoginProbe {
	path?: string;
	retry: boolean;
}

async function readLoginPath(flags: string): Promise<LoginProbe> {
	const argv = loginShellArgv(undefined, flags);
	if (!argv) {
		return { retry: false };
	}
	try {
		const result = await runProcess(argv, homedir(), LOGIN_TIMEOUT_MS);
		// A shell that ran but printed no path may not accept the flag spelling; one that hung is
		// not asked again — the retry would spend another timeout on the same broken rc.
		return { path: parseLoginPath(result.stdout), retry: !result.timedOut };
	} catch {
		return { retry: false };
	}
}

/**
 * Resolves the login shell's PATH once. A failure is not sticky forever: a broken rc fixed during
 * the session gets another chance after the cooldown. It never rejects — a command runs with the
 * inherited PATH rather than fail because the user's shell was slow.
 */
export function warmLoginPath(): Promise<string | undefined> {
	if (resolvedLoginPath) {
		return Promise.resolve(resolvedLoginPath);
	}
	if (loginWarm) {
		return loginWarm;
	}
	if (loginFailedAt && Date.now() - loginFailedAt < LOGIN_RETRY_MS) {
		return Promise.resolve(undefined);
	}
	loginWarm = (async () => {
		try {
			const first = await readLoginPath('-lic');
			const found = first.path ?? (first.retry ? (await readLoginPath('-lc')).path : undefined);
			if (!found) {
				loginFailedAt = Date.now();
				return undefined;
			}
			resolvedLoginPath = found;
			loginFailedAt = 0;
			return found;
		} finally {
			loginWarm = undefined;
		}
	})();
	return loginWarm;
}

/** The PATH a child should search: the login shell's, then whatever the host added. */
function effectivePath(): string {
	return mergePath(loginPathNow(), process.env.PATH) ?? process.env.PATH ?? '';
}

/** `.git` is never writable by agent tools, even inside the workspace. */
export function isProtectedPath(workspace: string, target: string): boolean {
	const rel = relative(resolve(workspace), resolve(target)).replaceAll('\\', '/');
	return rel === '.git' || rel.startsWith('.git/');
}

/**
 * The scratch directory a write-confined shell gets. It sits inside the workspace, so the boundary
 * that refuses writes elsewhere still holds while `mktemp` and test runners keep working.
 */
export function workspaceTempDir(workspace: string): string {
	return join(canonicalPath(workspace), '.comonad', 'tmp');
}

/**
 * The environment a sandboxed child gets: secrets stripped unless the user turned that off, the
 * login shell's PATH in front of the host's, and a TMPDIR the child can actually write to.
 * `undefined` keeps Node's inherit-everything behaviour when there is nothing to adjust.
 *
 * bwrap always gets its private /tmp. Once writes are confined the host temp directory lies outside
 * the boundary, so both sandboxes point TMPDIR at a workspace scratch directory instead of leaving
 * every `mktemp` to fail with EPERM; the directory is created here, before the command starts.
 */
export function sandboxEnv(
	options: SandboxOptions,
	kind: SandboxKind = sandboxKind(),
	loginPath: string | undefined = loginPathNow(),
	cwd?: string,
): NodeJS.ProcessEnv | undefined {
	const sandboxed = kind !== 'none' && options.mode !== 'direct';
	const scratch =
		sandboxed && options.writable && options.confinement.write && cwd?.trim()
			? workspaceTempDir(cwd)
			: undefined;
	const wantsTmp = kind === 'bwrap' && options.mode !== 'direct';
	if (options.filterEnv === false && !loginPath && !wantsTmp && !scratch) {
		return undefined;
	}
	const env = options.filterEnv === false ? { ...process.env } : sanitizedEnv();
	if (loginPath) {
		env.PATH = mergePath(loginPath, env.PATH);
	}
	if (scratch) {
		env.TMPDIR = scratch;
		try {
			mkdirSync(scratch, { recursive: true });
		} catch {
			// An unwritable workspace is the command's failure to report, not this helper's to pre-empt.
		}
	} else if (wantsTmp) {
		env.TMPDIR = '/tmp';
	}
	return env;
}

/** The argv that runs `argv` under the OS sandbox, or `null` when there is none to apply. */
function sandboxArgv(argv: string[], cwd: string, options: SandboxOptions): string[] | null {
	if (options.mode === 'direct') {
		return null;
	}
	const kind = sandboxKind();
	if (kind === 'macos') {
		const exe = findExecutable('sandbox-exec');
		return exe ? [exe, '-p', buildSbpl(cwd, options), '--', ...argv] : null;
	}
	if (kind === 'bwrap') {
		const exe = findExecutable('bwrap');
		return exe ? bwrapArguments(exe, argv, cwd, options) : null;
	}
	return null;
}

/** A bare command name searches the same PATH the child gets, not the host's alone. */
function executable(file: string, env: NodeJS.ProcessEnv | undefined): string {
	if (platform() === 'win32' || file.includes('/')) {
		return file;
	}
	return findExecutable(file, env?.PATH ?? process.env.PATH) ?? file;
}

export async function runCommand(argv: string[], cwd: string, options: SandboxOptions): Promise<RunResult> {
	// The login-shell probe can take seconds on a fresh host; a stopped turn should not wait for it.
	try {
		await abortable(options.signal, warmLoginPath());
	} catch (error) {
		if (options.signal?.aborted) {
			return { code: 1, stdout: '', stderr: '', timedOut: false, aborted: true };
		}
		throw error;
	}
	const env = sandboxEnv(options, sandboxKind(), loginPathNow(), cwd);
	const sandboxed = sandboxArgv(argv, cwd, options) ?? argv;
	return runProcess(sandboxed, cwd, options.timeoutMs, env, options.signal);
}

/**
 * Starts a command under the OS sandbox and hands back the running child, for callers that read its
 * output as it arrives instead of waiting for it to exit.
 */
export function spawnSandboxed(argv: string[], cwd: string, options: SandboxOptions): ChildProcess {
	const env = sandboxEnv(options, sandboxKind(), loginPathNow(), cwd);
	const sandboxed = sandboxArgv(argv, cwd, options) ?? argv;
	return spawn(executable(sandboxed[0]!, env), sandboxed.slice(1), spawnOptions(cwd, env));
}

/** Children lead their own group on POSIX, so a signal can reach the whole tree without the host's. */
function spawnOptions(cwd: string, env: NodeJS.ProcessEnv | undefined): SpawnOptions {
	return {
		cwd,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: platform() !== 'win32',
		windowsHide: platform() === 'win32',
	};
}

/**
 * Kill a spawned command and its descendants. POSIX signals the child's process group; Windows
 * uses taskkill's tree. Only call this on children spawned detached on POSIX.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
	const pid = child.pid;
	if (!pid) {
		return;
	}
	if (platform() === 'win32') {
		spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
		try {
			child.kill();
		} catch {
			// Already gone.
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Already gone.
		}
	}
}

export function runProcess(
	argv: string[],
	cwd: string,
	timeoutMs: number,
	env?: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<RunResult> {
	if (signal?.aborted) {
		return Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false, aborted: true });
	}
	return new Promise((resolvePromise, reject) => {
		const child = spawn(executable(argv[0]!, env), argv.slice(1), spawnOptions(cwd, env));
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let aborted = false;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let drain: NodeJS.Timeout | undefined;
		const finish = (result: RunResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			clearTimeout(drain);
			signal?.removeEventListener('abort', onAbort);
			// A pipe-holding grandchild must not keep the turn waiting after the tree was killed.
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolvePromise(result);
		};
		const kill = (why: 'timeout' | 'abort'): void => {
			if (settled) {
				return;
			}
			if (why === 'timeout') {
				timedOut = true;
			} else {
				aborted = true;
			}
			killProcessTree(child);
			// Do not wait for `close`: it arrives only after every inherited pipe is gone.
			clearTimeout(drain);
			drain = setTimeout(() => finish({ code: child.exitCode ?? 1, stdout, stderr, timedOut, aborted }), 100);
		};
		const onAbort = (): void => kill('abort');
		timer = setTimeout(() => kill('timeout'), Math.max(250, timeoutMs));
		signal?.addEventListener('abort', onAbort, { once: true });
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('error', (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			clearTimeout(drain);
			signal?.removeEventListener('abort', onAbort);
			reject(error);
		});
		child.on('exit', (code) => {
			// The process is gone, so its deadline no longer applies: a timer that fired after this
			// would call a finished command timed out and kill the group it deliberately left behind.
			clearTimeout(timer);
			if (timedOut || aborted) {
				finish({ code: code ?? 1, stdout, stderr, timedOut, aborted });
				return;
			}
			// A daemonized grandchild can hold the pipes open forever; settle shortly after exit.
			drain = setTimeout(() => finish({ code: code ?? 1, stdout, stderr, timedOut, aborted }), 1_000);
		});
		child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr, timedOut, aborted }));
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
	const root = canonicalPath(workspace);
	const lines = ['(version 1)', '(allow default)'];
	// SBPL is last-match-wins: an allow for the workspace does not close writes outside it, so the
	// deny has to come first. Without it, confineWrite did nothing on macOS.
	if (!options.writable || options.confinement.write) {
		lines.push('(deny file-write*)');
	}
	if (options.writable && options.confinement.write) {
		lines.push(`(allow file-write* (subpath "${quote(root)}"))`);
	}
	lines.push('(allow file-write* (literal "/dev/null"))');
	if (options.confinement.read) {
		// Reads start closed, so the boundary is the allow-list below rather than a deny-list.
		lines.push('(deny file-read*)');
	}
	lines.push(`(allow file-read* (subpath "${quote(root)}"))`);
	for (const denyPath of options.denyReadPaths) {
		if (denyPath && denyPath.includes('/')) {
			const denied = canonicalPath(denyPath);
			lines.push(`(deny file-read* (subpath "${quote(denied)}"))`);
			lines.push(`(deny file-write* (subpath "${quote(denied)}"))`);
		}
	}
	for (const prefix of [...SYSTEM_READ_PREFIXES, process.execPath.replace(/\/[^/]+$/, '')]) {
		if (prefix) {
			lines.push(`(allow file-read* (subpath "${quote(prefix)}"))`);
		}
	}
	// The shell still has to be able to read the binaries it runs: the login PATH can point at
	// directories the system prefixes above do not cover.
	for (const entry of effectivePath().split(delimiter).filter(Boolean)) {
		lines.push(`(allow file-read* (subpath "${quote(entry)}"))`);
	}
	if (options.network) {
		lines.push('(allow network*)');
	} else {
		// Everything off except loopback, which a test server or an IPC client needs. The filters
		// are spelled per operation: `local ip` on `network*` also admits outbound traffic.
		lines.push('(deny network*)');
		lines.push('(allow network* (local unix-socket))');
		lines.push('(allow network-bind (local ip "localhost:*"))');
		lines.push('(allow network-inbound (local ip "localhost:*"))');
		lines.push('(allow network-outbound (remote ip "localhost:*"))');
	}
	return lines.join('\n');
}

/** Read-only system mounts a confined shell needs to run at all. */
const SYSTEM_BIND_PREFIXES = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/System', '/opt/homebrew'];

export function bwrapArguments(bwrap: string, command: string[], cwd: string, options: SandboxOptions): string[] {
	const root = canonicalPath(cwd);
	const tmpRoot = canonicalPath('/tmp');
	const openWrite = options.writable && !options.confinement.write;
	const args = [bwrap, '--die-with-parent'];
	if (!options.network) {
		args.push('--unshare-net');
	}
	// The base view goes on first: a later mount wins over an earlier one for the same destination,
	// so everything below it — the special mounts and the workspace — is what the shell actually sees.
	const openRead = !options.confinement.read;
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
		for (const entry of effectivePath().split(delimiter).filter(Boolean)) {
			if (existsSync(entry)) {
				args.push('--ro-bind', entry, entry);
			}
		}
	}
	args.push('--proc', '/proc', '--dev', '/dev');
	// A private /tmp, never the host's: writable only when writes are open, otherwise remounted
	// read-only after the workspace bind, so a workspace under /tmp keeps its own writable mount.
	if (root !== tmpRoot) {
		args.push('--tmpfs', '/tmp');
	}
	args.push(options.writable ? '--bind' : '--ro-bind', root, root);
	for (const denyPath of options.denyReadPaths) {
		if (existsSync(denyPath)) {
			args.push('--ro-bind', '/dev/null', canonicalPath(denyPath));
		}
	}
	if (root !== tmpRoot && !openWrite) {
		args.push('--remount-ro', '/tmp');
	}
	args.push('--chdir', root, '--', ...(options.network ? command : loopbackCommand(command)));
	return args;
}

/**
 * A private network namespace starts with `lo` down. Bring it up when the image has a tool for it,
 * so a test server can listen while the outside stays unreachable; `exec` keeps the exit code.
 */
const LOOPBACK_UP =
	'command -v ip >/dev/null 2>&1 && ip link set lo up >/dev/null 2>&1; command -v ifconfig >/dev/null 2>&1 && ifconfig lo up >/dev/null 2>&1; exec "$@"';

function loopbackCommand(command: string[]): string[] {
	return ['/bin/sh', '-c', LOOPBACK_UP, 'comonad-loopback', ...command];
}
