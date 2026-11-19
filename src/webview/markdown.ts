// SPDX-License-Identifier: AGPL-3.0-only
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { mathPlugin } from './math';

/**
 * The chat's markdown renderer, loaded before `chat.js` as `resources/markdown.js`. It owns the whole
 * content layer the old hand-written line parser had: CommonMark blocks and inlines, the fenced code
 * block markup the transcript styles and copies, the optional math hooks, and the highlighter tool
 * cards share. `chat.js` only calls `__comonadMarkdown.render` and `highlightCode`.
 *
 * Everything global is reached through `globalThis`, not `window`, so tests can execute the built
 * bundle in the extension host and render without a DOM.
 */

const esc = (s: string): string =>
	String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A small bash highlighter for shell commands and fenced bash blocks. It is deliberately not a
 * parser: comments, quotes, variables, redirections and the usual keywords are enough to read a
 * command at a glance, and the text it returns is still the same text Copy sees.
 */
function highlightShell(src: string): string {
	const KEYWORDS = new Set(
		'if then else elif fi for while until do done case esac in function select time return exit local export readonly declare typeset set unset shift source alias eval exec trap break continue true false'.split(
			' ',
		),
	);
	const variable = /\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#*$!?-])/y;
	const operator = /(?:\|\||&&|\d*>&\d*|\d*>>?|[|&;<>()=])/y;
	let out = '';
	let i = 0;
	let expectCommand = true;
	const push = (cls: string, text: string): void => {
		out += cls ? '<span class="sh-' + cls + '">' + esc(text) + '</span>' : esc(text);
	};
	while (i < src.length) {
		const ch = src[i];
		if (ch === '\n') {
			push('', ch);
			expectCommand = true;
			i += 1;
			continue;
		}
		if (/\s/.test(ch!)) {
			push('', ch!);
			i += 1;
			continue;
		}
		if (ch === '#' && (i === 0 || /\s/.test(src[i - 1]!))) {
			const end = src.indexOf('\n', i);
			const stop = end < 0 ? src.length : end;
			push('comment', src.slice(i, stop));
			i = stop;
			continue;
		}
		if (ch === "'" || ch === '"') {
			let j = i + 1;
			while (j < src.length && src[j] !== ch) {
				if (ch === '"' && src[j] === '\\') {
					j += 1;
				}
				j += 1;
			}
			j = Math.min(j + 1, src.length);
			push('string', src.slice(i, j));
			i = j;
			continue;
		}
		variable.lastIndex = i;
		const cash = variable.exec(src);
		if (cash) {
			push('var', cash[0]);
			i = variable.lastIndex;
			continue;
		}
		operator.lastIndex = i;
		const op = operator.exec(src);
		if (op) {
			push('op', op[0]);
			if (/[|&;(]/.test(op[0])) {
				expectCommand = true;
			}
			i = operator.lastIndex;
			continue;
		}
		let j = i;
		while (j < src.length && !/[\s'"$|&;<>()=]/.test(src[j]!)) {
			j += 1;
		}
		if (j === i) {
			push('', ch!);
			i += 1;
			continue;
		}
		const token = src.slice(i, j);
		i = j;
		if (KEYWORDS.has(token)) {
			push('kw', token);
			expectCommand = token === 'then' || token === 'do' || token === 'else' || token === 'elif';
			continue;
		}
		if (expectCommand) {
			push('cmd', token);
			expectCommand = false;
			continue;
		}
		if (/^--?[A-Za-z0-9][\w-]*$/.test(token)) {
			push('flag', token);
			continue;
		}
		if (/^-?\d+(?:\.\d+)?$/.test(token)) {
			push('num', token);
			continue;
		}
		push('', token);
	}
	return out;
}

const SHELL_LANGS = /^(bash|sh|shell|zsh)$/i;

function highlightNow(lang: string, code: string): string {
	if (lang && !/^(text|plaintext|txt)$/i.test(lang)) {
		try {
			if (hljs.getLanguage(lang)) {
				return hljs.highlight(code, { language: lang }).value;
			}
			return hljs.highlightAuto(code).value;
		} catch {
			// A broken/growing block still reads as its source; fall through to the local path.
		}
	}
	return SHELL_LANGS.test(lang) ? highlightShell(code) : esc(code);
}

const highlightCache = new Map<string, string>();
const HIGHLIGHT_CACHE_LIMIT = 256;

/** The highlighter, memoized: a streaming reply re-renders every block on every frame. */
function highlightCode(lang: string, code: string): string {
	const key = lang + '\u0000' + code;
	const hit = highlightCache.get(key);
	if (hit !== undefined) {
		return hit;
	}
	const html = highlightNow(lang, code);
	if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) {
		highlightCache.clear();
	}
	highlightCache.set(key, html);
	return html;
}

function renderCodeBlock(lang: string, code: string): string {
	const label = lang || 'text';
	const safe = esc(label);
	return (
		'<div class="codeblock"><div class="codehead"><span>' +
		safe +
		'</span><button class="copy" type="button">Copy</button></div><pre data-lang="' +
		safe +
		'"><code>' +
		highlightCode(label, code) +
		'</code></pre></div>\n'
	);
}

const md = new MarkdownIt({
	html: false,
	breaks: true,
	linkify: true,
	typographer: false,
});
md.linkify.set({ fuzzyEmail: false });
md.inline.ruler.disable('image');
md.use(mathPlugin);

md.renderer.rules.fence = (tokens, idx) => {
	const token = tokens[idx]!;
	const info = token.info ? md.utils.unescapeAll(token.info).trim() : '';
	const lang = info ? info.split(/\s+/)[0]! : '';
	const code = token.content.endsWith('\n') ? token.content.slice(0, -1) : token.content;
	return renderCodeBlock(lang, code);
};

md.renderer.rules.code_block = (tokens, idx) => {
	const raw = tokens[idx]!.content;
	return renderCodeBlock('text', raw.endsWith('\n') ? raw.slice(0, -1) : raw);
};

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
	const token = tokens[idx]!;
	const href = String(token.attrGet('href') ?? '');
	token.attrs = [
		['href', '#'],
		['data-url', href],
	];
	return self.renderToken(tokens, idx, options);
};

const api = {
	render: (src: string): string => md.render(String(src)),
	highlightCode: (lang: string, code: string): string => highlightCode(String(lang || ''), String(code)),
};

(globalThis as Record<string, unknown>).__comonadMarkdown = api;
