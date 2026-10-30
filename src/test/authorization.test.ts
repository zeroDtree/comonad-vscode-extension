// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { issueAuthorization, verifyAuthorization } from '../lib/authorization';

suite('Tool authorization', () => {
	test('a grant covers exactly its session, batch and calls', () => {
		const grant = issueAuthorization({ sessionId: 's1', batch: 3, callIds: ['c1', 'c2'] });
		assert.strictEqual(verifyAuthorization(grant, { sessionId: 's1', batch: 3, callId: 'c1' }), true);
		assert.strictEqual(verifyAuthorization(grant, { sessionId: 's1', batch: 3, callId: 'c2' }), true);
		assert.strictEqual(verifyAuthorization(grant, { sessionId: 's2', batch: 3, callId: 'c1' }), false);
		assert.strictEqual(verifyAuthorization(grant, { sessionId: 's1', batch: 4, callId: 'c1' }), false);
		assert.strictEqual(verifyAuthorization(grant, { sessionId: 's1', batch: 3, callId: 'c3' }), false);
	});

	test('only an issued grant verifies', () => {
		const lookalike = { sessionId: 's1', batch: 1, callIds: ['c1'] };
		assert.strictEqual(verifyAuthorization(lookalike, { sessionId: 's1', batch: 1, callId: 'c1' }), false);
		assert.strictEqual(verifyAuthorization(undefined, { sessionId: 's1', batch: 1, callId: 'c1' }), false);
	});

	test('mutating the input list does not widen an issued grant', () => {
		const callIds = ['c1'];
		const grant = issueAuthorization({ sessionId: 's1', batch: 1, callIds });
		callIds.push('c2');
		assert.strictEqual(verifyAuthorization(grant, { sessionId: 's1', batch: 1, callId: 'c2' }), false);
		assert.ok(Object.isFrozen(grant));
		assert.ok(Object.isFrozen(grant.callIds));
	});

	test('the same call id in another batch needs its own grant', () => {
		const first = issueAuthorization({ sessionId: 's1', batch: 1, callIds: ['call_0'] });
		const second = issueAuthorization({ sessionId: 's1', batch: 2, callIds: ['call_0'] });
		assert.strictEqual(verifyAuthorization(first, { sessionId: 's1', batch: 2, callId: 'call_0' }), false);
		assert.strictEqual(verifyAuthorization(second, { sessionId: 's1', batch: 2, callId: 'call_0' }), true);
	});
});
