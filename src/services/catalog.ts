// SPDX-License-Identifier: AGPL-3.0-only
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Service, type Context } from 'cordis';
import { BUILTIN_ROLES, roleRisk, type AgentRole } from '../lib/agents';
import { booleanField, numberField, parseFrontmatter, stringField, stringListField } from '../lib/frontmatter';
import { asWorkMode, MODE_CAPS } from '../lib/policy';
import { SUBAGENT_CAPABILITIES } from '../lib/subagent';
import type { Capability } from '../lib/types';

/** Skills, subagent roles and custom slash commands discovered from disk. */

export interface Skill {
	name: string;
	description: string;
	path: string;
	body: string;
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

declare module 'cordis' {
	interface Context {
		catalog: Catalog;
	}
}

export class Catalog extends Service {
	static inject = ['host', 'log'];

	skills: Skill[] = [];
	agents: AgentRole[] = [...BUILTIN_ROLES];
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

	agent(name: string | undefined): AgentRole | undefined {
		if (!name) {
			return undefined;
		}
		const wanted = name.trim().toLowerCase();
		return this.agents.find((agent) => agent.id.toLowerCase() === wanted);
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

async function loadAgents(roots: { project?: string; user?: string }): Promise<AgentRole[]> {
	const custom: AgentRole[] = [];
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
				const raw = stringField(data, 'name') ?? entry.name.replace(/\.md$/, '');
				const id = raw.trim().toLowerCase();
				if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || id.length > 64) {
					continue;
				}
				const workMode = asWorkMode(stringField(data, 'mode') ?? stringField(data, 'workMode'), 'ro');
				const declared = stringListField(data, 'capabilities');
				const capabilities: Capability[] = declared?.length
					? declared.filter((capability): capability is Capability =>
							(SUBAGENT_CAPABILITIES as readonly string[]).includes(capability) &&
							MODE_CAPS[workMode].has(capability as Capability),
						)
					: [...MODE_CAPS[workMode]].filter((capability) => SUBAGENT_CAPABILITIES.includes(capability));
				const grant = {
					files: booleanField(data, 'files') === true,
					test: booleanField(data, 'test') === true,
				};
				custom.push({
					id,
					title: stringField(data, 'title') ?? id,
					description: stringField(data, 'description') ?? '',
					prompt: body,
					workMode,
					capabilities,
					network: booleanField(data, 'network') === true,
					tools: stringListField(data, 'tools'),
					disallowed: stringListField(data, 'disallowedTools') ?? stringListField(data, 'disallowed'),
					grant,
					risk: roleRisk(capabilities),
					model: stringField(data, 'model'),
					maxTurns: numberField(data, 'maxTurns'),
					builtin: false,
				});
			} catch {
				continue;
			}
		}
	}
	const overridden = new Set(custom.map((agent) => agent.id));
	return [...BUILTIN_ROLES.filter((agent) => !overridden.has(agent.id)), ...custom].sort((left, right) =>
		left.id.localeCompare(right.id),
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
