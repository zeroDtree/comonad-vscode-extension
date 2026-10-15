import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { APPROVAL_LABELS, MODE_CAPS, MODE_LABELS } from '../lib/policy';
import type { CommandSpec } from '../services/commands';
import { formatUsage } from '../services/usage';
import { sandboxStatus } from '../tools/shell';

/** Built-in slash commands, available from every chat surface. */

const HELP = [
	'**Comonad commands**',
	'',
	'| command | purpose |',
	'| --- | --- |',
	'| `/plan [task]` | research read-only, then write a plan |',
	'| `/review [focus]` | review pending changes without editing |',
	'| `/compact [notes]` | summarize the conversation |',
	'| `/clear` `/new` | start a fresh session |',
	'| `/fork` | fork this session and keep exploring |',
	'| `/context` | token budget breakdown for this session |',
	'| `/status` | mode, model, workspace, sandbox, usage |',
	'| `/cost` | token usage for today and this session |',
	'| `/permissions` | show mode capabilities and permission rules |',
	'| `/model` | switch the active model |',
	'| `/init` | create a COMONAD.md project instruction file |',
	'| `/rewind` | restore files and conversation to an earlier turn |',
	'| `/export` | export this session as markdown |',
	'| `/resume` | resume a suspended turn |',
	'| `/continue` | continue the last message |',
	'| `/impersonate` | write your next message for you |',
	'| `/swipe` | generate another version of the last reply |',
	'| `/regenerate` | generate the last reply again |',
	'| `/quiet [text]` | generate a reply without adding it to the transcript |',
];

const HELP_TAIL = [
	'',
	'Custom commands come from `.comonad/commands/*.md`.',
	'',
	'Tip: open the dedicated panel with **Comonad: Open Chat** (⌘⌥C / Ctrl+Alt+C).',
];

