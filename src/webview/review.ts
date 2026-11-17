// SPDX-License-Identifier: AGPL-3.0-only
import type { ReviewBlock, ReviewFileSummary, ReviewFileView, ReviewGuestMessage, ReviewHostMessage, ReviewRow, ReviewState } from '../lib/review-protocol';

/**
 * The Review tab's guest. The host sends one whole state; this file draws it and posts clicks back
 * with a path and a hunk key. Journal data never reaches `innerHTML`: rows, paths and the hunk header
 * are built with `textContent`, and the key lives in a data attribute.
 */

declare function acquireVsCodeApi(): {
	postMessage(message: ReviewGuestMessage): void;
	getState(): unknown;
	setState(state: unknown): void;
};

interface SavedState {
	path?: string;
	scrollTop?: number;
	wrap?: boolean;
	sidebar?: boolean;
}

const vscode = acquireVsCodeApi();
const post = (message: ReviewGuestMessage): void => vscode.postMessage(message);

function byId<T extends HTMLElement>(id: string): T {
	const element = document.getElementById(id);
	if (!element) {
		throw new Error(`missing #${id}`);
	}
	return element as T;
}

const summary = byId<HTMLDivElement>('rv-summary');
const filesToggle = byId<HTMLButtonElement>('rv-files-toggle');
const wrapButton = byId<HTMLButtonElement>('rv-wrap');
const keepAll = byId<HTMLButtonElement>('rv-keep-all');
const undoAll = byId<HTMLButtonElement>('rv-undo-all');
const filesTitle = byId<HTMLSpanElement>('rv-files-title');
const filesCount = byId<HTMLSpanElement>('rv-files-count');
const fileList = byId<HTMLDivElement>('rv-file-list');
const main = byId<HTMLElement>('rv-main');
const fileHead = byId<HTMLDivElement>('rv-file-head');
const prev = byId<HTMLButtonElement>('rv-prev');
const next = byId<HTMLButtonElement>('rv-next');
const pathButton = byId<HTMLButtonElement>('rv-path');
const badges = byId<HTMLSpanElement>('rv-badges');
const openDiff = byId<HTMLButtonElement>('rv-open-diff');
const undoFile = byId<HTMLButtonElement>('rv-undo-file');
const keepFile = byId<HTMLButtonElement>('rv-keep-file');
const empty = byId<HTMLDivElement>('rv-empty');
const hunks = byId<HTMLDivElement>('rv-hunks');
const note = byId<HTMLDivElement>('rv-note');
const notice = byId<HTMLDivElement>('rv-notice');

let state: ReviewState | null = null;
let dirtyPaths = new Set<string>();
let busy = false;
let noticeTimer: number | undefined;
let lastPath: string | null = null;
const savedAtStart = vscode.getState() as SavedState | undefined;
/** `undefined` means "follow the file type": prose wraps, code scrolls, until the reader decides. */
let wrapOverride = savedAtStart?.wrap;
let sidebar = savedAtStart?.sidebar !== false;

const prose = (path: string | null): boolean => Boolean(path && /\.(md|markdown|mdx|txt|rst)$/i.test(path));

const isDirty = (file: ReviewFileSummary): boolean => file.dirty || dirtyPaths.has(file.path);

/** Why a block cannot be acted on, or the empty string when it can. */
function blockReason(file: ReviewFileView): string {
	if (isDirty(file)) {
		return 'Save the file first';
	}
	if (file.changedOutside) {
		return 'Changed outside the agent';
	}
	if (file.binary) {
		return 'Binary file';
	}
	if (file.truncated) {
		return 'Too large for block actions';
	}
	return '';
}

