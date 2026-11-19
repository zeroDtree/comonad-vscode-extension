// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
	BUILD_MODES,
	MAX_BUILD_PLAN_CHARS,
	asBuildMode,
	buildPlanPrompt,
	parsePlanWriteResult,
	planFileName,
	planFolder,
	planPathForRecorded,
	planTargetFor,
} from '../lib/plan-files';

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

	test('only Semi-Write and Full Access can start a build', () => {
		assert.deepStrictEqual([...BUILD_MODES], ['sw', 'aw']);
		assert.strictEqual(asBuildMode('sw'), 'sw');
		assert.strictEqual(asBuildMode('aw'), 'aw');
		for (const rejected of ['plan', 'ro', 'chat', 'SW', 'toString', '', 42, null, undefined]) {
			assert.strictEqual(asBuildMode(rejected), undefined);
		}
	});

	test('the plan card is wired to preview and build on both sides', () => {
		const guest = readFileSync(join(__dirname, '..', '..', 'resources', 'chat.js'), 'utf8');
		assert.match(guest, /plan-card/);
		assert.match(guest, /plan-build/);
		assert.match(guest, /plan-trigger/);
		assert.match(guest, /button\[data-plan-pick\]/);
		assert.match(guest, /button\[data-plan\]/);
		// The action is read from the button once: comparing the derived type to 'build' is always false.
		assert.ok(!guest.includes("type === 'build'"), 'the payload branches on the button, not the derived type');
		assert.match(guest, /const build = plan\.dataset\.planAction === 'build'/);
		assert.match(guest, /type: build \? 'buildPlan' : 'previewPlan'/);
		assert.match(guest, /model: planBuildModel\(choice\)/);
		assert.match(guest, /mode: planBuildMode\(choice\)/);
		assert.match(guest, /function planBuildMode\(/);
		assert.match(guest, /function planBuildModel\(/);
		assert.ok(!guest.includes('model: (state && typeof state.model'), 'a card stores only explicit picks');
		assert.ok(!guest.includes("mode: state && (state.mode === 'sw'"), 'a card does not freeze the session mode');
		assert.ok(!guest.includes('.dataset.buildMode'), 'the write-only card defaults are gone');
		const panel = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'chat-panel.ts'), 'utf8');
		assert.match(panel, /case 'previewPlan'/);
		assert.match(panel, /case 'buildPlan'/);
		assert.match(panel, /markdown\.showPreviewToSide/);
		assert.ok(!panel.includes("mode === undefined ? 'sw'"), 'a missing mode is refused, never narrowed');
		assert.match(panel, /const buildMode = asBuildMode\(mode\)/);
		assert.match(panel, /buildPlanPrompt\(target\.relative, content, buildMode\)/);
		assert.match(panel, /ctx\.llm\.keyReady\(modelPick\)/);
		assert.match(panel, /ctx\.settings\.update\('model', modelPick\)/);
		assert.match(panel, /applyPolicy\(\{ mode: buildMode \}\)/);
		const css = readFileSync(join(__dirname, '..', '..', 'resources', 'chat.css'), 'utf8');
		assert.match(css, /\.plan-card/);
		assert.match(css, /\.plan-menu\s*\{[\s\S]*?position:\s*fixed/);
	});

	test('a recorded plan path survives a changed plan directory', () => {
		const recorded = parsePlanWriteResult(
			'wrote plan plan.md\nplan path: notes/plans/chat-1/plan.md\n\nThe plan is recorded. Stop here and summarize it.',
		);
		assert.deepStrictEqual(recorded, { name: 'plan.md', relative: 'notes/plans/chat-1/plan.md' });
		const target = planPathForRecorded('/repo', 'chat-1', recorded!);
		assert.ok(target);
		assert.strictEqual(target.relative, 'notes/plans/chat-1/plan.md');
		assert.strictEqual(target.path, resolve('/repo', 'notes/plans/chat-1/plan.md'));
		// The current planDirectory is irrelevant: the recorded path wins.
		assert.ok(planPathForRecorded('/repo', 'chat-1', { name: 'plan.md', relative: '.comonad/plans/chat-1/plan.md' }));
	});

	test('a recorded path must match the chat and the basename', () => {
		assert.strictEqual(planPathForRecorded('/repo', 'chat-1', { name: 'plan.md', relative: 'notes/plans/chat-2/plan.md' }), null);
		assert.strictEqual(planPathForRecorded('/repo', 'chat-1', { name: 'plan.md', relative: 'notes/plans/chat-1/other.md' }), null);
		assert.strictEqual(planPathForRecorded('/repo', 'chat-1', { name: 'plan.md', relative: '../escape/plan.md' }), null);
		assert.strictEqual(planPathForRecorded('/repo', 'chat-1', { name: 'plan.md', relative: 'notes/plans/xchat-1/plan.md' }), null);
		assert.strictEqual(planPathForRecorded('', 'chat-1', { name: 'plan.md', relative: 'notes/plans/chat-1/plan.md' }), null);
	});

	test('an older write_plan result falls back to the current setting', () => {
		assert.deepStrictEqual(parsePlanWriteResult('wrote plan plan.md\n\nThe plan is recorded.'), { name: 'plan.md' });
		assert.strictEqual(parsePlanWriteResult('wrote something else'), undefined);
		assert.strictEqual(planPathForRecorded('/repo', 'chat-1', { name: 'plan.md' }), null);
	});

	test('the build prompt carries the plan and the shell that may write', () => {
		const prompt = buildPlanPrompt('.comonad/plans/chat-1/plan.md', '# Plan\n\nDo it.', 'aw');
		assert.match(prompt, /`\.comonad\/plans\/chat-1\/plan\.md`/);
		assert.match(prompt, /# Plan/);
		assert.match(prompt, /Carry out the plan now/);
		assert.match(prompt, /Full Access/);
		assert.match(prompt, /`run_shell`/);
		assert.match(prompt, /`run_shell_test` can only write `\.comonad\/scratch`/);

		const semi = buildPlanPrompt('a.md', '# Plan', 'sw');
		assert.match(semi, /Semi-Write/);
		assert.match(semi, /file tools/);
		assert.ok(!semi.includes('Full Access'));

		const fallback = buildPlanPrompt('a.md', 'x'.repeat(MAX_BUILD_PLAN_CHARS + 1), 'sw');
		assert.match(fallback, /Read the plan at `a\.md`/);
		assert.ok(!fallback.includes('xxxx'));
		assert.match(fallback, /Semi-Write/, 'the fallback still names the shell rule');

		assert.match(buildPlanPrompt('a.md', '   ', 'aw'), /Read the plan at `a\.md`/);
	});
});
