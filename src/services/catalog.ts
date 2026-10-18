// SPDX-License-Identifier: AGPL-3.0-only
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Service, type Context } from 'cordis';
import { COMONAD_BLOCK, DEFAULT_BLOCK_PREFIX } from '../lib/blocks';
import { booleanField, numberField, parseFrontmatter, stringField, stringListField } from '../lib/frontmatter';

/** Skills, subagent definitions and custom slash commands discovered from disk. */

export interface Skill {
	name: string;
	description: string;
	path: string;
	body: string;
}

export interface AgentDefinition {
	name: string;
	description: string;
	prompt: string;
	tools?: string[];
	disallowed?: string[];
	model?: string;
	maxTurns?: number;
	background?: boolean;
	builtin?: boolean;
}

export interface CustomCommand {
	name: string;
	description: string;
	hint?: string;
	allowedTools?: string[];
	model?: string;
	template: string;
	path: string;
}

export const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		name: 'explore',
		description: 'Fast read-only search of the codebase. Use for locating code and answering questions about the workspace.',
		prompt: 'You explore the workspace and report what you find. Read files, search, and summarize. Never modify anything. Return a concise report with file paths and line references.',
		tools: ['list_dir', 'read_file', 'grep_files', 'find_files', 'find_symbols'],
		builtin: true,
	},
	{
		name: 'plan',
		description: 'Read-only researcher that produces an implementation plan.',
		prompt: 'You research the workspace and produce a step-by-step implementation plan. Inspect the relevant files first. The plan must list concrete files to change and the verification steps. Never modify anything.',
		tools: ['list_dir', 'read_file', 'grep_files', 'find_files', 'find_symbols', 'get_diagnostics', 'git_diff'],
		builtin: true,
	},
	{
		name: 'review',
		description: 'Read-only code reviewer. Use to review pending changes or a file for bugs and risks.',
		prompt: 'You review code without modifying it. Inspect the pending workspace diff and the relevant files. Report findings ordered by severity with file:line references and concrete fixes. Focus on correctness, security, and maintainability.',
		tools: ['list_dir', 'read_file', 'grep_files', 'find_files', 'find_symbols', 'get_diagnostics', 'git_diff', 'run_shell_readonly'],
		builtin: true,
	},
];

declare module 'cordis' {
	interface Context {
		catalog: Catalog;
	}
}

export class Catalog extends Service {
	static inject = ['host', 'log'];

	skills: Skill[] = [];
	agents: AgentDefinition[] = BUILTIN_AGENTS;
	commands: CustomCommand[] = [];

	/** The first read, in flight from the moment the service exists: see `Tavern.ready`. */
	readonly ready: Promise<void>;

	/** The reads run one at a time, so the read that started first cannot land last: see `Tavern`. */
	private reading: Promise<void> = Promise.resolve();

	constructor(ctx: Context) {
		super(ctx, 'catalog');
		this.ready = this.reload();
	}

	/** Re-reads every skill, agent and command, after the read before it has finished. */
	reload(): Promise<void> {
		const next = this.reading.then(() => this.read());
		this.reading = next.catch(() => undefined);
		return next;
	}

