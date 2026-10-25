// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Service, type Context } from 'cordis';
import { formatResult, runCommand, shellArgv } from '../lib/sandbox';
import type { DiagnosticLine } from '../lib/types';
import { workflowPane } from '../ui/workflow-pane';
import {
	afterCheck,
	approveGate,
	beginCheck,
	denyGate,
	enterStage,
	stageDirective,
	failStage,
	finalizeRun,
	finishStage,
	nextStep,
	normalizeWorkflowLibrary,
	resolveWorkflow,
	rewindTo,
	sanitizeWorkflowRun,
	skipStage,
	stagePolicy as policyOf,
	validateLibrary,
	type CheckEntry,
	type CheckInput,
	type CheckReport,
	type WorkflowDefinition,
	type WorkflowLibrary,
	type WorkflowResolveInput,
	type WorkflowRun,
	type WorkflowStage,
	type WorkflowStep,
	type WorkflowValidation,
} from '../lib/workflow';

/** The settings key this plugin owns. The manifest declares it; the kernel does not read it. */
export const WORKFLOW_SETTING_KEYS = ['workflows'] as const;

export type WorkflowResolveRequest = Omit<WorkflowResolveInput, 'library' | 'graphIds'>;

declare module 'cordis' {
	interface Context {
		workflows: Workflows;
	}
	interface Events {
		/** The library moved: the Workflow pane and its commands are stale. */
		'workflows/changed'(): void;
	}
}

/**
 * Workflow definitions, transitions and host checks, as their own plugin. It does not run the agent:
 * the turn driver asks for the next step and runs it. Keeping the model loop out of this service is
 * what lets the workflow plugin be turned off without touching a normal turn.
 */
export class Workflows extends Service {
	static inject = ['host', 'settings', 'graphs', 'sessions', 'commands', 'log'];

	constructor(ctx: Context) {
		super(ctx, 'workflows');
		ctx.commands.register({
			name: 'workflow',
			description: 'Run a workflow for this task (default when no id is named)',
			run: (args, surface) => {
				const trimmed = args.trim();
				const library = this.library();
				if (!trimmed) {
					surface.markdown(workflowList(library));
					return { done: true };
				}
				const first = trimmed.split(/\s+/, 1)[0]!.toLowerCase();
				const named = library.workflows.find((workflow) => workflow.id === first);
				const id = named?.id ?? library.default;
				const task = named ? trimmed.slice(first.length).trim() : trimmed;
				if (!task) {
					surface.markdown(`${workflowList(library)}\n\nDescribe the task after the workflow id.`);
					return { done: true };
				}
				return { done: false, text: task, workflow: id };
			},
		});
		ctx.commands.addHelp('workflow', ['| `/workflow [id] [task]` | run a workflow; no id uses the default |']);
		ctx.inject(['panes'], (scope) => scope.panes.register(workflowPane(ctx)));
	}

	/** The effective library: the user's settings normalized over the shipped preset. */
	library(): WorkflowLibrary {
		return normalizeWorkflowLibrary(this.ctx.host.config().workflows);
	}

	async saveLibrary(value: unknown): Promise<void> {
		await this.ctx.settings.update('workflows', normalizeWorkflowLibrary(value));
		this.ctx.emit('workflows/changed');
	}

	/** The run this turn should start, or undefined when the turn stays a plain graph turn. */
	resolve(input: WorkflowResolveRequest): WorkflowRun | undefined {
		const graphIds = this.ctx.graphs.names();
		if (!graphIds.length) {
			this.ctx.log.message('workflow: the graph source has no valid graphs; staying direct');
			return undefined;
		}
		return resolveWorkflow({ ...input, library: this.library(), graphIds });
	}

	policy(base: Parameters<typeof policyOf>[0], stage: WorkflowStage): ReturnType<typeof policyOf> {
		return policyOf(base, stage);
	}

	directive(run: WorkflowRun, stage: WorkflowStage): string {
		return stageDirective(run, stage);
	}

	enter(run: WorkflowRun, stageId: string): WorkflowRun {
		return enterStage(run, stageId);
	}

	beginCheck(run: WorkflowRun, stageId: string): WorkflowRun {
		return beginCheck(run, stageId);
	}

	finish(run: WorkflowRun, stageId: string, summary?: string): WorkflowRun {
		return finishStage(run, stageId, summary);
	}

	fail(run: WorkflowRun, stageId: string, error: string): WorkflowRun {
		return failStage(run, stageId, error);
	}

	skip(run: WorkflowRun, stageId: string, reason: string): WorkflowRun {
		return skipStage(run, stageId, reason);
	}

	rewind(run: WorkflowRun, stageId: string): WorkflowRun {
		return rewindTo(run, stageId);
	}

	next(run: WorkflowRun): WorkflowStep {
		return nextStep(run);
	}

	afterCheck(run: WorkflowRun, stage: WorkflowStage, report: CheckReport): WorkflowRun {
		return afterCheck(run, stage, report);
	}

	approve(run: WorkflowRun): WorkflowRun {
		return approveGate(run);
	}

	deny(run: WorkflowRun): WorkflowRun {
		return denyGate(run);
	}

	finalize(run: WorkflowRun): WorkflowRun {
		return finalizeRun(run);
	}

