// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { costFor, isPriced } from '../src/pricing/cost';
import { addUsage } from '../src/runtime/usage';

suite('cost', () => {
	test('the four terms price the whole prompt exactly once', () => {
		const cost = costFor(
			{ input: 1_000_000, output: 100_000, cached: 200_000, cacheWrite: 100_000 },
			{ inPerM: 1, cachedInPerM: 0.5, cacheWritePerM: 1.25, outPerM: 2 },
		);
		// fresh 700k × 1 + cached 200k × 0.5 + write 100k × 1.25 + out 100k × 2
		assert.strictEqual(cost, 0.7 + 0.1 + 0.125 + 0.2);
	});

	test('a cache write without its own price falls back to the input price', () => {
		const cost = costFor(
			{ input: 1_000_000, output: 0, cacheWrite: 400_000 },
			{ inPerM: 3, outPerM: 1 },
		);
		// fresh 600k + write 400k, both at 3
		assert.strictEqual(cost, 1.8 + 1.2);
	});

	test('a cache hit without its own price falls back to the input price', () => {
		const cost = costFor({ input: 1_000_000, output: 0, cached: 400_000 }, { inPerM: 3, outPerM: 1 });
		assert.strictEqual(cost, 3);
	});

	test('no cache reporting prices everything as fresh input', () => {
		const cost = costFor({ input: 1_000_000, output: 500_000 }, { inPerM: 1, cachedInPerM: 0.1, outPerM: 2 });
		assert.strictEqual(cost, 1 + 1);
	});

	test('an unpriced model is null, never zero dollars', () => {
		assert.strictEqual(costFor({ input: 10, output: 10 }, undefined), null);
		assert.strictEqual(costFor({ input: 10, output: 10 }, {}), null);
		assert.strictEqual(costFor({ input: 10, output: 10 }, { inPerM: 1 }), null);
		assert.strictEqual(costFor({ input: 10, output: 10 }, { outPerM: 1 }), null);
	});

	test('overlapping token counts clamp instead of double-billing', () => {
		const cost = costFor(
			{ input: 100, output: 0, cached: 60, cacheWrite: 80 },
			{ inPerM: 1, cachedInPerM: 0.5, cacheWritePerM: 1.25, outPerM: 1 },
		);
		// cached clamps to 60, write clamps to 40, fresh to 0
		assert.strictEqual(cost, 0.00003 + 0.00005);
	});

	test('isPriced mirrors what costFor can answer', () => {
		assert.ok(isPriced({ inPerM: 1, outPerM: 2 }));
		assert.ok(!isPriced({ inPerM: 1 }));
		assert.ok(!isPriced());
	});
});

suite('usage accumulation', () => {
	test('counts add across requests', () => {
		assert.deepStrictEqual(
			addUsage({ input: 10, output: 5, cached: 3 }, { input: 7, output: 2, cached: 1 }),
			{ input: 17, output: 7, cached: 4 },
		);
	});

	test('a cache field stays absent unless some term reported it', () => {
		assert.deepStrictEqual(addUsage({ input: 1, output: 1 }, { input: 2, output: 2 }), { input: 3, output: 3 });
		assert.deepStrictEqual(addUsage({ input: 1, output: 1, cached: 0 }, { input: 2, output: 2 }), {
			input: 3,
			output: 3,
			cached: 0,
		});
	});

	test('an absent side is the identity', () => {
		assert.strictEqual(addUsage(undefined, undefined), undefined);
		assert.deepStrictEqual(addUsage(undefined, { input: 1, output: 1 }), { input: 1, output: 1 });
		assert.deepStrictEqual(addUsage({ input: 1, output: 1 }, undefined), { input: 1, output: 1 });
	});
});
