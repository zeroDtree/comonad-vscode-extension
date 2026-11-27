// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The runtime's retry engine. One invariant is stronger than every rule here: a failure
 * after the stream showed anything is never retried, because the consumer would see the
 * answer twice. Semantic retries that rewrite the transcript (shrinking a too-large
 * prompt, dropping images) belong to the host, not here.
 */
import { ModelError, isRetryable } from '../errors';
import type { RetryPolicy } from '../config/schema';

export interface RetryPlan {
	retry: boolean;
	/** Present only when retry is true. */
	delayMs?: number;
	reason: string;
}

/**
 * Whether the failed attempt may run again, and after how long. `attempt` is 1-based —
 * the number of the attempt that just failed. A provider `Retry-After` wins over backoff.
 */
export function planRetry(
	error: unknown,
	attempt: number,
	policy: RetryPolicy,
	streamed: boolean,
): RetryPlan {
	if (streamed) {
		return { retry: false, reason: 'the stream already showed output' };
	}
	if (attempt >= policy.maxAttempts) {
		return { retry: false, reason: `attempt ${attempt} of ${policy.maxAttempts} failed` };
	}
	const code = error instanceof ModelError ? error.code : 'transport';
	if (!policy.retryableCodes.includes(code)) {
		return { retry: false, reason: `code "${code}" is not retryable` };
	}
	if (!isRetryable(error)) {
		return { retry: false, reason: `code "${code}" refused a retry` };
	}
	const retryAfterMs = error instanceof ModelError ? error.retryAfterMs : undefined;
	return {
		retry: true,
		delayMs: retryAfterMs ?? backoffMs(attempt, policy),
		reason: `code "${code}" is retryable`,
	};
}

/** Exponential backoff with full jitter, capped. */
export function backoffMs(attempt: number, policy: RetryPolicy): number {
	const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
	return Math.floor(Math.random() * ceiling);
}

/** A cancellable sleep: an abort ends the wait without pretending it elapsed. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolveSleep, reject) => {
		if (signal?.aborted) {
			reject(new ModelError('aborted', 'model request aborted'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolveSleep();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new ModelError('aborted', 'model request aborted'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
