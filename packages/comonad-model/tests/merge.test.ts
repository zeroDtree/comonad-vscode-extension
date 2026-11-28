// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import {
	MERGE_RULES,
	compileModelRules,
	mergeHeaders,
	mergeModels,
	mergeRetry,
	mergeWire,
	protocolIdFor,
	validateOptions,
} from '../src/config/merge';
import { keyEnvNames, resolveProvider } from '../src/config/resolve';
import type {
	ProviderDefinition,
	KeyProvider,
	OptionSchema,
	ProtocolDefinition,
	ProviderEntry,
	ResolvedWire,
} from '../src/config/schema';
import { ModelError } from '../src/errors';
import type { InvocationContext } from '../src/types';

const OPTIONS: OptionSchema = {
	temperature: { type: 'number' },
	thinkingOff: { type: 'string', enum: ['thinking', 'effort'] },
	includeUsage: { type: 'boolean' },
	responseFormat: { type: 'object' },
};

const noopHook = (): void => {};

function makeProtocol(overrides: Partial<ProtocolDefinition> = {}): ProtocolDefinition {
	return {
		apiVersion: 1,
		id: 'openai-chat',
		defaults: {
			chatPath: '/chat/completions',
			modelsPath: '/models',
			headers: { 'content-type': 'application/json', 'x-layer': 'protocol' },
			auth: { kind: 'bearer' },
			options: { includeUsage: true },
			optionsSchema: OPTIONS,
		},
		headerHooks: [noopHook],
		requestHooks: [noopHook],
		create: () => {
			throw new Error('merge never touches create()');
		},
		...overrides,
	};
}

function makeProvider(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
	return {
		apiVersion: 1,
		id: 'deepseek',
		protocol: 'openai-chat',
		defaults: {
			baseURL: 'https://api.deepseek.com',
			headers: { 'x-layer': 'vendor', 'x-brand': 'deepseek' },
			options: { thinkingOff: 'thinking' },
		},
		...overrides,
	};
}

function makeEntry(overrides: Partial<ProviderEntry> = {}): ProviderEntry {
	return {
		id: 'deepseek',
		provider: 'deepseek',
		base: 'https://api.deepseek.com',
		keyEnv: 'DEEPSEEK_API_KEY',
		...overrides,
	};
}

function wireOf(
	entry: Partial<ProviderEntry> = {},
	definition: Partial<ProviderDefinition> = {},
	protocol: Partial<ProtocolDefinition> = {},
): ResolvedWire {
	return mergeWire(makeProtocol(protocol), makeProvider(definition), makeEntry(entry));
}

function keysOf(overrides: Partial<KeyProvider> = {}): KeyProvider {
	return {
		keyFor: async () => undefined,
		env: () => undefined,
		...overrides,
	};
}

const ctx: InvocationContext = {
	conversationId: 's1',
	turnId: 's1:1',
	requestId: 'r1',
	signal: new AbortController().signal,
};

