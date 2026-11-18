// SPDX-License-Identifier: AGPL-3.0-only
import { EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	WidgetType,
	drawSelection,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
	scrollPastEnd,
	type DecorationSet,
	type ViewUpdate,
} from '@codemirror/view';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { c as cMode, cpp as cppMode, csharp as csharpMode, dart as dartMode, java as javaMode, kotlin as kotlinMode, scala as scalaMode } from '@codemirror/legacy-modes/mode/clike';
import { css as cssMode, less as lessMode, sCSS as scssMode } from '@codemirror/legacy-modes/mode/css';
import { diff as diffMode } from '@codemirror/legacy-modes/mode/diff';
import { dockerFile as dockerMode } from '@codemirror/legacy-modes/mode/dockerfile';
import { go as goMode } from '@codemirror/legacy-modes/mode/go';
import { haskell as haskellMode } from '@codemirror/legacy-modes/mode/haskell';
import { javascript as javascriptMode, json as jsonMode, typescript as typescriptMode } from '@codemirror/legacy-modes/mode/javascript';
import { julia as juliaMode } from '@codemirror/legacy-modes/mode/julia';
import { lua as luaMode } from '@codemirror/legacy-modes/mode/lua';
import { perl as perlMode } from '@codemirror/legacy-modes/mode/perl';
import { powerShell as powershellMode } from '@codemirror/legacy-modes/mode/powershell';
import { cython as cythonMode, python as pythonMode } from '@codemirror/legacy-modes/mode/python';
import { r as rMode } from '@codemirror/legacy-modes/mode/r';
import { ruby as rubyMode } from '@codemirror/legacy-modes/mode/ruby';
import { rust as rustMode } from '@codemirror/legacy-modes/mode/rust';
import { shell as shellMode } from '@codemirror/legacy-modes/mode/shell';
import { standardSQL as sqlMode } from '@codemirror/legacy-modes/mode/sql';
import { swift as swiftMode } from '@codemirror/legacy-modes/mode/swift';
import { toml as tomlMode } from '@codemirror/legacy-modes/mode/toml';
import { html as htmlMode, xml as xmlMode } from '@codemirror/legacy-modes/mode/xml';
import { yaml as yamlMode } from '@codemirror/legacy-modes/mode/yaml';
import { diffLines, splitLines, stripEol } from '../lib/line-diff';
import { hunkViews } from '../lib/file-review-model';
import type { FileHunkView, FileReviewChange, FileReviewGuestMessage, FileReviewHostMessage, FileReviewState } from '../lib/file-review-protocol';

/**
 * The File Review editor's guest: a whole file in an editable CodeMirror view. Its changes are drawn
 * from the journal's own hunks — the same blocks the Keep/Undo bars act on — so a block's paint,
 * its +/− counts and its bar cannot disagree. Deleted lines are real rows here, wrapping like the
 * rest of the file; the host owns the document and applies the edits.
 *
 * While the document has unsaved changes the host's hunks describe the file on disk, so the guest
 * diffs the accepted baseline against the live buffer itself; the bars stay visible but disabled
 * until the save brings fresh hunks.
 *
 * The view is created once and updated in place: a journal refresh may change the baseline and the
 * bars, but it must not throw away the reader's cursor, selection, scroll or undo history. External
 * document changes do replace the state on purpose — undo must never bring back text an agent or
 * another editor has since written.
 */

