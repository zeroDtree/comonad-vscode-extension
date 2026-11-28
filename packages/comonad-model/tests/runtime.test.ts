// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import type { ProviderEntry, RetryPolicy, Transport } from '../src/index';
import { ModelError } from '../src/errors';
import { fallbackChain } from '../src/runtime/fallback';
import { planRetry } from '../src/runtime/retry';
import { ModelRuntime, parseModelRef } from '../src/runtime/runtime';
import { shapeModelIds } from '../src/runtime/catalog';
import {
	makeFakeProvider,
	makeFakeEntry,
	makeFakeProtocol,
	type FakeCall,
	type FakeOutcome,
} from '../src/testing';
import type { InvocationContext, Message, ProviderStreamEvent, RuntimeStreamEvent } from '../src/types';

const noTransport: Transport = {
	send: async () => {
		throw new Error('these tests never reach a transport');
	},
};

function keysWith(key = 'test-key'): { keyFor: () => Promise<string | undefined>; env: () => undefined } {
	return { keyFor: async () => key, env: () => undefined };
}

function ctxOf(): InvocationContext {
	return {
		conversationId: 's1',
		turnId: 's1:1',
		requestId: `r-${Math.random().toString(36).slice(2)}`,
		signal: new AbortController().signal,
	};
}

function runtimeOf(
	handler: ((call: FakeCall, emit: (event: ProviderStreamEvent) => void) => Promise<FakeOutcome>) | undefined,
	entries: ProviderEntry[] = [makeFakeEntry({ retry: { baseDelayMs: 0, maxDelayMs: 0 } })],
	options: { listModels?: () => Promise<string[]>; definition?: Partial<import('../src/config/schema').ProviderDefinition> } = {},
) {
	const fake = makeFakeProtocol({ handler, listModels: options.listModels });
	const runtime = new ModelRuntime({
		transport: noTransport,
		keys: keysWith(),
		entries: () => entries,
	});
	runtime.registerProtocol(fake.definition);
	runtime.registerDefinition(makeFakeProvider(options.definition));
	return { runtime, fake };
}

suite('model refs', () => {
	test('the grammar is auto | instance | instance:model', () => {
		assert.deepStrictEqual(parseModelRef('auto'), {});
		assert.deepStrictEqual(parseModelRef(''), {});
		assert.deepStrictEqual(parseModelRef('deepseek'), { providerId: 'deepseek' });
		assert.deepStrictEqual(parseModelRef('deepseek:deepseek-chat'), { providerId: 'deepseek', model: 'deepseek-chat' });
		assert.deepStrictEqual(parseModelRef('deepseek:'), { providerId: 'deepseek', model: undefined });
	});
});

suite('retry plan', () => {
	const policy: RetryPolicy = {
		maxAttempts: 2,
		retryableCodes: ['transport', 'timeout', 'rate_limited', 'server'],
		baseDelayMs: 10,
		maxDelayMs: 100,
	};

	test('a pre-stream retryable failure schedules another attempt', () => {
		const plan = planRetry(new ModelError('transport', 'x'), 1, policy, false);
		assert.strictEqual(plan.retry, true);
		assert.ok((plan.delayMs ?? 0) >= 0 && (plan.delayMs ?? 0) <= 10);
	});

	test('the pre-stream guard outranks every retryable code', () => {
		assert.strictEqual(planRetry(new ModelError('transport', 'x'), 1, policy, true).retry, false);
	});

	test('an exhausted budget stops', () => {
		assert.strictEqual(planRetry(new ModelError('transport', 'x'), 2, policy, false).retry, false);
	});

	test('a code outside the policy stops even when the code is retryable in general', () => {
		const narrow: RetryPolicy = { ...policy, retryableCodes: ['transport'] };
		assert.strictEqual(planRetry(new ModelError('timeout', 'x'), 1, narrow, false).retry, false);
	});

	test('a provider Retry-After wins over backoff', () => {
		const plan = planRetry(new ModelError('rate_limited', 'x', { retryAfterMs: 321 }), 1, policy, false);
		assert.strictEqual(plan.delayMs, 321);
	});
});

