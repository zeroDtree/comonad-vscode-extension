// SPDX-License-Identifier: AGPL-3.0-only
import type { Capability, WorkMode } from './types';

/**
 * The built-in subagent roles. A role is a capability ceiling plus a tool selection and a prompt;
 * the runtime intersects it with the parent policy and the task's own filter. This module is pure:
 * no `vscode`, no `cordis`, and no import from a service.
 */

export type AgentRisk = 'read' | 'write';

/** What a subagent may be granted. Read-only tools are always available; these add write paths. */
export interface SubagentGrant {
	/** The tracked file-write tools (`write_file`, `edit_text`, `edit_ranges`). */
	files: boolean;
	/** The scratch-only test shell (`run_shell_test`). */
	test: boolean;
}

export const READ_ONLY_GRANT: Readonly<SubagentGrant> = { files: false, test: false };

export interface AgentRole {
	id: string;
	title: string;
	description: string;
	prompt: string;
	/** The displayed work mode and the role's capability ceiling. */
	workMode: WorkMode;
	/** The role's default effective capabilities; always a subset of the subagent hard cap. */
	capabilities: Capability[];
	/** The child gets network only when the parent switch and this flag are both on. */
	network: boolean;
	/** The tools this role may use. A definition without a list is read-only (custom roles). */
	tools?: string[];
	disallowed?: string[];
	/** Default files/test grant; a settings entry can override it. */
	grant: SubagentGrant;
	/** `write` only when the effective capabilities include `rw`. */
	risk: AgentRisk;
	maxTurns?: number;
	model?: string;
	builtin?: boolean;
}

/** Tools only the root orchestrator may call. They are never offered to a child. */
export const ORCHESTRATOR_TOOLS = ['task_plan', 'delegate', 'task_status'] as const;

/**
 * Tools a child must never be offered, in addition to the capability cap. `write_plan` and
 * `shell_rw` are already outside `SUBAGENT_CAPABILITIES`; the list is a second line of defence for
 * custom roles and a future capability change.
 */
export const SUBAGENT_EXCLUDED_TOOLS: readonly string[] = [
	...ORCHESTRATOR_TOOLS,
	'agent',
	'write_plan',
	'run_shell',
	'start_shell',
	'stop_shell',
	'run_task',
	'memory',
	'ask_user',
];

const READ = ['list_dir', 'read_file', 'grep_files', 'find_files', 'find_symbols'];
const DIAG = ['get_diagnostics', 'git_diff'];
const SHELL_READ = ['run_shell_readonly'];
const PLAN_READ = ['list_plans', 'read_plan'];
const WRITE = ['write_file', 'edit_text', 'edit_ranges'];
const SHELL_TEST = ['run_shell_test'];
const SKILL = ['skill'];
const WEB = ['fetch_url', 'web_search'];
const MATH = ['calculate', 'describe_numbers', 'percentile', 'convert_units'];
const LORE = ['lore_lookup'];
const MESSAGE = ['message'];
const TODO = ['todo_write'];

const files = (): SubagentGrant => ({ files: true, test: false });
const test = (): SubagentGrant => ({ files: false, test: true });
const filesAndTest = (): SubagentGrant => ({ files: true, test: true });

function role(
	input: Omit<AgentRole, 'risk' | 'builtin' | 'grant'> & { grant?: SubagentGrant; builtin?: boolean },
): AgentRole {
	const grant = input.grant ?? { ...READ_ONLY_GRANT };
	return {
		...input,
		grant,
		risk: input.capabilities.includes('rw') ? 'write' : 'read',
		builtin: input.builtin ?? true,
	};
}