function element(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

function showNotice(level: 'info' | 'warn' | 'error', text: string): void {
	notice.hidden = false;
	notice.className = `rv-notice rv-notice-${level}`;
	notice.textContent = text;
	clearTimeout(noticeTimer);
	if (level !== 'error') {
		noticeTimer = window.setTimeout(() => {
			notice.hidden = true;
		}, 6000);
	}
}

function hideNotice(): void {
	clearTimeout(noticeTimer);
	notice.hidden = true;
}

/** Post an action that changes the journal, and keep the buttons still until the answer lands. */
function act(message: ReviewGuestMessage): void {
	if (busy) {
		return;
	}
	busy = true;
	hideNotice();
	render();
	post(message);
}

function renderSummary(current: ReviewState): void {
	summary.replaceChildren();
	if (!current.totals.files) {
		return;
	}
	summary.append(element('span', 'rv-count', `${current.totals.files} ${current.totals.files === 1 ? 'file' : 'files'} changed`));
	if (current.totals.additions) {
		summary.append(element('span', 'rv-stat-add', `+${current.totals.additions}`));
	}
	if (current.totals.deletions) {
		summary.append(element('span', 'rv-stat-del', `−${current.totals.deletions}`));
	}
}

function fileFlags(file: ReviewFileSummary): string {
	const flags = [
		isDirty(file) ? 'Unsaved' : '',
		file.changedOutside ? 'Changed outside' : '',
	];
	return flags.filter(Boolean).join(' · ');
}

function renderFiles(current: ReviewState): void {
	fileList.replaceChildren();
	filesTitle.textContent = 'Files';
	filesCount.textContent = String(current.files.length);
	if (!current.files.length) {
		fileList.append(element('div', 'rv-files-empty', 'No pending files.'));
		return;
	}
	const fragment = document.createDocumentFragment();
	for (const file of current.files) {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'rv-file';
		if (file.path === current.activePath) {
			row.classList.add('is-active');
			row.setAttribute('aria-current', 'true');
		}
		row.dataset.path = file.path;
		const kind = element('span', `rv-kind ${file.deleted ? 'deleted' : file.created ? 'created' : 'changed'}`, file.deleted ? 'D' : file.created ? 'A' : 'M');
		const path = element('span', 'rv-path', file.path);
		const flags = fileFlags(file);
		const flag = element('span', 'rv-flag', flags ? '!' : '');
		if (flags) {
			flag.title = flags;
		} else {
			flag.hidden = true;
		}
		const stats = element('span', 'rv-stats');
		if (file.additions) {
			stats.append(element('span', 'rv-stat-add', `+${file.additions}`));
		}
		if (file.deletions) {
			stats.append(element('span', 'rv-stat-del', `−${file.deletions}`));
		}
		if (!stats.childElementCount) {
			stats.append(element('span', 'rv-muted', 'no line changes'));
		}
		row.append(kind, path, flag, stats);
		row.addEventListener('click', () => {
			if (!busy && current.activePath !== file.path) {
				post({ type: 'selectFile', path: file.path });
			}
		});
		fragment.append(row);
	}
	fileList.append(fragment);
}

function renderLine(row: ReviewRow, path: string, deleted: boolean): HTMLElement {
	const line = element('div', `rv-row rv-${row.kind}`);
	const oldNo = element(row.oldLine === null ? 'span' : 'button', 'rv-ln rv-ln-old', row.oldLine === null ? '' : String(row.oldLine));
	const newNo = element(row.newLine === null ? 'span' : 'button', 'rv-ln rv-ln-new', row.newLine === null ? '' : String(row.newLine));
	for (const cell of [oldNo, newNo]) {
		if (cell instanceof HTMLButtonElement) {
			cell.type = 'button';
			if (deleted || row.targetLine === null) {
				cell.disabled = true;
			} else {
				cell.title = `Open at line ${row.targetLine}`;
				cell.addEventListener('click', () => post({ type: 'openFile', path, line: row.targetLine ?? undefined }));
			}
		}
	}
	const mark = element('span', 'rv-mark', row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : '');
	const code = element('span', 'rv-code', row.text);
	line.append(oldNo, newNo, mark, code);
	return line;
}

function renderRows(rows: ReviewRow[], target: HTMLElement, path: string, deleted: boolean): void {
	const fragment = document.createDocumentFragment();
	for (const row of rows) {
		fragment.append(renderLine(row, path, deleted));
	}
	target.append(fragment);
}

function renderBlock(block: ReviewBlock, file: ReviewFileView): HTMLElement {
	if (block.kind === 'gap') {
		return element('div', 'rv-gap', `⋯ ${block.omitted} unchanged ${block.omitted === 1 ? 'line' : 'lines'}`);
	}
	if (block.kind === 'context') {
		const section = element('div', 'rv-context');
		renderRows(block.rows, section, file.path, file.deleted);
		return section;
	}
	const section = element('section', 'rv-hunk');
	section.dataset.key = block.key;
	const head = element('header', 'rv-hunk-head');
	head.append(element('span', 'rv-hunk-range', block.header));
	const actions = element('span', 'rv-hunk-actions');
	const reason = blockReason(file);
	const undo = element('button', 'rv-ghost', 'Undo') as HTMLButtonElement;
	undo.type = 'button';
	undo.disabled = busy || Boolean(reason);
	undo.title = reason || 'Restore this block to the baseline';
	undo.addEventListener('click', () => act({ type: 'undoHunk', path: file.path, hunk: block.key }));
	const keep = element('button', 'rv-primary', 'Keep') as HTMLButtonElement;
	keep.type = 'button';
	keep.disabled = busy || Boolean(reason);
	keep.title = reason || 'Accept this block into the baseline';
	keep.addEventListener('click', () => act({ type: 'keepHunk', path: file.path, hunk: block.key }));
	actions.append(undo, keep);
	head.append(actions);
	section.append(head);
	renderRows(block.rows, section, file.path, file.deleted);
	return section;
}

function renderFileHead(current: ReviewState, file: ReviewFileView): void {
	fileHead.hidden = false;
	const index = current.files.findIndex((candidate) => candidate.path === file.path);
	prev.disabled = busy || index <= 0;
	next.disabled = busy || index < 0 || index >= current.files.length - 1;
	pathButton.disabled = busy || file.deleted;
	pathButton.textContent = file.path;
	pathButton.title = file.deleted ? 'The file is deleted' : 'Open the file';
	badges.replaceChildren();
	if (file.created) {
		badges.append(element('span', 'rv-badge created', 'Added'));
	}
	if (file.deleted) {
		badges.append(element('span', 'rv-badge deleted', 'Deleted'));
	}
	if (file.changedOutside) {
		badges.append(element('span', 'rv-badge outside', 'Changed outside'));
	}
	if (isDirty(file)) {
		badges.append(element('span', 'rv-badge dirty', 'Unsaved'));
	}
	if (file.binary) {
		badges.append(element('span', 'rv-badge', 'Binary'));
	}
	if (file.truncated) {
		badges.append(element('span', 'rv-badge', 'Large'));
	}
	const dirty = isDirty(file);
	undoFile.disabled = busy || dirty;
	undoFile.title = dirty ? 'Save the file first' : 'Restore the accepted baseline';
	keepFile.disabled = busy || dirty;
	keepFile.title = dirty ? 'Save the file first' : 'Accept this file as it is now';
	openDiff.hidden = !file.binary && !file.truncated && !file.more;
	openDiff.disabled = busy || file.deleted;
}

function renderEmpty(current: ReviewState): void {
	fileHead.hidden = true;
	empty.hidden = false;
	empty.replaceChildren();
	if (current.activeError) {
		empty.append(element('div', 'rv-empty-title', 'The file could not be read'));
		empty.append(element('div', 'rv-empty-body', current.activeError));
		if (current.activePath) {
			empty.append(element('div', 'rv-empty-body rv-muted', current.activePath));
		}
		return;
	}
	empty.append(element('div', 'rv-empty-title', current.reason === 'error' ? 'The journal could not be read' : current.message || 'Nothing to review'));
	if (current.reason === 'error' && current.message) {
		empty.append(element('div', 'rv-empty-body', current.message));
	}
	if (current.reason === 'no-changes' || current.reason === 'ready') {
		empty.append(element('div', 'rv-empty-body rv-muted', current.note));
	}
}

/** The gutter is two columns wide enough for the file's largest line number, plus a divider. */
function setGutter(file: ReviewFileView): void {
	let maxLine = 1;
	for (const block of file.blocks) {
		if (block.kind === 'gap') {
			continue;
		}
		for (const row of block.rows) {
			maxLine = Math.max(maxLine, row.oldLine ?? 0, row.newLine ?? 0);
		}
	}
	hunks.style.setProperty('--rv-gutter', `calc(${String(maxLine).length}ch + 16px)`);
}

function renderMain(current: ReviewState): void {
	const active = current.active;
	if (!active) {
		hunks.replaceChildren();
		renderEmpty(current);
		return;
	}
	empty.hidden = true;
	renderFileHead(current, active);
	setGutter(active);
	hunks.replaceChildren();
	if (active.binary) {
		hunks.append(element('div', 'rv-empty-inline', 'Binary file — use Keep File or Undo File; Open Diff shows it side by side with the baseline.'));
	} else if (active.truncated) {
		hunks.append(element('div', 'rv-empty-inline', 'This file is too large to review block by block. Open Diff shows the whole change.'));
	} else if (!active.blocks.length) {
		hunks.append(element('div', 'rv-empty-inline', 'No line changes to show.'));
	} else {
		const fragment = document.createDocumentFragment();
		for (const block of active.blocks) {
			fragment.append(renderBlock(block, active));
		}
		hunks.append(fragment);
	}
	if (active.more > 0) {
		hunks.append(element('div', 'rv-more', `${active.more} more change${active.more === 1 ? '' : 's'} — open the file's diff`));
	}
}

function render(): void {
	if (!state) {
		return;
	}
	const saved = vscode.getState() as SavedState | undefined;
	const sameFile = state.activePath === lastPath;
	const scrollTop = main.scrollTop;
	renderSummary(state);
	renderFiles(state);
	renderMain(state);
	note.textContent = state.note;
	keepAll.disabled = busy || !state.files.length || state.files.some((file) => isDirty(file));
	undoAll.disabled = busy || !state.files.length || state.files.some((file) => isDirty(file));
	keepAll.title = state.files.some((file) => isDirty(file)) ? 'Save unsaved files first' : 'Accept every pending file as it is now';
	undoAll.title = state.files.some((file) => isDirty(file)) ? 'Save unsaved files first' : 'Restore every pending file to the accepted baseline';
	if (saved?.path === state.activePath && typeof saved.scrollTop === 'number') {
		main.scrollTop = saved.scrollTop;
	} else {
		main.scrollTop = sameFile ? scrollTop : 0;
	}
	lastPath = state.activePath;
	// A new active file may be prose or code; follow it until the reader overrides the choice.
	applyWrap();
}

function applyWrap(): void {
	const enabled = wrapOverride ?? prose(state?.activePath ?? null);
	document.body.classList.toggle('rv-wrap', enabled);
	wrapButton.setAttribute('aria-pressed', String(enabled));
	wrapButton.classList.toggle('is-active', enabled);
	const saved = (vscode.getState() as SavedState | undefined) ?? {};
	vscode.setState({ ...saved, wrap: wrapOverride } satisfies SavedState);
}

function applySidebar(): void {
	document.body.classList.toggle('rv-sidebar-hidden', !sidebar);
	filesToggle.textContent = sidebar ? 'Files ▾' : 'Files ▸';
	filesToggle.setAttribute('aria-pressed', String(sidebar));
	const saved = (vscode.getState() as SavedState | undefined) ?? {};
	vscode.setState({ ...saved, sidebar } satisfies SavedState);
}

wrapButton.addEventListener('click', () => {
	wrapOverride = !(wrapOverride ?? prose(state?.activePath ?? null));
	applyWrap();
});
filesToggle.addEventListener('click', () => {
	sidebar = !sidebar;
	applySidebar();
});
keepAll.addEventListener('click', () => act({ type: 'keepAll' }));
undoAll.addEventListener('click', () => act({ type: 'undoAll' }));
undoFile.addEventListener('click', () => {
	if (state?.activePath) {
		act({ type: 'undoFile', path: state.activePath });
	}
});
keepFile.addEventListener('click', () => {
	if (state?.activePath) {
		act({ type: 'keepFile', path: state.activePath });
	}
});
openDiff.addEventListener('click', () => {
	if (state?.activePath) {
		post({ type: 'openDiff', path: state.activePath });
	}
});
pathButton.addEventListener('click', () => {
	if (!state?.activePath || !state.active) {
		return;
	}
	const first = state.active.blocks.find((block): block is Extract<ReviewBlock, { kind: 'hunk' }> => block.kind === 'hunk');
	post({ type: 'openFile', path: state.activePath, line: first?.targetLine });
});
const step = (delta: number): void => {
	const current = state;
	if (!current?.activePath) {
		return;
	}
	const index = current.files.findIndex((file) => file.path === current.activePath);
	const wanted = current.files[index + delta];
	if (wanted) {
		post({ type: 'selectFile', path: wanted.path });
	}
};
prev.addEventListener('click', () => step(-1));
next.addEventListener('click', () => step(1));
main.addEventListener('scroll', () => {
	if (state?.activePath) {
		vscode.setState({ path: state.activePath, scrollTop: main.scrollTop, wrap: wrapOverride, sidebar } satisfies SavedState);
	}
});

window.addEventListener('message', (event: MessageEvent<ReviewHostMessage>) => {
	const message = event.data;
	if (message.type === 'state') {
		state = message.state;
		busy = false;
		dirtyPaths = new Set();
		render();
		return;
	}
	if (message.type === 'dirty') {
		dirtyPaths = new Set(message.paths);
		if (state) {
			render();
		}
		return;
	}
	busy = false;
	showNotice(message.level, message.text);
	render();
});

applySidebar();
applyWrap();
post({ type: 'ready' });