declare function acquireVsCodeApi(): {
	postMessage(message: FileReviewGuestMessage): void;
	getState(): unknown;
	setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const post = (message: FileReviewGuestMessage): void => vscode.postMessage(message);

function byId<T extends HTMLElement>(id: string): T {
	const element = document.getElementById(id);
	if (!element) {
		throw new Error(`missing #${id}`);
	}
	return element as T;
}

const pathLabel = byId<HTMLSpanElement>('fr-path');
const badges = byId<HTMLSpanElement>('fr-badges');
const openButton = byId<HTMLButtonElement>('fr-open');
const diffButton = byId<HTMLButtonElement>('fr-diff');
const undoFileButton = byId<HTMLButtonElement>('fr-undo');
const keepFileButton = byId<HTMLButtonElement>('fr-keep');
const editorHost = byId<HTMLDivElement>('fr-editor');
const empty = byId<HTMLDivElement>('fr-empty');
const notice = byId<HTMLDivElement>('fr-notice');

let view: EditorView | null = null;
let state: FileReviewState | null = null;
let dirty = false;
let language = 'plaintext';
let tabSize = 4;
let noticeTimer: number | undefined;

/** The value the tab is drawn with, read once: webviews reload on a theme change. */
const dark = (() => {
	const kind = document.body.dataset.vscodeThemeKind ?? '';
	return kind === 'vscode-dark' || kind === 'vscode-high-contrast' || document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
})();

/* ---------------------------------------------------------------- languages */

const modeFor = (parser: Parameters<typeof StreamLanguage.define>[0]): Extension => StreamLanguage.define(parser);

const byExtension: Record<string, () => Extension> = {
	py: () => modeFor(pythonMode),
	pyi: () => modeFor(pythonMode),
	pyw: () => modeFor(pythonMode),
	pyx: () => modeFor(cythonMode),
	js: () => modeFor(javascriptMode),
	mjs: () => modeFor(javascriptMode),
	cjs: () => modeFor(javascriptMode),
	jsx: () => modeFor(javascriptMode),
	ts: () => modeFor(typescriptMode),
	mts: () => modeFor(typescriptMode),
	cts: () => modeFor(typescriptMode),
	tsx: () => modeFor(typescriptMode),
	json: () => modeFor(jsonMode),
	jsonc: () => modeFor(jsonMode),
	json5: () => modeFor(jsonMode),
	sh: () => modeFor(shellMode),
	bash: () => modeFor(shellMode),
	zsh: () => modeFor(shellMode),
	ksh: () => modeFor(shellMode),
	c: () => modeFor(cMode),
	h: () => modeFor(cMode),
	cc: () => modeFor(cppMode),
	cpp: () => modeFor(cppMode),
	cxx: () => modeFor(cppMode),
	hpp: () => modeFor(cppMode),
	hh: () => modeFor(cppMode),
	hxx: () => modeFor(cppMode),
	cs: () => modeFor(csharpMode),
	java: () => modeFor(javaMode),
	kt: () => modeFor(kotlinMode),
	kts: () => modeFor(kotlinMode),
	scala: () => modeFor(scalaMode),
	sc: () => modeFor(scalaMode),
	dart: () => modeFor(dartMode),
	go: () => modeFor(goMode),
	rs: () => modeFor(rustMode),
	rb: () => modeFor(rubyMode),
	rake: () => modeFor(rubyMode),
	pl: () => modeFor(perlMode),
	pm: () => modeFor(perlMode),
	lua: () => modeFor(luaMode),
	swift: () => modeFor(swiftMode),
	r: () => modeFor(rMode),
	jl: () => modeFor(juliaMode),
	hs: () => modeFor(haskellMode),
	sql: () => modeFor(sqlMode),
	yaml: () => modeFor(yamlMode),
	yml: () => modeFor(yamlMode),
	toml: () => modeFor(tomlMode),
	xml: () => modeFor(xmlMode),
	svg: () => modeFor(xmlMode),
	plist: () => modeFor(xmlMode),
	html: () => modeFor(htmlMode),
	htm: () => modeFor(htmlMode),
	css: () => modeFor(cssMode),
	scss: () => modeFor(scssMode),
	less: () => modeFor(lessMode),
	diff: () => modeFor(diffMode),
	patch: () => modeFor(diffMode),
	ps1: () => modeFor(powershellMode),
	psm1: () => modeFor(powershellMode),
};

const byLanguage: Record<string, () => Extension> = {
	python: () => modeFor(pythonMode),
	cython: () => modeFor(cythonMode),
	javascript: () => modeFor(javascriptMode),
	javascriptreact: () => modeFor(javascriptMode),
	typescript: () => modeFor(typescriptMode),
	typescriptreact: () => modeFor(typescriptMode),
	json: () => modeFor(jsonMode),
	jsonc: () => modeFor(jsonMode),
	shellscript: () => modeFor(shellMode),
	c: () => modeFor(cMode),
	cpp: () => modeFor(cppMode),
	csharp: () => modeFor(csharpMode),
	java: () => modeFor(javaMode),
	kotlin: () => modeFor(kotlinMode),
	scala: () => modeFor(scalaMode),
	dart: () => modeFor(dartMode),
	go: () => modeFor(goMode),
	rust: () => modeFor(rustMode),
	ruby: () => modeFor(rubyMode),
	perl: () => modeFor(perlMode),
	lua: () => modeFor(luaMode),
	swift: () => modeFor(swiftMode),
	r: () => modeFor(rMode),
	julia: () => modeFor(juliaMode),
	haskell: () => modeFor(haskellMode),
	sql: () => modeFor(sqlMode),
	yaml: () => modeFor(yamlMode),
	toml: () => modeFor(tomlMode),
	xml: () => modeFor(xmlMode),
	html: () => modeFor(htmlMode),
	css: () => modeFor(cssMode),
	scss: () => modeFor(scssMode),
	less: () => modeFor(lessMode),
	diff: () => modeFor(diffMode),
	powershell: () => modeFor(powershellMode),
	dockerfile: () => modeFor(dockerMode),
};

/** What to highlight by: the document's language id, then its extension as a fallback. */
function languageFor(languageId: string, path: string): Extension | undefined {
	const direct = byLanguage[languageId];
	if (direct) {
		return direct();
	}
	const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
	if (base === 'dockerfile') {
		return modeFor(dockerMode);
	}
	if (base === 'gemfile' || base === 'rakefile') {
		return modeFor(rubyMode);
	}
	const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
	return byExtension[ext]?.();
}

/* ------------------------------------------------------------------- theme */

const highlight = HighlightStyle.define([
	{ tag: [tags.keyword, tags.moduleKeyword], color: 'var(--fr-tok-keyword)' },
	{ tag: [tags.controlKeyword, tags.operatorKeyword], color: 'var(--fr-tok-control)' },
	{ tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--fr-tok-string)' },
	{ tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--fr-tok-comment)', fontStyle: 'italic' },
	{ tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--fr-tok-number)' },
	{ tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--fr-tok-function)' },
	{ tag: [tags.typeName, tags.className, tags.namespace, tags.annotation], color: 'var(--fr-tok-type)' },
	{ tag: [tags.variableName, tags.propertyName, tags.definition(tags.variableName)], color: 'var(--fr-tok-variable)' },
	{ tag: [tags.operator, tags.punctuation], color: 'var(--fr-tok-operator)' },
	{ tag: tags.strong, fontWeight: 'bold' },
	{ tag: tags.emphasis, fontStyle: 'italic' },
	{ tag: tags.link, color: 'var(--fr-tok-link)', textDecoration: 'underline' },
	{ tag: tags.invalid, color: 'var(--vscode-errorForeground, #f85149)' },
]);

const theme = EditorView.theme(
	{
		'&': {
			height: '100%',
			color: 'var(--vscode-editor-foreground)',
			backgroundColor: 'var(--vscode-editor-background)',
		},
		'.cm-scroller': {
			fontFamily: 'var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)',
			fontSize: 'var(--vscode-editor-font-size, 13px)',
			lineHeight: '1.55',
		},
		'.cm-content': { padding: '6px 0', caretColor: 'var(--vscode-editorCursor-foreground)' },
		'.cm-gutters': {
			backgroundColor: 'var(--vscode-editorGutter-background, var(--vscode-editor-background))',
			color: 'var(--vscode-editorLineNumber-foreground)',
			borderRight: '1px solid var(--vscode-editorGutter-border, transparent)',
		},
		'.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)' },
		'.cm-activeLineGutter': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)' },
		'&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--vscode-editor-selectionBackground, rgba(120, 150, 200, 0.35))' },
		// Cursor style: background only, no underlines and no gutter bars. Added lines and deleted
		// rows are drawn from the journal's hunks — the same blocks the bars act on — so the paint,
		// the +/− counts and the bar can never disagree. The left padding matches `.cm-line`, and
		// the rows wrap like the rest of the file.
		'.fr-added-line': {
			backgroundColor: 'var(--vscode-diffEditor-insertedLineBackground, rgba(46, 160, 67, 0.12))',
		},
		'.fr-changed-text': {
			backgroundColor: 'var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, 0.28))',
		},
		'.fr-deleted-chunk': {
			backgroundColor: 'var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, 0.12))',
			padding: '0 2px 0 6px',
			whiteSpace: 'pre-wrap',
			overflowWrap: 'anywhere',
		},
		'.fr-deleted-text': {
			backgroundColor: 'var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.28))',
		},
	},
	{ dark },
);

