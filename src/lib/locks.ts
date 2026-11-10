// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A promise chain per key. Work for one key runs after the work before it; different keys run
 * concurrently. Used for per-file write locks and the shared mailbox. Pure module.
 */
export class KeyedMutex {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const next = previous.then(work, work);
		const tail = next.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		try {
			return await next;
		} finally {
			if (this.tails.get(key) === tail) {
				this.tails.delete(key);
			}
		}
	}
}
