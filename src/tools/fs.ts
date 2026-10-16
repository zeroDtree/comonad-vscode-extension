import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { guardPath, isDeniedRead } from '../lib/sandbox';
import { objectSchema, type ToolContext } from '../lib/types';
import { toolset } from '../services/tools';

/** Workspace file tools. Every path the model names goes through `guardPath`. */

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build', 'vendor']);

function readable(ctx: ToolContext, path: string): Promise<string> {
	return guardPath(ctx.policy.workingDirectory, path, {
		access: 'read',
		confinement: ctx.policy.confinement,
		denyReadPaths: ctx.policy.denyReadPaths,
	});
}

function writable(ctx: ToolContext, path: string): Promise<string> {
	return guardPath(ctx.policy.workingDirectory, path, {
		access: 'write',
		confinement: ctx.policy.confinement,
		denyReadPaths: ctx.policy.denyReadPaths,
	});
}

async function walk(dir: string, visit: (file: string) => Promise<void>): Promise<void> {
	let entries: Dirent[] = [];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (SKIP.has(entry.name)) {
			continue;
		}
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(path, visit);
		} else if (entry.isFile()) {
			await visit(path);
		}
	}
}

export const fsTools = toolset([
	{
		name: 'list_dir',
		description: 'List files and directories inside the workspace.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ path: { type: 'string', description: 'Directory relative to the workspace root.' } }, ['path']),
		async execute(args, ctx) {
			const { path } = args as { path: string };
			const target = await readable(ctx, path);
			const entries = await readdir(target, { withFileTypes: true });
			const lines = entries
				.filter((entry) => entry.name !== '.DS_Store')
				.map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'}\t${entry.name}`)
				.sort();
			return lines.join('\n') || '(empty)';
		},
	},
	{
		name: 'read_file',
		description: 'Read a UTF-8 text file inside the workspace. Optionally start at a line and limit the number of lines.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema(
			{
				path: { type: 'string' },
				startLine: { type: 'number', description: '1-based first line.' },
				lines: { type: 'number', description: 'How many lines to read.' },
			},
			['path'],
		),
		async execute(args, ctx) {
			const { path, startLine, lines } = args as { path: string; startLine?: number; lines?: number };
			const text = await readFile(await readable(ctx, path), 'utf8');
			if (startLine === undefined && lines === undefined) {
				return text.length > 30_000 ? `${text.slice(0, 30_000)}\n[...truncated, ${text.length} chars]` : text;
			}
			const all = text.split('\n');
			const from = Math.max(1, startLine ?? 1) - 1;
			const count = Math.max(1, lines ?? 200);
			const slice = all.slice(from, from + count);
			const numbered = slice.map((line, index) => `${from + index + 1}\t${line}`).join('\n');
			return slice.length < all.length - from ? `${numbered}\n[...${all.length - from - slice.length} more lines]` : numbered;
		},
	},
	{
		name: 'grep_files',
		description: 'Search workspace files with a regular expression. Returns path:line:text matches.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema(
			{
				pattern: { type: 'string' },
				path: { type: 'string', description: 'Directory or file to search. Defaults to the workspace root.' },
			},
			['pattern'],
		),
		async execute(args, ctx) {
			const { pattern, path = '.' } = args as { pattern: string; path?: string };
			const regex = new RegExp(pattern, 'i');
			const root = await readable(ctx, path);
			const info = await stat(root);
			const files: string[] = [];
			if (info.isDirectory()) {
				await walk(root, async (file) => {
					if (!isDeniedRead(root, file, ctx.policy.denyReadPaths)) {
						files.push(file);
					}
				});
			} else {
				files.push(root);
			}
			const hits: string[] = [];
			for (const file of files) {
				if (hits.length >= 200) {
					break;
				}
				let text = '';
				try {
					text = await readFile(file, 'utf8');
				} catch {
					continue;
				}
				text.split('\n').forEach((line, index) => {
					if (hits.length < 200 && regex.test(line)) {
						hits.push(`${relative(ctx.policy.workingDirectory, file)}:${index + 1}:${line.trim().slice(0, 240)}`);
					}
				});
			}
			return hits.join('\n') || '(no matches)';
		},
	},
	{
		name: 'write_file',
		description: 'Create or replace a UTF-8 file inside the workspace.',
		capability: 'rw',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
		async execute(args, ctx) {
			const { path, content } = args as { path: string; content: string };
			const target = await writable(ctx, path);
			const write = async () => {
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, content);
			};
			if (ctx.edit) {
				await ctx.edit(target, write);
			} else {
				await write();
			}
			return `wrote ${path} (${content.length} chars)`;
		},
	},
	{
		name: 'apply_patch',
		description: 'Replace the first occurrence of exact text in a workspace file. Use read_file first to copy the text precisely.',
		capability: 'rw',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, ['path', 'old', 'new']),
		async execute(args, ctx) {
			const { path, old, new: replacement } = args as { path: string; old: string; new: string };
			const target = await writable(ctx, path);
			const text = await readFile(target, 'utf8');
			if (!text.includes(old)) {
				return `Error: the old text was not found in ${path}`;
			}
			const write = () => writeFile(target, text.replace(old, replacement));
			if (ctx.edit) {
				await ctx.edit(target, write);
			} else {
				await write();
			}
			return `patched ${path}`;
		},
	},
]);