export const BUILTIN_ROLES: readonly AgentRole[] = [
	role({
		id: 'general-purpose',
		title: 'General Purpose',
		description: 'Read-only generalist for focused tasks without a clear specialist.',
		prompt:
			'You handle a focused, lightweight task that has no clear specialist. Work only with the read-only tools you are given. Inspect the workspace, answer the question, and return concise facts with file paths and line references. Never modify anything.',
		workMode: 'ro',
		capabilities: ['ro', 'shell_ro'],
		network: false,
		tools: [...READ, ...DIAG, ...SHELL_READ, ...SKILL, ...LORE, ...MESSAGE, ...TODO],
		maxTurns: 8,
	}),
	role({
		id: 'researcher',
		title: 'Researcher',
		description: 'External research with cited sources and explicit confidence.',
		prompt:
			'You research external sources for a delegated question. Search the web, prefer primary sources, and record title, URL, date and confidence for every claim. Separate sourced fact from inference. Never modify the workspace.',
		workMode: 'ro',
		capabilities: ['ro'],
		network: true,
		tools: [...READ, ...WEB, ...SKILL, ...LORE, ...MESSAGE, ...TODO],
		maxTurns: 10,
	}),
	role({
		id: 'math-researcher',
		title: 'Math Researcher',
		description: 'Mathematical derivation, computation and numerical verification.',
		prompt:
			'You formalize, derive and verify mathematical results. State every assumption, derive step by step, and use the math tools and the test shell for numerical checks. Report the method, the result and its error bounds. Do not modify project files.',
		workMode: 'sw',
		capabilities: ['ro', 'shell_ro', 'shell_test'],
		network: false,
		tools: [...READ, ...SHELL_READ, ...MATH, ...SHELL_TEST, ...SKILL, ...MESSAGE, ...TODO],
		grant: test(),
		maxTurns: 10,
	}),
	role({
		id: 'explorer',
		title: 'Explorer',
		description: 'Read-only codebase search and code-path mapping.',
		prompt:
			'You map the workspace. Search and read only what the task needs, then report exact files, symbols and line references, plus the call path or dependency chain you found. Distinguish what you verified from what you inferred. Never modify anything.',
		workMode: 'ro',
		capabilities: ['ro', 'shell_ro'],
		network: false,
		tools: [...READ, ...DIAG, ...SHELL_READ, ...SKILL, ...MESSAGE],
		maxTurns: 6,
	}),
	role({
		id: 'planner',
		title: 'Planner',
		description: 'Read-only implementation planning with steps, risks and verification.',
		prompt:
			'You produce an implementation plan. Inspect the relevant code and existing plans, then return ordered steps with files to change, dependencies, risks and verification. You cannot write plan files; return the plan in your report so the orchestrator can record it. Never modify anything.',
		workMode: 'pl',
		capabilities: ['ro', 'ro_plan', 'shell_ro'],
		network: false,
		tools: [...READ, ...DIAG, ...SHELL_READ, ...PLAN_READ, ...SKILL, ...MESSAGE],
		maxTurns: 10,
	}),
	role({
		id: 'coder',
		title: 'Coder',
		description: 'Implement a focused change with tracked file tools and tests.',
		prompt:
			'You implement exactly the delegated change. Use the tracked file tools for every project modification; never write project files through a shell. Make the smallest correct diff, run the specified tests with the test shell, and report changed files, commands and exit codes. If the task is blocked, report exactly what you need.',
		workMode: 'sw',
		capabilities: ['ro', 'rw', 'shell_ro', 'shell_test'],
		network: false,
		tools: [...READ, ...DIAG, ...WRITE, ...SHELL_READ, ...SHELL_TEST, ...PLAN_READ, ...SKILL, ...MESSAGE, ...TODO],
		grant: filesAndTest(),
		maxTurns: 16,
	}),
	role({
		id: 'tester',
		title: 'Tester',
		description: 'Design and run tests; report commands, exit codes and failures.',
		prompt:
			'You design and run tests for the delegated change. Add or adjust test files only when the task asks; never change production code. Run the specified commands with the test shell and report each command, exit code and the relevant output. Return a clear pass/fail judgement.',
		workMode: 'sw',
		capabilities: ['ro', 'rw', 'shell_ro', 'shell_test'],
		network: false,
		tools: [...READ, ...DIAG, ...WRITE, ...SHELL_READ, ...SHELL_TEST, ...PLAN_READ, ...SKILL, ...MESSAGE, ...TODO],
		grant: filesAndTest(),
		maxTurns: 12,
	}),
	role({
		id: 'reviewer',
		title: 'Reviewer',
		description: 'Independent read-only review against acceptance criteria.',
		prompt:
			'You independently review the delegated work. Inspect the workspace diff and the relevant files. Report findings ordered by severity with file:line references and concrete fixes. Judge each acceptance criterion explicitly; do not modify anything.',
		workMode: 'ro',
		capabilities: ['ro', 'ro_plan', 'shell_ro'],
		network: false,
		tools: [...READ, ...DIAG, ...SHELL_READ, ...PLAN_READ, ...SKILL, ...MESSAGE],
		maxTurns: 10,
	}),
	role({
		id: 'debugger',
		title: 'Debugger',
		description: 'Reproduce and diagnose failures from evidence.',
		prompt:
			'You diagnose a failure. Reproduce it from the available read-only commands and logs, isolate the smallest failing path, and report the root cause with evidence. Do not modify files; if a test run is required, ask the orchestrator to delegate a tester.',
		workMode: 'ro',
		capabilities: ['ro', 'shell_ro'],
		network: false,
		tools: [...READ, ...DIAG, ...SHELL_READ, ...SKILL, ...MESSAGE, ...TODO],
		maxTurns: 10,
	}),
	role({
		id: 'security-auditor',
		title: 'Security Auditor',
		description: 'Threat modeling and vulnerability review.',
		prompt:
			'You audit the delegated surface for security. Model the trust boundaries and attack surface, then report exploitable findings with severity, file:line references and concrete remediation. Do not modify anything.',
		workMode: 'ro',
		capabilities: ['ro', 'shell_ro'],
		network: false,
		tools: [...READ, ...DIAG, ...SHELL_READ, ...SKILL, ...MESSAGE],
		maxTurns: 10,
	}),
	role({
		id: 'data-analyst',
		title: 'Data Analyst',
		description: 'Data profiling, statistics and reproducible analysis.',
		prompt:
			'You analyze data for the delegated question. Profile the inputs, state assumptions, compute statistics or transformations reproducibly, and report the method, units, results and limitations. Write analysis files only when the task asks.',
		workMode: 'sw',
		capabilities: ['ro', 'rw', 'shell_ro', 'shell_test'],
		network: false,
		tools: [...READ, ...DIAG, ...WRITE, ...SHELL_READ, ...SHELL_TEST, ...MATH, ...SKILL, ...MESSAGE, ...TODO],
		grant: filesAndTest(),
		maxTurns: 14,
	}),
	role({
		id: 'scientist',
		title: 'Scientist',
		description: 'Hypothesis-driven scientific investigation and experiment design.',
		prompt:
			'You investigate a scientific question. State the hypothesis, method and evidence, separate observation from interpretation, and quantify uncertainty. Write only the artifacts the task requires and report how to reproduce them.',
		workMode: 'sw',
		capabilities: ['ro', 'rw', 'shell_ro', 'shell_test'],
		network: false,
		tools: [...READ, ...DIAG, ...WRITE, ...SHELL_READ, ...SHELL_TEST, ...MATH, ...SKILL, ...MESSAGE, ...TODO],
		grant: filesAndTest(),
		maxTurns: 16,
	}),
	role({
		id: 'technical-writer',
		title: 'Technical Writer',
		description: 'Accurate technical documentation for a named audience.',
		prompt:
			'You write technical documentation for the delegated audience. Read the code and existing docs first; be accurate, concise and consistent with the project voice. Do not invent APIs or behavior. Report every file you change.',
		workMode: 'sw',
		capabilities: ['ro', 'rw', 'shell_ro'],
		network: false,
		tools: [...READ, ...DIAG, ...WRITE, ...SHELL_READ, ...SKILL, ...LORE, ...MESSAGE, ...TODO],
		grant: files(),
		maxTurns: 10,
	}),
	role({
		id: 'architect',
		title: 'Architect',
		description: 'Architecture options, interfaces, trade-offs and evolution.',
		prompt:
			'You design a system or interface. Frame the constraints, options, trade-offs, boundaries and evolution path, then recommend one option with a decision record. Do not implement; return the design in your report.',
		workMode: 'pl',
		capabilities: ['ro', 'ro_plan', 'shell_ro'],
		network: false,
		tools: [...READ, ...DIAG, ...SHELL_READ, ...PLAN_READ, ...SKILL, ...MESSAGE],
		maxTurns: 10,
	}),
];

