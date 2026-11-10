// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The coordination mailbox shared by the Orchestrator and its parallel subagents. Records are
 * append-only JSONL and untrusted: a peer's message is data, never an instruction. Pure module.
 */

export interface MailboxFrom {
	task?: string;
	agent?: string;
	session?: string;
}

export interface MailboxRecord {
	at: number;
	from: MailboxFrom;
	to: string;
	text: string;
	files?: string[];
}

export const MAILBOX_TARGET_ALL = 'all';
export const MAILBOX_TARGET_ORCHESTRATOR = 'orchestrator';
export const MAX_MESSAGE_TEXT = 4_000;
export const MAX_MESSAGE_FILES = 16;
export const MAX_MAILBOX_RECORDS = 1_000;
export const MAX_MAILBOX_BYTES = 1_000_000;

const TARGET = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function text(value: unknown, limit: number): string {
	return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/** A target task id, `all`, or `orchestrator`. */
export function normalizeTarget(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const target = value.trim().toLowerCase();
	if (target === MAILBOX_TARGET_ALL || target === MAILBOX_TARGET_ORCHESTRATOR) {
		return target;
	}
	return TARGET.test(target) ? target : undefined;
}

/** Validates one record read from the mailbox file or produced by the message tool. */
export function sanitizeMailboxRecord(value: unknown): MailboxRecord | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const to = normalizeTarget(raw.to);
	if (!to) {
		return undefined;
	}
	const body = text(raw.text, MAX_MESSAGE_TEXT);
	if (!body) {
		return undefined;
	}
	const fromRaw = raw.from;
	const from: MailboxFrom = {};
	if (typeof fromRaw === 'string') {
		if (fromRaw.trim()) {
			from.task = text(fromRaw, 64);
		}
	} else if (fromRaw && typeof fromRaw === 'object') {
		const source = fromRaw as Record<string, unknown>;
		const task = text(source.task, 64);
		const agent = text(source.agent, 64);
		const session = text(source.session, 200);
		if (task) {
			from.task = task;
		}
		if (agent) {
			from.agent = agent;
		}
		if (session) {
			from.session = session;
		}
	}
	if (!from.task && !from.agent && !from.session) {
		return undefined;
	}
	const files = Array.isArray(raw.files)
		? raw.files
				.filter((item): item is string => typeof item === 'string' && item.trim().length > 0 && item.length <= 256)
				.slice(0, MAX_MESSAGE_FILES)
		: undefined;
	const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : Date.now();
	return { at, from, to, text: body, ...(files?.length ? { files } : {}) };
}

/** The display label for a sender. */
export function labelOf(from: MailboxFrom): string {
	return from.task ?? from.agent ?? from.session ?? 'unknown';
}

/** Whether a record is addressed to `task` (or to everyone / the orchestrator). */
export function addressedTo(record: MailboxRecord, task: string | undefined): boolean {
	if (record.to === MAILBOX_TARGET_ALL) {
		return true;
	}
	if (task === undefined) {
		return record.to === MAILBOX_TARGET_ORCHESTRATOR;
	}
	return record.to === task;
}

/** The one-line form the task board and tool result show. */
export function formatMailboxRecord(record: MailboxRecord): string {
	const files = record.files?.length ? ` [${record.files.join(', ')}]` : '';
	return `${labelOf(record.from)} -> ${record.to}: ${record.text}${files}`;
}

/** A stable, bounded record id for cursors. */
export function recordKey(record: MailboxRecord, index: number): number {
	return record.at * 1_000 + index;
}

/** A task id used as a mailbox target. */
export function isTaskId(value: string): boolean {
	return ID.test(value);
}
