import { fenceFor, inlineCode, wrapTex } from './format.mjs';

/**
 * Selection copy for the chat transcript.
 *
 * The renderer is one-way, so a selected fragment is walked back to Markdown: math hosts carry their
 * TeX in `data-tex`, code blocks become fences, and the surrounding DOM supplies emphasis, links,
 * headings and lists. UI chrome (buttons, timers, tool headers, the code-block header) is skipped.
 * A selection that is wholly inside one formula or one code block is handled without cloning.
 */

const SKIP =
	'button, .msg-actions, .foot, .timer, .chev, .codehead, .card-head, .swipe-step, .swipe-count, .edit-bar, .mention-menu, summary, [hidden], .card.collapsed, .katex, .katex-display, script, style';

const BLOCK = '.turn, .msg, .step-text, .body, .bubble, .line, .think, .notice, .welcome, .command';

export function installCopyHandler() {
	document.addEventListener('copy', (event) => {
		try {
			const markdown = copiedMarkdown();
			if (!markdown || !event.clipboardData) {
				return;
			}
			event.preventDefault();
			event.clipboardData.setData('text/plain', markdown);
		} catch {
			// A detached selection or an unusual DOM leaves the browser's own copy in charge.
		}
	});
}

function copiedMarkdown() {
	const selection = document.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		return null;
	}
	const range = selection.getRangeAt(0);
	if (inField(range.startContainer) || inField(range.endContainer)) {
		return null;
	}
	const messages = document.getElementById('messages');
	if (!messages || !messages.contains(range.startContainer) || !messages.contains(range.endContainer)) {
		return null;
	}
	if (!range.startContainer.isConnected || !range.endContainer.isConnected) {
		return null;
	}
	const startMath = mathHostOf(range.startContainer);
	if (startMath && startMath === mathHostOf(range.endContainer)) {
		return wrapTex(startMath.getAttribute('data-tex'), startMath.classList.contains('math-block')) || null;
	}
	const startPre = preOf(range.startContainer);
	if (startPre && startPre === preOf(range.endContainer)) {
		return startPre.closest('.codeblock') ? fenced(startPre, range.toString()) : range.toString() || null;
	}
	const held = [];
	let text = serializeChildren(range.cloneContents(), held);
	text = text
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/^\n+|\n+$/g, '');
	text = text.replace(/\u0003(\d+)\u0003/g, (_, index) => held[Number(index)]);
	return text.trim() ? text : null;
}

function serializeChildren(node, held) {
	let text = '';
	for (const child of node.childNodes) {
		text += serialize(child, held);
	}
	return text;
}

function serialize(node, held) {
	if (node.nodeType === 3) {
		return node.data;
	}
	if (node.nodeType !== 1) {
		return '';
	}
	if (node.hasAttribute('data-tex')) {
		const math = wrapTex(node.getAttribute('data-tex'), node.classList.contains('math-block'));
		return math ? hold(held, math) + (node.classList.contains('math-block') ? '\n\n' : '') : '';
	}
	if (node.matches(SKIP)) {
		return '';
	}
	const tag = node.tagName;
	if (tag === 'BR') {
		return '\n';
	}
	if (tag === 'HR') {
		return '\n---\n';
	}
	if (tag === 'PRE') {
		return serializePre(node, held);
	}
	if (tag === 'A') {
		const url = node.getAttribute('data-url') || '';
		const label = serializeChildren(node, held);
		if (!url) {
			return label;
		}
		return label.trim() && label.trim() !== url ? `[${label}](${url})` : url;
	}
	if (tag === 'TABLE') {
		return serializeTable(node, held);
	}
	const inner = serializeChildren(node, held);
	if (tag === 'STRONG' || tag === 'B') {
		return inner.trim() ? `**${inner}**` : inner;
	}
	if (tag === 'EM' || tag === 'I') {
		return inner.trim() ? `*${inner}*` : inner;
	}
	if (tag === 'DEL' || tag === 'S') {
		return inner.trim() ? `~~${inner}~~` : inner;
	}
	if (tag === 'CODE' && !node.closest('pre')) {
		return inlineCode(node.textContent || '');
	}
	if (/^H[1-6]$/.test(tag)) {
		const line = inner.replace(/\n+/g, ' ').trim();
		return line ? `${'#'.repeat(Number(tag[1]))} ${line}\n\n` : '';
	}
	if (tag === 'P') {
		return inner.trim() ? `${inner.replace(/\n+$/, '')}\n\n` : '';
	}
	if (tag === 'BLOCKQUOTE') {
		const body = inner.replace(/\n+$/, '');
		return body.trim() ? `> ${body.replace(/\n/g, '\n> ')}\n\n` : '';
	}
	if (tag === 'LI') {
		const ordered = node.parentElement && node.parentElement.tagName === 'OL';
		const marker = ordered ? `${[...node.parentElement.children].indexOf(node) + 1}. ` : '- ';
		const body = inner.replace(/\n+$/, '');
		return body.trim() ? `${marker}${body}\n` : '';
	}
	if (tag === 'UL' || tag === 'OL') {
		return inner.replace(/\n*$/, '\n');
	}
	if (node.matches(BLOCK)) {
		return inner.replace(/\n+$/, '') + '\n\n';
	}
	return inner;
}

function serializePre(pre, held) {
	if (!pre.closest('.codeblock') && pre.dataset.lang === undefined) {
		const code = pre.textContent || '';
		return hold(held, code.endsWith('\n') ? code : `${code}\n`);
	}
	return hold(held, `${fenced(pre, pre.textContent || '')}\n\n`);
}

function fenced(pre, code) {
	const body = code.replace(/\n$/, '');
	const lang = pre.dataset.lang || pre.closest('.codeblock')?.querySelector('.codehead span')?.textContent || '';
	const fence = fenceFor(body);
	return `${fence}${lang}\n${body}\n${fence}`;
}

function serializeTable(table, held) {
	const rows = [...table.querySelectorAll('tr')];
	if (!rows.length) {
		return '';
	}
	const cells = (row) =>
		[...row.children].map((cell) =>
			serializeChildren(cell, held)
				.trim()
				.replace(/\n+/g, ' '),
		);
	const lines = rows.map((row) => `| ${cells(row).join(' | ')} |`);
	if (rows[0].querySelector('th')) {
		lines.splice(1, 0, `| ${cells(rows[0]).map(() => '---').join(' | ')} |`);
	}
	return `${lines.join('\n')}\n\n`;
}

function hold(held, value) {
	held.push(value);
	return `\u0003${held.length - 1}\u0003`;
}

function mathHostOf(node) {
	const element = node?.nodeType === 1 ? node : node?.parentElement;
	return element?.closest?.('[data-tex]') ?? null;
}

function preOf(node) {
	const element = node?.nodeType === 1 ? node : node?.parentElement;
	return element?.closest?.('pre') ?? null;
}

function inField(node) {
	const element = node?.nodeType === 1 ? node : node?.parentElement;
	return Boolean(element?.closest?.('textarea, input, [contenteditable]'));
}