/* --------------------------------------------------------------- hunk bars */

function button(className: string, text: string, title: string, disabled: boolean, act: () => void): HTMLButtonElement {
	const element = document.createElement('button');
	element.type = 'button';
	element.className = className;
	element.textContent = text;
	element.title = title;
	element.disabled = disabled;
	if (!disabled) {
		element.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			act();
		});
	}
	return element;
}

/** One block's Cursor-like bar: the counts on the left, Undo and Keep on the right. */
class HunkBar extends WidgetType {
	constructor(
		readonly hunk: FileHunkView,
		readonly blocked: string,
	) {
		super();
	}

	eq(other: HunkBar): boolean {
		return other.hunk.key === this.hunk.key && other.blocked === this.blocked;
	}

	toDOM(): HTMLElement {
		const bar = document.createElement('div');
		bar.className = 'fr-hunk-actions';
		const meta = document.createElement('span');
		meta.className = 'fr-hunk-meta';
		meta.textContent = `+${this.hunk.additions} −${this.hunk.deletions}`;
		const undo = button('fr-hunk-button', '↶ Undo', this.blocked || 'Restore this block to the baseline', Boolean(this.blocked), () =>
			post({ type: 'undoHunk', hunk: this.hunk.key }),
		);
		const keep = button('fr-hunk-button fr-hunk-keep', '✓ Keep', this.blocked || 'Accept this block into the baseline', Boolean(this.blocked), () =>
			post({ type: 'keepHunk', hunk: this.hunk.key }),
		);
		bar.append(meta, undo, keep);
		return bar;
	}
}