	sanitizeRun(value: unknown): WorkflowRun | undefined {
		return sanitizeWorkflowRun(value);
	}

	validate(value: unknown): WorkflowValidation {
		return validateLibrary(value, this.ctx.graphs.names());
	}

	/**
	 * Runs one checks stage. Diagnostics are the host's fresh errors in files this turn wrote;
	 * commands are the user's, run inside the session's boundary. A workspace that is not trusted
	 * does not run commands: they come from workspace settings, and an untrusted folder may not
	 * choose what executes.
	 */
	async check(run: WorkflowRun, stage: WorkflowStage, input: CheckInput): Promise<CheckReport> {
		const checks = stage.checks ?? { diagnostics: true, commands: [], timeout: 120, repairs: 0 };
		const entries: CheckEntry[] = [];
		if (input.writes.length === 0) {
			entries.push({ kind: 'diagnostics', label: 'no files changed', status: 'skipped' });
			return { passed: true, checks: entries };
		}
		if (checks.diagnostics) {
			entries.push(this.diagnostics(input));
		}
		for (const command of checks.commands.slice(0, 8)) {
			entries.push(await this.command(command, checks.timeout, input));
		}
		const passed = entries.every((entry) => entry.status === 'passed' || entry.status === 'skipped');
		return { passed, checks: entries };
	}

	/** Suggests the project's own checks from package.json; the pane asks before using them. */
	async suggestCommands(workspace: string): Promise<string[]> {
		if (!workspace.trim()) {
			return [];
		}
		try {
			const parsed = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
			const scripts = parsed.scripts ?? {};
			const suggested: string[] = [];
			if (typeof scripts.typecheck === 'string') {
				suggested.push('npm run typecheck');
			}
			if (typeof scripts.test === 'string') {
				suggested.push('npm test');
			}
			if (typeof scripts.lint === 'string') {
				suggested.push('npm run lint');
			}
			if (typeof scripts.build === 'string') {
				suggested.push('npm run build');
			}
			return suggested;
		} catch (error) {
			this.ctx.log.message(`workflow: could not read package.json: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	private diagnostics(input: CheckInput): CheckEntry {
		const lines: string[] = [];
		const seen = new Set<string>();
		const absolute = new Set(input.writes.map((path) => join(input.workspace, path)));
		const reported: DiagnosticLine[] = this.ctx.host.diagnostics([...absolute]);
		for (const diagnostic of reported) {
			if (!absolute.has(diagnostic.file)) {
				continue;
			}
			const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`;
			if (input.diagnosticBaseline.has(key) || seen.has(key)) {
				continue;
			}
			seen.add(key);
			lines.push(`${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`);
			if (lines.length >= 50) {
				break;
			}
		}
		if (!reported.length) {
			// The editor had nothing to say: a pass, but the pane also offers commands for real evidence.
			return { kind: 'diagnostics', label: 'editor diagnostics', status: 'passed' };
		}
		return {
			kind: 'diagnostics',
			label: 'editor diagnostics',
			status: lines.length ? 'failed' : 'passed',
			output: lines.length ? lines.join('\n') : undefined,
		};
	}

	private async command(command: string, timeout: number, input: CheckInput): Promise<CheckEntry> {
		if (input.signal.aborted) {
			return { kind: 'command', label: command, status: 'failed', output: 'Stopped by the user.' };
		}
		if (!this.ctx.host.trusted()) {
			return {
				kind: 'command',
				label: command,
				status: 'skipped',
				output: 'Workspace is not trusted: verification commands were not run.',
			};
		}
		const scratch = join(this.ctx.host.storage.tmp, 'workflow', input.sessionId);
		try {
			await mkdir(scratch, { recursive: true });
		} catch (error) {
			this.ctx.log.message(`workflow: could not create scratch: ${describe(error)}`);
		}
		try {
			const result = await runCommand(shellArgv(command), input.workspace, {
				writeScope: input.base.confinement.write ? 'workspace' : 'all',
				scratch,
				confinement: input.base.confinement,
				network: input.base.network,
				denyReadPaths: [...input.base.denyReadPaths],
				timeoutMs: Math.max(1, timeout) * 1_000,
				signal: input.signal,
				filterEnv: this.ctx.settings.get().filterSensitiveEnv,
			});
			const status = result.aborted ? 'failed' : result.timedOut ? 'timed_out' : result.code === 0 ? 'passed' : 'failed';
			return {
				kind: 'command',
				label: command,
				status,
				exitCode: result.code,
				output: result.aborted ? 'Stopped by the user.' : formatResult(result, 4_000),
			};
		} catch (error) {
			return { kind: 'command', label: command, status: 'failed', output: describe(error) };
		}
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function workflowList(library: WorkflowLibrary): string {
	const rows = library.workflows.map(
		(workflow) =>
			`- \`${workflow.id}\` — ${workflow.name} (${workflow.when}${workflow.id === library.default ? ', default' : ''})`,
	);
	return [`**Workflows**${library.enabled ? '' : ' — automatic runs are off'}`, '', ...rows].join('\n');
}

export const workflowPlugin = Workflows;

/** Kept here for the pane and tests: the definition type is part of the plugin's public face. */
export type { WorkflowDefinition };