suite('merge rules', () => {
	test('the table documents every field of the layering contract', () => {
		assert.deepStrictEqual(
			MERGE_RULES.map((row) => row.field),
			[
				'protocol',
				'baseURL',
				'auth',
				'keyEnv',
				'headers',
				'headerHooks',
				'requestHooks',
				'chatPath',
				'modelsPath',
				'options',
				'models',
				'modelRules',
				'retry',
				'fallback',
				'create()',
			],
		);
		for (const row of MERGE_RULES) {
			assert.ok(row.note.length > 0, row.field);
		}
	});

	suite('protocol (override)', () => {
		test('the instance re-points the vendor protocol', () => {
			assert.strictEqual(protocolIdFor(makeEntry({ protocol: 'gemini' }), makeProvider()), 'gemini');
		});
		test('the vendor protocol is the default', () => {
			assert.strictEqual(protocolIdFor(makeEntry(), makeProvider()), 'openai-chat');
		});
		test('an explicit nullish instance value does not re-point', () => {
			assert.strictEqual(protocolIdFor(makeEntry({ protocol: undefined }), makeProvider({ protocol: 'anthropic-messages' })), 'anthropic-messages');
		});
	});

	suite('baseURL (override)', () => {
		test('the instance base wins over the vendor default', () => {
			assert.strictEqual(wireOf({ base: 'https://proxy.example/v1' }).baseURL, 'https://proxy.example/v1');
		});
		test('the vendor default fills an instance without one', () => {
			assert.strictEqual(wireOf({ base: '' }).baseURL, 'https://api.deepseek.com');
		});
		test('the base is normalized (trailing slashes, host case)', () => {
			assert.strictEqual(wireOf({ base: 'HTTPS://API.DeepSeek.COM//' }).baseURL, 'https://api.deepseek.com');
		});
		test('no base anywhere is a refusal', () => {
			assert.throws(
				() => wireOf({ base: '' }, { defaults: { headers: {}, options: {} } }),
				(error: unknown) => error instanceof ModelError && error.code === 'invalid_request',
			);
		});
	});

	suite('auth (replace)', () => {
		test('the instance scheme replaces the vendor one wholesale', () => {
			const wire = wireOf({ auth: { kind: 'header', name: 'x-api-key' } }, { defaults: { baseURL: 'https://b', auth: { kind: 'query', name: 'key' } } });
			assert.deepStrictEqual(wire.auth, { kind: 'header', name: 'x-api-key' });
		});
		test('the vendor scheme replaces the protocol default', () => {
			const wire = wireOf({}, { defaults: { baseURL: 'https://b', auth: { kind: 'query', name: 'key' } } });
			assert.deepStrictEqual(wire.auth, { kind: 'query', name: 'key' });
		});
		test('bearer is the last resort', () => {
			const wire = wireOf({}, {}, { defaults: { ...makeProtocol().defaults, auth: undefined } });
			assert.deepStrictEqual(wire.auth, { kind: 'bearer' });
		});
	});

	suite('keyEnv (override)', () => {
		test('a single name normalizes to a one-element list', () => {
			assert.deepStrictEqual(keyEnvNames(makeEntry({ keyEnv: 'KEY_A' }).keyEnv), ['KEY_A']);
		});
		test('an array keeps its order and trims', () => {
			assert.deepStrictEqual(keyEnvNames(makeEntry({ keyEnv: [' KEY_A ', 'KEY_B'] }).keyEnv), ['KEY_A', 'KEY_B']);
		});
		test('absent means no env fallback at all', () => {
			assert.deepStrictEqual(keyEnvNames(makeEntry({ keyEnv: undefined }).keyEnv), []);
		});
	});

	suite('headers (case-insensitive merge)', () => {
		test('a later layer wins per lower-cased key and keeps its own casing', () => {
			const wire = wireOf({ headers: { 'X-Layer': 'instance' } });
			assert.strictEqual(wire.headers['X-Layer'], 'instance');
			assert.ok(!('x-layer' in wire.headers));
		});
		test('keys only a deeper layer sets survive', () => {
			const wire = wireOf();
			assert.strictEqual(wire.headers['x-brand'], 'deepseek');
			assert.strictEqual(wire.headers['content-type'], 'application/json');
		});
		test('the vendor wins over the protocol', () => {
			assert.strictEqual(wireOf().headers['x-layer'], 'vendor');
		});
		test('nothing is merged field-wise inside a header value', () => {
			const wire = wireOf({ headers: { 'x-brand': 'other' } });
			assert.strictEqual(wire.headers['x-brand'], 'other');
		});
	});

	suite('headerHooks / requestHooks (concat)', () => {
		test('protocol hooks run before vendor hooks', () => {
			const order: string[] = [];
			const wire = wireOf(
				{},
				{
					headerHooks: [
						() => {
							order.push('vendor');
						},
					],
				},
				{
					headerHooks: [
						() => {
							order.push('protocol');
						},
					],
				},
			);
			for (const hook of wire.headerHooks) {
				hook({}, ctx);
			}
			assert.deepStrictEqual(order, ['protocol', 'vendor']);
		});
		test('every layer contributes its hooks, none replace', () => {
			const wire = wireOf({}, { requestHooks: [noopHook, noopHook] }, { requestHooks: [noopHook] });
			assert.strictEqual(wire.requestHooks.length, 3);
		});
		test('layers without hooks add nothing', () => {
			const wire = wireOf({}, { headerHooks: undefined }, { headerHooks: undefined });
			assert.deepStrictEqual(wire.headerHooks, []);
		});
	});

	suite('chatPath / modelsPath (override)', () => {
		test('independent paths override per layer', () => {
			const wire = wireOf(
				{ chatPath: '/inference/go/openai/v1/chat/completions', modelsPath: '/inference/go/v1/models' },
				{ defaults: { baseURL: 'https://b', chatPath: '/vendor/chat', modelsPath: '/vendor/models' } },
			);
			assert.strictEqual(wire.chatPath, '/inference/go/openai/v1/chat/completions');
			assert.strictEqual(wire.modelsPath, '/inference/go/v1/models');
		});
		test('vendor paths win over protocol defaults', () => {
			const wire = wireOf({}, { defaults: { baseURL: 'https://b', chatPath: '/vendor/chat', modelsPath: '/vendor/models' } });
			assert.strictEqual(wire.chatPath, '/vendor/chat');
			assert.strictEqual(wire.modelsPath, '/vendor/models');
		});
		test('the protocol defaults fill everything absent', () => {
			const wire = wireOf();
			assert.strictEqual(wire.chatPath, '/chat/completions');
			assert.strictEqual(wire.modelsPath, '/models');
		});
		test('a path outside the base origin is refused at resolve', async () => {
			await assert.rejects(
				resolveProvider(makeProtocol(), makeProvider(), makeEntry({ modelsPath: 'https://evil.example/models' }), keysOf()),
				(error: unknown) => error instanceof ModelError && error.code === 'invalid_request',
			);
		});
	});

	suite('options (shallow fold + schema validation)', () => {
		test('the deepest layer wins per key', () => {
			const wire = wireOf({ options: { temperature: 0.2 } }, { defaults: { baseURL: 'https://b', options: { temperature: 0.7, thinkingOff: 'effort' } } });
			assert.strictEqual(wire.options.temperature, 0.2);
			assert.strictEqual(wire.options.thinkingOff, 'effort');
			assert.strictEqual(wire.options.includeUsage, true);
		});
		test('an unknown option key is rejected', () => {
			assert.throws(
				() => wireOf({ options: { nope: 1 } }),
				(error: unknown) => error instanceof ModelError && /unknown option/.test((error as Error).message),
			);
		});
		test('a wrong type is rejected', () => {
			assert.throws(
				() => wireOf({ options: { temperature: 'hot' } }),
				(error: unknown) => error instanceof ModelError && /temperature/.test((error as Error).message),
			);
		});
		test('an enum violation is rejected', () => {
			assert.throws(
				() => wireOf({ options: { thinkingOff: 'freezing' } }),
				(error: unknown) => error instanceof ModelError && /thinkingOff/.test((error as Error).message),
			);
		});
		test('undefined values drop out instead of overriding', () => {
			const wire = wireOf({ options: { thinkingOff: undefined } });
			assert.ok(!('thinkingOff' in wire.options));
		});
	});

	suite('models (merge by id)', () => {
		test('vendor catalog facts seed the map', () => {
			const wire = wireOf({}, {
				modelCatalog: [{ id: 'deepseek-flash', contextWindow: 1048576, pricing: { inPerM: 0.3, outPerM: 1.2 } }],
			});
			assert.strictEqual(wire.models.get('deepseek-flash')?.contextWindow, 1048576);
		});
		test('the instance overrides per field, keeping the rest', () => {
			const wire = wireOf(
				{ models: { 'deepseek-flash': { contextWindow: 65536 } } },
				{ modelCatalog: [{ id: 'deepseek-flash', contextWindow: 1048576, pricing: { inPerM: 0.3, outPerM: 1.2 } }] },
			);
			const model = wire.models.get('deepseek-flash');
			assert.strictEqual(model?.contextWindow, 65536);
			assert.deepStrictEqual(model?.pricing, { inPerM: 0.3, outPerM: 1.2 });
		});
		test('pricing merges per price key', () => {
			const wire = wireOf(
				{ models: { m: { pricing: { outPerM: 2 } } } },
				{ modelCatalog: [{ id: 'm', pricing: { inPerM: 1, outPerM: 5 } }] },
			);
			assert.deepStrictEqual(wire.models.get('m')?.pricing, { inPerM: 1, outPerM: 2 });
		});
		test('the instance may introduce a model the vendor catalog never listed', () => {
			const wire = wireOf({ models: { custom: { contextWindow: 2048 } } });
			assert.deepStrictEqual(wire.models.get('custom'), { id: 'custom', contextWindow: 2048, pricing: undefined });
		});
	});

	suite('modelRules (scalars)', () => {
		test('the vendor rules fill an instance without any', () => {
			const rules = compileModelRules({ prefix: 'models/', skip: '^models/gemini-1' }, undefined);
			assert.strictEqual(rules.prefix, 'models/');
			assert.ok(rules.skip?.test('models/gemini-1.5'));
		});
		test('the instance wins per field', () => {
			const rules = compileModelRules({ prefix: 'models/', skip: '^a' }, { prefix: '' });
			assert.strictEqual(rules.prefix, '');
			assert.ok(rules.skip?.test('a'));
		});
		test('a skip that is not a regex is refused', () => {
			assert.throws(
				() => compileModelRules({ skip: '(' }, undefined),
				(error: unknown) => error instanceof ModelError && error.code === 'invalid_request',
			);
		});
		test('absent means no filtering at all', () => {
			assert.deepStrictEqual(compileModelRules(undefined, undefined), { prefix: '', skip: undefined });
		});
	});

	suite('retry (scalars over defaults)', () => {
		test('the defaults fill an instance without retry', () => {
			const retry = mergeRetry(undefined);
			assert.strictEqual(retry.maxAttempts, 2);
			assert.deepStrictEqual(retry.retryableCodes, ['transport', 'timeout', 'rate_limited', 'server']);
		});
		test('scalars override per field', () => {
			assert.strictEqual(mergeRetry({ maxAttempts: 4 }).maxAttempts, 4);
		});
		test('retryableCodes replaces wholesale', () => {
			assert.deepStrictEqual(mergeRetry({ retryableCodes: ['transport'] }).retryableCodes, ['transport']);
		});
		test('a nonsensical attempt count is refused', () => {
			assert.throws(
				() => mergeRetry({ maxAttempts: 0 }),
				(error: unknown) => error instanceof ModelError && error.code === 'invalid_request',
			);
		});
	});

	suite('fallback (override)', () => {
		test('the instance list is the chain', () => {
			assert.deepStrictEqual(wireOf({ fallback: ['backup'] }).fallback, ['backup']);
		});
		test('an empty list means no fallback', () => {
			assert.deepStrictEqual(wireOf({ fallback: [] }).fallback, []);
		});
		test('absent means no fallback', () => {
			assert.deepStrictEqual(wireOf().fallback, []);
		});
	});

	suite('create() (protocol-only)', () => {
		test('the merged wire carries no constructor a layer could have hijacked', () => {
			const wire = wireOf();
			assert.ok(!('create' in wire));
		});
		test('only a protocol definition declares one', () => {
			assert.strictEqual(typeof makeProtocol().create, 'function');
			assert.ok(!('create' in makeProvider()));
			assert.ok(!('create' in makeEntry()));
		});
		test('mergeWire returns the protocol its caller passed, untouched', () => {
			const protocol = makeProtocol();
			const before = protocol.create;
			mergeWire(protocol, makeProvider(), makeEntry());
			assert.strictEqual(protocol.create, before);
		});
	});
});