interface DeletedRow {
	text: string;
	/** The changed columns, when the row pairs with the line that replaced it. */
	mark: readonly [number, number] | null;
}

/** The removed lines of a block, drawn in place above the lines that replaced them. */
class DeletedChunk extends WidgetType {
	constructor(readonly rows: readonly DeletedRow[]) {
		super();
	}

	eq(other: DeletedChunk): boolean {
		return (
			other.rows.length === this.rows.length &&
			other.rows.every((row, index) => {
				const own = this.rows[index]!;
				return row.text === own.text && (row.mark?.[0] ?? -1) === (own.mark?.[0] ?? -1) && (row.mark?.[1] ?? -1) === (own.mark?.[1] ?? -1);
			})
		);
	}

	toDOM(): HTMLElement {
		const block = document.createElement('div');
		block.className = 'fr-deleted-chunk';
		for (const row of this.rows) {
			const line = document.createElement('div');
			line.className = 'fr-deleted-line';
			// An empty removed line still has to occupy a row.
			const text = row.text || '\u00a0';
			if (!row.mark) {
				line.textContent = text;
			} else {
				const [from, to] = row.mark;
				const changed = document.createElement('span');
				changed.className = 'fr-deleted-text';
				changed.textContent = text.slice(from, to);
				line.append(document.createTextNode(text.slice(0, from)), changed, document.createTextNode(text.slice(to)));
			}
			block.append(line);
		}
		return block;
	}
}

/** The unchanged head and tail columns of a replaced line pair. */
function lineEdges(before: string, after: string): { prefix: number; suffix: number } {
	const max = Math.min(before.length, after.length);
	let prefix = 0;
	while (prefix < max && before[prefix] === after[prefix]) {
		prefix += 1;
	}
	let suffix = 0;
	while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
		suffix += 1;
	}
	return { prefix, suffix };
}

/** The block actions refuse an unsaved buffer; the bars say so and stay disabled. */
const DIRTY_BLOCKED = 'Save the file first';

/** CodeMirror's text is LF-joined; the baseline arrives as raw bytes. */
const normalizeEol = (text: string): string => text.replace(/\r\n?/g, '\n');

interface ReviewData {
	hunks: readonly FileHunkView[];
	blocked: string;
	/** The accepted baseline, where a block's deleted rows are read from. */
	baseline: string;
	/** The host state is `ready` and small enough to diff. */
	diffable: boolean;
	/** Draw the baseline against the live buffer instead of the host's on-disk hunks. */
	live: boolean;
}

const setReview = StateEffect.define<ReviewData>();
/** The hunks and baseline the next state is built with; a state effect replaces them in place. */
let reviewData: ReviewData = { hunks: [], blocked: '', baseline: '', diffable: false, live: false };

