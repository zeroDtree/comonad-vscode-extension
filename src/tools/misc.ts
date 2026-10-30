// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'cordis';
import { abortable } from '../lib/cancel';
import { appendMemory, memoryDir, readMemory } from '../lib/instructions';
import { objectSchema, type Approval, type Capability, type SandboxMode } from '../lib/types';
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
			// The native quick pick cannot be dismissed here, but Stop must not wait for it.
			const answers = await abortable(ctx.signal, ctx.ask(question, options, multi));
			return answers.join(', ') || '(no answer)';
		},
	},
]);

export const agentTools = toolset([
	{
		name: 'agent',
		description:
			'Delegate a focused task to a subagent that runs in its own context window and reports back a summary. The child inherits the parent policy but only narrows it. Its approval response is always never, so any tool call that asks is denied: a write-capable agent needs an inherited allow rule or approval: "universal_accept" on the delegation.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema(
			{
				prompt: { type: 'string', description: 'The task for the subagent.' },
				description: { type: 'string', description: 'Short label shown in the transcript.' },
				agent: { type: 'string', description: 'Agent name: explore, plan, review, implement, or a custom agent.' },
				background: { type: 'boolean' },
				fork: { type: 'boolean', description: 'Give the subagent a copy of this conversation for extra context.' },
				capabilities: {
					type: 'array',
					items: { type: 'string', enum: ['ro', 'rw', 'rw_plan', 'shell_ro', 'shell_test', 'shell_rw'] },
					description: 'Further narrow the capabilities the child inherits. It can never add one.',
				},
				network: {
					type: 'boolean',
					description: 'false turns network off for the child. true or absent inherits the parent; it never turns network on.',
				},
				sandboxMode: {
					type: 'string',
					enum: ['workspace-read', 'read-only', 'workspace-write', 'danger-full-access'],
					description: 'A sandbox ceiling. The child gets the stricter of this and the parent sandbox.',
				},
				approval: {
					type: 'string',
					enum: ['manual', 'whitelist_accept', 'blacklist_reject', 'universal_accept', 'universal_reject'],
					description:
						'The child tool approval policy, independent of the parent. Defaults to whitelist_accept. Because the child approval response is always never, a policy that asks denies the call.',
				},
			},
			['prompt'],
		),
		async execute(args, ctx) {
			const { prompt, description, agent, background, fork, capabilities, network, sandboxMode, approval } = args as {
				prompt: string;
				description?: string;
				agent?: string;
				background?: boolean;
				fork?: boolean;
				capabilities?: Capability[];
				network?: boolean;
				sandboxMode?: SandboxMode;
				approval?: Approval;
			};
			return ctx.spawnAgent({
				prompt,
				description,
				agent,
				background,
				fork,
				capabilities,
				network,
				sandboxMode,
				approval,
				callId: ctx.callId,
				signal: ctx.signal,
			});
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