export const BUILTIN_ROLE_BY_ID: ReadonlyMap<string, AgentRole> = new Map(BUILTIN_ROLES.map((role) => [role.id, role]));

/** The effective risk of a capability set: only `rw` modifies the workspace. */
export function roleRisk(capabilities: readonly Capability[]): AgentRisk {
	return capabilities.includes('rw') ? 'write' : 'read';
}

/** The role's default capabilities, with an optional task-level filter applied by intersection. */
export function effectiveCapabilities(role: AgentRole, filter?: readonly Capability[]): Capability[] {
	const allowed = new Set(role.capabilities);
	return filter ? [...allowed].filter((capability) => filter.includes(capability)) : [...allowed];
}

/** The role's tools filtered by a candidate registry list; an absent list means every candidate. */
export function allowedToolsFor(role: Pick<AgentRole, 'tools' | 'disallowed'>, available: string[]): string[] {
	if (role.tools?.length) {
		const wanted = new Set(role.tools);
		return available.filter((name) => wanted.has(name));
	}
	if (role.disallowed?.length) {
		const blocked = new Set(role.disallowed);
		return available.filter((name) => !blocked.has(name));
	}
	return available;
}

/** The orchestration-block role index, one line per role. */
export function agentLines(agents: readonly AgentRole[]): string {
	if (agents.length === 0) {
		return '';
	}
	return agents
		.map(
			(agent) =>
				`- ${agent.id} [${agent.workMode}${agent.network ? ', network' : ''}]: ${agent.description || 'no description'}`,
		)
		.join('\n');
}