suite('runtime chat pipeline', () => {
	test('a pre-stream failure retries once and reports it', async () => {
		let calls = 0;
		const { runtime, fake } = runtimeOf(async (_call, emit) => {
			calls += 1;
			if (calls === 1) {
				throw new ModelError('transport', 'reset');
			}
			emit({ type: 'text', text: 'ok' });
			emit({ type: 'finish', reason: 'stop' });
			return { message: { role: 'assistant', content: 'ok' } as Message };
		});
		const events: RuntimeStreamEvent[] = [];
		const result = await runtime.chat({ model: 'fake', messages: [], tools: [], ctx: ctxOf(), onEvent: (event) => events.push(event) });
		assert.strictEqual(result.message.content, 'ok');
		assert.strictEqual(fake.calls.length, 2);
		const notices = events.filter((event) => event.type === 'notice');
		assert.strictEqual(notices.length, 1);
		assert.deepStrictEqual(notices[0], { type: 'notice', kind: 'retry', message: 'retrying fake: code "transport" is retryable', attempt: 1 });
		assert.deepStrictEqual(result.attempts.map((attempt) => attempt.ok), [false, true]);
	});

	test('a failure after the stream showed output is never retried', async () => {
		const boom = new ModelError('transport', 'reset mid-stream');
		const { runtime, fake } = runtimeOf(async (_call, emit) => {
			emit({ type: 'text', text: 'half an answ' });
			throw boom;
		});
		const events: RuntimeStreamEvent[] = [];
		await assert.rejects(
			runtime.chat({ model: 'fake', messages: [], tools: [], ctx: ctxOf(), onEvent: (event) => events.push(event) }),
			(error: unknown) => error === boom,
		);
		assert.strictEqual(fake.calls.length, 1);
		assert.ok(!events.some((event) => event.type === 'notice'));
	});

	test('the fallback chain walks on while nothing was shown', async () => {
		const { runtime, fake } = runtimeOf(
			async (call, emit) => {
				if (call.model === 'model-a') {
					throw new ModelError('auth', 'bad key');
				}
				emit({ type: 'text', text: 'from b' });
				emit({ type: 'finish', reason: 'stop' });
				return { message: { role: 'assistant', content: 'from b' } as Message };
			},
			[
				makeFakeEntry({ id: 'a', model: 'model-a', fallback: ['b'], retry: { baseDelayMs: 0, maxDelayMs: 0 } }),
				makeFakeEntry({ id: 'b', model: 'model-b', retry: { baseDelayMs: 0, maxDelayMs: 0 } }),
			],
		);
		const events: RuntimeStreamEvent[] = [];
		const result = await runtime.chat({ model: 'a', messages: [], tools: [], ctx: ctxOf(), onEvent: (event) => events.push(event) });
		assert.strictEqual(result.message.content, 'from b');
		assert.deepStrictEqual(result.attempts.map((attempt) => `${attempt.providerId}:${attempt.ok}`), ['a:false', 'b:true']);
		const notice = events.find((event) => event.type === 'notice');
		assert.deepStrictEqual(notice, { type: 'notice', kind: 'fallback', message: 'falling back to provider "b"' });
		assert.strictEqual(fake.calls.length, 2);
	});

	test('a fallback never starts after the stream showed output', async () => {
		const { runtime, fake } = runtimeOf(
			async (call, emit) => {
				if (call.model === 'model-a') {
					emit({ type: 'text', text: 'half' });
					throw new ModelError('transport', 'reset');
				}
				return { message: { role: 'assistant', content: 'from b' } as Message };
			},
			[
				makeFakeEntry({ id: 'a', model: 'model-a', fallback: ['b'], retry: { baseDelayMs: 0, maxDelayMs: 0 } }),
				makeFakeEntry({ id: 'b', model: 'model-b', retry: { baseDelayMs: 0, maxDelayMs: 0 } }),
			],
		);
		await assert.rejects(
			runtime.chat({ model: 'a', messages: [], tools: [], ctx: ctxOf() }),
			(error: unknown) => error instanceof ModelError && error.code === 'transport',
		);
		assert.strictEqual(fake.calls.length, 1);
	});

	test('an exhausted retry budget falls through to the next instance', async () => {
		const { runtime } = runtimeOf(
			async (call) => {
				if (call.model === 'model-a') {
					throw new ModelError('transport', 'always down');
				}
				return { message: { role: 'assistant', content: 'from b' } as Message };
			},
			[
				makeFakeEntry({ id: 'a', model: 'model-a', fallback: ['b'], retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } }),
				makeFakeEntry({ id: 'b', model: 'model-b', retry: { baseDelayMs: 0, maxDelayMs: 0 } }),
			],
		);
		const events: RuntimeStreamEvent[] = [];
		const result = await runtime.chat({ model: 'a', messages: [], tools: [], ctx: ctxOf(), onEvent: (event) => events.push(event) });
		assert.strictEqual(result.message.content, 'from b');
		assert.deepStrictEqual(result.attempts.map((attempt) => `${attempt.providerId}:${attempt.ok}`), ['a:false', 'a:false', 'b:true']);
		assert.strictEqual(events.filter((event) => event.type === 'notice' && event.kind === 'retry').length, 1);
	});

	test('a narrowed retryableCodes refuses a normally-retryable code', async () => {
		const { runtime, fake } = runtimeOf(async () => {
			throw new ModelError('timeout', 'slow');
		}, [makeFakeEntry({ retry: { retryableCodes: ['transport'], baseDelayMs: 0, maxDelayMs: 0 } })]);
		await assert.rejects(
			runtime.chat({ model: 'fake', messages: [], tools: [], ctx: ctxOf() }),
			(error: unknown) => error instanceof ModelError && error.code === 'timeout',
		);
		assert.strictEqual(fake.calls.length, 1);
	});

	test('the fallback chain drops cycles and repeats', () => {
		assert.deepStrictEqual(fallbackChain('a', ['b', 'a', 'c', 'b']), ['a', 'b', 'c']);
		assert.deepStrictEqual(fallbackChain('a', []), ['a']);
	});
});

