// SPDX-License-Identifier: AGPL-3.0-only
import { Service, type Context } from 'cordis';

/** Timestamped log with pluggable sinks (the VS Code output channel is one). */

export interface LogSink {
	write(line: string): void;
	show?(): void;
}

declare module 'cordis' {
	interface Context {
		log: Log;
	}
}

const MAX_LINES = 2_000;

export class Log extends Service {
	private readonly lines: string[] = [];
	private readonly sinks: LogSink[] = [];

	constructor(ctx: Context) {
		super(ctx, 'log');
	}

	/** Attaches a sink for the lifetime of the calling plugin. */
	attach(sink: LogSink): void {
		this.ctx.effect(() => {
			this.sinks.push(sink);
			return () => {
				const index = this.sinks.indexOf(sink);
				if (index >= 0) {
					this.sinks.splice(index, 1);
				}
			};
		}, 'ctx.log.attach()');
	}

	message(text: string): void {
		const line = `[${new Date().toISOString().slice(11, 19)}] ${text}`;
		this.lines.push(line);
		if (this.lines.length > MAX_LINES) {
			this.lines.splice(0, this.lines.length - MAX_LINES);
		}
		for (const sink of [...this.sinks]) {
			try {
				sink.write(line);
			} catch {
				// a broken sink must never break logging
			}
		}
	}

	history(): readonly string[] {
		return this.lines;
	}

	show(): void {
		for (const sink of [...this.sinks]) {
			sink.show?.();
		}
	}
}

export const logPlugin = Log;
