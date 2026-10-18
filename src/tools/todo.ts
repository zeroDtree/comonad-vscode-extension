// SPDX-License-Identifier: AGPL-3.0-only
import { formatTodos } from '../lib/util';
import { objectSchema, type TodoItem } from '../lib/types';
import { toolset } from '../services/tools';

export const todoTools = toolset([
	{
		name: 'todo_write',
		description: 'Replace the session todo list. Track multi-step work and keep exactly one item in_progress until the task is done.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema(
			{
				items: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							text: { type: 'string' },
							status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
						},
						required: ['text', 'status'],
					},
				},
			},
			['items'],
		),
		async execute(args, ctx) {
			const { items } = args as { items: TodoItem[] };
			return formatTodos(ctx.todos(items));
		},
	},
]);
