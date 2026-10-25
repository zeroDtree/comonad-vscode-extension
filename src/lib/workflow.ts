// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Workflow domain: the user's workflow library, stage policies, run snapshots and transitions.
 * Pure module — no vscode, no cordis, no shell. The service in `services/workflow.ts` owns IO.
 */

import type { Approval, DiagnosticLine, SessionPolicy, WorkMode } from './types';
import type { GenerationTrigger } from './generations';

export const WORKFLOW_STAGE_MODES = ['inherit', 'ro', 'pl', 'sw', 'aw'] as const;
export type WorkflowStageMode = (typeof WORKFLOW_STAGE_MODES)[number];

export const WORKFLOW_WHENS = ['auto', 'always', 'manual'] as const;
export type WorkflowWhen = (typeof WORKFLOW_WHENS)[number];

export const WORKFLOW_LIMITS = {
	workflows: 32,
	stages: 16,
	commands: 8,
	command: 500,
	objective: 4_000,
	name: 80,
	id: 48,
	summary: 8_000,
	output: 4_000,
} as const;

export interface WorkflowChecks {
	diagnostics: boolean;
	commands: string[];
	/** Seconds. */
	timeout: number;
	/** How many times this checks stage may send the run back to `repairTo`. */
	repairs: number;
	repairTo?: string;
}

export interface WorkflowStage {
	id: string;
	title: string;
	run: 'agent' | 'checks';
	/** Agent stages: the graph id from the Graph plugin. */
	graph?: string;
	mode?: WorkflowStageMode;
	approval?: 'inherit' | 'whitelist_accept';
	objective?: string;
	/** Graph-step budget for this stage; 0/undefined inherits the turn's remaining budget. */
	steps?: number;
	/** Pause after this stage until the user approves. */
	gate?: boolean;
	checks?: WorkflowChecks;
}

export interface WorkflowDefinition {
	id: string;
	name: string;
	description?: string;
	when: WorkflowWhen;
	stages: WorkflowStage[];
}

export interface WorkflowLibrary {
	version: 1;
	/** Master switch. Off still allows /workflow to run one manually. */
	enabled: boolean;
	/** The workflow auto/always uses. */
	default: string;
	workflows: WorkflowDefinition[];
}

export type WorkflowStageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'waiting';
export type WorkflowStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export interface CheckEntry {
	kind: 'diagnostics' | 'command';
	label: string;
	status: 'passed' | 'failed' | 'timed_out' | 'skipped';
	exitCode?: number;
	output?: string;
}

export interface CheckReport {
	passed: boolean;
	checks: CheckEntry[];
}

export interface WorkflowStageRun {
	status: WorkflowStageStatus;
	attempts: number;
	steps: number;
	startedAt?: number;
	endedAt?: number;
	summary?: string;
	check?: CheckReport;
}

export interface WorkflowRun {
	version: 1;
	workflowId: string;
	name: string;
	prompt: string;
	definition: WorkflowDefinition;
	order: string[];
	stages: Record<string, WorkflowStageRun>;
	current?: string;
	pendingGate?: { after: string; title: string; body: string };
	notes?: string;
	plan?: string;
	changed?: string[];
	repairs: number;
	steps: number;
	status: WorkflowStatus;
	startedAt: number;
	endedAt?: number;
	error?: string;
}

export interface WorkflowResolveInput {
	library: WorkflowLibrary;
	override?: 'off' | 'always' | string;
	prompt: string;
	trigger: GenerationTrigger;
	policy: SessionPolicy;
	toolsEnabled: boolean;
	subagent: boolean;
	composed: boolean;
	hasTools: boolean;
	graphIds: readonly string[];
}

export type WorkflowStep =
	| { kind: 'agent'; stage: WorkflowStage }
	| { kind: 'checks'; stage: WorkflowStage }
	| { kind: 'gate'; stage: WorkflowStage }
	| { kind: 'finish' };

export interface WorkflowValidation {
	errors: string[];
}

