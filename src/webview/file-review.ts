// SPDX-License-Identifier: AGPL-3.0-only
import { ChangeSet, Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
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
import { getOriginalDoc, originalDocChangeEffect, unifiedMergeView } from '@codemirror/merge';
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
import type { FileHunkView, FileReviewChange, FileReviewGuestMessage, FileReviewHostMessage, FileReviewState } from '../lib/file-review-protocol';

/**
 * The File Review editor's guest: a whole file in an editable CodeMirror view whose deletions are
 * drawn in place by the unified merge view — real rows, wrapping like the rest of the file, rather
 * than the single-line chip an editor decoration is limited to. Every block gets its own Undo/Keep
 * bar, named by the journal's hunk key; the host owns the document and applies the edits.
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
/** The merge view is a compartment: it appears and disappears with the pending diff. */
const merge = new Compartment();
let mergeOn = false;
let baseline = '';

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
		// The unified merge view draws an inserted line green and a removed block red, and the removed
		// lines are ordinary rows: they wrap, select and scroll with the rest of the file.
		'.cm-changedLine': { backgroundColor: 'var(--vscode-diffEditor-insertedLineBackground, rgba(46, 160, 67, 0.2))' },
		'.cm-changedText': { backgroundColor: 'var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, 0.4))' },
		'.cm-deletedChunk': {
			backgroundColor: 'var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, 0.2))',
			whiteSpace: 'pre-wrap',
			overflowWrap: 'anywhere',
		},
		'.cm-deletedChunk .cm-deletedText': { backgroundColor: 'var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.4))' },
		'.cm-deletedLineGutter': { backgroundColor: 'var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, 0.9))' },
		'.cm-changedLineGutter': { backgroundColor: 'var(--vscode-diffEditor-insertedLineBackground, rgba(46, 160, 67, 0.9))' },
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

interface BarData {
	hunks: readonly FileHunkView[];
	blocked: string;
}

const setBars = StateEffect.define<BarData>();
/** The hunks the next state is built with; a state effect replaces them in place. */
let barData: BarData = { hunks: [], blocked: '' };

function buildBars(doc: Text, data: BarData): DecorationSet {
	if (!data.hunks.length) {
		return Decoration.none;
	}
	const ranges = [];
	for (const hunk of data.hunks) {
		const at = hunk.anchorLine >= doc.lines ? doc.length : doc.line(Math.max(0, hunk.anchorLine) + 1).from;
		// `side: -1` attaches the bar to the line that follows it, so the gutter's line numbers stay
		// aligned; `side: 1` puts an end-of-document bar below a removal widget at the same position.
		ranges.push(Decoration.widget({ widget: new HunkBar(hunk, data.blocked), block: true, side: at === doc.length ? 1 : -1 }).range(at));
	}
	return Decoration.set(ranges, true);
}

/**
 * A state field, not a view plugin: a block widget takes vertical space, and CodeMirror only lets
 * layout-affecting decorations come from the state. The journal's line numbers are only valid for
 * the text the host computed them from, so any local edit drops the bars until the save delivers
 * fresh hunks.
 */
const barField = StateField.define<DecorationSet>({
	create: (editor) => buildBars(editor.doc, barData),
	update: (decorations, transaction) => {
		let next: BarData | null = null;
		for (const effect of transaction.effects) {
			if (effect.is(setBars)) {
				next = effect.value;
			}
		}
		if (next) {
			barData = next;
			return buildBars(transaction.state.doc, next);
		}
		return transaction.docChanged ? Decoration.none : decorations;
	},
	provide: (field) => EditorView.decorations.from(field),
});

function updateBars(): void {
	if (!view) {
		return;
	}
	const hunks = !dirty && state?.reason === 'ready' && !state.truncated ? state.hunks : [];
	view.dispatch({ effects: setBars.of({ hunks, blocked: state?.blockedReason ?? '' }) });
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
	openButton.title = 'Open the file in VS Code’s own editor';
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
	updateBars();
}

function mergeExtensions(original: string): Extension {
	return unifiedMergeView({
		original,
		mergeControls: false,
		highlightChanges: true,
		gutter: true,
		syntaxHighlightDeletions: true,
		allowInlineDiffs: false,
	});
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
		barField,
		merge.of(mergeOn ? mergeExtensions(baseline) : []),
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
	const wantsMerge = state?.reason === 'ready' && !state.truncated;
	mergeOn = wantsMerge;
	baseline = wantsMerge ? (state?.baseline ?? '') : '';
	barData = {
		hunks: wantsMerge && !dirty ? (state?.hunks ?? []) : [],
		blocked: state?.blockedReason ?? '',
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
	// The journal's block anchors belong to the old text; the next `state` carries fresh ones.
	barData = { hunks: [], blocked: state?.blockedReason ?? '' };
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
	const wantsMerge = next.reason === 'ready' && !next.truncated;
	if (wantsMerge && !mergeOn) {
		mergeOn = true;
		baseline = next.baseline;
		view.dispatch({ effects: merge.reconfigure(mergeExtensions(baseline)) });
	} else if (!wantsMerge && mergeOn) {
		mergeOn = false;
		baseline = '';
		view.dispatch({ effects: merge.reconfigure([]) });
	} else if (wantsMerge && next.baseline !== baseline) {
		// Reconfiguring the compartment would not re-run the merge field's init; the original doc is
		// updated through the effect the merge view provides.
		const original = getOriginalDoc(view.state);
		const changes = ChangeSet.of([{ from: 0, to: original.length, insert: next.baseline }], original.length);
		baseline = next.baseline;
		view.dispatch({ effects: originalDocChangeEffect(view.state, changes) });
	}
	updateBars();
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

openButton.addEventListener('click', () => post({ type: 'openText' }));
diffButton.addEventListener('click', () => post({ type: 'openDiff' }));
undoFileButton.addEventListener('click', () => post({ type: 'undoFile' }));
keepFileButton.addEventListener('click', () => post({ type: 'keepFile' }));

post({ type: 'ready' });
