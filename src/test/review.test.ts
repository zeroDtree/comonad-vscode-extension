// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import type { FileChange, JournalFile } from '../lib/journal';
import { diffLines, hunkKey } from '../lib/line-diff';
import { fileReviewBlocked, fileReviewIdle, fileReviewState, hunkAnchorLine, hunkViews } from '../lib/file-review-model';
import { fileSummary, findHunk, reviewBlocks, reviewState } from '../lib/review-model';
import type { ReviewBlock } from '../lib/review-protocol';

function changeOf(path: string, baseline: string, current: string, extra: Partial<FileChange> = {}): FileChange {
	const diff = diffLines(baseline, current);
	return {
		path,
		baseline,
		current,
		hunks: diff.hunks,
		created: false,
		deleted: false,
		changedOutside: false,
		truncated: diff.truncated,
		binary: false,
		...extra,
	};
}

function journalFile(path: string, additions: number, deletions: number, extra: Partial<JournalFile> = {}): JournalFile {
	return {
		path,
		additions,
		deletions,
		created: false,
		deleted: false,
		changedOutside: false,
		dirty: false,
		hunks: [],
		...extra,
	};
}

const kinds = (blocks: ReviewBlock[]): ReviewBlock['kind'][] => blocks.map((block) => block.kind);

