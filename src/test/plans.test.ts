// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { MAX_BUILD_PLAN_CHARS, buildPlanPrompt, planFileName, planFolder, planTargetFor } from '../lib/plans';

suite('Plan paths', () => {
	test('the folder follows the setting and the root chat', () => {
		assert.strictEqual(planFolder(undefined, 'chat'), join('.comonad/plans', 'chat'));
		assert.strictEqual(planFolder('', 'chat'), join('.comonad/plans', 'chat'));
		assert.strictEqual(planFolder('notes/plans', 'chat'), join('notes/plans', 'chat'));
	});

	test('a name is reduced to the basename write_plan writes', () => {
		assert.strictEqual(planFileName(' ./x/plan.md '), 'plan.md');
		assert.strictEqual(planFileName('../plan.md'), 'plan.md');
		assert.strictEqual(planFileName(''), null);
		assert.strictEqual(planFileName('   '), null);
		assert.strictEqual(planFileName('.'), null);
		assert.strictEqual(planFileName('..'), null);
		assert.strictEqual(planFileName(42), null);
	});

	test('a target names the file inside the workspace', () => {
		assert.deepStrictEqual(planTargetFor('/repo', undefined, 'chat-1', 'plan.md'), {
			name: 'plan.md',
			path: join('.comonad/plans', 'chat-1', 'plan.md'),
			relative: '.comonad/plans/chat-1/plan.md',
		});
	});

	test('a directory outside the workspace is shown as configured', () => {
		const target = planTargetFor('/repo/app', '../plans', 'chat-1', 'plan.md');
		assert.ok(target);
		assert.strictEqual(target.relative, target.path.split(sep).join('/'));
		const absolute = planTargetFor('/repo/app', '/tmp/plans', 'chat-1', 'plan.md');
		assert.ok(absolute);
		assert.strictEqual(absolute.relative, absolute.path.split(sep).join('/'));
	});

	test('an empty workspace cannot name a plan', () => {
		assert.strictEqual(planTargetFor('', undefined, 'chat-1', 'plan.md'), null);
		assert.strictEqual(planTargetFor('  ', undefined, 'chat-1', 'plan.md'), null);
	});

	test('the plan card is wired to preview and build on both sides', () => {
		const guest = readFileSync(join(__dirname, '..', '..', 'resources', 'chat.js'), 'utf8');
		assert.match(guest, /plan-build/);
		assert.match(guest, /'buildPlan' : 'previewPlan'/);
		assert.match(guest, /button\[data-plan\]/);
		const panel = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'chat-panel.ts'), 'utf8');
		assert.match(panel, /case 'previewPlan'/);
		assert.match(panel, /case 'buildPlan'/);
		assert.match(panel, /markdown\.showPreviewToSide/);
		assert.match(panel, /applyPolicy\(\{ mode: 'sw' \}\)/);
	});

	test('the build prompt carries the plan unless it is too large', () => {
		const prompt = buildPlanPrompt('.comonad/plans/chat-1/plan.md', '# Plan\n\nDo it.');
		assert.match(prompt, /`\.comonad\/plans\/chat-1\/plan\.md`/);
		assert.match(prompt, /# Plan/);
		assert.match(prompt, /Carry out the plan now/);

		const fallback = buildPlanPrompt('a.md', 'x'.repeat(MAX_BUILD_PLAN_CHARS + 1));
		assert.match(fallback, /Read the plan at `a\.md`/);
		assert.ok(!fallback.includes('xxxx'));

		assert.match(buildPlanPrompt('a.md', '   '), /Read the plan at `a\.md`/);
	});
});
