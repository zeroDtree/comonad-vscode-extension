// SPDX-License-Identifier: AGPL-3.0-only
import type { MarkdownIt, StateBlock, StateInline, Token } from 'markdown-it';

/**
 * The markdown-it half of the optional math contract. A chat asset loaded before this bundle installs
 * `globalThis.__comonadMath`; this file only decides where a formula starts and ends and wraps the
 * renderer's HTML in the `data-tex` host the source-preserving copy reads. Without the hook every
 * formula stays the literal text the model wrote, and while streaming a formula without its closer
 * stays literal until the closer arrives.
 *
 * The delimiters and the currency guards are the ones the chat's old line renderer used: `$…$` and
 * `\(…\)` are inline, `$$…$$` and `\[…\]` are display, and a lone `$` that looks like money is text.
 */

const esc = (s: string): string =>
	String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface MathApi {
	render?: (tex: string, display: boolean) => unknown;
}

function mathRender(tex: string, display: boolean): string | null {
	try {
		const api = (globalThis as { __comonadMath?: MathApi }).__comonadMath;
		if (!api || typeof api.render !== 'function') {
			return null;
		}
		const html = api.render(String(tex), Boolean(display));
		return typeof html === 'string' && html ? html : null;
	} catch {
		return null;
	}
}

function mathHost(tex: string, display: boolean): string | null {
	const html = mathRender(tex, display);
	if (!html) {
		return null;
	}
	return '<span class="' + (display ? 'math-block' : 'math-inline') + '" data-tex="' + esc(tex) + '">' + html + '</span>';
}

/** Whether the delimiter at `index` is escaped by an odd run of backslashes. */
function escapedAt(text: string, index: number): boolean {
	let count = 0;
	while (index - 1 - count >= 0 && text[index - 1 - count] === '\\') {
		count += 1;
	}
	return count % 2 === 1;
}

/** The first unescaped `close` at or after `from`, ignoring anything at or past `max`. */
function findClose(text: string, from: number, close: string, max: number): number {
	const limit = Math.min(max, text.length) - close.length;
	for (let index = from; index <= limit; index += 1) {
		if (text.startsWith(close, index) && !escapedAt(text, index)) {
			return index;
		}
	}
	return -1;
}

function lineEnd(text: string, from: number): number {
	const at = text.indexOf('\n', from);
	return at < 0 ? text.length : at;
}

const DOLLAR = 0x24;
const BACKSLASH = 0x5c;

/** Consumes literal text. Backslash delimiters are kept as written, not handed to the escape rule. */
function literalSpan(state: StateInline, end: number, silent: boolean): true {
	if (!silent) {
		state.pending += state.src.slice(state.pos, end);
	}
	state.pos = end;
	return true;
}

function pushMath(state: StateInline, tex: string, markup: string, display: boolean, html: string): void {
	const token = state.push('math_inline', 'math', 0);
	token.content = tex;
	token.markup = markup;
	token.meta = { html, display };
}

/** Inline `$…$` / `\(…\)`, and the same-line display forms. Never crosses a newline. */
function mathInline(state: StateInline, silent: boolean): boolean {
	const src = state.src;
	const start = state.pos;
	if (start >= state.posMax) {
		return false;
	}
	const limit = Math.min(state.posMax, lineEnd(src, start));
	const code = src.charCodeAt(start);

	if (code === BACKSLASH) {
		if (src.startsWith('\\)', start) || src.startsWith('\\]', start)) {
			return literalSpan(state, Math.min(start + 2, limit), silent);
		}
		const open = src.startsWith('\\(', start) ? '\\(' : src.startsWith('\\[', start) ? '\\[' : '';
		if (!open) {
			return false;
		}
		const close = open === '\\(' ? '\\)' : '\\]';
		const display = open === '\\[';
		const at = findClose(src, start + 2, close, limit);
		if (at < 0) {
			return literalSpan(state, Math.min(start + 2, limit), silent);
		}
		const inner = src.slice(start + 2, at);
		const after = src.slice(at + 2, limit);
		const valid =
			inner.trim().length > 0 &&
			!inner.includes('`') &&
			(display || (!/^\s|\s$/.test(inner) && !/^\d/.test(after) && !after.startsWith('$')));
		const html = valid ? mathHost(inner, display) : null;
		if (!html) {
			// No renderer, a malformed formula, or a still-streaming one: keep the source, backslashes
			// included. Returning false here would let markdown-it's escape rule eat them.
			return literalSpan(state, at + 2, silent);
		}
		if (!silent) {
			pushMath(state, inner, open, display, html);
		}
		state.pos = at + 2;
		return true;
	}

	if (code !== DOLLAR) {
		return false;
	}
	const display = src.startsWith('$$', start);
	const open = display ? '$$' : '$';
	const at = findClose(src, start + open.length, open, limit);
	if (at < 0) {
		return false;
	}
	const inner = src.slice(start + open.length, at);
	const after = src.slice(at + open.length, limit);
	const valid =
		inner.trim().length > 0 &&
		!inner.includes('`') &&
		(display || (!/^\s|\s$/.test(inner) && !/^\d/.test(after) && !after.startsWith('$')));
	if (!valid) {
		return false;
	}
	const html = mathHost(inner, display);
	if (!html) {
		return false;
	}
	if (!silent) {
		pushMath(state, inner, open, display, html);
	}
	state.pos = at + open.length;
	return true;
}

