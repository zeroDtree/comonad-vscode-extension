// SPDX-License-Identifier: AGPL-3.0-only
// Comonad Personas — the ST tab's Persona Management page, in SillyTavern's own layout and words:
// the avatar tiles on the left with the create button, the search box, the sort select, pagination,
// the grid toggle and the upload tile; the open persona on the right with its picture, name, title,
// description and token count, the description's position and depth, the three locks with the
// connection list, the persona's own lorebook, and the persona-wide settings underneath.
//
// The host owns the files: this pane owns the layout, remembers what is expanded, and posts one verb
// per change. Upstream saves a persona the moment a field changes, and so does this pane — there is
// no Save button on this page.
window.comonadPersonas = function personaPane(options) {
	'use strict';

	const $ = (id) => document.getElementById(id);
	// The panel owns the webview channel, so every message here is filed under `content` and carries
	// the pane's own verb as `action`.
	const post = (message) => {
		const { type, ...rest } = message;
		options.post({ type: 'content', action: type, ...rest });
	};

	// The five positions upstream offers, in its own order and with its own words. `AFTER_CHAR` is
	// deprecated there and is not offered; a file that carries it is still read as one.
	const POSITIONS = [
		[9, 'None (disabled)'],
		[0, 'In Story String / Prompt Manager'],
		[2, "Top of Author's Note"],
		[3, "Bottom of Author's Note"],
		[4, 'In-chat @ Depth'],
	];
	const ROLES = [
		[0, 'System'],
		[1, 'User'],
		[2, 'Assistant'],
	];
	// How many tiles one page holds, which is what upstream's pagination counts too.
	const PAGE_SIZE = 24;
	const SORT_VALUES = ['asc', 'desc', 'search'];

	const store = options.store || { get: () => ({}), set: () => {} };
	let state = null;
	/** The open persona with this pane's edits applied; `null` when nothing is selected. */
	let work = null;
	let dirty = false;
	let saving = null;
	let page = 0;
	let query = '';

	const remembered = store.get() || {};
	// The order upstream keeps across sessions; *Search* is only ever on while a term is in the box.
	let rememberedSort = SORT_VALUES.includes(remembered.pfSort) && remembered.pfSort !== 'search' ? remembered.pfSort : 'asc';
	let sort = rememberedSort;
	// Upstream keeps the two readings of the list — a column of small rows, and a wall of pictures — and
	// starts on the first: a name is what you pick a persona by, and a picture is the persona itself.
	let grid = remembered.pfGrid === true;

	const status = (text, isError) => {
		const node = $('st-status');
		node.textContent = text || '';
		node.className = isError ? 'error' : '';
	};

	/** SillyTavern's own guesstimate: bytes over four, rounded up. */
	const estimate = (text) => Math.ceil(new TextEncoder().encode(String(text ?? '')).length / 4);

	/* ------------------------------------------------------------------ the list */

	/** The name a tile is labelled with, and what the search box looks through. */
	const label = (persona) => persona.title || persona.name || persona.id;
	const haystack = (persona) =>
		`${persona.name} ${persona.title} ${persona.detail} ${(persona.connections || []).map((connection) => connection.name).join(' ')}`.toLowerCase();

	/** How well a persona answers the search box: a name that starts with it, then one that holds it. */
	const relevance = (persona, term) => {
		const name = label(persona).toLowerCase();
		if (name.startsWith(term)) {
			return 0;
		}
		return name.includes(term) ? 1 : 2;
	};

	/** The personas to draw: filtered by the search box, then in the chosen order. */
	const listed = () => {
		const all = (state && state.list) || [];
		const term = query.trim().toLowerCase();
		const hits = term ? all.filter((persona) => haystack(persona).includes(term)) : all.slice();
		if (sort === 'search' && term) {
			hits.sort((a, b) => relevance(a, term) - relevance(b, term) || label(a).localeCompare(label(b)));
		} else if (sort === 'desc') {
			hits.sort((a, b) => label(b).localeCompare(label(a)));
		} else {
			hits.sort((a, b) => label(a).localeCompare(label(b)));
		}
		return hits;
	};

	const pageCount = (total) => Math.max(1, Math.ceil(total / PAGE_SIZE));

	function renderTools(total) {
		// Upstream only offers the *Search* order while there is something to search for.
		const searchOption = $('pf-sort').querySelector('option[value="search"]');
		searchOption.hidden = !query.trim();
		$('pf-sort').value = sort;
		$('pf-search').value = query;
		$('pf-grid').classList.toggle('is-on', grid);
		const pager = $('pf-pager');
		const pages = pageCount(total);
		page = Math.min(Math.max(0, page), pages - 1);
		pager.textContent = '';
		if (pages < 2) {
			return;
		}
		const step = (label, delta, disabled) => {
			const button = document.createElement('button');
			button.type = 'button';
				button.className = 'icon';
			button.textContent = label;
			button.disabled = disabled;
			button.addEventListener('click', () => {
				page += delta;
				render();
			});
			return button;
		};
		pager.append(step('‹', -1, page === 0), `${page + 1} / ${pages}`, step('›', 1, page === pages - 1));
	}

	/** The picture of a persona, or the first letter of its name when it has none. */
	function tileFace(persona) {
		if (persona.avatar) {
			const image = document.createElement('img');
			image.src = persona.avatar;
			image.alt = '';
			return image;
		}
		const face = document.createElement('span');
		face.className = 'pf-letter';
		face.textContent = (label(persona)[0] || '?').toUpperCase();
		return face;
	}

	/** One of upstream's two lock badges, small and quiet, beside a persona's name. */
	function badge(glyph, tip) {
		const node = document.createElement('span');
		node.className = 'pf-badge';
		node.textContent = glyph;
		node.title = tip;
		return node;
	}

	/** A field the user is in is left alone, and one that already reads right is not written: a state
	 *  push can land in the middle of a keystroke, and a `.value` write would take the caret with it. */
	function put(node, value) {
		const wanted = String(value ?? '');
		if (node && document.activeElement !== node && node.value !== wanted) {
			node.value = wanted;
		}
	}

	/** The tiles are redrawn only when what they show moves; a push that changes nothing skips them. */
	let tilesShape = '';

	function tilesSignature(list) {
		return JSON.stringify([
			page,
			grid,
			work && work.id,
			list.map((persona) => [persona.id, persona.name, persona.title, persona.avatar, persona.locked.default, persona.locked.chat, persona.locked.character]),
		]);
	}

	function renderTiles() {
		const host = $('pf-tiles');
		const list = listed();
		const shape = tilesSignature(list);
		if (shape === tilesShape) {
			return;
		}
		tilesShape = shape;
		renderTools(list.length);
		host.textContent = '';
		host.classList.toggle('is-grid', grid);

		const from = page * PAGE_SIZE;
		for (const persona of list.slice(from, from + PAGE_SIZE)) {
			const tile = document.createElement('button');
			tile.type = 'button';
			tile.className = 'pf-tile';
			tile.dataset.id = persona.id;
			tile.classList.toggle('is-on', persona.id === (work && work.id));
			if (persona.locked.default) {
				tile.classList.add('is-default');
			}
			if (persona.locked.chat) {
				tile.classList.add('is-chat');
			}
			const locks = [
				persona.locked.default ? 'default' : '',
				persona.locked.chat ? 'this chat' : '',
				persona.locked.character ? 'this character' : '',
			].filter(Boolean);
			tile.title = locks.length ? `${persona.name} — ${locks.join(', ')}` : `${persona.name}${persona.title ? ` — ${persona.title}` : ''}`;
			tile.append(tileFace(persona));
			// The name, the title under it, and upstream's two badges: the crown for the default persona
			// and a lock for the one this chat speaks as.
			const meta = document.createElement('span');
			meta.className = 'pf-meta';
			const caption = document.createElement('span');
			caption.className = 'pf-caption';
			caption.textContent = persona.name || persona.id;
			meta.append(caption);
			if (persona.title && persona.title !== persona.name) {
				const sub = document.createElement('span');
				sub.className = 'pf-sub';
				sub.textContent = persona.title;
				meta.append(sub);
			}
			tile.append(meta);
			const badges = document.createElement('span');
			badges.className = 'pf-badges';
			if (persona.locked.default) {
				badges.append(badge('👑', 'Used for new chats'));
			}
			if (persona.locked.chat) {
				badges.append(badge('🔒', 'Used for this chat'));
			}
			if (persona.locked.character) {
				badges.append(badge('👤', `Bound to ${state.chatCharacterName || 'this character'}`));
			}
			tile.append(badges);
			tile.addEventListener('click', () => select(persona.id));
			host.append(tile);
		}

		// The upload tile is upstream's: a picture *is* a persona, so this creates one from a file.
		const upload = document.createElement('button');
		upload.type = 'button';
		upload.className = 'pf-tile pf-upload';
		upload.title = 'Create a persona from a picture';
		upload.textContent = '+';
		upload.addEventListener('click', () => post({ type: 'personaFromImage', kind: 'personas' }));
		host.append(upload);
	}

	/** Clicking a tile opens the persona; with auto-lock on it is also bound to this chat at once. */
	function select(id) {
		flush();
		if (id === (work && work.id)) {
			return;
		}
		post({ type: 'select', kind: 'personas', id });
		const persona = (state.list || []).find((entry) => entry.id === id);
		if (persona && state.settings && state.settings.autoLock) {
			post({ type: 'adopt', kind: 'personas', id, on: true });
		}
	}

	/* ------------------------------------------------------------------ the open persona */

	function renderPositions() {
		const position = $('pf-position');
		position.textContent = '';
		for (const [value, text] of POSITIONS) {
			const option = document.createElement('option');
			option.value = String(value);
			option.textContent = text;
			position.append(option);
		}
		// A file may carry the deprecated *after character*, which upstream no longer offers.
		if (work && !POSITIONS.some(([value]) => value === Number(work.position))) {
			const option = document.createElement('option');
			option.value = String(work.position);
			option.textContent = `Position ${work.position} (not offered by SillyTavern)`;
			position.append(option);
		}
		const role = $('pf-role');
		role.textContent = '';
		for (const [value, text] of ROLES) {
			const option = document.createElement('option');
			option.value = String(value);
			option.textContent = text;
			role.append(option);
		}
	}

	function renderConnections() {
		const list = $('pf-connections');
		list.textContent = '';
		const connections = (work && work.connections) || [];
		// The item carries ids; the names the host resolved are on the list entry for this persona.
		const current = (state.list || []).find((persona) => persona.id === work.id);
		const named = new Map(((current && current.connections) || []).map((entry) => [`${entry.type}\u0000${entry.id}`, entry.name]));
		if (!connections.length) {
			const empty = document.createElement('p');
			empty.className = 'hint';
			empty.textContent = 'Not connected: this persona is available to any chat.';
			list.append(empty);
		}
		connections.forEach((connection, index) => {
			const row = document.createElement('div');
			row.className = 'pf-connection';
			const name = named.get(`${connection.type}\u0000${connection.id}`) || connection.id;
			const what = document.createElement('span');
			what.className = 'pf-chip';
			what.textContent = `${name}${connection.type === 'group' ? ' (group)' : ''}`;
			const drop = document.createElement('button');
			drop.type = 'button';
			drop.className = 'pf-x';
			drop.textContent = '✕';
			drop.title = 'Remove this connection';
			drop.addEventListener('click', () => post({ type: 'personaDisconnect', kind: 'personas', id: work.id, index }));
			what.append(drop);
			row.append(what);
			list.append(row);
		});

		const select = $('pf-connect-character');
		const wanted = select.value;
		select.textContent = '';
		for (const character of (state && state.characters) || []) {
			const option = document.createElement('option');
			option.value = character.id;
			option.textContent = character.name;
			select.append(option);
		}
		if (wanted && [...select.options].some((option) => option.value === wanted)) {
			select.value = wanted;
		}

		const lorebooks = $('pf-lorebook');
		lorebooks.textContent = '';
		const empty = document.createElement('option');
		empty.value = '';
		empty.textContent = 'None';
		lorebooks.append(empty);
		for (const name of (state && state.lorebooks) || []) {
			const option = document.createElement('option');
			option.value = name;
			option.textContent = name;
			lorebooks.append(option);
		}
	}

	function renderEditor() {
		const editor = $('pf-editor');
		editor.hidden = !work;
		$('pf-empty').hidden = Boolean(work);
		if (!work) {
			return;
		}
		renderPositions();
		renderConnections();

		put($('pf-name'), work.name || '');
		put($('pf-title'), work.title || '');
		put($('pf-description'), work.description || '');
		$('pf-tokens').textContent = String(estimate(work.description));
		put($('pf-position'), String(work.position));
		put($('pf-depth'), String(work.depth));
		put($('pf-role'), String(work.role));
		put($('pf-lorebook'), work.lorebook || '');
		$('pf-depth').disabled = Number(work.position) !== 4;

		const picture = $('pf-picture');
		picture.textContent = '';
		picture.append(tileFace(work));
		picture.title = work.avatar ? 'Click to set another picture' : 'Click to give this persona a picture';
		$('pf-image-clear').disabled = !work.avatar;

		const locked = (persona) => persona && persona.locked;
		const current = (state.list || []).find((persona) => persona.id === work.id);
		const locks = locked(current) || { default: false, chat: false, character: false };
		$('pf-lock-default').classList.toggle('is-on', locks.default);
		$('pf-lock-chat').classList.toggle('is-on', locks.chat);
		$('pf-lock-character').classList.toggle('is-on', locks.character);
		$('pf-lock-character').disabled = !state.chatCharacter;

		const settings = state.settings || {};
		$('pf-auto-lock').checked = Boolean(settings.autoLock);
		$('pf-allow-multi').checked = Boolean(settings.allowMulti);
		$('pf-notify').checked = Boolean(settings.notifications);
	}

	function render() {
		renderTiles();
		renderEditor();
	}

	/* ------------------------------------------------------------------ saving */

	/**
	 * The pane writes the way upstream's does: a change is saved on its own, after a short pause, so
	 * the picture and the connections — which are files and settings of their own — always agree with
	 * the description that was typed beside them.
	 */
	function markDirty() {
		dirty = true;
		if (saving) {
			clearTimeout(saving);
		}
		saving = setTimeout(flush, 600);
	}

	function flush() {
		if (saving) {
			clearTimeout(saving);
			saving = null;
		}
		if (!dirty || !work) {
			return;
		}
		dirty = false;
		post({ type: 'save', kind: 'personas', item: work, quiet: true });
	}

	/* ------------------------------------------------------------------ wiring */

	/** A field that writes straight into the open persona. */
	function field(id, key, read) {
		$(id).addEventListener('input', () => {
			if (!work) {
				return;
			}
			work[key] = read ? read($(id)) : $(id).value;
			markDirty();
		});
	}

	field('pf-name', 'name');
	field('pf-title', 'title');
	field('pf-description', 'description', (node) => {
		$('pf-tokens').textContent = String(estimate(node.value));
		return node.value;
	});
	field('pf-position', 'position', (node) => {
		$('pf-depth').disabled = Number(node.value) !== 4;
		return Number(node.value);
	});
	field('pf-depth', 'depth', (node) => Number(node.value));
	field('pf-role', 'role', (node) => Number(node.value));
	field('pf-lorebook', 'lorebook');

	$('pf-search').addEventListener('input', () => {
		query = $('pf-search').value;
		page = 0;
		// Upstream reaches for the *Search* order the moment there is a term, and goes back to the
		// remembered order — never to *Search* — when the box is emptied again.
		sort = query.trim() ? 'search' : rememberedSort;
		render();
	});
	$('pf-sort').addEventListener('change', () => {
		const value = $('pf-sort').value;
		sort = value;
		if (value !== 'search') {
			rememberedSort = value;
			store.set({ pfSort: value });
		}
		render();
	});
	$('pf-grid').addEventListener('click', () => {
		grid = !grid;
		store.set({ pfGrid: grid });
		render();
	});
	$('pf-create').addEventListener('click', () => {
		flush();
		post({ type: 'new', kind: 'personas' });
	});
	$('pf-picture').addEventListener('click', () => post({ type: 'personaAvatar', kind: 'personas', id: work && work.id, item: work }));
	$('pf-image').addEventListener('click', () => post({ type: 'personaAvatar', kind: 'personas', id: work && work.id, item: work }));
	$('pf-image-clear').addEventListener('click', () => post({ type: 'personaClearAvatar', kind: 'personas', id: work && work.id }));
	$('pf-duplicate').addEventListener('click', () => {
		flush();
		post({ type: 'personaDuplicate', kind: 'personas', id: work && work.id });
	});
	$('pf-delete').addEventListener('click', () => post({ type: 'personaDelete', kind: 'personas', id: work && work.id }));
	$('pf-convert').addEventListener('click', () => post({ type: 'personaFromCharacter', kind: 'personas', character: state.chatCharacter }));
	$('pf-connect').addEventListener('click', () => {
		flush();
		post({ type: 'personaConnect', kind: 'personas', id: work && work.id, character: $('pf-connect-character').value });
	});
	// The locks are upstream's own three: the crown for new chats, the open character, and this chat.
	$('pf-lock-default').addEventListener('click', () => {
		const on = !$('pf-lock-default').classList.contains('is-on');
		post({ type: 'adopt', kind: 'personas', id: work && work.id, asDefault: true, on });
	});
	$('pf-lock-chat').addEventListener('click', () => {
		const on = !$('pf-lock-chat').classList.contains('is-on');
		post({ type: 'adopt', kind: 'personas', id: work && work.id, on });
	});
	$('pf-lock-character').addEventListener('click', () => {
		const on = !$('pf-lock-character').classList.contains('is-on');
		post({
			type: on ? 'personaConnect' : 'personaDisconnect',
			kind: 'personas',
			id: work && work.id,
			character: state.chatCharacter,
		});
	});
	for (const [id, key] of [
		['pf-auto-lock', 'personaAutoLock'],
		['pf-allow-multi', 'personaAllowMultiConnections'],
		['pf-notify', 'personaShowNotifications'],
	]) {
		$(id).addEventListener('change', () => post({ type: 'personaSetting', kind: 'personas', key, value: $(id).checked }));
	}
	$('pf-backup').addEventListener('click', () => post({ type: 'personaBackup', kind: 'personas' }));
	$('pf-restore').addEventListener('click', () => post({ type: 'personaRestore', kind: 'personas' }));

	return {
		// The host state slice, pushed with every settings state.
		render(content) {
			state = content.personas || {};
			const wanted = content.item && content.item.id ? content.item.id : null;
			// A re-render must not throw away what is being typed, so an edit of the *same* persona keeps
			// the pane's own copy; another persona opening is written first, and never silently dropped.
			if (work && wanted !== work.id) {
				flush();
			}
			if (dirty && work && wanted === work.id) {
				renderTiles();
				return;
			}
			work = content.item ? { ...content.item } : null;
			dirty = false;
			render();
		},
		// What the last action said. Upstream shows the same things as toasts.
		note(message) {
			if (!message) {
				return;
			}
			if (message.quiet) {
				return;
			}
			status(message.message === undefined ? String(message) : message.message, message.error === true);
		},
		notice(text) {
			status(text);
		},
		// The panel is going away, or another kind is taking over: never lose a pending edit.
		flush,
	};
};
