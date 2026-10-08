// Comonad World Info — the world-book page of the ST tab, built the way SillyTavern's own
// Worlds/Lorebooks panel is: the active worlds and the global activation knobs on top, then the book
// toolbar, then the entry list, where every row unfolds into its own editor.
//
// The pane owns the open book and writes it back whole, which is SillyTavern's own model; the host
// does what one book cannot — allocating a uid, touching another file, or the file system — and it
// owns the ordering rules, so the search box and the sort select only ever render what it returns.
// Loaded before content.js, which hands the `lorebooks` kind over to this module.
window.comonadWorldInfo = function worldInfo(options) {
	'use strict';

	const $ = (id) => document.getElementById(id);
	// The settings panel owns the webview channel: everything here is filed under `content` and
	// carries this pane's own verb as `action`.
	const post = (message) => {
		const { type, ...rest } = message;
		options.post({ type: 'content', action: type, ...rest });
	};
	const store = options.store || { get: () => ({}), set: () => {} };

	/* ---------------------------------------------------------------- option sets */

	/** The row's position select sets position *and* role in one choice, the way upstream's does. */
	const POSITIONS = [
		['0', '↑Char', 'Before the character definitions'],
		['1', '↓Char', 'After the character definitions'],
		['5', '↑EM', 'Before the examples'],
		['6', '↓EM', 'After the examples'],
		['2', '↑AN', "Before the author's note"],
		['3', '↓AN', "After the author's note"],
		['4|0', '@D ⚙️', 'In chat at depth, as the system'],
		['4|1', '@D 👤', 'In chat at depth, as the user'],
		['4|2', '@D 🤖', 'In chat at depth, as the assistant'],
		['7', '➡️ Outlet', 'Never injected here: read it with {{outlet::Name}}'],
	];

	// Upstream's row shows the state as a bare bullet — 🟢 🔵 🔗 — and keeps the word for the tooltip,
	// which is what lets the column stay as narrow as the glyph.
	const STATES = [
		['', '🟢', 'Normal: this entry activates when its keys match'],
		['constant', '🔵', 'Constant: always injected, whatever the scan text says'],
		['vectorized', '🔗', 'Vectorized: fired by a vector search of the chat instead of by keys'],
	];

	const LOGICS = [
		['0', 'AND ANY', 'At least one secondary key matches'],
		['3', 'AND ALL', 'Every secondary key matches'],
		['1', 'NOT ALL', 'At least one secondary key does not match'],
		['2', 'NOT ANY', 'No secondary key matches'],
	];

	const TRINARY = [
		['', 'Use global'],
		['true', 'Yes'],
		['false', 'No'],
	];

	const STRATEGIES = [
		['0', 'Sorted Evenly'],
		['1', 'Character Lore First'],
		['2', 'Global Lore First'],
	];

	const PAGE_SIZES = [10, 25, 50, 100, 500, 1000];

	/** How long the pane waits after the last keystroke before writing the book out. */
	const FLUSH_MS = 700;
	/** The activation knobs are radio-like, so they are written on a short debounce of their own. */
	const SETTING_MS = 400;
	const MEMO_LIMIT = 100;

	/* ---------------------------------------------------------------- module state */

	let state = null;
	/** The open book, which this pane edits and writes back whole. */
	let book = null;
	/** What the host says about showing it: display order, token counts, and the current query. */
	const ui = { order: [], tokens: {}, total: 0, query: '', sort: 'priority', page: 1, pageSize: 25 };
	/** The entries whose editor is unfolded. */
	const open = new Set();
	/** The key fields switched to plaintext, per kind: upstream remembers this in its own settings. */
	const plain = new Set(store.get().wiPlain || []);
	let dirty = false;
	let pending = null;
	let pendingSetting = null;
	let pendingRebuild = false;
	let focusUid = null;
	let shape = '';
	let messageTimer = null;
	let messageUntil = 0;
	let wired = false;
	let drag = null;

	const esc = (value) =>
		String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

	function status(text, isError) {
		const node = $('wi-status');
		if (!node) {
			return;
		}
		node.textContent = text || '';
		node.className = isError ? 'hint error' : 'hint';
		// A note is a toast: it holds the line for a moment, then the running totals come back.
		messageUntil = text ? Date.now() + (isError ? 9000 : 4000) : 0;
		if (messageTimer) {
			clearTimeout(messageTimer);
			messageTimer = null;
		}
		if (text) {
			messageTimer = setTimeout(showInfo, messageUntil - Date.now() + 50);
		} else {
			showInfo();
		}
	}

	/** What the list is showing, which is the line's resting state. */
	function showInfo() {
		const node = $('wi-status');
		if (!node || Date.now() < messageUntil) {
			return;
		}
		node.className = 'hint';
		node.textContent = book ? info() : '';
	}

	function info() {
		const count = Object.keys(book?.entries ?? {}).length;
		const shown = ui.order.length;
		const from = shown ? (ui.page - 1) * ui.pageSize + 1 : 0;
		const to = Math.min(ui.page * ui.pageSize, shown);
		return `${count} entries · ~${ui.total} tokens · showing ${from}-${to} of ${shown}${ui.query ? ` matching “${ui.query}”` : ''}`;
	}

	/* ---------------------------------------------------------------- small DOM helpers */

	function fillOptions(select, choices, value) {
		select.replaceChildren();
		for (const [optionValue, label, hint] of choices) {
			const option = document.createElement('option');
			option.value = String(optionValue);
			option.textContent = label;
			if (hint) {
				option.title = hint;
			}
			option.selected = String(optionValue) === String(value);
			select.append(option);
		}
	}

	/** A checkbox or a select: the value is read from the DOM, and the change is written back. */
	function bind(node, handler, event = 'change') {
		node.addEventListener(event, () => {
			handler();
			touch();
		});
	}

	const triValue = (value) => (value === null || value === undefined ? '' : String(value === true || value === 'true'));
	const tri = (value) => (value === '' ? null : value === 'true');
	const textOrNull = (value) => (String(value ?? '').trim() === '' ? null : String(value).trim());
	const numberOrNull = (value) => (String(value ?? '').trim() === '' ? null : Number(value) || 0);
	const numbers = (value) => (value === null || value === undefined ? '' : String(value));

	/* ---------------------------------------------------------------- the entry list */

	const entries = () => Object.values(book?.entries ?? {});
	const entryOf = (uid) => book?.entries?.[String(uid)] ?? null;
	const positionKey = (row) => {
		const position = Number(row.position ?? 0);
		return position === 4 ? `4|${Number(row.role ?? 0)}` : String(position);
	};

	function rowEl(row) {
		const template = $('wi-entry-tpl');
		const node = template.content.firstElementChild.cloneNode(true);
		node.dataset.uid = String(row.uid);
		node.classList.toggle('is-off', row.disable === true);
		node.classList.toggle('is-open', open.has(row.uid));
		node.classList.toggle('is-constant', row.constant === true);

		const title = node.querySelector('.wi-title');
		title.value = row.comment || '';
		title.rows = 1;
		bind(title, () => { row.comment = title.value; }, 'input');

		const kill = node.querySelector('.wi-kill');
		const paintKill = () => {
			kill.textContent = row.disable === true ? '○' : '●';
			node.classList.toggle('is-off', row.disable === true);
		};
		kill.title = "Toggle the entry's active state";
		bind(kill, () => {
			row.disable = row.disable !== true;
			paintKill();
		});
		paintKill();

		const fold = node.querySelector('.wi-fold');
		fold.textContent = open.has(row.uid) ? '▾' : '▸';
		fold.title = open.has(row.uid) ? 'Fold this entry' : 'Open this entry';
		fold.addEventListener('click', () => {
			if (open.has(row.uid)) {
				open.delete(row.uid);
			} else {
				open.add(row.uid);
			}
			rebuild();
		});

		const stateSelect = node.querySelector('.wi-state');
		const stateOf = (entry) => (entry.constant === true ? 'constant' : entry.vectorized === true ? 'vectorized' : '');
		fillOptions(stateSelect, STATES, stateOf(row));
		bind(stateSelect, () => {
			// Upstream's tri-state: the two switches are exclusive, so picking one clears the other.
			row.constant = stateSelect.value === 'constant';
			row.vectorized = stateSelect.value === 'vectorized';
			node.classList.toggle('is-constant', row.constant);
			node.classList.toggle('is-vectorized', row.vectorized);
		});

		const position = node.querySelector('.wi-row-position');
		fillOptions(position, POSITIONS, positionKey(row));
		bind(position, () => {
			const [where, role] = position.value.split('|');
			row.position = Number(where);
			if (role !== undefined) {
				row.role = Number(role);
			}
			position.title = POSITIONS.find((choice) => choice[0] === position.value)?.[2] ?? '';
		});

		for (const [selector, field] of [['.wi-row-depth', 'depth'], ['.wi-row-order', 'order'], ['.wi-row-prob', 'probability']]) {
			const input = node.querySelector(selector);
			input.value = numbers(row[field]);
			bind(input, () => { row[field] = Number(input.value) || 0; }, 'input');
		}

		node.querySelector('.wi-move').addEventListener('click', () => askTarget(row));
		node.querySelector('.wi-copy').addEventListener('click', () => post({ type: 'duplicateEntry', id: book.name, uid: row.uid }));
		node.querySelector('.wi-drop').addEventListener('click', () => post({ type: 'deleteEntry', id: book.name, uid: row.uid }));

		// Reordering is only offered while the list is sorted by hand, as upstream does. The handle keeps
		// its place in the row either way, so the columns never shift under the headers.
		const grip = node.querySelector('.wi-grip');
		grip.classList.toggle('is-off', ui.sort !== 'custom');
		node.draggable = ui.sort === 'custom';
		node.addEventListener('dragstart', (event) => {
			drag = row.uid;
			node.classList.add('is-dragging');
			event.dataTransfer?.setData('text/plain', String(row.uid));
		});
		node.addEventListener('dragend', () => {
			drag = null;
			node.classList.remove('is-dragging');
		});
		node.addEventListener('dragover', (event) => {
			if (drag === null || drag === row.uid) {
				return;
			}
			event.preventDefault();
			node.classList.add('is-over');
		});
		node.addEventListener('dragleave', () => node.classList.remove('is-over'));
		node.addEventListener('drop', (event) => {
			event.preventDefault();
			node.classList.remove('is-over');
			if (drag !== null && drag !== row.uid) {
				reorder(drag, row.uid);
			}
		});

		const edit = node.querySelector('.wi-edit');
		edit.hidden = !open.has(row.uid);
		if (open.has(row.uid)) {
			wireEditor(node, row);
		}
		paintCounters(node, row);
		return node;
	}

	/** The token count and the uid of one entry, which its editor shows next to `Content`. */
	function paintCounters(node, row) {
		const tokens = node.querySelector('.wi-tokens');
		const uid = node.querySelector('.wi-uid');
		if (tokens) {
			tokens.textContent = `(Tokens: ~${ui.tokens[row.uid] ?? 0})`;
		}
		if (uid) {
			uid.textContent = `(UID: ${row.uid})`;
		}
	}

	/* ---------------------------------------------------------------- the entry editor */

	/** The key inputs: chips, with the plaintext mode upstream keeps as a per-user preference. */
	function keys(node, row, field) {
		const wrap = node.querySelector(`.wi-chips[data-for="${field}"]`);
		const input = node.querySelector(`.wi-chip-input[data-for="${field}"]`);
		const area = node.querySelector(`.wi-chip-text[data-for="${field}"]`);
		const toggle = node.querySelector(`.wi-plain[data-for="${field}"]`);
		if (!wrap || !input || !area || !toggle) {
			return;
		}
		const list = () => {
			if (!Array.isArray(row[field])) {
				row[field] = [];
			}
			return row[field];
		};
		const draw = () => {
			wrap.replaceChildren();
			for (const value of list()) {
				const chip = document.createElement('button');
				chip.type = 'button';
				chip.className = 'wi-chip';
				chip.textContent = value;
				chip.title = 'Remove this key';
				chip.addEventListener('click', () => {
					row[field] = list().filter((entry) => entry !== value);
					touch();
					draw();
				});
				wrap.append(chip);
			}
			area.value = list().join(', ');
		};
		const add = (value) => {
			const wanted = value.trim();
			if (wanted && !list().includes(wanted)) {
				list().push(wanted);
				touch();
				draw();
			}
		};
		const paintPlain = () => {
			const isPlain = plain.has(field);
			wrap.hidden = isPlain;
			input.hidden = isPlain;
			area.hidden = !isPlain;
			toggle.textContent = isPlain ? '⌨️' : '✨';
			toggle.title = isPlain ? 'Switch to fancy mode' : 'Switch to plaintext mode';
			toggle.classList.toggle('is-on', isPlain);
		};
		input.setAttribute('list', 'wi-key-options');
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ',') {
				event.preventDefault();
				add(input.value);
				input.value = '';
			} else if (event.key === 'Backspace' && !input.value) {
				row[field] = list().slice(0, -1);
				touch();
				draw();
			}
		});
		input.addEventListener('blur', () => {
			if (input.value.trim()) {
				add(input.value);
				input.value = '';
			}
		});
		bind(area, () => {
			row[field] = area.value
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean);
			draw();
		}, 'input');
		toggle.addEventListener('click', () => {
			if (plain.has(field)) {
				plain.delete(field);
			} else {
				plain.add(field);
			}
			store.set({ wiPlain: [...plain] });
			paintPlain();
			draw();
		});
		draw();
		paintPlain();
	}

	/** Everything the unfolded editor owns. Each control reads the DOM and writes the entry. */
	function wireEditor(node, row) {
		keys(node, row, 'key');
		keys(node, row, 'keysecondary');

		const logic = node.querySelector('.wi-logic');
		fillOptions(logic, LOGICS, String(row.selectiveLogic ?? 0));
		bind(logic, () => { row.selectiveLogic = Number(logic.value) || 0; });

		const outlet = node.querySelector('.wi-outlet');
		outlet.value = row.outletName ?? '';
		bind(outlet, () => { row.outletName = outlet.value; }, 'input');

		const scan = node.querySelector('.wi-scan');
		scan.value = numbers(row.scanDepth);
		bind(scan, () => { row.scanDepth = numberOrNull(scan.value); }, 'input');

		for (const [selector, field] of [['.wi-case', 'caseSensitive'], ['.wi-words', 'matchWholeWords'], ['.wi-scoring', 'useGroupScoring']]) {
			const select = node.querySelector(selector);
			fillOptions(select, TRINARY, triValue(row[field]));
			bind(select, () => { row[field] = tri(select.value); });
		}

		// "Delay until recursion" is a checkbox *and* a level: upstream stores `true` for level one.
		const until = node.querySelector('.wi-delay-until');
		const level = node.querySelector('.wi-level');
		until.checked = Boolean(row.delayUntilRecursion);
		level.value = typeof row.delayUntilRecursion === 'number' ? String(row.delayUntilRecursion) : '';
		bind(until, () => {
			row.delayUntilRecursion = until.checked
				? typeof row.delayUntilRecursion === 'number' && row.delayUntilRecursion > 1
					? row.delayUntilRecursion
					: true
				: false;
			level.value = typeof row.delayUntilRecursion === 'number' ? String(row.delayUntilRecursion) : '';
		});
		bind(level, () => {
			const value = level.value.trim();
			row.delayUntilRecursion =
				value === ''
					? typeof row.delayUntilRecursion === 'boolean'
						? row.delayUntilRecursion
						: true
					: value === '1' || Number.isNaN(Number(value))
						? value === '1'
						: Number(value);
		}, 'input');

		const body = node.querySelector('.wi-body');
		body.value = row.content ?? '';
		bind(body, () => { row.content = body.value; }, 'input');

		for (const [selector, field] of [
			['.wi-exclude-recursion', 'excludeRecursion'],
			['.wi-prevent-recursion', 'preventRecursion'],
			['.wi-ignore-budget', 'ignoreBudget'],
			['.wi-override', 'groupOverride'],
			['.wi-selective', 'selective'],
			['.wi-use-probability', 'useProbability'],
			['.wi-memo', 'addMemo'],
			['.wi-m-desc', 'matchCharacterDescription'],
			['.wi-m-pers', 'matchCharacterPersonality'],
			['.wi-m-scenario', 'matchScenario'],
			['.wi-m-persona', 'matchPersonaDescription'],
			['.wi-m-depth', 'matchCharacterDepthPrompt'],
			['.wi-m-creator', 'matchCreatorNotes'],
		]) {
			const box = node.querySelector(selector);
			box.checked = row[field] === true;
			bind(box, () => { row[field] = box.checked; });
		}

		const name = node.querySelector('.wi-group-name');
		name.value = row.group ?? '';
		bind(name, () => { row.group = name.value; }, 'input');

		for (const [selector, field] of [['.wi-weight', 'groupWeight'], ['.wi-sticky', 'sticky'], ['.wi-cooldown', 'cooldown'], ['.wi-delay-turns', 'delay']]) {
			const input = node.querySelector(selector);
			input.value = numbers(row[field]);
			bind(input, () => { row[field] = numberOrNull(input.value); }, 'input');
		}
		// A weight is never empty: the engine multiplies by it.
		const weight = node.querySelector('.wi-weight');
		bind(weight, () => {
			if (row.groupWeight === null) {
				row.groupWeight = 100;
			}
		});

		const filter = node.querySelector('.wi-filter');
		const exclude = node.querySelector('.wi-filter-exclude');
		const chosen = () => ({
			names: row.characterFilter?.names ?? [],
			tags: row.characterFilter?.tags ?? [],
			isExclude: row.characterFilter?.isExclude === true,
		});
		const characters = (state?.book?.characters ?? []).map((character) => ({ value: character.id, label: character.name === character.id ? character.id : `${character.name} (${character.id})`, type: 'character' }));
		// The tags are the registry's, and the option's value is the tag **id**: that is what upstream
		// stores in `characterFilter.tags`, so an entry filtered here reads the same in SillyTavern and
		// keeps pointing at the same tag after the tag is renamed.
		const tags = (state?.book?.tags ?? []).map((tag) => ({ value: tag.id, label: `[Tag] ${tag.name}`, type: 'tag' }));
		const fillFilter = () => {
			const current = chosen();
			filter.replaceChildren();
			// A tag the entry names but the registry no longer has is not offered — upstream lists what
			// exists and leaves the stored value alone.
			for (const item of [...characters, ...tags]) {
				const option = document.createElement('option');
				option.value = item.value;
				option.textContent = item.label;
				option.dataset.type = item.type;
				option.selected = item.type === 'character' ? current.names.includes(item.value) : current.tags.includes(item.value);
				filter.append(option);
			}
			exclude.checked = current.isExclude;
		};
		const readFilter = () => {
			const picked = [...filter.selectedOptions];
			row.characterFilter = {
				names: picked.filter((option) => option.dataset.type === 'character').map((option) => option.value),
				tags: picked.filter((option) => option.dataset.type === 'tag').map((option) => option.value),
				isExclude: exclude.checked,
			};
		};
		fillFilter();
		filter.addEventListener('change', readFilter);
		bind(exclude, readFilter);

		// Automation ID: upstream runs the same-named automation (a Quick Reply there, a slash command
		// here) whenever this entry activates. The list offers the ids the other entries already use.
		const automation = node.querySelector('.wi-automation');
		automation.value = String(row.automationId ?? '');
		bind(automation, () => {
			row.automationId = automation.value.trim();
		}, 'input');
		automation.setAttribute('list', 'wi-automation-options');

		// Generation type triggers: an entry that names types only fires for those. Upstream's own list
		// and wording, and no selection means every type.
		const triggers = node.querySelector('.wi-triggers');
		const triggerOptions = state?.book?.generations ?? [];
		triggers.replaceChildren();
		for (const item of triggerOptions) {
			const option = document.createElement('option');
			option.value = item.value;
			option.textContent = item.label;
			option.selected = Array.isArray(row.triggers) && row.triggers.includes(item.value);
			triggers.append(option);
		}
		bind(triggers, () => {
			row.triggers = [...triggers.selectedOptions].map((option) => option.value);
		});

		const sources = node.querySelector('.wi-sources-head');
		const sourcesBody = node.querySelector('.wi-sources-body');
		sources.addEventListener('click', () => {
			sourcesBody.hidden = !sourcesBody.hidden;
			sources.setAttribute('aria-expanded', String(!sourcesBody.hidden));
			sources.classList.toggle('is-open', !sourcesBody.hidden);
		});
	}

	/* ---------------------------------------------------------------- list, pager, keys */

	function rebuild() {
		if (focusUid !== null) {
			const index = ui.order.indexOf(focusUid);
			if (index >= 0) {
				ui.page = Math.floor(index / ui.pageSize) + 1;
			}
			focusUid = null;
		}
		const host = $('wi-list');
		const total = ui.order.length;
		const pages = Math.max(1, Math.ceil(total / ui.pageSize));
		if (ui.page > pages) {
			ui.page = pages;
		}
		const slice = ui.order.slice((ui.page - 1) * ui.pageSize, ui.page * ui.pageSize);
		host.replaceChildren();
		const keys = new Set();
		for (const uid of slice) {
			const row = entryOf(uid);
			if (row) {
				host.append(rowEl(row));
			}
		}
		for (const row of entries()) {
			for (const key of row.key ?? []) {
				keys.add(key);
			}
		}
		const options = $('wi-key-options');
		if (options) {
			options.replaceChildren();
			for (const key of [...keys].sort()) {
				const option = document.createElement('option');
				option.value = key;
				options.append(option);
			}
		}
		// The Automation ID field offers what the other entries already run, as upstream's does.
		const automations = $('wi-automation-options');
		if (automations) {
			const ids = new Set();
			for (const row of entries()) {
				const id = String(row.automationId ?? '').trim();
				if (id) {
					ids.add(id);
				}
			}
			automations.replaceChildren();
			for (const id of [...ids].sort()) {
				const option = document.createElement('option');
				option.value = id;
				automations.append(option);
			}
		}
		if (!total) {
			const empty = document.createElement('p');
			empty.className = 'hint';
			empty.textContent = book && !Object.keys(book.entries).length
				? 'This book has no entries yet — add one, or import a file.'
				: ui.query
					? 'No entry matches that search.'
					: 'Pick a book to edit, or create one.';
			host.append(empty);
		}
		$('wi-pager').replaceChildren(...pagerNodes(total, pages));
		shape = signature();
		showInfo();
	}

	function signature() {
		return [book?.name ?? '', ui.order.join(','), ui.query, ui.sort, ui.page, ui.pageSize, [...open].sort().join(',')].join('|');
	}

	/** A second state push with the same list must not rebuild the DOM: a caret lives in there. */
	function renderList() {
		if (signature() !== shape) {
			rebuild();
		}
	}

	function pagerNodes(total, pages) {
		const nodes = [];
		if (pages <= 1) {
			return nodes;
		}
		const back = document.createElement('button');
		back.type = 'button';
		back.className = 'secondary';
		back.textContent = '‹';
		back.disabled = ui.page <= 1;
		back.addEventListener('click', () => {
			ui.page -= 1;
			rebuild();
		});
		const next = document.createElement('button');
		next.type = 'button';
		next.className = 'secondary';
		next.textContent = '›';
		next.disabled = ui.page >= pages;
		next.addEventListener('click', () => {
			ui.page += 1;
			rebuild();
		});
		const label = document.createElement('small');
		label.textContent = `${ui.page} / ${pages} · ${total} entries`;
		nodes.push(back, label, next);
		return nodes;
	}

	/* ---------------------------------------------------------------- writing it back */

	/** The pane holds the book; a keystroke only marks it, and the write happens once the typing stops. */
	function touch() {
		dirty = true;
		if (pending) {
			clearTimeout(pending);
		}
		pending = setTimeout(flush, FLUSH_MS);
	}

	function flush() {
		if (pending) {
			clearTimeout(pending);
			pending = null;
		}
		if (!dirty || !book) {
			return;
		}
		dirty = false;
		post({ type: 'write', id: book.name, book });
	}

	/** Ask the host for the display order again — the sort rules live over there. */
	function askOrder() {
		if (book) {
			post({ type: 'order', id: book.name, query: ui.query, sort: ui.sort });
		}
	}

	/** Apply the current sort as the entries' own Order, which is what upstream's button does. */
	function applyOrder() {
		const total = ui.order.length;
		ui.order.forEach((uid, index) => {
			const row = entryOf(uid);
			if (row) {
				row.order = total - index;
			}
		});
		touch();
		rebuild();
	}

	/** Give every untitled entry the title its keys suggest, capped the way upstream caps a memo. */
	function backfill() {
		let count = 0;
		for (const row of entries()) {
			if (!row.comment?.trim() && row.key?.length) {
				row.comment = row.key.join(', ').slice(0, MEMO_LIMIT);
				count += 1;
			}
		}
		touch();
		rebuild();
		status(count ? `Backfilled ${count} title${count === 1 ? '' : 's'}.` : 'Every entry already has a title.', false);
	}

	function reorder(from, to) {
		const next = ui.order.filter((uid) => uid !== from);
		const at = next.indexOf(to);
		next.splice(at < 0 ? next.length : at, 0, from);
		ui.order = next;
		// The hand-made order is what `displayIndex` means, so it is written back entry by entry.
		ui.order.forEach((uid, index) => {
			const row = entryOf(uid);
			if (row) {
				row.displayIndex = index;
			}
		});
		touch();
		rebuild();
	}

	/* ---------------------------------------------------------------- the panel's own settings */

	/** The knobs upstream keeps in this same panel: they are written straight through, no Save. */
	function sendSetting(key, value) {
		post({ type: 'setting', key, value });
	}

	function sendSettingSoon(key, value) {
		clearTimeout(pendingSetting);
		pendingSetting = setTimeout(() => sendSetting(key, value), SETTING_MS);
	}

	function wireGlobal() {
		for (const [id, key] of [
			['wi-g-scan', 'wiScanDepth'],
			['wi-g-budget', 'wiBudget'],
			['wi-g-cap', 'wiBudgetCap'],
			['wi-g-min', 'wiMinActivations'],
			['wi-g-depth', 'wiMaxActivationsDepth'],
			['wi-g-steps', 'wiMaxRecursionSteps'],
			['wi-g-vector-threshold', 'wiVectorThreshold'],
		]) {
			const input = $(id);
			const range = $(`${id}-range`);
			const pair = (source, target) => {
				source.addEventListener('input', () => {
					target.value = source.value;
					sendSettingSoon(key, Number(source.value) || 0);
				});
			};
			pair(input, range);
			pair(range, input);
		}
		for (const [id, key] of [
			['wi-g-vector-entries', 'wiVectorMaxEntries'],
			['wi-g-vector-query', 'wiVectorQuery'],
		]) {
			const input = $(id);
			bind(input, () => sendSettingSoon(key, Number(input.value) || 0), 'input');
		}
		for (const [id, key] of [
			['wi-g-vector-model', 'wiVectorModel'],
		]) {
			const input = $(id);
			bind(input, () => sendSetting(key, input.value.trim()), 'input');
		}
		const strategy = $('wi-g-strategy');
		fillOptions(strategy, STRATEGIES, '0');
		bind(strategy, () => sendSetting('wiCharacterStrategy', Number(strategy.value) || 0));
		for (const [id, key] of [
			['wi-g-names', 'wiIncludeNames'],
			['wi-g-recursive', 'wiRecursive'],
			['wi-g-case', 'wiCaseSensitive'],
			['wi-g-words', 'wiMatchWholeWords'],
			['wi-g-scoring', 'wiGroupScoring'],
			['wi-g-overflow', 'wiOverflowAlert'],
			['wi-g-automation', 'wiAutomation'],
			['wi-g-vector', 'wiVectorEnabled'],
		]) {
			const box = $(id);
			bind(box, () => sendSetting(key, box.checked));
		}
		const toggle = $('wi-global-toggle');
		const drawer = $('wi-global');
		toggle.addEventListener('click', () => {
			drawer.hidden = !drawer.hidden;
			toggle.setAttribute('aria-expanded', String(!drawer.hidden));
			toggle.classList.toggle('is-open', !drawer.hidden);
		});
		const worlds = $('wi-worlds');
		bind(worlds, () => sendSetting('tavernLorebooks', [...worlds.selectedOptions].map((option) => option.value)));
	}

	function renderGlobal(wi, active) {
		for (const [id, value] of [
			['wi-g-scan', wi.scanDepth],
			['wi-g-budget', wi.budget],
			['wi-g-cap', wi.budgetCap],
			['wi-g-min', wi.minActivations],
			['wi-g-depth', wi.maxActivationsDepth],
			['wi-g-steps', wi.maxRecursionSteps],
			['wi-g-vector-threshold', wi.vectorThreshold],
			['wi-g-vector-entries', wi.vectorMaxEntries],
			['wi-g-vector-query', wi.vectorQuery],
		]) {
			const input = $(id);
			const range = $(`${id}-range`);
			// Never take the caret out of a field the user is in the middle of.
			if (document.activeElement !== input && document.activeElement !== range) {
				input.value = numbers(value);
				if (range) {
					range.value = numbers(value);
				}
			}
		}
		const model = $('wi-g-vector-model');
		if (document.activeElement !== model) {
			model.value = String(wi.vectorModel ?? '');
		}
		const strategy = $('wi-g-strategy');
		if (document.activeElement !== strategy) {
			strategy.value = String(wi.characterStrategy ?? 0);
		}
		for (const [id, value] of [
			['wi-g-names', wi.includeNames],
			['wi-g-recursive', wi.recursive],
			['wi-g-case', wi.caseSensitive],
			['wi-g-words', wi.matchWholeWords],
			['wi-g-scoring', wi.useGroupScoring],
			['wi-g-overflow', wi.overflowAlert],
			['wi-g-automation', wi.automation],
			['wi-g-vector', wi.vectorEnabled],
		]) {
			$(id).checked = value === true;
		}
		const worlds = $('wi-worlds');
		const chosen = new Set(active ?? []);
		for (const option of worlds.options) {
			option.selected = chosen.has(option.value);
		}
	}

	function renderPicks(catalog) {
		const books = catalog.lorebooks ?? [];
		const worlds = $('wi-worlds');
		const picked = new Set([...worlds.selectedOptions].map((option) => option.value));
		worlds.replaceChildren();
		for (const item of books) {
			const option = document.createElement('option');
			option.value = item.name;
			option.textContent = item.name;
			option.selected = picked.has(item.name);
			worlds.append(option);
		}
		const pick = $('wi-pick');
		pick.replaceChildren();
		const none = document.createElement('option');
		none.value = '';
		none.textContent = '--- Pick to Edit ---';
		pick.append(none);
		for (const item of books) {
			const option = document.createElement('option');
			option.value = item.name;
			option.textContent = item.name;
			pick.append(option);
		}
		pick.value = book?.name ?? '';
	}

	function renderSort(rules) {
		const select = $('wi-sort');
		select.replaceChildren();
		if (ui.query) {
			const found = document.createElement('option');
			found.value = 'search';
			found.textContent = 'Search';
			select.append(found);
		}
		for (const rule of rules) {
			const option = document.createElement('option');
			option.value = rule.value;
			option.textContent = rule.label;
			select.append(option);
		}
		select.value = ui.sort;
	}

	/* ---------------------------------------------------------------- moving an entry */

	function askTarget(row) {
		const names = (state?.catalog?.lorebooks ?? []).map((item) => item.name).filter((name) => name !== book.name);
		if (!names.length) {
			status('There is no other world book to move this entry into.', true);
			return;
		}
		const modal = $('wi-modal');
		const select = $('wi-modal-select');
		select.replaceChildren();
		for (const name of names) {
			const option = document.createElement('option');
			option.value = name;
			option.textContent = name;
			select.append(option);
		}
		$('wi-modal-text').textContent = `Move or copy “${row.comment?.trim() || `entry ${row.uid}`}” to:`;
		modal.hidden = false;
		modal.dataset.uid = String(row.uid);
	}

	function answerTarget(answer) {
		const modal = $('wi-modal');
		const uid = Number(modal.dataset.uid);
		modal.hidden = true;
		if (!answer) {
			return;
		}
		flush();
		post({ type: 'move', id: book.name, uid, target: $('wi-modal-select').value, move: answer === 'move' });
	}

	/* ---------------------------------------------------------------- the toolbar */

	function wireOnce() {
		wired = true;
		wireGlobal();
		const pageSize = $('wi-page-size');
		for (const size of PAGE_SIZES) {
			const option = document.createElement('option');
			option.value = String(size);
			option.textContent = `${size} / page`;
			pageSize.append(option);
		}
		const remembered = Number(store.get().wiPageSize);
		ui.pageSize = PAGE_SIZES.includes(remembered) ? remembered : 25;
		pageSize.value = String(ui.pageSize);
		bind(pageSize, () => {
			ui.pageSize = Number(pageSize.value) || 25;
			store.set({ wiPageSize: ui.pageSize });
			ui.page = 1;
			rebuild();
		});

		$('wi-create').addEventListener('click', () => {
			flush();
			post({ type: 'create' });
		});
		$('wi-pick').addEventListener('change', () => {
			const wanted = $('wi-pick').value;
			if (wanted && wanted !== book?.name) {
				flush();
				post({ type: 'select', kind: 'lorebooks', id: wanted });
			}
		});
		$('wi-import').addEventListener('click', () => {
			flush();
			post({ type: 'importBook' });
		});
		$('wi-export').addEventListener('click', () => {
			flush();
			post({ type: 'exportBook', id: book?.name ?? '' });
		});
		$('wi-rename').addEventListener('click', () => {
			flush();
			post({ type: 'rename', id: book?.name ?? '' });
		});
		$('wi-duplicate').addEventListener('click', () => {
			flush();
			post({ type: 'duplicateBook', id: book?.name ?? '' });
		});
		$('wi-delete').addEventListener('click', () => {
			flush();
			post({ type: 'deleteBook', id: book?.name ?? '' });
		});
		$('wi-refresh').addEventListener('click', () => {
			flush();
			post({ type: 'reload' });
		});
		$('wi-add').addEventListener('click', () => {
			flush();
			post({ type: 'addEntry', id: book?.name ?? '' });
		});
		$('wi-open-all').addEventListener('click', () => {
			for (const uid of ui.order) {
				open.add(uid);
			}
			rebuild();
		});
		$('wi-close-all').addEventListener('click', () => {
			open.clear();
			rebuild();
		});
		$('wi-backfill').addEventListener('click', backfill);
		$('wi-apply-order').addEventListener('click', applyOrder);

		let searchTimer = null;
		$('wi-search').addEventListener('input', () => {
			clearTimeout(searchTimer);
			searchTimer = setTimeout(() => {
				ui.query = $('wi-search').value.trim();
				ui.sort = ui.query ? 'search' : ui.sort === 'search' ? 'priority' : ui.sort;
				ui.page = 1;
				askOrder();
			}, 140);
		});
		$('wi-search').addEventListener('keydown', (event) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				$('wi-search').value = '';
				$('wi-search').dispatchEvent(new Event('input'));
			}
		});
		$('wi-sort').addEventListener('change', () => {
			ui.sort = $('wi-sort').value;
			ui.page = 1;
			askOrder();
		});
		for (const button of $('wi-modal').querySelectorAll('button')) {
			button.addEventListener('click', () => answerTarget(button.dataset.answer));
		}
	}

	/* ---------------------------------------------------------------- what the panel calls */

	function render(content) {
		state = content;
		if (!wired) {
			wireOnce();
		}
		const next = content.book || {};
		const item = content.item ?? null;
		const sameBook = Boolean(book && item && book.name === item.name);
		// The pane's own copy stays put: the rows hold the entry objects they were built from, so
		// swapping the model under them would have the next keystroke write into an orphan. The host's
		// copy is taken only when it really has news — another book, or a file it changed itself.
		if (pendingRebuild || !sameBook) {
			book = item;
			dirty = false;
		}
		if (next.order) {
			ui.order = next.order;
		}
		ui.tokens = next.tokens || ui.tokens;
		ui.total = next.total ?? ui.total;
		// The query in flight is the pane's: the host only answers it after a round trip.
		ui.sort = next.sort ?? ui.sort;
		if (!sameBook) {
			open.clear();
			ui.page = 1;
		}
		renderPicks(content.catalog || {});
		renderGlobal(next.wi || {}, next.worlds || []);
		renderSort(next.rules || []);
		if (document.activeElement !== $('wi-search')) {
			$('wi-search').value = ui.query;
		}
		if (pendingRebuild) {
			pendingRebuild = false;
			rebuild();
			return;
		}
		renderList();
	}

	function note(message) {
		if (message.error) {
			status(message.message, true);
			return;
		}
		if (message.order) {
			ui.order = message.order;
		}
		if (message.tokens) {
			ui.tokens = message.tokens;
		}
		if (message.total !== undefined) {
			ui.total = message.total;
		}
		if (message.entry !== undefined) {
			open.add(Number(message.entry));
			focusUid = Number(message.entry);
		}
		if (message.book) {
			// A rename or a fresh file: the panel pushes the new state next.
			pendingRebuild = true;
		}
		if (message.refresh) {
			// The host changed the file, so its copy wins over whatever this pane was holding.
			dirty = false;
			pendingRebuild = true;
		}
		if (message.order) {
			rebuild();
		}
		if (typeof message.message === 'string' && !message.quiet) {
			status(message.message, false);
		}
	}

	return {
		render,
		note,
		/** Said out loud when the panel pushes a state this pane cannot use. */
		notice: (text) => status(text, true),
		/** The panel is leaving this sub-tab: anything typed but not yet written goes out now. */
		flush,
	};
};
