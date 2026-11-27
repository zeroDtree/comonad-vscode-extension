// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { customBrand } from '../src/brands/custom';
import { deepseekBrand } from '../src/brands/deepseek';
import { SKIP_SIGNATURE, demandsSignature, googleSignatures } from '../src/brands/google';
import { openaiBrand } from '../src/brands/openai';
import { opencodeGoBrand } from '../src/brands/opencode-go';
import type { InvocationContext } from '../src/types';

const ctx: InvocationContext = {
	conversationId: 's1',
	turnId: 's1:1',
	requestId: 'r1',
	signal: new AbortController().signal,
	attributes: { sessionId: 'sess-42', kind: 'chat' },
};

suite('google signatures', () => {
	test('Gemini 3 and later demand one; 2.5 does not', () => {
		assert.ok(demandsSignature('gemini-3.8-flash'));
		assert.ok(demandsSignature('models/gemini-4-pro'));
		assert.ok(!demandsSignature('gemini-2.5-pro'));
		assert.ok(!demandsSignature('deepseek-chat'));
	});

	test('a history call without a signature gets the bypass', () => {
		const body = {
			model: 'gemini-3.8-flash',
			messages: [
				{ role: 'user', content: 'go' },
				{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
			],
		};
		googleSignatures(body, undefined as never, ctx);
		const calls = (body.messages[1] as { tool_calls: { extra_content?: unknown }[] }).tool_calls;
		assert.deepStrictEqual(calls[0]?.extra_content, SKIP_SIGNATURE);
	});

	test('a signature the call already carries is left alone', () => {
		const own = { google: { thought_signature: 'mine' } };
		const body = {
			model: 'gemini-3.8-flash',
			messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{}' }, extra_content: own }] }],
		};
		googleSignatures(body, undefined as never, ctx);
		const calls = (body.messages[0] as { tool_calls: { extra_content?: unknown }[] }).tool_calls;
		assert.strictEqual(calls[0]?.extra_content, own);
	});

	test('a model that never demanded one keeps its calls bare', () => {
		const body = {
			model: 'gemini-2.5-flash',
			messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{}' } }] }],
		};
		googleSignatures(body, undefined as never, ctx);
		const calls = (body.messages[0] as { tool_calls: { extra_content?: unknown }[] }).tool_calls;
		assert.strictEqual(calls[0]?.extra_content, undefined);
	});
});

suite('opencode-go session header', () => {
	test('the header carries the invocation session', () => {
		const headers: Record<string, string> = {};
		opencodeGoBrand.headerHooks?.[0]?.(headers, ctx);
		assert.strictEqual(headers['x-opencode-session'], 'sess-42');
	});

	test('a detached call falls back to the conversation', () => {
		const headers: Record<string, string> = {};
		opencodeGoBrand.headerHooks?.[0]?.(headers, { ...ctx, attributes: undefined });
		assert.strictEqual(headers['x-opencode-session'], 's1');
	});
});

suite('brand data', () => {
	test('deepseek switches thinking off through its own field and prices its models', () => {
		assert.deepStrictEqual(deepseekBrand.defaults.options?.thinkingOff, 'thinking');
		assert.strictEqual(deepseekBrand.modelCatalog?.length, 2);
		assert.strictEqual(deepseekBrand.modelCatalog?.[0]?.pricing?.cachedInPerM, 0.006);
	});

	test('the custom brand contributes nothing but the wire', () => {
		assert.deepStrictEqual(customBrand.defaults, {});
		assert.strictEqual(customBrand.protocol, 'openai-chat');
	});

	test('openai is the reference brand; google carries its rules as data', () => {
		assert.strictEqual(openaiBrand.defaults.baseURL, 'https://api.openai.com/v1');
		assert.ok(openaiBrand.modelRules === undefined);
		assert.strictEqual(deepseekBrand.modelRules === undefined, true);
	});
});
