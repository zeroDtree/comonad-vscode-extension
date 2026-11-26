// SPDX-License-Identifier: AGPL-3.0-only
// Comonad chat panel — runs inside the VS Code webview, talks to the extension over postMessage.
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const $ = (id) => document.getElementById(id);
	const messagesEl = $('messages');
	const input = $('input');
	const composerPastesEl = $('composer-pastes');
	const composerImagesEl = $('composer-images');
	const mentionEl = $('mention');
	const mentionHead = $('mention-head');
	const mentionList = $('mention-list');
	const environmentChip = $('environment');
	const changesPanel = $('changes-panel');
	const changesHead = $('changes-head');
	const changesTitle = $('changes-title');
	const changesList = $('changes-list');
	const changesToggle = $('changes-toggle');
	const changesActions = $('changes-actions');
	const barEl = $('bar');
	const chatsEl = $('chats');
	const chatsList = $('chats-list');
	const searchBox = $('search');
	const scopeButton = $('chats-scope');
	const jumpButton = $('jump-latest');
	const tip = $('tip');

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
		if (planMenuState && !event.target.closest?.('.plan-menu') && !event.target.closest?.('.plan-trigger')) {
			closePlanMenu(false);
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
		closePlanMenu(false);
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

	const modePill = setupPill('mode', (mode) => {
		// The card's build default follows the pick at once; the next host state confirms it.
		if (state) {
			state.mode = mode;
		}
		syncPlanCards();
		vscode.postMessage({ type: 'setMode', mode });
	});
	// The generation menu is not a setting: every entry runs a generation of that type. The host owns
	// the list (and its wording).
	const GENERATION_TIPS = {
		normal: 'answer the text in the box',
		continue: 'carry the last message on from where it stops',
		impersonate: 'write your next message for you',
		swipe: 'another version of the last reply, keeping the one you are reading',
		regenerate: 'the last reply again',
		quiet: 'a private reply with read-only tools, never added to the chat',
	};
	const generationPill = setupPill('generate', () => undefined);
	const approvalPill = setupPill('approval', (approval) => vscode.postMessage({ type: 'setApproval', approval }));
	const sandboxPill = setupPill('sandbox', (sandboxMode) => vscode.postMessage({ type: 'setSandboxMode', sandboxMode }));

	/* The model pill: Reasoning effort, Context budget and Model, Cursor-style. */

	const REASONING = [
		{ id: 'auto', label: 'Auto', description: 'use the provider default' },
		{ id: 'none', label: 'Off', description: 'answer without extra thinking, where the model allows it' },
		{ id: 'low', label: 'Low', description: 'a quick pass of thinking' },
		{ id: 'medium', label: 'Medium', description: 'balanced thinking' },
		{ id: 'high', label: 'High', description: 'deep thinking for hard work' },
		{ id: 'max', label: 'Max', description: 'the deepest thinking the endpoint offers, at the highest cost' },
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
			// The card's build default follows the pick at once; the next host state confirms it.
			if (state && typeof value === 'string') {
				state.model = value;
			}
			syncPlanCards();
			vscode.postMessage({ type: 'setModel', model: value });
		}
	});

	const modelState = {
		models: [],
		model: '',
		modelLabel: 'auto',
		reasoningEffort: 'auto',
		reasoningEffortResolved: '',
		contextWindow: 0,
		windowTokens: 0,
	};

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

	/** The rows of one page. Kept apart from placement so a list that lands while the flyout is open can refill it. */
	function fillFlyout(page) {
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
	}

	function showFlyout(page, row) {
		clearTimeout(flyoutShowTimer);
		clearTimeout(flyoutHideTimer);
		hideTip();
		flyoutPage = page;
		fillFlyout(page);
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

	/** The Reasoning value, plus the endpoint's ceiling when the pick is above it. */
	function reasoningValue() {
		const label = choiceLabel(REASONING, modelState.reasoningEffort);
		const resolved = modelState.reasoningEffortResolved;
		return resolved && resolved !== modelState.reasoningEffort && resolved !== 'auto' ? label + ' → ' + resolved : label;
	}

	function renderModelMenu() {
		const menu = modelPill.menu;
		menu.innerHTML = '';
		menu.append(flyoutRow('reasoning', 'Reasoning', reasoningValue()));
		menu.append(flyoutRow('context', 'Context window', formatLimit(modelState.contextWindow)));
		menu.append(flyoutRow('model', 'Model', modelState.modelLabel));
	}

	function updateModelPill() {
		// The pill reads out the two things the menu picks at a glance: which model, and how hard
		// it is asked to think. The effort is secondary, so it is dimmed rather than merged into
		// the model name.
		const effort = choiceLabel(REASONING, modelState.reasoningEffort);
		modelPill.trigger.querySelector('.pill-label').innerHTML =
			esc(modelState.modelLabel) + '<span class="pill-effort">· ' + esc(effort) + '</span>';
		modelPill.trigger.dataset.tip =
			'Model — the model for new turns\nCurrent: ' + modelState.modelLabel + ' · Reasoning: ' + effort;
		if (!modelPill.menu.hidden) {
			renderModelMenu();
		}
	}

	modelPill.onOpen = () => {
		renderModelMenu();
	};

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
	/** The subagent conversation requested or on screen, if any. */
	let subagentView = null;
	let subagentWanted = null;
	/** Tool cards opened in the overlay, so a step update does not fold them again. */
	const subagentOpen = new Map();
	/** The overlay always renders the full work process, whatever the chat's display form is. */
	let subagentRendering = false;
	/** The Task Graph payload on screen, and whether its modal is open or requested. */
	let taskGraphView = null;
	let taskGraphWanted = false;
	let taskGraphShown = false;
	let taskGraphTick = 0;

	/* ------------------------------------------------------------------ markdown */

	const esc = (s) =>
		String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

	/**
	 * Markdown is rendered by the `resources/markdown.js` bundle loaded before this script: CommonMark
	 * blocks and inlines, the `.codeblock` markup and the optional math hooks all live there. The
	 * fallback keeps the transcript readable if the bundle ever fails to load.
	 */
	function md(src) {
		const api = globalThis.__comonadMarkdown;
		if (api && typeof api.render === 'function') {
			try {
				return api.render(String(src));
			} catch {
				// Fall through to escaped text: a renderer failure must not blank the message.
			}
		}
		const text = String(src);
		return text ? '<p>' + esc(text).replace(/\n/g, '<br/>') + '</p>' : '';
	}

	/** The same bundle owns the highlighter the tool cards use for a command line. */
	function highlightCode(lang, code) {
		const api = globalThis.__comonadMarkdown;
		if (api && typeof api.highlightCode === 'function') {
			try {
				return api.highlightCode(String(lang || ''), String(code ?? ''));
			} catch {
				// Fall through to the plain source.
			}
		}
		return esc(String(code ?? ''));
	}

	/* ------------------------------------------------------------------ message bricks */

	/** The transcript follows the newest output only while the reader is still at the end. */
	function scroll(force) {
		if (force || pinned) {
			pinned = true;
			messagesEl.scrollTop = messagesEl.scrollHeight;
		}
		paintJump();
	}

	/** The way back: shown exactly when the transcript has stopped following the end. */
	function paintJump() {
		jumpButton.hidden = pinned;
	}

	// What the reader last saw, so a scroll the content itself caused is not read as the reader
	// scrolling away.
	let lastHeight = messagesEl.scrollHeight;
	let lastTop = messagesEl.scrollTop;

	messagesEl.addEventListener('scroll', () => {
		if (planMenuState) {
			closePlanMenu(false);
		}
		const height = messagesEl.scrollHeight;
		const top = messagesEl.scrollTop;
		const distance = height - top - messagesEl.clientHeight;
		// A picture decoding above the reader grows the transcript, and scroll anchoring moves the
		// offset to hold their place; that scroll event is not the reader leaving the end. Only growth
		// that moved the offset down (never a wheel, which unpins first) keeps the transcript following.
		const grew = height > lastHeight && top >= lastTop;
		lastHeight = height;
		lastTop = top;
		if (distance < 8) {
			// A few pixels of slack, not a screen line: reading the last lines while a reply streams is
			// exactly when the transcript must stop moving under the pointer.
			pinned = true;
		} else if (pinned && grew) {
			scroll(true);
			return;
		} else {
			pinned = false;
		}
		paintJump();
	});

	// The footer (todos, the changes panel) and the panel's own size take room from the transcript
	// without scrolling it: a reader at the end keeps seeing the end.
	if (typeof ResizeObserver === 'function') {
		const follow = new ResizeObserver(() => scroll());
		follow.observe(messagesEl);
		const footerEl = document.querySelector('footer');
		if (footerEl) {
			follow.observe(footerEl);
		}
	}

	// A wheel turned upward unpins before its scroll event lands, so a token painted in the same
	// frame cannot snap the reader back to the bottom first.
	messagesEl.addEventListener(
		'wheel',
		(event) => {
			if (event.deltaY < 0) {
				pinned = false;
				paintJump();
			}
		},
		{ passive: true },
	);

	let touchY = 0;
	messagesEl.addEventListener(
		'touchstart',
		(event) => {
			touchY = event.touches[0]?.clientY ?? 0;
		},
		{ passive: true },
	);
	messagesEl.addEventListener(
		'touchmove',
		(event) => {
			const y = event.touches[0]?.clientY ?? 0;
			if (y > touchY) {
				pinned = false;
				paintJump();
			}
			touchY = y;
		},
		{ passive: true },
	);

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
		for (const { key, icon, label, tip, run } of actions) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = label === undefined ? 'act' : 'act text';
			button.dataset.act = key;
			button.dataset.tip = tip;
			if (label === undefined) {
				button.innerHTML = ICONS[icon];
			} else {
				button.textContent = label;
			}
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

	/*
	 * A quiet reply is never written to the transcript, so it cannot live in a turn: the host repaints
	 * the transcript on its own (a resync, a chat switch, a display change) and `renderTurns` empties
	 * `#messages`. The last reply of each chat is kept here instead, and drawn again after every
	 * redraw until the reader copies or dismisses it.
	 */
	const quietReplies = new Map();

	/**
	 * The steps of the quiet turn that just streamed, keyed by chat, waiting for the `quiet-reply`
	 * that carries its final text. The bubble is dropped at `turn-end` and the transcript never held
	 * it, so this is the only place where the process behind a quiet answer survives.
	 */
	const pendingQuiet = new Map();

	/**
	 * What a quiet turn is worth keeping: its thoughts and the calls it really made. The final text
	 * comes separately in `quiet-reply`, so a text step would only duplicate it; a compaction note is
	 * not something the reader asked to see.
	 */
	function keptQuietSteps(turn) {
		const kept = [];
		for (const step of turn.steps || []) {
			// A step still open here (the turn ended around it) has no settled duration yet: freeze it
			// locally so the card shows a number rather than a blank.
			if (step.kind === 'thought') {
				freeze(step);
				kept.push({
					kind: 'thought',
					text: step.text || '',
					ms: step.ms,
					tokens: step.tokens ?? estimateThoughtTokens(step.text || ''),
				});
			} else if (step.kind === 'tool') {
				freeze(step);
				kept.push({
					kind: 'tool',
					id: step.id,
					name: step.name,
					args: step.args,
					command: step.command,
					description: step.description,
					result: step.result,
					status: step.status,
					images: step.images,
					plan: step.plan,
					subagentId: step.subagentId,
					ms: step.ms,
					tokens: step.tokens,
				});
			}
		}
		return kept;
	}

	function quietCard(id, entry) {
		const el = document.createElement('div');
		el.className = 'msg quiet-reply';
		const label = document.createElement('div');
		label.className = 'quiet-label';
		label.textContent = 'Quiet · not added to the chat';
		label.dataset.tip = 'A quiet reply is never written to the transcript. Copy it here if you want to keep it.';
		// The thoughts and tool calls that led to the reply are the process behind it: they are drawn
		// with the same builders a written turn uses, from the steps harvested before the bubble went.
		// They are a snapshot, not a transcript, so they carry no live clock of their own.
		const steps = document.createElement('div');
		steps.className = 'steps quiet-steps';
		const now = Date.now();
		for (const step of entry.steps || []) {
			steps.appendChild(stepEl(step, false));
			paintTimer(step, false, now);
		}
		const body = document.createElement('div');
		body.className = 'body md quiet-body';
		body.innerHTML = md(entry.text || '(no reply)');
		el.append(
			label,
			...(steps.children.length ? [steps] : []),
			body,
			actionRow([
				{ key: 'copy', icon: 'copy', tip: 'Copy this reply', run: (button) => copyAction(button, entry.text) },
				{
					key: 'dismiss',
					label: 'Dismiss',
					tip: 'Forget this quiet reply',
					run: () => {
						quietReplies.delete(id);
						el.remove();
					},
				},
			]),
		);
		return el;
	}

	/** Draws the shown chat's quiet reply, if it has one: called after every transcript redraw. */
	function renderQuietReply(sessionId) {
		messagesEl.querySelector('.msg.quiet-reply')?.remove();
		const id = String(sessionId || '');
		const entry = id ? quietReplies.get(id) : undefined;
		if (entry) {
			messagesEl.appendChild(quietCard(id, entry));
		}
	}

	/* ------------------------------------------------------------------ turns */

	// The transcript is a list of turns: one prompt plus the steps the agent took for it — its
	// thoughts, its text and its tool calls, in the order they happened. A live turn is built with
	// the same builders a replayed one is, so what you watch streaming is what a reload shows, and
	// a turn is never split in two by a refresh.

	let turns = [];
	let live = null;
	/** The current model-context summary, as sent by the host; `null` when the chat has none. */
	let summaryInfo = null;
	/** The loaded page: where it starts, how many turns exist, and whether older turns remain. */
	let pageInfo = { firstTurnIndex: undefined, totalTurns: 0, hasMore: false };
	/** An impersonation is being written into the composer rather than into a turn of the chat. */
	let draft = false;
	/** The open prompt editor's restore function, if one is open. */
	let editing = null;

	/** Long prompts fold by default; this remembers the ones the reader opened, across redraws. */
	const promptOpen = new Set();
	const PROMPT_CLAMP_CHARS = 1_200;
	const PROMPT_CLAMP_LINES = 18;

	/** `sessionId:index` is stable across renderTurns, prependTurns and resyncs that replace turn objects. */
	function promptStateKey(turn) {
		return String(turn.sessionId || (state && state.sessionId) || '') + ':' + turn.index;
	}

	function promptIsLong(turn) {
		const text = String(turn.prompt || '');
		return text.length > PROMPT_CLAMP_CHARS || text.split('\n').length > PROMPT_CLAMP_LINES;
	}

	/** Applies the remembered state to a freshly drawn bubble and its action-row button. */
	function applyPromptState(turn, button) {
		const long = promptIsLong(turn);
		const open = long && promptOpen.has(promptStateKey(turn));
		if (turn._bubble) {
			turn._bubble.classList.toggle('collapsed', long && !open);
		}
		if (button) {
			button.hidden = !long;
			button.textContent = open ? 'Show less' : 'Show more';
			button.setAttribute('aria-expanded', String(open));
			button.dataset.tip = open ? 'Collapse this prompt' : 'Show the full prompt';
		}
	}

	function togglePrompt(turn, button) {
		const key = promptStateKey(turn);
		if (promptOpen.has(key)) {
			promptOpen.delete(key);
		} else {
			promptOpen.add(key);
		}
		applyPromptState(turn, button);
	}

	function currentView() {
		if (subagentRendering) {
			return 'rendered';
		}
		return state && (state.display === 'token' || state.display === 'raw') ? state.display : 'rendered';
	}

	/** How a tool card starts: header only (the default), with its preview, or open. */
	function toolCardMode() {
		return state && (state.toolCard === 'preview' || state.toolCard === 'open') ? state.toolCard : 'collapsed';
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
				if (step.kind === 'note' && step.note) {
					const note = step.note;
					const share = note.window > 0 ? Math.round((note.after / note.window) * 100) : 0;
					return (
						'Compaction\n' +
						note.folded +
						' earlier message' +
						(note.folded === 1 ? '' : 's') +
						' · ' +
						formatTokens(note.before) +
						' → ' +
						formatTokens(note.after) +
						' tokens · ' +
						share +
						'% of the ' +
						formatTokens(note.window) +
						' window\n' +
						(note.summary || '')
					);
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
		edit_text: 'Edit text',
		edit_ranges: 'Edit ranges',
		find_files: 'Find files',
		find_symbols: 'Find symbols',
		get_diagnostics: 'Get diagnostics',
		git_diff: 'Read git diff',
		run_task: 'Run task',
		fetch_url: 'Fetch URL',
		web_search: 'Search the web',
		ask_user: 'Ask you',
		agent: 'Run agent',
		delegate: 'Delegate tasks',
		task_graph: 'Record task graph',
		task_status: 'Task status',
		message: 'Coordination note',
		skill: 'Run skill',
		memory: 'Use memory',
		todo_write: 'Update todos',
		list_plans: 'List plans',
		read_plan: 'Read plan',
		write_plan: 'Write plan',
		edit_plan: 'Edit plan',
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
		edit_text: 'pencil',
		edit_ranges: 'pencil',
		write_plan: 'pencil',
		edit_plan: 'pencil',
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
	// Two arrows closing on a line: a request folded onto the summary that stands in for it.
	const COMPACTION_ICON = '<svg viewBox="0 0 16 16"><path d="M2.8 5.4L5.2 8l-2.4 2.6"/><path d="M13.2 5.4L10.8 8l2.4 2.6"/><path d="M5.8 8h4.4"/></svg>';

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

	/* ------------------------------------------------------------------ delegation cards */

	/** The task ids a delegate/resume call named, read back from its (possibly clipped) args. */
	function taskIdsOf(step) {
		const parsed = toolArgs(step);
		return parsed && Array.isArray(parsed.tasks)
			? parsed.tasks.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
			: [];
	}

	/** The board glyph for a task status; the same mapping drives the footer and a card. */
	function taskGlyph(status) {
		return status === 'accepted'
			? '✔'
			: status === 'rejected'
				? '✕'
				: status === 'running'
					? '◐'
					: status === 'verifying'
						? '◑'
						: status === 'paused'
							? '⏸'
							: '○';
	}

	/** The word after a task id: the rejection code when one exists, so `stopped` is not `coder`. */
	function taskStateLabel(task) {
		if (!task) {
			return '';
		}
		if (task.status === 'rejected') {
			return (task.rejection && task.rejection.code) || 'rejected';
		}
		return task.status;
	}

	/** A task chip's tooltip: title, role/status, writes and the exact rejection. */
	function taskTip(task) {
		if (!task) {
			return '';
		}
		return [
			task.title,
			task.role + ' · ' + task.status,
			task.writes && task.writes.length ? 'writes: ' + task.writes.join(', ') : '',
			task.rejection ? task.rejection.code + ': ' + task.rejection.reason : '',
		]
			.filter(Boolean)
			.join('\n');
	}

	function taskButton(id, label, tip) {
		return (
			'<button type="button" class="tool-open-subagent" data-subagent="' +
			esc(id) +
			'" data-tip="' +
			esc(tip) +
			'">' +
			esc(label) +
			'</button>'
		);
	}

	/**
	 * The task state a delegate/resume card carries: its node, the worker's session and the last
	 * verifier. The worker finishing is not the delegation finishing, so the node's own status is
	 * the headline, not the child's `finished` flag.
	 */
	function delegationBadges(ids, fallbackId) {
		const board = state && state.taskBoard && Array.isArray(state.taskBoard.nodes) ? state.taskBoard.nodes : [];
		const nodes = ids.map((id) => board.find((node) => node.id === id)).filter(Boolean);
		if (!nodes.length) {
			return fallbackId ? taskButton(fallbackId, 'Open session', 'Open the subagent session') : '';
		}
		const shown = nodes.slice(0, 3);
		const hidden = nodes.length - shown.length;
		const badges = shown
			.map((task) => {
				const verifier = (task.verificationSessionIds || []).slice(-1)[0];
				const worker = task.subagentSessionId
					? taskButton(task.subagentSessionId, 'Open ' + task.role, 'Open the ' + task.role + ' session')
					: '';
				const verify =
					verifier && verifier !== task.subagentSessionId ? taskButton(verifier, 'Verify', 'Open the verifier session') : '';
				const verifiers = task.status === 'verifying' ? (task.verificationSessionIds || []).length : 0;
				const label =
					taskStateLabel(task) +
					(task.status === 'verifying'
						? verifiers
							? ' · ' + verifiers + (verifiers === 1 ? ' verifier' : ' verifiers')
							: ' · awaiting verifier'
						: '');
				return (
					'<span class="delegation ' +
					esc(task.status) +
					'" data-tip="' +
					esc(taskTip(task)) +
					'">' +
					taskGlyph(task.status) +
					' <span class="delegation-name">' +
					esc(task.id) +
					' · ' +
					esc(label) +
					'</span>' +
					worker +
					verify +
					'</span>'
				);
			})
			.join('');
		return hidden > 0
			? badges +
					'<span class="delegation-more" data-tip="' +
					esc(nodes.map((task) => task.id).join('\n')) +
					'">+' +
					hidden +
					' more</span>'
			: badges;
	}

	/** Repaints every delegation card already on screen from the live board. */
	function syncDelegations() {
		for (const card of document.querySelectorAll('#messages .tool-card[data-task-ids]')) {
			const box = card.querySelector('.tool-delegation');
			if (!box) {
				continue;
			}
			const ids = String(card.dataset.taskIds || '')
				.split(',')
				.filter(Boolean);
			const html = delegationBadges(ids, card.dataset.subagent);
			if (box.innerHTML !== html) {
				box.innerHTML = html;
			}
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

	const SUMMARY_KEYS = ['path', 'file_path', 'file', 'pattern', 'query', 'url', 'question', 'description', 'prompt', 'name', 'id', 'todos', 'tasks'];

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
		// Reserve the box the picture will fill from the size in its header. Without it the <img> is
		// empty until the bytes arrive, and the transcript grows a frame after the scroll that was
		// meant to bring the card into view — which a reader following the end sees as the bottom
		// disappearing. The thumbnail's CSS caps are mirrored here so the reserved box is final.
		const width = Number(part.width);
		const height = Number(part.height);
		if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
			const scale = Math.min(1, 180 / width, 120 / height);
			img.width = Math.max(1, Math.round(width * scale));
			img.height = Math.max(1, Math.round(height * scale));
		}
		const url = attachmentUrls.get(part.id);
		if (url) {
			img.src = url;
		} else {
			requestAttachment(part.id);
		}
		// A picture whose header carried no size, or one that decodes after the scroll that placed it,
		// still belongs to the end a following reader is watching; scroll() leaves an unpinned one be.
		img.addEventListener('load', () => scroll());
		return img;
	}

	function imageThumbs(parts) {
		const images = Array.isArray(parts) ? parts.filter((part) => !part.kind || part.kind === 'image') : [];
		if (!images.length) {
			return null;
		}
		// A span, not a div: a tool card keeps its pictures inside the <summary>.
		const box = document.createElement('span');
		box.className = 'thumbs';
		for (const part of images) {
			box.appendChild(imageThumb(part));
		}
		return box;
	}

	function imageLabel(part) {
		const size = part.width && part.height ? ' · ' + part.width + '×' + part.height : '';
		return (part.name || 'image') + size;
	}

	/**
	 * A tool's pictures wait behind one chip until the card is opened. A card that read a screenshot
	 * is a log line, and printing the picture while folded moves every line under it; the chip names
	 * what is waiting, and opening the card — by the chip or by its header — shows the picture in the
	 * body, where folding the card puts it away again.
	 */
	function imageReveal(step, details) {
		const images = Array.isArray(step.images) ? step.images.filter((part) => !part.kind || part.kind === 'image') : [];
		if (!images.length) {
			return null;
		}
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'image-reveal';
		button.dataset.tip = images.length === 1 ? 'Show this image' : 'Show these images';
		button.textContent = images.length === 1 ? '🖼 ' + imageLabel(images[0]) : '🖼 ' + images.length + ' images';
		button.addEventListener('click', (event) => {
			// The chip lives inside the card's <summary>: its click opens the picture, not the card
			// twice. The toggle listener below is the one place that builds it.
			event.preventDefault();
			event.stopPropagation();
			details.open = true;
		});
		return button;
	}

	/** Resolved text references, as compact chips beside the prompt; file and paste chips open on click. */
	function referenceChips(parts, turn) {
		const refs = Array.isArray(parts)
			? parts.map((part, index) => ({ part, index })).filter(({ part }) => part.kind === 'text' || part.kind === 'document')
			: [];
		if (!refs.length) {
			return null;
		}
		const box = document.createElement('div');
		box.className = 'refs';
		for (const { part, index } of refs) {
			const chip = document.createElement('span');
			chip.className = 'ref' + (part.form === 'error' ? ' error' : '');
			const source = part.source || {};
			if (part.kind === 'document') {
				const pages = part.pages ? ' · p.' + part.pages.start + (part.pages.end === part.pages.start ? '' : '-' + part.pages.end) : '';
				const total = part.pageCount ? '/' + part.pageCount : '';
				chip.textContent = '📄 ' + (part.name || 'PDF') + pages + total;
			} else if (part.name) {
				// A composer paste: its name, never its (possibly very long) body.
				chip.textContent = '📋 ' + part.name;
			} else {
				const range = source.range ? ':' + source.range.start + (source.range.end === source.range.start ? '' : '-' + source.range.end) : '';
				chip.textContent = (part.form === 'folder' ? '📁 ' : part.form === 'symbol' ? 'ƒ ' : '') + (source.symbol || source.path || part.form) + range;
			}
			// Only a resolved file/symbol and a composer paste carry a target; folders, PDFs and
			// error notes stay inert. The dataset is the click handler's only input.
			const isFileRef = part.kind === 'text' && part.origin === 'reference'
				&& typeof source.path === 'string' && source.path
				&& (part.form === 'file' || part.form === 'symbol');
			const canPaste = part.kind === 'text' && part.origin === 'user' && part.form === 'note' && Boolean(turn);
			if (isFileRef) {
				chip.dataset.refPath = source.path;
				if (source.range && source.range.unit === 'line') {
					chip.dataset.refStart = String(source.range.start);
					chip.dataset.refEnd = String(source.range.end);
				}
				chip.tabIndex = 0;
				chip.setAttribute('role', 'link');
			} else if (canPaste) {
				chip.dataset.pasteTurn = String(turn.index);
				chip.dataset.pasteIndex = String(index);
				chip.dataset.pasteSession = turn.sessionId || (state && state.sessionId) || '';
				chip.tabIndex = 0;
				chip.setAttribute('role', 'link');
			}
			if (part.text) {
				const preview = part.text.slice(0, 2_000);
				chip.title = isFileRef
					? 'Open in the editor\n\n' + preview
					: canPaste
						? 'Open the full pasted text\n\n' + preview
						: preview;
			} else if (isFileRef) {
				chip.title = 'Open in the editor';
			} else if (canPaste) {
				chip.title = 'Open the full pasted text';
			}
			box.appendChild(chip);
		}
		return box;
	}

	function renderPromptAttachments(turn) {
		if (!turn || !turn._bubble) {
			return;
		}
		const old = turn._bubble.querySelector('.refs');
		if (old) {
			old.remove();
		}
		const chips = referenceChips(turn.promptAttachments, turn);
		if (chips) {
			turn._bubble.appendChild(chips);
		}
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

	/* ------------------------------------------------------------------ plan build picker */

	/** Build selections per plan card, keyed by session + call id: replay rebuilds the step objects. */
	const planChoices = new Map();
	/** The one open picker: { trigger, step, field, active, items } or null. */
	let planMenuState = null;
	let planMenuEl = null;

	const PLAN_MODE_FALLBACK = [
		{ id: 'sw', label: 'Semi-Write', description: 'write files, run tests in a scratch shell' },
		{ id: 'aw', label: 'Full Access', description: 'write files, full shell' },
	];

	function planModeChoices() {
		const modes = state && Array.isArray(state.modes)
			? state.modes.filter((item) => item && (item.id === 'sw' || item.id === 'aw'))
			: [];
		return modes.length ? modes : PLAN_MODE_FALLBACK;
	}

	function planModelChoices() {
		return modelState.models;
	}

	function planChoiceKey(step) {
		const plan = (step && step.plan) || {};
		return (plan.sessionId || '') + ':' + ((step && step.id) || plan.name || '');
	}

	/** A card's explicit build picks. Until one is made the card follows the live session below. */
	function planChoice(step) {
		const key = planChoiceKey(step);
		let choice = planChoices.get(key);
		if (!choice) {
			choice = {};
			planChoices.set(key, choice);
			if (planChoices.size > 200) {
				planChoices.delete(planChoices.keys().next().value);
			}
		}
		return choice;
	}

	/** The mode the build will run in: an explicit pick, else the session's — only sw/aw can build. */
	function planBuildMode(choice) {
		if (choice && (choice.mode === 'sw' || choice.mode === 'aw')) {
			return choice.mode;
		}
		return state && (state.mode === 'sw' || state.mode === 'aw') ? state.mode : 'sw';
	}

	/** The model the build will run with: an explicit pick, else the session's. */
	function planBuildModel(choice) {
		if (choice && typeof choice.model === 'string' && choice.model) {
			return choice.model;
		}
		return (state && typeof state.model === 'string' && state.model) || 'auto';
	}

	function planModelItem(id) {
		return planModelChoices().find((item) => item.id === id);
	}

	function planModelLabel(id) {
		const item = planModelItem(id);
		if (item) {
			return item.label;
		}
		if (state && state.model === id && state.modelLabel) {
			return state.modelLabel;
		}
		return id === 'auto' ? 'Auto' : id;
	}

	function planModeLabel(id) {
		const item = planModeChoices().find((choice) => choice.id === id);
		return (item && item.label) || (id === 'aw' ? 'Full Access' : 'Semi-Write');
	}

	function planTrigger(field, label, tip) {
		const trigger = document.createElement('button');
		trigger.type = 'button';
		trigger.className = 'pill-trigger plan-trigger';
		trigger.dataset.planPick = field;
		trigger.setAttribute('aria-haspopup', 'listbox');
		trigger.setAttribute('aria-expanded', 'false');
		trigger.dataset.tip = tip;
		const text = document.createElement('span');
		text.className = 'pill-label';
		text.dataset.planLabel = field;
		text.textContent = label;
		const chev = document.createElement('span');
		chev.className = 'chev';
		chev.setAttribute('aria-hidden', 'true');
		chev.textContent = '▾';
		trigger.append(text, chev);
		return trigger;
	}

	function planField(label, trigger) {
		const field = document.createElement('div');
		field.className = 'plan-field';
		const text = document.createElement('span');
		text.className = 'plan-field-label';
		text.textContent = label;
		field.append(text, trigger);
		return field;
	}

	/** A finished plan: its own card, not a tool row, so the build controls are always visible. */
	function planCard(step, plan) {
		const tool = step.name || 'write_plan';
		const card = document.createElement('div');
		card.className = 'tool-card plan-card';
		card.dataset.status = step.status === 'error' ? 'error' : 'ok';
		card.dataset.tool = tool;
		if (step.id) {
			card.dataset.callId = step.id;
		}
		card.dataset.plan = plan.name;
		card.dataset.relative = plan.relative || '';
		card.dataset.session = plan.sessionId || '';

		const head = document.createElement('div');
		head.className = 'plan-head';
		const glyph = document.createElement('span');
		glyph.className = 'plan-glyph';
		glyph.setAttribute('aria-hidden', 'true');
		glyph.innerHTML = toolIcon(tool);
		const heading = document.createElement('span');
		heading.className = 'plan-heading';
		const eyebrow = document.createElement('span');
		eyebrow.className = 'plan-eyebrow';
		const dot = document.createElement('span');
		dot.className = 'plan-dot';
		eyebrow.append(dot, document.createTextNode(plan.edited ? 'Plan updated' : 'Plan ready'));
		const name = document.createElement('span');
		name.className = 'plan-name';
		name.textContent = plan.name;
		const path = document.createElement('span');
		path.className = 'plan-path';
		path.textContent = plan.relative || plan.name;
		heading.append(eyebrow, name, path);
		head.append(glyph, heading);
		card.append(head);

		const choice = planChoice(step);
		const controls = document.createElement('div');
		controls.className = 'plan-controls';
		const modelTrigger = planTrigger('model', planModelLabel(planBuildModel(choice)), 'Model for the implementing turn');
		const modeTrigger = planTrigger('mode', planModeLabel(planBuildMode(choice)), 'Agent mode for the implementing turn');
		const actions = document.createElement('div');
		actions.className = 'plan-actions';
		const preview = document.createElement('button');
		preview.type = 'button';
		preview.className = 'plan-preview';
		preview.dataset.plan = plan.name;
		preview.dataset.planAction = 'preview';
		preview.dataset.session = plan.sessionId || '';
		preview.dataset.tip = 'Open this plan in the Markdown preview';
		preview.textContent = 'Preview';
		const build = document.createElement('button');
		build.type = 'button';
		build.className = 'plan-build primary';
		build.dataset.plan = plan.name;
		build.dataset.planAction = 'build';
		build.dataset.session = plan.sessionId || '';
		build.textContent = 'Build plan';
		actions.append(preview, build);
		controls.append(planField('Model', modelTrigger), planField('Mode', modeTrigger), actions);
		card.append(controls);

		if (step.result !== undefined) {
			const trace = document.createElement('details');
			trace.className = 'plan-trace';
			const summary = document.createElement('summary');
			const record = document.createElement('span');
			record.textContent = 'Tool record';
			const meta = document.createElement('span');
			meta.className = 'plan-trace-meta';
			meta.textContent = tool + ' · ' + (card.dataset.status === 'error' ? 'error' : 'ok');
			summary.append(record, meta);
			const out = document.createElement('pre');
			out.className = 'plan-trace-out';
			out.textContent = step.result || '(no output)';
			trace.append(summary, out);
			card.append(trace);
		}

		step._card = card;
		card._planStep = step;
		syncPlanCard(card);
		return card;
	}

	function setPlanTrigger(card, field, label, tip, warning) {
		const trigger = card.querySelector('button[data-plan-pick="' + field + '"]');
		if (!trigger) {
			return;
		}
		const text = trigger.querySelector('[data-plan-label="' + field + '"]');
		if (text) {
			text.textContent = label;
		}
		trigger.dataset.tip = tip;
		trigger.classList.toggle('is-warning', Boolean(warning));
	}

	function syncPlanCard(card) {
		const step = card && card._planStep;
		if (!step || !step.plan) {
			return;
		}
		const choice = planChoice(step);
		const model = planBuildModel(choice);
		const mode = planBuildMode(choice);
		const modelItem = planModelItem(model);
		const modelLabel = planModelLabel(model);
		const modeItem = planModeChoices().find((item) => item.id === mode);
		const modeLabel = planModeLabel(mode);
		const modelTip =
			'Model for the implementing turn\nCurrent: ' +
			(modelItem && modelItem.description ? modelLabel + ' — ' + modelItem.description : modelLabel);
		const modeTip =
			'Agent mode for the implementing turn\nCurrent: ' +
			(modeItem && modeItem.description ? modeLabel + ' — ' + modeItem.description : modeLabel);
		setPlanTrigger(card, 'model', modelLabel, modelTip, Boolean(modelItem && modelItem.needsKey));
		setPlanTrigger(card, 'mode', modeLabel, modeTip, false);
		const build = card.querySelector('button.plan-build');
		if (build) {
			const blocked = running
				? 'A turn is running — wait for it to finish.'
				: modelItem && modelItem.needsKey
					? 'This model has no API key — pick another one.'
					: '';
			build.disabled = Boolean(blocked);
			build.dataset.tip =
				blocked || 'Implement ' + step.plan.name + ' with ' + modelLabel + ' in ' + modeLabel + ' mode';
		}
	}

	function syncPlanCards() {
		for (const card of document.querySelectorAll('.plan-card')) {
			syncPlanCard(card);
		}
		if (planMenuState) {
			fillPlanMenu();
		}
	}

	function planMenuRows() {
		return planMenuEl ? [...planMenuEl.querySelectorAll('button.plan-option')] : [];
	}

	function planOptionRow(item, current) {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'pill-choice plan-option';
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', String(item.id === current));
		row.tabIndex = -1;
		row.dataset.planValue = item.id;
		row.classList.toggle('is-on', item.id === current);
		row.dataset.tip = item.description ? item.label + ' — ' + item.description : item.label;
		const text = document.createElement('span');
		text.className = 'plan-option-text';
		const label = document.createElement('span');
		label.className = 'pill-choice-label';
		label.textContent = (item.id === current ? '✓ ' : '') + (item.label || item.id);
		text.append(label);
		if (item.description) {
			const detail = document.createElement('span');
			detail.className = 'plan-option-detail';
			detail.textContent = item.description;
			text.append(detail);
		}
		row.append(text);
		if (item.needsKey) {
			const note = document.createElement('span');
			note.className = 'pill-choice-note';
			note.textContent = 'no key';
			row.append(note);
			row.disabled = true;
			row.setAttribute('aria-disabled', 'true');
		}
		return row;
	}

	function fillPlanMenu() {
		const current = planMenuState;
		if (!current || !planMenuEl) {
			return;
		}
		const items = current.field === 'model' ? planModelChoices() : planModeChoices();
		const choice = planChoice(current.step);
		const selected = current.field === 'model' ? planBuildModel(choice) : planBuildMode(choice);
		const previous = current.active;
		planMenuEl.innerHTML = '';
		planMenuEl.setAttribute('aria-label', current.field === 'model' ? 'Model for the build' : 'Agent mode for the build');
		current.items = items;
		for (const item of items) {
			planMenuEl.append(planOptionRow(item, selected));
		}
		const rows = planMenuRows();
		if (!rows.length) {
			const hint = document.createElement('div');
			hint.className = 'plan-menu-hint';
			hint.textContent =
				current.field === 'model' ? 'No models configured — add a provider in Settings.' : 'No build modes available.';
			planMenuEl.append(hint);
			current.active = -1;
			return;
		}
		const chosen = items.findIndex((item) => item.id === selected && !item.needsKey);
		const enabled = rows.findIndex((row) => !row.disabled);
		current.active =
			previous >= 0 && previous < rows.length && !rows[previous].disabled
				? previous
				: chosen >= 0
					? chosen
					: enabled;
		if (!planMenuEl.hidden) {
			setPlanActive(current.active);
		}
	}

	function ensurePlanMenu(trigger) {
		if (!planMenuEl) {
			planMenuEl = document.createElement('div');
			planMenuEl.id = 'plan-picker';
			planMenuEl.className = 'pill-menu plan-menu';
			planMenuEl.setAttribute('role', 'listbox');
			planMenuEl.hidden = true;
			planMenuEl.addEventListener('keydown', planMenuKey);
			planMenuEl.addEventListener('click', (event) => {
				const row = event.target.closest('button.plan-option');
				if (row && !row.disabled) {
					event.preventDefault();
					event.stopPropagation();
					pickPlanValue(planMenuRows().indexOf(row));
				}
			});
		}
		// The overlay makes every other body child inert, so its menu must live inside it.
		const parent = trigger.closest('#subagent-view') || document.body;
		if (planMenuEl.parentElement !== parent) {
			parent.append(planMenuEl);
		}
		return planMenuEl;
	}

	function placePlanMenu(trigger) {
		const rect = trigger.getBoundingClientRect();
		const width = planMenuEl.offsetWidth;
		const height = planMenuEl.offsetHeight;
		let left = rect.left;
		if (left + width > window.innerWidth - 8) {
			left = Math.max(8, window.innerWidth - 8 - width);
		}
		let top = rect.bottom + 6;
		if (top + height > window.innerHeight - 8 && rect.top - 6 - height >= 8) {
			top = rect.top - 6 - height;
		}
		top = Math.max(8, Math.min(top, window.innerHeight - 8 - height));
		planMenuEl.style.left = left + 'px';
		planMenuEl.style.top = top + 'px';
	}

	function planMenuNextEnabled(from, delta) {
		const rows = planMenuRows();
		if (!rows.length) {
			return -1;
		}
		let index = from;
		for (let step = 0; step < rows.length; step += 1) {
			index = (index + delta + rows.length) % rows.length;
			if (!rows[index].disabled) {
				return index;
			}
		}
		return -1;
	}

	function setPlanActive(index) {
		const current = planMenuState;
		const rows = planMenuRows();
		if (!current || !rows.length || index < 0) {
			return;
		}
		current.active = index;
		rows.forEach((row, at) => {
			const active = at === index;
			row.classList.toggle('active', active);
			if (active) {
				row.focus({ preventScroll: true });
				row.scrollIntoView({ block: 'nearest' });
			}
		});
	}

	function planMenuKey(event) {
		if (!planMenuState) {
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closePlanMenu(true);
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			setPlanActive(planMenuNextEnabled(planMenuState.active, event.key === 'ArrowDown' ? 1 : -1));
		} else if (event.key === 'Home') {
			event.preventDefault();
			setPlanActive(planMenuNextEnabled(-1, 1));
		} else if (event.key === 'End') {
			event.preventDefault();
			setPlanActive(planMenuNextEnabled(planMenuRows().length, -1));
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			pickPlanValue(planMenuState.active);
		} else if (event.key === 'Tab') {
			closePlanMenu(false);
		}
	}

	function pickPlanValue(index) {
		const current = planMenuState;
		const item = current && current.items[index];
		if (!item || item.needsKey) {
			return;
		}
		const card = current.trigger.closest('.plan-card');
		const choice = planChoice(current.step);
		if (current.field === 'model') {
			choice.model = item.id;
		} else {
			choice.mode = item.id;
		}
		closePlanMenu(true);
		if (card) {
			syncPlanCard(card);
		}
	}

	function openPlanMenu(trigger) {
		const card = trigger.closest('.plan-card');
		const step = card && card._planStep;
		const field = trigger.dataset.planPick;
		if (!step || (field !== 'model' && field !== 'mode')) {
			return;
		}
		closePlanMenu(false);
		closeToolMenus();
		closeMenus();
		hideFlyout();
		closeMention();
		ensurePlanMenu(trigger);
		planMenuState = { trigger, step, field, active: -1, items: [] };
		// Fill while hidden, then reveal and position: the measuring and focus wait for layout.
		fillPlanMenu();
		planMenuEl.hidden = false;
		trigger.setAttribute('aria-expanded', 'true');
		placePlanMenu(trigger);
		setPlanActive(planMenuState.active);
	}

	function closePlanMenu(returnFocus) {
		const current = planMenuState;
		if (!current) {
			return;
		}
		planMenuState = null;
		if (planMenuEl) {
			planMenuEl.hidden = true;
			planMenuEl.innerHTML = '';
		}
		current.trigger.setAttribute('aria-expanded', 'false');
		if (returnFocus && current.trigger.isConnected) {
			current.trigger.focus();
		}
	}

	window.addEventListener('resize', () => {
		if (planMenuState) {
			closePlanMenu(false);
		}
	});

	/**
	 * One tool call: a title, a utility summary and a preview of the output while closed; the whole
	 * command (highlighted) and the whole output when open. The preview lives in the summary so it
	 * stays visible while the card is folded; the copy menu is a sibling so it can never toggle it.
	 */
	function toolCard(step) {
		// The host attaches `plan` only for a plan writer; the payload is the source of truth.
		const plan = step.plan && typeof step.plan.name === 'string' ? step.plan : null;
		if (plan) {
			return planCard(step, plan);
		}
		const parsed = toolArgs(step);
		const shell = SHELL_TOOL.test(step.name || '');
		const command = shellCommandOf(step);
		const failed = step.status === 'error' || /^Error:/.test(step.result || '');
		const state = step.result === undefined ? 'running' : failed ? 'error' : 'ok';
		const title = shell ? oneLine(shellDescriptionOf(step), 120) || humanToolName(step.name) : humanToolName(step.name);
		const summary = shell ? shellUtilities(command) || oneLine(command, 100) : argSummary(step, parsed);
		// A delegation card names the whole task, not just the one worker child it may link.
		const delegation = step.name === 'delegate' || step.name === 'resume';
		const delegationIds = delegation ? taskIdsOf(step) : [];
		const delegationHtml = delegation
			? '<span class="tool-delegation">' + delegationBadges(delegationIds, step.subagentId) + '</span>'
			: '';
		const openSubagent =
			!delegation && step.name === 'agent' && step.subagentId
				? '<button type="button" class="tool-open-subagent" data-subagent="' + esc(step.subagentId) + '" data-tip="Open the subagent session">Open session</button>'
				: '';
		const mode = toolCardMode();
		// `collapsed` is header-only: the preview is not built at all, not merely hidden.
		const preview = mode === 'collapsed' ? '' : previewOf(step);

		const card = document.createElement('div');
		card.className = 'tool-card';
		card.dataset.status = state;
		if (step.name) {
			card.dataset.tool = step.name;
		}
		if (step.id) {
			card.dataset.callId = step.id;
		}
		if (delegation && delegationIds.length) {
			card.dataset.taskIds = delegationIds.join(',');
		}
		if (delegation && step.subagentId) {
			card.dataset.subagent = step.subagentId;
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
			(openSubagent || delegationHtml) +
			'<span class="timer tool-time"></span></span>' +
			(preview ? '<span class="tool-preview"></span>' : '');
		if (preview) {
			// Output is text, never markup: a command may print anything.
			head.querySelector('.tool-preview').textContent = preview;
		}
		// A picture is not printed on the folded card: one chip names it, and opening the card shows it.
		const reveal = imageReveal(step, details);
		if (reveal) {
			head.appendChild(reveal);
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

		// The pictures are built the first time the body is shown, not while the card is folded: the
		// bytes are fetched only when someone asked to look, and folding the card puts them away.
		let imagesShown = false;
		const showImages = () => {
			if (imagesShown) {
				return;
			}
			imagesShown = true;
			const thumbs = imageThumbs(step.images);
			if (thumbs) {
				body.insertBefore(thumbs, body.firstChild);
			}
		};

		details.addEventListener('toggle', () => {
			step._open = details.open;
			if (details.open) {
				showImages();
			}
		});
		if (details.open) {
			showImages();
		}
		step._card = card;
		step._details = details;
		step._timer = head.querySelector('.tool-time');
		return card;
	}

	/**
	 * A fold is a card in the step flow, not a chat line: the stats stay readable while folded and
	 * the summary the fold produced is one click away. It borrows the tool card's shell so the theme,
	 * chevron and focus behave exactly like the calls around it.
	 */
	function compactionCard(step) {
		const note = step.note || {};
		const folded = Math.max(0, Number(note.folded) || 0);
		const before = Math.max(0, Number(note.before) || 0);
		const after = Math.max(0, Number(note.after) || 0);
		const window = Math.max(0, Number(note.window) || 0);
		const covers = Math.max(0, Number(note.covers) || 0);
		const anchor = Math.max(covers, Number(note.anchor) || covers);
		const share = window > 0 ? Math.round((after / window) * 100) : 0;

		const card = document.createElement('div');
		card.className = 'tool-card compaction-card';
		card.dataset.status = 'ok';

		const details = document.createElement('details');
		details.className = 'tool-details';
		details.open = step._open === true;

		const head = document.createElement('summary');
		head.className = 'tool-head';
		head.innerHTML =
			'<span class="tool-head-row">' +
			'<span class="tool-glyph"><span class="tool-icon">' +
			COMPACTION_ICON +
			'</span><span class="tool-chev">' +
			CHEVRON_ICON +
			'</span></span>' +
			'<span class="tool-title">Conversation summarized</span>' +
			'<span class="tool-summary">' +
			esc(
				folded +
					' earlier message' +
					(folded === 1 ? '' : 's') +
					' · ' +
					formatTokens(before) +
					' → ' +
					formatTokens(after) +
					' tokens · ' +
					share +
					'% of the ' +
					formatTokens(window) +
					' window',
			) +
			'</span></span>';

		const body = document.createElement('div');
		body.className = 'tool-body compaction-body';

		let filled = false;
		const fill = () => {
			if (filled) {
				return;
			}
			filled = true;
			const stats = document.createElement('div');
			stats.className = 'compaction-stats';
			for (const [value, label] of [
				[String(folded), folded === 1 ? 'message folded' : 'messages folded'],
				[formatTokens(after), 'tokens now (was ' + formatTokens(before) + ')'],
				[share + '%', 'of the ' + formatTokens(window) + ' window'],
			]) {
				const item = document.createElement('span');
				item.className = 'compaction-stat';
				const strong = document.createElement('b');
				strong.textContent = value;
				item.append(strong, document.createTextNode(' ' + label));
				stats.appendChild(item);
			}
			const summary = document.createElement('div');
			summary.className = 'compaction-summary body md';
			summary.innerHTML = md(String(note.summary || ''));
			const keep = document.createElement('p');
			keep.className = 'compaction-keep';
			keep.textContent =
				'The chat itself is unchanged: the first ' +
				covers +
				' messages are represented by this summary; the latest ' +
				Math.max(0, anchor - covers) +
				' stayed in full.';
			body.append(stats, summary, keep);
		};

		details.addEventListener('toggle', () => {
			step._open = details.open;
			if (details.open) {
				fill();
			}
		});
		if (details.open) {
			fill();
		}
		details.append(head, body);
		card.appendChild(details);
		step._card = card;
		step._details = details;
		return card;
	}

	/** One element for one step; the single place a thought, a text block or a call is drawn. */
	function stepEl(step, busy) {
		if (step.kind === 'thought') {
			const fold = document.createElement('details');
			fold.className = 'thinking';
			fold.innerHTML =
				'<summary><span class="label">' +
				(busy ? 'Thinking…' : 'Thought') +
				'</span><span class="timer"></span><span class="thought-tokens"></span></summary><div class="think"></div>';
			fold.querySelector('.think').textContent = step.text || '';
			step._think = fold.querySelector('.think');
			step._summary = fold.querySelector('.label');
			step._timer = fold.querySelector('.timer');
			step._tokens = fold.querySelector('.thought-tokens');
			paintThoughtTokens(step, false);
			return fold;
		}
		if (step.kind === 'tool') {
			return toolCard(step);
		}
		if (step.kind === 'note') {
			return compactionCard(step);
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

	// The bytes-per-token fallback the kernel uses when no tokenizer is loaded; the host's count
	// replaces this estimate the moment the turn settles.
	const utf8 = new TextEncoder();
	function estimateThoughtTokens(text) {
		return text ? Math.ceil(utf8.encode(text).length / 3.35) : 0;
	}

	/** A thought's size beside its duration: counted live, then taken from the host at turn-end. */
	function paintThoughtTokens(step, live) {
		if (!step._tokens) {
			return;
		}
		const tokens = step.tokens ?? (live ? estimateThoughtTokens(step.text || '') : undefined);
		step._tokens.textContent = tokens ? tokens.toLocaleString() + ' tokens' : '';
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
		// A placeholder drawn before the first streamed step must not sit above the real content.
		turn._steps.querySelector('.no-reply')?.remove();
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
			empty.className = 'muted no-reply';
			empty.textContent = '(no reply text)';
			turn._steps.appendChild(empty);
		}
		// A turn built from the transcript carries the durations the host measured.
		const now = Date.now();
		for (const step of turn.steps || []) {
			paintTimer(step, false, now);
		}
	}

	/** The live footer's label: elapsed time even before the first token or tool call. */
	function workingLabel(turn) {
		const seconds = turn.startedAt ? Math.max(0, Math.round((Date.now() - turn.startedAt) / 1000)) : 0;
		return seconds >= 1 ? 'Working… · ' + seconds + 's' : 'Working…';
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
			meta.textContent = workingLabel(turn);
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
	function turnEl(turn, container = messagesEl, readOnly = false) {
		const root = document.createElement('div');
		root.className = 'turn';
		turn._root = root;
		root._turn = turn;

		const prompt = document.createElement('div');
		prompt.className = 'msg user';
		// The text alone is wrapped: reference chips and image thumbnails stay visible when it folds.
		prompt.innerHTML = '<div class="bubble"><div class="prompt-body">' + renderPromptHtml(turn.prompt) + '</div></div>';
		turn._bubble = prompt.querySelector('.bubble');
		const promptThumbs = imageThumbs(turn.promptAttachments);
		if (promptThumbs) {
			turn._bubble.appendChild(promptThumbs);
		}
		renderPromptAttachments(turn);
		if (!turn.command) {
			const actions = [{ key: 'copy', icon: 'copy', tip: 'Copy message', run: (button) => copyAction(button, turn.prompt) }];
			if (!readOnly && turn.prompt) {
				actions.push({ key: 'edit', icon: 'pencil', tip: 'Edit this prompt and run it again', run: () => beginEdit(turn) });
			}
			const long = promptIsLong(turn);
			if (long) {
				actions.push({ key: 'expand', label: 'Show more', tip: 'Show the full prompt', run: (button) => togglePrompt(turn, button) });
			}
			const row = actionRow(actions);
			prompt.appendChild(row);
			if (long) {
				applyPromptState(turn, row.querySelector('.act[data-act="expand"]'));
			}
		}
		if (turn.prompt || (turn.promptAttachments && turn.promptAttachments.length)) {
			// A continuation and an impersonation have no prompt of their own — the host sends them with
			// no text, and an empty bubble is not a message. A quiet turn does carry the prompt it was
			// asked, in a bubble that is removed once the reply becomes a quiet card. An image-only
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
		container.appendChild(root);
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
		if (running || (state && state.suspended) || turn.command || !turn.prompt) {
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
		area.spellcheck = false;
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
			button.hidden = !last || button.closest('.turn') !== last._root || running;
		}
		const suspended = Boolean(state && state.suspended);
		for (const button of messagesEl.querySelectorAll('.msg.user .act[data-act="edit"]')) {
			const turn = button.closest('.turn')?._turn;
			// An image-only prompt has no text but is still a prompt that can be run again.
		const prompted = Boolean(turn && (turn.prompt || (turn.promptAttachments && turn.promptAttachments.length)));
		button.hidden = running || suspended || !turn || Boolean(turn.command) || !prompted;
		}
	}

	function welcome() {
		const workspace = (state && state.workspace) || '';
		return add(
			'welcome',
			'<div class="welcome-head"><span class="welcome-mark" aria-hidden="true">◉</span><h2>Comonad</h2></div>' +
				'<p class="welcome-lead">Ask for a change, a review or an explanation.</p>' +
				'<div class="welcome-workspace"><span class="welcome-label">Workspace</span><code>' +
				esc(workspace || 'no folder open') +
				'</code></div>' +
				'<div class="welcome-keys"><span><code>/</code> for commands</span><span><code>@</code> to reference code</span></div>',
		);
	}

	/** Draws a whole transcript: the one path used by a reload, a chat switch and a display change. */
	function summaryTitle(summary) {
		const messages = Number(summary && summary.covers) || 0;
		const covered = Number(summary && summary.coveredTurns) || 0;
		const scope = messages ? messages + ' message' + (messages === 1 ? '' : 's') : 'earlier history';
		return 'Conversation summary · ' + scope + (covered ? ' · ' + covered + ' turn' + (covered === 1 ? '' : 's') : '');
	}

	function summaryCard(summary) {
		const card = document.createElement('section');
		card.className = 'summary-card';
		const head = document.createElement('div');
		head.className = 'summary-head';
		const title = document.createElement('span');
		title.className = 'summary-title';
		title.textContent = summaryTitle(summary);
		const actions = document.createElement('span');
		actions.className = 'summary-actions';
		const rebuild = document.createElement('button');
		rebuild.type = 'button';
		rebuild.className = 'summary-btn';
		rebuild.textContent = 'Rebuild';
		rebuild.title = 'Rebuild this summary from the full conversation';
		rebuild.addEventListener('click', () => {
			rebuild.disabled = true;
			vscode.postMessage({ type: 'rebuildSummary', sessionId: state && state.sessionId });
		});
		actions.appendChild(rebuild);
		head.append(title, actions);
		const body = document.createElement('div');
		body.className = 'summary-body';
		body.innerHTML = md(String(summary && summary.text ? summary.text : ''));
		card.append(head, body);
		return card;
	}

	function summaryDetails() {
		const details = document.createElement('details');
		details.className = 'summary-originals';
		const head = document.createElement('summary');
		head.textContent = 'Show original messages';
		details.appendChild(head);
		return details;
	}

	/** Move loaded turns in and out of the summary details as coverage changes. */
	function updateSummaryDetails(summary) {
		const details = messagesEl.querySelector('.summary-originals');
		if (!details) {
			return;
		}
		const covers = summary ? Number(summary.covers) || 0 : 0;
		for (const turn of turns) {
			if (!turn._root) {
				continue;
			}
			// A turn with no host boundary yet is the live one: a summary cannot cover it.
			if (summary && Number.isFinite(turn.at) && turn.at <= covers) {
				if (turn._root.parentElement !== details) {
					details.appendChild(turn._root);
				}
			} else if (turn._root.parentElement === details) {
				const firstUncovered = turns.find((other) => other !== turn && other._root && other._root.parentElement === messagesEl);
				messagesEl.insertBefore(turn._root, firstUncovered ? firstUncovered._root : null);
			}
		}
		const count = details.querySelectorAll('.turn').length;
		details.querySelector('summary').textContent = 'Show original messages' + (count ? ' (' + count + ')' : '');
	}

	function renderLoadOlder() {
		const old = messagesEl.querySelector('.load-older');
		if (old) {
			old.remove();
		}
		if (!pageInfo.hasMore || pageInfo.firstTurnIndex === undefined) {
			return;
		}
		const box = document.createElement('div');
		box.className = 'load-older';
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = 'Load older messages';
		button.addEventListener('click', () => {
			button.disabled = true;
			vscode.postMessage({ type: 'loadOlder', before: pageInfo.firstTurnIndex, sessionId: state && state.sessionId });
		});
		box.appendChild(button);
		const details = messagesEl.querySelector('.summary-originals');
		const anchor = details ? details.nextSibling : messagesEl.firstChild;
		messagesEl.insertBefore(box, anchor);
	}

	function updateSummary(summary) {
		summaryInfo = summary || null;
		const card = messagesEl.querySelector('.summary-card');
		const details = messagesEl.querySelector('.summary-originals');
		if (!summaryInfo) {
			if (details) {
				for (const turn of turns) {
					if (turn._root && turn._root.parentElement === details) {
						messagesEl.insertBefore(turn._root, details);
					}
				}
			}
			if (card) {
				card.remove();
			}
			if (details) {
				details.remove();
			}
			renderLoadOlder();
			return;
		}
		if (!card) {
			const next = messagesEl.firstChild;
			messagesEl.insertBefore(summaryCard(summaryInfo), next);
			messagesEl.insertBefore(summaryDetails(), next);
		} else {
			card.querySelector('.summary-title').textContent = summaryTitle(summaryInfo);
			card.querySelector('.summary-body').innerHTML = md(String(summaryInfo.text || ''));
		}
		if (!messagesEl.querySelector('.summary-originals')) {
			messagesEl.insertBefore(summaryDetails(), card.nextSibling);
		}
		updateSummaryDetails(summaryInfo);
		renderLoadOlder();
	}

	function prependTurns(message) {
		const list = message.turns || [];
		if (!list.length) {
			return;
		}
		const oldHeight = messagesEl.scrollHeight;
		const oldTop = messagesEl.scrollTop;
		const fragment = document.createDocumentFragment();
		for (const turn of list) {
			turnEl(turn, fragment);
			renderSteps(turn);
			renderFoot(turn);
		}
		const anchor = Array.from(messagesEl.children).find((child) => child.classList.contains('turn')) || null;
		messagesEl.insertBefore(fragment, anchor);
		turns = [...list, ...turns];
		summaryInfo = message.summary || summaryInfo;
		pageInfo = {
			firstTurnIndex: message.firstTurnIndex,
			totalTurns: message.totalTurns,
			hasMore: message.hasMore === true,
		};
		if (summaryInfo) {
			updateSummary(summaryInfo);
		}
		renderLoadOlder();
		for (const messageEl of messagesEl.querySelectorAll('.msg')) {
			messageEl.classList.add('no-anim');
		}
		syncDelegations();
		if (pinned) {
			scroll(true);
		} else {
			messagesEl.scrollTop = oldTop + (messagesEl.scrollHeight - oldHeight);
		}
	}

	function renderTurns(list, sessionId, summary, page, runningHere) {
		closePlanMenu(false);
		turns = list || [];
		summaryInfo = summary || null;
		pageInfo = page || {
			firstTurnIndex: turns[0] ? turns[0].index : undefined,
			totalTurns: turns.length,
			hasMore: Boolean(turns[0] && turns[0].index > 0),
		};
		live = null;
		editing = null;
		toolCards.clear();
		messagesEl.innerHTML = '';
		if (summaryInfo) {
			messagesEl.appendChild(summaryCard(summaryInfo));
			messagesEl.appendChild(summaryDetails());
		}
		if (!turns.length) {
			if (!summaryInfo) {
				welcome();
			}
		} else {
			for (const turn of turns) {
				turnEl(turn);
				renderSteps(turn);
				renderFoot(turn);
			}
			refreshActions();
		}
		if (summaryInfo) {
			updateSummaryDetails(summaryInfo);
		}
		renderLoadOlder();
		// A quiet reply is nowhere else: the redraw that just emptied the transcript puts it back.
		renderQuietReply(sessionId);
		// The whole transcript is drawn at once on open and on a chat switch: the rise animation
		// belongs to a message arriving during a turn, not to a replay of what was already there.
		for (const message of messagesEl.querySelectorAll('.msg')) {
			message.classList.add('no-anim');
		}
		syncDelegations();
		pinned = true;
		scroll(true);
		// A reload or a resync while a turn runs: the transcript the host persisted ends at the last
		// settled step, and the rest of the stream continues in this same turn. Whether this page is
		// the running turn's chat is decided by the host on the message itself, beside the transcript:
		// a stale snapshot, or a turn that ended while this guest was hidden, must never re-arm one.
		const lastTurn = turns[turns.length - 1];
		// Only the turn the host marks live may receive the stream after a redraw. Binding to a
		// settled previous turn is what made a prompt sent during pre-flight compaction disappear.
		if (runningHere && lastTurn && lastTurn.live) {
			resumeLive(lastTurn);
			tick();
		}
	}

	/** Registers a drawn turn's tool calls by id, so a result settles the card the redraw built. */
	function mapToolCards(turn) {
		for (const step of (turn && turn.steps) || []) {
			if (step.kind === 'tool' && step.id) {
				toolCards.set(step.id, step);
			}
		}
	}

	/**
	 * Re-attaches the live stream to a turn drawn from the persisted transcript. The steps already
	 * on screen are the host's record of this turn; a thought or text block still being written
	 * continues in place, and every tool call is registered so its result settles its own card.
	 */
	function resumeLive(turn) {
		if (!turn) {
			return;
		}
		live = { turn, thought: null, text: null, think: '', pending: false };
		mapToolCards(turn);
		const steps = turn.steps || [];
		const last = steps[steps.length - 1];
		if (last && last.kind === 'thought' && last._think) {
			live.thought = last;
			live.think = last.text || '';
			if (last._summary) {
				last._summary.textContent = 'Thinking…';
			}
		} else if (last && last.kind === 'text' && last._body) {
			live.text = last;
		}
		renderFoot(turn);
		refreshActions();
		tick();
	}

	/* ------------------------------------------------------------- subagent overlay */

	/**
	 * Only the topmost open dialog stays interactive. The subagent overlay sits above the Task
	 * Graph, so closing a child view returns to the map instead of unlocking the whole chat.
	 */
	function syncInert() {
		closePlanMenu(false);
		const active = subagentView ? 'subagent-view' : taskGraphShown ? 'task-graph-view' : null;
		for (const node of document.body.children) {
			node.inert = active !== null && node.id !== active;
		}
	}

	/**
	 * The open overlay's task chip and one chip per child session. A finished worker is only one
	 * step of a delegation: the verifier chips keep the whole batch visible without leaving it.
	 */
	function renderSubagentChildren(message) {
		const box = $('subagent-children');
		if (!box) {
			return;
		}
		const task = message && message.task;
		const children = message && Array.isArray(message.children) ? message.children : [];
		if (!subagentView || !message || message.id !== subagentView.id || !task || !children.length) {
			box.hidden = true;
			box.innerHTML = '';
			return;
		}
		const taskChip =
			'<span class="task ' +
			esc(task.status) +
			'" data-tip="' +
			esc(taskTip(task)) +
			'">' +
			taskGlyph(task.status) +
			' ' +
			esc(task.id) +
			' · ' +
			esc(taskStateLabel(task)) +
			'</span>';
		const chips = children
			.map((child) => {
				const label = (child.done ? '✔ ' : '◐ ') + child.role;
				return child.id === message.id
					? '<span class="subagent-child active" aria-current="true">' + esc(label) + '</span>'
					: '<button type="button" class="tool-open-subagent subagent-child" data-subagent="' +
							esc(child.id) +
							'" data-tip="Open the ' +
							esc(child.role) +
							' session">' +
							esc(label) +
							'</button>';
			})
			.join('');
		box.innerHTML = taskChip + chips;
		box.hidden = false;
	}

	/** A subagent's conversation, read-only: the parent chat keeps its place underneath. */
	function renderSubagentTurns(message) {
		if (!message || !message.id) {
			return;
		}
		if (subagentWanted !== message.id && (!subagentView || subagentView.id !== message.id)) {
			return;
		}
		if (subagentView && subagentView.id !== message.id) {
			subagentOpen.clear();
		}
		subagentView = message;
		subagentWanted = message.id;
		const view = $('subagent-view');
		if (!view) {
			return;
		}
		const wasHidden = view.hidden;
		view.hidden = false;
		syncInert();
		if (wasHidden) {
			$('subagent-close')?.focus();
		}
		$('subagent-title').textContent = message.title || 'Subagent session';
		$('subagent-status').textContent = message.done ? 'finished' : 'working…';
		renderSubagentChildren(message);
		const root = $('subagent-messages');
		const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 24;
		const keepScroll = root.scrollTop;
		root.innerHTML = '';
		for (const turn of message.turns || []) {
			for (const step of turn.steps || []) {
				if (step.kind === 'tool' && step.id && subagentOpen.has(step.id)) {
					step._open = subagentOpen.get(step.id);
				}
			}
			turnEl(turn, root, true);
			subagentRendering = true;
			try {
				renderSteps(turn);
			} finally {
				subagentRendering = false;
			}
			const foot = turn._foot;
			if (!foot) {
				continue;
			}
			const meta = document.createElement('span');
			meta.className = 'foot-meta';
			const tools = turnTools(turn);
			const seconds = turn.startedAt && turn.endedAt ? Math.max(0, Math.round((turn.endedAt - turn.startedAt) / 1000)) : 0;
			meta.textContent = message.done
				? [seconds >= 1 ? 'Worked for ' + seconds + 's' : 'Worked', tools ? tools + (tools === 1 ? ' tool' : ' tools') : ''].filter(Boolean).join(' · ')
				: 'Working…';
			foot.appendChild(meta);
		}
		for (const node of root.querySelectorAll('.msg')) {
			node.classList.add('no-anim');
		}
		root.scrollTop = atBottom ? root.scrollHeight : keepScroll;
	}

	/** A card already on screen (a repaint cleared the live step map) still gets its link. */
	function attachSubagentLink(callId, id) {
		if (!callId || !id) {
			return;
		}
		const card = [...document.querySelectorAll('#messages .tool-card')].find((item) => item.dataset.callId === callId);
		const head = card && card.querySelector('.tool-head-row');
		// A delegation card owns its links (worker + verifier); never add a second, stale one.
		if (!head || card.dataset.taskIds || card.querySelector('.tool-delegation') || head.querySelector('.tool-open-subagent')) {
			return;
		}
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'tool-open-subagent';
		button.dataset.subagent = id;
		button.dataset.tip = 'Open the subagent session';
		button.textContent = 'Open session';
		const timer = head.querySelector('.tool-time');
		head.insertBefore(button, timer || null);
	}

	function closeSubagentView() {
		if (!subagentView && !subagentWanted) {
			return;
		}
		subagentView = null;
		subagentWanted = null;
		subagentOpen.clear();
		const view = $('subagent-view');
		if (view) {
			view.hidden = true;
		}
		syncInert();
		// Back goes to the map if it is still open underneath, otherwise to the composer.
		const mapClose = taskGraphShown ? $('task-graph-close') : null;
		if (mapClose) {
			mapClose.focus();
		} else if (input) {
			input.focus();
		}
		vscode.postMessage({ type: 'closeSubagent' });
	}

	/* ------------------------------------------------------------- task graph modal */

	/** Opens the Task Graph modal for the active chat; the payload arrives from the host. */
	function openTaskGraphView() {
		if (!state || !state.taskBoard || !Array.isArray(state.taskBoard.nodes) || !state.taskBoard.nodes.length) {
			return;
		}
		taskGraphWanted = true;
		vscode.postMessage({ type: 'openTaskGraph' });
	}

	function closeTaskGraphView() {
		if (!taskGraphShown && !taskGraphWanted) {
			return;
		}
		taskGraphShown = false;
		taskGraphWanted = false;
		taskGraphView = null;
		const view = $('task-graph-view');
		if (view) {
			view.hidden = true;
		}
		if (taskGraphTick) {
			clearInterval(taskGraphTick);
			taskGraphTick = 0;
		}
		syncInert();
		const pill = $('task-graph-pill');
		const wrap = $('task-graph-wrap');
		if (pill && wrap && !wrap.hidden) {
			pill.focus();
		} else if (input) {
			input.focus();
		}
		vscode.postMessage({ type: 'closeTaskGraph' });
	}

	/** A duration span whose text the modal's ticker keeps current. */
	function taskGraphTimeHtml(start, end) {
		if (!start) {
			return '';
		}
		return '<span class="tg-time" data-start="' + esc(start) + '" data-end="' + esc(end || '') + '"></span>';
	}

	/** The root card: the chat/orchestrator, its state, context line and the graph objective. */
	function taskGraphRootHtml(root, view) {
		const working = running && (!runningSession || (state && runningSession === state.sessionId));
		const counts = (view && view.counts) || {};
		const tasks = view && Array.isArray(view.tasks) ? view.tasks : [];
		const accepted = counts.accepted || 0;
		return (
			'<div class="tg-card tg-root-card">' +
			'<div class="tg-task-head"><span class="tg-dot ' +
			(working ? 'running' : 'idle') +
			'"></span><span class="tg-task-title">' +
			esc((root && root.title) || 'Orchestrator') +
			'</span></div>' +
			'<div class="tg-task-meta"><span class="tg-state">' +
			esc('Orchestrator · ' + (working ? 'working' : 'idle')) +
			'</span><span class="tg-tokens">' +
			esc(accepted + '/' + tasks.length + ' accepted') +
			'</span></div>' +
			(root && root.detail ? '<div class="tg-detail" data-tip="' + esc(root.detail) + '">' + esc(root.detail) + '</div>' : '') +
			(view && view.objective
				? '<div class="tg-objective" data-tip="' + esc(view.objective) + '">' + esc(view.objective) + '</div>'
				: '') +
			'</div>'
		);
	}

	function taskGraphChildrenHtml(children) {
		if (!Array.isArray(children) || !children.length) {
			return '';
		}
		return (
			'<div class="tg-children">' +
			children
				.map((child) => {
					const label =
						'<span class="tg-dot ' +
						(child.done ? 'done' : 'working') +
						'"></span><span class="tg-agent-role">' +
						esc(child.role) +
						'</span>' +
						taskGraphTimeHtml(child.startedAt, child.finishedAt) +
						(child.tokens ? '<span class="tg-tokens">' + esc(formatTokens(child.tokens)) + ' tokens</span>' : '');
					return (
						'<button type="button" class="tool-open-subagent tg-agent" data-subagent="' +
						esc(child.id) +
						'" data-tip="Open the ' +
						esc(child.role) +
						' session">' +
						label +
						'</button>'
					);
				})
				.join('') +
			'</div>'
		);
	}

	function taskGraphTaskHtml(task) {
		const after = Array.isArray(task.dependsOn) && task.dependsOn.length
			? '<div class="tg-after">after ' + esc(task.dependsOn.join(', ')) + '</div>'
			: '';
		const rejection = task.rejection
			? '<div class="tg-rejection">' + esc(task.rejection.code + ': ' + task.rejection.reason) + '</div>'
			: '';
		const tokens = task.tokens ? '<span class="tg-tokens">' + esc(formatTokens(task.tokens)) + ' tokens</span>' : '';
		return (
			'<div class="tg-card tg-task ' +
			esc(task.status) +
			'" data-tip="' +
			esc(taskTip(task)) +
			'">' +
			'<div class="tg-task-head"><span class="tg-dot ' +
			esc(task.status) +
			'"></span><span class="tg-task-title">' +
			esc(task.title || task.id) +
			'</span><span class="tg-role">' +
			esc(task.role) +
			'</span></div>' +
			'<div class="tg-task-meta"><span class="tg-state ' +
			esc(task.status) +
			'">' +
			esc(task.stateLabel) +
			'</span>' +
			taskGraphTimeHtml(task.startedAt, task.finishedAt) +
			tokens +
			'</div>' +
			after +
			rejection +
			taskGraphChildrenHtml(task.children) +
			'</div>'
		);
	}

	/** Paints the running clocks without rebuilding the cards. */
	function paintTaskGraphTimes() {
		for (const el of document.querySelectorAll('#task-graph-view .tg-time')) {
			const start = Number(el.dataset.start);
			if (!start) {
				continue;
			}
			const end = Number(el.dataset.end) || Date.now();
			el.textContent = formatDuration(Math.max(0, end - start));
		}
	}

	/** Repaints only the root card, whose working dot follows the guest's live turn state. */
	function paintTaskGraphRoot() {
		const box = $('task-graph-root');
		if (!taskGraphShown || !box || !taskGraphView) {
			return;
		}
		box.innerHTML = taskGraphRootHtml(taskGraphView.root, taskGraphView.view);
	}

	/** Draws the Task Graph payload; a null view closes the modal. */
	function renderTaskGraph(message) {
		if (!message || !message.view) {
			closeTaskGraphView();
			return;
		}
		if (state && message.sessionId && state.sessionId && message.sessionId !== state.sessionId) {
			return;
		}
		if (!taskGraphWanted && !taskGraphShown) {
			return;
		}
		const view = $('task-graph-view');
		if (!view) {
			return;
		}
		taskGraphView = message;
		taskGraphWanted = true;
		const wasHidden = view.hidden;
		taskGraphShown = true;
		view.hidden = false;
		const graph = message.view;
		const tasks = Array.isArray(graph.tasks) ? graph.tasks : [];
		const agents = tasks.reduce((sum, task) => sum + (Array.isArray(task.children) ? task.children.length : 0), 0);
		const subtitle = [
			tasks.length + (tasks.length === 1 ? ' task' : ' tasks'),
			agents + (agents === 1 ? ' agent' : ' agents'),
			graph.notes ? graph.notes + (graph.notes === 1 ? ' note' : ' notes') : '',
			'click an agent for details',
		]
			.filter(Boolean)
			.join(' · ');
		const subtitleEl = $('task-graph-subtitle');
		if (subtitleEl) {
			subtitleEl.textContent = subtitle;
		}
		$('task-graph-root').innerHTML = taskGraphRootHtml(message.root, graph);
		$('task-graph-tasks').innerHTML = tasks.map(taskGraphTaskHtml).join('');
		paintTaskGraphTimes();
		if (!taskGraphTick) {
			taskGraphTick = setInterval(paintTaskGraphTimes, 1000);
		}
		syncInert();
		if (wasHidden) {
			$('task-graph-close')?.focus();
		}
	}

	/* ------------------------------------------------------------------ streaming */

	// A live turn is a turn like any other: events push new steps into it, in order, so a thought
	// that follows a tool call stays after it instead of being folded into one block.

	function beginTurn(message) {
		// A turn started anywhere means the last quiet turn's steps will never be consumed: its reply
		// either already came or never will (a stop, a stream lost while hidden). Clear them so a
		// later reply with the same chat id cannot attach a stale process to itself.
		const sessionId = String(message.sessionId || (state && state.sessionId) || '');
		if (sessionId) {
			pendingQuiet.delete(sessionId);
		}
		// A turn started anywhere invalidates an editor that was open on an older prompt.
		closeEdit();
		// Only an impersonation streams into the composer. Every other start says so — a turn whose end
		// was lost while hidden must not leave the next turn's text in the box.
		draft = message.draft === true;
		// An impersonation is not a turn: upstream clears the composer and streams your next message
		// into it, so the chat is left alone until you send it yourself.
		if (message.draft) {
			live = null;
			input.value = '';
			resizeInput();
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
				// An edited prompt is a new message: it starts folded rather than inheriting an old
				// expansion. A regenerate/swipe below keeps its key because the text is the same.
				promptOpen.delete(promptStateKey(removed));
				removed._root?.remove();
			}
			turns = turns.filter((turn) => turn.index < from);
		}
		const replacing = turns.find((turn) => turn.index === message.replaces);
		if (replacing) {
			turns = turns.filter((turn) => turn !== replacing);
			replacing._root?.remove();
		}
		// Only the empty chat's card goes: a quiet reply lives in `#messages` too, and it is the only
		// copy of itself, so the first prompt of the chat must not take it with the welcome page.
		messagesEl.querySelector('.msg.welcome')?.remove();
		const last = turns.length ? turns[turns.length - 1] : null;
		const turn = {
			index: from !== undefined && Number.isFinite(from) ? from : last ? last.index + 1 : 0,
			sessionId: message.sessionId,
			// A swipe or a regenerate re-runs the same prompt, and the host sends no text with it.
			prompt: message.text || replacing?.prompt || '',
			promptAttachments: message.attachments || replacing?.promptAttachments || [],
			steps: [],
			// A live turn has no transcript boundary yet: the host sends it with turn-end. Without
			// one, a mid-turn summary cannot fold the running turn (and its approval cards) into
			// the covered originals.
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
		// Start the clock now: a turn that spends its first seconds resolving references or
		// compacting has no steps yet, and a static "Working…" is indistinguishable from a freeze.
		tick();
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
			paintThoughtTokens(live.thought, true);
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
			if (live) {
				const meta = live.turn._foot && live.turn._foot.querySelector('.foot-meta');
				if (meta) {
					meta.textContent = workingLabel(live.turn);
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

	// A guest that missed the stream (a hidden view, a dropped message) asks the host for the
	// transcript it persisted while the turn ran. One request a second is enough: the answer
	// re-attaches the live turn, and the events after it land normally.
	let resyncAt = 0;

	function requestResync(force) {
		// Same fallback as the redraw: the turn the guest announced is the one to resync, even when the
		// last state message predates it.
		const runningSessionId = (state && state.running ? state.runningSessionId : null) || runningSession;
		if (!force && (!runningSessionId || state.sessionId !== runningSessionId)) {
			return;
		}
		// A forced resync is recovery, not chatter: it must not be swallowed by the throttle.
		const now = Date.now();
		if (!force && now - resyncAt < 1_000) {
			return;
		}
		resyncAt = now;
		vscode.postMessage({ type: 'resync' });
	}

	function toolStart(message) {
		if (!live) {
			requestResync();
			return;
		}
		flushOpen();
		freeze(live.thought);
		freeze(live.text);
		live.thought = null;
		live.text = null;
		// A redraw or a suspended-turn resume may have drawn this call from the transcript already
		// (a call that had not run yet). Settle that card instead of adding a twin that would spin
		// forever beside the real one.
		const known = message.id
			? live.turn.steps.find((step) => step.kind === 'tool' && step.id === message.id && step.result === undefined)
			: null;
		if (known) {
			known.name = message.name || known.name;
			known.args = message.args || known.args || '';
			known.command = message.command || known.command || '';
			known.description = message.description || known.description || '';
			known.status = 'running';
			known.ms = undefined;
			known.startedAt = Date.now();
			known._open = (known._details && known._details.open) || known._open === true;
			if (known._card) {
				known._card.replaceWith(toolCard(known));
			}
			toolCards.set(message.id, known);
			tick();
			scroll();
			return;
		}
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
		// A new call is not a reason to move a reader who scrolled away: the transcript follows the
		// end only while they are at it, exactly as it does for streamed text.
		scroll();
	}

	/**
	 * A fold that finished mid-turn belongs after the step that was current, inside the same turn:
	 * exactly where a replay's `turnsOf` puts it. Freezing the open buffers follows `toolStart` —
	 * a fold only happens between requests, but the invariant is cheap to keep.
	 */
	function appendCompaction(message) {
		const note = message.note;
		if (!note || typeof note !== 'object') {
			return;
		}
		if (!live) {
			requestResync();
			return;
		}
		if (live.turn.sessionId && message.sessionId && live.turn.sessionId !== message.sessionId) {
			return;
		}
		// A reload or resync may already have drawn this fold from the persisted transcript. The id
		// is the same on both sides, so an arriving event never doubles the card.
		const id = 'compaction:' + note.version + ':' + note.anchor;
		if (live.turn.steps.some((step) => step.kind === 'note' && step.id === id)) {
			return;
		}
		flushOpen();
		freeze(live.thought);
		freeze(live.text);
		live.thought = null;
		live.text = null;
		const step = appendStep(live.turn, { kind: 'note', id, note, at: note.at }, false);
		live.turn.steps.push(step);
		tick();
		scroll();
	}

	function toolResult(message) {
		const step = toolCards.get(message.id);
		if (!step) {
			// The card is gone (a redraw the guest never caught up with): the transcript has it,
			// so ask for it instead of leaving the result as a loose notice.
			requestResync();
			addNotice(message.output || '');
			return;
		}
		step.result = message.output || '';
		step.images = Array.isArray(message.images) ? message.images : [];
		step.plan = message.plan && typeof message.plan.name === 'string' ? message.plan : undefined;
		step.status = /^Error:/.test(step.result) ? 'error' : 'ok';
		freeze(step);
		// A click may not have dispatched its toggle yet: read the live element, then redraw the card
		// in place. `toolCard` stores the new element on the step, so the old one has to be held first
		// or the swapped-out card would replace itself.
		step._open = (step._details && step._details.open) || step._open === true;
		const card = step._card;
		if (planMenuState && card.contains(planMenuState.trigger)) {
			closePlanMenu(false);
		}
		card.replaceWith(toolCard(step));
		syncDelegations();
		paintTimer(step, false, Date.now());
		scroll();
	}

	/**
	 * A quiet turn is not a turn of the chat: its bubble existed only to show the stream, and the
	 * transcript never held it. Remove it — and do not ask for a resync, which would repaint the
	 * transcript and take the quiet card with it.
	 */
	function dropQuietTurn() {
		clearInterval(ticker);
		ticker = 0;
		if (!live) {
			return;
		}
		const turn = live.turn;
		// The steps exist only in this bubble: the transcript never held them, so harvest what is
		// worth keeping before it goes. The `quiet-reply` that follows paints them into the card; a
		// reply that never comes (a stop) leaves them for `beginTurn` to clear.
		const id = String(turn.sessionId || (state && state.sessionId) || '');
		if (id) {
			pendingQuiet.set(id, keptQuietSteps(turn));
		}
		for (const step of turn.steps || []) {
			if (step.kind === 'tool' && step.id && toolCards.get(step.id) === step) {
				// The bubble is gone: a late tool-result must not be told to settle a dead card.
				toolCards.delete(step.id);
			}
		}
		live = null;
		turn._root?.remove();
		// Leaving it in `turns` would make the guest number the next turn one past the transcript's.
		turns = turns.filter((item) => item !== turn);
		// The first quiet prompt of an empty chat took the welcome card away; the chat is empty again.
		if (!turns.length && !messagesEl.querySelector('.msg.welcome') && !summaryInfo) {
			messagesEl.insertBefore(welcome(), messagesEl.firstChild);
		}
		refreshActions();
		scroll();
	}

	function endTurn(message) {
		if (!live) {
			// The turn ended without this guest ever holding its live stream (a reload, a resync
			// that raced it). The host has the settled transcript now, so draw that instead of
			// leaving the reply missing.
			requestResync(true);
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
				step.tokens = report.tokens;
			}
		});
		const settledAt = Date.now();
		for (const step of turn.steps) {
			paintTimer(step, true, settledAt);
		}
		// The window too: the footer then reads the same whether it was watched or reloaded.
		turn.startedAt = message.startedAt ?? turn.startedAt;
		turn.endedAt = message.endedAt ?? settledAt;
		// The host knows where the finished turn ends; that boundary is what lets a later summary
		// fold this turn once it is no longer the newest.
		if (Number.isFinite(message.at)) {
			turn.at = message.at;
		}
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
			if (step.kind === 'thought') {
				paintThoughtTokens(step, false);
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
		// A resync or a dropped message can leave the drawn turn short of the steps the host
		// settled; the host's record is authoritative, so redraw it from there.
		if (currentView() !== 'rendered') {
			renderSteps(turn);
		} else if (settled.length > turn.steps.length) {
			turn.steps = settled;
			renderSteps(turn);
			// The redraw built new step objects: re-register them, or a later result would settle a card
			// that is no longer on screen.
			mapToolCards(turn);
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
		root.innerHTML = '<div class="approval-card"><div class="a-title">⚠ Approval required</div><div class="a-reason">' +
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
		// An approval belongs at the end of the turn, but it may not drag a reader there: the jump
		// button says a question is waiting without taking the page from under them.
		scroll();
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

	/* ------------------------------------------------------------------ questions */

	/** A one-row question textarea: the free-text answer, grown by the delegated input handler. */
	function questionInput(placeholder) {
		const area = document.createElement('textarea');
		area.className = 'q-input q-manual';
		area.rows = 1;
		area.placeholder = placeholder;
		return area;
	}

	/** Multi-select Send turns on for a checked option or typed text; other cards keep it enabled. */
	function syncSend(card) {
		if (!card.querySelector('input[type="checkbox"]')) {
			return;
		}
		const send = card.querySelector('button[data-q="send"]');
		if (send) {
			const checked = card.querySelector('input[type="checkbox"]:checked');
			const area = card.querySelector('textarea.q-input');
			send.disabled = !checked && !(area && area.value.trim());
		}
	}

	/** Submit the checked options and/or the typed answer; an empty card keeps its focus. */
	function submitQuestion(card) {
		const answers = [...card.querySelectorAll('input[type="checkbox"]:checked')].map((box) => box.value);
		const area = card.querySelector('textarea.q-input');
		const manual = area ? area.value.trim() : '';
		if (!answers.length && !manual) {
			if (area) {
				area.focus();
			}
			return;
		}
		settleQuestion(card, answers, manual);
	}

	function question(message) {
		// A repost after a chat switch or a reload is the same card, not a second question.
		if (document.querySelector('.question[data-id="' + message.id + '"]')) {
			return;
		}
		const options = Array.isArray(message.options) ? message.options : [];
		const multi = options.length > 0 && message.multi === true;
		const root = document.createElement('div');
		root.className = 'msg question';
		root.dataset.id = message.id;
		root.dataset.session = message.sessionId || '';
		const card = document.createElement('div');
		card.className = 'question-card';
		const title = document.createElement('div');
		title.className = 'q-title';
		title.textContent = 'Question';
		const text = document.createElement('div');
		text.className = 'q-text';
		text.textContent = message.question || '';
		card.append(title, text);
		const actions = document.createElement('div');
		actions.className = 'actions';
		if (options.length) {
			const list = document.createElement('div');
			list.className = 'q-options';
			if (multi) {
				for (const option of options) {
					const label = document.createElement('label');
					label.className = 'q-option';
					const box = document.createElement('input');
					box.type = 'checkbox';
					box.value = option;
					const span = document.createElement('span');
					span.textContent = option;
					label.append(box, span);
					list.appendChild(label);
				}
			} else {
				for (const option of options) {
					const button = document.createElement('button');
					button.className = 'q-option';
					button.dataset.q = 'option';
					button.dataset.value = option;
					button.textContent = option;
					list.appendChild(button);
				}
			}
			card.appendChild(list);
		}
		// The user may always type an answer, whether or not the model offered options.
		card.appendChild(questionInput(options.length ? 'Or type your own answer…' : 'Type your answer…'));
		const send = document.createElement('button');
		send.className = 'primary';
		send.dataset.q = 'send';
		send.textContent = 'Send';
		send.disabled = multi;
		actions.appendChild(send);
		const skip = document.createElement('button');
		skip.className = 'ghost';
		skip.dataset.q = 'skip';
		skip.textContent = 'Skip';
		actions.appendChild(skip);
		card.appendChild(actions);
		root.appendChild(card);
		// The question belongs to the turn that asked it, so it sits with that turn's steps.
		if (live) {
			live.turn._steps.appendChild(root);
		} else {
			messagesEl.appendChild(root);
		}
		// A question belongs at the end of the turn, but it may not drag a reader there.
		scroll();
	}

	function settleQuestion(card, answers, manual) {
		if (card.classList.contains('answered') || card.classList.contains('withdrawn')) {
			return;
		}
		card.classList.add('answered');
		for (const control of card.querySelectorAll('button, input, textarea')) {
			control.disabled = true;
		}
		const shown = manual ? [...new Set([...answers, manual])] : answers;
		const actions = card.querySelector('.actions');
		if (actions) {
			const done = document.createElement('span');
			done.className = 'q-done';
			done.textContent = shown.length ? shown.join(', ').slice(0, 200) : 'Skipped';
			actions.replaceChildren(done);
		}
		vscode.postMessage({ type: 'answer', id: card.dataset.id, answers, ...(manual ? { manual } : {}) });
	}

	/** A stopped turn withdraws its question: the card stays as a record, but nothing can be chosen. */
	function withdrawQuestions(ids) {
		for (const id of ids || []) {
			const card = document.querySelector('.question[data-id="' + id + '"]');
			if (!card || card.classList.contains('answered') || card.classList.contains('withdrawn')) {
				continue;
			}
			card.classList.add('withdrawn');
			for (const control of card.querySelectorAll('button, input, textarea')) {
				control.disabled = true;
			}
			const actions = card.querySelector('.actions');
			if (actions) {
				const cancelled = document.createElement('span');
				cancelled.className = 'a-cancelled';
				cancelled.textContent = 'Cancelled';
				actions.replaceChildren(cancelled);
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
		for (const menu of document.querySelectorAll('#messages .tool-menu, #subagent-messages .tool-menu')) {
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

	/** Ask the host to open a reference chip or an inline token. */
	function openReference(element) {
		if (element.classList.contains('ref-token')) {
			// The painted token is exactly what the host parser reads; no second grammar here.
			vscode.postMessage({
				type: 'openReference',
				token: element.textContent || '',
				sessionId: (state && state.sessionId) || undefined,
			});
			return;
		}
		if (element.dataset.pasteTurn !== undefined) {
			vscode.postMessage({
				type: 'openPastedText',
				sessionId: element.dataset.pasteSession || (state && state.sessionId) || undefined,
				turn: Number(element.dataset.pasteTurn),
				index: Number(element.dataset.pasteIndex),
			});
			return;
		}
		vscode.postMessage({
			type: 'openReference',
			path: element.dataset.refPath,
			start: element.dataset.refStart ? Number(element.dataset.refStart) : undefined,
			end: element.dataset.refEnd ? Number(element.dataset.refEnd) : undefined,
			sessionId: (state && state.sessionId) || undefined,
		});
	}

	/** Enter or Space on a focused reference is a click. */
	function referenceKey(event) {
		if (event.key !== 'Enter' && event.key !== ' ') {
			return;
		}
		const ref = event.target.closest('.ref[data-ref-path], .ref[data-paste-turn], .ref-token');
		if (!ref) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		openReference(ref);
	}

	/** The interactive bits a transcript and the subagent overlay share: links, copies, tool menus. */
	function handleRichClick(event) {
		const ref = event.target.closest('.ref[data-ref-path], .ref[data-paste-turn], .ref-token');
		if (ref) {
			event.preventDefault();
			event.stopPropagation();
			closeToolMenus();
			openReference(ref);
			return true;
		}
		const openSub = event.target.closest('button.tool-open-subagent');
		if (openSub) {
			event.preventDefault();
			event.stopPropagation();
			const id = openSub.dataset.subagent;
			if (id) {
				subagentWanted = id;
				vscode.postMessage({ type: 'openSubagent', id });
			}
			return true;
		}
		const pick = event.target.closest('button[data-plan-pick]');
		if (pick) {
			event.preventDefault();
			event.stopPropagation();
			if (planMenuState && planMenuState.trigger === pick) {
				closePlanMenu(true);
			} else {
				openPlanMenu(pick);
			}
			return true;
		}
		const plan = event.target.closest('button[data-plan]');
		if (plan) {
			event.preventDefault();
			event.stopPropagation();
			if (!plan.disabled) {
				const card = plan.closest('.plan-card');
				const step = card && card._planStep;
				const choice = step ? planChoice(step) : undefined;
				const build = plan.dataset.planAction === 'build';
				vscode.postMessage({
					// The button names the action; its own field decides the payload.
					type: build ? 'buildPlan' : 'previewPlan',
					name: plan.dataset.plan,
					relative: (card && card.dataset.relative) || undefined,
					sessionId: plan.dataset.session || undefined,
					// Only a build carries the picks; a preview has no use for them.
					...(build ? { model: planBuildModel(choice), mode: planBuildMode(choice) } : {}),
				});
			}
			return true;
		}
		const more = event.target.closest('button.tool-more');
		if (more) {
			event.stopPropagation();
			toggleToolMenu(more);
			return true;
		}
		const copied = event.target.closest('.tool-menu button[data-copy]');
		if (copied) {
			event.stopPropagation();
			copyToolPart(copied);
			return true;
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
			return true;
		}
		const link = event.target.closest('a[data-url]');
		if (link) {
			event.preventDefault();
			vscode.postMessage({ type: 'openUrl', url: link.dataset.url });
			return true;
		}
		return false;
	}

	messagesEl.addEventListener('click', (event) => {
		if (handleRichClick(event)) {
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
			return;
		}
		const control = event.target.closest('.question button[data-q]');
		if (!control || control.disabled) {
			return;
		}
		const card = control.closest('.question');
		const action = control.dataset.q;
		if (action === 'option') {
			control.classList.add('chosen');
			settleQuestion(card, [control.dataset.value]);
		} else if (action === 'send') {
			submitQuestion(card);
		} else {
			settleQuestion(card, []);
		}
	});

	messagesEl.addEventListener('keydown', referenceKey);

	// Enter and Escape belong to the open question, not to the global Stop shortcut.
	messagesEl.addEventListener('keydown', (event) => {
		const card = event.target.closest('.question');
		if (!card || card.classList.contains('answered') || card.classList.contains('withdrawn')) {
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			settleQuestion(card, []);
			return;
		}
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target.classList.contains('q-input')) {
			event.preventDefault();
			submitQuestion(card);
		}
	});

	// The multi-select Send waits for a checked option or typed text.
	messagesEl.addEventListener('change', (event) => {
		const box = event.target.closest('.question input[type="checkbox"]');
		if (box) {
			syncSend(box.closest('.question'));
		}
	});

	// Typed text grows the box and, on a multi-select card, satisfies Send.
	messagesEl.addEventListener('input', (event) => {
		const area = event.target.closest('.question textarea.q-input');
		if (!area) {
			return;
		}
		area.style.height = 'auto';
		area.style.height = Math.min(area.scrollHeight, 200) + 'px';
		syncSend(area.closest('.question'));
	});

	// The composer pill opens the Task Graph; its child chips use the rich-click handler.
	const taskGraphPill = $('task-graph-pill');
	if (taskGraphPill) {
		taskGraphPill.addEventListener('click', openTaskGraphView);
	}
	const taskGraphViewEl = $('task-graph-view');
	if (taskGraphViewEl) {
		taskGraphViewEl.addEventListener('click', handleRichClick);
		taskGraphViewEl.addEventListener('click', (event) => {
			if (event.target === taskGraphViewEl) {
				closeTaskGraphView();
			}
		});
	}
	const taskGraphClose = $('task-graph-close');
	if (taskGraphClose) {
		taskGraphClose.addEventListener('click', () => closeTaskGraphView());
	}

	const subagentChildrenEl = $('subagent-children');
	if (subagentChildrenEl) {
		subagentChildrenEl.addEventListener('click', handleRichClick);
	}

	const subagentMessagesEl = $('subagent-messages');
	if (subagentMessagesEl) {
		subagentMessagesEl.addEventListener('click', handleRichClick);
		subagentMessagesEl.addEventListener('keydown', referenceKey);
		subagentMessagesEl.addEventListener(
			'scroll',
			() => {
				if (planMenuState) {
					closePlanMenu(false);
				}
			},
			{ passive: true },
		);
		subagentMessagesEl.addEventListener(
			'toggle',
			(event) => {
				const details = event.target.closest('.tool-details');
				const card = details && details.closest('.tool-card');
				if (details && card && card.dataset.callId) {
					subagentOpen.set(card.dataset.callId, details.open);
				}
			},
			true,
		);
	}
	const subagentClose = $('subagent-close');
	if (subagentClose) {
		subagentClose.addEventListener('click', () => closeSubagentView());
	}

	/* ------------------------------------------------------------------ state & history */

	function setRunning(value) {
		if (value && !running) {
			closeEdit();
			closeMention();
			closeMenus();
			closePlanMenu(false);
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
		// A plan cannot be built on top of the turn that is still writing it. The sync also keeps a
		// keyless selected model's Build disabled once the turn is over.
		syncPlanCards();
		refreshActions();
		// The Task Graph's root card follows the turn without waiting for a host payload.
		if (taskGraphShown) {
			paintTaskGraphRoot();
		}
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

	/** The list's scope: this workspace, or every workspace the extension host has seen. */
	function renderScope() {
		const all = Boolean(state && state.historyScope === 'all');
		scopeButton.textContent = all ? 'All workspaces' : 'This workspace';
		scopeButton.dataset.tip = all
			? 'Showing chats from every workspace — click to show only this one'
			: 'Showing chats from this workspace — click to show every workspace';
		scopeButton.classList.toggle('is-on', all);
		scopeButton.setAttribute('aria-pressed', all ? 'true' : 'false');
	}

	function renderChats() {
		chatsEl.hidden = !chatsOpen;
		// The list is the whole header: with it closed the panel starts straight at the transcript.
		barEl.hidden = !chatsOpen;
		if (!chatsOpen) {
			return;
		}
		renderScope();
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
		if (!items.length) {
			const empty = document.createElement('p');
			empty.className = 'muted';
			empty.textContent = state && state.historyScope === 'all' ? 'No chats yet' : 'No chats in this workspace yet';
			chatsList.append(empty);
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

	/**
	 * The usage/context line above the composer. Recomposed from the snapshot so a status-only
	 * message can update it without repainting anything else.
	 */
	function renderStatus() {
		if (!state) {
			return;
		}
		const detail = [state.detail, state.suspended ? '⏸ waiting for approval — send /resume' : ''].filter(Boolean).join('  ·  ');
		$('status').textContent = detail;
	}

	function renderState() {
		if (!state) {
			return;
		}
		if (state.sessionId !== shownSession) {
			// A query belongs to the session that was active when it was typed.
			shownSession = state.sessionId;
			closeMention();
			closePlanMenu(false);
			// The overlay and the task graph belong to the chat they were opened from.
			closeSubagentView();
			closeTaskGraphView();
		}
		renderChats();
		fillPill(modePill, state.modes, state.mode, 'Work mode — what the agent may do');
		fillPill(approvalPill, state.approvals, state.approval, 'Tool approval policy — what happens to a call no rule matched');
		fillPill(sandboxPill, state.sandboxes, state.sandboxMode, 'Sandbox mode — how far reads and writes may reach');
		fillGenerations();
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
			renderTurns(turns, state && state.sessionId, summaryInfo, pageInfo, false);
		}
		shownView = currentView();
		if (!running && !live) {
			shownToolCard = cardMode;
		}
		// The model list arrives on its own `models` message; the state only names the current pick.
		modelState.model = state.model;
		modelState.modelLabel = state.modelLabel || state.model || 'auto';
		modelState.reasoningEffort = state.reasoningEffort || 'auto';
		modelState.reasoningEffortResolved = state.reasoningEffortResolved || '';
		modelState.contextWindow = Number(state.contextWindow) || 0;
		modelState.windowTokens = Number(state.windowTokens) || 0;
		updateModelPill();
		// The cards keep their own picks; a new model list or mode only relabels them.
		syncPlanCards();
		const noSandbox = state.sandbox === 'none';
		environmentChip.hidden = !noSandbox;
		environmentChip.textContent = noSandbox ? (state.remote ? 'remote · no sandbox' : 'no OS sandbox') : '';
		environmentChip.dataset.tip = noSandbox
			? state.sandboxMode === 'danger-full-access'
				? state.network
					? 'No OS sandbox on this host; the full-access sandbox mode runs shell commands unconfined.'
					: 'No OS sandbox on this host, so the network access policy cannot be enforced.\nShell commands are refused until network is on; then full access runs them unconfined.'
				: 'No OS sandbox on this host — shell commands are refused.\nChoose danger-full-access with network on to run them unconfined.'
			: '';
		refreshTip();
		renderStatus();
		renderTaskGraphPill();
		syncDelegations();
		renderTodos();
		// The snapshot is authoritative about what runs: an idle one drops a session id left over from
		// a turn whose end this guest never saw.
		runningSession = state.running ? state.runningSessionId || runningSession : null;
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

	/** The most active state across the graph, for the pill's dot. */
	function taskGraphStatus(nodes) {
		if (nodes.some((task) => task.status === 'rejected')) {
			return 'rejected';
		}
		if (nodes.some((task) => task.status === 'running')) {
			return 'running';
		}
		if (nodes.some((task) => task.status === 'verifying')) {
			return 'verifying';
		}
		if (nodes.some((task) => task.status === 'paused')) {
			return 'paused';
		}
		return nodes.length && nodes.every((task) => task.status === 'accepted') ? 'accepted' : 'pending';
	}

	/** The composer pill that opens the Task Graph; hidden until the chat has a graph. */
	function renderTaskGraphPill() {
		const wrap = $('task-graph-wrap');
		if (!wrap) {
			return;
		}
		const board = state && state.taskBoard;
		const list = board && Array.isArray(board.nodes) ? board.nodes : [];
		wrap.hidden = !list.length;
		if (!list.length) {
			return;
		}
		const accepted = (board.counts && board.counts.accepted) || 0;
		const count = $('task-graph-count');
		if (count) {
			count.textContent = accepted + '/' + list.length;
		}
		const dot = $('task-graph-dot');
		if (dot) {
			dot.dataset.status = taskGraphStatus(list);
		}
		const button = $('task-graph-pill');
		if (button) {
			button.dataset.tip = 'Open the Task Graph — ' + accepted + '/' + list.length + ' accepted';
			button.setAttribute('aria-label', 'Open the Task Graph (' + accepted + ' of ' + list.length + ' tasks accepted)');
		}
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
				// A plugin mounting or a command file changing repaints the open `/` menu in place.
				if (mention && mention.mode === 'command') {
					mention.items = commandRows(mention.query);
					renderMention();
				}
				break;
			case 'status':
				// One model round trip finished: the host sends the line alone, so the transcript
				// and the rest of the snapshot are not rebuilt mid-turn.
				if (state && message.sessionId === state.sessionId) {
					state.detail = typeof message.detail === 'string' ? message.detail : '';
					renderStatus();
				}
				break;
			case 'models':
				// The list travels on its own message so a slow endpoint never delays the state above.
				modelState.models = Array.isArray(message.models) ? message.models : [];
				// Open pickers read the list live: relabel the plan cards and refill a flyout on screen.
				syncPlanCards();
				if (flyoutPage === 'model' && !modelFlyout.hidden) {
					fillFlyout('model');
				}
				break;
			case 'toggleHistory':
				// The title-bar icon (comonad.toggleHistory) flips the chat list.
				chatsOpen = !chatsOpen;
				renderChats();
				break;
			case 'changes':
				renderChanges(message.files || [], message.reviewed || []);
				break;
			case 'task-board':
				if (state) {
					state.taskBoard = message.board || null;
					renderTaskGraphPill();
					syncDelegations();
				}
				break;
			case 'turns':
				if (message.prepend) {
					prependTurns(message);
				} else {
					renderTurns(
						message.turns || [],
						message.sessionId,
						message.summary,
						{
							firstTurnIndex: message.firstTurnIndex,
							totalTurns: message.totalTurns,
							hasMore: message.hasMore === true,
						},
						message.running === true,
					);
				}
				break;
			case 'summary':
				updateSummary(message.summary);
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
			case 'quiet-reply': {
				// The reply belongs to the chat that asked, which may no longer be the one on screen.
				const id = typeof message.sessionId === 'string' && message.sessionId
					? message.sessionId
					: (state && state.sessionId) || '';
				if (id) {
					// The steps were harvested when the bubble was dropped: take them, so this reply
					// carries the process behind it and a second reply cannot reuse them.
					const steps = pendingQuiet.get(id);
					pendingQuiet.delete(id);
					quietReplies.set(id, { text: String(message.text || '(no reply)'), steps });
					if (!state || id === state.sessionId) {
						renderQuietReply(id);
					}
				}
				break;
			}
			case 'compaction':
				// The card belongs to the turn that folded; another chat's late fold is ignored.
				if (state && message.sessionId && message.sessionId !== state.sessionId) {
					break;
				}
				appendCompaction(message);
				break;
			case 'turn-start':
				acceptPendingSend();
				runningSession = message.sessionId || runningSession;
				setRunning(true);
				beginTurn(message);
				break;
			case 'send-refused':
				refusePendingSend(message);
				break;
			case 'turn-resume': {
				runningSession = message.sessionId || runningSession;
				setRunning(true);
				// A resumed turn is the same turn: keep appending its steps to the last one.
				const turn = turns.length ? turns[turns.length - 1] : null;
				if (turn) {
					turn.sessionId = turn.sessionId || message.sessionId;
					resumeLive(turn);
				}
				break;
			}
			case 'text':
				// A draft turn is being written into the composer, not into the transcript: the box grows
				// with the text, and its end stays in view.
				if (draft) {
					input.value += message.text || '';
					resizeInput();
					input.scrollTop = input.scrollHeight;
				} else {
					appendText(message.text);
				}
				break;
			case 'draft':
				// The finished impersonation as one piece of text, so nothing depends on how it streamed,
				// with the caret where you edit it before sending.
				input.value = message.text || '';
				resizeInput();
				input.scrollTop = input.scrollHeight;
				input.focus();
				break;
			case 'reasoning':
				appendReasoning(message.text);
				break;
			case 'tool-start':
				toolStart(message);
				break;
			case 'attachments':
				if (live) {
					live.turn.promptAttachments = Array.isArray(message.attachments) ? message.attachments : [];
					renderPromptAttachments(live.turn);
				}
				break;
			case 'tool-result':
				toolResult(message);
				break;
			case 'subagent-start': {
				// The child exists while its call is still running: the live card gains its link now.
				const step = toolCards.get(message.callId);
				if (step) {
					step.subagentId = message.id;
					step.subagentName = message.name;
					const card = step._card;
					if (card) {
						step._open = (step._details && step._details.open) || step._open === true;
						card.replaceWith(toolCard(step));
						syncDelegations();
					}
				} else {
					attachSubagentLink(message.callId, message.id);
				}
				break;
			}
			case 'subagent-open':
				// A webview reload reopens the overlay it had; this is the one unsolicited open.
				subagentWanted = message.id;
				renderSubagentTurns(message);
				break;
			case 'subagent':
				renderSubagentTurns(message);
				break;
			case 'subagent-children':
				// A sibling started or finished: only the chip row moves, never the transcript.
				if (subagentView && message.id === subagentView.id) {
					subagentView.task = message.task;
					subagentView.children = Array.isArray(message.children) ? message.children : [];
					renderSubagentChildren(subagentView);
				}
				break;
			case 'task-graph':
				renderTaskGraph(message);
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
			case 'question':
				question(message);
				break;
			case 'question-withdraw':
				withdrawQuestions(message.ids);
				break;
			case 'stop-ack':
				if (message.ok === false) {
					if (message.running === true) {
						// The host still owns a turn that is already aborting: its turn-end settles this.
						break;
					}
					// Nothing was running where Stop was sent: this guest lost the turn-end (a hidden
					// panel receives no messages). Clear the stale flag and repaint from the host's
					// transcript, which has what the live stream missed.
					runningSession = null;
					draft = false;
					setRunning(false);
					addNotice('Nothing to stop — the turn already ended.');
					requestResync(true);
				}
				break;
			case 'turn-end': {
				// The panel may have switched chats mid-turn; only settle the live turn it belongs to.
				// A live turn drawn from a transcript older than this field has no chat id: it can only
				// be the one this turn-end settles, so it must not be skipped.
				const mine = !live || !message.sessionId || !live.turn.sessionId || message.sessionId === live.turn.sessionId;
				setRunning(false);
				runningSession = null;
				// Anything still unanswered in the DOM belongs to the turn that just ended.
				for (const card of document.querySelectorAll('.approval:not(.answered):not(.withdrawn)')) {
					card.classList.add('withdrawn');
					for (const button of card.querySelectorAll('button')) {
						button.disabled = true;
					}
				}
				withdrawQuestions(
					[...document.querySelectorAll('.question:not(.answered):not(.withdrawn)')].map((card) => card.dataset.id),
				);
				if (mine) {
					draft = false;
					// A quiet turn never existed in the transcript: take its bubble out and leave the
					// transcript alone — `endTurn` would ask for a resync that erased the reply card.
					if (message.quiet === true) {
						dropQuietTurn();
					} else {
						endTurn(message);
					}
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

	/* ------------------------------------------------------------------ composer picker */

	// One floating list serves both the `@` reference picker and the `/` command menu: only one can
	// be open, and the arrow, Tab, Enter and Escape keys mean the same thing in both.

	const MENTION_CATEGORIES = [
		{ kind: 'mode', mode: 'file', label: 'Files', description: 'Search workspace files' },
		{ kind: 'mode', mode: 'folder', label: 'Folders', description: 'Search workspace folders' },
		{ kind: 'mode', mode: 'symbol', label: 'Symbols', description: 'Search code symbols' },
		{ kind: 'mode', mode: 'selection', label: 'Current selection', description: 'Use the code selected in the editor' },
	];

	const PICKER_LABELS = { command: 'Commands', file: 'Files', folder: 'Folders', symbol: 'Symbols', selection: 'Selection' };
	const PICKER_ICONS = { mode: '›', selection: '↔', file: 'F', folder: 'D', symbol: 'S' };
	const PICKER_EMPTY = { command: 'No matching commands', symbol: 'Type to search symbols' };

	/**
	 * The `/` menu's rows. Commands arrive with `state`, so filtering is local: the list is small and
	 * the menu must answer at typing speed. Prefix matches rank above substring matches.
	 */
	function commandRows(query) {
		const commands = state && Array.isArray(state.commands) ? state.commands : [];
		const needle = query.toLowerCase();
		const matches = needle ? commands.filter((command) => command.name.toLowerCase().includes(needle)) : commands;
		const prefix = needle ? matches.filter((command) => command.name.toLowerCase().startsWith(needle)) : [];
		const rest = needle ? matches.filter((command) => !command.name.toLowerCase().startsWith(needle)) : matches;
		return [...prefix, ...rest].slice(0, 50).map((command) => ({
			kind: 'command',
			name: command.name,
			label: '/' + command.name,
			description: [command.hint, command.description || (command.custom ? 'Custom command' : '')].filter(Boolean).join(' · '),
			token: '/' + command.name,
		}));
	}

	/** Whether `@` may start a reference after this character. Mirrors the parser's boundary. */
	function mentionBoundary(previous) {
		return previous === undefined || !/[A-Za-z0-9_.@/\\-]/.test(previous);
	}

	/** The full-width ASCII a Chinese IME can produce, folded to what the host matches. */
	function halfWidth(text) {
		return String(text ?? '')
			.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
			.replace(/　/g, ' ');
	}

	/** A prose mark ends the query; brackets stay, since a path can contain them. */
	const MENTION_QUERY_END = /[，。；：！？、,;!?…]/;
	/** A following punctuation mark needs no space before it when the token is inserted. */
	const MENTION_SUFFIX_PUNCT = /^[.,;:!?，。；：！？、…)\]}）】》」』]/;

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
			mentionHead.textContent = PICKER_LABELS[mention.mode] + (mention.query ? ' · ' + mention.query : '');
		}
		mentionList.innerHTML = '';
		const rows = mentionRows();
		if (!rows.length) {
			const empty = document.createElement('div');
			empty.className = 'mention-hint';
			const waiting = mention.mode === 'command' && !state ? 'Commands are still loading…' : PICKER_EMPTY[mention.mode];
			empty.textContent = mention.hint || waiting || 'No matches';
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
			// A command's label already starts with `/`; it needs no icon column.
			if (item.kind !== 'command') {
				const icon = document.createElement('span');
				icon.className = 'mention-icon';
				icon.textContent = PICKER_ICONS[item.kind] || 'S';
				row.append(icon);
			}
			const label = document.createElement('span');
			label.className = 'mention-label';
			label.textContent = item.label;
			const detail = document.createElement('span');
			detail.className = 'mention-detail';
			detail.textContent = item.description || '';
			row.append(label, detail);
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
		if (!mention || mention.mode === 'categories' || mention.mode === 'command' || mention.composing) {
			return;
		}
		clearTimeout(mention.timer);
		const send = () => {
			if (!mention || mention.mode === 'categories' || mention.mode === 'command') {
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
		const original = input.value.slice(mention.start + 1, caret);
		if (/\s/.test(original)) {
			closeMention();
			return;
		}
		// Cut at the first prose mark before folding: folding would turn `：` into `:` and lose the
		// difference between a Chinese comma after a note name and a real range/symbol colon.
		const cut = original.search(MENTION_QUERY_END);
		const end = cut < 0 ? caret : mention.start + 1 + cut;
		const raw = halfWidth(cut < 0 ? original : original.slice(0, cut));
		mention.caret = caret;
		mention.end = end;
		if (mention.mode === 'command') {
			// Commands are in `state`: filter here, and never ask the host for a row it already sent.
			const changed = raw !== mention.query;
			mention.query = raw;
			mention.items = commandRows(raw);
			if (changed) {
				mention.active = 0;
				mention.hint = '';
			}
			renderMention();
			return;
		}
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

	function openMention(mode, start, caret) {
		closeMention();
		mention = {
			mode,
			query: '',
			start,
			caret,
			end: caret,
			items: mode === 'command' ? commandRows('') : [],
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
		// The query may have been cut before a prose mark (`@广义，`): replace only up to that mark
		// and keep the user's punctuation. A punctuation that follows needs no space before it.
		const after = input.value.slice(mention.end);
		const suffix = /^\s/.test(after) || MENTION_SUFFIX_PUNCT.test(after) ? '' : ' ';
		input.setRangeText(item.token + suffix, mention.start, mention.end, 'end');
		resizeInput();
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
			const row = rows[Math.max(0, Math.min(mention.active, rows.length - 1))];
			// Enter on the exact name runs it: completing `/help` again would make the user press
			// Enter twice for the command they already typed.
			if (event.key === 'Enter' && mention.mode === 'command' && row.name.toLowerCase() === mention.query.toLowerCase()) {
				closeMention();
				return false;
			}
			event.preventDefault();
			acceptMention(row);
			return true;
		}
		return false;
	}

	/**
	 * Ranges of fenced code and inline code spans. Mirrors `codeRanges` in src/lib/references.ts:
	 * an @ inside them is literal Markdown, not a reference chip.
	 */
	function codeRanges(text) {
		const ranges = [];
		let fence;
		let lineStart = 0;
		for (;;) {
			const newline = text.indexOf('\n', lineStart);
			const lineEnd = newline < 0 ? text.length : newline;
			const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');
			const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			let fenceLine = false;
			if (fence) {
				if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
					ranges.push({ start: fence.start, end: newline < 0 ? text.length : newline + 1 });
					fence = undefined;
					fenceLine = true;
				}
			} else if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
				fence = { start: lineStart, char: marker[1][0], length: marker[1].length };
				fenceLine = true;
			}
			if (!fence && !fenceLine) {
				inlineCodeRanges(text, lineStart, lineEnd, ranges);
			}
			if (newline < 0) {
				break;
			}
			lineStart = newline + 1;
		}
		if (fence) {
			ranges.push({ start: fence.start, end: text.length });
		}
		return ranges;
	}

	function inlineCodeRanges(text, from, to, ranges) {
		const runs = [];
		for (let index = from; index < to; index += 1) {
			if (text[index] !== '`') {
				continue;
			}
			const start = index;
			while (index < to && text[index] === '`') {
				index += 1;
			}
			runs.push({ start, end: index, length: index - start });
		}
		if (runs.length < 2) {
			return;
		}
		const next = new Array(runs.length);
		const seen = new Map();
		for (let index = runs.length - 1; index >= 0; index -= 1) {
			const run = runs[index];
			next[index] = seen.get(run.length);
			seen.set(run.length, index);
		}
		for (let index = 0; index < runs.length; ) {
			const open = runs[index];
			// Backslash escapes do not work inside a span, so only an opener is checked.
			if (isEscaped(text, open.start)) {
				index += 1;
				continue;
			}
			const close = next[index];
			if (close === undefined) {
				index += 1;
				continue;
			}
			ranges.push({ start: open.start, end: runs[close].end });
			index = close + 1;
		}
	}

	/** Whether an odd number of backslashes immediately precedes `index`. */
	function isEscaped(text, index) {
		let count = 0;
		for (let before = index - 1; before >= 0 && text[before] === '\\'; before -= 1) {
			count += 1;
		}
		return count % 2 === 1;
	}

	/** Escapes a prompt and paints @ references as chips; the textarea itself stays raw. */
	function renderPromptHtml(text) {
		const source = String(text ?? '');
		const code = codeRanges(source);
		let codeAt = 0;
		let out = '';
		let last = 0;
		const pattern = /(^|[^A-Za-z0-9_.@/\\-])((?:@|＠)(?:symbol:"[^"]*":[^\s@]+|"[^"]*"(?::\d+(?:-\d+)?|\/)?|symbol:[^\s@，。；：！？、,;!?…]+|[^\s@，。；：！？、,;!?…]+))/g;
		for (const match of source.matchAll(pattern)) {
			const index = match.index ?? 0;
			const start = index + match[1].length;
			// Check the @ itself, not the match prefix: a span may end immediately before it.
			while (codeAt < code.length && code[codeAt].end <= start) {
				codeAt += 1;
			}
			if (codeAt < code.length && code[codeAt].start <= start) {
				continue;
			}
			out += esc(source.slice(last, start));
			const token = match[2];
			const tailPattern = /^(?:@|＠)symbol:/.test(token)
				? /[.,;:!?，。；：！？、…]+$/
				: /[.,;:!?，。；：！？、…)\]}）】》」』]+$/;
			const tail = tailPattern.exec(token);
			const tailText = tail ? tail[0] : '';
			const body = tailText ? token.slice(0, -tailText.length) : token;
			out += '<span class="ref-token" role="link" tabindex="0" title="Open this reference">' + esc(body) + '</span>' + esc(tailText);
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
		resizeInput();
		input.focus();
		input.scrollTop = input.scrollHeight;
	}

	/* ------------------------------------------------------------------ composer pastes */

	// A long paste stays out of the textarea: Chromium lays the whole value out on every keystroke, so
	// a pasted block makes every later key slower. The block becomes a chip above the input and travels
	// as a user note attachment; the transcript draws its name, not the whole text.
	const PASTE_CHIP_CHARS = 20_000;
	/** What one paste may carry. The kernel bounds a stored text attachment at the same size. */
	const MAX_PASTE_CHARS = 200_000;
	const MAX_COMPOSER_PASTES = 6;
	const composerPastes = [];
	let pasteSeq = 0;

	function renderComposerPastes() {
		composerPastesEl.innerHTML = '';
		composerPastesEl.hidden = composerPastes.length === 0;
		composerPastes.forEach((paste, index) => {
			const chip = document.createElement('div');
			chip.className = 'composer-paste';
			const label = document.createElement('span');
			label.className = 'composer-paste-label';
			const kept = paste.text.length.toLocaleString();
			const size = paste.original ? kept + ' of ' + paste.original.toLocaleString() : kept;
			label.textContent = '📋 ' + paste.name + ' · ' + size + ' chars';
			label.title = paste.text.slice(0, 2_000);
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'composer-paste-remove';
			remove.textContent = '×';
			remove.title = 'Remove this pasted text';
			remove.addEventListener('click', () => {
				composerPastes.splice(index, 1);
				renderComposerPastes();
				input.focus();
			});
			chip.append(label, remove);
			composerPastesEl.appendChild(chip);
		});
	}

	/** The bound leaves no half surrogate pair at the cut: a paste can end anywhere. */
	function clipPaste(text) {
		const kept = text.slice(0, MAX_PASTE_CHARS);
		return /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept;
	}

	/** Keeps one long paste beside the prompt instead of inside it. */
	function addPastedText(text) {
		const clipped = text.length > MAX_PASTE_CHARS;
		composerPastes.push({
			name: 'Pasted text ' + (++pasteSeq),
			text: clipped ? clipPaste(text) : text,
			original: clipped ? text.length : 0,
		});
		renderComposerPastes();
		if (clipped) {
			addNotice(
				'Pasted text is ' +
					text.length.toLocaleString() +
					' characters; only the first ' +
					MAX_PASTE_CHARS.toLocaleString() +
					' were attached.',
			);
		}
	}

	/** A paste this long leaves the box; a shorter one stays native. Returns whether it was taken. */
	function interceptPastedText(event, text) {
		if (text.length < PASTE_CHIP_CHARS) {
			return false;
		}
		if (composerPastes.length >= MAX_COMPOSER_PASTES) {
			// Let the native paste keep the text rather than dropping what the reader brought.
			addNotice('Only ' + MAX_COMPOSER_PASTES + ' pasted texts can be added to one message.');
			return false;
		}
		event.preventDefault();
		addPastedText(text);
		input.focus();
		return true;
	}

	/* ------------------------------------------------------------------ composer images */

	// The composer holds attachments locally as data URLs, shows them as chips, and sends them once.
	// The host stores the bytes and returns ids; the transcript then loads images back on demand.
	const MAX_COMPOSER_IMAGES = 6;
	const MAX_COMPOSER_BYTES = 4 * 1024 * 1024;
	const MAX_COMPOSER_DOCUMENT_BYTES = 20 * 1024 * 1024;
	const composerImages = [];
	const pendingReads = new Set();

	function renderComposerImages() {
		composerImagesEl.innerHTML = '';
		composerImagesEl.hidden = composerImages.length === 0;
		composerImages.forEach((attachment, index) => {
			const chip = document.createElement('div');
			chip.className = 'composer-image';
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'composer-image-remove';
			remove.textContent = '×';
			remove.title = 'Remove this attachment';
			remove.addEventListener('click', () => {
				composerImages.splice(index, 1);
				renderComposerImages();
				input.focus();
			});
			if (attachment.kind === 'document') {
				const label = document.createElement('span');
				label.className = 'composer-doc';
				label.textContent = '📄 ' + (attachment.name || 'PDF');
				label.title = attachment.name || 'PDF';
				chip.append(label, remove);
			} else {
				const img = document.createElement('img');
				img.src = attachment.dataUrl;
				img.alt = attachment.name || 'image';
				img.title = attachment.name || 'image';
				chip.append(img, remove);
			}
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

	function isPdfFile(file) {
		if (!file) {
			return false;
		}
		const type = String(file.type || '').toLowerCase();
		const name = String(file.name || '');
		return type === 'application/pdf' || (!type && /\.pdf$/i.test(name));
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

	function addAttachmentFile(file) {
		const image = isImageFile(file);
		const pdf = isPdfFile(file);
		if (!image && !pdf) {
			return;
		}
		if (composerImages.length >= MAX_COMPOSER_IMAGES) {
			addNotice('Only ' + MAX_COMPOSER_IMAGES + ' attachments can be added to one message.');
			return;
		}
		if (image && file.size > MAX_COMPOSER_BYTES) {
			addNotice('An image is over the 4 MiB limit and was not attached.');
			return;
		}
		if (pdf && file.size > MAX_COMPOSER_DOCUMENT_BYTES) {
			addNotice('A PDF is over the 20 MiB limit and was not attached.');
			return;
		}
		const read = (async () => {
			try {
				const dataUrl = await readDataUrl(file);
				if (pdf) {
					composerImages.push({ kind: 'document', name: file.name || 'document.pdf', dataUrl });
				} else {
					const prepared = await downscaled(dataUrl);
					const name =
						prepared === dataUrl
							? file.name || 'image'
							: 'image.' + (prepared.startsWith('data:image/webp') ? 'webp' : 'jpg');
					composerImages.push({ kind: 'image', name, dataUrl: prepared });
				}
				renderComposerImages();
			} catch {
				addNotice(pdf ? 'A PDF could not be read.' : 'An image could not be read.');
			}
		})();
		pendingReads.add(read);
		read.finally(() => pendingReads.delete(read));
	}

	/* ------------------------------------------------------------------ outbound actions */

	/** `#input`'s max-height in chat.css; the box never grows past this. */
	const INPUT_MAX_HEIGHT = 200;
	/** Whether the last measurement found the box at its ceiling. */
	let composerCapped = false;
	/** The value length at the last measurement (or skipped insertion), to spot a replacing edit. */
	let composerLength = 0;

	/**
	 * One line while empty, growing with the text: the box is as tall as what is in it.
	 *
	 * Measuring lays the whole value out, so while the box is already at its ceiling an insertion
	 * that only grows the value cannot make it taller and is skipped. A deletion, or an insertion
	 * over a selection that leaves the value shorter, measures again and may bring the box down.
	 */
	function resizeInput(event) {
		const length = input.textLength;
		if (!length) {
			// `rows="1"` is the empty height; measuring would also measure a long placeholder.
			input.style.height = '';
			composerCapped = false;
			composerLength = 0;
			return;
		}
		const cap = Math.min(Math.round(window.innerHeight * 0.4), INPUT_MAX_HEIGHT);
		if (composerCapped && length > composerLength && event && /^insert/.test(event.inputType || '')) {
			composerLength = length;
			return;
		}
		input.style.height = 'auto';
		const height = input.scrollHeight;
		input.style.height = Math.min(height, cap) + 'px';
		composerCapped = height >= cap;
		composerLength = length;
	}

	let submitting = false;
	/** What the host has not accepted yet. The composer keeps it until `turn-start` settles it. */
	let pendingSend = null;
	/**
	 * The host accepted the send: clear exactly what was sent. A prompt the user edited while the
	 * host was accepting it, or attachments added after Send, are left alone.
	 */
	function acceptPendingSend() {
		if (!pendingSend) {
			submitting = false;
			return;
		}
		if (input.value.trim() === pendingSend.text) {
			input.value = '';
			resizeInput();
		}
		for (const paste of pendingSend.sentPastes) {
			const at = composerPastes.indexOf(paste);
			if (at >= 0) {
				composerPastes.splice(at, 1);
			}
		}
		for (const image of pendingSend.sentImages) {
			const at = composerImages.indexOf(image);
			if (at >= 0) {
				composerImages.splice(at, 1);
			}
		}
		renderComposerPastes();
		renderComposerImages();
		pendingSend = null;
		submitting = false;
	}
	/** The host refused before accepting: keep the text and let the user send it again. */
	function refusePendingSend(message) {
		pendingSend = null;
		submitting = false;
		if (message && typeof message.text === 'string' && !input.value.trim()) {
			input.value = message.text;
			resizeInput();
			input.focus();
		}
	}
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
			if (!text && !composerImages.length && !composerPastes.length) {
				submitting = false;
				return;
			}
			closeMention();
			const sentImages = [...composerImages];
			const sentPastes = [...composerPastes];
			const attachments = [
				...sentPastes.map((paste) => ({ kind: 'text', name: paste.name, text: paste.text })),
				...sentImages.map((attachment) => ({ kind: attachment.kind, name: attachment.name, data: attachment.dataUrl })),
			];
			pendingSend = { text, sentImages, sentPastes };
			vscode.postMessage({ type: 'send', text, attachments });
			input.focus();
		} catch (error) {
			submitting = false;
			throw error;
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
		// box is empty — so the box is emptied here and the answer comes back as a notice. A quiet
		// turn has no attachment channel, so its pasted blocks join the prompt text, material first.
		const text =
			trigger === 'quiet' ? [...composerPastes.map((paste) => paste.text), input.value.trim()].filter(Boolean).join('\n\n') : '';
		if (trigger === 'quiet') {
			if (text.trim()) {
				pendingSend = { text: text.trim(), sentImages: [], sentPastes: [...composerPastes] };
			}
			input.value = '';
			resizeInput();
			composerPastes.length = 0;
			renderComposerPastes();
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
	// A picture or a PDF becomes an attachment; a short text paste stays native, and a long one
	// becomes a chip so the textarea never holds a prompt that makes every key slow.
	input.addEventListener('paste', (event) => {
		const files = [];
		for (const item of event.clipboardData?.items ?? []) {
			if (item.kind !== 'file') {
				continue;
			}
			const file = item.getAsFile();
			if (file && (isImageFile(file) || isPdfFile(file))) {
				files.push(file);
			}
		}
		if (files.length) {
			event.preventDefault();
			for (const file of files) {
				addAttachmentFile(file);
			}
			return;
		}
		interceptPastedText(event, event.clipboardData?.getData('text/plain') ?? '');
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
		const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => isImageFile(file) || isPdfFile(file));
		if (!files.length) {
			return;
		}
		event.preventDefault();
		for (const file of files) {
			addAttachmentFile(file);
		}
	});
	input.addEventListener('input', resizeInput);
	// A narrower panel re-wraps the same text; the height has to be measured again.
	window.addEventListener('resize', resizeInput);
	input.addEventListener('input', (event) => {
		if (mention) {
			updateMention();
			return;
		}
		// An IME can commit its text as `insertCompositionText` with no further composition event.
		if (event.isComposing || (event.inputType !== 'insertText' && event.inputType !== 'insertCompositionText')) {
			return;
		}
		const caret = input.selectionStart;
		const at = caret - 1;
		if (event.data === '@' || event.data === '＠') {
			if (
				at >= 0 &&
				(input.value[at] === '@' || input.value[at] === '＠') &&
				mentionBoundary(at === 0 ? undefined : input.value[at - 1]) &&
				input.value[at + 1] !== '"' &&
				input.value[at + 1] !== '＂'
			) {
				openMention('categories', at, caret);
			}
			return;
		}
		// A slash starts a command only at the start of the prompt, where `slashName()` looks for it.
		if (
			(event.data === '/' || event.data === '／') &&
			at >= 0 &&
			(input.value[at] === '/' || input.value[at] === '／') &&
			!input.value.slice(0, at).trim()
		) {
			openMention('command', at, caret);
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
			// Committing the raw pinyin the IME had already put in the field leaves the query
			// unchanged, so `changed` is false and no request would ever be sent otherwise.
			requestMention(false);
			return;
		}
		// Some IMEs commit a full-width ＠ as composition text rather than as insertText.
		const caret = input.selectionStart;
		const at = caret - 1;
		if (at >= 0 && input.value[at] === '＠' && mentionBoundary(at === 0 ? undefined : input.value[at - 1])) {
			openMention('categories', at, caret);
		}
	});
	document.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') {
			return;
		}
		// Escape belongs to the IME while a candidate is being composed; it must not close the picker.
		if (event.isComposing || event.keyCode === 229) {
			return;
		}
		if (mention) {
			closeMention();
			return;
		}
		if (planMenuState) {
			closePlanMenu(true);
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
		// A dialog owns Escape while it is open; it comes before Stop so closing the map or a
		// child's transcript never also interrupts the turn behind it.
		if (subagentView) {
			event.preventDefault();
			closeSubagentView();
			return;
		}
		if (taskGraphShown) {
			event.preventDefault();
			closeTaskGraphView();
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
	// The scope pill flips between this workspace and every workspace the host has seen.
	scopeButton.addEventListener('click', () => {
		const next = state && state.historyScope === 'all' ? 'workspace' : 'all';
		vscode.postMessage({ type: 'setHistoryScope', scope: next });
		// The hits on screen were counted in the old scope; ask again for the same query.
		if (searchQuery) {
			vscode.postMessage({ type: 'search', query: searchQuery });
		}
	});
	jumpButton.addEventListener('click', () => {
		pinned = true;
		scroll(true);
	});
	// The chevron sits inside the row, so its click bubbles here. The action group is the only
	// part of the row that must not toggle.
	changesHead.addEventListener('click', (event) => {
		if (event.target.closest?.('#changes-actions')) {
			return;
		}
		changesOpen = !changesOpen;
		renderChanges(pendingChanges, reviewedChanges);
	});
	$('changes-undo').addEventListener('click', () => vscode.postMessage({ type: 'undoAll' }));
	$('changes-keep').addEventListener('click', () => vscode.postMessage({ type: 'keepAll' }));
	$('changes-review').addEventListener('click', () => vscode.postMessage({ type: 'review' }));

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