suite('Review view model', () => {
	test('a replacement shows context on both sides and line numbers from each file', () => {
		const baseline = Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`).join('');
		const current = baseline.replace('line 5\n', 'changed 5\n');
		const change = changeOf('a.txt', baseline, current);
		const { blocks, more } = reviewBlocks(change);

		assert.strictEqual(more, 0);
		assert.deepStrictEqual(kinds(blocks), ['gap', 'context', 'hunk', 'context', 'gap']);
		const leading = blocks[0] as Extract<ReviewBlock, { kind: 'gap' }>;
		assert.strictEqual(leading.omitted, 1);
		const before = blocks[1] as Extract<ReviewBlock, { kind: 'context' }>;
		assert.deepStrictEqual(before.rows.map((row) => [row.oldLine, row.newLine, row.text]), [
			[2, 2, 'line 2'],
			[3, 3, 'line 3'],
			[4, 4, 'line 4'],
		]);
		const hunk = blocks[2] as Extract<ReviewBlock, { kind: 'hunk' }>;
		assert.strictEqual(hunk.key, hunkKey(change.hunks[0]!));
		assert.strictEqual(hunk.header, '@@ -5,1 +5,1 @@');
		assert.strictEqual(hunk.targetLine, 5);
		assert.deepStrictEqual(hunk.rows.map((row) => [row.kind, row.oldLine, row.newLine, row.targetLine, row.text]), [
			['del', 5, null, 5, 'line 5'],
			['add', null, 5, 5, 'changed 5'],
		]);
		const after = blocks[3] as Extract<ReviewBlock, { kind: 'context' }>;
		assert.deepStrictEqual(after.rows.map((row) => [row.oldLine, row.newLine]), [
			[6, 6],
			[7, 7],
			[8, 8],
		]);
		const trailing = blocks[4] as Extract<ReviewBlock, { kind: 'gap' }>;
		assert.strictEqual(trailing.omitted, 2);
	});

	test('two distant changes keep their own context and omit the middle', () => {
		const baseline = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join('');
		const current = baseline.replace('line 5\n', 'changed 5\n').replace('line 25\n', 'changed 25\n');
		const change = changeOf('a.txt', baseline, current);
		const { blocks } = reviewBlocks(change);

		assert.deepStrictEqual(kinds(blocks), ['gap', 'context', 'hunk', 'context', 'gap', 'context', 'hunk', 'context', 'gap']);
		const middleGap = blocks[4] as Extract<ReviewBlock, { kind: 'gap' }>;
		assert.strictEqual(middleGap.omitted, 13, 'lines 9–21 are omitted between the two windows');
		assert.deepStrictEqual((blocks[3] as Extract<ReviewBlock, { kind: 'context' }>).rows.map((row) => row.newLine), [6, 7, 8]);
		assert.deepStrictEqual((blocks[5] as Extract<ReviewBlock, { kind: 'context' }>).rows.map((row) => row.newLine), [22, 23, 24]);
	});

	test('a created file is all additions, numbered on the new side', () => {
		const change = changeOf('new.txt', '', 'a\nb\n', { created: true });
		const { blocks } = reviewBlocks(change);

		assert.deepStrictEqual(kinds(blocks), ['hunk']);
		const hunk = blocks[0] as Extract<ReviewBlock, { kind: 'hunk' }>;
		assert.deepStrictEqual(hunk.rows.map((row) => [row.kind, row.oldLine, row.newLine, row.text]), [
			['add', null, 1, 'a'],
			['add', null, 2, 'b'],
		]);
	});

	test('a deleted file is all deletions, anchored on the line that followed it', () => {
		const change = changeOf('gone.txt', 'a\nb\n', '', { deleted: true });
		const { blocks } = reviewBlocks(change);

		assert.deepStrictEqual(kinds(blocks), ['hunk']);
		const hunk = blocks[0] as Extract<ReviewBlock, { kind: 'hunk' }>;
		assert.deepStrictEqual(hunk.rows.map((row) => [row.kind, row.oldLine, row.newLine, row.targetLine, row.text]), [
			['del', 1, null, 1, 'a'],
			['del', 2, null, 1, 'b'],
		]);
	});

	test('CRLF text is displayed without its terminator', () => {
		const change = changeOf('crlf.txt', 'a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n');
		const { blocks } = reviewBlocks(change);
		const texts = blocks.flatMap((block) => (block.kind === 'gap' ? [] : block.rows.map((row) => row.text)));

		assert.ok(texts.every((text) => !text.includes('\r')));
		assert.deepStrictEqual(texts, ['a', 'b', 'B', 'c']);
	});

	test('binary and truncated files have no rows to render', () => {
		assert.deepStrictEqual(reviewBlocks(changeOf('a.bin', 'a', 'b', { binary: true })), { blocks: [], more: 0 });
		assert.deepStrictEqual(reviewBlocks(changeOf('huge.txt', 'a', 'b', { truncated: true })), { blocks: [], more: 0 });
	});

	test('findHunk matches by the journal key and rejects a stale one', () => {
		const change = changeOf('a.txt', 'one\n', 'two\n');
		const key = hunkKey(change.hunks[0]!);

		assert.strictEqual(findHunk(change, key), change.hunks[0]);
		assert.strictEqual(findHunk(change, 'not-a-key'), undefined);
		assert.strictEqual(findHunk(undefined, key), undefined);
	});

	test('fileSummary copies the flags the sidebar badges', () => {
		const summary = fileSummary(journalFile('a.txt', 2, 1, { created: true, dirty: true, changedOutside: true }));
		assert.deepStrictEqual(summary, {
			path: 'a.txt',
			additions: 2,
			deletions: 1,
			created: true,
			deleted: false,
			changedOutside: true,
			dirty: true,
		});
	});

	test('reviewState falls back to the first file and totals every count', () => {
		const files = [fileSummary(journalFile('a.txt', 2, 1)), fileSummary(journalFile('b.txt', 3, 0))];
		const state = reviewState({
			sessionId: 's',
			workspace: '/ws',
			available: true,
			files,
			activePath: 'gone.txt',
			active: null,
			note: 'note',
		});

		assert.strictEqual(state.reason, 'ready');
		assert.strictEqual(state.activePath, 'a.txt');
		assert.deepStrictEqual(state.totals, { files: 2, additions: 5, deletions: 1 });
		assert.strictEqual(state.note, 'note');
	});

	test('reviewState names why there is nothing to review', () => {
		const empty = reviewState({ sessionId: 's', workspace: '/ws', available: true, files: [], activePath: null, active: null, note: '' });
		assert.strictEqual(empty.reason, 'no-changes');
		assert.strictEqual(empty.message, 'No pending changes.');
		assert.strictEqual(empty.activePath, null);

		const fresh = reviewState({ sessionId: 's', workspace: '/ws', available: false, files: [], activePath: null, active: null, note: '' });
		assert.strictEqual(fresh.message, 'This chat has not written any files.');

		const noSession = reviewState({ sessionId: null, workspace: null, available: false, files: [], activePath: null, active: null, note: '' });
		assert.strictEqual(noSession.reason, 'no-session');

		const failed = reviewState({ sessionId: 's', workspace: '/ws', available: true, files: [], activePath: null, active: null, error: 'journal unreadable', note: '' });
		assert.strictEqual(failed.reason, 'error');
		assert.strictEqual(failed.message, 'journal unreadable');
	});

	test('an unreadable active file leaves the rest of the list usable', () => {
		const files = [fileSummary(journalFile('a.txt', 1, 0))];
		const state = reviewState({
			sessionId: 's',
			workspace: '/ws',
			available: true,
			files,
			activePath: 'a.txt',
			active: null,
			activeError: 'a.txt moved',
			note: '',
		});

		assert.strictEqual(state.reason, 'ready');
		assert.strictEqual(state.active, null);
		assert.strictEqual(state.activeError, 'a.txt moved');
	});
});

suite('File review view model', () => {
	test('hunk views carry the journal key and the line just below each block', () => {
		const baseline = Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`).join('');
		const current = baseline.replace('line 5\n', 'changed 5\n');
		const change = changeOf('a.txt', baseline, current);
		const views = hunkViews(change.hunks);

		assert.strictEqual(views.length, 1);
		assert.strictEqual(views[0]!.key, hunkKey(change.hunks[0]!));
		assert.strictEqual(views[0]!.anchorLine, 5);
		assert.deepStrictEqual([views[0]!.additions, views[0]!.deletions], [1, 1]);
		assert.deepStrictEqual(
			[views[0]!.oldStart, views[0]!.oldLines, views[0]!.newStart, views[0]!.newLines],
			[5, 1, 5, 1],
		);
	});

	test('a pure deletion anchors on the line that took its place', () => {
		const baseline = 'a\nb\nc\n';
		const current = 'a\nc\n';
		const change = changeOf('a.txt', baseline, current);
		const views = hunkViews(change.hunks);

		assert.strictEqual(views.length, 1);
		assert.deepStrictEqual([views[0]!.additions, views[0]!.deletions], [0, 1]);
		assert.deepStrictEqual([views[0]!.newStart, views[0]!.newLines], [1, 0]);
		// 0-based line 1 is `c`, the line that came after the removed `b`.
		assert.strictEqual(hunkAnchorLine(change.hunks[0]!), 1);
	});

	test('a deletion after the last line anchors past the document', () => {
		const change = changeOf('a.txt', 'a\nb\n', 'a\n');
		const views = hunkViews(change.hunks);

		assert.strictEqual(views.length, 1);
		// `current` has one line; an anchor of 1 is the line after it, which the guest draws at the
		// document end. The model does not clamp: the guest owns the document's line count.
		assert.strictEqual(views[0]!.anchorLine, 1);
	});

	test('fileReviewState carries both texts and marks binary content unreadable', () => {
		const change = changeOf('src/a.py', 'old\n', 'new\n');
		const state = fileReviewState(change, false);

		assert.strictEqual(state.reason, 'ready');
		assert.strictEqual(state.baseline, 'old\n');
		assert.strictEqual(state.current, 'new\n');
		assert.strictEqual(state.blockedReason, '');
		assert.strictEqual(state.hunks.length, 1);

		const binary = fileReviewState(changeOf('img.png', '', '', { binary: true }), false);
		assert.strictEqual(binary.reason, 'binary');
		assert.strictEqual(binary.baseline, '');
		assert.strictEqual(binary.current, '');
		assert.deepStrictEqual(binary.hunks, []);
	});

	test('blocked reasons follow the Review tab order', () => {
		const change = changeOf('a.txt', 'a\n', 'b\n', { changedOutside: true, truncated: true });
		assert.strictEqual(fileReviewBlocked(change, true), 'Save the file first');
		assert.strictEqual(fileReviewBlocked(change, false), 'Changed outside the agent');
		assert.strictEqual(fileReviewBlocked({ ...change, changedOutside: false }, false), 'Too large for block actions');
		assert.strictEqual(fileReviewBlocked(changeOf('img.png', '', '', { binary: true }), false), 'Binary file');
		assert.strictEqual(fileReviewBlocked(changeOf('a.txt', 'a\n', 'b\n'), false), '');
	});

	test('a truncated change still sends the file but no blocks', () => {
		const state = fileReviewState(changeOf('big.txt', 'a\n', 'b\n', { truncated: true }), false);
		assert.strictEqual(state.reason, 'ready');
		assert.strictEqual(state.truncated, true);
		assert.deepStrictEqual(state.hunks, []);
		assert.strictEqual(state.blockedReason, 'Too large for block actions');
	});

	test('an idle review names the path and why it is empty', () => {
		const idle = fileReviewIdle('a.txt', 'no-pending', 'No pending changes for this file.');
		assert.strictEqual(idle.path, 'a.txt');
		assert.strictEqual(idle.reason, 'no-pending');
		assert.strictEqual(idle.message, 'No pending changes for this file.');
		assert.strictEqual(idle.blockedReason, 'Nothing pending');
	});
});