/** What a checks stage is given: the session's boundary, the turn's writes and its diagnostic baseline. */
export interface CheckInput {
	base: SessionPolicy;
	workspace: string;
	sessionId: string;
	writes: readonly string[];
	diagnosticBaseline: ReadonlySet<string>;
	signal: AbortSignal;
}

/** The shipped best-practice workflow. A fresh copy every call: a caller may edit its library. */
export function shippedWorkflowLibrary(): WorkflowLibrary {
	return {
		version: 1,
		enabled: true,
		default: 'standard',
		workflows: [
			{
				id: 'standard',
				name: 'Standard coding task',
				description: 'Research, plan and approve, implement, verify, then review.',
				when: 'auto',
				stages: [
					{
						id: 'research',
						title: 'Research',
						run: 'agent',
						graph: 'agent',
						mode: 'ro',
						steps: 12,
						objective:
							'Investigate the workspace before changing anything. Find the relevant files, symbols, call paths, tests and conventions. Report what exists, where the change belongs, and the constraints. Do not edit.',
					},
					{
						id: 'plan',
						title: 'Plan',
						run: 'agent',
						graph: 'agent',
						mode: 'pl',
						gate: true,
						objective:
							'Write a concrete implementation plan for the task. List the files to change, ordered steps, edge cases, and how the change will be verified. Keep it short enough to act on. Do not edit project files.',
					},
					{
						id: 'implement',
						title: 'Implement',
						run: 'agent',
						graph: 'agent',
						mode: 'inherit',
						objective:
							'Implement the task, following the plan. If the plan is wrong, adapt it. Use the file tools for project changes. Keep edits focused and the workspace buildable. Finish with a short summary of what changed.',
					},
					{
						id: 'verify',
						title: 'Verify',
						run: 'checks',
						checks: { diagnostics: true, commands: [], timeout: 120, repairs: 1, repairTo: 'implement' },
					},
					{
						id: 'review',
						title: 'Review',
						run: 'agent',
						graph: 'agent',
						mode: 'ro',
						objective:
							'Review the changes made in this turn. Read the diff and changed files. Report defects by severity with file:line references. Then give the final report: what changed, what verification showed, and any remaining issues. If verification failed, say so explicitly.',
					},
				],
			},
		],
	};
}

/** The shipped default, as the settings manifest spells it. */
export const DEFAULT_WORKFLOW_LIBRARY = shippedWorkflowLibrary();

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

export function slug(value: string, limit = WORKFLOW_LIMITS.id): string {
	const cleaned = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '')
		.slice(0, limit);
	return cleaned || 'workflow';
}

function text(value: unknown, limit: number, fallback = ''): string {
	return typeof value === 'string' ? value.trim().slice(0, limit) : fallback;
}

function count(value: unknown, fallback: number, minimum: number, maximum: number): number {
	const number = Number(value);
	return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.round(number))) : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function commandList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : [];
	const seen = new Set<string>();
	const commands: string[] = [];
	for (const item of raw) {
		const command = text(item, WORKFLOW_LIMITS.command);
		if (!command || seen.has(command)) {
			continue;
		}
		seen.add(command);
		commands.push(command);
		if (commands.length >= WORKFLOW_LIMITS.commands) {
			break;
		}
	}
	return commands;
}

