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
	let activeSt = (vscode.getState() || {}).st || 'characters';
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

	// The content editor lives in the same document and shares this webview's message channel.
	const pane = window.comonadContentPane({ post });

	/* ------------------------------------------------------------------ tabs */

	function showSt(name) {
		// The content sub-tabs are the pane's kinds; ask it before switching away from unsaved edits.
		if (name !== 'settings' && !pane.select(name)) {
			return;
		}
		activeSt = name;
		vscode.setState({ tab: activeTab, st: name });
		for (const button of document.querySelectorAll('.subtab[data-st]')) {
			if (button.dataset.st === 'settings') {
				button.classList.toggle('is-on', name === 'settings');
			}
		}
		$('st-pane').dataset.view = name === 'settings' ? 'settings' : 'content';
	}

	for (const button of document.querySelectorAll('.subtab[data-st]')) {
		button.addEventListener('click', () => showSt(button.dataset.st));
	}

	function showTab(name) {
		if (!document.querySelector('.tab[data-tab="' + name + '"]')) {
			name = 'agent';
		}
		activeTab = name;
		vscode.setState({ tab: name, st: activeSt });
		for (const tab of document.querySelectorAll('.tab')) {
			const on = tab.dataset.tab === name;
			tab.classList.toggle('is-on', on);
			tab.setAttribute('aria-selected', String(on));
		}
		for (const pane of document.querySelectorAll('section[data-pane]')) {
			pane.hidden = pane.dataset.pane !== name;
		}
		schedulePreview();
		scheduleFlow();
	}

	for (const tab of document.querySelectorAll('.tab')) {
		tab.addEventListener('click', () => showTab(tab.dataset.tab));
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

	function fillSelect(node, items, current) {
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
		node.innerHTML = '';
		for (const model of models || []) {
			node.append(option([model.id, model.label + (model.description ? ' — ' + model.description : '')], current));
		}
		if (current && node.value !== current) {
			node.append(option([current, current], current));
		}
	}

	/* ------------------------------------------------------------------ content tabs */

	// The character/persona/book/preset pickers are selects over whatever the catalog found, plus an
	// empty choice: "no default" is a real value for all four.
	function fillCatalog(node, items, current, empty) {
		node.innerHTML = '';
		node.append(option(['', empty], current));
		for (const item of items || []) {
			node.append(option([item.id || item.name, item.name], current));
		}
		if (current && node.value !== current) {
			node.append(option([current, current], current));
		}
	}

	const STRATEGIES = [
		['0', 'Character first'],
		['1', 'Global first'],
		['2', 'Evenly'],
	];
	function renderTavern() {
		const tavern = state.tavern || {};
		const catalog = state.catalog || {};
		$('tavern-enabled').checked = Boolean(tavern.enabled);
		$('tavern-user').value = tavern.userName || '';
		$('tavern-note').value = tavern.authorNote || '';
		$('tavern-note-depth').value = String(tavern.noteDepth || 0);
		fillCatalog($('tavern-character'), catalog.characters, tavern.character, 'No default character');
		fillCatalog($('tavern-persona'), catalog.personas, tavern.persona, 'No persona');
		fillCatalog($('tavern-preset'), catalog.presets, tavern.preset, 'The shipped prompts');
		$('tavern-books').value = (tavern.lorebooks || []).join('\n');
		$('books-known').textContent = 'Known books: ' + ((catalog.books || []).map((book) => book.name + ' (' + book.entries + ')').join(', ') || 'none found');
		$('catalog-summary').textContent =
			(catalog.characters || []).length +
			' character(s) · ' +
			(catalog.personas || []).length +
			' persona(s) · ' +
			(catalog.books || []).length +
			' book(s) · ' +
			(catalog.presets || []).length +
			' preset(s). Reload after adding files — **Comonad: Reload Characters, Books and Presets**.';
		const wi = tavern.wi || {};
		$('wi-scan').value = String(wi.scanDepth ?? 0);
		$('wi-budget').value = String(wi.budget ?? 0);
		$('wi-cap').value = String(wi.budgetCap ?? 0);
		$('wi-min').value = String(wi.minActivations ?? 0);
		$('wi-min-depth').value = String(wi.maxActivationsDepth ?? 0);
		$('wi-recursion').checked = Boolean(wi.recursive);
		$('wi-recursion-steps').value = String(wi.maxRecursionSteps ?? 0);
		$('wi-case').checked = Boolean(wi.caseSensitive);
		$('wi-words').checked = Boolean(wi.matchWholeWords);
		$('wi-names').checked = Boolean(wi.includeNames);
		$('wi-groups').checked = Boolean(wi.groupScoring);
		fillSelect($('wi-strategy'), Object.fromEntries(STRATEGIES), String(wi.characterStrategy ?? 0));
		$('wi-format').value = tavern.wiFormat || '';
		$('fmt-scenario').value = tavern.scenarioFormat || '';
		$('fmt-personality').value = tavern.personalityFormat || '';
	}

	function renderForm() {
		const config = state.config;
		fillSelect($('mode'), state.labels.modes, config.mode);
		fillSelect($('approval'), state.labels.approvals, config.approval);
		fillSelect($('display'), state.labels.displays, config.displayForm);
		fillSelect($('context'), state.labels.contexts, config.contextForm);
		fillModels(state.models, config.model);
		$('network').checked = Boolean(config.network);
		$('wd').value = config.workingDirectory;
		$('timeout').value = String(config.commandTimeout);
		$('plans').value = config.planDirectory;
		$('deny').value = (config.denyReadPaths || []).join('\n');
		$('steps').value = String(config.maxSteps);
		const rules = config.permissions || {};
		$('rules-allow').value = (rules.allow || []).join('\n');
		$('rules-ask').value = (rules.ask || []).join('\n');
		$('rules-deny').value = (rules.deny || []).join('\n');
		$('graph').value = config.graph;
		renderTavern();
		clearDirty();
	}

	/** One rule (or path) per line. */
	const lines = (node) => node.value.split('\n').map((line) => line.trim()).filter(Boolean);

	function collect() {
		return {
			mode: $('mode').value,
			approval: $('approval').value,
			network: $('network').checked,
			workingDirectory: $('wd').value.trim(),
			commandTimeout: Number($('timeout').value) || 0,
			planDirectory: $('plans').value.trim(),
			denyReadPaths: lines($('deny')),
			maxSteps: Number($('steps').value) || 0,
			displayForm: $('display').value,
			contextForm: $('context').value,
			model: $('model').value,
			graph: $('graph').value,
			allow: lines($('rules-allow')),
			ask: lines($('rules-ask')),
			deny: lines($('rules-deny')),
			// Content. The prompt table is saved on its own, as a preset.
			tavernEnabled: $('tavern-enabled').checked,
			tavernCharacter: $('tavern-character').value,
			tavernPersona: $('tavern-persona').value,
			tavernUserName: $('tavern-user').value.trim(),
			tavernLorebooks: lines($('tavern-books')),
			tavernAuthorNote: $('tavern-note').value,
			tavernNoteDepth: Number($('tavern-note-depth').value) || 0,
			tavernWiFormat: $('wi-format').value,
			tavernScenarioFormat: $('fmt-scenario').value,
			tavernPersonalityFormat: $('fmt-personality').value,
			wiScanDepth: Number($('wi-scan').value) || 0,
			wiBudget: Number($('wi-budget').value) || 0,
			wiBudgetCap: Number($('wi-cap').value) || 0,
			wiMinActivations: Number($('wi-min').value) || 0,
			wiMaxActivationsDepth: Number($('wi-min-depth').value) || 0,
			wiRecursive: $('wi-recursion').checked,
			wiMaxRecursionSteps: Number($('wi-recursion-steps').value) || 0,
			wiCaseSensitive: $('wi-case').checked,
			wiMatchWholeWords: $('wi-words').checked,
			wiIncludeNames: $('wi-names').checked,
			wiGroupScoring: $('wi-groups').checked,
			wiCharacterStrategy: Number($('wi-strategy').value) || 0,
			tavernPreset: $('tavern-preset').value,
		};
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
		if (activeTab !== 'flow' || !state || (state.flow === flowSource && flowDrawn)) {
			return;
		}
		flowSource = state.flow;
		drawDiagram($('flow'), state.flow, 'flow-diagram').then((drawn) => {
			flowDrawn = drawn;
		});
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

	/* ------------------------------------------------------------------ inbound */

	window.addEventListener('message', (event) => {
		const message = event.data;
		switch (message.type) {
			case 'state':
				state = message;
				graphInfo = message.graphInfo || graphInfo;
				if (!dirty || !ready) {
					renderForm();
				}
				renderReadOnly();
				renderLegend();
				renderGraphInfo();
				// The pane keeps its own edit state, so it is fed on every push, not only on a tab switch.
				if (message.content) {
					pane.render(message.content);
				} else {
					pane.notice('The panel sent a state without its content slice — the ST tab cannot render.');
				}
				if (!ready) {
					ready = true;
					showSt(activeSt);
					showTab(activeTab);
				} else {
					scheduleFlow();
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
			case 'contentNote':
				pane.note(message);
				break;
			case 'openTab':
				showTab(message.tab);
				break;
		}
	});

	// The panel is pushed its first state on open; this also covers a reload.
	post({ type: 'ready' });
})();
