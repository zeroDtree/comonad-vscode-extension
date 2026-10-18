// SPDX-License-Identifier: AGPL-3.0-only
import type { Message, TodoItem } from './types';

/** Tiny shared helpers. Pure module. */

export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Renders a todo list for prompts and tool output. */
export function formatTodos(items: TodoItem[]): string {
	if (items.length === 0) {
		return '(todo list cleared)';
	}
	const mark = (status: TodoItem['status']) => (status === 'completed' ? '[x]' : status === 'in_progress' ? '[>]' : '[ ]');
	return items.map((item) => `${mark(item.status)} ${item.text}`).join('\n');
}

/** Clips text to `limit` characters, trimming carriage returns first. */
export function clip(text: string, limit: number): string {
	const clean = text.replaceAll('\r', '').trim();
	return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

export function safeParse(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return {};
	}
}

export function lastAssistant<T extends { role: string }>(messages: readonly T[]): T | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === 'assistant') {
			return message;
		}
	}
	return undefined;
}

/**
 * The index of the assistant's last full reply: a message with text and no tool call hanging off it.
 * A turn that ended in a call has no reply of its own, so this is what a swipe or a continue means by
 * "the last thing the model said".
 */
export function lastReplyIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message && message.role === 'assistant' && !message.toolCalls?.length && message.content.trim()) {
			return index;
		}
	}
	return -1;
}

/** Human label for a tool call's most telling argument, used in previews. */
export function preview(args: string, limit = 120): string {
	const parsed = safeParse(args) as Record<string, unknown>;
	const value = parsed.command ?? parsed.path ?? parsed.url ?? parsed.query ?? parsed.prompt ?? args;
	return clip(typeof value === 'string' ? value : args, limit);
}