/** A stage from any input, shaped into what the runtime understands. Invalid ids become empty. */
export function normalizeStage(value: unknown): WorkflowStage | undefined {
	const raw = record(value);
	const id = text(raw.id, WORKFLOW_LIMITS.id).toLowerCase();
	if (!SLUG.test(id)) {
		return undefined;
	}
	const run = raw.run === 'checks' ? 'checks' : 'agent';
	const title = text(raw.title, WORKFLOW_LIMITS.name) || id.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
	const stage: WorkflowStage = { id, title, run };
	if (run === 'agent') {
		stage.graph = text(raw.graph, WORKFLOW_LIMITS.id) || 'agent';
		const mode = raw.mode;
		stage.mode = (WORKFLOW_STAGE_MODES as readonly string[]).includes(String(mode)) ? (mode as WorkflowStageMode) : 'inherit';
		if (raw.approval === 'inherit' || raw.approval === 'whitelist_accept') {
			stage.approval = raw.approval;
		}
		stage.objective = text(raw.objective, WORKFLOW_LIMITS.objective);
		stage.steps = count(raw.steps, 0, 0, 10_000);
		if (raw.gate === true) {
			stage.gate = true;
		}
	} else {
		const checks = record(raw.checks);
		stage.checks = {
			diagnostics: flag(checks.diagnostics, true),
			commands: commandList(checks.commands),
			timeout: count(checks.timeout, 120, 1, 600),
			repairs: count(checks.repairs, 1, 0, 5),
			repairTo: text(checks.repairTo, WORKFLOW_LIMITS.id) || undefined,
		};
	}
	return stage;
}

/** A workflow definition from any input. Duplicate stage ids are dropped. */
export function normalizeWorkflow(value: unknown): WorkflowDefinition | undefined {
	const raw = record(value);
	const id = text(raw.id, WORKFLOW_LIMITS.id).toLowerCase();
	if (!SLUG.test(id)) {
		return undefined;
	}
	const stages: WorkflowStage[] = [];
	const seen = new Set<string>();
	for (const item of Array.isArray(raw.stages) ? raw.stages.slice(0, WORKFLOW_LIMITS.stages) : []) {
		const stage = normalizeStage(item);
		if (!stage || seen.has(stage.id)) {
			continue;
		}
		seen.add(stage.id);
		stages.push(stage);
	}
	if (!stages.length) {
		return undefined;
	}
	const when = (WORKFLOW_WHENS as readonly string[]).includes(String(raw.when)) ? (raw.when as WorkflowWhen) : 'manual';
	return {
		id,
		name: text(raw.name, WORKFLOW_LIMITS.name) || id,
		description: text(raw.description, WORKFLOW_LIMITS.objective) || undefined,
		when,
		stages,
	};
}

/**
 * A library from any input. Missing or empty libraries fall back to the shipped preset; a default
 * that names no workflow falls back to the first auto workflow, then the shipped one.
 */
export function normalizeWorkflowLibrary(value: unknown): WorkflowLibrary {
	const raw = record(value);
	const incoming = Array.isArray(raw.workflows) ? raw.workflows.slice(0, WORKFLOW_LIMITS.workflows) : [];
	const workflows: WorkflowDefinition[] = [];
	const seen = new Set<string>();
	for (const item of incoming) {
		const workflow = normalizeWorkflow(item);
		if (!workflow || seen.has(workflow.id)) {
			continue;
		}
		seen.add(workflow.id);
		workflows.push(workflow);
	}
	if (!workflows.length) {
		const shipped = shippedWorkflowLibrary();
		// A library that only carries the master switch still gets the shipped definitions; keeping
		// the switch is what lets a test or a user turn automatic runs off without deleting them.
		return { ...shipped, enabled: flag(raw.enabled, shipped.enabled) };
	}
	const wanted = text(raw.default, WORKFLOW_LIMITS.id);
	const fallback = shippedWorkflowLibrary().default;
	const chosen = workflows.find((workflow) => workflow.id === wanted)
		? wanted
		: (workflows.find((workflow) => workflow.when === 'auto')?.id ?? workflows[0]!.id ?? fallback);
	return {
		version: 1,
		enabled: flag(raw.enabled, true),
		default: chosen,
		workflows,
	};
}

