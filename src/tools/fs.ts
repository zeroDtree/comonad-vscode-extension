// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { MAX_IMAGE_BYTES, looksLikeImagePath, sniffImage } from '../lib/images';
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

/** The first bytes of a file, for sniffing a type without loading a large body. */
async function readHead(path: string, size: number): Promise<Buffer> {
	const handle = await open(path, 'r');
	try {
		const head = Buffer.alloc(size);
		const { bytesRead } = await handle.read(head, 0, size, 0);
		return head.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
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
		description:
			'Read a workspace file. Text is returned as UTF-8; PNG, JPEG, GIF and WebP images are attached to the model as image content. Optionally start at a line and limit the number of lines for text files.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema(
			{
				path: { type: 'string' },
				startLine: { type: 'number', description: '1-based first line. Text files only.' },
				lines: { type: 'number', description: 'How many lines to read. Text files only.' },
			},
			['path'],
		),
		async execute(args, ctx) {
			const { path, startLine, lines } = args as { path: string; startLine?: number; lines?: number };
			const target = await readable(ctx, path);
			const info = await stat(target);
			// A huge binary is not loaded just to learn it is an image; a header is enough.
			if (info.size > MAX_IMAGE_BYTES) {
				const probe = sniffImage(await readHead(target, 64 * 1024));
				if (probe) {
					return `Error: image ${path} (${probe.mime}, ${probe.width}x${probe.height}, ${info.size} bytes) is too large to attach (limit ${MAX_IMAGE_BYTES} bytes).`;
				}
			}
			const bytes = await readFile(target);
			const image = sniffImage(bytes);
			if (image) {
				const ignored =
					startLine === undefined && lines === undefined
						? ''
						: ' startLine/lines were ignored; they apply to text files.';
				return {
					content: `Read image ${path} (${image.mime}, ${image.width}x${image.height}, ${bytes.byteLength} bytes).${ignored}`,
					images: [{ data: bytes, mime: image.mime, name: basename(path) }],
				};
			}
			if (looksLikeImagePath(path)) {
				return `Error: ${path} has an image extension but is not a valid PNG, JPEG, GIF or WebP image.`;
			}
			const text = bytes.toString('utf8');
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
			// A file that did not exist before this write is the session's own: the gate may later let
			// it be removed without asking. Any error other than ENOENT means "assume it existed".
			let existed = true;
			try {
				await lstat(target);
			} catch (error) {
				existed = (error as NodeJS.ErrnoException).code !== 'ENOENT';
			}
			const write = async () => {
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, content);
			};
			if (ctx.edit) {
				await ctx.edit(target, write);
			} else {
				await write();
			}
			if (!existed) {
				ctx.noteCreated?.(target);
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
				throw new Error(`the old text was not found in ${path}`);
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
