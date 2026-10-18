// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Service, type Context } from 'cordis';

/** Append-only audit trail: every user message, tool call and turn end hits disk as JSONL. */

declare module 'cordis' {
	interface Context {
		audit: Audit;
	}
}

export class Audit extends Service {
	static inject = ['host', 'log'];

	constructor(ctx: Context) {
		super(ctx, 'audit');
	}

	write(sessionId: string, entry: Record<string, unknown>): void {
		const record = { at: Date.now(), sessionId, ...entry };
		try {
			const dir = this.ctx.host.storage.audit;
			mkdirSync(dir, { recursive: true });
			const day = new Date().toISOString().slice(0, 10);
			appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`);
		} catch {
			// auditing must never break a turn
		}
		this.ctx.log.message(`[audit] ${JSON.stringify(entry)}`);
	}
}

export const auditPlugin = Audit;