/** The workflow the runtime would run, or undefined when this turn is not a workflow turn. */
export function resolveWorkflow(input: WorkflowResolveInput): WorkflowRun | undefined {
	const { library, override, prompt, trigger, policy } = input;
	if (override === 'off' || trigger !== 'normal' || input.subagent || input.composed) {
		return undefined;
	}
	if (!input.toolsEnabled || !input.hasTools || !prompt.trim() || !policy.workingDirectory.trim()) {
		return undefined;
	}
	if (policy.approval === 'universal_reject' || policy.workMode === 'chat') {
		return undefined;
	}
	const usable = (workflow: WorkflowDefinition): boolean => validateWorkflow(workflow, input.graphIds).errors.length === 0;
	let chosen: WorkflowDefinition | undefined;
	if (override && override !== 'always') {
		chosen = library.workflows.find((workflow) => workflow.id === override);
	} else if (override === 'always') {
		chosen = library.workflows.find((workflow) => workflow.id === library.default);
	} else if (library.enabled) {
		chosen = library.workflows.find((workflow) => workflow.when === 'always' && usable(workflow));
		if (!chosen) {
			const auto = library.workflows.find((workflow) => workflow.id === library.default);
			if (auto?.when === 'auto' && canWrite(policy.workMode) && looksLikeCodingTask(prompt)) {
				chosen = auto;
			}
		}
	}
	if (!chosen || !usable(chosen)) {
		return undefined;
	}
	return startRun(chosen, prompt);
}

/** Whether the selected mode may change project files; auto workflows only start in such a mode. */
export function canWrite(mode: WorkMode): boolean {
	return mode === 'sw' || mode === 'aw';
}

const QUESTION_START =
	/^(?:(?:what|why|how|who|when|where|which|explain|describe|tell me|show me)\b|什么|为什么|怎么|如何|哪|解释|说明|介绍|告诉我)/i;
const ACTION =
	/(?:\b(?:fix|add|implement|refactor|change|update|remove|delete|rename|create|build|write|test|debug|investigate|support|migrate|upgrade|optimize|improve)\b|修复|实现|添加|修改|更新|删除|重构|新增|优化|排查|改成|支持)/i;

/**
 * A prompt is a pure question when it reads like one and names no action. "Can you fix this?" is
 * an action request even though it ends in a question mark.
 */
export function looksLikeCodingTask(prompt: string): boolean {
	const text = prompt.trim();
	if (!text || ACTION.test(text)) {
		return true;
	}
	return !(text.endsWith('?') || text.endsWith('？') || QUESTION_START.test(text));
}

/** Clamps a stage's requested mode to the session's capability set. Plan files are the one addition. */
export function stageMode(base: WorkMode, requested: WorkflowStageMode | undefined): WorkMode {
	if (!requested || requested === 'inherit') {
		return base;
	}
	if (requested === 'ro') {
		return 'ro';
	}
	if (base === 'chat') {
		return 'chat';
	}
	if (requested === 'pl') {
		return base === 'pl' ? 'pl' : base === 'sw' || base === 'aw' ? 'pl' : 'ro';
	}
	if (requested === 'sw') {
		return base === 'aw' || base === 'sw' ? 'sw' : base === 'pl' ? 'pl' : 'ro';
	}
	// requested === 'aw'
	return base === 'aw' ? 'aw' : base === 'sw' ? 'sw' : base === 'pl' ? 'pl' : 'ro';
}

/** The effective policy of one stage. Reads auto-approve; writes never do. */
export function stagePolicy(base: SessionPolicy, stage: WorkflowStage): SessionPolicy {
	const mode = stageMode(base.workMode, stage.mode);
	const readOnly = mode === 'ro' || mode === 'pl';
	const requested = stage.approval ?? (readOnly ? 'whitelist_accept' : 'inherit');
	const approval: Approval =
		requested === 'whitelist_accept' && readOnly && base.approval !== 'universal_reject'
			? 'whitelist_accept'
			: base.approval;
	return { ...base, workMode: mode, approval };
}

