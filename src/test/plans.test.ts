// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
	BUILD_MODES,
	MAX_BUILD_PLAN_CHARS,
	asBuildMode,
	buildPlanPrompt,
	isMarkdownPlanName,
	isPlanWriterTool,
	parsePlanResult,
	planFileName,
	planFolder,
	planPathForRecorded,
	planTargetFor,
	planWriteFileName,
} from '../lib/plan-files';
import { applyLiteralEdits } from '../lib/text-edit';
import { rightmostEditorColumn } from '../ui/chat-panel';

suite('Plan paths', () => {
	test('the folder follows the setting and the root chat', () => {
		assert.strictEqual(planFolder(undefined, 'chat'), join('.comonad/plans', 'chat'));
		assert.strictEqual(planFolder('', 'chat'), join('.comonad/plans', 'chat'));
		assert.strictEqual(planFolder('notes/plans', 'chat'), join('notes/plans', 'chat'));
	});

	test('a name is reduced to the basename the plan tools write', () => {
		assert.strictEqual(planFileName(' ./x/plan.md '), 'plan.md');
		assert.strictEqual(planFileName('../plan.md'), 'plan.md');
		assert.strictEqual(planFileName(''), null);
		assert.strictEqual(planFileName('   '), null);
		assert.strictEqual(planFileName('.'), null);
		assert.strictEqual(planFileName('..'), null);
		assert.strictEqual(planFileName(42), null);
	});

	test('write_plan gives a plan a Markdown name without renaming recorded plans', () => {
		assert.strictEqual(planWriteFileName('nekoai-js-2.0-update'), 'nekoai-js-2.0-update.md');
		assert.strictEqual(planWriteFileName(' ./x/plan.md '), 'plan.md');
		assert.strictEqual(planWriteFileName('plan.markdown'), 'plan.markdown');
		assert.strictEqual(planWriteFileName('PLAN.MD'), 'PLAN.MD');
		assert.strictEqual(planWriteFileName('plan.txt'), 'plan.txt.md');
		for (const rejected of ['', '   ', '.', '..', 42]) {
			assert.strictEqual(planWriteFileName(rejected), null);
		}
		assert.strictEqual(isMarkdownPlanName('plan.md'), true);
		assert.strictEqual(isMarkdownPlanName('plan.MD'), true);
		assert.strictEqual(isMarkdownPlanName('plan.markdown'), true);
		assert.strictEqual(isMarkdownPlanName('plan'), false);
		assert.strictEqual(isMarkdownPlanName('plan.txt'), false);
		assert.strictEqual(isMarkdownPlanName('plan.md.txt'), false);
		// The exact rule is unchanged: recorded and legacy names keep resolving the file they name.
		assert.strictEqual(planFileName('nekoai-js-2.0-update'), 'nekoai-js-2.0-update');
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
		assert.match(guest, /Plan updated/);
		assert.match(guest, /edit_plan: 'Edit plan'/);
		assert.match(guest, /edit_plan: 'pencil'/);
		assert.ok(!guest.includes('model: (state && typeof state.model'), 'a card stores only explicit picks');
		assert.ok(!guest.includes("mode: state && (state.mode === 'sw'"), 'a card does not freeze the session mode');
		assert.ok(!guest.includes('.dataset.buildMode'), 'the write-only card defaults are gone');
		const panel = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'chat-panel.ts'), 'utf8');
		assert.match(panel, /case 'previewPlan'/);
		assert.match(panel, /case 'buildPlan'/);
		assert.match(panel, /const MARKDOWN_PREVIEW_VIEW_TYPE = 'vscode\.markdown\.preview\.editor'/);
		assert.match(panel, /executeCommand\('vscode\.openWith', uri, MARKDOWN_PREVIEW_VIEW_TYPE/);
		assert.match(panel, /rightmostEditorColumn\(vscode\.window\.tabGroups\.all\.map/);
		assert.match(panel, /preserveFocus: quiet/);
		assert.match(panel, /isMarkdownPlanName\(target\.name\)/);
		assert.match(panel, /executeCommand\('markdown\.showPreview', uri\)/);
		assert.ok(!panel.includes('markdown.showPreviewToSide'), 'a preview joins an existing column instead of splitting one off');
		assert.ok(!panel.includes("mode === undefined ? 'sw'"), 'a missing mode is refused, never narrowed');
		assert.match(panel, /const buildMode = asBuildMode\(mode\)/);
		assert.match(panel, /buildPlanPrompt\(target\.relative, content, buildMode\)/);
		assert.match(panel, /isPlanWriterTool/);
		assert.match(panel, /ctx\.llm\.keyReady\(modelPick\)/);
		assert.match(panel, /ctx\.settings\.update\('model', modelPick, composerScope\(\)\)/);
		assert.match(panel, /applyPolicy\(\{ mode: buildMode \}, composerScope\(\)\)/);
		const css = readFileSync(join(__dirname, '..', '..', 'resources', 'chat.css'), 'utf8');
		assert.match(css, /\.plan-card/);
		assert.match(css, /\.plan-menu\s*\{[\s\S]*?position:\s*fixed/);
	});

	test('a plan preview joins the rightmost editor column', () => {
		assert.strictEqual(rightmostEditorColumn([]), vscode.ViewColumn.Active, 'no group to join: the active one');
		assert.strictEqual(rightmostEditorColumn([vscode.ViewColumn.One]), vscode.ViewColumn.One);
		assert.strictEqual(
			rightmostEditorColumn([vscode.ViewColumn.Three, vscode.ViewColumn.One, vscode.ViewColumn.Two]),
			vscode.ViewColumn.Three,
		);
	});

	test('a recorded plan path survives a changed plan directory', () => {
		const recorded = parsePlanResult(
			'wrote plan plan.md\nplan path: notes/plans/chat-1/plan.md\n\nThe plan is recorded. Stop here and summarize it.',
		);
		assert.deepStrictEqual(recorded, { name: 'plan.md', relative: 'notes/plans/chat-1/plan.md', edited: false });
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
		assert.deepStrictEqual(parsePlanResult('wrote plan plan.md\n\nThe plan is recorded.'), {
			name: 'plan.md',
			edited: false,
		});
		assert.strictEqual(parsePlanResult('wrote something else'), undefined);
		assert.strictEqual(planPathForRecorded('/repo', 'chat-1', { name: 'plan.md' }), null);
	});

	test('an edit result records the plan and marks it as edited', () => {
		assert.deepStrictEqual(parsePlanResult('edited plan plan.md\nplan path: notes/plans/chat-1/plan.md\n\n1 edit applied.'), {
			name: 'plan.md',
			relative: 'notes/plans/chat-1/plan.md',
			edited: true,
		});
		assert.deepStrictEqual(parsePlanResult('edited plan plan.md\n\n2 edits applied.'), { name: 'plan.md', edited: true });
		assert.strictEqual(parsePlanResult('edited something else'), undefined);
	});

	test('both plan writers feed the plan card', () => {
		assert.strictEqual(isPlanWriterTool('write_plan'), true);
		assert.strictEqual(isPlanWriterTool('edit_plan'), true);
		assert.strictEqual(isPlanWriterTool('read_plan'), false);
		assert.strictEqual(isPlanWriterTool(undefined), false);
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

suite('Plan edits', () => {
	test('applies a batch in order and leaves other text untouched', () => {
		const text = '# Plan\n\n## Steps\n\n1. Old\n\n## Risks\n\nnone\n';
		const result = applyLiteralEdits(
			text,
			[
				{ old: '## Steps\n\n1. Old', new: '## Steps\n\n1. New' },
				{ old: '1. New', new: '1. New\n2. Added' },
			],
			'plan "plan.md"',
		);
		assert.strictEqual(result, '# Plan\n\n## Steps\n\n1. New\n2. Added\n\n## Risks\n\nnone\n');
	});

	test('inserts the replacement literally, without $ pattern expansion', () => {
		assert.strictEqual(
			applyLiteralEdits('cost: X', [{ old: 'X', new: "$& $1 $' $$" }], 'plan "plan.md"'),
			"cost: $& $1 $' $$",
		);
	});

	test('refuses an empty, missing or ambiguous anchor', () => {
		assert.throws(
			() => applyLiteralEdits('abc', [{ old: '', new: 'x' }], 'plan "plan.md"'),
			/plan "plan\.md", edit 1: old text is empty/,
		);
		assert.throws(
			() =>
				applyLiteralEdits(
					'one two',
					[
						{ old: 'one', new: 'ONE' },
						{ old: 'missing', new: 'x' },
					],
					'plan "plan.md"',
				),
			/edit 2: old text was not found; call read_plan and copy the current text exactly/,
		);
		assert.throws(
			() => applyLiteralEdits('ab ab', [{ old: 'ab', new: 'x' }], 'plan "plan.md"'),
			/old text occurs 2 times; include more surrounding text/,
		);
	});

	test('counts overlapping occurrences as ambiguous', () => {
		assert.throws(
			() => applyLiteralEdits('aaa', [{ old: 'aa', new: 'x' }], 'plan "plan.md"'),
			/old text occurs 2 times/,
		);
	});
});
