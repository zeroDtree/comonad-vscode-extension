// SPDX-License-Identifier: AGPL-3.0-only
import { relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { formatResult, guardPath, resolveInside, runCommand } from '../lib/sandbox';
import { objectSchema } from '../lib/types';
import { toolset } from '../services/tools';

/** Tools that use the editor itself: diagnostics, symbols, edits, tasks, git. */

function within(root: string, path: string): boolean {
	if (!root) {
		return false;
	}
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return path === root || path.startsWith(prefix);
}

/** A path as the model should see it: workspace-relative inside, absolute when reads are open. */
function shown(root: string, path: string): string {
	return within(root, path) ? relative(root, path).split(sep).join('/') : path;
}

export const vscodeTools = toolset([
	{
		name: 'find_files',
		description: 'Find files in the workspace by glob pattern, for example `**/*.test.ts`.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ glob: { type: 'string' }, max: { type: 'number' } }, ['glob']),
		async execute(args, ctx) {
			const { glob, max } = args as { glob: string; max?: number };
			const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**', Math.min(max ?? 200, 400));
			const root = ctx.policy.workingDirectory;
			const files = uris
				.map((uri) => uri.fsPath)
				.filter((path) => !ctx.policy.confinement.read || within(root, path))
				.map((path) => shown(root, path));
			return files.join('\n') || '(no files)';
		},
	},
	{
		name: 'find_symbols',
		description: 'Search for classes, functions and other symbols in the workspace by name.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ query: { type: 'string' }, max: { type: 'number' } }, ['query']),
		async execute(args, ctx) {
			const { query, max } = args as { query: string; max?: number };
			const symbols =
				(await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>('vscode.executeWorkspaceSymbolProvider', query)) ?? [];
			const root = ctx.policy.workingDirectory;
			const lines = symbols
				.filter((symbol) => !ctx.policy.confinement.read || within(root, symbol.location.uri.fsPath))
				.slice(0, Math.min(max ?? 50, 100))
				.map((symbol) => {
					const path = shown(root, symbol.location.uri.fsPath);
					return `${vscode.SymbolKind[symbol.kind]} ${symbol.name} — ${path}:${symbol.location.range.start.line + 1}`;
				});
			return lines.join('\n') || '(no symbols)';
		},
	},
	{
		name: 'get_diagnostics',
		description: 'Read current editor diagnostics (errors and warnings) for the workspace.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ path: { type: 'string', description: 'Optional file or directory to filter by.' } }),
		async execute(args, ctx) {
			const { path } = args as { path?: string };
			const root = ctx.policy.workingDirectory;
			const confine = ctx.policy.confinement.read;
			const filter = path ? (confine ? resolveInside(root, path) : resolve(root, path)) : root;
			const lines: string[] = [];
			for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
				if (!within(filter, uri.fsPath)) {
					continue;
				}
				if (confine && !within(root, uri.fsPath)) {
					continue;
				}
				for (const diagnostic of diagnostics) {
					if (lines.length >= 100) {
						break;
					}
					const severity = vscode.DiagnosticSeverity[diagnostic.severity] ?? 'info';
					const file = shown(root, uri.fsPath);
					lines.push(`${file}:${diagnostic.range.start.line + 1} ${severity.toLowerCase()}: ${diagnostic.message}`);
				}
			}
			return lines.join('\n') || '(no diagnostics)';
		},
	},
	{
		name: 'apply_edits',
		description:
			'Apply line/column text edits to one workspace file through the editor, so the user can undo them. Prefer this tool for precise, localized changes; use write_file for new files or full rewrites.',
		capability: 'rw',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema(
			{
				path: { type: 'string' },
				edits: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							startLine: { type: 'number' },
							startColumn: { type: 'number' },
							endLine: { type: 'number' },
							endColumn: { type: 'number' },
							text: { type: 'string' },
							old: { type: 'string', description: 'Expected current text of the range, verified before applying.' },
						},
						required: ['startLine', 'startColumn', 'endLine', 'endColumn', 'text'],
					},
				},
			},
			['path', 'edits'],
		),
		async execute(args, ctx) {
			const { path, edits } = args as {
				path: string;
				edits: { startLine: number; startColumn: number; endLine: number; endColumn: number; text: string; old?: string }[];
			};
			let target: string;
			try {
				target = await guardPath(ctx.policy.workingDirectory, path, {
					access: 'write',
					confinement: ctx.policy.confinement,
					denyReadPaths: ctx.policy.denyReadPaths,
				});
			} catch (error) {
				return `Error: ${error instanceof Error ? error.message : String(error)}`;
			}
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
			// Unsaved text is the user's, not the agent's: refuse rather than save it to disk.
			if (document.isDirty) {
				return `Error: ${path} has unsaved changes in the editor — save it first, then retry`;
			}
			const edit = new vscode.WorkspaceEdit();
			for (const change of edits) {
				const range = new vscode.Range(change.startLine - 1, change.startColumn - 1, change.endLine - 1, change.endColumn - 1);
				if (change.old !== undefined && document.getText(range) !== change.old) {
					return `Error: expected text does not match ${path} at line ${change.startLine}`;
				}
				edit.replace(document.uri, range, change.text);
			}
			// The editor writes this file, so the journal reads the disk around it: the unsaved text is
			// what the user would lose on a revert, which is why the review refuses a dirty document.
			const write = async () => {
				const applied = await vscode.workspace.applyEdit(edit);
				if (!applied) {
					throw new Error('the editor rejected the edits');
				}
				// The edit is applied in the buffer; save it so the disk and the journal agree.
				await document.save();
			};
			try {
				if (ctx.edit) {
					await ctx.edit(target, write);
				} else {
					await write();
				}
			} catch (error) {
				return `Error: ${error instanceof Error ? error.message : String(error)}`;
			}
			return `applied ${edits.length} edit(s) to ${path}`;
		},
	},
	{
		name: 'git_diff',
		description: 'Show the git status and the diff of the workspace. Useful before committing or reviewing changes.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ staged: { type: 'boolean' } }),
		async execute(args, ctx) {
			const { staged } = args as { staged?: boolean };
			const options = {
				writable: false,
				confinement: ctx.policy.confinement,
				network: false,
				denyReadPaths: [] as string[],
				timeoutMs: 20_000,
			};
			const status = await runCommand(['git', 'status', '--porcelain=v1', '--branch'], ctx.policy.workingDirectory, options);
			const diff = await runCommand(['git', 'diff', ...(staged ? ['--cached'] : [])], ctx.policy.workingDirectory, options);
			const parts = [formatResult(status, 6_000)];
			if (diff.stdout.trim()) {
				parts.push(formatResult(diff, 30_000));
			}
			return parts.join('\n\n');
		},
	},
	{
		name: 'run_task',
		description: 'List or run a VS Code task by name (build, test, lint). Without a name, lists available tasks.',
		capability: 'shell_rw',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ name: { type: 'string' } }),
		async execute(args) {
			const { name } = args as { name?: string };
			const tasks = await vscode.tasks.fetchTasks();
			if (!name) {
				return tasks.map((task) => `${task.name} (${task.source})`).join('\n') || '(no tasks)';
			}
			const task = tasks.find((item) => item.name === name);
			if (!task) {
				return `Error: no task named ${name}`;
			}
			const execution = await vscode.tasks.executeTask(task);
			const exitCode = await new Promise<number | undefined>((resolvePromise) => {
				const timer = setTimeout(() => {
					// The task outlived the wait: stop listening, or every run that times out leaves a
					// listener behind that fires on the next one.
					stop.dispose();
					resolvePromise(undefined);
				}, 10 * 60_000);
				const stop = vscode.tasks.onDidEndTaskProcess((event) => {
					if (event.execution === execution) {
						clearTimeout(timer);
						stop.dispose();
						resolvePromise(event.exitCode);
					}
				});
			});
			return exitCode === undefined ? `task ${name} is still running` : `task ${name} finished with exit code ${exitCode}`;
		},
	},
]);