suite('runtime resolve', () => {
	test('auto runs the first instance; a bare instance runs its default model', async () => {
		const { runtime } = runtimeOf(undefined, [
			makeFakeEntry({ id: 'a', model: 'model-a' }),
			makeFakeEntry({ id: 'b', model: 'model-b' }),
		]);
		assert.strictEqual((await runtime.resolveCall({})).model, 'model-a');
		assert.strictEqual((await runtime.resolveCall({ providerId: 'b' })).model, 'model-b');
		assert.strictEqual((await runtime.resolveCall({ providerId: 'b', model: 'named' })).model, 'named');
	});

	test('an unknown provider, definition or protocol is a refusal', async () => {
		const { runtime } = runtimeOf(undefined, [makeFakeEntry({ id: 'a', model: 'm' })]);
		await assert.rejects(
			runtime.resolveCall({ providerId: 'ghost' }),
			(error: unknown) => error instanceof ModelError && /unknown provider/.test(error.message),
		);
		const ghostDefinition = new ModelRuntime({
			transport: noTransport,
			keys: keysWith(),
			entries: () => [makeFakeEntry({ id: 'x', model: 'm', provider: 'ghost' })],
		});
		ghostDefinition.registerProtocol(makeFakeProtocol().definition);
		await assert.rejects(
			ghostDefinition.resolveCall({ providerId: 'x' }),
			(error: unknown) => error instanceof ModelError && /definition/.test(error.message),
		);
		const withoutModel = new ModelRuntime({
			transport: noTransport,
			keys: keysWith(),
			entries: () => [makeFakeEntry({ model: undefined })],
		});
		withoutModel.registerProtocol(makeFakeProtocol().definition);
		withoutModel.registerDefinition(makeFakeProvider());
		await assert.rejects(
			withoutModel.resolveCall({ providerId: 'fake' }),
			(error: unknown) => error instanceof ModelError && /names no model/.test(error.message),
		);
	});

	test('registration checks the apiVersion', async () => {
		const { runtime } = runtimeOf(undefined);
		assert.throws(() => runtime.registerProtocol({ ...makeFakeProtocol().definition, apiVersion: 2 }), /apiVersion/);
		assert.throws(() => runtime.registerDefinition({ ...makeFakeProvider(), apiVersion: 99 }), /apiVersion/);
	});
});

