// SPDX-License-Identifier: AGPL-3.0-only
/** Four independent native execution budgets: turns, tools, tokens and wall-clock time. */

import type { Message } from './types';

export interface BudgetLimits {
	/** Model round trips. `0` means unlimited. */
	turns: number;
	/** Tool calls. `0` means unlimited. */
	tools: number;
	/** Input plus output tokens. `0` means unlimited. */
	tokens: number;
	/** Wall-clock milliseconds. `0` means unlimited. */
	milliseconds: number;
}

export type BudgetDimension = keyof BudgetLimits;
export type BudgetInput = Partial<Record<BudgetDimension, number>>;

/** Where a child's four limits come from: the parent's run or its own default stack. */
export type SubagentBudgetMode = 'inherit' | 'custom';

export interface BudgetUsage {
	turns: number;
	tools: number;
	tokens: number;
	milliseconds: number;
}

export interface BudgetReport {
	limits: BudgetLimits;
	usage: BudgetUsage;
	/** The dimension that stopped the run. Absent when the run ended on its own. */
	stopped?: BudgetDimension;
}

export const NO_BUDGET: BudgetLimits = Object.freeze({ turns: 0, tools: 0, tokens: 0, milliseconds: 0 });

const DIMENSIONS: readonly BudgetDimension[] = ['milliseconds', 'turns', 'tokens', 'tools'];

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function normalizeBudget(input?: BudgetInput | null): BudgetLimits {
	return {
		turns: count(input?.turns),
		tools: count(input?.tools),
		tokens: count(input?.tokens),
		milliseconds: count(input?.milliseconds),
	};
}

/** Smallest non-zero limit per dimension; `0` means "no opinion", never "zero allowance". */
function tightest(values: readonly number[]): number {
	let result = 0;
	for (const value of values) {
		if (value > 0 && (result === 0 || value < result)) {
			result = value;
		}
	}
	return result;
}

export function mergeBudget(...inputs: readonly (BudgetInput | undefined)[]): BudgetLimits {
	const found = inputs.map((input) => normalizeBudget(input));
	return {
		turns: tightest(found.map((limit) => limit.turns)),
		tools: tightest(found.map((limit) => limit.tools)),
		tokens: tightest(found.map((limit) => limit.tokens)),
		milliseconds: tightest(found.map((limit) => limit.milliseconds)),
	};
}

export interface SubagentBudgetInput {
	mode: SubagentBudgetMode;
	/** The parent run's current limits; used by `inherit`. */
	parent?: BudgetInput;
	/** The global child default; used by `custom`. */
	global?: BudgetInput;
	/** The role's default; used by `custom`. */
	role?: BudgetInput;
	/** The task plan or resume override; tightens either mode. */
	task?: BudgetInput;
}

/**
 * Resolve one child segment's limits. `inherit` copies the parent's limits (not its remaining
 * budget) and ignores the child defaults/role so a role's 6–16 turns cannot silently shorten an
 * inherited 40. A task/resume budget still tightens both modes.
 */
export function resolveSubagentBudget(input: SubagentBudgetInput): BudgetLimits {
	return input.mode === 'inherit'
		? mergeBudget(input.parent, input.task)
		: mergeBudget(input.global, input.role, input.task);
}

/** `0` (unlimited) leaves the other side alone, so a role can only narrow. */
export function narrowLimit(current: number, next: number): number {
	return current === 0 ? next : next === 0 ? current : Math.min(current, next);
}

export function remainingBudget(limits: BudgetLimits, usage: BudgetUsage, now = Date.now(), startedAt = now): BudgetUsage {
	return {
		turns: limits.turns === 0 ? 0 : Math.max(0, limits.turns - usage.turns),
		tools: limits.tools === 0 ? 0 : Math.max(0, limits.tools - usage.tools),
		tokens: limits.tokens === 0 ? 0 : Math.max(0, limits.tokens - usage.tokens),
		milliseconds:
			limits.milliseconds === 0 ? 0 : Math.max(0, limits.milliseconds - Math.max(usage.milliseconds, now - startedAt)),
	};
}

const LABELS: Record<BudgetDimension, string> = {
	turns: 'turn',
	tools: 'tool',
	tokens: 'token',
	milliseconds: 'time',
};

export function budgetLabel(dimension: BudgetDimension): string {
	return LABELS[dimension];
}

export function budgetNote(dimension: BudgetDimension): string {
	return `Error: the ${budgetLabel(dimension)} budget was exhausted before this tool call ran; resume to continue.`;
}

export function describeBudget(limits: BudgetLimits): string {
	const parts = (Object.keys(limits) as BudgetDimension[])
		.filter((dimension) => limits[dimension] > 0)
		.map((dimension) => `${limits[dimension]} ${dimension}`);
	return parts.length > 0 ? parts.join(', ') : 'unlimited';
}