const BLOCK_OPEN = /^\s*(\$\$|\\\[)[ \t]*(.*)$/;

function pushMathBlock(state: StateBlock, startLine: number, endLine: number, tex: string, markup: string, html: string): void {
	const token = state.push('math_block', 'math', 0);
	token.block = true;
	token.content = tex;
	token.markup = markup;
	token.map = [startLine, endLine];
	token.meta = { html };
	state.line = endLine;
}

/** A display formula opened by `$$` or `\[` on its own line, closed on this or a later line. */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
	const offset = state.bMarks[startLine]! + state.tShift[startLine]!;
	const opener = BLOCK_OPEN.exec(state.src.slice(offset, state.eMarks[startLine]));
	if (!opener) {
		return false;
	}
	const open = opener[1]!;
	const close = open === '$$' ? '$$' : '\\]';
	const rest = opener[2]!;

	const same = findClose(rest, 0, close, rest.length);
	if (same >= 0 && !rest.slice(same + close.length).trim()) {
		const inner = rest.slice(0, same);
		const html = inner.trim() ? mathHost(inner, true) : null;
		if (!html) {
			return false;
		}
		if (silent) {
			return true;
		}
		pushMathBlock(state, startLine, startLine + 1, inner, open, html);
		return true;
	}

	const body = rest.trim() ? [rest] : [];
	for (let next = startLine + 1; next < endLine; next += 1) {
		if (state.isEmpty(next)) {
			body.push('');
			continue;
		}
		if (state.sCount[next]! < state.blkIndent) {
			return false;
		}
		const from = state.bMarks[next]! + state.tShift[next]!;
		const text = state.src.slice(from, state.eMarks[next]);
		const at = findClose(text, 0, close, text.length);
		if (at >= 0 && !text.slice(at + close.length).trim()) {
			body.push(text.slice(0, at));
			const inner = body.join('\n');
			const html = inner.trim() ? mathHost(inner, true) : null;
			if (!html) {
				return false;
			}
			if (silent) {
				return true;
			}
			pushMathBlock(state, startLine, next + 1, inner, open, html);
			return true;
		}
		body.push(text);
	}
	// Streaming: the closer has not arrived, so the source stays a paragraph until it does.
	return false;
}

function tokenHtml(token: Token): string | null {
	const html = token.meta ? token.meta.html : null;
	return typeof html === 'string' && html ? html : null;
}

/** Registers the math block and inline rules on a markdown-it instance. */
export function mathPlugin(md: MarkdownIt): void {
	md.inline.ruler.before('escape', 'math_inline', mathInline);
	md.block.ruler.before('code', 'math_block', mathBlock, {
		alt: ['paragraph', 'reference', 'blockquote', 'list'],
	});
	md.renderer.rules.math_inline = (tokens, idx) => tokenHtml(tokens[idx]!) ?? '';
	md.renderer.rules.math_block = (tokens, idx) => {
		const html = tokenHtml(tokens[idx]!);
		return html ? html + '\n' : '';
	};
}
