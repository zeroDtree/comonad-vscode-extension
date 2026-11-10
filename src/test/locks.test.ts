// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { KeyedMutex } from '../lib/locks';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

suite('Keyed mutex', () => {
	test('the same key runs in order, while a different key can run alongside it', async () => {
		const mutex = new KeyedMutex();
		const order: string[] = [];
		await Promise.all([
			mutex.run('a', async () => {
				order.push('a1');
				await wait(20);
				order.push('a2');
			}),
			mutex.run('a', async () => {
				order.push('a3');
			}),
			mutex.run('b', async () => {
				order.push('b1');
				await wait(5);
				order.push('b2');
			}),
		]);
		assert.deepStrictEqual(
			order.filter((entry) => entry.startsWith('a')),
			['a1', 'a2', 'a3'],
		);
		assert.deepStrictEqual(
			order.filter((entry) => entry.startsWith('b')),
			['b1', 'b2'],
		);
	});

	test('different keys start together', async () => {
		const mutex = new KeyedMutex();
		let started = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = mutex.run('a', async () => {
			started += 1;
			await gate;
		});
		const second = mutex.run('b', async () => {
			started += 1;
			await gate;
		});
		await wait(10);
		assert.strictEqual(started, 2);
		release();
		await Promise.all([first, second]);
	});

	test('a rejected run releases the key for the next one', async () => {
		const mutex = new KeyedMutex();
		await assert.rejects(
			mutex.run('a', async () => {
				throw new Error('boom');
			}),
			/boom/,
		);
		const result = await mutex.run('a', async () => 'after');
		assert.strictEqual(result, 'after');
	});
});
