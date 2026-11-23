// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEvidence } from './task-graph';
import type { Message } from './types';

/**
 * Evidence is a boundary value: the model writes it, the runtime reads it, and a single malformed
 * item must never discard the rest of a valid report. This module owns the one tolerant policy used
 * by the envelope parser, task-graph persistence and the runtime's own transcript harvest.
 */

export const MAX_EVIDENCE = 16;
const MAX_TEXT = { path: 256, query: 500, command: 2000, note: 1000, output: 2000 } as const;
const KIND_ORDER: Record<AgentEvidence['kind'], number> = { command: 0, file: 1, search: 2, note: 3 };
const SHELL_TOOLS = new Set(['run_shell_test', 'run_shell_readonly', 'run_shell']);

const text = (value: unknown, limit: number): string =>
	typeof value === 'string' ? value.replaceAll('\r', '').trim().slice(0, limit) : '';

function numeric(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) {
			return Math.trunc(parsed);
		}
	}
	return undefined;
}

function readItem(value: unknown): AgentEvidence | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	// Models occasionally capitalize or alias the kind; accept the obvious forms.
	const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
	switch (kind) {
		case 'file': {
			const path = text(raw.path ?? raw.file, MAX_TEXT.path);
			return path
				? { kind: 'file', path, ...(typeof raw.note === 'string' ? { note: text(raw.note, MAX_TEXT.note) } : {}) }
				: undefined;
		}
		case 'search': {
			const query = text(raw.query ?? raw.pattern ?? raw.search, MAX_TEXT.query);
			return query
				? { kind: 'search', query, ...(typeof raw.note === 'string' ? { note: text(raw.note, MAX_TEXT.note) } : {}) }
				: undefined;
		}
		case 'command': {
			const command = text(raw.command ?? raw.cmd, MAX_TEXT.command);
			const exitCode = numeric(raw.exitCode ?? raw.exit_code ?? raw.code);
			return command && exitCode !== undefined
				? {
						kind: 'command',
						command,
						exitCode,
						...(typeof raw.output === 'string' ? { output: text(raw.output, MAX_TEXT.output) } : {}),
					}
				: undefined;
		}
		case 'note': {
			const body = text(raw.text ?? raw.note, MAX_TEXT.note);
			return body ? { kind: 'note', text: body } : undefined;
		}
		default:
			return undefined;
	}
}

export interface EvidenceRead {
	items: AgentEvidence[];
	warnings: string[];
}

function cap(items: AgentEvidence[], limit: number): EvidenceRead {
	if (items.length <= limit) {
		return { items, warnings: [] };
	}
	// Keep the decisive kinds when a report overflows: command first, then file, search and note.
	const ordered = [...items].sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
	return {
		items: ordered.slice(0, limit),
		warnings: [`evidence had ${ordered.length} items; kept the first ${limit} by kind (command, file, search, note)`],
	};
}

/** Reads a reported evidence array item by item; bad entries are skipped, never fatal. */
export function readEvidence(value: unknown, limit = MAX_EVIDENCE): EvidenceRead {
	if (value === undefined) {
		return { items: [], warnings: [] };
	}
	if (!Array.isArray(value)) {
		return { items: [], warnings: ['evidence was not an array; ignored'] };
	}
	const items: AgentEvidence[] = [];
	const warnings: string[] = [];
	value.forEach((entry, index) => {
		const item = readItem(entry);
		if (item) {
			items.push(item);
		} else {
			const kind = entry && typeof entry === 'object' ? (entry as { kind?: unknown }).kind : undefined;
			warnings.push(`evidence[${index}]${typeof kind === 'string' ? ` (${kind})` : ''} was not a valid evidence item; dropped`);
		}
	});
	const capped = cap(items, limit);
	return { items: capped.items, warnings: [...warnings, ...capped.warnings] };
}

/** Persistence-safe evidence: the same tolerant policy, with diagnostics discarded. */
export function sanitizeEvidence(value: unknown): AgentEvidence[] {
	return readEvidence(value).items;
}

function argumentCommand(argumentsText: string): string | undefined {
	try {
		const parsed = JSON.parse(argumentsText) as { command?: unknown };
		return typeof parsed.command === 'string' && parsed.command.trim()
			? parsed.command.trim().slice(0, MAX_TEXT.command)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * The commands a child actually ran, harvested from its transcript. A tool result is the fact; the
 * model's transcription is not. The last run of the same command is the one that counts.
 */
export function collectShellEvidence(messages: readonly Message[]): AgentEvidence[] {
	const calls = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== 'assistant' || !message.toolCalls) {
			continue;
		}
		for (const call of message.toolCalls) {
			if (!SHELL_TOOLS.has(call.name)) {
				continue;
			}
			const command = argumentCommand(call.arguments);
			if (command) {
				calls.set(call.id, command);
			}
		}
	}
	const observed = new Map<string, AgentEvidence>();
	for (const message of messages) {
		if (message.role !== 'tool' || !message.toolCallId) {
			continue;
		}
		const command = calls.get(message.toolCallId);
		if (!command) {
			continue;
		}
		const match = /(?:^|\n)exit_code:\s*(-?\d+)/.exec(message.content ?? '');
		if (!match) {
			continue;
		}
		const exitCode = Number(match[1]);
		if (!Number.isFinite(exitCode)) {
			continue;
		}
		observed.set(command, {
			kind: 'command',
			command,
			exitCode: Math.trunc(exitCode),
			output: (message.content ?? '').slice(0, MAX_TEXT.output),
		});
	}
	// No cap here: a criterion command may have run early, and mergeEvidence must see it to keep it
	// ahead of the noise. The final evidence list is capped once, after prioritisation.
	return [...observed.values()];
}

/**
 * Merges a model report with runtime observations. Command evidence comes only from the transcript;
 * file/search/note evidence remains the model's context. `undefined` observations (an older caller)
 * keep the declared commands, so persisted graphs and tests without a transcript still work.
 */
export function mergeEvidence(
	declared: readonly AgentEvidence[],
	observed: readonly AgentEvidence[] | undefined,
): EvidenceRead {
	if (observed === undefined) {
		return cap([...declared], MAX_EVIDENCE);
	}
	const warnings: string[] = [];
	const claimed = declared.filter((item) => item.kind === 'command');
	if (claimed.length) {
		warnings.push(`${claimed.length} self-reported command item(s) replaced by the runtime transcript`);
	}
	const byCommand = new Map<string, AgentEvidence>();
	for (const item of observed) {
		if (item.kind === 'command') {
			byCommand.set(item.command, item);
		}
	}
	const merged = [...byCommand.values(), ...declared.filter((item) => item.kind !== 'command')];
	const capped = cap(merged, MAX_EVIDENCE);
	return { items: capped.items, warnings: [...warnings, ...capped.warnings] };
}

/** The exact command, or a mirror wrapper such as `cd <copy> && <exact command>`. */
export function commandMatches(observed: string, expected: string): boolean {
	const target = expected.trim();
	let current = observed.trim();
	for (;;) {
		if (current === target) {
			return true;
		}
		const mirror = /^cd\s+[^&;]+\s*(?:&&|;)\s*(.+)$/.exec(current);
		if (!mirror?.[1]) {
			return false;
		}
		current = mirror[1].trim();
	}
}
