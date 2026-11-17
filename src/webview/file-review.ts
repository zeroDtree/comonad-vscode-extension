// SPDX-License-Identifier: AGPL-3.0-only
import { EditorState, StateField, type Extension, type Text } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	WidgetType,
	drawSelection,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
	type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { unifiedMergeView } from '@codemirror/merge';
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
import type { FileHunkView, FileReviewGuestMessage, FileReviewHostMessage, FileReviewState } from '../lib/file-review-protocol';

/**
 * The File Review tab's guest: a whole file in a CodeMirror editor whose deletions are drawn in
 * place by the unified merge view — real rows, wrapping like the rest of the file, rather than the
 * single-line chip an editor decoration is limited to. Every block gets its own Undo/Keep bar,
 * named by the journal's hunk key; the host owns the writes and sends the state back.
 *
 * The editor is read-only on purpose: the journal reviews saved content, and edits belong in the
 * real file, one button away.
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
let noticeTimer: number | undefined;
/** The file the editor last showed, so a switch can reveal its first change instead of the top. */
let shownPath = '';

/** The value the open tabs' theme is drawn with, read once: webviews reload on a theme change. */
const dark = (() => {
	const kind = document.body.dataset.vscodeThemeKind ?? '';
	return kind === 'vscode-dark' || kind === 'vscode-high-contrast' || document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
})();

/* ---------------------------------------------------------------- languages */

const modeFor = (parser: Parameters<typeof StreamLanguage.define>[0]): Extension => StreamLanguage.define(parser);

