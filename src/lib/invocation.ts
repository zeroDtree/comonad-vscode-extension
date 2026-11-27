// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import type { InvocationContext } from '@comonad/model';

/** A detached call's signal: nothing cancels it but its own timeout. */
const NEVER_ABORT = new AbortController().signal;

/**
 * The invocation context every model call carries: who is calling, which turn, which request.
 * `turnId` is stable across a turn's retries; `requestId` is minted per logical call — a semantic
 * retry that rewrites the transcript starts a new one.
 */
export function makeCtx(
	conversationId: string,
	turn: number | string,
	kind: 'chat' | 'compaction' | 'soft-route' | 'hook',
	signal?: AbortSignal,
	attributes: Record<string, string | number | boolean> = {},
): InvocationContext {
	return {
		conversationId,
		turnId: `${conversationId}:${turn}`,
		requestId: randomUUID(),
		signal: signal ?? NEVER_ABORT,
		attributes: { kind, ...attributes },
	};
}

/** A fresh request id for a retry of the same logical call site. */
export function freshRequestId(ctx: InvocationContext): InvocationContext {
	return { ...ctx, requestId: randomUUID() };
}