/** The blocks of an unsaved buffer: the host's hunks describe the file on disk, not this text. */
function liveHunks(doc: Text, baseline: string): readonly FileHunkView[] | null {
	const diff = diffLines(normalizeEol(baseline), doc.toString());
	return diff.truncated ? null : hunkViews(diff.hunks);
}

/** A block's paint: its added lines, its deleted rows and its bar, all from the same hunk. */
function buildReview(doc: Text, data: ReviewData): DecorationSet {
	const hunks = data.live ? liveHunks(doc, data.baseline) : data.hunks;
	if (!hunks || !hunks.length) {
		return Decoration.none;
	}
	const baseline = data.baseline ? splitLines(normalizeEol(data.baseline)) : [];
	const ranges = [];
	for (const hunk of hunks) {
		const at = hunk.anchorLine >= doc.lines ? doc.length : doc.line(Math.max(0, hunk.anchorLine) + 1).from;
		if (hunk.newLines > 0) {
			const first = Math.min(doc.lines, Math.max(1, hunk.newStart));
			const last = Math.min(doc.lines, first + hunk.newLines - 1);
			for (let number = first; number <= last; number += 1) {
				ranges.push(Decoration.line({ class: 'fr-added-line' }).range(doc.line(number).from));
			}
		}
		if (hunk.oldLines > 0) {
			const start = Math.max(0, hunk.oldStart - 1);
			const rows: DeletedRow[] = [];
			// A replacement with the same number of lines pairs them one to one, so the changed
			// columns can carry the stronger tint on both sides — still a background, never a line.
			const paired = hunk.oldLines === hunk.newLines && hunk.newLines > 0;
			for (let index = 0; index < hunk.oldLines; index += 1) {
				const text = stripEol(baseline[start + index] ?? '');
				let mark: readonly [number, number] | null = null;
				const number = hunk.newStart + index;
				if (paired && number <= doc.lines) {
					const line = doc.line(number);
					const { prefix, suffix } = lineEdges(text, line.text);
					if (prefix < text.length - suffix) {
						mark = [prefix, text.length - suffix];
					}
					const from = line.from + prefix;
					const to = line.from + line.length - suffix;
					if (from < to) {
						ranges.push(Decoration.mark({ class: 'fr-changed-text' }).range(from, to));
					}
				}
				rows.push({ text, mark });
			}
			const pos = hunk.newLines > 0 ? doc.line(Math.min(doc.lines, Math.max(1, hunk.newStart))).from : at;
			ranges.push(Decoration.widget({ widget: new DeletedChunk(rows), block: true, side: -1 }).range(pos));
		}
		// `side: -1` attaches the bar to the line that follows it, so the gutter's line numbers stay
		// aligned; `side: 1` puts an end-of-document bar below a removal widget at the same position.
		ranges.push(Decoration.widget({ widget: new HunkBar(hunk, data.blocked), block: true, side: at === doc.length ? 1 : -1 }).range(at));
	}
	return Decoration.set(ranges, true);
}

/**
 * A state field, not a view plugin: block widgets take vertical space, and CodeMirror only lets
 * layout-affecting decorations come from the state. Clean hunks are the host's — their keys are
 * the journal's, so the bars can act on them. An unsaved buffer is diffed here instead, against
 * the same baseline, and keeps painting live until the save delivers fresh hunks.
 */
const reviewField = StateField.define<DecorationSet>({
	create: (editor) => buildReview(editor.doc, reviewData),
	update: (decorations, transaction) => {
		let next: ReviewData | null = null;
		for (const effect of transaction.effects) {
			if (effect.is(setReview)) {
				next = effect.value;
			}
		}
		if (next) {
			reviewData = next;
			return buildReview(transaction.state.doc, next);
		}
		if (!transaction.docChanged) {
			return decorations;
		}
		// The buffer no longer matches the text the host diffed: from here until the next state
		// message the blocks are this guest's, and only a saved document can act on them.
		if (reviewData.diffable && !reviewData.live) {
			reviewData = { ...reviewData, hunks: [], live: true, blocked: DIRTY_BLOCKED };
		}
		return buildReview(transaction.state.doc, reviewData);
	},
	provide: (field) => EditorView.decorations.from(field),
});