/** What to highlight by, from the file's name: the same common set the chat's highlighter covers. */
function languageFor(path: string): Extension | undefined {
	const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
	const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
	if (base === 'dockerfile') {
		return modeFor(dockerMode);
	}
	if (base === 'gemfile' || base === 'rakefile') {
		return modeFor(rubyMode);
	}
	switch (ext) {
		case 'py':
		case 'pyi':
		case 'pyw':
			return modeFor(pythonMode);
		case 'pyx':
			return modeFor(cythonMode);
		case 'js':
		case 'mjs':
		case 'cjs':
		case 'jsx':
			return modeFor(javascriptMode);
		case 'ts':
		case 'mts':
		case 'cts':
		case 'tsx':
			return modeFor(typescriptMode);
		case 'json':
		case 'jsonc':
		case 'json5':
			return modeFor(jsonMode);
		case 'sh':
		case 'bash':
		case 'zsh':
		case 'ksh':
			return modeFor(shellMode);
		case 'c':
		case 'h':
			return modeFor(cMode);
		case 'cc':
		case 'cpp':
		case 'cxx':
		case 'hpp':
		case 'hh':
		case 'hxx':
			return modeFor(cppMode);
		case 'cs':
			return modeFor(csharpMode);
		case 'java':
			return modeFor(javaMode);
		case 'kt':
		case 'kts':
			return modeFor(kotlinMode);
		case 'scala':
		case 'sc':
			return modeFor(scalaMode);
		case 'dart':
			return modeFor(dartMode);
		case 'go':
			return modeFor(goMode);
		case 'rs':
			return modeFor(rustMode);
		case 'rb':
		case 'rake':
			return modeFor(rubyMode);
		case 'pl':
		case 'pm':
			return modeFor(perlMode);
		case 'lua':
			return modeFor(luaMode);
		case 'swift':
			return modeFor(swiftMode);
		case 'r':
			return modeFor(rMode);
		case 'jl':
			return modeFor(juliaMode);
		case 'hs':
			return modeFor(haskellMode);
		case 'sql':
			return modeFor(sqlMode);
		case 'yaml':
		case 'yml':
			return modeFor(yamlMode);
		case 'toml':
			return modeFor(tomlMode);
		case 'xml':
		case 'svg':
		case 'plist':
			return modeFor(xmlMode);
		case 'html':
		case 'htm':
			return modeFor(htmlMode);
		case 'css':
			return modeFor(cssMode);
		case 'scss':
			return modeFor(scssMode);
		case 'less':
			return modeFor(lessMode);
		case 'diff':
		case 'patch':
			return modeFor(diffMode);
		case 'ps1':
		case 'psm1':
			return modeFor(powershellMode);
		default:
			return undefined;
	}
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
		// The bar lives inside the editor's content; the editor must not swallow the click.
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

/**
 * The bars are placed from the host's hunks, not from the merge view's chunks: Keep/Undo must name
 * exactly the block the journal will revalidate, and the two diff implementations are allowed to
 * disagree about where a block starts.
 *
 * A state field, not a view plugin: a block widget takes vertical space, and CodeMirror only lets
 * the layout-affecting decorations come from the state.
 */
function hunkBarField(hunks: readonly FileHunkView[], blocked: string): Extension {
	const build = (doc: Text): DecorationSet => {
		const ranges = [];
		for (const hunk of hunks) {
			const at = hunk.anchorLine >= doc.lines ? doc.length : doc.line(Math.max(0, hunk.anchorLine) + 1).from;
			// `side: -1` attaches the bar to the line that follows it, so the gutter's line numbers
			// stay aligned with their lines; `side: 1` counts the bar's height against the line above.
			// At the document's very end there is no following line, and `1` puts the bar after a
			// removal widget at the same position — below the deleted lines, where the other bars sit.
			ranges.push(Decoration.widget({ widget: new HunkBar(hunk, blocked), block: true, side: at === doc.length ? 1 : -1 }).range(at));
		}
		return Decoration.set(ranges, true);
	};
	const field = StateField.define<DecorationSet>({
		create: (state) => build(state.doc),
		update: (decorations, transaction) => (transaction.docChanged ? build(transaction.state.doc) : decorations),
		provide: (value) => EditorView.decorations.from(value),
	});
	return field;
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
	if (current.dirty) {
		badge('Unsaved', 'dirty');
	}
	if (current.truncated) {
		badge('Large', '', 'Too large or too different to diff block by block; the file is shown as it is on disk.');
	}

	const usable = current.reason === 'ready' || current.reason === 'binary' || current.reason === 'too-large';
	openButton.disabled = !usable || current.deleted || current.reason === 'no-pending';
	openButton.title = current.deleted ? 'The file is deleted' : 'Open the file in the editor';
	diffButton.disabled = !usable || current.deleted;
	diffButton.title = current.deleted ? 'The file is deleted' : 'Open the baseline diff';
	const fileActionBlocked = current.dirty;
	undoFileButton.disabled = !usable || fileActionBlocked;
	undoFileButton.title = fileActionBlocked ? 'Save the file first' : 'Restore the accepted baseline';
	keepFileButton.disabled = !usable || fileActionBlocked;
	keepFileButton.title = fileActionBlocked ? 'Save the file first' : 'Accept this file as it is now';
}

function showEmpty(message: string): void {
	empty.hidden = false;
	empty.replaceChildren();
	const title = document.createElement('div');
	title.className = 'fr-empty-title';
	title.textContent = message;
	empty.append(title);
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

/** The extensions of one render; a new state means new hunks and possibly a new language. */
function extensionsFor(current: FileReviewState): Extension[] {
	const extensions: Extension[] = [
		lineNumbers(),
		highlightActiveLine(),
		highlightActiveLineGutter(),
		drawSelection(),
		EditorView.lineWrapping,
		EditorView.editable.of(false),
		EditorState.readOnly.of(true),
		keymap.of([...searchKeymap, ...defaultKeymap]),
		search({ top: true }),
		syntaxHighlighting(highlight),
		theme,
		hunkBarField(current.hunks, current.blockedReason),
	];
	const language = languageFor(current.path);
	if (language) {
		extensions.push(language);
	}
	// A truncated diff is a whole-file fallback: showing the file is still useful, pretending it is
	// a readable inline diff is not.
	if (!current.truncated) {
		extensions.push(
			unifiedMergeView({
				original: current.baseline,
				mergeControls: false,
				highlightChanges: true,
				gutter: true,
				syntaxHighlightDeletions: true,
				allowInlineDiffs: false,
			}),
		);
	}
	return extensions;
}

function render(current: FileReviewState): void {
	renderHeader(current);
	if (current.reason !== 'ready') {
		empty.hidden = false;
		// The next ready state is a fresh view even for the same path: the editor was cleared here.
		shownPath = '';
		view?.setState(EditorState.create({ doc: '', extensions: [] }));
		showEmpty(current.message || 'Nothing to review');
		return;
	}
	empty.hidden = true;
	const freshFile = view === null || current.path !== shownPath;
	shownPath = current.path;
	const scrollTop = view?.scrollDOM.scrollTop ?? 0;
	const next = EditorState.create({ doc: current.current, extensions: extensionsFor(current) });
	const editor = view ?? new EditorView({ state: next, parent: editorHost });
	if (!view) {
		view = editor;
	} else {
		view.setState(next);
		view.scrollDOM.scrollTop = scrollTop;
		// setState re-lays the document out; restoring after a frame keeps the reader's place.
		requestAnimationFrame(() => {
			if (view && !freshFile) {
				view.scrollDOM.scrollTop = scrollTop;
			}
		});
	}
	// A review opens at its first change, not at line 1: the change can be thousands of lines down,
	// and a top-of-file view reads as "nothing changed". Later refreshes keep the reader's place.
	if (freshFile) {
		const first = current.hunks[0];
		if (first) {
			const line = first.newLines > 0 ? first.newStart - 1 : first.newStart;
			const target = editor.state.doc.line(Math.max(0, Math.min(editor.state.doc.lines - 1, line)) + 1).from;
			editor.dispatch({ effects: EditorView.scrollIntoView(target, { y: 'center' }) });
		}
	}
}

/* ---------------------------------------------------------------- messages */

window.addEventListener('message', (event: MessageEvent<FileReviewHostMessage>) => {
	const message = event.data;
	if (!message || typeof message !== 'object') {
		return;
	}
	if (message.type === 'state') {
		// Remember the file so a reloaded window restores this tab on the same path.
		vscode.setState({ path: message.state.path });
		try {
			render(message.state);
		} catch (error) {
			// A blank editor is worse than a sentence: the failure is shown, not swallowed.
			showNotice('error', `The review view failed to render: ${String(error)}`);
		}
		return;
	}
	if (message.type === 'notice') {
		showNotice(message.level, message.text);
	}
});

openButton.addEventListener('click', () => post({ type: 'openFile' }));
diffButton.addEventListener('click', () => post({ type: 'openDiff' }));
undoFileButton.addEventListener('click', () => post({ type: 'undoFile' }));
keepFileButton.addEventListener('click', () => post({ type: 'keepFile' }));

post({ type: 'ready' });
