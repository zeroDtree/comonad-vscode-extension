// SPDX-License-Identifier: AGPL-3.0-only
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { isLoopbackBase } from '../lib/endpoint';
import { APPROVAL_LABELS, APPROVAL_RESPONSE_LABELS, MODE_CAPS, MODE_LABELS, SANDBOX_LABELS } from '../lib/policy';
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
	'| `/summarize [notes] [--rebuild]` | summarize the model context; `--rebuild` rewrites it from the full chat (`/compress` and `/compact` are aliases) |',
	'| `/clear` `/new` | start a fresh session |',
	'| `/fork` | fork this session and keep exploring |',
	'| `/context` | token budget breakdown for this session |',
	'| `/status` | mode, model, workspace, sandbox, usage |',
	'| `/cost` | token usage for today and this session |',
	'| `/permissions` | show mode capabilities and permission rules |',
	'| `/audit [call_id]` | show a tool call\'s decision trace, or the recent terminals |',
	'| `/model` | switch the active model |',
	'| `/init` | create a COMONAD.md project instruction file |',
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
	const register = (name: string, description: string, run: CommandSpec['run'], hint?: string): void => {
		ctx.commands.register({ name, description, hint, run });
	};

	register('help', 'List commands', (_args, surface) => {
		// Read now, not at registration: a plugin's rows arrive with the plugin, which may be later.
		surface.markdown([...HELP, ...ctx.commands.help(), ...HELP_TAIL].join('\n'));
		return { done: true };
	});

	register(
		'plan',
		'Research read-only, then write a plan',
		(args, surface) => {
			if (!args.trim()) {
				surface.markdown('Describe what you want planned.');
				return { done: true };
			}
			return {
				done: false,
				text: `Research the workspace read-only, then write a step-by-step implementation plan for:\n\n${args}`,
				policy: { workMode: 'pl', approval: 'whitelist_accept', network: false },
			};
		},
		'[task]',
	);

	register(
		'review',
		'Review pending changes without editing',
		(args) => {
			const focus = args.trim() ? `\n\nFocus: ${args}` : '';
			return {
				done: false,
				text: `Review the pending workspace changes. Start with the git_diff tool, read the relevant files, and report issues ordered by severity with file:line references. Do not modify anything.${focus}`,
				policy: { workMode: 'ro', approval: 'whitelist_accept', network: false },
			};
		},
		'[focus]',
	);

	const summarize: CommandSpec['run'] = async (args, surface) => {
		const session = ctx.sessions.active();
		if (!session) {
			surface.markdown('No active session yet.');
			return { done: true };
		}
		const rebuild = /(^|\s)--rebuild(\s|$)/.test(args);
		const notes = args.replaceAll('--rebuild', '').trim() || undefined;
		surface.progress(rebuild ? 'Rebuilding the summary from the full chat…' : 'Summarizing…');
		try {
			surface.markdown(await ctx.agent.compact(session.id, notes, rebuild));
		} catch (error) {
			surface.markdown(`Summarizing failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { done: true };
	};

	// `/summarize` is the name; the other two are what people reach for, and what other tools call it.
	register('summarize', 'Summarize the conversation to free up context', summarize, '[notes] [--rebuild]');
	register('compress', 'Summarize the conversation to free up context', summarize, '[notes] [--rebuild]');
	register('compact', 'Summarize the conversation to free up context', summarize, '[notes] [--rebuild]');

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

	register(
		'audit',
		'Show the decision trace for a tool call',
		(args, surface) => {
			surface.markdown(auditText(ctx, args.trim()));
			return { done: true };
		},
		'[call_id]',
	);

	register('permissions', 'Show capabilities and permission rules', (_args, surface) => {
		const config = ctx.settings.get();
		surface.markdown(
			[
				`**Mode:** ${MODE_LABELS[config.mode] ?? config.mode}`,
				`Capabilities: ${[...MODE_CAPS[config.mode]].join(', ') || 'none'}`,
				`**Tool approval:** ${config.approval} — ${APPROVAL_LABELS[config.approval]}`,
				`**Approval response:** ${config.approvalResponse} — ${APPROVAL_RESPONSE_LABELS[config.approvalResponse]}`,
				`**Network access:** ${config.network ? 'on' : 'off'}`,
				`**Sandbox mode:** ${config.sandboxMode} — ${SANDBOX_LABELS[config.sandboxMode]}`,
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
	register('quiet', 'Generate a reply without adding it to the transcript', (args) => ({ done: false, text: args, trigger: 'quiet' }), '[text]');

}
slashCommands.inject = ['commands', 'agent', 'settings', 'sessions', 'llm', 'usage', 'host', 'tools', 'decisions'];

/** `/audit`: recent terminal events, or one call's path from its terminal back to the root. */
export function auditText(ctx: Context, callId: string): string {
	const cell = (value: unknown): string => String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim() || '—';
	const time = (at: number): string => new Date(at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
	if (!callId) {
		const events = ctx.decisions.recent(20);
		if (!events.length) {
			return 'No decision traces recorded yet.';
		}
		return [
			'**Recent decision terminals**',
			'',
			'| time | event | tool | call id | reason |',
			'| --- | --- | --- | --- | --- |',
			...events.map((event) => `| ${time(event.timestamp)} | ${cell(event.event)} | ${cell(event.tool_name)} | \`${cell(event.call_id)}\` | ${cell(event.reason)} |`),
			'',
			'Use `/audit <call_id>` to reconstruct one path.',
		].join('\n');
	}
	const view = ctx.decisions.reconstruct(callId);
	if (!view) {
		return `No decision trace for \`${callId}\`.`;
	}
	const terminal = view.terminal
		? `**Terminal:** \`${view.terminal.event}\` at ${time(view.terminal.timestamp)}${view.terminal.reason ? ` — ${cell(view.terminal.reason)}` : ''}`
		: '**Terminal:** none (suspended or incomplete)';
	const context = view.context ?? {};
	const lines = [
		`**Decision trace** \`${view.callId}\`${context.toolName ? ` — ${cell(context.toolName)}` : ''}`,
		terminal,
		...(context.providerCallId ? [`**Provider call:** \`${cell(context.providerCallId)}\` · session \`${cell(context.sessionId)}\` · turn ${context.turn ?? '—'}`] : []),
		...(view.nodes[0]?.policy_revision ? [`**Policy revision:** \`${view.nodes[0].policy_revision}\``] : []),
		'',
		'| # | layer | decision | matched rule | reason |',
		'| --- | --- | --- | --- | --- |',
		...view.nodes.map(
			(node, index) =>
				`| ${index + 1} | ${cell(node.layer)} | ${cell(node.decision)} | ${cell(node.matched_rule)} | ${cell(node.reason)} |`,
		),
	];
	if (view.policy) {
		const policy = view.policy;
		lines.push(
			'',
			`**Policy:** mode \`${policy.workMode}\` · tool approval \`${policy.approval}\` · response \`${policy.approvalResponse}\` · network \`${policy.network ? 'on' : 'off'}\` · sandbox \`${policy.sandboxMode}\``,
			`**Capabilities:** ${(policy.capabilities ?? []).join(', ') || 'none'}`,
			...(policy.tools ? [`**Tools:** ${policy.tools.join(', ') || '(none)'}`] : []),
			`**Rules:** deny ${policy.rules.deny.length} · ask ${policy.rules.ask.length} · allow ${policy.rules.allow.length} · denied reads ${policy.denyReadPaths.length}`,
		);
		if (policy.rules.deny.length || policy.rules.ask.length || policy.rules.allow.length) {
			lines.push(
				'```text',
				...policy.rules.deny.map((rule) => `deny  ${rule}`),
				...policy.rules.ask.map((rule) => `ask   ${rule}`),
				...policy.rules.allow.map((rule) => `allow ${rule}`),
				'```',
			);
		}
	}
	return lines.join('\n');
}

