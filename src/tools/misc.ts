import type { Context } from 'cordis';
import { appendMemory, memoryDir, readMemory } from '../lib/instructions';
import { objectSchema } from '../lib/types';
import { toolset } from '../services/tools';

/** Interaction tools: user questions, subagents, skills and memory. */

export const askTools = toolset([
	{
		name: 'ask_user',
		description: 'Ask the user a question and wait for the answer. Use when a decision is genuinely ambiguous.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema(
			{
				question: { type: 'string' },
				options: { type: 'array', items: { type: 'string' }, description: 'Optional choices.' },
				multi: { type: 'boolean', description: 'Allow selecting more than one option.' },
			},
			['question'],
		),
		async execute(args, ctx) {
			const { question, options, multi } = args as { question: string; options?: string[]; multi?: boolean };
			const answers = await ctx.ask(question, options, multi);
			return answers.join(', ') || '(no answer)';
		},
	},
]);

export const agentTools = toolset([
	{
		name: 'agent',
		description:
			'Delegate a focused task to a subagent that runs in its own context window and reports back a summary. Use for exploration, planning or review.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema(
			{
				prompt: { type: 'string', description: 'The task for the subagent.' },
				description: { type: 'string', description: 'Short label shown in the transcript.' },
				agent: { type: 'string', description: 'Agent name: explore, plan, review, or a custom agent.' },
				background: { type: 'boolean' },
				fork: { type: 'boolean', description: 'Give the subagent a copy of this conversation for extra context.' },
			},
			['prompt'],
		),
		async execute(args, ctx) {
			const { prompt, description, agent, background, fork } = args as {
				prompt: string;
				description?: string;
				agent?: string;
				background?: boolean;
				fork?: boolean;
			};
			return ctx.spawnAgent({ prompt, description, agent, background, fork, signal: ctx.signal });
		},
	},
]);

export function skillTools(ctx: Context): void {
	ctx.tools.register({
		name: 'skill',
		description: 'Load the full instructions of a skill by name. Call this before following a skill.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema({ name: { type: 'string' } }, ['name']),
		async execute(args) {
			const { name } = args as { name: string };
			const skill = ctx.catalog.skill(name);
			if (!skill) {
				const available = ctx.catalog.skills.map((item) => item.name).join(', ') || '(none)';
				return `Error: unknown skill ${name}. Available: ${available}`;
			}
			return `# Skill: ${skill.name}\n\n${skill.body}`;
		},
	});
}
skillTools.inject = ['tools', 'catalog'];

export function memoryTools(ctx: Context): void {
	ctx.tools.register({
		name: 'memory',
		description:
			'Read or append to the agent memory for this project. Remember durable facts, preferences and pitfalls the user asks you to keep.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema(
			{
				action: { type: 'string', enum: ['read', 'append'] },
				text: { type: 'string', description: 'Text to append when action is append. One line per memory.' },
			},
			['action'],
		),
		async execute(args) {
			if (!ctx.settings.get().memory) {
				return 'Error: memory is disabled in settings';
			}
			const { action, text } = args as { action: 'read' | 'append'; text?: string };
			const dir = memoryDir(ctx.host.storage.root, ctx.settings.workspace());
			if (action === 'read') {
				const content = await readMemory(dir);
				return content || '(memory is empty)';
			}
			if (!text?.trim()) {
				return 'Error: text is required for append';
			}
			await appendMemory(dir, text);
			return 'saved to memory';
		},
	});
}
memoryTools.inject = ['tools', 'settings', 'host'];
