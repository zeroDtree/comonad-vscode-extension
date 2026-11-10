// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Service, type Context } from 'cordis';
import { KeyedMutex } from '../lib/locks';
import {
	addressedTo,
	MAX_MAILBOX_BYTES,
	MAX_MAILBOX_RECORDS,
	MAX_MESSAGE_FILES,
	MAX_MESSAGE_TEXT,
	sanitizeMailboxRecord,
	type MailboxFrom,
	type MailboxRecord,
} from '../lib/mailbox';

/**
 * The per-root-chat coordination mailbox. One append-only JSONL file under extension storage; the
 * Orchestrator and its parallel subagents exchange notes through it. Messages are untrusted data.
 */

declare module 'cordis' {
	interface Context {
		mailbox: Mailbox;
	}
}

export interface MailboxRead {
	messages: MailboxRecord[];
	/** The sequence number after the last record this read consumed. */
	cursor: number;
}

export class Mailbox extends Service {
	static inject = ['host', 'log'];

	private readonly locks = new KeyedMutex();
	/** Per child session, the mailbox sequence it has already read. */
	private readonly cursors = new Map<string, number>();

	constructor(ctx: Context) {
		super(ctx, 'mailbox');
	}

	private path(rootSessionId: string): string {
		const safe = rootSessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'session';
		return join(this.ctx.host.storage.root, 'coordination', `${safe}.jsonl`);
	}

	/** Appends one note. A full mailbox is an error, not silent loss. */
	async send(
		rootSessionId: string,
		from: MailboxFrom,
		to: string,
		text: string,
		files?: string[],
	): Promise<MailboxRecord> {
		if (typeof text !== 'string' || !text.trim()) {
			throw new Error('a message needs text');
		}
		if (text.length > MAX_MESSAGE_TEXT) {
			throw new Error(`a message may be at most ${MAX_MESSAGE_TEXT} characters`);
		}
		if (files && files.length > MAX_MESSAGE_FILES) {
			throw new Error(`a message may name at most ${MAX_MESSAGE_FILES} files`);
		}
		const record = sanitizeMailboxRecord({ at: Date.now(), from, to, text, files });
		if (!record) {
			throw new Error('the message target or sender is invalid');
		}
		const file = this.path(rootSessionId);
		return this.locks.run(file, async () => {
			mkdirSync(dirname(file), { recursive: true });
			let size = 0;
			try {
				size = statSync(file).size;
			} catch {
				size = 0;
			}
			if (size > MAX_MAILBOX_BYTES) {
				throw new Error('the coordination mailbox is full; coordinate through task results instead');
			}
			let records = 0;
			try {
				records = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
			} catch {
				records = 0;
			}
			if (records >= MAX_MAILBOX_RECORDS) {
				throw new Error('the coordination mailbox has too many messages; coordinate through task results instead');
			}
			appendFileSync(file, `${JSON.stringify(record)}\n`);
			return record;
		});
	}

	/** The messages addressed to `task` (or the orchestrator) after the session's cursor. */
	read(rootSessionId: string, sessionId: string, task: string | undefined, since?: number, limit = 50): MailboxRead {
		const start = Number.isFinite(since) && since !== undefined ? Math.max(0, Math.trunc(since)) : (this.cursors.get(sessionId) ?? 0);
		const file = this.path(rootSessionId);
		let lines: string[] = [];
		try {
			lines = readFileSync(file, 'utf8').split('\n');
		} catch {
			return { messages: [], cursor: start };
		}
		const messages: MailboxRecord[] = [];
		let cursor = start;
		let index = 0;
		for (const line of lines) {
			if (!line.trim()) {
				continue;
			}
			const at = index;
			index += 1;
			if (at < start) {
				continue;
			}
			cursor = at + 1;
			let record: MailboxRecord | undefined;
			try {
				record = sanitizeMailboxRecord(JSON.parse(line));
			} catch {
				record = undefined;
			}
			if (record && addressedTo(record, task)) {
				messages.push(record);
			}
			if (messages.length >= limit) {
				break;
			}
		}
		this.cursors.set(sessionId, cursor);
		return { messages, cursor };
	}

	/** The last records regardless of target, for the Orchestrator prompt and the board. */
	recent(rootSessionId: string, limit = 10): MailboxRecord[] {
		const file = this.path(rootSessionId);
		let lines: string[] = [];
		try {
			lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
		} catch {
			return [];
		}
		const out: MailboxRecord[] = [];
		for (const line of lines.slice(-Math.max(1, limit))) {
			try {
				const record = sanitizeMailboxRecord(JSON.parse(line));
				if (record) {
					out.push(record);
				}
			} catch {
				continue;
			}
		}
		return out;
	}

	/** Removes the mailbox when its root chat is removed. */
	remove(rootSessionId: string): void {
		try {
			unlinkSync(this.path(rootSessionId));
		} catch {
			// already gone
		}
		this.cursors.clear();
	}
}

export const mailboxPlugin = Mailbox;
