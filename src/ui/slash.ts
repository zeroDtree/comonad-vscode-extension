import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { APPROVAL_LABELS, MODE_CAPS, MODE_LABELS } from '../lib/policy';
import type { CommandSpec } from '../services/commands';
import { formatUsage } from '../services/usage';
import { sandboxStatus } from '../tools/shell';
import { greetingsOf } from '../lib/tavern/card';
import { assignCharacter } from './tavern';

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
	'| `/char [name]` | pick the character this chat speaks as |',
	'| `/persona [name]` | pick who you are in this chat |',
	'| `/lore [names]` | pick the world books this chat scans |',
	'| `/preset [name]` | pick the prompt and sampler preset |',
	"| `/note [text]` | set or clear the standing author's note |",
	'',
	'Custom commands come from `.comonad/commands/*.md`.',
	'',
	'Tip: open the dedicated panel with **Comonad: Open Chat** (⌘⌥C / Ctrl+Alt+C).',
].join('\n');

export function slashCommands(ctx: Context): void {
	const register = (name: string, description: string, run: CommandSpec['run']): void => {
		ctx.commands.register({ name, description, run });
	};

	register('help', 'List commands', (_args, surface) => {
		surface.markdown(HELP);
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

	register('char', 'Pick the character this chat speaks as', async (args, surface) => {
		const session = ctx.sessions.active();
		if (!session) {
			surface.markdown('No active session yet.');
			return { done: true };
		}
		const named = args.trim();
		if (!named) {
			await vscode.commands.executeCommand('comonad.pickCharacter');
			return { done: true };
		}
		const character = ctx.tavern.findCharacter(named);
		if (!character) {
			const known = ctx.tavern.characters.map((entry) => entry.name).join(', ') || '(none found)';
			surface.markdown(`No character named **${named}**. Known characters: ${known}.`);
			return { done: true };
		}
		const opened = assignCharacter(ctx, session.id, character);
		const greetings = greetingsOf(character).length;
		surface.markdown(
			`This chat speaks as **${character.name}**.` +
				(opened ? ' It opens with the card’s greeting.' : greetings ? ' The chat already has messages, so the greeting was not inserted.' : ''),
		);
		return { done: true };
	});

	register('persona', 'Pick who you are in this chat', async (args, surface) => {
		const session = ctx.sessions.active();
		if (!session) {
			surface.markdown('No active session yet.');
			return { done: true };
		}
		const named = args.trim().toLowerCase();
		if (!named) {
			await vscode.commands.executeCommand('comonad.pickPersona');
			return { done: true };
		}
		const persona = ctx.tavern.findPersona(named);
		if (!persona) {
			const known = ctx.tavern.personas.map((entry) => entry.title || entry.name).join(', ') || '(none found)';
			surface.markdown(`No persona named **${args.trim()}**. Known personas: ${known}.`);
			return { done: true };
		}
		session.persona = persona.id;
		ctx.sessions.save(session);
		ctx.sessions.changed(session.id);
		surface.markdown(`You are **${persona.title || persona.name}** in this chat.`);
		return { done: true };
	});

	register('lore', 'Pick the world books this chat scans', async (args, surface) => {
		const session = ctx.sessions.active();
		if (!session) {
			surface.markdown('No active session yet.');
			return { done: true };
		}
		const named = args.trim();
		if (!named) {
			await vscode.commands.executeCommand('comonad.pickLorebooks');
			return { done: true };
		}
		if (named.toLowerCase() === 'none') {
			session.lorebooks = [];
			ctx.sessions.save(session);
			ctx.sessions.changed(session.id);
			surface.markdown('This chat scans no world books of its own.');
			return { done: true };
		}
		const { found, missing } = ctx.tavern.resolveBooks(named.split(/[\s,]+/));
		if (missing.length) {
			const known = ctx.tavern.books.map((entry) => entry.name).join(', ') || '(none found)';
			surface.markdown(`No world book named ${missing.map((name) => `**${name}**`).join(', ')}. Known books: ${known}.`);
			return { done: true };
		}
		session.lorebooks = found;
		ctx.sessions.save(session);
		ctx.sessions.changed(session.id);
		surface.markdown(`This chat scans: ${found.join(', ')}.`);
		return { done: true };
	});

	register('preset', 'Pick the prompt and sampler preset', async (args, surface) => {
		const named = args.trim();
		if (!named) {
			await vscode.commands.executeCommand('comonad.pickTavernPreset');
			return { done: true };
		}
		const session = ctx.sessions.active();
		if (!session) {
			surface.markdown('No active session yet.');
			return { done: true };
		}
		if (named.toLowerCase() === 'none') {
			session.preset = undefined;
			ctx.sessions.save(session);
			ctx.sessions.changed(session.id);
			surface.markdown('This chat uses the shipped prompt collection.');
			return { done: true };
		}
		const preset = ctx.tavern.findPreset(named);
		if (!preset) {
			const known = ctx.tavern.presets.map((entry) => entry.name).join(', ') || '(none found)';
			surface.markdown(`No preset named **${named}**. Known presets: ${known}.`);
			return { done: true };
		}
		session.preset = preset.id;
		ctx.sessions.save(session);
		ctx.sessions.changed(session.id);
		surface.markdown(`This chat uses **${preset.name}**.`);
		return { done: true };
	});

	register('note', "Set or clear this chat's standing author's note", (args, surface) => {
		const session = ctx.sessions.active();
		if (!session) {
			surface.markdown('No active session yet.');
			return { done: true };
		}
		const text = args.trim();
		session.authorNote = text || undefined;
		ctx.sessions.save(session);
		ctx.sessions.changed(session.id);
		surface.markdown(text ? `Author's note set (depth ${ctx.settings.get().tavernNoteDepth}).` : 'Author’s note cleared.');
		return { done: true };
	});
}
slashCommands.inject = ['commands', 'agent', 'settings', 'sessions', 'llm', 'usage', 'tavern'];

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
