import { readFile, stat } from 'node:fs/promises';
import { Service, type Context } from 'cordis';
import { guardPath, runCommand, shellArgv, type SandboxOptions } from '../lib/sandbox';
import type { SessionPolicy } from '../lib/types';
import type { GenerationTrigger } from '../lib/tavern/types';
import type { CustomCommand } from './catalog';

/** Slash commands: built-ins registered as plugins plus `.comonad/commands/*.md`. */

export interface CommandSurface {
	markdown(text: string): void;
	progress(text: string): void;
}

export interface CommandOutcome {
	done: boolean;
	/** Replacement prompt for a normal turn. */
	text?: string;
	/** Policy overrides for the turn. */
	policy?: Partial<SessionPolicy>;
	/** The generation type this command starts; the surface passes it to the turn. */
	trigger?: GenerationTrigger;
	/** Output to show when the command did not stream through the turn pipeline. */
	result?: string;
}

export interface CommandSpec {
	name: string;
	description: string;
	run(args: string, surface: CommandSurface): Promise<CommandOutcome> | CommandOutcome;
}

declare module 'cordis' {
	interface Context {
		commands: Commands;
	}
}

export class Commands extends Service {
	static inject = ['catalog', 'settings', 'log'];

	private readonly specs = new Map<string, CommandSpec>();
	/** Help lines per plugin id, so a feature's commands are listed while the feature is loaded. */
	private readonly notes = new Map<string, string[]>();

	constructor(ctx: Context) {
		super(ctx, 'commands');
	}

	register(spec: CommandSpec): void {
		this.ctx.effect(
			() => {
				this.specs.set(spec.name.toLowerCase(), spec);
				return () => {
					this.specs.delete(spec.name.toLowerCase());
				};
			},
			`ctx.commands.register(${JSON.stringify(spec.name)})`,
		);
	}

	list(): CommandSpec[] {
		return [...this.specs.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * Rows a plugin adds to `/help`'s table: the built-in table is written out, so a feature that
	 * brings commands of its own brings their lines with it, and takes them away when it goes.
	 */
	addHelp(id: string, rows: string[]): void {
		this.ctx.effect(() => {
			this.notes.set(id, rows);
			return () => {
				this.notes.delete(id);
			};
		}, `ctx.commands.addHelp(${JSON.stringify(id)})`);
	}

	help(): string[] {
		const rows = [...this.notes.values()];
		return rows.length ? ['', ...rows.flat()] : [];
	}

	get(name: string): CommandSpec | undefined {
		return this.specs.get(name.trim().toLowerCase());
	}

	/**
	 * Resolves a slash command or a custom prompt. Returns `{ done: false }` with the
	 * text to run when the input is a normal prompt or an expanded custom command.
	 */
	async handle(command: string | undefined, prompt: string, surface: CommandSurface): Promise<CommandOutcome> {
		const name = command ?? slashName(prompt);
		const args = command ? prompt : stripSlash(prompt);
		if (!name) {
			return { done: false, text: prompt };
		}
		const spec = this.get(name);
		if (spec) {
			return spec.run(args, surface);
		}
		const custom = this.ctx.catalog.command(name);
		if (!custom) {
			surface.markdown(`Unknown command \`/${name}\`. Try \`/help\`.`);
			return { done: true };
		}
		const expanded = await expandCommand(custom, args, this.ctx.settings.workspace(), this.sandboxOptions());
		return { done: false, text: expanded };
	}

	/**
	 * The boundary a custom command's `!`shell`` snippets and `@file` includes run under: the same
	 * one the shell tools get, so a command file cannot be a way around it.
	 */
	private sandboxOptions(): SandboxOptions {
		const config = this.ctx.settings.get();
		return {
			writable: true,
			confinement: { read: config.confineRead, write: config.confineWrite },
			network: config.network,
			denyReadPaths: [...config.denyReadPaths],
			timeoutMs: 20_000,
			filterEnv: config.filterSensitiveEnv,
		};
	}
}

export const commandsPlugin = Commands;

export function slashName(prompt: string): string | undefined {
	const match = prompt.trim().match(/^\/([A-Za-z][\w-]*)\b/);
	return match?.[1]?.toLowerCase();
}

function stripSlash(prompt: string): string {
	return prompt.trim().replace(/^\/[A-Za-z][\w-]*\s*/, '');
}

/** Expands `$ARGUMENTS`, `` !`shell` `` snippets and `@path` file includes. */
async function expandCommand(command: CustomCommand, args: string, workspace: string, options: SandboxOptions): Promise<string> {
	let output = command.template.replaceAll('$ARGUMENTS', args);
	const shellPattern = /!`([^`]+)`/g;
	for (const match of [...output.matchAll(shellPattern)]) {
		const snippet = match[1]!;
		let replacement = `(command failed: ${snippet})`;
		if (workspace) {
			try {
				const result = await runCommand(shellArgv(snippet), workspace, options);
				replacement = [result.stdout, result.stderr].filter(Boolean).join('\n').trim() || `(no output: ${snippet})`;
				if (result.code !== 0) {
					replacement = `(exit ${result.code})\n${replacement}`;
				}
			} catch (error) {
				replacement = `(command failed: ${error instanceof Error ? error.message : String(error)})`;
			}
		}
		output = output.replace(match[0], replacement);
	}
	const filePattern = /@([A-Za-z0-9_./-]+)/g;
	for (const match of [...output.matchAll(filePattern)]) {
		if (!workspace) {
			continue;
		}
		try {
			const file = await guardPath(workspace, match[1]!, {
				access: 'read',
				confinement: options.confinement,
				denyReadPaths: options.denyReadPaths,
			});
			const info = await stat(file);
			if (!info.isFile() || info.size > 64 * 1024) {
				continue;
			}
			const text = await readFile(file, 'utf8');
			output = output.replace(match[0], `\n<file path="${match[1]}">\n${text}\n</file>\n`);
		} catch {
			continue;
		}
	}
	return output;
}