/** A live budget for one run segment. `0` limits are unlimited. */
export class RunBudget {
	readonly limits: BudgetLimits;
	readonly usage: BudgetUsage;
	readonly startedAt: number;
	private stopped?: BudgetDimension;

	constructor(limits: BudgetInput = {}, usage: Partial<BudgetUsage> = {}, startedAt = Date.now()) {
		this.limits = normalizeBudget(limits);
		this.usage = { turns: 0, tools: 0, tokens: 0, milliseconds: 0, ...usage };
		this.startedAt = startedAt;
	}

	get stopReason(): BudgetDimension | undefined {
		return this.stopped;
	}

	/**
	 * The first dimension at or over its limit wins; later calls keep the same reason. `only`
	 * narrows the check: a turn budget stops the *next* model round, not the tool calls the current
	 * round already asked for, so the tool path checks time/tokens/tools but not turns.
	 */
	check(now = Date.now(), only: readonly BudgetDimension[] = DIMENSIONS): BudgetDimension | undefined {
		if (this.stopped) {
			return only.includes(this.stopped) ? this.stopped : undefined;
		}
		const elapsed = Math.max(this.usage.milliseconds, now - this.startedAt);
		for (const dimension of only) {
			const limit = this.limits[dimension];
			if (limit > 0 && (dimension === 'milliseconds' ? elapsed : this.usage[dimension]) >= limit) {
				this.stopped = dimension;
				return dimension;
			}
		}
		return undefined;
	}

	stop(dimension: BudgetDimension): BudgetDimension {
		this.stopped ??= dimension;
		return this.stopped;
	}

	spendTurn(now = Date.now()): void {
		this.usage.turns += 1;
		this.usage.milliseconds = Math.max(this.usage.milliseconds, now - this.startedAt);
	}

	spendTools(tools: number, now = Date.now()): void {
		if (tools > 0) {
			this.usage.tools += tools;
		}
		this.usage.milliseconds = Math.max(this.usage.milliseconds, now - this.startedAt);
	}

	spendTokens(tokens: number, now = Date.now()): void {
		if (tokens > 0) {
			this.usage.tokens += tokens;
		}
		this.usage.milliseconds = Math.max(this.usage.milliseconds, now - this.startedAt);
	}

	remaining(now = Date.now()): BudgetUsage {
		return remainingBudget(this.limits, this.usage, now, this.startedAt);
	}

	deadline(): number | undefined {
		return this.limits.milliseconds > 0 ? this.startedAt + this.limits.milliseconds : undefined;
	}

	report(now = Date.now()): BudgetReport {
		return {
			limits: this.limits,
			usage: { ...this.usage, milliseconds: Math.max(this.usage.milliseconds, now - this.startedAt) },
			...(this.stopped ? { stopped: this.stopped } : {}),
		};
	}

	/** The cursor stores RunState as JSON; keep the counters and revive the methods on load. */
	toJSON(): { limits: BudgetLimits; usage: BudgetUsage; startedAt: number; stopped?: BudgetDimension } {
		return {
			limits: this.limits,
			usage: this.usage,
			startedAt: this.startedAt,
			...(this.stopped ? { stopped: this.stopped } : {}),
		};
	}

	static from(value: unknown): RunBudget | undefined {
		if (value instanceof RunBudget) {
			return value;
		}
		if (!value || typeof value !== 'object') {
			return undefined;
		}
		const raw = value as { limits?: BudgetInput; usage?: Partial<BudgetUsage>; startedAt?: number; stopped?: BudgetDimension };
		const budget = new RunBudget(raw.limits, raw.usage, raw.startedAt);
		if (raw.stopped && (Object.keys(budget.limits) as BudgetDimension[]).includes(raw.stopped)) {
			budget.stop(raw.stopped);
		}
		return budget;
	}
}

/**
 * Close a transcript at a message boundary: every assistant tool call without a result gets a
 * synthetic result, so the next run (a resume) can send the conversation to the model unchanged.
 * Returns the last assistant text, the best partial answer available.
 */
export function sealPartial(messages: Message[], transcript: Message[], dimension: BudgetDimension): string {
	const answered = new Set<string>();
	for (const message of transcript) {
		if (message.role === 'tool' && message.toolCallId) {
			answered.add(message.toolCallId);
		}
	}
	const pending: Message[] = [];
	for (const message of transcript) {
		if (message.role !== 'assistant' || !message.toolCalls?.length) {
			continue;
		}
		for (const call of message.toolCalls) {
			if (!answered.has(call.id)) {
				answered.add(call.id);
				pending.push({ role: 'tool', toolCallId: call.id, content: budgetNote(dimension), at: Date.now() });
			}
		}
	}
	if (pending.length > 0) {
		transcript.push(...pending);
		if (messages !== transcript) {
			messages.push(...pending);
		}
	}
	for (let index = transcript.length - 1; index >= 0; index -= 1) {
		const message = transcript[index];
		if (message.role === 'assistant' && message.content.trim()) {
			return message.content;
		}
	}
	return '';
}