function updateReview(): void {
	if (!view) {
		return;
	}
	const current = state;
	const diffable = Boolean(current && current.reason === 'ready' && !current.truncated);
	view.dispatch({
		effects: setReview.of({
			// While the buffer is unsaved the host's hunks describe the file on disk, so the guest
			// diffs the baseline against the buffer itself (see `liveHunks`).
			hunks: current && diffable && !dirty ? current.hunks : [],
			blocked: dirty ? DIRTY_BLOCKED : (current?.blockedReason ?? ''),
			baseline: current && diffable ? current.baseline : '',
			diffable,
			live: diffable && dirty,
		}),
	});
}

/* ---------------------------------------------------------------- rendering */

function renderHeader(current: FileReviewState): void {
	pathLabel.textContent = current.path || 'Comonad review';
	pathLabel.title = current.path;
	badges.replaceChildren();
	const badge = (text: string, extra = '', title = ''): void => {
		const element = document.createElement('span');
		element.className = `fr-badge ${extra}`.trim();
		element.textContent = text;
		element.title = title;
		badges.append(element);
	};
	if (current.created) {
		badge('Added', 'created');
	}
	if (current.deleted) {
		badge('Deleted', 'deleted');
	}
	if (current.changedOutside) {
		badge('Changed outside', 'outside');
	}
	if (dirty) {
		badge('Unsaved', 'dirty');
	}
	if (current.truncated) {
		badge('Large', '', 'Too large or too different to diff block by block; the file is shown as it is on disk.');
	}

	const pendingTab = current.reason === 'ready' || current.reason === 'binary' || current.reason === 'too-large';
	openButton.disabled = false;
	openButton.title = 'Open the file in VS Code’s editor beside this tab';
	diffButton.disabled = !pendingTab;
	diffButton.title = 'Open the baseline diff';
	undoFileButton.disabled = !pendingTab || dirty;
	undoFileButton.title = dirty ? 'Save the file first' : 'Restore the accepted baseline';
	keepFileButton.disabled = !pendingTab || dirty;
	keepFileButton.title = dirty ? 'Save the file first' : 'Accept this file as it is now';
}

/** A reason without a diff still keeps the editor: this is a file tab, not a review-only view. */
function renderBanner(current: FileReviewState): void {
	const message = current.reason === 'ready' ? '' : current.message;
	const replacesEditor = current.reason === 'binary' || current.reason === 'too-large';
	empty.hidden = !message;
	empty.className = replacesEditor ? '' : 'fr-banner';
	empty.replaceChildren();
	if (message) {
		const title = document.createElement('div');
		title.className = 'fr-empty-title';
		title.textContent = message;
		empty.append(title);
	}
	editorHost.hidden = replacesEditor;
}

function showNotice(level: 'info' | 'warn' | 'error', text: string): void {
	notice.hidden = false;
	notice.className = `fr-notice fr-notice-${level}`;
	notice.textContent = text;
	clearTimeout(noticeTimer);
	if (level !== 'error') {
		noticeTimer = window.setTimeout(() => {
			notice.hidden = true;
		}, 6000);
	}
}

function setDirty(next: boolean): void {
	if (dirty === next) {
		return;
	}
	dirty = next;
	if (state) {
		renderHeader(state);
	}
	updateReview();
}

/** One editor, one document: the language and the tab size never change after this. */
function extensions(): Extension[] {
	const extensions: Extension[] = [
		lineNumbers(),
		highlightActiveLine(),
		highlightActiveLineGutter(),
		drawSelection(),
		EditorView.lineWrapping,
		scrollPastEnd(),
		EditorState.allowMultipleSelections.of(true),
		EditorState.tabSize.of(tabSize),
		bracketMatching(),
		closeBrackets(),
		history(),
		// Save has to win over the browser's "save page" chord; the host queues it behind its edits.
		Prec.high(
			keymap.of([
				{
					key: 'Mod-s',
					run: () => {
						post({ type: 'save' });
						return true;
					},
				},
			]),
		),
		keymap.of([...closeBracketsKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
		search({ top: true }),
		syntaxHighlighting(highlight),
		theme,
		reviewField,
		EditorView.updateListener.of((update) => {
			if (!update.docChanged) {
				return;
			}
			const changes: FileReviewChange[] = [];
			update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
				const from = update.startState.doc.lineAt(fromA);
				const to = update.startState.doc.lineAt(toA);
				changes.push({
					fromLine: from.number - 1,
					fromCh: fromA - from.from,
					toLine: to.number - 1,
					toCh: toA - to.from,
					removed: update.startState.doc.sliceString(fromA, toA),
					text: inserted.toString(),
				});
			});
			post({ type: 'edit', changes, length: update.state.doc.length });
		}),
	];
	const mode = languageFor(language, state?.path ?? '');
	if (mode) {
		extensions.push(mode);
	}
	return extensions;
}

