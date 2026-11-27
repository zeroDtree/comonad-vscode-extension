// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import {
	ModelError,
	classifyHttpRefusal,
	isAbortedError,
	isContextOverflow,
	isImageUnsupported,
	isRetryable,
	isTransportFailure,
	modelHttpError,
	toTransportError,
} from '../src/errors';

suite('model errors', () => {
	suite('classifyHttpRefusal', () => {
		test('an over-full prompt is context_overflow whatever the provider calls it', () => {
			for (const detail of [
				'this model\'s maximum context length is 65536 tokens',
				'context_length_exceeded',
				'prompt is too long: too many tokens',
				'reduce the length of the messages',
			]) {
				assert.strictEqual(classifyHttpRefusal(400, detail), 'context_overflow', detail);
			}
			assert.strictEqual(classifyHttpRefusal(413, 'payload too large: context window exceeded'), 'context_overflow');
		});

		test('an image refusal is image_unsupported', () => {
			for (const detail of ['image input is not supported', 'invalid image', 'this model is text-only (no vision)']) {
				assert.strictEqual(classifyHttpRefusal(400, detail), 'image_unsupported', detail);
			}
			assert.strictEqual(classifyHttpRefusal(415, 'unsupported media type: image content'), 'image_unsupported');
		});

		test('a context refusal that mentions an image is still a context refusal', () => {
			assert.strictEqual(
				classifyHttpRefusal(400, 'too many tokens in messages (including image input)'),
				'context_overflow',
			);
		});

		test('status classes map to their own codes', () => {
			assert.strictEqual(classifyHttpRefusal(401, 'invalid api key'), 'auth');
			assert.strictEqual(classifyHttpRefusal(403, 'quota exceeded for this key'), 'auth');
			assert.strictEqual(classifyHttpRefusal(429, 'rate limit reached'), 'rate_limited');
			assert.strictEqual(classifyHttpRefusal(503, 'service unavailable'), 'server');
			assert.strictEqual(classifyHttpRefusal(400, 'unknown parameter xyz'), 'invalid_request');
		});
	});

	test('modelHttpError keeps the status and the endpoint wording', () => {
		const error = modelHttpError(413, 'context window exceeded');
		assert.strictEqual(error.code, 'context_overflow');
		assert.strictEqual(error.status, 413);
		assert.strictEqual(error.detail, 'context window exceeded');
		assert.match(error.message, /413/);
	});

	suite('retryable defaults', () => {
		test('a retry may fix transport-shaped failures only', () => {
			assert.strictEqual(new ModelError('rate_limited', 'x').retryable, true);
			assert.strictEqual(new ModelError('transport', 'x').retryable, true);
			assert.strictEqual(new ModelError('timeout', 'x').retryable, true);
			assert.strictEqual(new ModelError('server', 'x').retryable, true);
			assert.strictEqual(new ModelError('auth', 'x').retryable, false);
			assert.strictEqual(new ModelError('invalid_request', 'x').retryable, false);
			assert.strictEqual(new ModelError('context_overflow', 'x').retryable, false);
			assert.strictEqual(new ModelError('aborted', 'x').retryable, false);
		});

		test('an explicit retryable wins over the default', () => {
			assert.strictEqual(new ModelError('server', 'x', { retryable: false }).retryable, false);
			assert.strictEqual(new ModelError('quota', 'x', { retryable: true }).retryable, true);
		});
	});

	suite('predicates', () => {
		test('semantic retries classify by code', () => {
			assert.ok(isContextOverflow(new ModelError('context_overflow', 'x')));
			assert.ok(!isContextOverflow(new ModelError('invalid_request', 'x')));
			assert.ok(isImageUnsupported(new ModelError('image_unsupported', 'x')));
			assert.ok(!isImageUnsupported(new Error('image input is not supported')));
		});

		test('an unwrapped fetch failure still reads as a transport failure', () => {
			assert.ok(isTransportFailure(new Error('fetch failed')));
			assert.ok(isTransportFailure(new Error('read', { cause: new Error('socket hang up') })));
			assert.ok(isTransportFailure(new ModelError('transport', 'x')));
			assert.ok(isTransportFailure(new ModelError('timeout', 'x')));
			assert.ok(!isTransportFailure(new Error('boom')));
			assert.ok(!isTransportFailure(modelHttpError(500, 'server error')));
		});

		test('isRetryable follows the codes, and transport wording outside them', () => {
			assert.ok(isRetryable(new ModelError('rate_limited', 'x')));
			assert.ok(!isRetryable(new ModelError('auth', 'x')));
			assert.ok(isRetryable(new Error('connection reset by peer')));
		});

		test('aborted keeps its own code', () => {
			assert.ok(isAbortedError(new ModelError('aborted', 'x')));
			assert.ok(!isAbortedError(new Error('aborted')));
		});
	});

	test('toTransportError folds the cause into the message once', () => {
		const folded = toTransportError(new Error('fetch failed', { cause: new Error('other side closed') }));
		assert.strictEqual(folded.code, 'transport');
		assert.match(folded.message, /other side closed/);
		const plain = toTransportError(new Error('terminated'));
		assert.strictEqual(plain.message, 'terminated');
		const passthrough = toTransportError(new ModelError('timeout', 'slow'));
		assert.strictEqual(passthrough.code, 'timeout');
	});
});
