// SPDX-License-Identifier: AGPL-3.0-only
// The **ST** tab's own client: the content editor and its sub-tabs, plus the settings half of the tab.
// The host's settings client owns the webview channel and hands every pane its slice of each state
// push, so this file registers here and posts through `window.comonadPanes`. The editor itself, the
// world-book page and the persona page are the modules beside this file; `content.js` orchestrates
// them and this file only tells the host that the tab exists.
(function () {
	'use strict';

	const bridge = window.comonadPanes;
	if (!bridge) {
		return;
	}
	const $ = (id) => document.getElementById(id);
	const store = bridge.store;

	// The editor is built on first use: it draws from the slice it is handed, and the first push can
	// arrive before this script does.
	let editor = null;
	const content = () => {
		if (!editor) {
			editor = window.comonadContentPane({ post: (message) => bridge.post('st', message), store });
		}
		return editor;
	};

	/* ------------------------------------------------------------------ sub-tabs */

	let active = store.get().st || 'characters';

	/** The content sub-tabs are the editor's kinds; the settings one is this file's. */
	function show(name) {
		// The editor is asked first: leaving a sub-tab with unsaved edits is its call, not ours.
		if (name !== 'settings' && !content().select(name)) {
			return;
		}
		active = name;
		store.set({ st: name });
		for (const button of document.querySelectorAll('.subtab[data-st]')) {
			if (button.dataset.st === 'settings') {
				button.classList.toggle('is-on', name === 'settings');
			}
		}
		const pane = $('st-pane');
		if (pane) {
			pane.dataset.view = name === 'settings' ? 'settings' : 'content';
		}
	}

	for (const button of document.querySelectorAll('.subtab[data-st]')) {
		button.addEventListener('click', () => show(button.dataset.st));
	}

	/* ------------------------------------------------------------------ settings */

	/** A field the user is in is left alone: a state push can land in the middle of a keystroke. */
	const put = (node, value) => {
		if (node && document.activeElement !== node) {
			node.value = value;
		}
	};

	function option(value, label, current) {
		const node = document.createElement('option');
		node.value = value;
		node.textContent = label;
		node.selected = value === current;
		return node;
	}

	// The pickers are selects over whatever the library found, plus an empty choice: "no default" is a
	// real value for the character, the persona and the preset alike.
	function fillCatalog(node, items, current, empty) {
		if (!node || document.activeElement === node) {
			return;
		}
		node.innerHTML = '';
		node.append(option('', empty, current));
		for (const item of items || []) {
			node.append(option(item.id || item.name, item.name, current));
		}
		if (current && node.value !== current) {
			node.append(option(current, current, current));
		}
	}

	function renderSettings(tavern, catalog) {
		settingsDrawn = true;
		const enabled = $('tavern-enabled');
		if (enabled && document.activeElement !== enabled) {
			enabled.checked = Boolean(tavern.enabled);
		}
		put($('tavern-user'), tavern.userName || '');
		put($('tavern-note'), tavern.authorNote || '');
		put($('tavern-note-depth'), String(tavern.noteDepth || 0));
		fillCatalog($('tavern-character'), catalog.characters, tavern.character, 'No default character');
		fillCatalog($('tavern-persona'), catalog.personas, tavern.persona, 'No persona');
		fillCatalog($('tavern-preset'), catalog.presets, tavern.preset, 'Default (built-in)');
		put($('wi-format'), tavern.wiFormat || '');
		put($('fmt-scenario'), tavern.scenarioFormat || '');
		put($('fmt-personality'), tavern.personalityFormat || '');
		const known = $('books-known');
		if (known) {
			known.textContent = 'Known books: ' + ((catalog.lorebooks || []).map((book) => book.name + ' (' + book.entries + ')').join(', ') || 'none found');
		}
		const summary = $('catalog-summary');
		if (summary) {
			summary.textContent =
				(catalog.characters || []).length +
				' character(s) · ' +
				(catalog.personas || []).length +
				' persona(s) · ' +
				(catalog.lorebooks || []).length +
				' book(s) · ' +
				(catalog.presets || []).length +
				' preset(s). Reload after adding files — **Comonad: Reload Characters, Books and Presets**.';
		}
	}

	/** Whether the settings half has ever been drawn: before that its fields hold markup defaults,
	 *  and handing those to Save would write them over the user's configuration. */
	let settingsDrawn = false;

	/** The keys this tab owns, as the panel's save merges them into the patch it sends back. */
	function collectSettings() {
		if (!settingsDrawn) {
			return {};
		}
		return {
			tavernEnabled: $('tavern-enabled').checked,
			tavernCharacter: $('tavern-character').value,
			tavernPersona: $('tavern-persona').value,
			tavernUserName: $('tavern-user').value.trim(),
			tavernAuthorNote: $('tavern-note').value,
			tavernNoteDepth: Number($('tavern-note-depth').value) || 0,
			tavernWiFormat: $('wi-format').value,
			tavernScenarioFormat: $('fmt-scenario').value,
			tavernPersonalityFormat: $('fmt-personality').value,
			tavernPreset: $('tavern-preset').value,
		};
	}

	/* ------------------------------------------------------------------ registration */

	bridge.register('st', {
		render(slice) {
			// The panel says which tab is up, so the pane can be told what to draw; a push without a
			// slice means the row that owns this pane is not running, and the tab says so.
			if (!slice) {
				content().notice('The panel sent a state without the ST slice — the tavern row is not loaded.');
				return;
			}
			content().render(slice.content || {});
			renderSettings(slice.tavern || {}, slice.catalog || {});
		},
		note(message) {
			content().note(message);
		},
		collect: collectSettings,
		show: () => show(active),
	});
})();