function scrollToFirstChange(): void {
	if (!view || !state || state.reason !== 'ready' || dirty) {
		return;
	}
	const first = state.hunks[0];
	if (!first) {
		return;
	}
	const line = first.newLines > 0 ? first.newStart - 1 : first.newStart;
	const target = view.state.doc.line(Math.max(0, Math.min(view.state.doc.lines - 1, line)) + 1).from;
	view.dispatch({ effects: EditorView.scrollIntoView(target, { y: 'center' }) });
}

/** Builds the editor for the document the host owns; the view is created exactly once. */
function openDocument(text: string, languageId: string, size: number): void {
	language = languageId;
	tabSize = Number.isFinite(size) && size > 0 ? size : 4;
	const current = state;
	const diffable = Boolean(current && current.reason === 'ready' && !current.truncated);
	reviewData = {
		hunks: current && diffable && !dirty ? current.hunks : [],
		blocked: dirty ? DIRTY_BLOCKED : (current?.blockedReason ?? ''),
		baseline: current && diffable ? current.baseline : '',
		diffable,
		live: diffable && dirty,
	};
	const next = EditorState.create({ doc: text, extensions: extensions() });
	if (view) {
		view.setState(next);
	} else {
		view = new EditorView({ state: next, parent: editorHost });
	}
	if (state) {
		renderBanner(state);
	}
	scrollToFirstChange();
}

function replaceDocument(text: string): void {
	if (!view) {
		return;
	}
	if (view.state.doc.toString() === text) {
		return;
	}
	const scrollTop = view.scrollDOM.scrollTop;
	const selection = view.state.selection.main;
	// The journal's block anchors belong to the old text; the next `state` carries fresh ones. The
	// baseline still holds, so an unsaved buffer repaints against it immediately.
	const previous = reviewData;
	reviewData = {
		hunks: [],
		blocked: dirty ? DIRTY_BLOCKED : (state?.blockedReason ?? ''),
		baseline: previous.baseline,
		diffable: previous.diffable,
		live: previous.diffable && dirty,
	};
	const next = EditorState.create({
		doc: text,
		selection: EditorSelection.single(Math.min(selection.anchor, text.length), Math.min(selection.head, text.length)),
		extensions: extensions(),
	});
	view.setState(next);
	view.scrollDOM.scrollTop = scrollTop;
}

function applyState(next: FileReviewState): void {
	state = next;
	if (!view) {
		// Before the document arrives there is no local editing, so the host's flag is the truth.
		dirty = next.dirty;
	}
	renderHeader(next);
	renderBanner(next);
	if (!view) {
		return;
	}
	updateReview();
}

/* ---------------------------------------------------------------- messages */

window.addEventListener('message', (event: MessageEvent<FileReviewHostMessage>) => {
	const message = event.data;
	if (!message || typeof message !== 'object') {
		return;
	}
	try {
		switch (message.type) {
			case 'document':
				openDocument(message.text, message.languageId, message.tabSize);
				if (state) {
					applyState(state);
				}
				return;
			case 'state':
				applyState(message.state);
				return;
			case 'dirty':
				setDirty(message.dirty);
				return;
			case 'replace':
				replaceDocument(message.text);
				return;
			case 'notice':
				showNotice(message.level, message.text);
				return;
		}
	} catch (error) {
		// A blank editor is worse than a sentence: the failure is shown, not swallowed.
		showNotice('error', `The review view failed to render: ${String(error)}`);
	}
});

openButton.addEventListener('click', () => post({ type: 'openEditor' }));
diffButton.addEventListener('click', () => post({ type: 'openDiff' }));
undoFileButton.addEventListener('click', () => post({ type: 'undoFile' }));
keepFileButton.addEventListener('click', () => post({ type: 'keepFile' }));

post({ type: 'ready' });
