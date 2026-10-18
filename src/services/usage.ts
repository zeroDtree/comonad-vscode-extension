// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Service, type Context } from 'cordis';

/** Daily token accounting, persisted under the storage root. */

export interface UsageDay {
	input: number;
	output: number;
	requests: number;
}

export function dayKey(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function formatUsage(day: UsageDay): string {
	const total = day.input + day.output;
	return `${day.requests} requests · ${total} tokens (${day.input} in / ${day.output} out)`;
}

declare module 'cordis' {
	interface Context {
		usage: Usage;
	}
}

export class Usage extends Service {
	static inject = ['host'];

	private file = '';

	constructor(ctx: Context) {
		super(ctx, 'usage');
	}

	private get path(): string {
		this.file ||= join(this.ctx.host.storage.root, 'usage.json');
		return this.file;
	}

	add(usage: Partial<UsageDay>): void {
		const days = this.days();
		const key = dayKey();
		const day = days[key] ?? { input: 0, output: 0, requests: 0 };
		day.input += usage.input ?? 0;
		day.output += usage.output ?? 0;
		day.requests += usage.requests ?? 0;
		days[key] = day;
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify(days));
	}

	today(): UsageDay {
		return this.days()[dayKey()] ?? { input: 0, output: 0, requests: 0 };
	}

	total(): UsageDay {
		return Object.values(this.days()).reduce(
			(sum, day) => ({ input: sum.input + day.input, output: sum.output + day.output, requests: sum.requests + day.requests }),
			{ input: 0, output: 0, requests: 0 },
		);
	}

	days(): Record<string, UsageDay> {
		if (!existsSync(this.path)) {
			return {};
		}
		try {
			return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, UsageDay>;
		} catch {
			return {};
		}
	}
}

export const usagePlugin = Usage;
