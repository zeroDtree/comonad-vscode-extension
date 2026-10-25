// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { missingAncestor } from '../lib/created';
import { guardPath, PathEscapeError } from '../lib/sandbox';
import { objectSchema, type ToolContext } from '../lib/types';
import { toolset } from '../services/tools';

/** Plan files live under `<workdir>/<planDirectory>/<session>/` inside the workspace. */

function planDir(ctx: ToolContext): string {
	return join(ctx.policy.planDirectory || '.comonad/plans', ctx.sessionId);
}

/** Resolves a plan path through the workspace guard, so a symlinked plan folder cannot escape. */
function planPath(ctx: ToolContext, name: string | null, access: 'read' | 'write'): Promise<string> {
	const parts = [planDir(ctx)];
	if (name !== null) {
		const clean = basename(name.trim());
		if (!clean || clean === '.' || clean === '..') {
			throw new PathEscapeError(`invalid plan name: ${name}`);
		}
		parts.push(clean);
	}
	return guardPath(ctx.policy.workingDirectory, join(...parts), {
		access,
		confinement: ctx.policy.confinement,
		denyReadPaths: ctx.policy.denyReadPaths,
	});
}

export const planTools = toolset([
	{
		name: 'list_plans',
		description: 'List plan files for this session.',
		capability: 'rw_plan',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({}),
		async execute(_args, ctx) {
			const dir = await planPath(ctx, null, 'write');
			await mkdir(dir, { recursive: true });
			const names = await readdir(dir);
			return names.join('\n') || '(no plans)';
		},
	},
	{
		name: 'read_plan',
		description: 'Read a plan file by name.',
		capability: 'rw_plan',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ name: { type: 'string' } }, ['name']),
		async execute(args, ctx) {
			const { name } = args as { name: string };
			return readFile(await planPath(ctx, name, 'read'), 'utf8');
		},
	},
	{
		name: 'write_plan',
		description: 'Write a plan file by name. Use it to record the implementation plan before editing code.',
		capability: 'rw_plan',
		trackedWrite: true,
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({ name: { type: 'string' }, content: { type: 'string' } }, ['name', 'content']),
		async execute(args, ctx) {
			const { name, content } = args as { name: string; content: string };
			const target = await planPath(ctx, name, 'write');
			let existed = true;
			try {
				await lstat(target);
			} catch (error) {
				existed = (error as NodeJS.ErrnoException).code !== 'ENOENT';
			}
			const createdDir = await missingAncestor(dirname(target), ctx.policy.workingDirectory);
			const write = async () => {
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, content);
			};
			if (ctx.edit) {
				await ctx.edit(target, write);
			} else {
				await write();
			}
			if (createdDir) {
				ctx.noteCreatedDir?.(createdDir);
			}
			if (!existed) {
				ctx.noteCreated?.(target);
			}
			return `wrote plan ${name}`;
		},
	},
]);
