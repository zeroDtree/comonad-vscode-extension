import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Service, type Context } from 'cordis';

/**
 * Shadow-git checkpoints. One repository per session and workspace path, stored
 * outside the project (`GIT_DIR` points at the shadow repo). The user's own
 * repository is never touched.
 */

export interface DiffLine {
	type: 'add' | 'del' | 'ctx' | 'meta';
	text: string;
}

export interface DiffHunk {
	header: string;
	lines: DiffLine[];
}

export interface DiffFile {
	path: string;
	additions: number;
	deletions: number;
	untracked: boolean;
	hunks: DiffHunk[];
	patch: string;
}

export interface WorkspaceDiff {
	available: boolean;
	files: DiffFile[];
	error?: string;
}

interface Repo {
	dir: string;
	work: string;
}

interface GitResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

declare module 'cordis' {
	interface Context {
		checkpoints: Checkpoints;
	}
}

export class Checkpoints extends Service {
	static inject = ['host'];

	constructor(ctx: Context) {
		super(ctx, 'checkpoints');
	}

	private get root(): string {
		return this.ctx.host.storage.checkpoints;
	}

	/** Capture the workspace tree as an orphan commit keyed by `id`. Idempotent. */
	async capture(workspace: string, sessionId: string, id: string): Promise<void> {
		const repo = await this.open(workspace, sessionId);
		const record = join(repo.dir, 'marks', `${checkpointId(id)}.json`);
		if (await exists(record)) {
			return;
		}
		const index = join(repo.dir, `tmp-${checkpointId(id)}`);
		try {
			const empty = await git(repo, ['read-tree', '--empty'], index);
			if (empty.code !== 0) {
				throw new Error(empty.stderr || 'could not snapshot the workspace');
			}
			const added = await git(repo, ['add', '-A'], index);
			if (added.code !== 0) {
				throw new Error(added.stderr || 'could not snapshot the workspace');
			}
			const tree = await git(repo, ['write-tree'], index);
			if (tree.code !== 0 || !tree.stdout.trim()) {
				throw new Error(tree.stderr || 'could not snapshot the workspace');
			}
			const commit = await git(repo, ['commit-tree', tree.stdout.trim(), '-m', checkpointId(id)]);
			if (commit.code !== 0 || !commit.stdout.trim()) {
				throw new Error(commit.stderr || 'could not snapshot the workspace');
			}
			await mkdir(join(repo.dir, 'marks'), { recursive: true });
			await writeFile(record, JSON.stringify({ commit: commit.stdout.trim() }));
		} finally {
			await unlink(index).catch(() => undefined);
		}
		this.ctx.emit('checkpoints/changed');
	}

	/** Restore the workspace and the accept index to a checkpoint. */
	async revert(workspace: string, sessionId: string, id: string): Promise<void> {
		const repo = await this.open(workspace, sessionId);
		const stored = JSON.parse(await readFile(join(repo.dir, 'marks', `${checkpointId(id)}.json`), 'utf8')) as { commit?: string };
		const commit = stored.commit ?? '';
		if (!/^[0-9a-f]{40}$/i.test(commit)) {
			throw new Error('checkpoint record is invalid');
		}
		const reset = await git(repo, ['read-tree', '-u', '--reset', commit]);
		if (reset.code !== 0) {
			throw new Error(reset.stderr || 'could not restore the workspace');
		}
		const cleaned = await git(repo, ['clean', '-fd']);
		if (cleaned.code !== 0) {
			throw new Error(cleaned.stderr || 'could not restore the workspace');
		}
		this.ctx.emit('checkpoints/changed');
	}

	async hasSession(workspace: string, sessionId: string): Promise<boolean> {
		if (!workspace.trim() || !sessionId.trim()) {
			return false;
		}
		return exists(repoDir(this.root, workspace, sessionId));
	}

