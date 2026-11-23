// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { missingAncestor } from '../lib/created';
import { planFileName, planFolder, planTargetFor, planWriteFileName } from '../lib/plan-files';
import { guardPath, PathEscapeError } from '../lib/sandbox';
import { applyLiteralEdits, type LiteralEdit } from '../lib/text-edit';
import { objectSchema, type ToolContext } from '../lib/types';
import { toolset } from '../services/tools';

/**
 * Plan files live under `<workdir>/<planDirectory>/<root chat id>/` inside the workspace. A
 * subagent's own session id is `sub-…`, so it resolves the folder of the chat that spawned it.
 */

function planDir(ctx: ToolContext): string {
	return planFolder(ctx.policy.planDirectory, ctx.rootSessionId ?? ctx.sessionId);
}

/** Resolves a plan path through the workspace guard, so a symlinked plan folder cannot escape. */
function planPath(ctx: ToolContext, name: string | null, access: 'read' | 'write'): Promise<string> {
	const parts = [planDir(ctx)];
	if (name !== null) {
		const clean = planFileName(name);
		if (!clean) {
			throw new PathEscapeError(`invalid plan name: ${name}`);
		}
		parts.push(clean);
	}
	return guardPath(ctx.policy.workingDirectory, join(...parts), {
		access,
		sandboxMode: ctx.policy.sandboxMode,
		denyReadPaths: ctx.policy.denyReadPaths,
	});
}

/** The workspace-relative path a plan tool records for the card and the Build turn. */
function recordedPlanPath(ctx: ToolContext, file: string): string {
	return (
		planTargetFor(ctx.policy.workingDirectory, ctx.policy.planDirectory, ctx.rootSessionId ?? ctx.sessionId, file)
			?.relative ?? file
	);
}

export const planTools = toolset([
	{
		name: 'list_plans',
		description: 'List the plan files recorded for this chat.',
		capability: 'ro_plan',
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema({}),
		async execute(_args, ctx) {
			const dir = await planPath(ctx, null, 'read');
			try {
				const names = await readdir(dir);
				return names.join('\n') || '(no plans)';
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					return '(no plans)';
				}
				throw error;
			}
		},
	},
	{
		name: 'read_plan',
		description: 'Read a plan file recorded for this chat by name. Use it to copy the exact text edit_plan needs.',
		capability: 'ro_plan',
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
		description:
			'Create or replace a plan file for this chat by name. A name without a Markdown extension gets ".md" appended, and the result reports the file name that was written. The file is the durable deliverable the user can build; use edit_plan to revise an existing plan instead of rewriting it. When plan writes are unavailable, return the plan in your summary instead.',
		capability: 'rw_plan',
		trackedWrite: true,
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema(
			{
				name: { type: 'string', description: 'The plan file name; a missing Markdown extension gets ".md".' },
				content: { type: 'string' },
			},
			['name', 'content'],
		),
		async execute(args, ctx) {
			const { name, content } = args as { name: string; content: string };
			const file = planWriteFileName(name);
			if (!file) {
				throw new PathEscapeError(`invalid plan name: ${name}`);
			}
			const target = await planPath(ctx, file, 'write');
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
			return `wrote plan ${file}\nplan path: ${recordedPlanPath(ctx, file)}\n\nThe plan is recorded. Stop here and summarize it; do not call more tools. Implementation starts when the user builds the plan.`;
		},
	},
	{
		name: 'edit_plan',
		description:
			'Edit an existing plan file for this chat with exact-text replacements. The plan must already exist; use write_plan to create it. Each old text must occur exactly once in the current plan (later edits see earlier ones), and if any anchor is missing or ambiguous nothing is written. Use read_plan first to copy the exact current text.',
		capability: 'rw_plan',
		trackedWrite: true,
		needsNetwork: false,
		needsWorkspace: true,
		parameters: objectSchema(
			{
				name: { type: 'string', description: 'The exact plan file name reported by write_plan.' },
				edits: {
					type: 'array',
					description: 'Ordered exact-text replacements; each old must occur exactly once at that point.',
					minItems: 1,
					items: {
						type: 'object',
						properties: {
							old: { type: 'string', description: 'Exact current text; must occur exactly once. Empty is rejected.' },
							new: { type: 'string', description: 'Literal replacement text; $ patterns are not expanded.' },
						},
						required: ['old', 'new'],
						additionalProperties: false,
					},
				},
			},
			['name', 'edits'],
		),
		async execute(args, ctx) {
			const { name, edits } = args as { name?: unknown; edits?: unknown };
			if (typeof name !== 'string' || !name.trim()) {
				throw new Error('edit_plan needs a plan name');
			}
			if (!Array.isArray(edits) || edits.length === 0) {
				throw new Error('edit_plan needs a non-empty edits array of {old, new} pairs');
			}
			const pairs: LiteralEdit[] = edits.map((item, index) => {
				const pair = item as { old?: unknown; new?: unknown } | null;
				if (!pair || typeof pair !== 'object' || typeof pair.old !== 'string' || typeof pair.new !== 'string') {
					throw new Error(`edit_plan edit ${index + 1} must be an object with string old and new`);
				}
				return { old: pair.old, new: pair.new };
			});
			const file = planFileName(name) ?? name;
			const target = await planPath(ctx, name, 'write');
			const write = async () => {
				let text: string;
				try {
					text = await readFile(target, 'utf8');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						throw new Error(
							`no plan named ${file} exists in this chat; create it with write_plan first, then revise it with edit_plan`,
						);
					}
					throw error;
				}
				await writeFile(target, applyLiteralEdits(text, pairs, `plan "${file}"`));
			};
			if (ctx.edit) {
				await ctx.edit(target, write);
			} else {
				await write();
			}
			const count = pairs.length;
			return `edited plan ${file}\nplan path: ${recordedPlanPath(ctx, file)}\n\n${count} edit${count === 1 ? '' : 's'} applied. The plan is recorded. Stop here and summarize it; do not call more tools. Implementation starts when the user builds the plan.`;
		},
	},
]);