	private async read(): Promise<void> {
		const host = this.ctx.host;
		const trusted = host.trusted();
		const project = trusted ? host.workspace() : undefined;
		const user = host.home();
		try {
			[this.skills, this.agents, this.commands] = await Promise.all([
				loadSkills({ project, user }),
				loadAgents({ project, user }),
				loadCommands({ project, user }),
			]);
		} catch (error) {
			this.ctx.log.message(`catalog reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.ctx.emit('catalog/changed');
	}

	skill(name: string): Skill | undefined {
		const wanted = name.trim().toLowerCase();
		return this.skills.find((skill) => skill.name.toLowerCase() === wanted);
	}

	agent(name: string | undefined): AgentDefinition | undefined {
		if (!name) {
			return undefined;
		}
		const wanted = name.trim().toLowerCase();
		return this.agents.find((agent) => agent.name.toLowerCase() === wanted);
	}

	command(name: string): CustomCommand | undefined {
		const wanted = name.trim().toLowerCase();
		return this.commands.find((command) => command.name.toLowerCase() === wanted);
	}
}

export const catalogPlugin = Catalog;

/** The skill list itself, without the heading a prompt block adds above it. */
export function skillLines(skills: Skill[]): string {
	if (skills.length === 0) {
		return '';
	}
	return skills.map((skill) => `- ${skill.name}: ${skill.description || 'no description'}`).join('\n');
}

/** The subagent list itself, without the heading a prompt block adds above it. */
export function agentLines(agents: AgentDefinition[]): string {
	if (agents.length === 0) {
		return '';
	}
	return agents.map((agent) => `- ${agent.name}: ${agent.description || 'no description'}`).join('\n');
}

export function agentIndex(agents: AgentDefinition[], heading = DEFAULT_BLOCK_PREFIX[COMONAD_BLOCK.agents]): string {
	const body = agentLines(agents);
	const head = heading.trim();
	return head && body ? `${head}\n${body}` : head || body;
}

export function allowedToolsFor(agent: AgentDefinition, available: string[]): string[] {
	if (agent.tools?.length) {
		const wanted = new Set(agent.tools);
		return available.filter((name) => wanted.has(name));
	}
	if (agent.disallowed?.length) {
		const blocked = new Set(agent.disallowed);
		return available.filter((name) => !blocked.has(name));
	}
	return available;
}

async function loadSkills(roots: { project?: string; user?: string }): Promise<Skill[]> {
	const skills: Skill[] = [];
	for (const root of [roots.project, roots.user]) {
		if (!root) {
			continue;
		}
		const base = join(root, '.comonad', 'skills');
		let entries: Dirent[] = [];
		try {
			entries = await readdir(base, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const file = join(base, entry.name, 'SKILL.md');
			try {
				if (!(await stat(file)).isFile()) {
					continue;
				}
				const text = await readFile(file, 'utf8');
				const { data, body } = parseFrontmatter(text);
				skills.push({
					name: stringField(data, 'name') ?? entry.name,
					description: stringField(data, 'description') ?? '',
					path: file,
					body: body.trim(),
				});
			} catch {
				continue;
			}
		}
	}
	return skills.sort((left, right) => left.name.localeCompare(right.name));
}

async function loadAgents(roots: { project?: string; user?: string }): Promise<AgentDefinition[]> {
	const custom: AgentDefinition[] = [];
	for (const root of [roots.project, roots.user]) {
		if (!root) {
			continue;
		}
		const base = join(root, '.comonad', 'agents');
		let entries: Dirent[] = [];
		try {
			entries = await readdir(base, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith('.md')) {
				continue;
			}
			try {
				const file = join(base, entry.name);
				if (!(await stat(file)).isFile()) {
					continue;
				}
				const { data, body } = parseFrontmatter(await readFile(file, 'utf8'));
				const name = stringField(data, 'name') ?? entry.name.replace(/\.md$/, '');
				custom.push({
					name,
					description: stringField(data, 'description') ?? '',
					prompt: body,
					tools: stringListField(data, 'tools'),
					disallowed: stringListField(data, 'disallowedTools') ?? stringListField(data, 'disallowed'),
					model: stringField(data, 'model'),
					maxTurns: numberField(data, 'maxTurns'),
					background: booleanField(data, 'background'),
				});
			} catch {
				continue;
			}
		}
	}
	const overridden = new Set(custom.map((agent) => agent.name));
	return [...BUILTIN_AGENTS.filter((agent) => !overridden.has(agent.name)), ...custom].sort((left, right) =>
		left.name.localeCompare(right.name),
	);
}

async function loadCommands(roots: { project?: string; user?: string }): Promise<CustomCommand[]> {
	const commands: CustomCommand[] = [];
	for (const root of [roots.project, roots.user]) {
		if (!root) {
			continue;
		}
		const base = join(root, '.comonad', 'commands');
		let entries: Dirent[] = [];
		try {
			entries = await readdir(base, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith('.md')) {
				continue;
			}
			try {
				const file = join(base, entry.name);
				if (!(await stat(file)).isFile()) {
					continue;
				}
				const { data, body } = parseFrontmatter(await readFile(file, 'utf8'));
				commands.push({
					name: stringField(data, 'name') ?? entry.name.replace(/\.md$/, ''),
					description: stringField(data, 'description') ?? '',
					hint: stringField(data, 'argument-hint') ?? stringField(data, 'hint'),
					allowedTools: stringListField(data, 'allowed-tools'),
					model: stringField(data, 'model'),
					template: body,
					path: file,
				});
			} catch {
				continue;
			}
		}
	}
	return commands.sort((left, right) => left.name.localeCompare(right.name));
}