suite('resolveProvider', () => {
	test('the stored key wins over the environment', async () => {
		const resolved = await resolveProvider(
			makeProtocol(),
			makeProvider(),
			makeEntry({ keyEnv: ['KEY_A', 'KEY_B'] }),
			keysOf({ keyFor: async () => 'stored-key', env: () => 'env-key' }),
		);
		assert.strictEqual(resolved.key, 'stored-key');
		assert.strictEqual(resolved.keySource, 'stored');
	});

	test('the environment is tried in order', async () => {
		const seen: string[] = [];
		const resolved = await resolveProvider(
			makeProtocol(),
			makeProvider(),
			makeEntry({ keyEnv: ['KEY_A', 'KEY_B'] }),
			keysOf({
				env: (name) => {
					seen.push(name);
					return name === 'KEY_B' ? 'env-b' : undefined;
				},
			}),
		);
		assert.deepStrictEqual(seen, ['KEY_A', 'KEY_B']);
		assert.strictEqual(resolved.key, 'env-b');
		assert.strictEqual(resolved.keySource, 'env');
	});

	test('a keyless provider resolves with keySource none', async () => {
		const resolved = await resolveProvider(makeProtocol(), makeProvider(), makeEntry(), keysOf());
		assert.strictEqual(resolved.key, undefined);
		assert.strictEqual(resolved.keySource, 'none');
	});

	test('keySource env prefers the environment when both sources hold a key', async () => {
		const resolved = await resolveProvider(
			makeProtocol(),
			makeProvider(),
			makeEntry({ keyEnv: ['KEY_A'], keySource: 'env' }),
			keysOf({ keyFor: async () => 'stored-key', env: () => 'env-key' }),
		);
		assert.strictEqual(resolved.key, 'env-key');
		assert.strictEqual(resolved.keySource, 'env');
	});

	test('keySource env still falls back to the stored key when the environment is empty', async () => {
		const resolved = await resolveProvider(
			makeProtocol(),
			makeProvider(),
			makeEntry({ keyEnv: ['KEY_A'], keySource: 'env' }),
			keysOf({ keyFor: async () => 'stored-key', env: () => undefined }),
		);
		assert.strictEqual(resolved.key, 'stored-key');
		assert.strictEqual(resolved.keySource, 'stored');
	});

	test('keySource keychain is the default and beats the environment', async () => {
		const resolved = await resolveProvider(
			makeProtocol(),
			makeProvider(),
			makeEntry({ keyEnv: ['KEY_A'], keySource: 'keychain' }),
			keysOf({ keyFor: async () => 'stored-key', env: () => 'env-key' }),
		);
		assert.strictEqual(resolved.key, 'stored-key');
		assert.strictEqual(resolved.keySource, 'stored');
	});

	test('the chat and models URLs are absolute and origin-locked', async () => {
		const resolved = await resolveProvider(
			makeProtocol(),
			makeProvider(),
			makeEntry({ base: 'https://api.opencode.ai/inference/go', chatPath: 'openai/v1/chat/completions', modelsPath: 'v1/models' }),
			keysOf(),
		);
		assert.strictEqual(resolved.chatURL, 'https://api.opencode.ai/inference/go/openai/v1/chat/completions');
		assert.strictEqual(resolved.modelsURL, 'https://api.opencode.ai/inference/go/v1/models');
	});

	test('identity rides along for logs and retries', async () => {
		const resolved = await resolveProvider(makeProtocol(), makeProvider(), makeEntry(), keysOf());
		assert.strictEqual(resolved.providerId, 'deepseek');
		assert.strictEqual(resolved.definitionId, 'deepseek');
		assert.strictEqual(resolved.protocolId, 'openai-chat');
	});
});
