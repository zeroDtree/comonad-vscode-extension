// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The model error taxonomy. Every failure a model request can produce — transport,
 * HTTP refusal, protocol violation — surfaces as one `ModelError` with a stable code,
 * so the runtime's retry engine and the host's semantic retries classify without
 * matching on message text at the call site.
 */

export type ModelErrorCode =
	| 'auth'
	| 'invalid_request'
	| 'context_overflow'
	| 'image_unsupported'
	| 'rate_limited'
	| 'quota'
	| 'transport'
	| 'timeout'
	| 'aborted'
	| 'protocol'
	| 'empty_response'
	| 'server';

export interface ModelErrorOptions {
	/** HTTP status when the endpoint answered. */
	status?: number;
	/** The endpoint's own refusal text, trimmed. Kept separate so callers can show it. */
	detail?: string;
	/** Parsed from a Retry-After header; drives backoff for `rate_limited`. */
	retryAfterMs?: number;
	/** Overrides the per-code default. */
	retryable?: boolean;
	/** The provider's request id when it sent one, for support and traces. */
	providerRequestId?: string;
	cause?: unknown;
}

/** Codes a runtime retry may fix without changing the request. */
const DEFAULT_RETRYABLE: Record<ModelErrorCode, boolean> = {
	auth: false,
	invalid_request: false,
	context_overflow: false,
	image_unsupported: false,
	rate_limited: true,
	quota: false,
	transport: true,
	timeout: true,
	aborted: false,
	protocol: false,
	empty_response: false,
	server: true,
};

/**
 * A request the model stack could not complete. The status is kept as a field, not just in the
 * message, so a caller can tell an over-full prompt (which it can shrink and retry) from a
 * request that is simply wrong.
 */
export class ModelError extends Error {
	readonly code: ModelErrorCode;
	readonly status?: number;
	readonly detail?: string;
	readonly retryAfterMs?: number;
	readonly retryable: boolean;
	readonly providerRequestId?: string;

	constructor(code: ModelErrorCode, message: string, options: ModelErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'ModelError';
		this.code = code;
		this.status = options.status;
		this.detail = options.detail;
		this.retryAfterMs = options.retryAfterMs;
		this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
		this.providerRequestId = options.providerRequestId;
	}
}

/** How an endpoint words "this prompt no longer fits", across the providers worth naming. */
const OVERFLOW_TEXT =
	/context length|context_length|maximum context|context window|too long|too many tokens|token limit|reduce the length|exceeds the maximum/i;

/**
 * How endpoints say "I cannot look at pictures". The wording deliberately avoids a bare `image`, so a
 * context refusal that happens to mention an image is still treated as one.
 */
const IMAGE_REFUSAL =
	/image input|image content|invalid image|unsupported image|does not support image|images are not supported|vision|multimodal/i;

/** The code an HTTP refusal deserves, from its status and wording. */
export function classifyHttpRefusal(status: number, detail: string): ModelErrorCode {
	if ((status === 400 || status === 413 || status === 422) && OVERFLOW_TEXT.test(detail)) {
		return 'context_overflow';
	}
	if ((status === 400 || status === 415 || status === 422) && IMAGE_REFUSAL.test(detail)) {
		return 'image_unsupported';
	}
	if (status === 401 || status === 403) {
		return 'auth';
	}
	if (status === 429) {
		return 'rate_limited';
	}
	if (status >= 500) {
		return 'server';
	}
	return 'invalid_request';
}

/** An HTTP refusal as a ModelError, keeping the endpoint's wording in `detail`. */
export function modelHttpError(status: number, detail: string, options: Omit<ModelErrorOptions, 'status' | 'detail'> = {}): ModelError {
	return new ModelError(classifyHttpRefusal(status, detail), `model request failed (${status}): ${detail}`, {
		...options,
		status,
		detail,
	});
}

/** Whether a refusal was about the prompt's size, which is the one refusal a retry can fix. */
export function isContextOverflow(error: unknown): boolean {
	return error instanceof ModelError && error.code === 'context_overflow';
}

/** Whether a refusal was about the images in the request, which stripping them can fix. */
export function isImageUnsupported(error: unknown): boolean {
	return error instanceof ModelError && error.code === 'image_unsupported';
}

/**
 * Whether the connection failed before the endpoint answered. A reset is worth one more try (a stale
 * keep-alive socket is the usual cause); an image request can then fall back to text. Generic
 * fetch errors are read by wording too, so an unwrapped failure still classifies.
 */
export function isTransportFailure(error: unknown): boolean {
	if (error instanceof ModelError) {
		return error.code === 'transport' || error.code === 'timeout';
	}
	const message = error instanceof Error ? error.message : String(error);
	const cause =
		error instanceof Error && error.cause instanceof Error
			? error.cause.message
			: error instanceof Error && typeof error.cause === 'string'
				? error.cause
				: '';
	return /terminated|fetch failed|other side closed|socket hang up|econnreset|epipe|connection (reset|closed)|network/i.test(
		`${message} ${cause}`,
	);
}

/** Whether a runtime retry may fix this without changing the request. */
export function isRetryable(error: unknown): boolean {
	return error instanceof ModelError ? error.retryable : isTransportFailure(error);
}

/** Whether the call ended because its signal aborted. */
export function isAbortedError(error: unknown): boolean {
	return error instanceof ModelError && error.code === 'aborted';
}

/**
 * Fetch errors lose their cause when only `.message` is read; keep it in the message the
 * turn reports. Anything that is not already a ModelError becomes one, code `transport`.
 */
export function toTransportError(error: unknown): ModelError {
	if (error instanceof ModelError) {
		return error;
	}
	if (!(error instanceof Error)) {
		return new ModelError('transport', String(error), { cause: error });
	}
	const cause =
		error.cause instanceof Error
			? error.cause.message
			: typeof error.cause === 'string'
				? error.cause
				: '';
	const message = cause && !error.message.includes(cause) ? `${error.message}: ${cause}` : error.message;
	return new ModelError('transport', message, { cause: error });
}