export function slashCommands(ctx: Context): void {
	const register = (name: string, description: string, run: CommandSpec['run']): void => {
		ctx.commands.register({ name, description, run });
	};

	register('help', 'List commands', (_args, surface) => {
		// Read now, not at registration: a plugin's rows arrive with the plugin, which may be later.
		surface.markdown([...HELP, ...ctx.commands.help(), ...HELP_TAIL].join('\n'));
		return { done: true };
	});

	register('plan', 'Research read-only, then write a plan', (args, surface) => {
		if (!args.trim()) {
			surface.markdown('Describe what you want planned.');
			return { done: true };
		}
		return {
			done: false,
			text: `Research the workspace read-only, then write a step-by-step implementation plan for:\n\n${args}`,
			policy: { workMode: 'pl', approval: 'whitelist_accept', network: false },
		};
	});

	register('review', 'Review pending changes without editing', (args) => {
		const focus = args.trim() ? `\n\nFocus: ${args}` : '';
		return {
			done: false,
			text: `Review the pending workspace changes. Start with the git_diff tool, read the relevant files, and report issues ordered by severity with file:line references. Do not modify anything.${focus}`,
			policy: { workMode: 'ro', approval: 'whitelist_accept', network: false },
		};
	});

	register('compact', 'Summarize the conversation', async (args, surface) => {
		const session = ctx.sessions.active();
		if (!session) {
			surface.markdown('No active session yet.');
			return { done: true };
		}
		surface.progress('Compacting…');
		try {
			surface.markdown(await ctx.agent.compact(session.id, args.trim() || undefined));
		} catch (error) {
			surface.markdown(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { done: true };
	});

	register('clear', 'Start a fresh session', (_args, surface) => {
		ctx.sessions.create(ctx.agent.policyFor());
		surface.markdown('Started a new session.');
		return { done: true };
	});
	register('new', 'Start a fresh session', (_args, surface) => {
		ctx.sessions.create(ctx.agent.policyFor());
		surface.markdown('Started a new session.');
		return { done: true };
	});

	register('fork', 'Fork this session', (_args, surface) => {
		const forked = ctx.sessions.fork();
		surface.markdown(`Forked into **${forked.title}** — the conversation continues in a new session.`);
		return { done: true };
	});

	register('context', 'Show the token budget breakdown', (_args, surface) => {
		surface.markdown(ctx.agent.contextReport());
		return { done: true };
	});

	register('status', 'Show mode, model, workspace and usage', async (_args, surface) => {
		surface.markdown(await statusText(ctx));
		return { done: true };
	});

	register('cost', 'Show token usage', (_args, surface) => {
		const session = ctx.sessions.active();
		const lines = [`**Today:** ${formatUsage(ctx.usage.today())}`];
		if (session) {
			lines.push(
				`**This session:** ${session.usage.requests} requests · ${session.usage.inputTokens + session.usage.outputTokens} tokens (${session.usage.inputTokens} in / ${session.usage.outputTokens} out)`,
			);
		}
		surface.markdown(lines.join('\n\n'));
		return { done: true };
	});

	register('permissions', 'Show capabilities and permission rules', (_args, surface) => {
		const config = ctx.settings.get();
		surface.markdown(
			[
				`**Mode:** ${MODE_LABELS[config.mode] ?? config.mode}`,
				`Capabilities: ${[...MODE_CAPS[config.mode]].join(', ') || 'none'}`,
				`**Approval:** ${config.approval} — ${APPROVAL_LABELS[config.approval]}`,
				`**Network:** ${config.network ? 'on' : 'off'}`,
				'',
				'Permission rules (settings `comonad.permissions`):',
				`- allow: ${config.permissions.allow.join(', ') || '(none)'}`,
				`- ask: ${config.permissions.ask.join(', ') || '(none)'}`,
				`- deny: ${config.permissions.deny.join(', ') || '(none)'}`,
			].join('\n'),
		);
		return { done: true };
	});

	register('model', 'Switch the active model', async (_args, surface) => {
		await vscode.commands.executeCommand('comonad.pickModel');
		surface.markdown(`Model: **${ctx.llm.describe(ctx.settings.get().model)}**`);
		return { done: true };
	});

	register('init', 'Create a COMONAD.md project file', async (_args, surface) => {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			surface.markdown('Open a folder first.');
			return { done: true };
		}
		const target = vscode.Uri.joinPath(folder.uri, 'COMONAD.md');
		try {
			await vscode.workspace.fs.stat(target);
			surface.markdown('`COMONAD.md` already exists.');
		} catch {
			const template = ['# Project instructions', '', '- Build: ', '- Test: ', '- Conventions: ', ''].join('\n');
			await vscode.workspace.fs.writeFile(target, Buffer.from(template, 'utf8'));
			surface.markdown('Created `COMONAD.md`. Fill in build, test and convention notes.');
		}
		return { done: true };
	});

	register('rewind', 'Rewind files and conversation', async () => {
		await vscode.commands.executeCommand('comonad.rewind');
		return { done: true };
	});

	register('export', 'Export this session as markdown', async () => {
		await vscode.commands.executeCommand('comonad.exportSession');
		return { done: true };
	});

	register('resume', 'Resume a suspended turn', async () => {
		const session = ctx.sessions.active();
		if (!session) {
			return { done: true, result: 'No active session.' };
		}
		const result = await ctx.agent.resume(session.id);
		return { done: true, result: result.text };
	});

	// The generation types SillyTavern's own generate menu offers. Each one is a real generation: the
	// type decides which world-info entries may activate and how the text is written down.
	register('continue', 'Continue the last message instead of answering a new one', () => ({ done: false, text: '', trigger: 'continue' }));
	register('impersonate', 'Write your next message for you', () => ({ done: false, text: '', trigger: 'impersonate' }));
	register('swipe', 'Generate another version of the last reply', () => ({ done: false, text: '', trigger: 'swipe' }));
	register('regenerate', 'Generate the last reply again', () => ({ done: false, text: '', trigger: 'regenerate' }));
	register('quiet', 'Generate a reply without adding it to the transcript', (args) => ({ done: false, text: args, trigger: 'quiet' }));

}
slashCommands.inject = ['commands', 'agent', 'settings', 'sessions', 'llm', 'usage'];

async function statusText(ctx: Context): Promise<string> {
	const config = ctx.settings.get();
	const session = ctx.sessions.active();
	const visible = ctx.tools.visible(ctx.agent.policyFor());
	const lines = [
		'**Comonad status**',
		'',
		`- Model: ${ctx.llm.describe(config.model)}`,
		`- Mode: ${config.mode} · approval: ${config.approval} · network: ${config.network ? 'on' : 'off'}`,
		`- Workspace: ${config.workingDirectory || '(none)'}`,
		`- Tools available now: ${visible.length}`,
		`- ${sandboxStatus()}`,
		`- Today: ${formatUsage(ctx.usage.today())}`,
	];
	if (session) {
		lines.push(`- Session: ${session.title} (${session.id.slice(0, 8)}…) · ${session.turnIndex} turns · ${session.transcript.length} messages`);
		if (session.cursor) {
			lines.push('- ⏸ Suspended tool call pending: run `/resume`.');
		}
	}
	return lines.join('\n');
}