	/** Pending changes: worktree versus the accept index. */
	async diff(workspace: string, sessionId: string): Promise<WorkspaceDiff> {
		if (!workspace.trim() || !sessionId.trim() || !(await this.hasSession(workspace, sessionId))) {
			return { available: false, files: [] };
		}
		try {
			const repo = await this.open(workspace, sessionId);
			const [unstaged, untracked] = await Promise.all([
				git(repo, ['diff', '--no-ext-diff']),
				git(repo, ['ls-files', '--others', '--exclude-standard', '-z']),
			]);
			const created = await Promise.all(
				untracked.stdout
					.split('\0')
					.filter(Boolean)
					.map((file) => git(repo, ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', file])),
			);
			const files = [...parseUnified(unstaged.stdout), ...created.flatMap((item) => parseUnified(item.stdout))];
			return { available: true, files };
		} catch (error) {
			return { available: false, files: [], error: error instanceof Error ? error.message : String(error) };
		}
	}

	async keep(workspace: string, sessionId: string, file: string, hunk?: number): Promise<void> {
		const repo = await this.open(workspace, sessionId);
		const target = await this.pendingFile(workspace, sessionId, file);
		if (hunk === undefined) {
			const added = await git(repo, ['add', '--', target.path]);
			if (added.code !== 0) {
				throw new Error(added.stderr || 'git add failed');
			}
			this.ctx.emit('checkpoints/changed');
			return;
		}
		const applied = await gitInput(repo, ['apply', '--cached'], hunkPatch(target, hunk));
		if (applied.code !== 0) {
			throw new Error(applied.stderr || 'could not accept this hunk');
		}
		this.ctx.emit('checkpoints/changed');
	}

	async undo(workspace: string, sessionId: string, file: string, hunk?: number): Promise<void> {
		const repo = await this.open(workspace, sessionId);
		const target = await this.pendingFile(workspace, sessionId, file);
		if (hunk === undefined) {
			if (target.untracked) {
				await unlink(safeJoin(resolve(workspace), target.path));
				this.ctx.emit('checkpoints/changed');
				return;
			}
			const restored = await git(repo, ['checkout', '--', target.path]);
			if (restored.code !== 0) {
				throw new Error(restored.stderr || 'git checkout failed');
			}
			this.ctx.emit('checkpoints/changed');
			return;
		}
		const applied = await gitInput(repo, ['apply', '--reverse'], hunkPatch(target, hunk));
		if (applied.code !== 0) {
			throw new Error(applied.stderr || 'could not undo this hunk');
		}
		this.ctx.emit('checkpoints/changed');
	}

	/** Content of the accepted (index) version of a file, for diff editors. */
	async indexContent(workspace: string, sessionId: string, file: string): Promise<string | null> {
		if (!(await this.hasSession(workspace, sessionId))) {
			return null;
		}
		const repo = await this.open(workspace, sessionId);
		const result = await git(repo, ['show', `:${file}`]);
		return result.code === 0 ? result.stdout : null;
	}

	/** Housekeeping for the shadow repository; fire and forget. */
	async gc(workspace: string, sessionId: string): Promise<void> {
		if (!workspace || !(await this.hasSession(workspace, sessionId))) {
			return;
		}
		try {
			const repo = await this.open(workspace, sessionId);
			await git(repo, ['gc', '--auto', '--quiet']);
		} catch {
			// gc failures are harmless
		}
	}

	private async pendingFile(workspace: string, sessionId: string, file: string): Promise<DiffFile> {
		const path = relativePath(file);
		const diff = await this.diff(workspace, sessionId);
		const found = diff.files.find((item) => item.path === path);
		if (!found) {
			throw new Error('file is not pending review');
		}
		return found;
	}

	private async open(workspace: string, sessionId: string): Promise<Repo> {
		const work = resolve(workspace);
		const dir = repoDir(this.root, work, sessionId);
		await mkdir(dir, { recursive: true });
		const repo = { dir, work };
		const inside = await git(repo, ['rev-parse', '--is-inside-work-tree']);
		if (inside.stdout.trim() === 'true') {
			return repo;
		}
		const init = await git(repo, ['init']);
		if (init.code !== 0) {
			throw new Error(init.stderr || 'could not initialize the shadow repository');
		}
		await git(repo, ['config', 'user.email', 'comonad@localhost']);
		await git(repo, ['config', 'user.name', 'comonad']);
		const added = await git(repo, ['add', '-A']);
		if (added.code !== 0) {
			throw new Error(added.stderr || 'could not snapshot the workspace');
		}
		const committed = await git(repo, ['commit', '--allow-empty', '-m', 'baseline']);
		if (committed.code !== 0) {
			throw new Error(committed.stderr || 'could not commit the baseline');
		}
		return repo;
	}
}

export const checkpointsPlugin = Checkpoints;

function repoDir(root: string, workspace: string, sessionId: string): string {
	const session = createHash('sha1').update(sessionId).digest('hex').slice(0, 20);
	const path = createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 16);
	return join(root, session, path);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function checkpointId(id: string): string {
	const clean = id.replaceAll('-', '');
	if (!/^[0-9a-f]{8,64}$/i.test(clean)) {
		return createHash('sha1').update(id).digest('hex');
	}
	return clean;
}

function git(repo: Repo, args: string[], index?: string): Promise<GitResult> {
	return gitInput(repo, args, '', index);
}

function gitInput(repo: Repo, args: string[], input: string, index?: string): Promise<GitResult> {
	return new Promise((resolvePromise) => {
		const child = spawn('git', args, {
			cwd: repo.work,
			env: {
				...process.env,
				GIT_DIR: repo.dir,
				GIT_WORK_TREE: repo.work,
				...(index ? { GIT_INDEX_FILE: index } : {}),
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => child.kill(), 15_000);
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('error', () => {
			clearTimeout(timer);
			resolvePromise({ code: 1, stdout: '', stderr: '' });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolvePromise({ code, stdout, stderr });
		});
		child.stdin.end(input);
	});
}

export function parseUnified(text: string): DiffFile[] {
	const parts = text
		.split(/^diff --git /m)
		.map((part) => part.trim())
		.filter(Boolean);
	return parts.flatMap((part) => {
		const patch = `diff --git ${part}\n`;
		const lines = patch.split('\n');
		const match = (lines[0] ?? '').match(/^diff --git a\/(.+) b\/(.+)$/);
		const path = unquote(match?.[2] ?? '');
		if (!path) {
			return [];
		}
		const untracked = lines.some((line) => line === '--- /dev/null' || line.startsWith('new file mode'));
		const raw: DiffHunk[] = [];
		let current: DiffHunk | null = null;
		for (const line of lines) {
			if (line.startsWith('@@')) {
				current = { header: line, lines: [] };
				raw.push(current);
				continue;
			}
			if (!current || line === '') {
				continue;
			}
			if (line.startsWith('+')) {
				current.lines.push({ type: 'add', text: line.slice(1) });
			} else if (line.startsWith('-')) {
				current.lines.push({ type: 'del', text: line.slice(1) });
			} else if (line.startsWith(' ')) {
				current.lines.push({ type: 'ctx', text: line.slice(1) });
			} else if (line.startsWith('\\')) {
				current.lines.push({ type: 'meta', text: line });
			}
		}
		const hunks = raw.flatMap(splitHunk);
		const additions = hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.type === 'add').length, 0);
		const deletions = hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.type === 'del').length, 0);
		return [{ path, additions, deletions, untracked, hunks, patch }];
	});
}