async function statusText(ctx: Context): Promise<string> {
	const config = ctx.settings.get();
	const session = ctx.sessions.active();
	const visible = ctx.tools.visible(ctx.agent.policyFor());
	const remote = ctx.host.remoteName();
	const sandbox = ctx.host.sandboxKind();
	const lines = [
		'**Comonad status**',
		'',
		`- Model: ${ctx.llm.describe(config.model)}`,
		`- Mode: ${config.mode} · tool approval: ${config.approval} · approval response: ${config.approvalResponse} · network: ${config.network ? 'on' : 'off'}`,
		`- Host: ${remote ? `remote (${remote})` : 'local'} · ${sandboxStatus(config.sandboxMode, sandbox)}`,
		`- Workspace: ${config.workingDirectory || '(none)'}`,
		`- Tools available now: ${visible.length}`,
		`- Today: ${formatUsage(ctx.usage.today())}`,
	];
	if (sandbox === 'none') {
		lines.push(
			config.sandboxMode === 'danger-full-access' && config.network
				? '- No OS sandbox: shell commands run unconfined under the full-access sandbox mode.'
				: '- No OS sandbox: shell commands are refused; use danger-full-access with network access on to run them unconfined.',
		);
	}
	const loopback = remote ? config.profiles.filter((profile) => isLoopbackBase(profile.base)).map((profile) => profile.id) : [];
	if (loopback.length) {
		lines.push(`- Loopback endpoint(s) ${loopback.join(', ')} resolve on the remote machine, not yours.`);
	}
	if (session) {
		lines.push(`- Session: ${session.title} (${session.id.slice(0, 8)}…) · ${session.turnIndex} turns · ${session.transcript.length} messages`);
		if (session.cursor) {
			lines.push('- ⏸ Suspended tool call pending: run `/resume`.');
		}
	}
	return lines.join('\n');
}