/** The user message that opens a stage. It lives only in the request, never in the transcript. */
export function stageDirective(run: WorkflowRun, stage: WorkflowStage): string {
	const index = run.order.indexOf(stage.id);
	const lines = [
		`(workflow) Stage ${index + 1}/${run.order.length}: ${stage.title}`,
		`Task: ${run.prompt.trim()}`,
	];
	if (stage.objective?.trim()) {
		lines.push('', stage.objective.trim());
	}
	const prior = run.order
		.slice(0, index)
		.map((id) => {
			const summary = run.stages[id]?.summary;
			if (!summary?.trim()) {
				return '';
			}
			const title = run.definition.stages.find((entry) => entry.id === id)?.title ?? id;
			return `${title}: ${summary.trim()}`;
		})
		.filter(Boolean);
	if (prior.length) {
		lines.push('', 'Previous stages:', clip(prior.join('\n\n'), WORKFLOW_LIMITS.summary));
	}
	const planStage = run.definition.stages.find((entry) => entry.id === 'plan');
	const planSummary = planStage ? run.stages[planStage.id]?.summary?.trim() : '';
	if (run.plan?.trim() && run.plan.trim() !== planSummary) {
		lines.push('', 'The plan from the previous stage:', clip(run.plan, WORKFLOW_LIMITS.summary));
	}
	if (run.changed?.length) {
		lines.push('', `Files changed in this turn: ${run.changed.slice(0, 40).join(', ')}`);
	}
	const check = latestCheck(run);
	if (check) {
		lines.push('', 'The latest verification failed. Its evidence:', formatCheckReport(check));
	}
	lines.push(
		'',
		'Complete only this stage. When it is done, stop calling tools and reply with a concise handoff. Do not claim verification passed unless the host reported it.',
	);
	return lines.join('\n');
}

function latestCheck(run: WorkflowRun): CheckReport | undefined {
	for (const id of [...run.order].reverse()) {
		const report = run.stages[id]?.check;
		if (report && !report.passed) {
			return report;
		}
	}
	return undefined;
}

