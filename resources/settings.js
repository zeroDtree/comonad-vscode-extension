// Comonad settings webview — tabs over the `comonad.*` config, saved with the header Save button.
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const $ = (id) => document.getElementById(id);
	const post = (message) => vscode.postMessage(message);

	let state = null;
	let dirty = false;
	let ready = false;
	let mcpSeen = '';
	// The ST tab's sub-tab, remembered with the main tab. `data-tab` on the script tag is the tab the
	// extension asked for (`Comonad: Manage Content` opens straight into ST).
	const askedTab = document.querySelector('script[data-tab]');
	let activeTab = (vscode.getState() || {}).tab || (askedTab && askedTab.dataset.tab) || 'agent';
	// The Inspect tab's own sub-tab: the tool policy flow, or the prompt list.
	let activeInspect = (vscode.getState() || {}).inspect || 'flow';
	let graphInfo = { nodes: [], routes: [], error: '' };
	let dirs = { path: '', parent: '', entries: [], error: '' };
	let dirFilter = '';
	let dirsTimer = 0;
	let graphTimer = 0;
	let previewTimer = 0;
	let previewSeq = 0;
	let previewSource = null;
	let previewDrawn = false;

	const status = (text, isError) => {
		const node = $('status');
		node.textContent = text || '';
		node.className = isError ? 'error' : '';
	};
	const markDirty = () => {
		dirty = true;
		$('save').classList.add('is-dirty');
	};
	const clearDirty = () => {
		dirty = false;
		$('save').classList.remove('is-dirty');
	};

	// A pane is a tab a plugin added: its markup and its client files are part of this document, so this
	// client owns the message channel for all of them. A pane's script registers here, is fed its own
	// slice of every state push, and what it collects at save time is merged into the patch.
	// `store` is the small per-document preference bag the guests share, kept apart from the tab.
	const store = {
		get: () => vscode.getState() || {},
		set: (patch) => vscode.setState({ ...(vscode.getState() || {}), ...patch }),
	};
	const panes = new Map();
	let paneSlices = {};
	const lastNote = new Map();
	/** What a pane's script is handed: the channel, the store, and where its own updates go. */
	window.comonadPanes = {
		store,
		post: (id, message) => post({ type: 'pane', pane: id, message }),
		dirty: markDirty,
		register: (id, handlers) => {
			panes.set(id, handlers || {});
			// A pane's script loads after this one and may load after the first state: it is fed what is
			// already here, so registration order is never what decides whether the tab draws.
			if (paneSlices[id]) {
				renderPane(id);
			}
			if (lastNote.has(id)) {
				panes.get(id).note && panes.get(id).note(lastNote.get(id));
			}
			if (activeTab === id) {
				panes.get(id).show && panes.get(id).show();
			}
		},
	};

	/** Feeds one pane its slice of the state the panel just pushed; a pane keeps its own edit state. */
	function renderPane(id) {
		const handlers = panes.get(id);
		if (handlers && handlers.render) {
			handlers.render(paneSlices[id]);
		}
	}

	/* ------------------------------------------------------------------ tabs */

	/* The Inspect tab's own sub-tabs: the tool policy flow and the plugin dependency tree. */
	function showInspect(name) {
		if (!document.querySelector('.subtab[data-inspect="' + name + '"]')) {
			name = 'flow';
		}
		activeInspect = name;
		store.set({ tab: activeTab, inspect: name });
		for (const button of document.querySelectorAll('.subtab[data-inspect]')) {
			const on = button.dataset.inspect === name;
			button.classList.toggle('is-on', on);
			button.setAttribute('aria-selected', String(on));
		}
		for (const pane of document.querySelectorAll('[data-inspect-pane]')) {
			pane.hidden = pane.dataset.inspectPane !== name;
		}
		scheduleFlow();
	}

	for (const button of document.querySelectorAll('.subtab[data-inspect]')) {
		button.addEventListener('click', () => showInspect(button.dataset.inspect));
	}

	function showTab(name) {
		if (!document.querySelector('.tab[data-tab="' + name + '"]')) {
			name = 'agent';
		}
		activeTab = name;
		store.set({ tab: name, inspect: activeInspect });
		for (const tab of document.querySelectorAll('.tab')) {
			const on = tab.dataset.tab === name;
			tab.classList.toggle('is-on', on);
			tab.setAttribute('aria-selected', String(on));
		}
		for (const pane of document.querySelectorAll('section[data-pane]')) {
			pane.hidden = pane.dataset.pane !== name;
		}
		if (name === 'inspect') {
			showInspect(activeInspect);
		}
		if (name === 'prompts') {
			// Paint the last slice (or "reading…") before asking for a fresh one, so reopening the tab
			// is never a blank page.
			renderPrompts();
			post({ type: 'prompts' });
		}
		// A pane may remember a sub-tab of its own: it is shown the tab that is now on screen.
		if (panes.has(name) && panes.get(name).show) {
			panes.get(name).show();
		}
		// Only the tab on screen is drawn — the pushes that landed while it was hidden are cached, and
		// this is where the cache is spent.
		renderActive();
		// The sidebar search travels from page to page: the new page's rows answer to it too.
		applySearch();
		schedulePreview();
		scheduleFlow();
	}

	for (const tab of document.querySelectorAll('.tab')) {
		tab.addEventListener('click', () => showTab(tab.dataset.tab));
	}

	/* ------------------------------------------------------------------ sidebar width */

	// Cursor's settings rail: drag the sash to resize; past the minimum it becomes an icon rail, and
	// double-click (or Home/End on the focused sash) toggles between the two. The width is kept in the
	// webview state beside the active tab, so it survives the panel reloading.
	const SIDE_RAIL = 52;
	const SIDE_MIN = 150;
	const SIDE_MAX = 380;
	const side = $('side');
	const resizer = $('side-resizer');
	const clampSide = (value) => Math.max(SIDE_MIN, Math.min(SIDE_MAX, value));
	let sideWidth = clampSide(Number((vscode.getState() || {}).sideWidth) || 180);
	let sideCompact = Boolean((vscode.getState() || {}).sideCompact);
	const applySide = (persist) => {
		if (!side || !resizer) {
			return;
		}
		side.classList.toggle('compact', sideCompact);
		side.style.width = (sideCompact ? SIDE_RAIL : sideWidth) + 'px';
		resizer.setAttribute('aria-valuenow', String(sideCompact ? SIDE_RAIL : sideWidth));
		resizer.setAttribute('aria-valuemin', String(SIDE_RAIL));
		resizer.setAttribute('aria-valuemax', String(SIDE_MAX));
		if (persist) {
			store.set({ sideWidth, sideCompact });
		}
	};
	applySide(false);
	if (side && resizer) {
		let drag = null;
		const end = (event) => {
			if (drag === null) {
				return;
			}
			drag = null;
			document.body.classList.remove('resizing');
			if (resizer.hasPointerCapture?.(event.pointerId)) {
				resizer.releasePointerCapture(event.pointerId);
			}
			applySide(true);
		};
		resizer.addEventListener('pointerdown', (event) => {
			if (event.button !== 0) {
				return;
			}
			drag = event.pointerId;
			resizer.setPointerCapture?.(event.pointerId);
			document.body.classList.add('resizing');
			event.preventDefault();
		});
		resizer.addEventListener('pointermove', (event) => {
			if (drag === null) {
				return;
			}
			const width = event.clientX - side.getBoundingClientRect().left;
			if (width < SIDE_MIN - 12) {
				sideCompact = true;
			} else {
				sideCompact = false;
				sideWidth = clampSide(width);
			}
			applySide(false);
		});
		resizer.addEventListener('pointerup', end);
		resizer.addEventListener('pointercancel', end);
		resizer.addEventListener('dblclick', () => {
			sideCompact = !sideCompact;
			applySide(true);
		});
		resizer.addEventListener('keydown', (event) => {
			if (event.key === 'ArrowLeft') {
				if (sideCompact) {
					return;
				}
				if (sideWidth <= SIDE_MIN) {
					sideCompact = true;
				} else {
					sideWidth = clampSide(sideWidth - 12);
				}
			} else if (event.key === 'ArrowRight') {
				if (sideCompact) {
					sideCompact = false;
					sideWidth = SIDE_MIN;
				} else {
					sideWidth = clampSide(sideWidth + 12);
				}
			} else if (event.key === 'Home') {
				sideCompact = true;
			} else if (event.key === 'End') {
				sideCompact = false;
				sideWidth = SIDE_MAX;
			} else {
				return;
			}
			event.preventDefault();
			applySide(true);
		});
	}

	/* ------------------------------------------------------------------ search */

	// The sidebar search, Cursor's: it filters the settings rows of the page on screen, and the query
	// travels from page to page. A row is its title and its description, which is what is in the DOM.
	const search = $('search');
	function applySearch() {
		if (!search) {
			return;
		}
		const query = search.value.trim().toLowerCase();
		for (const field of document.querySelectorAll('section[data-pane]:not([hidden]) .field')) {
			field.hidden = Boolean(query) && !field.textContent.toLowerCase().includes(query);
		}
		// A group with nothing left in it goes too, and so does the title above it, so the page reads as
		// the hits and nothing else.
		for (const group of document.querySelectorAll('section[data-pane]:not([hidden]) .group')) {
			group.hidden = Boolean(query) && ![...group.querySelectorAll('.field')].some((field) => !field.hidden);
		}
		for (const title of document.querySelectorAll('section[data-pane]:not([hidden]) .group-title')) {
			const group = title.nextElementSibling;
			title.hidden = Boolean(query) && (!group || group.hidden);
		}
	}
	if (search) {
		search.addEventListener('input', () => {
			applySearch();
		});
		search.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') {
				search.value = '';
				applySearch();
				search.blur();
			}
		});
		document.addEventListener('keydown', (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
				event.preventDefault();
				search.focus();
				search.select();
			}
		});
	}
	/* ------------------------------------------------------------------ form */

	// `label — detail` pairs become the option text, like the rest of the extension.
	function option(items, current) {
		const option = document.createElement('option');
		option.value = items[0];
		option.textContent = items[1];
		option.selected = items[0] === current;
		return option;
	}

	/** A field the user is in is left alone: a state push can land in the middle of a keystroke. */
	function put(node, value) {
		const wanted = String(value ?? '');
		if (node && document.activeElement !== node && node.value !== wanted) {
			node.value = wanted;
		}
	}

	function fillSelect(node, items, current) {
		if (!node || document.activeElement === node) {
			return;
		}
		node.innerHTML = '';
		for (const entry of Object.entries(items || {})) {
			node.append(option(entry, current));
		}
		if (current !== undefined && node.value !== current) {
			node.append(option([current, current], current));
		}
	}

	function fillModels(models, current) {
		const node = $('model');
		if (!node || document.activeElement === node) {
			return;
		}
		node.innerHTML = '';
		for (const model of models || []) {
			node.append(option([model.id, model.label + (model.description ? ' — ' + model.description : '')], current));
		}
		if (current && node.value !== current) {
			node.append(option([current, current], current));
		}
	}

	function renderForm() {
		const config = state.config;
		fillSelect($('mode'), state.labels.modes, config.mode);
		fillSelect($('approval'), state.labels.approvals, config.approval);
		fillSelect($('display'), state.labels.displays, config.displayForm);
		fillSelect($('context'), state.labels.contexts, config.contextForm);
		fillModels(state.models, config.model);
		const checked = (id, value) => {
			const node = $(id);
			if (node && document.activeElement !== node) {
				node.checked = Boolean(value);
			}
		};
		checked('network', config.network);
		put($('wd'), config.workingDirectory);
		put($('timeout'), String(config.commandTimeout));
		put($('plans'), config.planDirectory);
		put($('deny'), (config.denyReadPaths || []).join('\n'));
		checked('confine-read', config.confineRead);
		checked('confine-write', config.confineWrite);
		put($('steps'), String(config.maxSteps));
		const rules = config.permissions || {};
		put($('rules-allow'), (rules.allow || []).join('\n'));
		put($('rules-ask'), (rules.ask || []).join('\n'));
		put($('rules-deny'), (rules.deny || []).join('\n'));
		put($('graph'), config.graph);
		clearDirty();
	}

	/** One rule (or path) per line. */
	const lines = (node) => node.value.split('\n').map((line) => line.trim()).filter(Boolean);

	function collect() {
		const config = {
			mode: $('mode').value,
			approval: $('approval').value,
			network: $('network').checked,
			workingDirectory: $('wd').value.trim(),
			commandTimeout: Number($('timeout').value) || 0,
			planDirectory: $('plans').value.trim(),
			denyReadPaths: lines($('deny')),
			confineRead: $('confine-read').checked,
			confineWrite: $('confine-write').checked,
			maxSteps: Number($('steps').value) || 0,
			displayForm: $('display').value,
			contextForm: $('context').value,
			model: $('model').value,
			graph: $('graph').value,
			allow: lines($('rules-allow')),
			ask: lines($('rules-ask')),
			deny: lines($('rules-deny')),
		};
		// A pane owns its own keys: it contributes the ones its tab holds, and nothing else.
		for (const handlers of panes.values()) {
			if (handlers.collect) {
				Object.assign(config, handlers.collect());
			}
		}
		return config;
	}

	for (const node of document.querySelectorAll('[data-key]')) {
		const changed = () => {
			markDirty();
			if (node.dataset.key === 'graph') {
				scheduleValidate();
				schedulePreview();
			}
		};
		node.addEventListener('input', changed);
		node.addEventListener('change', changed);
	}

	$('model-refresh').addEventListener('click', () => post({ type: 'refresh' }));
	$('pr-refresh').addEventListener('click', () => {
		// A refresh is a fresh read: unsaved layout edits are dropped, as on the Inspect tab.
		promptDirty = false;
		promptLayout = null;
		post({ type: 'prompts' });
	});
	$('pr-save').addEventListener('click', savePrompts);
	$('pr-reset').addEventListener('click', resetPrompts);
	$('model-add').addEventListener('click', () => post({ type: 'configureModel' }));
	$('graph-reset').addEventListener('click', () => {
		$('graph').value = state ? state.defaultGraph : '';
		markDirty();
		post({ type: 'validateGraph', source: $('graph').value });
		schedulePreview();
	});

	function save() {
		const payload = { type: 'save', config: collect() };
		const mcp = $('mcp').value;
		if (mcp !== mcpSeen) {
			try {
				payload.mcpServers = JSON.parse(mcp || '{}');
			} catch (error) {
				status('MCP servers: ' + String((error && error.message) || error), true);
				showTab('mcp');
				return;
			}
		}
		status('Saving…');
		post(payload);
	}

	$('save').addEventListener('click', save);
	$('close').addEventListener('click', () => post({ type: 'close' }));

	/* ------------------------------------------------- working directory picker */

	const wdInput = $('wd');
	const dirsEl = $('dirs');

	function closeDirs() {
		dirsEl.hidden = true;
		dirsEl.innerHTML = '';
	}

	function askDirs(path) {
		post({ type: 'listDirs', path });
	}

	function openDirs() {
		if (dirsEl.hidden) {
			dirsEl.hidden = false;
			askDirs(wdInput.value.trim());
		}
	}

	function entry(label, title, pick) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'entry';
		button.textContent = label;
		button.title = title;
		button.addEventListener('click', pick);
		return button;
	}

	function renderDirs() {
		if (dirsEl.hidden) {
			return;
		}
		dirsEl.innerHTML = '';
		const path = document.createElement('div');
		path.className = 'path';
		path.textContent = dirs.path + (dirs.error ? ' — ' + dirs.error : '');
		dirsEl.append(path);

		const filter = document.createElement('input');
		filter.className = 'filter';
		filter.placeholder = 'Directory name';
		filter.value = dirFilter;
		filter.spellcheck = false;
		filter.addEventListener('input', () => {
			dirFilter = filter.value;
			renderDirs();
			dirsEl.querySelector('.filter')?.focus();
		});
		filter.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				closeDirs();
			}
		});
		dirsEl.append(filter);

		if (dirs.parent) {
			dirsEl.append(entry('↑  ..', dirs.parent, () => askDirs(dirs.parent)));
		}
		const needle = dirFilter.trim().toLowerCase();
		let shown = 0;
		for (const item of dirs.entries) {
			if (needle && !item.name.toLowerCase().includes(needle)) {
				continue;
			}
			shown += 1;
			dirsEl.append(
				entry(item.name, item.path, () => {
					wdInput.value = item.path;
					markDirty();
					askDirs(item.path);
				}),
			);
		}
		if (!shown) {
			const empty = document.createElement('div');
			empty.className = 'path';
			empty.textContent = dirs.error ? '(no access)' : '(no subdirectories)';
			dirsEl.append(empty);
		}

		const use = document.createElement('button');
		use.type = 'button';
		use.className = 'use';
		use.textContent = 'Use this directory';
		use.addEventListener('click', () => {
			wdInput.value = dirs.path || wdInput.value;
			markDirty();
			closeDirs();
		});
		dirsEl.append(use);
	}

	wdInput.addEventListener('focus', openDirs);
	wdInput.addEventListener('click', openDirs);
	wdInput.addEventListener('input', () => {
		openDirs();
		clearTimeout(dirsTimer);
		dirsTimer = setTimeout(() => askDirs(wdInput.value.trim()), 250);
	});
	wdInput.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			event.stopPropagation();
			closeDirs();
		}
	});
	document.addEventListener('mousedown', (event) => {
		if (!event.target.closest?.('.combo')) {
			closeDirs();
		}
	});

	/* ------------------------------------------------------------------ diagrams */

	// Mermaid measures its container, so both diagrams are drawn while their tab is visible.
	function drawDiagram(node, source, name) {
		node.innerHTML = '';
		if (!source) {
			return Promise.resolve(false);
		}
		if (!window.mermaid) {
			node.textContent = 'The diagram needs the Mermaid CDN; everything still works without it.';
			return Promise.resolve(false);
		}
		const container = document.createElement('div');
		node.append(container);
		try {
			window.mermaid.initialize({
				startOnLoad: false,
				securityLevel: 'strict',
				suppressErrorRendering: true,
				theme: document.body.classList.contains('vscode-light') ? 'default' : 'dark',
				// The gate flow is a long chain: keep the ranks tight and let its labels use the full row.
				flowchart: {
					nodeSpacing: 16,
					rankSpacing: 26,
					padding: 6,
					curve: 'linear',
					wrappingWidth: 320,
					subGraphTitleMargin: { top: 4, bottom: 8 },
					useMaxWidth: true,
				},
			});
			return window.mermaid
				.render(name, source)
				.then((result) => {
					container.innerHTML = result.svg;
					return true;
				})
				.catch((error) => {
					container.textContent = String((error && error.message) || error);
					return false;
				});
		} catch (error) {
			container.textContent = String(error);
			return Promise.resolve(false);
		}
	}

	// Both diagrams record whether they are on screen, so re-entering a tab can retry a failed or
	// not-yet-loaded render.
	let flowSource = null;
	let flowDrawn = false;

	function scheduleFlow() {
		if (activeTab !== 'inspect' || activeInspect !== 'flow' || !state || (state.flow === flowSource && flowDrawn)) {
			return;
		}
		flowSource = state.flow;
		drawDiagram($('flow'), state.flow, 'flow-diagram').then((drawn) => {
			flowDrawn = drawn;
		});
	}

	/* ------------------------------------------------------ plugin dependency table */

	/** What each row provides, what it needs and who needs it: the whole wiring, readable as a list. */
	function renderPluginDeps() {
		const rows = (state.plugins && state.plugins.dependencies) || [];
		const node = $('pg-deps');
		node.innerHTML = '';
		const head = document.createElement('tr');
		for (const header of ['row', 'layer', 'provides', 'needs', 'needed by', 'state']) {
			const th = document.createElement('th');
			th.textContent = header;
			head.append(th);
		}
		node.append(head);
		for (const row of rows) {
			const tr = document.createElement('tr');
			tr.className = 'pg-row';
			tr.dataset.id = row.id;
			tr.title = 'Click for the whole chain that stops with this row';
			const name = document.createElement('td');
			name.textContent = row.id;
			name.className = 'mono';
			tr.append(name);
			const layer = document.createElement('td');
			layer.textContent = row.group || '';
			tr.append(layer);
			const provides = document.createElement('td');
			provides.textContent = row.provides.join(', ');
			provides.className = 'mono';
			tr.append(provides);
			const needs = document.createElement('td');
			needs.className = 'mono';
			for (const require of row.requires) {
				const line = document.createElement('div');
				// A service Comonad mounts before the tree is not a hole in it; one nothing provides is.
				line.textContent = require.provider ? `${require.name} ← ${require.provider}` : require.external ? `${require.name} (built in)` : `?${require.name}`;
				if (!require.provider && !require.external) {
					line.className = 'pg-missing';
				}
				needs.append(line);
			}
			tr.append(needs);
			const usedBy = document.createElement('td');
			usedBy.textContent = row.usedBy.join(', ');
			usedBy.className = 'mono';
			tr.append(usedBy);
			const status = document.createElement('td');
			status.textContent = row.loaded ? 'loaded' : row.enabled ? (row.error || '').startsWith('pending') ? 'waiting' : 'failed' : 'off';
			if (row.error) {
				status.title = row.error;
				if (!row.loaded) {
					status.className = 'plugin-error';
				}
			}
			tr.append(status);
			tr.addEventListener('click', () => post({ type: 'pluginTree', id: row.id }));
			node.append(tr);
		}
	}

	/* ------------------------------------------------------------------ graph */

	function renderGraphInfo() {
		$('graph-error').textContent = graphInfo.error ? '⚠ ' + graphInfo.error : '';
		$('graph-error').className = graphInfo.error ? 'hint error' : 'hint';
		$('graph-nodes').textContent = 'Nodes: ' + (graphInfo.nodes.join(', ') || '(none)');
		$('graph-routes').textContent = 'Routes: ' + (graphInfo.routes.join(', ') || '(none)');
	}

	function scheduleValidate() {
		clearTimeout(graphTimer);
		graphTimer = setTimeout(() => post({ type: 'validateGraph', source: $('graph').value }), 300);
	}

	function schedulePreview() {
		clearTimeout(previewTimer);
		// Mermaid measures its container, so only render while the tab is visible.
		if (activeTab !== 'graph') {
			return;
		}
		previewTimer = setTimeout(renderPreview, 300);
	}

	function renderPreview() {
		const node = $('preview');
		const source = $('graph').value.trim();
		if (source === previewSource && previewDrawn) {
			return;
		}
		previewSource = source;
		// The extension already parsed it: show its error instead of mermaid's.
		if (source && graphInfo.error) {
			node.innerHTML = '';
			node.textContent = graphInfo.error;
			previewDrawn = true;
			return;
		}
		drawDiagram(node, source, 'graph-preview-' + ++previewSeq).then((drawn) => {
			previewDrawn = drawn;
		});
	}

	/* ------------------------------------------------------------------ mcp & tools */

	$('mcp-save').addEventListener('click', () => post({ type: 'saveMcp', json: $('mcp').value }));
	$('mcp-reload').addEventListener('click', () => post({ type: 'reloadMcp' }));
	$('plugins-reload').addEventListener('click', () => post({ type: 'plugins', action: 'reload' }));
	$('plugins-install').addEventListener('click', () => post({ type: 'plugins', action: 'install' }));

	function table(node, headers, rows) {
		node.innerHTML = '';
		const head = document.createElement('tr');
		for (const header of headers) {
			const th = document.createElement('th');
			th.textContent = header;
			head.append(th);
		}
		node.append(head);
		for (const row of rows) {
			const tr = document.createElement('tr');
			for (const cell of row) {
				const td = document.createElement('td');
				td.textContent = cell.text;
				if (cell.mono) {
					td.className = 'mono';
				}
				tr.append(td);
			}
			node.append(tr);
		}
	}

	/** The modes and what they grant, as a caption above the gate flow. */
	function renderLegend() {
		const node = $('flow-legend');
		node.innerHTML = '';
		for (const line of state.modeLegend || []) {
			const [name, detail] = String(line).split(' — ');
			const item = document.createElement('li');
			const strong = document.createElement('strong');
			strong.textContent = name;
			item.append(strong, detail ? ' — ' + detail : '');
			node.append(item);
		}
	}

	/**
	 * The plugin list: what each row is, where it came from, and whether it is loaded. A row that is
	 * enabled can be turned off here — the host writes that into the workspace's `cordis.yml` and applies
	 * the list again, so the change is the same one you would make by hand, and it survives a reload.
	 * A row that is not built in can also be uninstalled: its row goes and its installed folder with it.
	 */
	function renderPlugins() {
		const plugins = state.plugins || { rows: [], project: '', user: '', writable: '', trusted: true };
		$('plugins-project').textContent = plugins.project || '(no workspace folder)';
		$('plugins-user').textContent = plugins.user || '(no home)';
		$('plugins-writable').textContent = plugins.writable || 'nowhere (a toggle would have no file to go in)';
		$('plugins-reload').disabled = !plugins.project && !plugins.user;
		$('plugins-note').textContent = plugins.trusted
			? ''
			: 'This workspace is not trusted, so its own list is not read and a row can only be toggled in yours.';
		const node = $('plugins');
		node.innerHTML = '';
		const head = document.createElement('tr');
		for (const header of ['row', 'from', 'resolves to', 'state', '']) {
			const th = document.createElement('th');
			th.textContent = header;
			head.append(th);
		}
		node.append(head);
		for (const row of plugins.rows || []) {
			const tr = document.createElement('tr');
			const name = document.createElement('td');
			name.textContent = row.id;
			name.className = 'mono';
			name.title = row.error || '';
			tr.append(name);
			const from = document.createElement('td');
			from.textContent = row.source;
			tr.append(from);
			const target = document.createElement('td');
			target.textContent = row.target;
			target.className = 'mono';
			tr.append(target);
			const status = document.createElement('td');
			status.textContent = row.loaded ? 'loaded' : row.enabled ? 'not loaded' : 'off';
			if (row.error) {
				status.title = row.error;
				status.className = 'plugin-error';
			}
			tr.append(status);
			const actions = document.createElement('td');
			const button = document.createElement('button');
			button.className = 'secondary';
			button.type = 'button';
			button.textContent = row.enabled ? 'Disable' : 'Enable';
			button.disabled = !plugins.writable;
			button.title = row.enabled ? 'Turn this row off' : 'Turn this row on';
			button.addEventListener('click', () => post({ type: 'plugins', action: 'toggle', id: row.id, disabled: row.enabled }));
			actions.append(button);
			// A built-in row ships with Comonad and cannot be uninstalled, only turned off; anything
			// else is something the user put there — an installed copy in the library, or a row of
			// their own — and can be taken away again (the host asks before it deletes anything).
			if (row.target !== 'built-in') {
				const remove = document.createElement('button');
				remove.className = 'secondary';
				remove.type = 'button';
				remove.textContent = 'Uninstall';
				remove.disabled = !plugins.writable;
				remove.title = 'Remove this row — and the copy in your library, when there is one';
				remove.addEventListener('click', () => post({ type: 'plugins', action: 'uninstall', id: row.id }));
				actions.append(remove);
			}
			tr.append(actions);
			node.append(tr);
		}
	}

	function renderReadOnly() {
		const mcp = $('mcp');
		if (document.activeElement !== mcp) {
			const text = JSON.stringify(state.mcpServers || {}, null, 2);
			if (mcp.value !== text) {
				mcp.value = text;
			}
			mcpSeen = text;
		}
		$('mcp-status').innerHTML = '';
		table($('mcp-status'), ['server', 'connected', 'tools', 'error'], (state.mcp || []).map((item) => [
			{ text: item.name, mono: true },
			{ text: item.connected ? 'yes' : 'no' },
			{ text: String(item.tools) },
			{ text: item.error || '' },
		]));
		table($('tools'), ['tool', 'capability', 'network', 'workspace', 'description'], (state.tools || []).map((tool) => [
			{ text: tool.name, mono: true },
			{ text: tool.capability },
			{ text: tool.network ? 'yes' : '' },
			{ text: tool.workspace ? 'yes' : '' },
			{ text: tool.description },
		]));
	}

	/* ------------------------------------------------------------------ prompts */

	// The Prompts tab: Comonad's blocks (order, switch, editable static prefix) and the tool
	// definitions (order, switch, read-only definition). The host reads the slice on demand; under ST
	// the block order/switches mirror the active preset, while the prefix stays ours.
	let promptsData = null;
	/** The editable copy: arrays whose order is the send order. */
	let promptLayout = null;
	let promptDirty = false;
	/** The row being dragged: { group, index }, or null. */
	let promptDrag = null;

	const promptKey = (group, row) => group + ':' + (group === 'comonad' ? row.id : row.name);
	const firstPromptKey = () =>
		promptLayout && promptLayout.comonad.length
			? promptKey('comonad', promptLayout.comonad[0])
			: promptLayout && promptLayout.tools.length
				? promptKey('tools', promptLayout.tools[0])
				: '';

	function acceptPrompts(data, saved) {
		if (!data) {
			return;
		}
		promptsData = data;
		// A push can land while the user is editing. Only a save response (or a clean form) replaces
		// the local copy; a dirty one keeps its edits and merely refreshes the banner.
		if (!promptLayout || !promptDirty || saved) {
			promptLayout = {
				comonad: (data.comonad || []).map((row) => ({ ...row })),
				tools: (data.tools || []).map((row) => ({ ...row })),
			};
			promptDirty = false;
		}
		renderPrompts();
	}

	function promptMarkDirty() {
		promptDirty = true;
		const save = $('pr-save');
		if (save) {
			save.disabled = false;
		}
	}

	function movePromptRow(group, from, to) {
		const rows = promptLayout && promptLayout[group];
		if (!rows || from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) {
			return;
		}
		const moved = rows.splice(from, 1)[0];
		rows.splice(to, 0, moved);
		promptMarkDirty();
		renderPrompts();
	}

	function promptRowElement(group, row, index, picked) {
		const readOnlyOrder = group === 'comonad' && row.readOnlyOrder === true;
		const item = document.createElement('div');
		item.className = 'pr-item' + (row.enabled === false ? ' is-off' : '');
		item.draggable = !readOnlyOrder;
		if (!readOnlyOrder) {
			item.addEventListener('dragstart', (event) => {
				promptDrag = { group, index };
				item.classList.add('is-dragging');
				event.dataTransfer.effectAllowed = 'move';
				// Firefox needs some data on the transfer before it starts a drag.
				event.dataTransfer.setData('text/plain', promptKey(group, row));
			});
			item.addEventListener('dragend', () => {
				promptDrag = null;
				item.classList.remove('is-dragging');
				document.querySelectorAll('#pr-list .is-drop-target').forEach((node) => node.classList.remove('is-drop-target'));
			});
			item.addEventListener('dragover', (event) => {
				if (!promptDrag || promptDrag.group !== group) {
					return;
				}
				event.preventDefault();
				item.classList.add('is-drop-target');
			});
			item.addEventListener('dragleave', () => item.classList.remove('is-drop-target'));
			item.addEventListener('drop', (event) => {
				if (!promptDrag || promptDrag.group !== group) {
					return;
				}
				event.preventDefault();
				const from = promptDrag.index;
				promptDrag = null;
				movePromptRow(group, from, index);
			});
		}
		const line = document.createElement('div');
		line.className = 'pr-row' + (picked ? ' is-on' : '');

		const toggle = document.createElement('label');
		toggle.className = 'switch';
		toggle.title = readOnlyOrder ? 'ST owns this switch' : row.enabled === false ? 'Send this block' : 'Stop sending this block';
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = row.enabled !== false;
		input.disabled = readOnlyOrder;
		input.addEventListener('change', () => {
			row.enabled = input.checked;
			promptMarkDirty();
			renderPrompts();
		});
		toggle.append(input, Object.assign(document.createElement('span'), { className: 'knob' }));

		const name = document.createElement('button');
		name.type = 'button';
		name.className = 'pr-name';
		name.textContent = row.name;
		name.title = group === 'comonad' ? 'Edit the static prefix' : 'Read this tool definition';
		name.addEventListener('click', () => {
			store.set({ prompt: promptKey(group, row) });
			renderPrompts();
		});

		const note = document.createElement('span');
		note.className = 'pr-note';
		note.textContent =
			group === 'comonad'
				? (readOnlyOrder ? 'ST order · ' : '') + (row.tokens || 0) + ' tokens'
				: (row.enabled === false ? 'off · ' : '') + (row.visible ? row.capability : row.reason || 'not offered') + ' · ' + row.tokens + ' tokens';

		const controls = document.createElement('div');
		controls.className = 'pr-controls';
		const control = (glyph, tip, onClick, disabled) => {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'icon';
			button.textContent = glyph;
			button.title = tip;
			button.disabled = disabled;
			button.addEventListener('click', onClick);
			controls.append(button);
		};
		control('↑', 'Move up', () => movePromptRow(group, index, index - 1), readOnlyOrder || index === 0);
		control('↓', 'Move down', () => movePromptRow(group, index, index + 1), readOnlyOrder || index === promptLayout[group].length - 1);

		line.append(toggle, name, note, controls);
		item.append(line);
		return item;
	}

	function renderPromptPreview(picked) {
		const editor = $('pr-editor');
		const view = $('pr-view');
		editor.innerHTML = '';
		view.hidden = false;
		const comonad = promptLayout.comonad.find((row) => promptKey('comonad', row) === picked);
		if (comonad) {
			$('pr-title').textContent = 'Comonad — ' + comonad.name;
			$('pr-meta').textContent =
				(comonad.enabled === false ? 'off' : 'on') +
				' · ' +
				comonad.tokens +
				' tokens' +
				(comonad.readOnlyOrder ? ' · order and switch come from the active ST preset' : '');
			const label = document.createElement('label');
			label.textContent = 'Static prefix';
			label.htmlFor = 'pr-prefix';
			const hint = document.createElement('p');
			hint.className = 'hint';
			hint.textContent =
				comonad.id === 'comonad-tools'
					? 'This guidance is sent when at least one tool is available. A turn with no tools uses the built-in no-tools sentence; the dynamic lines below are always appended.'
					: 'Only this static opening is editable. The generated content below it is rebuilt every turn and is shown read-only.';
			const area = document.createElement('textarea');
			area.id = 'pr-prefix';
			area.className = 'control';
			area.rows = 4;
			area.spellcheck = false;
			area.value = comonad.prefix;
			area.addEventListener('input', () => {
				comonad.prefix = area.value;
				promptMarkDirty();
			});
			const reset = document.createElement('button');
			reset.type = 'button';
			reset.className = 'secondary';
			reset.textContent = 'Reset prefix';
			reset.addEventListener('click', () => {
				comonad.prefix = comonad.defaultPrefix;
				promptMarkDirty();
				renderPrompts();
			});
			editor.append(label, hint, area, reset);
			view.textContent = comonad.text || '(not sent this turn)';
			return;
		}
		const tool = promptLayout.tools.find((row) => promptKey('tools', row) === picked);
		if (tool) {
			$('pr-title').textContent = 'Tool — ' + tool.name;
			$('pr-meta').textContent =
				(tool.enabled === false ? 'off' : 'on') +
				' · ' +
				(tool.visible ? 'offered' : tool.reason || 'not offered') +
				' · ' +
				tool.capability +
				' · ' +
				tool.tokens +
				' tokens';
			view.textContent = (tool.description || '') + '\n\n' + JSON.stringify(tool.parameters || {}, null, 2);
			return;
		}
		$('pr-title').textContent = 'Preview';
		$('pr-meta').textContent = '';
		view.textContent = 'Pick a prompt on the left.';
	}

	function renderPrompts() {
		const list = $('pr-list');
		const view = $('pr-view');
		if (!list || !view) {
			return;
		}
		list.innerHTML = '';
		if (!promptLayout) {
			list.innerHTML = '<p class="hint">Reading the prompts…</p>';
			$('pr-editor').innerHTML = '';
			$('pr-title').textContent = 'Preview';
			$('pr-meta').textContent = '';
			view.textContent = '';
			return;
		}
		const groups = [
			['Comonad', promptLayout.comonad, 'comonad'],
			['Tools', promptLayout.tools, 'tools'],
		];
		const keys = [];
		for (const [, rows, group] of groups) {
			for (const row of rows) {
				keys.push(promptKey(group, row));
			}
		}
		const picked = (vscode.getState() || {}).prompt || '';
		const shown = keys.includes(picked) ? picked : firstPromptKey();
		for (const [label, rows, group] of groups) {
			if (!rows.length) {
				continue;
			}
			const heading = document.createElement('h3');
			heading.textContent = label;
			heading.append(Object.assign(document.createElement('span'), { className: 'pr-count', textContent: String(rows.length) }));
			list.append(heading);
			rows.forEach((row, index) => {
				list.append(promptRowElement(group, row, index, promptKey(group, row) === shown));
			});
		}
		if (!keys.length) {
			list.innerHTML = '<p class="hint">Nothing to show yet.</p>';
		}

		const note = $('prompts-note');
		note.textContent = '';
		if (promptsData && promptsData.takeover) {
			note.append(
				document.createTextNode(
					'ST takes over the prompts: the block order and switches below come from the active preset. Edit them in ST → Presets; the prefixes here are still used by the composed request. ',
				),
			);
			const open = document.createElement('button');
			open.type = 'button';
			open.className = 'secondary';
			open.textContent = 'Open ST tab';
			open.addEventListener('click', () => post({ type: 'openTab', tab: 'st' }));
			note.append(open);
		}
		if (promptsData && promptsData.stToolsEnabled === false) {
			const line = document.createElement('p');
			line.className = 'hint';
			line.textContent = "ST's Tools entry is off: no tools will be sent this turn. The tool switches below still save for when it is on.";
			note.append(line);
		}
		if (promptsData && !promptsData.takeover && promptsData.toolsBlockEnabled === false) {
			const line = document.createElement('p');
			line.className = 'hint';
			line.textContent = 'The Tools block is off: no tools will be sent this turn. Turn it back on to offer them.';
			note.append(line);
		}
		$('pr-chat').textContent =
			promptsData && promptsData.chat
				? 'The next turn would run as ' + promptsData.chat.mode + ' · ' + promptsData.chat.approval + '.'
				: 'No active chat: tools are reported as not offered.';
		renderPromptPreview(shown);
		updatePromptSave();
	}

	function updatePromptSave() {
		const save = $('pr-save');
		if (save) {
			save.disabled = !promptDirty;
		}
	}

	function savePrompts() {
		if (!promptLayout) {
			return;
		}
		post({
			type: 'savePrompts',
			prompts: promptLayout.comonad.map((row) => ({ id: row.id, enabled: row.enabled !== false, prefix: row.prefix })),
			toolPrompts: promptLayout.tools.map((row) => ({ name: row.name, enabled: row.enabled !== false })),
		});
	}

	function resetPrompts() {
		if (!promptsData || !promptLayout) {
			return;
		}
		const current = new Map(promptLayout.comonad.map((row) => [row.id, row]));
		const defaults = (promptsData.defaults && promptsData.defaults.comonad) || [];
		promptLayout.comonad = defaults.map((row, index) => {
			const live = current.get(row.id) || {};
			return {
				...live,
				...row,
				order: index,
				enabled: true,
				prefix: row.prefix,
				readOnlyOrder: promptsData.takeover,
				body: live.body || '',
				text: live.text || '',
				tokens: live.tokens || 0,
			};
		});
		promptLayout.tools = promptLayout.tools
			.slice()
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((row) => ({ ...row, enabled: true }));
		promptMarkDirty();
		renderPrompts();
	}

	/* ------------------------------------------------------------------ inbound */

	/** Draws the tab on screen from the state the panel last pushed. Hidden tabs are not drawn at
	 *  all: their widgets are rebuilt when they are next shown, from this same cache. */
	function renderActive() {
		if (!state) {
			return;
		}
		switch (activeTab) {
			case 'agent':
				// A form the user is in the middle of keeps its edits; the next push after the save
				// is the one that redraws it.
				if (!dirty || !ready) {
					renderForm();
				}
				break;
			case 'graph':
				renderGraphInfo();
				break;
			case 'rules':
				if (!dirty || !ready) {
					renderForm();
				}
				break;
			case 'mcp':
			case 'tools':
				renderReadOnly();
				break;
			case 'plugins':
				renderPlugins();
				break;
			case 'inspect':
				renderPluginDeps();
				renderLegend();
				renderGraphInfo();
				break;
			default:
				break;
		}
		if (panes.has(activeTab)) {
			renderPane(activeTab);
		}
	}

	window.addEventListener('message', (event) => {
		const message = event.data;
		switch (message.type) {
			case 'pluginTree': {
				const wrap = $('pg-detail-wrap');
				$('pg-detail-title').textContent = 'Dependency tree — ' + message.id;
				$('pg-detail').textContent = message.text;
				wrap.hidden = false;
				wrap.scrollIntoView({ block: 'nearest' });
				break;
			}
			case 'state':
				state = message;
				paneSlices = message.panes || {};
				graphInfo = message.graphInfo || graphInfo;
				renderActive();
				if (!ready) {
					ready = true;
					showTab(activeTab);
				} else {
					scheduleFlow();
				}
				break;
			case 'prompts':
				acceptPrompts(message.prompts, message.saved === true);
				if (message.saved === true) {
					status('Prompts saved.');
				}
				break;
			case 'models':
				fillModels(message.models, state ? state.config.model : '');
				break;
			case 'dirs':
				dirs = message;
				renderDirs();
				break;
			case 'graphInfo':
				graphInfo = message;
				renderGraphInfo();
				previewSource = null;
				previewDrawn = false;
				schedulePreview();
				break;
			case 'ok':
				status(message.message);
				clearDirty();
				break;
			case 'error':
				status(message.message, true);
				break;
			case 'note':
				lastNote.set(message.pane, message);
				if (panes.has(message.pane) && panes.get(message.pane).note) {
					panes.get(message.pane).note(message);
				}
				break;
			case 'openTab':
				showTab(message.tab);
				break;
		}
	});

	// The panel is pushed its first state on open; this also covers a reload.
	post({ type: 'ready' });
})();
