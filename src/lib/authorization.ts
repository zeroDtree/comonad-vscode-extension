// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The single-use grant the gate issues for one tool batch and the executor verifies before a tool
 * body runs. Only `issueAuthorization` registers a grant, so a look-alike value cannot pass
 * `verifyAuthorization`, and a cursor round-trip cannot revive a grant: the registry is in-process.
 */
export interface ToolAuthorization {
	readonly sessionId: string;
	/** The turn's batch number, so a grant cannot cover a later batch with reused call ids. */
	readonly batch: number;
	readonly callIds: readonly string[];
}

const issued = new WeakSet<ToolAuthorization>();

/** Mint the grant for one allowed batch. The gate is its only caller. */
export function issueAuthorization(input: {
	sessionId: string;
	batch: number;
	callIds: readonly string[];
}): ToolAuthorization {
	const authorization: ToolAuthorization = Object.freeze({
		sessionId: input.sessionId,
		batch: input.batch,
		callIds: Object.freeze([...input.callIds]),
	});
	issued.add(authorization);
	return authorization;
}

/** Whether this exact grant covers this call, in this batch, for this session. */
export function verifyAuthorization(
	authorization: ToolAuthorization | undefined,
	input: { sessionId: string; batch: number; callId: string },
): boolean {
	return Boolean(
		authorization &&
			issued.has(authorization) &&
			authorization.sessionId === input.sessionId &&
			authorization.batch === input.batch &&
			authorization.callIds.includes(input.callId),
	);
}
