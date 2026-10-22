// SPDX-License-Identifier: AGPL-3.0-only
// Comonad chat panel — runs inside the VS Code webview, talks to the extension over postMessage.
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const $ = (id) => document.getElementById(id);
	const messagesEl = $('messages');
	const input = $('input');
	const composerImagesEl = $('composer-images');
	const mentionEl = $('mention');
	const mentionHead = $('mention-head');
	const mentionList = $('mention-list');
	const networkChip = $('network');
	const environmentChip = $('environment');
	const changesPanel = $('changes-panel');
	const changesTitle = $('changes-title');
	const changesList = $('changes-list');
	const changesToggle = $('changes-toggle');
	const changesActions = $('changes-actions');
	const loreChip = $('lore');
	const barEl = $('bar');
	const chatsEl = $('chats');
	const chatsList = $('chats-list');
	const searchBox = $('search');
	const tip = $('tip');

	const FORMS = [
		['rendered', 'Rendered', 'folded thoughts, tool cards'],
		['token', 'Token', 'assistant text only'],
		['raw', 'Raw', 'the full record'],
	];
	const CONTEXTS = [
		{ id: 'rendered', label: 'Rendered', description: 'text, thoughts and tool results' },
		{ id: 'token', label: 'Token', description: 'assistant text only' },
		{ id: 'raw', label: 'Raw', description: 'the full record' },
	];

	/* ------------------------------------------------------------------ tooltips */

	// A VS Code-style hover tip; each control carries its explanation in `data-tip`.

	let tipFor = null;

	function showTip(target) {
		const text = target.dataset.tip;
		if (!text) {
			return;
		}
		tipFor = target;
		tip.textContent = text;
		tip.hidden = false;
		const rect = target.getBoundingClientRect();
		const width = tip.offsetWidth;
		const height = tip.offsetHeight;
		// While a pill menu is open the tip anchors to the menu itself, so it stays
		// put while the mouse moves between choices.
		const menu = target.closest('.pill-menu');
		const anchor = menu ? menu.getBoundingClientRect() : rect;
		let left;
		let top;
		if (menu && anchor.right + 8 + width <= window.innerWidth - 8) {
			left = anchor.right + 8;
			top = anchor.top;
		} else if (menu && anchor.left - 8 - width >= 8) {
			left = anchor.left - 8 - width;
			top = anchor.top;
		} else {
			left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
			top = anchor.top - height - 6 >= 8 ? anchor.top - height - 6 : anchor.bottom + 6;
		}
		tip.style.left = left + 'px';
		tip.style.top = Math.max(8, Math.min(top, window.innerHeight - height - 8)) + 'px';
	}

	function hideTip() {
		tipFor = null;
		tip.hidden = true;
	}

	function refreshTip() {
		if (tipFor && !tipFor.isConnected) {
			hideTip();
			return;
		}
		if (tipFor) {
			showTip(tipFor);
		}
	}

	document.addEventListener('mouseover', (event) => {
		const target = event.target.closest?.('[data-tip]');
		if (!target) {
			hideTip();
			return;
		}
		if (target !== tipFor) {
			showTip(target);
		}
	});
	document.addEventListener('mouseout', (event) => {
		const target = event.target.closest?.('[data-tip]');
		if (target && !target.contains(event.relatedTarget)) {
			hideTip();
		}
	});
	document.addEventListener('mousedown', (event) => {
		hideTip();
		if (!event.target.closest?.('.pill') && !modelFlyout.contains(event.target)) {
			closeMenus();
		}
		// The chat list behaves like a popover: clicking anywhere else folds it away.
		if (!event.target.closest?.('#chats') && !event.target.closest?.('#history')) {
			closeChats();
		}
		if (mention && !event.target.closest?.('#mention') && !event.target.closest?.('#input')) {
			closeMention();
		}
	});
	window.addEventListener('blur', () => {
		hideTip();
		hideFlyout();
		closeChats();
		closeMention();
	});

	/* ------------------------------------------------------------------ pill menus */

	// The send-bar pills open their own menu instead of a native select, so every
	// choice can carry an explanation on hover.

	const pills = new Map();

	function setupPill(control, send) {
		const root = document.querySelector('.pill[data-control="' + control + '"]');
		const trigger = root.querySelector('.pill-trigger');
		const menu = root.querySelector('.pill-menu');
		const entry = { root, trigger, menu, send, current: '' };
		pills.set(control, entry);
		trigger.addEventListener('click', () => {
			if (menu.hidden) {
				openMenu(entry);
			} else {
				closeMenu(entry);
			}
		});
		return entry;
	}

	function openMenu(entry) {
		closeMenus();
		entry.menu.hidden = false;
		entry.trigger.setAttribute('aria-expanded', 'true');
		entry.onOpen?.();
	}

	function closeMenu(entry) {
		entry.menu.hidden = true;
		entry.trigger.setAttribute('aria-expanded', 'false');
		hideFlyout();
	}

	function closeMenus() {
		let closed = false;
		for (const entry of pills.values()) {
			if (!entry.menu.hidden) {
				closeMenu(entry);
				closed = true;
			}
		}
		return closed;
	}

	function fillPill(entry, items, current, purpose) {
		entry.current = current;
		entry.trigger.querySelector('.pill-label').textContent = choiceLabel(items, current);
		entry.trigger.dataset.tip = purpose + '\nCurrent: ' + choiceTitle(items, current);
		entry.menu.innerHTML = '';
		for (const item of items || []) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'pill-choice';
			row.dataset.value = item.id;
			row.dataset.tip = item.description ? item.label + ' — ' + item.description : item.label;
			row.innerHTML = '<span class="pill-choice-label">' + esc((item.id === current ? '✓ ' : '') + (item.label || item.id)) + '</span>';
			row.classList.toggle('is-on', item.id === current);
			row.addEventListener('click', () => {
				closeMenu(entry);
				if (item.id !== entry.current) {
					entry.send(item.id);
				}
			});
			entry.menu.appendChild(row);
		}
	}

	const modePill = setupPill('mode', (mode) => vscode.postMessage({ type: 'setMode', mode }));
	// The generation menu is not a setting: every entry runs a generation of that type, which is how
	// SillyTavern's own generate button works. The host owns the list (and its wording).
	const GENERATION_TIPS = {
		normal: 'answer the text in the box',
		continue: 'carry the last message on from where it stops',
		impersonate: 'write your next message for you',
		swipe: 'another version of the last reply, keeping the one you are reading',
		regenerate: 'the last reply again',
		quiet: 'a reply that is never added to the chat',
	};
	const generationPill = setupPill('generate', () => undefined);
	const approvalPill = setupPill('approval', (approval) => vscode.postMessage({ type: 'setApproval', approval }));
	const contextPill = setupPill('context', (context) => vscode.postMessage({ type: 'setContext', context }));
	// Display is global: it re-renders the whole transcript instead of one reply at a time.
	const displayPill = setupPill('display', (display) => vscode.postMessage({ type: 'setDisplay', display }));
	const DISPLAYS = FORMS.map(([id, label, description]) => ({ id, label, description }));

	/* The model pill: Reasoning effort, Context budget and Model, Cursor-style. */

	const REASONING = [
		{ id: 'auto', label: 'Auto', description: 'use the provider default' },
		{ id: 'none', label: 'None', description: 'answer without extra thinking' },
		{ id: 'low', label: 'Low', description: 'a quick pass of thinking' },
		{ id: 'medium', label: 'Medium', description: 'balanced thinking' },
		{ id: 'high', label: 'High', description: 'the deepest thinking the model offers' },
	];
	// The window the model is treated as having. Auto takes the model's own, which is the only setting
	// that stays right when the model changes; the rest override it for a model whose window is not what
	// its provider documents. None of these cap the history — past the window, older turns are summarized.
	const LIMITS = [
		{ id: 0, label: 'Auto', description: "use the model's own window" },
		{ id: 32768, label: '32K', description: 'treat the window as 32k tokens' },
		{ id: 65536, label: '64K', description: 'treat the window as 64k tokens' },
		{ id: 131072, label: '128K', description: 'treat the window as 128k tokens' },
		{ id: 262144, label: '256K', description: 'treat the window as 256k tokens' },
		{ id: 524288, label: '512K', description: 'treat the window as 512k tokens' },
		{ id: 1048576, label: '1M', description: 'treat the window as 1m tokens' },
	];

	const modelPill = setupPill('model', (value) => {
		if (value && typeof value === 'object') {
			vscode.postMessage(value);
		} else {
			vscode.postMessage({ type: 'setModel', model: value });
		}
	});

	const modelState = { models: [], model: '', modelLabel: 'auto', reasoningEffort: 'auto', contextWindow: 0, windowTokens: 0 };

	// Hovering Reasoning / Context / Model expands the choices in a flyout on the right.
	const modelFlyout = document.createElement('div');
	modelFlyout.className = 'pill-menu pill-flyout';
	modelFlyout.hidden = true;
	document.body.append(modelFlyout);
	let flyoutPage = '';
	let flyoutShowTimer = 0;
	let flyoutHideTimer = 0;

	/** A token count the way a window is spoken about: 128K, 1M. */
	function formatTokens(tokens) {
		if (tokens >= 1048576) {
			return Math.round((tokens / 1048576) * 10) / 10 + 'M';
		}
		return Math.round(tokens / 1024) + 'K';
	}

	/** The Context row's value: the chat's override, or the window the model's profile supplied. */
	function formatLimit(value) {
		const tokens = Number(value) || 0;
		if (tokens > 0) {
			return formatTokens(tokens);
		}
		return modelState.windowTokens > 0 ? `Auto (${formatTokens(modelState.windowTokens)})` : 'Auto';
	}


	function pageItems(page) {
		if (page === 'reasoning') {
			return REASONING;
		}
		if (page === 'context') {
			return LIMITS;
		}
		return modelState.models;
	}

	function pageCurrent(page) {
		if (page === 'reasoning') {
			return modelState.reasoningEffort;
		}
		if (page === 'context') {
			return modelState.contextWindow;
		}
		return modelState.model;
	}

	function pagePick(page, id) {
		if (page === 'reasoning') {
			modelPill.send({ type: 'setReasoningEffort', effort: id });
		} else if (page === 'context') {
			modelPill.send({ type: 'setContextWindow', window: id });
		} else {
			modelPill.send(id);
		}
	}

	function placeFlyout(row) {
		const menu = modelPill.menu.getBoundingClientRect();
		const rect = row.getBoundingClientRect();
		const width = modelFlyout.offsetWidth;
		const height = modelFlyout.offsetHeight;
		let left = menu.right + 6;
		if (left + width > window.innerWidth - 8) {
			left = Math.max(8, window.innerWidth - 8 - width);
		}
		// Align with the row, but never reach past the menu's bottom — a flyout that
		// is taller than the rest of the menu grows upward instead.
		let top = Math.min(rect.top - 4, menu.bottom - height);
		top = Math.max(8, Math.min(top, window.innerHeight - 8 - height));
		modelFlyout.style.left = left + 'px';
		modelFlyout.style.top = top + 'px';
	}

	function showFlyout(page, row) {
		clearTimeout(flyoutShowTimer);
		clearTimeout(flyoutHideTimer);
		hideTip();
		flyoutPage = page;
		modelFlyout.innerHTML = '';
		for (const item of pageItems(page)) {
			modelFlyout.append(choiceRow(item, pageCurrent(page), (id) => pagePick(page, id), modelPill));
		}
		if (page === 'model') {
			// The way out when there is no profile yet: the wizard writes `comonad.profiles` and the key.
			modelFlyout.append(
				choiceRow(
					{ id: '__configure', label: '⚙ Configure a provider…', description: 'add an OpenAI-compatible endpoint' },
					'',
					() => modelPill.send({ type: 'configureModel' }),
					modelPill,
				),
			);
		}
		modelFlyout.hidden = false;
		placeFlyout(row);
	}

	function scheduleFlyout(page, row) {
		clearTimeout(flyoutHideTimer);
		clearTimeout(flyoutShowTimer);
		flyoutShowTimer = setTimeout(() => showFlyout(page, row), 80);
	}

	function scheduleHideFlyout(delay = 180) {
		clearTimeout(flyoutShowTimer);
		clearTimeout(flyoutHideTimer);
		flyoutHideTimer = setTimeout(hideFlyout, delay);
	}

	function hideFlyout() {
		clearTimeout(flyoutShowTimer);
		clearTimeout(flyoutHideTimer);
		flyoutPage = '';
		modelFlyout.hidden = true;
		modelFlyout.innerHTML = '';
	}

	modelPill.menu.addEventListener('mouseleave', (event) => {
		if (!modelFlyout.contains(event.relatedTarget)) {
			scheduleHideFlyout();
		}
	});
	modelFlyout.addEventListener('mouseenter', () => {
		clearTimeout(flyoutShowTimer);
		clearTimeout(flyoutHideTimer);
	});
	modelFlyout.addEventListener('mouseleave', (event) => {
		if (!modelPill.menu.contains(event.relatedTarget)) {
			scheduleHideFlyout(120);
		}
	});

	function choiceRow(item, current, pick, entry) {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'pill-choice';
		row.dataset.tip = item.description ? item.label + ' — ' + item.description : item.label;
		row.innerHTML =
			'<span class="pill-choice-label">' +
			esc((item.id === current ? '✓ ' : '') + (item.label || item.id)) +
			'</span>' +
			(item.needsKey ? '<span class="pill-choice-note">no key</span>' : '');
		row.classList.toggle('is-on', item.id === current);
		row.addEventListener('click', () => {
			// The menu the row belongs to is the one that has to close: a pick is an action, not a
			// setting that stays open for the next one.
			closeMenu(entry);
			pick(item.id);
		});
		return row;
	}

	function flyoutRow(page, label, value) {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'pill-choice pill-choice-section';
		row.innerHTML =
			'<span class="pill-choice-label">' +
			esc(label) +
			'</span><span class="pill-choice-value">' +
			esc(value) +
			'</span><span class="pill-choice-arrow">›</span>';
		row.addEventListener('mouseenter', () => scheduleFlyout(page, row));
		row.addEventListener('click', () => {
			if (flyoutPage === page && !modelFlyout.hidden) {
				hideFlyout();
			} else {
				showFlyout(page, row);
			}
		});
		return row;
	}

	function renderModelMenu() {
		const menu = modelPill.menu;
		menu.innerHTML = '';
		menu.append(flyoutRow('reasoning', 'Reasoning', choiceLabel(REASONING, modelState.reasoningEffort)));
		menu.append(flyoutRow('context', 'Context window', formatLimit(modelState.contextWindow)));
		menu.append(flyoutRow('model', 'Model', modelState.modelLabel));
	}

	function updateModelPill() {
		modelPill.trigger.querySelector('.pill-label').textContent = modelState.modelLabel;
		modelPill.trigger.dataset.tip = 'Model — the model for new turns\nCurrent: ' + modelState.modelLabel;
		if (!modelPill.menu.hidden) {
			renderModelMenu();
		}
	}

	modelPill.onOpen = () => {
		renderModelMenu();
	};

	/* What the content layer reported after the last turn: the entries the world-book scan injected. */

	const tavernState = { activated: [], overflow: false };

	let state = null;
	let shownSession = null;
	/** The open @ picker, if any. */
	let mention = null;
	let running = false;
	/** The chat whose turn is running, so Stop targets it after the user switches away. */
	let runningSession = null;
	/** A stop was requested and the host has not settled the turn yet. */
	let stopping = false;
	let pinned = true;
	/** Tool step per call id, so a result can be written back into the step that asked for it. */
	const toolCards = new Map();

	/* ------------------------------------------------------------------ markdown */

	const esc = (s) =>
		String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

	/**
	 * The optional math renderer a chat asset installs before this script. The core owns the wrapper
	 * and its `data-tex`, so the source-preserving copy works whichever renderer contributed; without
	 * the hook every formula stays the literal text the model wrote.
	 */
	function mathRender(tex, display) {
		try {
			const api = window.__comonadMath;
			if (!api || typeof api.render !== 'function') {
				return null;
			}
			const html = api.render(String(tex), Boolean(display));
			return typeof html === 'string' && html ? html : null;
		} catch {
			return null;
		}
	}

	function mathHost(tex, display) {
		const html = mathRender(tex, display);
		if (!html) {
			return null;
		}
		return '<span class="' + (display ? 'math-block' : 'math-inline') + '" data-tex="' + esc(tex) + '">' + html + '</span>';
	}

	/** Whether the delimiter at `index` is escaped by an odd run of backslashes. */
	function escapedAt(text, index) {
		let count = 0;
		while (index - 1 - count >= 0 && text[index - 1 - count] === '\\') {
			count += 1;
		}
		return count % 2 === 1;
	}

	function findClose(text, from, close) {
		for (let index = from; index <= text.length - close.length; index += 1) {
			if (text.startsWith(close, index) && !escapedAt(text, index)) {
				return index;
			}
		}
		return -1;
	}

	/**
	 * Replaces inline math with placeholders. `$$...$$` / `\[...\]` are display, `\(...\)` / `$...$`
	 * are inline; dollar signs that look like currency (whitespace at an edge, a digit after the
	 * closer) stay literal. Math containing a code/link placeholder is left alone so the placeholders
	 * can still be restored.
	 */
	function protectMath(text, out) {
		if (!window.__comonadMath) {
			return text;
		}
		let result = '';
		let index = 0;
		while (index < text.length) {
			const rest = text.slice(index);
			let opener = null;
			if (rest.startsWith('\\(') && !escapedAt(text, index)) {
				opener = { open: '\\(', close: '\\)', display: false, inline: true };
			} else if (rest.startsWith('\\[') && !escapedAt(text, index)) {
				opener = { open: '\\[', close: '\\]', display: true, inline: false };
			} else if (rest.startsWith('$$') && !escapedAt(text, index)) {
				opener = { open: '$$', close: '$$', display: true, inline: false };
			} else if (text[index] === '$' && !escapedAt(text, index)) {
				opener = { open: '$', close: '$', display: false, inline: true };
			}
			if (!opener) {
				result += text[index];
				index += 1;
				continue;
			}
			const start = index + opener.open.length;
			const close = findClose(text, start, opener.close);
			if (close < 0) {
				result += text[index];
				index += 1;
				continue;
			}
			const inner = text.slice(start, close);
			const after = text.slice(close + opener.close.length);
			const valid =
				inner.trim().length > 0 &&
				!inner.includes('\u0000') &&
				!inner.includes('\u0001') &&
				(!opener.inline || (!/^\s|\s$/.test(inner) && !/^\d/.test(after) && !after.startsWith('$')));
			if (!valid) {
				// A bad dollar candidate is currency or prose: keep the opener and let the closer be
				// considered on its own. A bad \(..\)/\[..\]/$$..$$ is left as source.
				if (opener.open === '$') {
					result += '$';
					index += 1;
				} else {
					result += text.slice(index, close + opener.close.length);
					index = close + opener.close.length;
				}
				continue;
			}
			const host = mathHost(inner, opener.display);
			if (!host) {
				result += text.slice(index, close + opener.close.length);
				index = close + opener.close.length;
				continue;
			}
			out.push(host);
			result += '\u0002' + (out.length - 1) + '\u0002';
			index = close + opener.close.length;
		}
		return result;
	}

	function inline(text) {
		const codes = [];
		const links = [];
		const maths = [];
		let s = String(text).replace(/`([^`]+)`/g, (_, code) => {
			codes.push(code);
			return '\u0000' + (codes.length - 1) + '\u0000';
		});
		s = protectMath(s, maths);
		s = esc(s);
		s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
			links.push('<a href="#" data-url="' + url + '">' + label + '</a>');
			return '\u0001' + (links.length - 1) + '\u0001';
		});
		s = s.replace(/(https?:\/\/[^\s<)"']+)/g, (_, url) => {
			links.push('<a href="#" data-url="' + url + '">' + url + '</a>');
			return '\u0001' + (links.length - 1) + '\u0001';
		});
		s = s
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
			.replace(/~~([^~]+)~~/g, '<del>$1</del>');
		s = s.replace(/\u0001(\d+)\u0001/g, (_, index) => links[Number(index)]);
		s = s.replace(/\u0002(\d+)\u0002/g, (_, index) => maths[Number(index)]);
		s = s.replace(/\u0000(\d+)\u0000/g, (_, index) => '<code>' + esc(codes[Number(index)]) + '</code>');
		return s;
	}

	/**
	 * A small bash highlighter for shell commands and fenced bash blocks. It is deliberately not a
	 * parser: comments, quotes, variables, redirections and the usual keywords are enough to read a
	 * command at a glance, and the text it returns is still the same text Copy sees.
	 */
	function highlightShell(src) {
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
		const push = (cls, text) => {
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
			if (/\s/.test(ch)) {
				push('', ch);
				i += 1;
				continue;
			}
			if (ch === '#' && (i === 0 || /\s/.test(src[i - 1]))) {
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
			while (j < src.length && !/[\s'"$|&;<>()=]/.test(src[j])) {
				j += 1;
			}
			if (j === i) {
				push('', ch);
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

	/** highlight.js when the webview bundle is present; the local shell highlighter otherwise. */
	function highlightCode(lang, code) {
		const hljs = window.hljs;
		if (hljs && lang && !/^(text|plaintext|txt)$/i.test(lang)) {
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

	function codeBlock(lang, code) {
		return (
			'<div class="codeblock"><div class="codehead"><span>' +
			esc(lang) +
			'</span><button class="copy" type="button">Copy</button></div><pre data-lang="' +
			esc(lang) +
			'"><code>' +
			highlightCode(lang, code) +
			'</code></pre></div>'
		);
	}

	function cells(line) {
		return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
	}

	function table(header, rows) {
		let html = '<table><thead><tr>' + header.map((cell) => '<th>' + inline(cell) + '</th>').join('') + '</tr></thead><tbody>';
		for (const row of rows) {
			html += '<tr>' + row.map((cell) => '<td>' + inline(cell) + '</td>').join('') + '</tr>';
		}
		return html + '</tbody></table>';
	}

	/**
	 * A display formula at `lines[i]`: a whole-line `$$…$$` / `\[…\]`, or a block opened by one of
	 * them and closed on a later line. `null` when there is no renderer or no closer yet, so a
	 * streaming formula stays its source until the closing delimiter arrives.
	 */
	function displayMathAt(lines, i) {
		if (!window.__comonadMath) {
			return null;
		}
		const opener = /^\s*(\$\$|\\\[)\s*(.*)$/.exec(lines[i]);
		if (!opener) {
			return null;
		}
		const close = opener[1] === '$$' ? '$$' : '\\]';
		const rest = opener[2];
		const oneLine = rest.indexOf(close);
		if (oneLine >= 0 && !rest.slice(oneLine + close.length).trim()) {
			const inner = rest.slice(0, oneLine);
			if (!inner.trim()) {
				return null;
			}
			const host = mathHost(inner, true);
			return host ? { html: host, end: i + 1 } : null;
		}
		const body = rest.trim() ? [rest] : [];
		for (let next = i + 1; next < lines.length; next += 1) {
			const at = lines[next].indexOf(close);
			if (at >= 0 && !escapedAt(lines[next], at) && !lines[next].slice(at + close.length).trim()) {
				body.push(lines[next].slice(0, at));
				const inner = body.join('\n');
				if (!inner.trim()) {
					return null;
				}
				const host = mathHost(inner, true);
				return host ? { html: host, end: next + 1 } : null;
			}
			body.push(lines[next]);
		}
		return null;
	}

	function md(src) {
		const lines = String(src).replace(/\r\n/g, '\n').split('\n');
		const out = [];
		let i = 0;
		let list = null;
		const closeList = () => {
			if (list) {
				out.push(list === 'ul' ? '</ul>' : '</ol>');
				list = null;
			}
		};
		while (i < lines.length) {
			const line = lines[i];
			const fence = line.match(/^```\s*([\w+-]*)\s*$/);
			if (fence) {
				closeList();
				const body = [];
				i += 1;
				while (i < lines.length && !/^```\s*$/.test(lines[i])) {
					body.push(lines[i]);
					i += 1;
				}
				i += 1;
				out.push(codeBlock(fence[1] || 'text', body.join('\n')));
				continue;
			}
			const display = displayMathAt(lines, i);
			if (display) {
				closeList();
				out.push(display.html);
				i = display.end;
				continue;
			}
			const heading = line.match(/^(#{1,5})\s+(.*)$/);
			if (heading) {
				closeList();
				const n = heading[1].length;
				out.push('<h' + n + '>' + inline(heading[2]) + '</h' + n + '>');
				i += 1;
				continue;
			}
			if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
				closeList();
				out.push('<hr/>');
				i += 1;
				continue;
			}
			if (/^>\s?/.test(line)) {
				closeList();
				const quote = [];
				while (i < lines.length && /^>\s?/.test(lines[i])) {
					quote.push(lines[i].replace(/^>\s?/, ''));
					i += 1;
				}
				out.push('<blockquote>' + md(quote.join('\n')) + '</blockquote>');
				continue;
			}
			const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
			const number = line.match(/^\s*\d+[.)]\s+(.*)$/);
			if (bullet || number) {
				const want = bullet ? 'ul' : 'ol';
				if (list !== want) {
					closeList();
					out.push(want === 'ul' ? '<ul>' : '<ol>');
					list = want;
				}
				out.push('<li>' + inline((bullet || number)[1]) + '</li>');
				i += 1;
				continue;
			}
			if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
				closeList();
				const header = cells(line);
				const rows = [];
				i += 2;
				while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
					rows.push(cells(lines[i]));
					i += 1;
				}
				out.push(table(header, rows));
				continue;
			}
			if (line.trim() === '') {
				closeList();
				i += 1;
				continue;
			}
			closeList();
			const paragraph = [line];
			i += 1;
			while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,5}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s|\s*\$\$|\s*\\\[)/.test(lines[i])) {
				paragraph.push(lines[i]);
				i += 1;
			}
			out.push('<p>' + paragraph.map(inline).join('<br/>') + '</p>');
		}
		closeList();
		return out.join('\n');
	}

	/* ------------------------------------------------------------------ message bricks */

	function scroll(force) {
		if (force || pinned) {
			messagesEl.scrollTop = messagesEl.scrollHeight;
		}
	}

	messagesEl.addEventListener('scroll', () => {
		pinned = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 48;
	});

	function add(cls, html) {
		const el = document.createElement('div');
		el.className = 'msg ' + cls;
		el.innerHTML = html;
		messagesEl.appendChild(el);
		scroll();
		return el;
	}

	const ICONS = {
		copy: '<svg viewBox="0 0 16 16"><rect x="5.6" y="5.6" width="8" height="8" rx="1.6"/><path d="M10.4 3.4A1.6 1.6 0 0 0 8.8 2.4H4a1.6 1.6 0 0 0-1.6 1.6v4.8c0 .7.4 1.3 1 1.5"/></svg>',
		check: '<svg viewBox="0 0 16 16"><path d="M3.4 8.6l3 3 6.2-6.6"/></svg>',
		fork: '<svg viewBox="0 0 16 16"><circle cx="4.6" cy="3.8" r="1.8"/><circle cx="4.6" cy="12.2" r="1.8"/><circle cx="11.4" cy="3.8" r="1.8"/><path d="M4.6 5.6v4.8M11.4 5.6c0 2.4-2 3.2-4.2 3.6"/></svg>',
		again: '<svg viewBox="0 0 16 16"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8"/><path d="M13.4 2.6v3.3h-3.3"/></svg>',
		pencil: '<svg viewBox="0 0 16 16"><path d="M10.8 2.6l2.6 2.6-8.1 8.1-3.3.7.7-3.3z"/><path d="M9.4 4l2.6 2.6"/></svg>',
	};

	function actionRow(actions) {
		const row = document.createElement('div');
		row.className = 'msg-actions';
		for (const { key, icon, tip, run } of actions) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'act';
			button.dataset.act = key;
			button.dataset.tip = tip;
			button.innerHTML = ICONS[icon];
			button.addEventListener('click', () => run(button));
			row.appendChild(button);
		}
		return row;
	}

	/** Copies a message and flashes a check, like Cursor's copy button. */
	function copyAction(button, text) {
		vscode.postMessage({ type: 'copy', text });
		if (button.classList.contains('is-done')) {
			return;
		}
		const icon = button.innerHTML;
		button.innerHTML = ICONS.check;
		button.classList.add('is-done');
		setTimeout(() => {
			button.innerHTML = icon;
			button.classList.remove('is-done');
		}, 1_200);
	}

	function addCommand(text) {
		add('command', '<div class="bubble md">' + md(text) + '</div>');
	}

	function addNotice(text) {
		add('notice', '<div class="line">' + esc(text) + '</div>');
	}

	/* ------------------------------------------------------------------ turns */

	// The transcript is a list of turns: one prompt plus the steps the agent took for it — its
	// thoughts, its text and its tool calls, in the order they happened. A live turn is built with
	// the same builders a replayed one is, so what you watch streaming is what a reload shows, and
	// a turn is never split in two by a refresh.

	let turns = [];
	let live = null;
	/** An impersonation is being written into the composer rather than into a turn of the chat. */
	let draft = false;
	/** The open prompt editor's restore function, if one is open. */
	let editing = null;

	function currentView() {
		return state && (state.display === 'token' || state.display === 'raw') ? state.display : 'rendered';
	}

	/** How a tool card starts: with its preview (the default), with only its header, or open. */
	function toolCardMode() {
		return state && (state.toolCard === 'collapsed' || state.toolCard === 'open') ? state.toolCard : 'preview';
	}

	function turnTools(turn) {
		return (turn.steps || []).filter((step) => step.kind === 'tool').length;
	}

	function turnAnswer(turn) {
		const steps = (turn.steps || []).filter((step) => step.kind === 'text' && (step.text || '').trim());
		return steps.length ? steps[steps.length - 1].text : '';
	}

	function turnRaw(turn) {
		return (turn.steps || [])
			.map((step) => {
				if (step.kind === 'thought') {
					return 'Thought\n' + (step.text || '');
				}
				if (step.kind === 'tool') {
					return '> ' + (step.name || 'tool') + ' ' + (step.args || '') + '\n' + (step.result || '');
				}
				return step.text || '';
			})
			.filter(Boolean)
			.join('\n\n');
	}

	/** `840ms`, `3.4s`, `1m 12s` — short enough to sit beside a label. */
	function formatDuration(ms) {
		const value = Math.max(0, Number(ms) || 0);
		if (value < 1_000) {
			return Math.round(value) + 'ms';
		}
		if (value < 60_000) {
			return (value / 1_000).toFixed(value < 10_000 ? 1 : 0) + 's';
		}
		const minutes = Math.floor(value / 60_000);
		const seconds = Math.round((value % 60_000) / 1_000);
		return minutes + 'm ' + seconds + 's';
	}

	/* ------------------------------------------------------------------ tool cards */

	// A tool card's visible words: a one-line title, the utility summary under it, and the output.
	// Shell calls carry their title from the model (`description`), so the host sends it whole; every
	// other title/summary is derived from the name and the arguments here, where the DOM lives.

	const SHELL_TOOL = /^(?:run_shell|start_shell)/;

	const TOOL_LABELS = {
		run_shell: 'Run shell',
		run_shell_readonly: 'Run shell (read-only)',
		start_shell: 'Start shell',
		shell_output: 'Shell output',
		stop_shell: 'Stop shell',
		read_file: 'Read file',
		write_file: 'Write file',
		list_dir: 'List directory',
		grep_files: 'Search files',
		apply_patch: 'Apply patch',
		apply_edits: 'Apply edits',
		find_files: 'Find files',
		find_symbols: 'Find symbols',
		get_diagnostics: 'Get diagnostics',
		git_diff: 'Read git diff',
		run_task: 'Run task',
		fetch_url: 'Fetch URL',
		web_search: 'Search the web',
		ask_user: 'Ask you',
		agent: 'Run agent',
		skill: 'Run skill',
		memory: 'Use memory',
		todo_write: 'Update todos',
		list_plans: 'List plans',
		read_plan: 'Read plan',
		write_plan: 'Write plan',
		calculate: 'Calculate',
		describe_numbers: 'Describe numbers',
		percentile: 'Percentile',
		convert_units: 'Convert units',
	};

	const TOOL_FAMILIES = {
		run_shell: 'terminal',
		run_shell_readonly: 'terminal',
		start_shell: 'terminal',
		shell_output: 'terminal',
		stop_shell: 'terminal',
		run_task: 'terminal',
		read_file: 'file',
		list_dir: 'file',
		git_diff: 'file',
		write_file: 'pencil',
		apply_patch: 'pencil',
		apply_edits: 'pencil',
		write_plan: 'pencil',
		grep_files: 'search',
		find_files: 'search',
		find_symbols: 'search',
		fetch_url: 'globe',
		web_search: 'globe',
		todo_write: 'list',
		list_plans: 'list',
		read_plan: 'list',
		agent: 'spark',
		skill: 'spark',
		memory: 'spark',
		ask_user: 'spark',
	};

	// The card's glyph is the tool's family, not its name: a shell is a prompt, a read is a page.
	const TOOL_ICONS = {
		terminal: '<svg viewBox="0 0 16 16"><path d="M3 4.2l3.1 3.6L3 11.4"/><path d="M8.4 11.4h4.4"/></svg>',
		file: '<svg viewBox="0 0 16 16"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>',
		pencil: '<svg viewBox="0 0 16 16"><path d="M10.6 2.7l2.7 2.7-7.8 7.8-3.3.6.6-3.3z"/><path d="M9.2 4.1l2.7 2.7"/></svg>',
		search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="3.8"/><path d="M10 10l3.3 3.3"/></svg>',
		globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.2"/><path d="M2.8 8h10.4M8 2.8c1.5 1.4 2.3 3.2 2.3 5.2S9.5 11.8 8 13.2C6.5 11.8 5.7 10 5.7 8S6.5 4.2 8 2.8z"/></svg>',
		list: '<svg viewBox="0 0 16 16"><path d="M6 4.5h7M6 8h7M6 11.5h7"/><path d="M3.2 4.5h.1M3.2 8h.1M3.2 11.5h.1"/></svg>',
		spark: '<svg viewBox="0 0 16 16"><path d="M8 2.2l1.4 3.8 3.8 1.4-3.8 1.4L8 12.6 6.6 8.8 2.8 7.4l3.8-1.4z"/></svg>',
		tool: '<svg viewBox="0 0 16 16"><path d="M9.6 2.6a3.4 3.4 0 0 0-3.2 4.5L2.6 10.9l2.5 2.5 3.8-3.8a3.4 3.4 0 0 0 4.5-3.2l-2 2-2.3-.6-.6-2.3z"/></svg>',
	};
	const CHEVRON_ICON = '<svg viewBox="0 0 16 16"><path d="M4.8 6.4L8 9.6l3.2-3.2"/></svg>';

	function toolIcon(name) {
		return TOOL_ICONS[TOOL_FAMILIES[name]] || TOOL_ICONS.tool;
	}

	function humanToolName(name) {
		const known = TOOL_LABELS[name];
		if (known) {
			return known;
		}
		const words = String(name || 'tool').replace(/_/g, ' ').trim() || 'tool';
		return words.charAt(0).toUpperCase() + words.slice(1);
	}

	/** A tool call's arguments as an object; clipped or malformed JSON is simply unknown. */
	function toolArgs(step) {
		if (typeof step.args !== 'string' || !step.args.trim()) {
			return null;
		}
		try {
			const parsed = JSON.parse(step.args);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	/** A shell step's command: sent whole by the host, or read back from the (clipped) args. */
	function shellCommandOf(step) {
		if (step.command) {
			return step.command;
		}
		const parsed = SHELL_TOOL.test(step.name || '') ? toolArgs(step) : null;
		return parsed && typeof parsed.command === 'string' ? parsed.command : '';
	}

	/** The model's title for a shell call, sent whole by the host or read back from the args. */
	function shellDescriptionOf(step) {
		if (step.description) {
			return step.description;
		}
		const parsed = SHELL_TOOL.test(step.name || '') ? toolArgs(step) : null;
		return parsed && typeof parsed.description === 'string' ? parsed.description : '';
	}

	/** One trimmed line, clipped for a header or a summary. */
	function oneLine(text, limit) {
		const clean = String(text || '')
			.replace(/\s+/g, ' ')
			.trim();
		return clean.length > limit ? clean.slice(0, limit) + '…' : clean;
	}

	// Shell words that wrap another command, start a compound statement, or only navigate.
	const SHELL_WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'env', 'nohup', 'time', 'timeout', 'nice', 'ionice', 'stdbuf', 'xargs']);
	const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', 'in', '!', '{', '}', '(', ')']);
	const SHELL_HEADERS = new Set(['if', 'for', 'while', 'until', 'case', 'select', 'function']);
	const SHELL_NAVIGATION = new Set(['cd', 'export', 'set', 'unset', 'source', '.', ':']);
	// Options that take the next word as their value: `sudo -u root apt`, `nice -n 5 npm`.
	const SHELL_FLAG_VALUES = new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '-n', '-c', '-I', '-P', '-s', '-e']);
	const SHELL_REDIRECT = /^(?:\d*[<>]|&>)/;

	/** Unquoted command separators: `;`, newlines, pipes, `&&`, parentheses and background `&`. */
	function shellSegments(command) {
		const text = String(command);
		const segments = [];
		let current = '';
		let quote = '';
		let escaped = false;
		for (let index = 0; index < text.length; index += 1) {
			const char = text[index];
			if (escaped) {
				current += char;
				escaped = false;
				continue;
			}
			if (char === '\\') {
				current += char;
				escaped = true;
				continue;
			}
			if (quote) {
				current += char;
				if (char === quote) {
					quote = '';
				}
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char;
				current += char;
				continue;
			}
			// `2>&1`, `&>file`: the ampersand belongs to the redirection, not to the command chain.
			if (char === '&' && (current.endsWith('>') || current.endsWith('<') || text[index + 1] === '>')) {
				current += char;
				continue;
			}
			if (';\n()|&'.includes(char)) {
				segments.push(current);
				current = '';
				continue;
			}
			current += char;
		}
		segments.push(current);
		return segments;
	}

	/** The words of one simple command; quotes are stripped and redirections are left out. */
	function shellWords(segment) {
		const words = [];
		let current = '';
		let quote = '';
		let escaped = false;
		for (const char of segment) {
			if (escaped) {
				current += char;
				escaped = false;
				continue;
			}
			if (char === '\\') {
				escaped = true;
				continue;
			}
			if (quote) {
				if (char === quote) {
					quote = '';
				} else {
					current += char;
				}
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char;
				continue;
			}
			if (/\s/.test(char)) {
				if (current) {
					words.push(current);
					current = '';
				}
				continue;
			}
			current += char;
		}
		if (current) {
			words.push(current);
		}
		return words.filter((word) => !SHELL_REDIRECT.test(word));
	}

	/**
	 * The utilities a shell command uses, deduplicated in order: `ls, echo, find, sort`. It is the
	 * subtitle of the card, not a parse of the shell — enough to recognize the call at a glance.
	 */
	function shellUtilities(command) {
		const names = [];
		for (const segment of shellSegments(command)) {
			const words = shellWords(segment);
			let index = 0;
			while (index < words.length) {
				const word = words[index];
				if (SHELL_HEADERS.has(word)) {
					// `for x in …`, `if [ … ]`: the segment declares a block, not a command.
					index = words.length;
					break;
				}
				if (SHELL_NAVIGATION.has(word)) {
					// `cd src && …`: navigating is not what the call is about; drop the segment.
					index = words.length;
					break;
				}
				if (SHELL_WRAPPERS.has(word)) {
					index += 1;
					// `timeout 10 npm`: the duration belongs to the wrapper, not to the command.
					if (word === 'timeout' && index < words.length && !words[index].startsWith('-')) {
						index += 1;
					}
					continue;
				}
				if (word.startsWith('-')) {
					index += 1;
					if (SHELL_FLAG_VALUES.has(word) && index < words.length) {
						index += 1;
					}
					continue;
				}
				if (SHELL_KEYWORDS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
					index += 1;
					continue;
				}
				break;
			}
			if (index >= words.length) {
				continue;
			}
			const name = words[index].split('/').pop();
			if (!name || name === '[' || name === 'test' || names.includes(name)) {
				continue;
			}
			names.push(name);
		}
		const head = names.slice(0, 4);
		if (names.length > 4) {
			head.push('…');
		}
		return head.join(', ');
	}

	const SUMMARY_KEYS = ['path', 'file_path', 'file', 'pattern', 'query', 'url', 'question', 'description', 'prompt', 'name', 'id', 'todos'];

	/** The one argument worth showing beside a non-shell tool's title. */
	function argSummary(step, parsed) {
		if (!parsed) {
			return oneLine(step.args || '', 100);
		}
		for (const key of SUMMARY_KEYS) {
			const value = parsed[key];
			if (typeof value === 'string' && value.trim()) {
				return oneLine(value, 100);
			}
			if (typeof value === 'number') {
				return String(value);
			}
			if (Array.isArray(value)) {
				return '[' + value.length + (value.length === 1 ? ' item' : ' items') + ']';
			}
		}
		const fields = Object.entries(parsed).filter(([, value]) => typeof value === 'string' || typeof value === 'number');
		return fields.length ? oneLine(fields.slice(0, 2).map(([key, value]) => key + '=' + value).join(' '), 100) : '';
	}

	/** The first lines a collapsed card previews: output when done, the command while running. */
	function previewOf(step) {
		const source = step.result !== undefined ? step.result : shellCommandOf(step);
		if (!source) {
			return '';
		}
		const lines = String(source)
			.replace(/\r/g, '')
			.replace(/^\n+/, '')
			.replace(/\s+$/, '')
			.split('\n');
		if (!lines.length || (lines.length === 1 && !lines[0])) {
			return '';
		}
		const limit = step.result === undefined ? 2 : 5;
		const head = lines.slice(0, limit).map((line) => (line.length > 240 ? line.slice(0, 240) + '…' : line));
		if (lines.length > limit) {
			head.push('…');
		}
		const text = head.join('\n');
		return step.result === undefined ? '$ ' + text : text;
	}

	/* ------------------------------------------------------------------ images */

	// The host sends image metadata, never the bytes: each id is fetched once and shared by every
	// thumbnail that names it, so a chat with several open panels does not broadcast megabytes.
	const attachmentUrls = new Map();
	const pendingAttachments = new Set();
	const ATTACHMENT_CACHE_LIMIT = 24;

	function requestAttachment(id) {
		if (!id || attachmentUrls.has(id) || pendingAttachments.has(id)) {
			return;
		}
		pendingAttachments.add(id);
		vscode.postMessage({ type: 'attachment', id });
	}

	function imageThumb(part) {
		const img = document.createElement('img');
		img.className = 'thumb';
		img.dataset.attachmentId = part.id;
		img.alt = part.name || 'image';
		img.title = [part.name, part.mime, part.width && part.height ? part.width + '×' + part.height : '']
			.filter(Boolean)
			.join(' · ');
		const url = attachmentUrls.get(part.id);
		if (url) {
			img.src = url;
		} else {
			requestAttachment(part.id);
		}
		return img;
	}

	function imageThumbs(parts) {
		if (!Array.isArray(parts) || !parts.length) {
			return null;
		}
		// A span, not a div: a tool card keeps its pictures inside the <summary>.
		const box = document.createElement('span');
		box.className = 'thumbs';
		for (const part of parts) {
			box.appendChild(imageThumb(part));
		}
		return box;
	}

	/** One attachment's bytes, for every thumbnail that is already waiting on it. */
	function attachmentReply(message) {
		const id = String(message.id || '');
		pendingAttachments.delete(id);
		const url = typeof message.url === 'string' ? message.url : '';
		if (url) {
			attachmentUrls.set(id, url);
			if (attachmentUrls.size > ATTACHMENT_CACHE_LIMIT) {
				const oldest = attachmentUrls.keys().next().value;
				if (oldest !== undefined) {
					attachmentUrls.delete(oldest);
				}
			}
		}
		for (const img of document.querySelectorAll('img.thumb[data-attachment-id="' + CSS.escape(id) + '"]')) {
			if (url) {
				img.src = url;
			} else {
				img.classList.add('missing');
				img.alt = 'image unavailable';
				img.title = 'image unavailable';
			}
		}
	}

	/**
	 * One tool call: a title, a utility summary and a preview of the output while closed; the whole
	 * command (highlighted) and the whole output when open. The preview lives in the summary so it
	 * stays visible while the card is folded; the copy menu is a sibling so it can never toggle it.
	 */
	function toolCard(step) {
		const parsed = toolArgs(step);
		const shell = SHELL_TOOL.test(step.name || '');
		const command = shellCommandOf(step);
		const failed = step.status === 'error' || /^Error:/.test(step.result || '');
		const state = step.result === undefined ? 'running' : failed ? 'error' : 'ok';
		const title = shell ? oneLine(shellDescriptionOf(step), 120) || humanToolName(step.name) : humanToolName(step.name);
		const summary = shell ? shellUtilities(command) || oneLine(command, 100) : argSummary(step, parsed);
		const mode = toolCardMode();
		// `collapsed` is header-only: the preview is not built at all, not merely hidden.
		const preview = mode === 'collapsed' ? '' : previewOf(step);

		const card = document.createElement('div');
		card.className = 'tool-card';
		card.dataset.status = state;
		if (step.name) {
			card.dataset.tool = step.name;
		}

		const details = document.createElement('details');
		details.className = 'tool-details';
		// Set the state before listening: a programmatic open must not be read back as a click.
		// An explicit per-card toggle wins; otherwise the configured mode decides the first state.
		details.open = step._open === undefined ? mode === 'open' : step._open === true;

		const head = document.createElement('summary');
		head.className = 'tool-head';
		head.innerHTML =
			'<span class="tool-head-row">' +
			'<span class="tool-glyph"><span class="spin"></span><span class="tool-icon">' +
			toolIcon(step.name) +
			'</span><span class="tool-chev">' +
			CHEVRON_ICON +
			'</span></span>' +
			'<span class="tool-title">' +
			esc(title) +
			'</span>' +
			(summary ? '<span class="tool-summary">' + esc(summary) + '</span>' : '') +
			'<span class="timer tool-time"></span></span>' +
			(preview ? '<span class="tool-preview"></span>' : '');
		if (preview) {
			// Output is text, never markup: a command may print anything.
			head.querySelector('.tool-preview').textContent = preview;
		}
		// A picture is the answer itself: it stays beside the title whether the card is open or not.
		const thumbs = imageThumbs(step.images);
		if (thumbs) {
			head.appendChild(thumbs);
		}

		const body = document.createElement('div');
		body.className = 'tool-body';
		if (command) {
			const pre = document.createElement('pre');
			pre.className = 'tool-command';
			pre.innerHTML = '<span class="tool-prompt">$ </span><code>' + highlightCode('bash', command) + '</code>';
			body.appendChild(pre);
		} else if (step.args) {
			// Clipped args do not parse; they are still the record, so show them as they came.
			const formatted = parsed && Object.keys(parsed).length ? JSON.stringify(parsed, null, 2) : step.args;
			const pre = document.createElement('pre');
			pre.className = 'tool-args';
			pre.textContent = formatted;
			if (pre.textContent) {
				body.appendChild(pre);
			}
		}
		if (step.result !== undefined) {
			const out = document.createElement('pre');
			out.className = 'tool-out';
			out.textContent = step.result || '(no output)';
			body.appendChild(out);
		}

		details.appendChild(head);
		details.appendChild(body);
		card.appendChild(details);

		const inputText = command || step.args || '';
		if (inputText || step.result) {
			const more = document.createElement('button');
			more.type = 'button';
			more.className = 'tool-more';
			more.setAttribute('aria-haspopup', 'menu');
			more.setAttribute('aria-expanded', 'false');
			more.setAttribute('aria-label', 'Tool actions');
			more.dataset.tip = 'Copy command or output';
			more.textContent = '…';

			const menu = document.createElement('div');
			menu.className = 'tool-menu';
			menu.setAttribute('role', 'menu');
			menu.hidden = true;
			if (inputText) {
				const copy = document.createElement('button');
				copy.type = 'button';
				copy.setAttribute('role', 'menuitem');
				copy.dataset.copy = 'input';
				copy.textContent = command ? 'Copy command' : 'Copy arguments';
				menu.appendChild(copy);
			}
			if (step.result) {
				const copy = document.createElement('button');
				copy.type = 'button';
				copy.setAttribute('role', 'menuitem');
				copy.dataset.copy = 'output';
				copy.textContent = 'Copy output';
				menu.appendChild(copy);
			}
			card.appendChild(more);
			card.appendChild(menu);
		}

		details.addEventListener('toggle', () => {
			step._open = details.open;
		});
		step._card = card;
		step._details = details;
		step._timer = head.querySelector('.tool-time');
		return card;
	}

	/** One element for one step; the single place a thought, a text block or a call is drawn. */
	function stepEl(step, busy) {
		if (step.kind === 'thought') {
			const fold = document.createElement('details');
			fold.className = 'thinking';
			fold.innerHTML =
				'<summary><span class="label">' + (busy ? 'Thinking…' : 'Thought') + '</span><span class="timer"></span></summary><div class="think"></div>';
			fold.querySelector('.think').textContent = step.text || '';
			step._think = fold.querySelector('.think');
			step._summary = fold.querySelector('.label');
			step._timer = fold.querySelector('.timer');
			return fold;
		}
		if (step.kind === 'tool') {
			return toolCard(step);
		}
		// The markdown body is re-rendered on every text delta, so the duration sits beside it in a
		// wrapper rather than inside — otherwise the streaming repaint would wipe its own timer.
		const wrap = document.createElement('div');
		wrap.className = 'step-text';
		const body = document.createElement('div');
		body.className = 'body md';
		body.innerHTML = md(step.text || '');
		wrap.appendChild(body);
		if (step.ms !== undefined || step.at !== undefined) {
			const timer = document.createElement('span');
			timer.className = 'timer step-timer';
			wrap.appendChild(timer);
			step._timer = timer;
		}
		step._body = body;
		return wrap;
	}

	/**
	 * Writes a step's duration: the settled value the host reported, else — while the step is still
	 * running — how long it has been going, so a slow call shows a ticking number rather than a spinner.
	 */
	function paintTimer(step, live, now) {
		if (!step._timer) {
			return;
		}
		const ms = step.ms ?? (live ? now - (step.startedAt ?? now) : undefined);
		step._timer.textContent = ms === undefined ? '' : formatDuration(ms);
	}

	/** Stops a step's clock at the local measurement; the host's number replaces it at `turn-end`. */
	function freeze(step) {
		if (!step) {
			return;
		}
		if (step.ms === undefined && step.startedAt !== undefined) {
			step.ms = Math.max(0, Date.now() - step.startedAt);
		}
		// A thought that nothing is writing any more is a thought that is over: it reads in the past
		// tense from the moment the next step starts, not only once the whole turn ends.
		if (step.kind === 'thought' && step._summary) {
			step._summary.textContent = 'Thought';
		}
	}

	/**
	 * Writes the open buffers to the DOM. Called before a pointer moves on: `paint` runs on the next
	 * frame, and a step closed within the same frame as its last delta would otherwise keep the empty
	 * text it was created with — the whole thought lost because a tool call followed immediately.
	 */
	function flushOpen() {
		paint();
	}

	function appendStep(turn, step, busy) {
		turn._steps.appendChild(stepEl(step, busy));
		return step;
	}

	function renderSteps(turn) {
		const view = currentView();
		turn._steps.innerHTML = '';
		if (view === 'raw') {
			const pre = document.createElement('pre');
			pre.className = 'trace-pre';
			pre.textContent = turnRaw(turn) || '(empty)';
			turn._steps.appendChild(pre);
			return;
		}
		let tools = 0;
		for (const step of turn.steps || []) {
			if (step.kind === 'tool') {
				tools += 1;
				if (view === 'token') {
					continue;
				}
			} else if (view === 'token' && step.kind !== 'text') {
				continue;
			}
			appendStep(turn, step, false);
		}
		if (view === 'token' && tools) {
			const line = document.createElement('p');
			line.className = 'muted';
			line.textContent = tools + (tools === 1 ? ' tool call' : ' tool calls');
			turn._steps.appendChild(line);
		}
		if (!turn._steps.children.length) {
			const empty = document.createElement('p');
			empty.className = 'muted';
			empty.textContent = '(no reply text)';
			turn._steps.appendChild(empty);
		}
		// A turn built from the transcript carries the durations the host measured.
		const now = Date.now();
		for (const step of turn.steps || []) {
			paintTimer(step, false, now);
		}
	}

	/** The turn's dated footer: how long it worked, how many tools it used, what it offers. */
	function renderFoot(turn) {
		const foot = turn._foot;
		if (!foot) {
			return;
		}
		foot.innerHTML = '';
		if (turn.command) {
			return;
		}
		const busy = Boolean(live && live.turn === turn);
		const meta = document.createElement('span');
		meta.className = 'foot-meta';
		if (busy) {
			meta.textContent = 'Working…';
		} else {
			const tools = turnTools(turn);
			const seconds = turn.startedAt && turn.endedAt ? Math.max(0, Math.round((turn.endedAt - turn.startedAt) / 1000)) : 0;
			meta.textContent = [
				turn.stopped ? 'Stopped' : seconds >= 1 ? 'Worked for ' + seconds + 's' : 'Worked',
				tools ? tools + (tools === 1 ? ' tool' : ' tools') : '',
			]
				.filter(Boolean)
				.join(' · ');
		}
		foot.appendChild(meta);
		// More than one variant of the reply: upstream's `‹ n/m ›`, on the turn the variants belong to.
		if (Array.isArray(turn.swipes) && turn.swipes.length > 1) {
			const shown = Math.min(Math.max(turn.swipeId || 0, 0), turn.swipes.length - 1);
			const nav = document.createElement('span');
			nav.className = 'swipes';
			const step = (label, delta, tip, disabled) => {
				const control = document.createElement('button');
				control.type = 'button';
				control.className = 'swipe-step';
				control.textContent = label;
				control.disabled = disabled;
				control.dataset.tip = tip;
				control.addEventListener('click', () => vscode.postMessage({ type: 'setSwipe', turn: turn.index, index: shown + delta }));
				return control;
			};
			const count = document.createElement('span');
			count.className = 'swipe-count';
			count.textContent = shown + 1 + '/' + turn.swipes.length;
			count.dataset.tip = 'This reply has ' + turn.swipes.length + ' versions. Generate another with the ▾ menu or /swipe.';
			nav.append(
				step('‹', -1, 'Previous version', shown === 0),
				count,
				step('›', 1, 'Next version', shown === turn.swipes.length - 1),
			);
			foot.appendChild(nav);
		}
		foot.appendChild(
			actionRow([
				{ key: 'copy', icon: 'copy', tip: 'Copy reply', run: (button) => copyAction(button, turnAnswer(turn) || turnRaw(turn)) },
				{
					key: 'fork',
					icon: 'fork',
					tip: 'Fork chat from here — this turn and everything before it, as a new chat',
					run: () => vscode.postMessage({ type: 'fork', turn: turn.index }),
				},
				{
					key: 'again',
					icon: 'again',
					tip: 'Regenerate — run the last prompt again',
					run: () => vscode.postMessage({ type: 'regenerate', turn: turn.index }),
				},
			]),
		);
	}

	/** Builds the turn's frame: the prompt bubble, the step column and the footer. */
	function turnEl(turn) {
		const root = document.createElement('div');
		root.className = 'turn';
		turn._root = root;
		root._turn = turn;

		const prompt = document.createElement('div');
		prompt.className = 'msg user';
		prompt.innerHTML = '<div class="bubble">' + renderPromptHtml(turn.prompt) + '</div>';
		turn._bubble = prompt.querySelector('.bubble');
		const promptThumbs = imageThumbs(turn.promptImages);
		if (promptThumbs) {
			turn._bubble.appendChild(promptThumbs);
		}
		if (!turn.command) {
			const actions = [{ key: 'copy', icon: 'copy', tip: 'Copy message', run: (button) => copyAction(button, turn.prompt) }];
			if (!turn.greeting && turn.prompt) {
				actions.push({ key: 'edit', icon: 'pencil', tip: 'Edit this prompt and run it again', run: () => beginEdit(turn) });
			}
			prompt.appendChild(actionRow(actions));
		}
		if (turn.greeting) {
			// A character's opening line has no prompt behind it: the bubble would be empty.
			root.classList.add('greeting');
		} else if (turn.prompt || (turn.promptImages && turn.promptImages.length)) {
			// A continuation, an impersonation and a quiet turn have no prompt of their own either —
			// the host sends them with no text, and an empty bubble is not a message. An image-only
			// prompt is a message even though its text is empty.
			root.appendChild(prompt);
		}

		const reply = document.createElement('div');
		reply.className = 'msg assistant';
		const steps = document.createElement('div');
		steps.className = 'steps';
		reply.appendChild(steps);
		const foot = document.createElement('div');
		foot.className = 'foot';
		reply.appendChild(foot);
		root.appendChild(reply);
		turn._steps = steps;
		turn._foot = foot;
		messagesEl.appendChild(root);
		return root;
	}

	/** Closes an open prompt editor, putting the bubble it replaced back. */
	function closeEdit() {
		const restore = editing;
		editing = null;
		if (restore) {
			restore();
		}
	}

	/**
	 * Turns a prompt bubble into an editor. The edit replaces this turn and everything after it, so
	 * the footer count says that before anything is sent; the host asks separately about files.
	 */
	function beginEdit(turn) {
		if (running || (state && state.suspended) || turn.greeting || turn.command || !turn.prompt) {
			return;
		}
		closeEdit();
		const bubble = turn._bubble;
		const message = turn._root && turn._root.querySelector('.msg.user');
		if (!bubble || !message) {
			return;
		}
		const actions = message.querySelector('.msg-actions');
		const original = bubble.innerHTML;
		bubble.classList.add('editing');
		if (actions) {
			actions.hidden = true;
		}
		bubble.innerHTML = '';

		const area = document.createElement('textarea');
		area.className = 'edit-input';
		area.value = turn.prompt;
		area.setAttribute('aria-label', 'Edit prompt');
		bubble.appendChild(area);

		const bar = document.createElement('div');
		bar.className = 'edit-bar';
		const later = turns.filter((item) => item.index > turn.index).length;
		const hint = document.createElement('span');
		hint.className = 'edit-hint';
		hint.textContent = later
			? 'Sending discards this reply and ' + later + ' later turn' + (later === 1 ? '' : 's') + '.'
			: 'Sending replaces this reply.';
		bar.appendChild(hint);

		let restoreBox = null;
		if (turn.files) {
			const label = document.createElement('label');
			label.className = 'edit-restore';
			label.dataset.tip = 'Files the agent wrote since this prompt go back to their earlier content. Shell changes are not tracked.';
			restoreBox = document.createElement('input');
			restoreBox.type = 'checkbox';
			label.append(restoreBox, document.createTextNode(' Restore files too'));
			bar.appendChild(label);
		}

		const restore = () => {
			bubble.classList.remove('editing');
			bubble.innerHTML = original;
			if (actions) {
				actions.hidden = false;
			}
		};
		editing = restore;

		const submit = () => {
			const text = area.value.trim();
			if (!text) {
				area.focus();
				return;
			}
			const restoreFiles = Boolean(restoreBox && restoreBox.checked);
			editing = null;
			restore();
			vscode.postMessage({ type: 'editPrompt', turn: turn.index, text, restoreFiles });
			input.focus();
		};

		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'ghost edit-btn';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', () => {
			editing = null;
			restore();
			input.focus();
		});
		const send = document.createElement('button');
		send.type = 'button';
		send.className = 'primary edit-btn';
		send.textContent = 'Send';
		send.addEventListener('click', submit);
		bar.append(cancel, send);
		bubble.appendChild(bar);

		area.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				submit();
				return;
			}
			if (event.key === 'Escape') {
				// The document's Escape stops a running turn; this one only closes the editor.
				event.preventDefault();
				event.stopPropagation();
				editing = null;
				restore();
				input.focus();
			}
		});
		area.addEventListener('input', () => {
			area.style.height = 'auto';
			area.style.height = Math.min(area.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
		});

		area.focus();
		area.setSelectionRange(area.value.length, area.value.length);
		area.dispatchEvent(new Event('input'));
	}

	/** Only the last turn may be regenerated, and never while a turn is running or without a prompt. */
	function refreshActions() {
		const last = turns.length ? turns[turns.length - 1] : null;
		for (const button of messagesEl.querySelectorAll('.foot .act[data-act="again"]')) {
			button.hidden = !last || button.closest('.turn') !== last._root || running || Boolean(last.greeting);
		}
		const suspended = Boolean(state && state.suspended);
		for (const button of messagesEl.querySelectorAll('.msg.user .act[data-act="edit"]')) {
			const turn = button.closest('.turn')?._turn;
			// An image-only prompt has no text but is still a prompt that can be run again.
		const prompted = Boolean(turn && (turn.prompt || (turn.promptImages && turn.promptImages.length)));
		button.hidden = running || suspended || !turn || Boolean(turn.greeting) || Boolean(turn.command) || !prompted;
		}
	}

	function welcome() {
		add(
			'welcome',
			'<h2>◉ Comonad</h2><p>Ask for a change, a review or an explanation. Tools run against <code>' +
				esc((state && state.workspace) || 'no workspace') +
				'</code>.</p><p class="muted">Type <code>/help</code> for commands. Writes and shell commands ask for approval first.</p>',
		);
	}

	/** Draws a whole transcript: the one path used by a reload, a chat switch and a display change. */
	function renderTurns(list) {
		turns = list || [];
		live = null;
		editing = null;
		toolCards.clear();
		messagesEl.innerHTML = '';
		if (!turns.length) {
			welcome();
		} else {
			for (const turn of turns) {
				turnEl(turn);
				renderSteps(turn);
				renderFoot(turn);
			}
			refreshActions();
		}
		// The whole transcript is drawn at once on open and on a chat switch: the rise animation
		// belongs to a message arriving during a turn, not to a replay of what was already there.
		for (const message of messagesEl.querySelectorAll('.msg')) {
			message.classList.add('no-anim');
		}
		pinned = true;
		scroll(true);
	}

	/* ------------------------------------------------------------------ streaming */

	// A live turn is a turn like any other: events push new steps into it, in order, so a thought
	// that follows a tool call stays after it instead of being folded into one block.

	function beginTurn(message) {
		// A turn started anywhere invalidates an editor that was open on an older prompt.
		closeEdit();
		// An impersonation is not a turn: upstream clears the composer and streams your next message
		// into it, so the chat is left alone until you send it yourself.
		if (message.draft) {
			draft = true;
			live = null;
			input.value = '';
			return;
		}
		// A continue is not a turn of its own: its reply is written into the message it carries on, so
		// that message grows here rather than a second bubble appearing beside it. The host hands over
		// the transcript once the turn is over either way, so the two views always end the same.
		const continuing = message.continues === undefined ? null : turns.find((turn) => turn.index === message.continues);
		if (continuing) {
			continuing.sessionId = continuing.sessionId || message.sessionId;
			const grown = [...(continuing.steps || [])].reverse().find((step) => step.kind === 'text' && step._body);
			live = { turn: continuing, thought: null, text: grown ?? null, think: '', pending: false };
			renderFoot(continuing);
			refreshActions();
			scroll();
			return;
		}
		// An edited prompt replaces its turn and every later one: they are about to be cut from the
		// transcript, so none of them may stay on screen while the replacement streams.
		const from = message.replacesFrom === undefined ? undefined : Number(message.replacesFrom);
		if (from !== undefined && Number.isFinite(from)) {
			for (const removed of turns.filter((turn) => turn.index >= from)) {
				removed._root?.remove();
			}
			turns = turns.filter((turn) => turn.index < from);
		}
		const replacing = turns.find((turn) => turn.index === message.replaces);
		if (replacing) {
			turns = turns.filter((turn) => turn !== replacing);
			replacing._root?.remove();
		}
		if (messagesEl.querySelector('.msg.welcome')) {
			messagesEl.innerHTML = '';
		}
		const last = turns.length ? turns[turns.length - 1] : null;
		const turn = {
			index: from !== undefined && Number.isFinite(from) ? from : last ? last.index + 1 : 0,
			sessionId: message.sessionId,
			// A swipe or a regenerate re-runs the same prompt, and the host sends no text with it.
			prompt: message.text || replacing?.prompt || '',
			promptImages: message.images || replacing?.promptImages || [],
			steps: [],
			at: 0,
			startedAt: Date.now(),
			endedAt: undefined,
			command: false,
			stopped: false,
			files: false,
		};
		turns.push(turn);
		turnEl(turn);
		// The live marker goes up first: the footer reads it to show "Working…" while the turn runs.
		live = { turn, thought: null, text: null, think: '', pending: false };
		renderFoot(turn);
		refreshActions();
		scroll(true);
	}

	/** Writes the buffers of the open steps into the DOM; text is re-rendered as markdown. */
	function paint() {
		if (!live) {
			return;
		}
		live.pending = false;
		if (live.thought) {
			live.thought._think.textContent = live.think;
		}
		if (live.text) {
			live.text._body.innerHTML = md(live.text.text);
		}
		scroll();
	}

	function schedule() {
		if (!live || live.pending) {
			return;
		}
		live.pending = true;
		requestAnimationFrame(() => {
			if (live) {
				paint();
			}
		});
	}

	// One interval for the whole live turn: it walks the open timers so a slow call shows a number
	// that climbs, like the work it stands for. `endTurn` settles every step from the host's numbers.
	let ticker = 0;

	function tick() {
		const paint2 = () => {
			const now = Date.now();
			for (const step of live ? live.turn.steps : []) {
				if (step.ms === undefined && step.startedAt !== undefined) {
					paintTimer(step, true, now);
				}
			}
		};
		paint2();
		if (!ticker) {
			ticker = setInterval(paint2, 100);
		}
	}

	function appendText(text) {
		if (!live) {
			return;
		}
		flushOpen();
		freeze(live.thought);
		live.thought = null;
		if (!live.text) {
			live.text = appendStep(live.turn, { kind: 'text', text: '', startedAt: Date.now(), at: Date.now() }, true);
			live.turn.steps.push(live.text);
			tick();
		}
		live.text.text += text;
		schedule();
	}

	function appendReasoning(text) {
		if (!live) {
			return;
		}
		flushOpen();
		freeze(live.text);
		live.text = null;
		if (!live.thought) {
			live.thought = appendStep(live.turn, { kind: 'thought', text: '', startedAt: Date.now(), at: Date.now() }, true);
			live.turn.steps.push(live.thought);
			tick();
		}
		live.thought.text += text;
		live.think += text;
		schedule();
	}

	function toolStart(message) {
		if (!live) {
			return;
		}
		flushOpen();
		freeze(live.thought);
		freeze(live.text);
		live.thought = null;
		live.text = null;
		const step = appendStep(
			live.turn,
			{
				kind: 'tool',
				id: message.id,
				name: message.name,
				args: message.args || '',
				command: message.command || '',
				description: message.description || '',
				status: 'running',
				startedAt: Date.now(),
				at: Date.now(),
			},
			true,
		);
		live.turn.steps.push(step);
		toolCards.set(message.id, step);
		tick();
		scroll(true);
	}

	function toolResult(message) {
		const step = toolCards.get(message.id);
		if (!step) {
			addNotice(message.output || '');
			return;
		}
		step.result = message.output || '';
		step.images = Array.isArray(message.images) ? message.images : [];
		step.status = /^Error:/.test(step.result) ? 'error' : 'ok';
		freeze(step);
		// A click may not have dispatched its toggle yet: read the live element, then redraw the card
		// in place. `toolCard` stores the new element on the step, so the old one has to be held first
		// or the swapped-out card would replace itself.
		step._open = (step._details && step._details.open) || step._open === true;
		const card = step._card;
		card.replaceWith(toolCard(step));
		paintTimer(step, false, Date.now());
		scroll();
	}

	function endTurn(message) {
		if (!live) {
			return;
		}
		const turn = live.turn;
		paint();
		clearInterval(ticker);
		ticker = 0;
		// The host reports what each step actually cost, so a settled turn reads the same whether it
		// was watched live or reloaded afterwards.
		const settled = Array.isArray(message.steps) ? message.steps : [];
		turn.steps.forEach((step, index) => {
			const report = settled[index];
			if (report && report.kind === step.kind && (report.id ?? '') === (step.id ?? '')) {
				step.ms = report.ms;
			}
		});
		const settledAt = Date.now();
		for (const step of turn.steps) {
			paintTimer(step, true, settledAt);
		}
		// The window too: the footer then reads the same whether it was watched or reloaded.
		turn.startedAt = message.startedAt ?? turn.startedAt;
		turn.endedAt = message.endedAt ?? settledAt;
		turn.stopped = Boolean(message.stopped);
		turn.command = Boolean(message.command);
		// A normal turn is not republished, so this is how a just-finished reply learns an edit of it
		// can offer to restore files (the host computes it from the journal).
		turn.files = message.files === true;
		// A swipe or a regenerate answers with the whole variant list, which is what the ‹ n/m › nav draws.
		if (Array.isArray(message.swipes) && message.swipes.length > 1) {
			turn.swipes = message.swipes;
			turn.swipeId = message.swipeId ?? 0;
		}
		// A folded thought is no longer being written, exactly as on a replayed turn.
		for (const step of turn.steps) {
			if (step._summary) {
				step._summary.textContent = 'Thought';
			}
		}
		// Providers may stream empty thinking chunks; a blank fold is not a step on a replayed turn
		// either, so drop it here rather than let the live turn differ.
		turn.steps = turn.steps.filter((step) => {
			if (step.kind === 'thought' && !(step.text || '').trim()) {
				step._summary?.closest('details')?.remove();
				return false;
			}
			return true;
		});
		live = null;
		if (currentView() !== 'rendered') {
			renderSteps(turn);
		}
		renderFoot(turn);
		refreshActions();
		scroll();
	}

	/* ------------------------------------------------------------------ approvals */

	function approval(message) {
		// A repost after a chat switch or a reload is the same card, not a second question.
		if (document.querySelector('.approval[data-id="' + message.id + '"]')) {
			return;
		}
		const calls = (message.calls || [])
			.map((call) => '<li><b>' + esc(call.name) + '</b><span>' + esc(call.args || '') + '</span></li>')
			.join('');
		const root = document.createElement('div');
		root.className = 'msg approval';
		root.dataset.id = message.id;
		root.dataset.session = message.sessionId || '';
		root.innerHTML =
			'<div class="approval-card"><div class="a-title">⚠ Approval required</div><div class="a-reason">' +
			esc(message.reason || '') +
			'</div><ul class="calls">' +
			calls +
			'</ul><div class="actions"><button class="primary" data-d="allow">Allow once</button><button data-d="always">Always allow</button><button class="ghost" data-d="deny">Deny</button></div></div>';
		// The question belongs to the turn that asked it, so it sits with that turn's steps.
		if (live) {
			live.turn._steps.appendChild(root);
		} else {
			messagesEl.appendChild(root);
		}
		scroll(true);
	}

	/** A stopped turn withdraws its question: the card stays as a record, but nothing can be chosen. */
	function withdrawApprovals(ids) {
		for (const id of ids || []) {
			const card = document.querySelector('.approval[data-id="' + id + '"]');
			if (!card) {
				continue;
			}
			card.classList.add('withdrawn');
			for (const button of card.querySelectorAll('button')) {
				button.disabled = true;
			}
			const actions = card.querySelector('.actions');
			if (actions) {
				actions.innerHTML = '<span class="a-cancelled">Cancelled</span>';
			}
		}
	}

	/* ------------------------------------------------------------------ event delegation */

	/** Clipboard first, the host second: the webview API can be denied where the host's cannot. */
	function copyText(text) {
		if (!text) {
			return;
		}
		Promise.resolve()
			.then(() => navigator.clipboard.writeText(text))
			.catch(() => vscode.postMessage({ type: 'copy', text }));
	}

	function closeToolMenus() {
		let closed = false;
		for (const menu of messagesEl.querySelectorAll('.tool-menu')) {
			if (menu.hidden) {
				continue;
			}
			menu.hidden = true;
			closed = true;
			const more = menu.parentElement.querySelector('.tool-more');
			if (more) {
				more.setAttribute('aria-expanded', 'false');
			}
		}
		return closed;
	}

	function toggleToolMenu(button) {
		const menu = button.parentElement.querySelector('.tool-menu');
		if (!menu) {
			return;
		}
		const open = menu.hidden;
		closeToolMenus();
		menu.hidden = !open;
		button.setAttribute('aria-expanded', String(open));
	}

	function copyToolPart(item) {
		const card = item.closest('.tool-card');
		if (!card) {
			return;
		}
		const text =
			item.dataset.copy === 'input'
				? (card.querySelector('.tool-command code')?.textContent ?? card.querySelector('.tool-args')?.textContent ?? '')
				: (card.querySelector('.tool-out')?.textContent ?? '');
		if (!text) {
			return;
		}
		copyText(text);
		const label = item.textContent;
		item.textContent = 'Copied';
		setTimeout(() => {
			item.textContent = label;
			closeToolMenus();
		}, 700);
	}

	messagesEl.addEventListener('click', (event) => {
		const more = event.target.closest('button.tool-more');
		if (more) {
			event.stopPropagation();
			toggleToolMenu(more);
			return;
		}
		const copied = event.target.closest('.tool-menu button[data-copy]');
		if (copied) {
			event.stopPropagation();
			copyToolPart(copied);
			return;
		}
		closeToolMenus();
		const copy = event.target.closest('button.copy');
		if (copy) {
			const code = copy.closest('.codeblock').querySelector('code');
			copyText(code ? code.textContent : '');
			copy.textContent = 'Copied';
			setTimeout(() => {
				copy.textContent = 'Copy';
			}, 1200);
			return;
		}
		const link = event.target.closest('a[data-url]');
		if (link) {
			event.preventDefault();
			vscode.postMessage({ type: 'openUrl', url: link.dataset.url });
			return;
		}
		const decision = event.target.closest('.approval button[data-d]');
		if (decision && !decision.disabled) {
			const card = decision.closest('.approval');
			for (const button of card.querySelectorAll('button')) {
				button.disabled = true;
			}
			card.classList.add('answered');
			decision.classList.add('chosen');
			vscode.postMessage({ type: 'approve', id: card.dataset.id, decision: decision.dataset.d });
		}
	});

	/* ------------------------------------------------------------------ state & history */

	function setRunning(value) {
		if (value && !running) {
			closeEdit();
			closeMention();
			closeMenus();
			stopping = false;
			$('stop').disabled = false;
			$('stop').textContent = 'Stop';
		}
		if (!value) {
			stopping = false;
			$('stop').disabled = false;
			$('stop').textContent = 'Stop';
		}
		running = value;
		$('send').hidden = value;
		$('stop').hidden = !value;
		// Every generation type is refused while a turn runs; a disabled menu says so up front.
		generationPill.trigger.disabled = value;
		refreshActions();
	}

	/** Stop is acknowledged by the host, but it behaves like a command: one click, then waiting. */
	function requestStop() {
		if (!running || stopping) {
			return;
		}
		stopping = true;
		$('stop').disabled = true;
		$('stop').textContent = 'Stopping…';
		vscode.postMessage({ type: 'stop', sessionId: runningSession });
	}

	function choiceTitle(items, current) {
		const item = (items || []).find((entry) => entry.id === current);
		if (!item) {
			return current || '';
		}
		return item.description ? item.label + ' — ' + item.description : item.label;
	}

	function choiceLabel(items, current) {
		const item = (items || []).find((entry) => entry.id === current);
		return item ? item.label : current || '';
	}

	// Codex-style chat list: folded away until the `comonad.toggleHistory` title-bar icon opens it.
	let chatsOpen = false;
	// The display form the transcript was drawn with; changing it redraws every turn.
	let shownView = '';
	// The tool card mode the transcript was drawn with; changing it also redraws every turn.
	let shownToolCard = '';
	let chatsAll = false;
	let searchQuery = '';
	let searchTimer = 0;
	let searchHits = { query: '', items: [] };

	function ago(at) {
		const minutes = Math.round(Math.max(0, Date.now() - (at || 0)) / 60_000);
		if (minutes < 1) {
			return 'now';
		}
		if (minutes < 60) {
			return minutes + 'm';
		}
		const hours = Math.round(minutes / 60);
		if (hours < 24) {
			return hours + 'h';
		}
		const days = Math.round(hours / 24);
		if (days < 7) {
			return days + 'd';
		}
		const weeks = Math.round(days / 7);
		if (weeks < 5) {
			return weeks + 'w';
		}
		const months = Math.round(days / 30);
		return months < 12 ? months + 'mo' : Math.round(days / 365) + 'y';
	}

	function chatRow(item) {
		const active = item.id === (state && state.sessionId);
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'chat' + (active ? ' is-active' : '');
		row.dataset.tip =
			item.title + '\nUpdated ' + new Date(item.updatedAt).toLocaleString() + ' — click to continue this chat';
		row.innerHTML =
			'<span class="text"><span class="name">' +
			esc(item.title) +
			'</span>' +
			(item.snippet ? '<span class="snippet">' + esc(item.snippet) + '</span>' : '') +
			'</span><span class="ago">' +
			ago(item.updatedAt) +
			'</span>';
		row.addEventListener('click', () => vscode.postMessage({ type: 'switchSession', id: item.id }));
		return row;
	}

	/** Folds the chat list away — clicking outside it, Escape, or losing the panel's focus. */
	function closeChats() {
		if (!chatsOpen) {
			return;
		}
		chatsOpen = false;
		renderChats();
	}

	function renderChats() {
		chatsEl.hidden = !chatsOpen;
		// The list is the whole header: with it closed the panel starts straight at the transcript.
		barEl.hidden = !chatsOpen;
		if (!chatsOpen) {
			return;
		}
		const items = (state && state.sessions) || [];
		chatsList.innerHTML = '';
		if (searchQuery) {
			for (const hit of searchHits.items) {
				chatsList.append(chatRow(hit));
			}
			if (!searchHits.items.length) {
				const empty = document.createElement('p');
				empty.className = 'muted';
				empty.textContent = 'No chats match “' + searchQuery + '”';
				chatsList.append(empty);
			}
			return;
		}
		for (const item of chatsAll ? items : items.slice(0, 3)) {
			chatsList.append(chatRow(item));
		}
		if (items.length > 3 || chatsAll) {
			const more = document.createElement('button');
			more.type = 'button';
			more.id = 'more';
			more.textContent = chatsAll ? 'Show less' : 'View all (' + (state.sessionTotal ?? items.length) + ')';
			more.dataset.tip = chatsAll ? 'Collapse the chat list' : 'Show every chat in this workspace';
			more.addEventListener('click', () => {
				chatsAll = !chatsAll;
				renderChats();
			});
			chatsList.append(more);
			if (chatsAll) {
				const hidden = (state.sessionTotal ?? items.length) - items.length;
				if (hidden > 0) {
					const note = document.createElement('p');
					note.className = 'muted';
					note.textContent = hidden + ' older chat(s) — search to reach them';
					chatsList.append(note);
				}
			}
		}
	}

	function renderState() {
		if (!state) {
			return;
		}
		if (state.sessionId !== shownSession) {
			// A query belongs to the session that was active when it was typed.
			shownSession = state.sessionId;
			closeMention();
		}
		renderChats();
		fillPill(modePill, state.modes, state.mode, 'Work mode — what the agent may do');
		fillPill(approvalPill, state.approvals, state.approval, 'Approval — what runs without asking');
		fillPill(contextPill, CONTEXTS, state.context, 'Context — what this chat sends back to the model');
		fillPill(displayPill, DISPLAYS, currentView(), 'Display — how every turn is shown');
		fillGenerations();
		Object.assign(tavernState, state.tavern || {});
		renderLore();
		// Switching the display form or the tool card mode redraws what is on screen — never during a
		// turn, where the transcript is being written to. A mode change also drops per-card toggles so
		// every card follows the new default.
		const cardMode = toolCardMode();
		const viewChanged = shownView && shownView !== currentView();
		const cardsChanged = shownToolCard && shownToolCard !== cardMode;
		if ((viewChanged || cardsChanged) && !running && !live) {
			if (cardsChanged) {
				for (const turn of turns) {
					for (const step of turn.steps || []) {
						delete step._open;
					}
				}
			}
			renderTurns(turns);
		}
		shownView = currentView();
		if (!running && !live) {
			shownToolCard = cardMode;
		}
		modelState.models = state.models || [];
		modelState.model = state.model;
		modelState.modelLabel = state.modelLabel || state.model || 'auto';
		modelState.reasoningEffort = state.reasoningEffort || 'auto';
		modelState.contextWindow = Number(state.contextWindow) || 0;
		modelState.windowTokens = Number(state.windowTokens) || 0;
		updateModelPill();
		networkChip.classList.toggle('is-on', Boolean(state.network));
		networkChip.dataset.tip =
			'Network — allow network tools and network inside the shell sandbox\nCurrent: ' + (state.network ? 'on' : 'off');
		const noSandbox = state.sandbox === 'none';
		environmentChip.hidden = !noSandbox;
		environmentChip.textContent = noSandbox ? (state.remote ? 'remote · no sandbox' : 'no OS sandbox') : '';
		environmentChip.dataset.tip = noSandbox
			? 'No OS sandbox on this host — shell commands run unconfined.\n' +
				(state.allowUnsandboxedShell
					? 'comonad.allowUnsandboxedShell is on, so they run without a prompt.'
					: 'Every shell call asks for confirmation; set comonad.allowUnsandboxedShell to skip it.')
			: '';
		refreshTip();
		const detail = [state.detail, state.suspended ? '⏸ waiting for approval — send /resume' : ''].filter(Boolean).join('  ·  ');
		$('status').textContent = detail;
		renderTodos();
		if (state.runningSessionId) {
			runningSession = state.runningSessionId;
		}
		setRunning(Boolean(state.running));
	}

	/** The pending or reviewed changes above the composer: a collapsible file list, Cursor-style. */
	let changesOpen = true;
	let pendingChanges = [];
	let reviewedChanges = [];

	function renderChanges(files, reviewed) {
		pendingChanges = Array.isArray(files) ? files : [];
		reviewedChanges = Array.isArray(reviewed) ? reviewed : [];
		// Nothing waiting on a decision: keep the files that were reviewed on screen, in a list that
		// carries no Keep/Undo. As soon as something is pending again, that list is the whole story.
		const showingReviewed = pendingChanges.length === 0 && reviewedChanges.length > 0;
		const items = showingReviewed ? reviewedChanges.map((path) => ({ path, reviewed: true })) : pendingChanges;
		if (!items.length) {
			changesPanel.hidden = true;
			changesTitle.textContent = '';
			changesList.innerHTML = '';
			return;
		}
		changesPanel.hidden = false;
		changesTitle.textContent =
			items.length + (items.length === 1 ? ' File' : ' Files') + (showingReviewed ? ' reviewed' : '');
		changesActions.hidden = showingReviewed;
		changesToggle.textContent = changesOpen ? '▾' : '▸';
		changesToggle.setAttribute('aria-expanded', String(changesOpen));
		changesToggle.dataset.tip = changesOpen ? 'Collapse the changed files' : 'Expand the changed files';
		changesList.hidden = !changesOpen;
		changesList.innerHTML = '';
		for (const file of items) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'change-file';
			row.dataset.path = file.path;
			if (file.reviewed) {
				row.dataset.tip = file.path + ' — reviewed; click to open it';
				row.innerHTML =
					'<span class="change-kind reviewed">✓</span><span class="change-path">' +
					esc(file.path) +
					'</span><span class="change-stats muted">Reviewed</span>';
			} else {
				const flags = [file.changedOutside ? 'changed outside the agent' : '', file.dirty ? 'unsaved in editor' : ''].filter(Boolean);
				row.dataset.tip = flags.length ? file.path + ' — ' + flags.join(' · ') : file.path;
				const kind = file.deleted ? 'D' : file.created ? 'A' : 'M';
				const stats = [];
				if (file.additions) {
					stats.push('<span class="stat-add">+' + file.additions + '</span>');
				}
				if (file.deletions) {
					stats.push('<span class="stat-del">−' + file.deletions + '</span>');
				}
				row.innerHTML =
					'<span class="change-kind ' +
					(file.deleted ? 'deleted' : file.created ? 'created' : 'changed') +
					'">' +
					kind +
					'</span><span class="change-path">' +
					esc(file.path) +
					'</span><span class="change-stats">' +
					(stats.join('') || '<span class="muted">no line changes</span>') +
					'</span>';
			}
			row.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: file.path }));
			changesList.appendChild(row);
		}
	}

	/** What the last turn's world-book scan injected, so the readout mirrors the request. */
	function renderLore() {
		const hits = tavernState.activated || [];
		if (!hits.length) {
			loreChip.hidden = true;
			loreChip.textContent = '';
			return;
		}
		loreChip.hidden = false;
		loreChip.classList.toggle('is-over', tavernState.overflow === true);
		loreChip.textContent = (tavernState.overflow ? '◈⚠ ' : '◈ ') + hits.length + (hits.length === 1 ? ' lore entry' : ' lore entries');
		loreChip.dataset.tip =
			'World-book entries injected into the last turn:\n' +
			hits.join('\n') +
			(tavernState.overflow ? '\n\n⚠ The world-info budget was reached, so later entries were left out.' : '') +
			'\n\nClick to pick the books this chat scans';
	}

	function renderTodos() {
		const list = (state && state.todos) || [];
		const node = $('todos');
		if (!list.length) {
			node.hidden = true;
			node.innerHTML = '';
			return;
		}
		const done = list.filter((todo) => todo.status === 'completed').length;
		const glyph = (status) => (status === 'completed' ? '✔' : status === 'in_progress' ? '◐' : '○');
		node.hidden = false;
		node.innerHTML =
			'<span class="todo-head">Todos ' +
			done +
			'/' +
			list.length +
			'</span>' +
			list
				.slice(0, 6)
				.map((todo) => '<span class="todo ' + esc(todo.status) + '">' + glyph(todo.status) + ' ' + esc(todo.text) + '</span>')
				.join('');
	}

	/* ------------------------------------------------------------------ inbound messages */

	window.addEventListener('message', (event) => {
		const message = event.data;
		switch (message.type) {
			case 'state':
				state = message;
				renderState();
				break;
			case 'toggleHistory':
				// The title-bar icon (comonad.toggleHistory) flips the chat list.
				chatsOpen = !chatsOpen;
				renderChats();
				break;
			case 'changes':
				renderChanges(message.files || [], message.reviewed || []);
				break;
			case 'turns':
				renderTurns(message.turns || []);
				break;
			case 'search':
				// Only the surface that asked renders these hits.
				if (message.query === searchQuery) {
					searchHits = { query: message.query, items: message.items || [] };
					renderChats();
				}
				break;
			case 'mentionResults': {
				if (!mention || mention.mode === 'categories') {
					break;
				}
				if (Number(message.id) !== mention.id || message.kind !== mention.mode || String(message.query ?? '') !== mention.query) {
					break;
				}
				mention.items = Array.isArray(message.items) ? message.items : [];
				mention.hint = typeof message.hint === 'string' ? message.hint : '';
				mention.active = mention.items.length ? 0 : -1;
				renderMention();
				if (mention && mention.autoAccept && mention.items.length === 1) {
					acceptMention(mention.items[0]);
				}
				if (mention) {
					mention.autoAccept = false;
				}
				break;
			}
			case 'command':
				addCommand(message.text);
				break;
			case 'notice':
				addNotice(message.text);
				break;
			case 'turn-start':
				runningSession = message.sessionId || runningSession;
				setRunning(true);
				beginTurn(message);
				break;
			case 'turn-resume': {
				runningSession = message.sessionId || runningSession;
				setRunning(true);
				// A resumed turn is the same turn: keep appending its steps to the last one.
				const turn = turns.length ? turns[turns.length - 1] : null;
				if (turn) {
					turn.sessionId = turn.sessionId || message.sessionId;
					live = { turn, thought: null, text: null, think: '', pending: false };
					renderFoot(turn);
				}
				break;
			}
			case 'text':
				// A draft turn is being written into the composer, not into the transcript: the box grows
				// with the text, and its end stays in view.
				if (draft) {
					input.value += message.text || '';
					input.scrollTop = input.scrollHeight;
				} else {
					appendText(message.text);
				}
				break;
			case 'draft':
				// The finished impersonation as one piece of text, so nothing depends on how it streamed,
				// with the caret where you edit it before sending.
				input.value = message.text || '';
				input.scrollTop = input.scrollHeight;
				input.focus();
				break;
			case 'reasoning':
				appendReasoning(message.text);
				break;
			case 'tool-start':
				toolStart(message);
				break;
			case 'tool-result':
				toolResult(message);
				break;
			case 'attachment':
				attachmentReply(message);
				break;
			case 'approval':
				approval(message);
				break;
			case 'approval-withdraw':
				withdrawApprovals(message.ids);
				break;
			case 'stop-ack':
				if (message.ok === false) {
					stopping = false;
					$('stop').disabled = false;
					$('stop').textContent = 'Stop';
					addNotice('Nothing to stop — the turn already ended.');
				}
				break;
			case 'turn-end': {
				// The panel may have switched chats mid-turn; only settle the live turn it belongs to.
				const mine = !live || !message.sessionId || message.sessionId === live.turn.sessionId;
				setRunning(false);
				runningSession = null;
				// Anything still unanswered in the DOM belongs to the turn that just ended.
				for (const card of document.querySelectorAll('.approval:not(.answered):not(.withdrawn)')) {
					card.classList.add('withdrawn');
					for (const button of card.querySelectorAll('button')) {
						button.disabled = true;
					}
				}
				if (mine) {
					draft = false;
					endTurn(message);
				}
				break;
			}
			case 'insertReference':
				insertReferenceToken(message.token);
				break;
			case 'focus':
				input.focus();
				break;
		}
		scroll();
	});

	/* ------------------------------------------------------------------ @ references */

	const MENTION_CATEGORIES = [
		{ kind: 'mode', mode: 'file', label: 'Files', description: 'Search workspace files' },
		{ kind: 'mode', mode: 'folder', label: 'Folders', description: 'Search workspace folders' },
		{ kind: 'mode', mode: 'symbol', label: 'Symbols', description: 'Search code symbols' },
		{ kind: 'mode', mode: 'selection', label: 'Current selection', description: 'Use the code selected in the editor' },
	];

	/** Whether `@` may start a reference after this character. Mirrors the parser's boundary. */
	function mentionBoundary(previous) {
		return previous === undefined || !/[A-Za-z0-9_.@/\\-]/.test(previous);
	}

	function closeMention() {
		if (!mention) {
			return;
		}
		clearTimeout(mention.timer);
		mention.id += 1;
		mention = null;
		mentionEl.hidden = true;
		mentionHead.hidden = true;
		mentionList.innerHTML = '';
	}

	function mentionRows() {
		return mention ? (mention.mode === 'categories' ? MENTION_CATEGORIES : mention.items) : [];
	}

	function renderMention() {
		if (!mention) {
			mentionEl.hidden = true;
			return;
		}
		mentionEl.hidden = false;
		mentionHead.hidden = mention.mode === 'categories';
		if (mention.mode !== 'categories') {
			const label =
				mention.mode === 'file'
					? 'Files'
					: mention.mode === 'folder'
						? 'Folders'
						: mention.mode === 'symbol'
							? 'Symbols'
							: 'Selection';
			mentionHead.textContent = label + (mention.query ? ' · ' + mention.query : '');
		}
		mentionList.innerHTML = '';
		const rows = mentionRows();
		if (!rows.length) {
			const empty = document.createElement('div');
			empty.className = 'mention-hint';
			empty.textContent = mention.hint || (mention.mode === 'symbol' ? 'Type to search symbols' : 'No matches');
			mentionList.appendChild(empty);
			return;
		}
		mention.active = Math.max(0, Math.min(mention.active, rows.length - 1));
		rows.forEach((item, index) => {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'mention-row' + (index === mention.active ? ' active' : '');
			row.setAttribute('role', 'option');
			row.setAttribute('aria-selected', String(index === mention.active));
			const icon = document.createElement('span');
			icon.className = 'mention-icon';
			icon.textContent =
				item.kind === 'mode' ? '›' : item.kind === 'selection' ? '↔' : item.kind === 'file' ? 'F' : item.kind === 'folder' ? 'D' : 'S';
			const label = document.createElement('span');
			label.className = 'mention-label';
			label.textContent = item.label;
			const detail = document.createElement('span');
			detail.className = 'mention-detail';
			detail.textContent = item.description || '';
			row.append(icon, label, detail);
			if (item.token) {
				row.title = item.token;
			}
			row.addEventListener('mousedown', (event) => event.preventDefault());
			row.addEventListener('mouseenter', () => {
				if (!mention) {
					return;
				}
				mention.active = index;
				for (const other of mentionList.querySelectorAll('.mention-row')) {
					other.classList.toggle('active', other === row);
					other.setAttribute('aria-selected', String(other === row));
				}
			});
			row.addEventListener('click', () => acceptMention(item));
			mentionList.appendChild(row);
		});
		const active = mentionList.querySelector('.mention-row.active');
		if (active) {
			active.scrollIntoView({ block: 'nearest' });
		}
	}

	function requestMention(immediate) {
		if (!mention || mention.mode === 'categories' || mention.composing) {
			return;
		}
		clearTimeout(mention.timer);
		const send = () => {
			if (!mention || mention.mode === 'categories') {
				return;
			}
			mention.id += 1;
			vscode.postMessage({ type: 'mentionQuery', id: mention.id, kind: mention.mode, query: mention.query });
		};
		if (immediate) {
			send();
		} else {
			mention.timer = setTimeout(send, 120);
		}
	}

	function updateMention() {
		if (!mention) {
			return;
		}
		const caret = input.selectionStart;
		if (caret < mention.start + 1) {
			closeMention();
			return;
		}
		const raw = input.value.slice(mention.start + 1, caret);
		if (/\s/.test(raw)) {
			closeMention();
			return;
		}
		mention.caret = caret;
		if (!raw) {
			mention.mode = 'categories';
			mention.query = '';
			mention.items = [];
			mention.hint = '';
			mention.active = 0;
			renderMention();
			return;
		}
		if (raw.startsWith('"') || raw.startsWith('symbol:"')) {
			// A path being typed by hand in Cursor's quoted form: the picker has nothing to add.
			closeMention();
			return;
		}
		let mode = mention.mode;
		let query = raw;
		if (raw.startsWith('symbol:')) {
			mode = 'symbol';
			query = raw.slice('symbol:'.length);
		} else if (mode === 'categories') {
			if (raw.endsWith('/')) {
				mode = 'folder';
				query = raw.slice(0, -1);
			} else {
				mode = 'file';
			}
		} else if (mode === 'symbol') {
			query = raw.startsWith('symbol:') ? raw.slice('symbol:'.length) : raw;
		}
		if (mode === 'selection') {
			query = '';
		}
		if (mode === 'folder' && query.endsWith('/')) {
			query = query.slice(0, -1);
		}
		const changed = mode !== mention.mode || query !== mention.query;
		mention.mode = mode;
		mention.query = query;
		if (changed) {
			mention.active = 0;
			mention.hint = '';
		}
		renderMention();
		if (changed) {
			requestMention(false);
		}
	}

	function openMention(start, caret) {
		closeMention();
		mention = {
			mode: 'categories',
			query: '',
			start,
			caret,
			items: [],
			hint: '',
			active: 0,
			id: 0,
			timer: 0,
			composing: false,
			autoAccept: false,
		};
		renderMention();
		input.focus();
	}

	function acceptMention(item) {
		if (!mention) {
			return;
		}
		if (item.kind === 'mode') {
			mention.mode = item.mode;
			mention.query = '';
			mention.items = [];
			mention.hint = '';
			mention.active = 0;
			mention.autoAccept = item.mode === 'selection';
			renderMention();
			requestMention(true);
			return;
		}
		const after = input.value.slice(mention.caret);
		const suffix = /^\s/.test(after) ? '' : ' ';
		input.setRangeText(item.token + suffix, mention.start, mention.caret, 'end');
		closeMention();
		input.focus();
	}

	function mentionKey(event) {
		if (!mention || event.isComposing || event.keyCode === 229) {
			return false;
		}
		const rows = mentionRows();
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeMention();
			return true;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			if (rows.length) {
				event.preventDefault();
				const delta = event.key === 'ArrowDown' ? 1 : -1;
				mention.active = (mention.active + delta + rows.length) % rows.length;
				renderMention();
			}
			return true;
		}
		if (event.key === 'Enter' || event.key === 'Tab') {
			if (!rows.length) {
				closeMention();
				return false;
			}
			event.preventDefault();
			acceptMention(rows[Math.max(0, Math.min(mention.active, rows.length - 1))]);
			return true;
		}
		return false;
	}

	/** Escapes a prompt and paints @ references as chips; the textarea itself stays raw. */
	function renderPromptHtml(text) {
		const source = String(text ?? '');
		let out = '';
		let last = 0;
		const pattern = /(^|[^A-Za-z0-9_.@/\\-])(@(?:symbol:"[^"]*":[^\s@]+|"[^"]*"(?::\d+(?:-\d+)?|\/)?|symbol:[^\s@]+|[^\s@]+))/g;
		for (const match of source.matchAll(pattern)) {
			const index = match.index ?? 0;
			const start = index + match[1].length;
			out += esc(source.slice(last, start));
			const token = match[2];
			const tailPattern = token.startsWith('@symbol:')
				? /[.,;:!?，。；：！？]+$/
				: /[.,;:!?，。；：！？)\]}）】》」』]+$/;
			const tail = tailPattern.exec(token);
			const tailText = tail ? tail[0] : '';
			const body = tailText ? token.slice(0, -tailText.length) : token;
			out += '<span class="ref-token">' + esc(body) + '</span>' + esc(tailText);
			last = start + token.length;
		}
		out += esc(source.slice(last));
		return out.replace(/\n/g, '<br/>');
	}

	/** Cmd+L from the editor: append the selected range as a token, keeping whatever was typed. */
	function insertReferenceToken(token) {
		const text = String(token ?? '').trim();
		if (!text) {
			return;
		}
		closeMention();
		const at = input.value.length;
		const lead = input.value && !/\s$/.test(input.value) ? ' ' : '';
		input.setRangeText(lead + text + ' ', at, at, 'end');
		input.focus();
		input.scrollTop = input.scrollHeight;
	}

	/* ------------------------------------------------------------------ composer images */

	// The composer holds the pictures locally as data URLs, shows them as chips, and sends them once.
	// The host stores the bytes and returns ids; the transcript then loads them back on demand.
	const MAX_COMPOSER_IMAGES = 6;
	const MAX_COMPOSER_BYTES = 4 * 1024 * 1024;
	const composerImages = [];
	const pendingReads = new Set();

	function renderComposerImages() {
		composerImagesEl.innerHTML = '';
		composerImagesEl.hidden = composerImages.length === 0;
		composerImages.forEach((image, index) => {
			const chip = document.createElement('div');
			chip.className = 'composer-image';
			const img = document.createElement('img');
			img.src = image.dataUrl;
			img.alt = image.name || 'image';
			img.title = image.name || 'image';
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'composer-image-remove';
			remove.textContent = '×';
			remove.title = 'Remove this image';
			remove.addEventListener('click', () => {
				composerImages.splice(index, 1);
				renderComposerImages();
				input.focus();
			});
			chip.append(img, remove);
			composerImagesEl.appendChild(chip);
		});
	}

	function isImageFile(file) {
		if (!file) {
			return false;
		}
		const type = String(file.type || '').toLowerCase();
		const name = String(file.name || '');
		return /^image\/(png|jpeg|jpg|gif|webp)$/.test(type) || (!type && /\.(png|jpe?g|gif|webp)$/i.test(name));
	}

	const MAX_COMPOSER_SIDE = 1568;
	const MAX_COMPOSER_EDIT_BYTES = 1.5 * 1024 * 1024;

	function readDataUrl(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('empty read')));
			reader.onerror = () => reject(reader.error ?? new Error('read failed'));
			reader.readAsDataURL(file);
		});
	}

	/** A screenshot larger than the useful side is re-encoded once here, before it reaches the model. */
	function downscaled(dataUrl) {
		return new Promise((resolve) => {
			const image = new Image();
			image.onload = () => {
				const longest = Math.max(image.width, image.height);
				if ((longest <= MAX_COMPOSER_SIDE && dataUrl.length <= MAX_COMPOSER_EDIT_BYTES) || !longest) {
					resolve(dataUrl);
					return;
				}
				const scale = Math.min(1, MAX_COMPOSER_SIDE / longest);
				const width = Math.max(1, Math.round(image.width * scale));
				const height = Math.max(1, Math.round(image.height * scale));
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				const context = canvas.getContext('2d');
				if (!context) {
					resolve(dataUrl);
					return;
				}
				context.imageSmoothingQuality = 'high';
				context.drawImage(image, 0, 0, width, height);
				// WebP keeps screenshot text crisp at a fraction of PNG's size; Chromium always has it.
				const webp = canvas.toDataURL('image/webp', 0.92);
				resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.9));
			};
			image.onerror = () => resolve(dataUrl);
			image.src = dataUrl;
		});
	}

	function addImageFile(file) {
		if (!isImageFile(file)) {
			return;
		}
		if (composerImages.length >= MAX_COMPOSER_IMAGES) {
			addNotice('Only ' + MAX_COMPOSER_IMAGES + ' images can be attached to one message.');
			return;
		}
		if (file.size > MAX_COMPOSER_BYTES) {
			addNotice('An image is over the 4 MiB limit and was not attached.');
			return;
		}
		const read = (async () => {
			try {
				const dataUrl = await readDataUrl(file);
				const prepared = await downscaled(dataUrl);
				const name =
					prepared === dataUrl
						? file.name || 'image'
						: 'image.' + (prepared.startsWith('data:image/webp') ? 'webp' : 'jpg');
				composerImages.push({ name, dataUrl: prepared });
				renderComposerImages();
			} catch {
				addNotice('An image could not be read.');
			}
		})();
		pendingReads.add(read);
		read.finally(() => pendingReads.delete(read));
	}

	/* ------------------------------------------------------------------ outbound actions */

	let submitting = false;
	async function submit() {
		if (running) {
			addNotice('A turn is still running in this chat — press Stop or wait for it to finish.');
			return;
		}
		if (submitting) {
			return;
		}
		submitting = true;
		try {
			// A read still in flight is part of what is being sent.
			if (pendingReads.size) {
				await Promise.all([...pendingReads]);
			}
			const text = input.value.trim();
			if (!text && !composerImages.length) {
				return;
			}
			closeMention();
			const images = composerImages.map((image) => ({ name: image.name, data: image.dataUrl }));
			input.value = '';
			composerImages.length = 0;
			renderComposerImages();
			vscode.postMessage({ type: 'send', text, images });
			input.focus();
		} finally {
			submitting = false;
		}
	}

	/** Runs one of the generation types. `Normal` is Send; `Quiet` uses what is in the box. */
	function runGeneration(trigger) {
		if (running) {
			addNotice('A turn is still running in this chat — press Stop or wait for it to finish.');
			return;
		}
		closeMention();
		if (trigger === 'normal') {
			submit();
			return;
		}
		// Quiet is the one type with a prompt of its own, and it is the one the host refuses when the
		// box is empty — so the box is emptied here and the answer comes back as a notice.
		const text = trigger === 'quiet' ? input.value.trim() : '';
		if (trigger === 'quiet') {
			input.value = '';
		}
		vscode.postMessage({ type: 'generate', trigger, text });
		input.focus();
	}

	function fillGenerations() {
		const items = state?.generations || [];
		if (!items.length || generationPill.menu.dataset.filled === 'yes') {
			return;
		}
		generationPill.menu.dataset.filled = 'yes';
		for (const item of items) {
			generationPill.menu.append(
				choiceRow({ id: item.value, label: item.label, description: GENERATION_TIPS[item.value] }, '', () => runGeneration(item.value), generationPill),
			);
		}
	}

	$('send').addEventListener('click', submit);
	$('stop').addEventListener('click', requestStop);
	input.addEventListener('keydown', (event) => {
		if (mention && event.key === 'Enter' && event.shiftKey) {
			closeMention();
			return;
		}
		if (mentionKey(event)) {
			return;
		}
		if (event.key === 'Enter' && !event.shiftKey) {
			if (event.isComposing) {
				return;
			}
			event.preventDefault();
			submit();
		}
	});
	// Paste and drop are image input only when they carry a picture; ordinary text paste stays native.
	input.addEventListener('paste', (event) => {
		const files = [];
		for (const item of event.clipboardData?.items ?? []) {
			if (item.kind !== 'file') {
				continue;
			}
			const file = item.getAsFile();
			if (file && isImageFile(file)) {
				files.push(file);
			}
		}
		if (!files.length) {
			return;
		}
		event.preventDefault();
		for (const file of files) {
			addImageFile(file);
		}
	});
	const editorEl = $('editor');
	editorEl.addEventListener('dragover', (event) => {
		const types = Array.from(event.dataTransfer?.types ?? []);
		if (!types.includes('Files')) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
	});
	editorEl.addEventListener('drop', (event) => {
		const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile);
		if (!files.length) {
			return;
		}
		event.preventDefault();
		for (const file of files) {
			addImageFile(file);
		}
	});
	input.addEventListener('input', (event) => {
		if (mention) {
			updateMention();
			return;
		}
		if (event.isComposing || event.inputType !== 'insertText' || event.data !== '@') {
			return;
		}
		const caret = input.selectionStart;
		const at = caret - 1;
		if (
			at >= 0 &&
			input.value[at] === '@' &&
			mentionBoundary(at === 0 ? undefined : input.value[at - 1]) &&
			input.value[at + 1] !== '"'
		) {
			openMention(at, caret);
		}
	});
	input.addEventListener('compositionstart', () => {
		if (mention) {
			mention.composing = true;
		}
	});
	input.addEventListener('compositionend', () => {
		if (mention) {
			mention.composing = false;
			updateMention();
		}
	});
	document.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') {
			return;
		}
		if (mention) {
			closeMention();
			return;
		}
		if (!modelFlyout.hidden) {
			hideFlyout();
			return;
		}
		if (closeToolMenus() || closeMenus()) {
			return;
		}
		if (chatsOpen) {
			closeChats();
			return;
		}
		// Escape only stops a running turn; with nothing running it must not poison the next one.
		if (running) {
			requestStop();
		}
	});
	// The header controls (recent chats, settings, new session) are title-bar commands now.
	// Searching goes through the extension, which also matches message text.
	searchBox.addEventListener('input', () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			searchQuery = searchBox.value.trim();
			vscode.postMessage({ type: 'search', query: searchQuery });
		}, 140);
	});
	searchBox.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') {
			return;
		}
		event.stopPropagation();
		if (!searchBox.value) {
			closeChats();
			return;
		}
		searchBox.value = '';
		searchQuery = '';
		searchHits = { query: '', items: [] };
		renderChats();
	});
	networkChip.addEventListener('click', () => vscode.postMessage({ type: 'toggleNetwork' }));
	changesToggle.addEventListener('click', () => {
		changesOpen = !changesOpen;
		renderChanges(pendingChanges, reviewedChanges);
	});
	$('changes-undo').addEventListener('click', () => vscode.postMessage({ type: 'undoAll' }));
	$('changes-keep').addEventListener('click', () => vscode.postMessage({ type: 'keepAll' }));
	$('changes-review').addEventListener('click', () => vscode.postMessage({ type: 'review' }));
	loreChip.addEventListener('click', () => vscode.postMessage({ type: 'lorebooks' }));

	/* ------------------------------------------------------------------ focus */

	// The host turns this into the `comonad.chatFocused` context key. A chord pressed inside a
	// webview is resolved against the workbench's root context, where the part-scoped keys
	// (`auxiliaryBarFocus`, `focusedView`) are out of scope — so the guest is the only reliable
	// witness that the keyboard is in the chat, which is what scopes Cmd+N to the chat.
	const reportFocus = (focused) => vscode.postMessage({ type: 'focusState', focused });
	window.addEventListener('focus', () => reportFocus(true));
	window.addEventListener('blur', () => reportFocus(false));
	document.addEventListener('focusin', () => reportFocus(true));
	document.addEventListener('mousedown', () => reportFocus(true));
	document.addEventListener('visibilitychange', () => reportFocus(document.hasFocus() && document.visibilityState === 'visible'));

	vscode.postMessage({ type: 'ready' });
	input.focus();
	reportFocus(document.hasFocus());
})();