function splitHunk(hunk: DiffHunk): DiffHunk[] {
	const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header);
	let oldLine = Number(match?.[1] ?? 1);
	let newLine = Number(match?.[3] ?? 1);
	const blocks: DiffHunk[] = [];
	let pending: DiffLine | null = null;
	let pendingOld = oldLine;
	let pendingNew = newLine;
	let block: DiffLine[] | null = null;
	let blockOld = oldLine;
	let blockNew = newLine;
	const emit = (trailing: DiffLine | null) => {
		if (!block) {
			return;
		}
		const lines = trailing ? [...block, trailing] : [...block];
		const oldCount = lines.filter((line) => line.type === 'ctx' || line.type === 'del').length;
		const newCount = lines.filter((line) => line.type === 'ctx' || line.type === 'add').length;
		blocks.push({ header: `@@ -${blockOld},${oldCount} +${blockNew},${newCount} @@`, lines });
		block = null;
	};
	for (const line of hunk.lines) {
		if (line.type === 'meta') {
			if (block) {
				block.push(line);
			}
			continue;
		}
		if (line.type === 'ctx') {
			if (block) {
				emit(line);
			}
			pending = line;
			pendingOld = oldLine;
			pendingNew = newLine;
			oldLine += 1;
			newLine += 1;
			continue;
		}
		if (!block) {
			block = pending ? [pending] : [];
			blockOld = pending ? pendingOld : oldLine;
			blockNew = pending ? pendingNew : newLine;
		}
		block.push(line);
		if (line.type === 'del') {
			oldLine += 1;
		} else {
			newLine += 1;
		}
	}
	emit(null);
	return blocks;
}

function hunkPatch(file: DiffFile, index: number): string {
	const hunk = file.hunks[index];
	if (!hunk) {
		throw new Error('hunk is missing');
	}
	const lines = file.patch.split('\n');
	const cut = lines.findIndex((line) => line.startsWith('@@'));
	const head = (cut === -1 ? lines : lines.slice(0, cut)).filter((line) => line !== '');
	const body = [
		hunk.header,
		...hunk.lines.map((line) => (line.type === 'meta' ? line.text : `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}${line.text}`)),
	];
	return `${head.join('\n')}\n${body.join('\n')}\n`;
}

function relativePath(file: string): string {
	const clean = file.replaceAll('\\', '/').replace(/^\.\//, '');
	if (!clean || clean.includes('\0') || clean.startsWith('/') || clean.split('/').includes('..')) {
		throw new Error('invalid path');
	}
	return clean;
}

function safeJoin(cwd: string, file: string): string {
	return join(cwd, relativePath(file));
}

function unquote(path: string): string {
	if (path.startsWith('"') && path.endsWith('"')) {
		try {
			return JSON.parse(path) as string;
		} catch {
			return path;
		}
	}
	return path;
}