suite('runtime complete', () => {
	test('the text comes back trimmed', async () => {
		const { runtime } = runtimeOf(async () => ({ message: { role: 'assistant', content: '  spaced  ' } as Message }));
		assert.strictEqual(
			await runtime.complete({ model: 'fake', system: 's', prompt: 'p', ctx: ctxOf() }),
			'spaced',
		);
	});

	test('a reasoning-only reply names the cause instead of returning empty', async () => {
		const { runtime } = runtimeOf(async () => ({
			message: { role: 'assistant', content: '', reasoning: 'thinking out loud' } as Message,
		}));
		await assert.rejects(
			runtime.complete({ model: 'fake', system: 's', prompt: 'p', ctx: ctxOf(), rejectReasoningOnly: true }),
			(error: unknown) => error instanceof ModelError && error.code === 'empty_response',
		);
	});

	test('a timed-out call throws instead of returning a partial', async () => {
		const { runtime } = runtimeOf(
			async () =>
				new Promise<FakeOutcome>((resolve) =>
					setTimeout(() => resolve({ message: { role: 'assistant', content: 'late' } as Message }), 50),
				),
		);
		await assert.rejects(
			runtime.complete({ model: 'fake', system: 's', prompt: 'p', ctx: ctxOf(), timeoutMs: 5 }),
			(error: unknown) => error instanceof Error && error.name === 'TimeoutError',
		);
	});
});

suite('model catalog', () => {
	test('a listing caches until invalidated', async () => {
		let fetches = 0;
		const { runtime } = runtimeOf(undefined, undefined, {
			listModels: async () => {
				fetches += 1;
				return ['fake-small', 'fake-large'];
			},
		});
		const ctx = ctxOf();
		await runtime.listModels('fake', ctx);
		await runtime.listModels('fake', ctx);
		assert.strictEqual(fetches, 1);
		runtime.invalidateCatalog('fake');
		await runtime.listModels('fake', ctx);
		assert.strictEqual(fetches, 2);
	});

	test('a key change misses the cache without a hook', async () => {
		let fetches = 0;
		let key = 'one';
		const fake = makeFakeProtocol({
			listModels: async () => {
				fetches += 1;
				return ['fake-small'];
			},
		});
		const runtime = new ModelRuntime({
			transport: noTransport,
			keys: { keyFor: async () => key, env: () => undefined },
			entries: () => [makeFakeEntry()],
		});
		runtime.registerProtocol(fake.definition);
		runtime.registerDefinition(makeFakeProvider());
		const ctx = ctxOf();
		await runtime.listModels('fake', ctx);
		key = 'two';
		await runtime.listModels('fake', ctx);
		assert.strictEqual(fetches, 2);
	});

	test('the skip list and prefix shape a live listing, and facts merge by id', async () => {
		const { runtime } = runtimeOf(undefined, [makeFakeEntry({ models: { 'fake-small': { contextWindow: 99 } } })], {
			listModels: async () => ['models/legacy-1', 'models/fake-small', 'models/fake-small'],
			definition: { modelRules: { prefix: 'models/', skip: '^models/legacy' } },
		});
		const models = await runtime.listModels('fake', ctxOf());
		assert.deepStrictEqual(models, [{ id: 'fake-small', label: 'fake-small', contextWindow: 99, pricing: undefined }]);
	});

	test('shapeModelIds drops skipped ids and strips the prefix', () => {
		assert.deepStrictEqual(
			shapeModelIds(['models/a', 'models/gemini-old', 'plain'], { prefix: 'models/', skip: /gemini-old/ }),
			['a', 'plain'],
		);
	});
});
