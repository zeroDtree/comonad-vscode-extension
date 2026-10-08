import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Service, type Context } from 'cordis';
import { sanitizedEnv, shellArgv } from '../lib/sandbox';
import type { BackgroundTask, TaskApi } from '../lib/types';

const MAX_OUTPUT = 400_000;

declare module 'cordis' {
	interface Context {
		tasks: Tasks;
	}
}

/**
 * Background shell tasks. They run outside the OS sandbox with the user's account,
 * so the policy gate still approves each `start_shell` call. Children are killed
 * when the service unloads.
 */
export class Tasks extends Service implements TaskApi {
	static inject = ['host', 'settings'];

	private readonly running = new Map<string, { task: BackgroundTask; child: ChildProcess }>();

	constructor(ctx: Context) {
		super(ctx, 'tasks');
		ctx.effect(() => () => this.killAll());
	}

	start(command: string, cwd: string): BackgroundTask {
		const id = randomUUID().slice(0, 8);
		const task: BackgroundTask = { id, command, cwd, startedAt: Date.now(), output: '', exitCode: null };
		const argv = shellArgv(command);
		const env = this.ctx.settings.get().filterSensitiveEnv ? sanitizedEnv() : undefined;
		const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
		const append = (chunk: string) => {
			task.output = `${task.output}${chunk}`.slice(-MAX_OUTPUT);
		};
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', append);
		child.stderr?.on('data', append);
		child.on('error', (error) => {
			task.exitCode = 1;
			append(`\n[spawn error] ${error.message}`);
			this.notify(`Background command ${id} failed to start`);
			this.changed();
		});
		child.on('close', (code) => {
			task.exitCode = code ?? 1;
			this.notify(`Background command ${id} exited with ${task.exitCode}`);
			this.changed();
		});
		this.running.set(id, { task, child });
		this.changed();
		return task;
	}

	read(id: string, tail = 120): string {
		const entry = this.running.get(id);
		if (!entry) {
			return `Error: unknown task ${id}`;
		}
		const state = entry.task.exitCode === null ? 'running' : `exited ${entry.task.exitCode}`;
		const lines = entry.task.output.split('\n');
		const slice = lines.slice(Math.max(0, lines.length - Math.max(1, tail)));
		return `task ${id} (${state})\n${slice.join('\n')}`;
	}

	stop(id: string): boolean {
		const entry = this.running.get(id);
		if (!entry || entry.task.exitCode !== null) {
			return false;
		}
		entry.child.kill('SIGTERM');
		return true;
	}

	list(): BackgroundTask[] {
		return [...this.running.values()].map((entry) => entry.task);
	}

	killAll(): void {
		for (const entry of this.running.values()) {
			if (entry.task.exitCode === null) {
				entry.child.kill('SIGKILL');
			}
		}
		this.running.clear();
		this.changed();
	}

	private changed(): void {
		this.ctx.emit('tasks/changed');
	}

	private notify(message: string): void {
		this.ctx.host.notify(message);
	}
}

export const tasksPlugin = Tasks;
