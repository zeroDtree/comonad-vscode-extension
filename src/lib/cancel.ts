// SPDX-License-Identifier: AGPL-3.0-only

/** Abort helpers shared by a turn, its tools and the processes they start. */

/**
 * Forward `source` to `target`, including a signal that aborted before it was linked. Returns the
 * unlink to call when the turn ends.
 */
export function linkAbort(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) {
		return () => undefined;
	}
	const forward = (): void => target.abort(source.reason);
	if (source.aborted) {
		forward();
		return () => undefined;
	}
	source.addEventListener('abort', forward, { once: true });
	return () => source.removeEventListener('abort', forward);
}

/**
 * Settle with `work`, or reject as soon as `signal` aborts. For waits that cannot take a signal
 * (VS Code APIs, hooks, plugin calls): the turn stops waiting while the work may finish on its own,
 * and its late rejection is observed here rather than becoming an unhandled rejection.
 */
export function abortable<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
	if (!signal) {
		return work;
	}
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(signal.reason ?? new DOMException('The turn was stopped.', 'AbortError'));
		signal.addEventListener('abort', abort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener('abort', abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener('abort', abort);
				reject(error);
			},
		);
	});
}