export function clip(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}\n[...truncated, ${value.length} chars]` : value;
}

export function formatCheckReport(report: CheckReport): string {
	const lines = report.checks.map((check) => {
		const head = `${check.status === 'passed' ? 'PASS' : check.status.toUpperCase()} ${check.label}${check.exitCode === undefined ? '' : ` (exit ${check.exitCode})`}`;
		return check.output ? `${head}\n${clip(check.output, WORKFLOW_LIMITS.output)}` : head;
	});
	return lines.join('\n\n') || '(no checks)';
}

export function reportSummary(report: CheckReport): string {
	if (!report.checks.length) {
		return 'no checks configured';
	}
	return report.checks
		.map((check) => `${check.status === 'passed' ? '✔' : check.status === 'skipped' ? '–' : '✕'} ${check.label}`)
		.join(' · ');
}

/** Starts a run: the definition and order are frozen for the turn. */
export function startRun(definition: WorkflowDefinition, prompt: string): WorkflowRun {
	const stages: Record<string, WorkflowStageRun> = {};
	for (const stage of definition.stages) {
		stages[stage.id] = { status: 'pending', attempts: 0, steps: 0 };
	}
	return {
		version: 1,
		workflowId: definition.id,
		name: definition.name,
		prompt,
		definition: clone(definition),
		order: definition.stages.map((stage) => stage.id),
		stages,
		repairs: 0,
		steps: 0,
		status: 'running',
		startedAt: Date.now(),
	};
}

export function enterStage(run: WorkflowRun, stageId: string): WorkflowRun {
	const current = run.stages[stageId];
	if (!current) {
		return run;
	}
	return {
		...run,
		current: stageId,
		stages: {
			...run.stages,
			[stageId]: {
				...current,
				status: 'running',
				attempts: current.attempts + 1,
				startedAt: current.startedAt ?? Date.now(),
				endedAt: undefined,
			},
		},
	};
}

/** For a checks stage: count the run before the host executes it. */
export function beginCheck(run: WorkflowRun, stageId: string): WorkflowRun {
	const current = run.stages[stageId];
	if (!current) {
		return run;
	}
	return {
		...run,
		current: stageId,
		stages: {
			...run.stages,
			[stageId]: { ...current, status: 'running', attempts: current.attempts + 1, startedAt: current.startedAt ?? Date.now() },
		},
	};
}

/**
 * Ends a stage. A stage with a gate parks the run until the user answers; the stage itself is done,
 * so a denied gate leaves the work and its summary in place.
 */
export function finishStage(run: WorkflowRun, stageId: string, summary = ''): WorkflowRun {
	const current = run.stages[stageId];
	if (!current) {
		return run;
	}
	const stage = run.definition.stages.find((entry) => entry.id === stageId);
	const next: WorkflowRun = {
		...run,
		current: stageId,
		stages: {
			...run.stages,
			[stageId]: { ...current, status: 'done', summary: clip(summary.trim(), WORKFLOW_LIMITS.summary), endedAt: Date.now() },
		},
	};
	if (stage?.gate && stage.run === 'agent') {
		next.status = 'waiting';
		next.pendingGate = {
			after: stageId,
			title: `Approve ${stage.title}`,
			body: (summary || (stageId === 'plan' ? run.plan : '') || '').trim().slice(0, WORKFLOW_LIMITS.summary),
		};
	}
	return next;
}

export function failStage(run: WorkflowRun, stageId: string, error: string): WorkflowRun {
	const current = run.stages[stageId];
	if (!current) {
		return run;
	}
	return {
		...run,
		stages: {
			...run.stages,
			[stageId]: { ...current, status: 'failed', summary: clip(error, WORKFLOW_LIMITS.summary), endedAt: Date.now() },
		},
	};
}

export function skipStage(run: WorkflowRun, stageId: string, reason: string): WorkflowRun {
	const current = run.stages[stageId];
	if (!current) {
		return run;
	}
	return {
		...run,
		stages: { ...run.stages, [stageId]: { ...current, status: 'skipped', summary: reason, endedAt: Date.now() } },
	};
}

/** Sends the run back to an earlier stage and resets every stage from there onward. */
export function rewindTo(run: WorkflowRun, stageId: string): WorkflowRun {
	const index = run.order.indexOf(stageId);
	if (index < 0) {
		return run;
	}
	const stages = { ...run.stages };
	for (let at = index; at < run.order.length; at += 1) {
		const id = run.order[at]!;
		const current = stages[id]!;
		stages[id] = { ...current, status: 'pending', endedAt: undefined, summary: undefined };
	}
	return { ...run, stages, current: undefined, pendingGate: undefined, repairs: run.repairs + 1 };
}

/** Clears a gate after the user approved it. */
export function approveGate(run: WorkflowRun): WorkflowRun {
	return { ...run, pendingGate: undefined, status: 'running' };
}

/** Clears a gate after the user denied it; the transcript keeps the plan/stage summary. */
export function denyGate(run: WorkflowRun): WorkflowRun {
	return { ...run, pendingGate: undefined, status: 'stopped', endedAt: Date.now() };
}

/** The next thing the driver must do. Finished stages are skipped; a failed checks stage stays failed. */
export function nextStep(run: WorkflowRun): WorkflowStep {
	if (run.pendingGate) {
		const stage = run.definition.stages.find((entry) => entry.id === run.pendingGate!.after);
		if (stage) {
			return { kind: 'gate', stage };
		}
	}
	const id = run.order.find((stageId) => {
		const status = run.stages[stageId]?.status;
		return status === 'pending' || status === 'running';
	});
	if (!id) {
		return { kind: 'finish' };
	}
	const stage = run.definition.stages.find((entry) => entry.id === id);
	if (!stage) {
		return { kind: 'finish' };
	}
	return stage.run === 'checks' ? { kind: 'checks', stage } : { kind: 'agent', stage };
}

/**
 * What follows a checks stage: pass, repair, or fail. A repair rewinds to the configured stage and
 * leaves the failed report on the checks stage so the implement directive can include it.
 */
export function afterCheck(run: WorkflowRun, stage: WorkflowStage, report: CheckReport): WorkflowRun {
	const current = run.stages[stage.id]!;
	const checks = stage.checks ?? { diagnostics: true, commands: [], timeout: 120, repairs: 0 };
	const skipped = report.passed && report.checks.every((check) => check.status === 'skipped');
	const failed: WorkflowRun = {
		...run,
		stages: {
			...run.stages,
			[stage.id]: {
				...current,
				check: report,
				status: report.passed ? (skipped ? 'skipped' : 'done') : 'failed',
				summary: reportSummary(report),
				endedAt: Date.now(),
			},
		},
	};
	if (report.passed) {
		return failed;
	}
	const attempts = current.attempts;
	if (checks.repairTo && attempts <= checks.repairs) {
		// The checks stage itself goes back to pending so it runs again after the repair; its report
		// stays on the stage, which is what the repair stage's directive reads.
		const rewound = rewindTo(failed, checks.repairTo);
		return {
			...rewound,
			stages: {
				...rewound.stages,
				[stage.id]: { ...current, check: report, status: 'pending', summary: reportSummary(report), endedAt: undefined },
			},
		};
	}
	return failed;
}

/** The final status, once no stage is left. */
export function finalizeRun(run: WorkflowRun): WorkflowRun {
	if (run.status === 'stopped') {
		return { ...run, endedAt: run.endedAt ?? Date.now() };
	}
	const failed = run.order.some((id) => run.stages[id]?.status === 'failed');
	return { ...run, status: failed ? 'failed' : 'done', endedAt: Date.now(), current: undefined, pendingGate: undefined };
}

export function validateWorkflow(definition: WorkflowDefinition, graphIds: readonly string[]): WorkflowValidation {
	const errors: string[] = [];
	if (!definition.stages.length) {
		errors.push('needs at least one stage');
	}
	if (!definition.stages.some((stage) => stage.run === 'agent')) {
		errors.push('needs at least one agent stage');
	}
	const seen = new Set<string>();
	for (const stage of definition.stages) {
		if (seen.has(stage.id)) {
			errors.push(`duplicate stage id ${stage.id}`);
		}
		seen.add(stage.id);
		if (stage.run === 'agent' && stage.graph && graphIds.length && !graphIds.includes(stage.graph)) {
			errors.push(`stage ${stage.id} uses unknown graph ${stage.graph}`);
		}
		if (stage.run === 'checks') {
			const checks = stage.checks;
			if (!checks) {
				errors.push(`checks stage ${stage.id} has no checks settings`);
				continue;
			}
			if (checks.repairTo) {
				const target = definition.stages.findIndex((entry) => entry.id === checks.repairTo);
				const own = definition.stages.findIndex((entry) => entry.id === stage.id);
				if (target < 0 || target >= own || definition.stages[target]!.run !== 'agent') {
					errors.push(`stage ${stage.id} repairs to ${checks.repairTo}, which is not an earlier agent stage`);
				}
			}
		}
	}
	return { errors };
}

export function validateLibrary(value: unknown, graphIds: readonly string[]): WorkflowValidation {
	const library = normalizeWorkflowLibrary(value);
	const errors: string[] = [];
	const ids = new Set<string>();
	for (const workflow of library.workflows) {
		if (ids.has(workflow.id)) {
			errors.push(`duplicate workflow id ${workflow.id}`);
		}
		ids.add(workflow.id);
		errors.push(...validateWorkflow(workflow, graphIds).errors.map((error) => `${workflow.id}: ${error}`));
	}
	if (!ids.has(library.default)) {
		errors.push(`default workflow ${library.default} is not defined`);
	}
	const chosen = library.workflows.find((workflow) => workflow.id === library.default);
	if (library.enabled && chosen?.when !== 'auto' && !library.workflows.some((workflow) => workflow.when === 'always')) {
		errors.push('automatic runs are on, but the default workflow is not auto and none is always');
	}
	return { errors };
}

/** A run from a session file: every field is checked, and unknown stage ids are dropped. */
export function sanitizeWorkflowRun(value: unknown): WorkflowRun | undefined {
	const raw = record(value);
	if (raw.version !== 1 || !raw.definition || !Array.isArray(raw.order)) {
		return undefined;
	}
	const definition = normalizeWorkflow(raw.definition);
	if (!definition) {
		return undefined;
	}
	const order = raw.order.filter((id): id is string => typeof id === 'string' && definition.stages.some((stage) => stage.id === id));
	if (!order.length) {
		return undefined;
	}
	const rawStages = record(raw.stages);
	const stages: Record<string, WorkflowStageRun> = {};
	for (const id of order) {
		const entry = record(rawStages[id]);
		const status = ['pending', 'running', 'done', 'failed', 'skipped', 'waiting'].includes(String(entry.status))
			? (entry.status as WorkflowStageStatus)
			: 'pending';
		stages[id] = {
			status,
			attempts: count(entry.attempts, 0, 0, 100),
			steps: count(entry.steps, 0, 0, 1_000_000),
			startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : undefined,
			endedAt: typeof entry.endedAt === 'number' ? entry.endedAt : undefined,
			summary: text(entry.summary, WORKFLOW_LIMITS.summary) || undefined,
			check: sanitizeCheck(entry.check),
		};
	}
	const status = ['running', 'waiting', 'done', 'failed', 'stopped'].includes(String(raw.status))
		? (raw.status as WorkflowStatus)
		: 'running';
	const pending = record(raw.pendingGate);
	const pendingGate =
		typeof pending.after === 'string' && order.includes(pending.after)
			? {
					after: pending.after,
					title: text(pending.title, WORKFLOW_LIMITS.name),
					body: text(pending.body, WORKFLOW_LIMITS.summary),
				}
			: undefined;
	return {
		version: 1,
		workflowId: text(raw.workflowId, WORKFLOW_LIMITS.id) || definition.id,
		name: text(raw.name, WORKFLOW_LIMITS.name) || definition.name,
		prompt: text(raw.prompt, WORKFLOW_LIMITS.objective),
		definition,
		order,
		stages,
		current: typeof raw.current === 'string' && order.includes(raw.current) ? raw.current : undefined,
		pendingGate,
		notes: text(raw.notes, WORKFLOW_LIMITS.summary) || undefined,
		plan: text(raw.plan, WORKFLOW_LIMITS.summary) || undefined,
		changed: Array.isArray(raw.changed) ? raw.changed.map((item) => text(item, 500)).filter(Boolean).slice(0, 100) : undefined,
		repairs: count(raw.repairs, 0, 0, 100),
		steps: count(raw.steps, 0, 0, 1_000_000),
		status,
		startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : Date.now(),
		endedAt: typeof raw.endedAt === 'number' ? raw.endedAt : undefined,
		error: text(raw.error, WORKFLOW_LIMITS.summary) || undefined,
	};
}

function sanitizeCheck(value: unknown): CheckReport | undefined {
	const raw = record(value);
	if (!Array.isArray(raw.checks)) {
		return undefined;
	}
	const checks: CheckEntry[] = [];
	for (const item of raw.checks.slice(0, 20)) {
		const entry = record(item);
		const kind = entry.kind === 'diagnostics' ? 'diagnostics' : 'command';
		const status = ['passed', 'failed', 'timed_out', 'skipped'].includes(String(entry.status))
			? (entry.status as CheckEntry['status'])
			: 'failed';
		checks.push({
			kind,
			label: text(entry.label, WORKFLOW_LIMITS.name),
			status,
			exitCode: typeof entry.exitCode === 'number' ? entry.exitCode : undefined,
			output: text(entry.output, WORKFLOW_LIMITS.output) || undefined,
		});
	}
	return { passed: raw.passed === true, checks };
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
