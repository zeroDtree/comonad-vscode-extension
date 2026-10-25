/* Workflow settings pane: a library rail, a stage pipeline, a stage inspector and JSON. */
(function () {
	'use strict';

	const $ = (id) => document.getElementById(id);
	const pane = window.comonadPanes;
	if (!pane) {
		return;
	}

	const MODES = [
		['inherit', 'Inherit — the session mode'],
		['ro', 'Read only'],
		['pl', 'Plan — read only + plan files'],
		['sw', 'Semi-write'],
		['aw', 'Full access'],
	];
	const WHENS = [
		['auto', 'Auto — coding tasks'],
		['always', 'Always'],
		['manual', 'Manual — /workflow only'],
	];
	const STATUS_GLYPH = { done: '✔', running: '◐', failed: '✕', skipped: '–', pending: '○', waiting: '⏸' };

	let slice = null;
	let library = null;
	let selected = null;
	let stageId = null;
	let dirty = false;
	let mode = 'visual';
	let jsonDirty = false;
	let dragFrom = -1;
	let suggestionsFor = null;

	const post = (message) => pane.post('workflow', message);
	const clone = (value) => JSON.parse(JSON.stringify(value));
	const esc = (value) =>
		String(value ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');

	function mark() {
		dirty = true;
		$('w-errors').hidden = true;
		status('');
	}
	function status(text, error) {
		const node = $('w-status');
		node.textContent = text || '';
		node.className = error ? 'w-note error' : 'w-note';
	}
	function showErrors(errors) {
		const node = $('w-errors');
		if (!errors || !errors.length) {
			node.hidden = true;
			node.innerHTML = '';
			return;
		}
		node.hidden = false;
		node.innerHTML = '<b>Fix these before saving</b><ul>' + errors.map((error) => '<li>' + esc(error) + '</li>').join('') + '</ul>';
	}
	function workflow() {
		return library && library.workflows.find((entry) => entry.id === selected);
	}
	function stage() {
		const current = workflow();
		return current && current.stages.find((entry) => entry.id === stageId);
	}
	function defaultGraph() {
		const graphs = (slice && slice.graphs) || [];
		const first = graphs.find((graph) => graph.default) || graphs[0] || null;
		return (first && first.id) || 'agent';
	}
	function graphIds() {
		return new Set(((slice && slice.graphs) || []).map((graph) => graph.id));
	}
	function unique(base, used) {
		let id = base;
		let index = 2;
		while (used.has(id)) {
			id = base + '-' + index++;
		}
		return id;
	}
	function slug(text) {
		return (
			String(text || '')
				.toLowerCase()
				.replace(/[^a-z0-9._-]+/g, '-')
				.replace(/^[-.]+|[-.]+$/g, '')
				.slice(0, 48) || 'workflow'
		);
	}

	function ensureSelection() {
		if (!library) {
			return;
		}
		if (!selected || !library.workflows.some((entry) => entry.id === selected)) {
			selected = library.default || library.workflows[0]?.id || null;
		}
		const current = workflow();
		if (!stageId || !current || !current.stages.some((entry) => entry.id === stageId)) {
			stageId = current?.stages[0]?.id || null;
		}
	}

	/* ------------------------------------------------------------------ render */

	function render(next) {
		slice = next || slice;
		if (!slice) {
			return;
		}
		// A live state push (a run started in the chat, say) must not eat unsaved edits or rebuild
		// the inspector under the cursor. Only the run banner follows the chat while dirty.
		if (dirty && library) {
			renderRun();
			return;
		}
		library = clone(slice.library);
		ensureSelection();
		renderAll();
		if (slice.validation && slice.validation.errors && slice.validation.errors.length) {
			showErrors(slice.validation.errors);
		}
	}

	function renderAll() {
		renderTop();
		renderList();
		renderMeta();
		renderPipeline();
		renderStages();
		renderInspector();
		renderRun();
		if (mode === 'json' && !jsonDirty) {
			$('w-json').value = JSON.stringify(library, null, 2);
		}
	}

	function renderTop() {
		const enabled = $('w-enabled');
		enabled.checked = Boolean(library.enabled);
		const select = $('w-default');
		select.innerHTML = library.workflows.map((entry) => '<option value="' + esc(entry.id) + '">' + esc(entry.name) + '</option>').join('');
		select.value = library.default;
		const automatic = library.workflows.filter(
			(entry) => entry.when === 'always' || (entry.id === library.default && entry.when === 'auto'),
		);
		const note = $('w-automatic');
		note.textContent = !library.enabled
			? 'Automatic runs are off; /workflow still runs one.'
			: automatic.length
				? ''
				: 'No workflow will run automatically.';
		note.className = !library.enabled || automatic.length ? 'w-note' : 'w-note warn';
	}

	function renderList() {
		const node = $('w-workflows');
		node.innerHTML = library.workflows
			.map((entry) => {
				const active = entry.id === selected;
				const badges = [];
				if (entry.id === library.default) {
					badges.push('<span class="w-star" title="default">★</span>');
				}
				badges.push('<span class="w-when ' + esc(entry.when) + '">' + esc(entry.when) + '</span>');
				return (
					'<button type="button" class="w-card' +
					(active ? ' active' : '') +
					'" data-workflow="' +
					esc(entry.id) +
					'"><span class="w-card-name">' +
					badges.join(' ') +
					' ' +
					esc(entry.name) +
					'</span><span class="w-card-meta">' +
					esc(entry.id) +
					' · ' +
					entry.stages.length +
					' stages</span></button>'
				);
			})
			.join('');
	}

	function renderMeta() {
		const current = workflow();
		$('w-name').value = current?.name || '';
		$('w-id').value = current?.id || '';
		$('w-description').value = current?.description || '';
		$('w-when').value = current?.when || 'manual';
		for (const id of ['w-name', 'w-id', 'w-description', 'w-when', 'w-duplicate', 'w-delete', 'w-add-agent', 'w-add-checks']) {
			$(id).disabled = !current;
		}
		$('w-add-agent').disabled = !current;
		$('w-add-checks').disabled = !current;
	}

	function pipelineStatus(id) {
		const run = slice && slice.run;
		if (!run || run.workflowId !== selected) {
			return '';
		}
		const state = (run.stages || {})[id];
		return state ? STATUS_GLYPH[state.status] || '' : '';
	}

	function renderPipeline() {
		const current = workflow();
		const node = $('w-pipeline');
		if (!current) {
			node.innerHTML = '';
			return;
		}
		node.innerHTML = current.stages
			.map((entry, index) => {
				const glyph = pipelineStatus(entry.id);
				const icon = entry.run === 'checks' ? '🛡' : '▣';
				const gate = entry.gate ? ' ⏸' : '';
				const running = slice && slice.run && slice.run.workflowId === selected && slice.run.current === entry.id;
				return (
					(index ? '<span class="w-arrow" aria-hidden="true">→</span>' : '') +
					'<button type="button" class="w-pipe' +
					(entry.id === stageId ? ' active' : '') +
					(running ? ' running' : '') +
					'" data-stage="' +
					esc(entry.id) +
					'" title="' +
					esc(entry.title + (gate ? ' — approval gate' : '')) +
					'">' +
					(glyph ? '<span class="w-pipe-glyph">' + glyph + '</span> ' : '') +
					esc(icon + ' ' + entry.title) +
					gate +
					'</button>'
				);
			})
			.join('');
	}

	function renderStages() {
		const current = workflow();
		const node = $('w-stages');
		if (!current) {
			node.innerHTML = '<p class="w-note">Create a workflow to begin.</p>';
			return;
		}
		node.innerHTML = current.stages
			.map((entry, index) => {
				const active = entry.id === stageId;
				const detail =
					entry.run === 'checks'
						? 'checks · ' + (entry.checks?.commands?.length || 0) + ' commands · ' + (entry.checks?.repairs ?? 1) + ' repairs'
						: esc(entry.graph || 'agent') + ' · ' + esc(modeLabel(entry.mode)) + (entry.gate ? ' · approval gate' : '');
				const glyph = pipelineStatus(entry.id);
				return (
					'<div class="w-stage' +
					(active ? ' active' : '') +
					'" draggable="true" data-stage-card="' +
					esc(entry.id) +
					'"><span class="w-drag" title="Drag to reorder">⋮⋮</span><span class="w-stage-index">' +
					(index + 1) +
					'</span><span class="w-stage-body"><span class="w-stage-title">' +
					(glyph ? glyph + ' ' : '') +
					esc(entry.title) +
					'</span><span class="w-stage-meta">' +
					detail +
					'</span></span><span class="w-stage-actions"><button type="button" data-move="up" title="Move up" ' +
					(index === 0 ? 'disabled' : '') +
					'>↑</button><button type="button" data-move="down" title="Move down" ' +
					(index === current.stages.length - 1 ? 'disabled' : '') +
					'>↓</button><button type="button" data-remove-stage="' +
					esc(entry.id) +
					'" title="Remove stage">✕</button></span></div>'
				);
			})
			.join('');
	}

	function modeLabel(value) {
		const found = MODES.find((entry) => entry[0] === (value || 'inherit'));
		return found ? found[1].split(' — ')[0] : value || 'inherit';
	}

	function options(items, current) {
		return items
			.map(
				(entry) =>
					'<option value="' + esc(entry[0]) + '"' + (entry[0] === current ? ' selected' : '') + '>' + esc(entry[1]) + '</option>',
			)
			.join('');
	}

	function renderInspector() {
		const current = workflow();
		const entry = stage();
		const node = $('w-inspector');
		if (!current || !entry) {
			node.innerHTML = '<p class="w-note">Select a stage to edit it.</p>';
			return;
		}
		const index = current.stages.indexOf(entry);
		const graphs = (slice && slice.graphs) || [];
		const graphOptions =
			(graphs.some((graph) => graph.id === (entry.graph || '')) ? '' : entry.graph ? '<option value="' + esc(entry.graph) + '" selected>' + esc(entry.graph) + ' (missing)</option>' : '') +
			graphs.map((graph) => '<option value="' + esc(graph.id) + '"' + (graph.id === entry.graph ? ' selected' : '') + '>' + esc(graph.id) + '</option>').join('');
		const earlier = current.stages
			.slice(0, index)
			.filter((candidate) => candidate.run === 'agent')
			.map((candidate) => [candidate.id, candidate.title]);
		const check = entry.checks || { diagnostics: true, commands: [], timeout: 120, repairs: 1, repairTo: '' };
		const runFields =
			entry.run === 'checks'
				? '<div class="w-field"><span>Checks</span><label class="check"><input type="checkbox" data-field="checks.diagnostics"' +
					(check.diagnostics ? ' checked' : '') +
					' /> Editor diagnostics</label><p class="w-hint">Only errors that were not present when the run started, in files this turn wrote.</p></div>' +
					'<div class="w-field"><span>Commands</span><textarea data-field="checks.commands" rows="4" spellcheck="false" placeholder="npm test&#10;npm run typecheck">' +
					esc((check.commands || []).join('\n')) +
					'</textarea><div class="row"><button type="button" class="secondary" id="w-detect">Detect from package.json</button></div><p class="w-hint">One command per line, run in order with the session sandbox and timeout. Commands from workspace settings only run in trusted workspaces.</p></div>' +
					'<div class="w-grid"><label class="w-field"><span>Timeout (s)</span><input type="number" min="1" max="600" data-field="checks.timeout" value="' +
					esc(check.timeout) +
					'" /></label><label class="w-field"><span>Repairs</span><input type="number" min="0" max="5" data-field="checks.repairs" value="' +
					esc(check.repairs) +
					'" /></label></div>' +
					'<label class="w-field"><span>Repair to</span><select data-field="checks.repairTo"><option value="">— no repair —</option>' +
					options(earlier, check.repairTo || '') +
					'</select></label>'
				: '<div class="w-grid"><label class="w-field"><span>Graph</span><select data-field="graph">' +
					graphOptions +
					'</select></label><label class="w-field"><span>Mode</span><select data-field="mode">' +
					options(MODES, entry.mode || 'inherit') +
					'</select></label></div>' +
					'<div class="w-grid"><label class="w-field"><span>Approval</span><select data-field="approval"><option value=""' +
					(!entry.approval ? ' selected' : '') +
					'>Automatic — reads auto-approve</option><option value="inherit"' +
					(entry.approval === 'inherit' ? ' selected' : '') +
					'>Session approval</option><option value="whitelist_accept"' +
					(entry.approval === 'whitelist_accept' ? ' selected' : '') +
					'>Auto-approve reads</option></select></label><label class="w-field"><span>Step budget</span><input type="number" min="0" data-field="steps" value="' +
					esc(entry.steps || 0) +
					'" /><span class="w-hint">0 inherits the turn budget.</span></label></div>' +
					'<label class="w-field"><span>Objective</span><textarea data-field="objective" rows="5" placeholder="What this stage must finish">' +
					esc(entry.objective || '') +
					'</textarea></label>' +
					'<label class="check"><input type="checkbox" data-field="gate"' +
					(entry.gate ? ' checked' : '') +
					' /> Pause for approval after this stage</label>';
		node.innerHTML =
			'<div class="w-inspector-head"><span>Stage</span><span class="w-spacer"></span><span class="w-when">' +
			esc(entry.run) +
			'</span></div>' +
			'<div class="w-grid"><label class="w-field"><span>Title</span><input type="text" data-field="title" value="' +
			esc(entry.title) +
			'" /></label><label class="w-field"><span>Id</span><input type="text" class="w-mono" data-field="id" value="' +
			esc(entry.id) +
			'" /></label></div>' +
			'<label class="w-field"><span>Kind</span><select data-field="run"><option value="agent"' +
			(entry.run === 'agent' ? ' selected' : '') +
			'>Agent — runs a graph</option><option value="checks"' +
			(entry.run === 'checks' ? ' selected' : '') +
			'>Checks — host verification</option></select></label>' +
			runFields +
			'<div class="row w-inspector-actions"><button type="button" class="secondary" data-act="duplicate-stage">Duplicate stage</button><button type="button" class="secondary" data-act="remove-stage">Remove stage</button></div>' +
			'<p class="w-hint">Read-only and plan stages auto-approve read-only tool calls; project writes always use the session approval.</p>';
	}

	function renderRun() {
		const node = $('w-run');
		const run = slice && slice.run;
		if (!run) {
			node.hidden = true;
			node.innerHTML = '';
			return;
		}
		node.hidden = false;
		const current = run.current ? ' · ' + run.current : '';
		node.innerHTML =
			'<span class="w-run-title">This chat · ' +
			esc(run.name || run.workflowId) +
			'</span><span class="w-run-status ' +
			esc(run.status) +
			'">' +
			esc(run.status + current) +
			'</span>' +
			(run.changed && run.changed.length ? '<span class="w-run-meta">' + run.changed.length + ' files changed</span>' : '');
	}

	/* ------------------------------------------------------------------ editing */

	function reorder(from, to) {
		const current = workflow();
		if (!current || from < 0 || to < 0 || from >= current.stages.length || to >= current.stages.length || from === to) {
			return;
		}
		const [entry] = current.stages.splice(from, 1);
		current.stages.splice(to, 0, entry);
		mark();
		renderStages();
		renderPipeline();
	}
	function moveStage(direction) {
		const current = workflow();
		if (!current) {
			return;
		}
		const index = current.stages.findIndex((entry) => entry.id === stageId);
		reorder(index, index + direction);
	}
	function addStage(run) {
		const current = workflow();
		if (!current) {
			return;
		}
		const used = new Set(current.stages.map((entry) => entry.id));
		const id = unique(run === 'checks' ? 'checks' : 'stage', used);
		const base = current.stages.findIndex((entry) => entry.id === stageId);
		const at = base < 0 ? current.stages.length : base + 1;
		if (run === 'checks') {
			const earlier = current.stages.slice(0, at).filter((entry) => entry.run === 'agent').pop();
			current.stages.splice(at, 0, {
				id,
				title: 'Verify',
				run: 'checks',
				checks: { diagnostics: true, commands: [], timeout: 120, repairs: 1, repairTo: earlier?.id || '' },
			});
		} else {
			current.stages.splice(at, 0, {
				id,
				title: 'New stage',
				run: 'agent',
				graph: defaultGraph(),
				mode: 'inherit',
				objective: '',
			});
		}
		stageId = id;
		mark();
		renderAll();
	}
	function removeStage(id) {
		const current = workflow();
		if (!current) {
			return;
		}
		if (current.stages.length <= 1) {
			showErrors(['A workflow needs at least one stage.']);
			return;
		}
		const index = current.stages.findIndex((entry) => entry.id === id);
		if (index < 0 || !window.confirm(`Remove stage ${current.stages[index].title}?`)) {
			return;
		}
		current.stages.splice(index, 1);
		for (const entry of current.stages) {
			if (entry.checks && entry.checks.repairTo === id) {
				entry.checks.repairTo = '';
			}
		}
		stageId = current.stages[Math.min(index, current.stages.length - 1)].id;
		mark();
		renderAll();
	}
	function duplicateStage() {
		const current = workflow();
		const entry = stage();
		if (!current || !entry) {
			return;
		}
		const used = new Set(current.stages.map((candidate) => candidate.id));
		const copy = clone(entry);
		copy.id = unique(entry.id + '-copy', used);
		copy.title = entry.title + ' copy';
		if (copy.checks) {
			copy.checks.repairTo = '';
		}
		const at = current.stages.indexOf(entry) + 1;
		current.stages.splice(at, 0, copy);
		stageId = copy.id;
		mark();
		renderAll();
	}

	function updateField(field, value) {
		const entry = stage();
		if (!entry) {
			return;
		}
		if (field === 'run') {
			if (value === 'checks') {
				const current = workflow();
				const index = current.stages.indexOf(entry);
				const earlier = current.stages.slice(0, index).filter((candidate) => candidate.run === 'agent').pop();
				entry.run = 'checks';
				entry.checks = { diagnostics: true, commands: [], timeout: 120, repairs: 1, repairTo: earlier?.id || '' };
				for (const key of ['graph', 'mode', 'approval', 'objective', 'steps', 'gate']) {
					delete entry[key];
				}
			} else {
				entry.run = 'agent';
				entry.graph = entry.graph || defaultGraph();
				entry.mode = entry.mode || 'inherit';
				entry.objective = entry.objective || '';
				delete entry.checks;
			}
			mark();
			renderAll();
			return;
		}
		if (field === 'id') {
			const current = workflow();
			const next = slug(value);
			if (!next) {
				return;
			}
			const previous = entry.id;
			entry.id = next;
			stageId = next;
			for (const candidate of current.stages) {
				if (candidate.checks && candidate.checks.repairTo === previous) {
					candidate.checks.repairTo = next;
				}
			}
			mark();
			renderList();
			renderPipeline();
			renderStages();
			return;
		}
		if (field.startsWith('checks.')) {
			entry.checks = entry.checks || { diagnostics: true, commands: [], timeout: 120, repairs: 1, repairTo: '' };
			const key = field.slice('checks.'.length);
			entry.checks[key] = key === 'commands' ? String(value).split('\n').map((line) => line.trim()).filter(Boolean) : key === 'diagnostics' ? Boolean(value) : key === 'timeout' || key === 'repairs' ? Number(value) : String(value);
			mark();
			renderStages();
			renderPipeline();
			return;
		}
		entry[field] = field === 'steps' ? Number(value) : field === 'gate' ? Boolean(value) : String(value);
		mark();
		renderStages();
		renderPipeline();
	}

	function updateWorkflow(field, value) {
		const current = workflow();
		if (!current) {
			return;
		}
		if (field === 'id') {
			const next = slug(value);
			if (!next) {
				return;
			}
			const previous = current.id;
			if (library.default === previous) {
				library.default = next;
			}
			current.id = next;
			selected = next;
			mark();
			renderList();
			renderTop();
			return;
		}
		current[field] = String(value);
		mark();
		renderList();
		renderTop();
	}

	function selectWorkflow(id) {
		if (id === selected) {
			return;
		}
		if (dirty && !window.confirm('Discard the unsaved workflow edits?')) {
			return;
		}
		dirty = false;
		selected = id;
		stageId = null;
		ensureSelection();
		renderAll();
	}
	function selectStage(id) {
		stageId = id;
		renderPipeline();
		renderStages();
		renderInspector();
	}

	/* ------------------------------------------------------------------ JSON */

	function setMode(next) {
		if (next === mode) {
			return;
		}
		if (mode === 'json' && jsonDirty && !window.confirm('Discard the JSON edits?')) {
			return;
		}
		mode = next;
		jsonDirty = false;
		for (const button of document.querySelectorAll('[data-wmode]')) {
			button.classList.toggle('active', button.dataset.wmode === mode);
		}
		const visual = mode === 'visual';
		$('w-json-wrap').hidden = visual;
		$('w-layout')?.toggleAttribute('hidden', !visual);
		if (visual) {
			renderAll();
		} else {
			$('w-json').value = JSON.stringify(library, null, 2);
			$('w-json-status').textContent = '';
		}
	}

	function applyJson(quiet) {
		try {
			const parsed = JSON.parse($('w-json').value);
			library = parsed;
			jsonDirty = false;
			ensureSelection();
			renderAll();
			$('w-json-status').className = 'w-note';
			if (!quiet) {
				$('w-json-status').textContent = 'Applied to the editor; Save writes it.';
			}
			return true;
		} catch (error) {
			$('w-json-status').textContent = String((error && error.message) || error);
			$('w-json-status').className = 'w-note error';
			return false;
		}
	}

	/* ------------------------------------------------------------------ events */

	$('w-enabled').addEventListener('change', () => {
		library.enabled = $('w-enabled').checked;
		mark();
		renderTop();
	});
	$('w-default').addEventListener('change', () => {
		library.default = $('w-default').value;
		mark();
		renderList();
	});
	$('w-name').addEventListener('input', () => updateWorkflow('name', $('w-name').value));
	$('w-id').addEventListener('change', () => updateWorkflow('id', $('w-id').value));
	$('w-description').addEventListener('input', () => updateWorkflow('description', $('w-description').value));
	$('w-when').addEventListener('change', () => updateWorkflow('when', $('w-when').value));

	$('w-workflows').addEventListener('click', (event) => {
		const card = event.target.closest('[data-workflow]');
		if (card) {
			selectWorkflow(card.dataset.workflow);
		}
	});
	$('w-pipeline').addEventListener('click', (event) => {
		const chip = event.target.closest('[data-stage]');
		if (chip) {
			selectStage(chip.dataset.stage);
		}
	});
	$('w-stages').addEventListener('click', (event) => {
		const move = event.target.closest('[data-move]');
		if (move) {
			event.stopPropagation();
			moveStage(move.dataset.move === 'up' ? -1 : 1);
			return;
		}
		const remove = event.target.closest('[data-remove-stage]');
		if (remove) {
			event.stopPropagation();
			removeStage(remove.dataset.removeStage);
			return;
		}
		const card = event.target.closest('[data-stage-card]');
		if (card) {
			selectStage(card.dataset.stageCard);
		}
	});
	$('w-stages').addEventListener('dragstart', (event) => {
		const card = event.target.closest('[data-stage-card]');
		if (!card) {
			return;
		}
		dragFrom = workflow().stages.findIndex((entry) => entry.id === card.dataset.stageCard);
		event.dataTransfer.effectAllowed = 'move';
	});
	$('w-stages').addEventListener('dragover', (event) => {
		if (dragFrom >= 0) {
			event.preventDefault();
			event.dataTransfer.dropEffect = 'move';
		}
	});
	$('w-stages').addEventListener('drop', (event) => {
		const card = event.target.closest('[data-stage-card]');
		if (!card || dragFrom < 0) {
			return;
		}
		event.preventDefault();
		const to = workflow().stages.findIndex((entry) => entry.id === card.dataset.stageCard);
		reorder(dragFrom, to);
		dragFrom = -1;
	});
	$('w-stages').addEventListener('dragend', () => {
		dragFrom = -1;
	});

	$('w-inspector').addEventListener('input', (event) => {
		const field = event.target.dataset.field;
		if (!field || event.target.tagName === 'SELECT' || field === 'id') {
			return;
		}
		updateField(field, event.target.type === 'checkbox' ? event.target.checked : event.target.value);
	});
	$('w-inspector').addEventListener('change', (event) => {
		const field = event.target.dataset.field;
		if (!field) {
			return;
		}
		if (event.target.tagName === 'SELECT') {
			updateField(field, event.target.value);
			if (field === 'run') {
				renderInspector();
			}
		} else if (field === 'id') {
			updateField(field, event.target.value);
			event.target.value = stage()?.id || event.target.value;
		}
	});
	$('w-inspector').addEventListener('click', (event) => {
		const act = event.target.closest('[data-act]');
		if (act) {
			if (act.dataset.act === 'duplicate-stage') {
				duplicateStage();
			} else if (act.dataset.act === 'remove-stage' && stageId) {
				removeStage(stageId);
			}
			return;
		}
		if (event.target.closest('#w-detect')) {
			suggestionsFor = stageId;
			post({ action: 'suggest' });
		}
	});

	$('w-add-agent').addEventListener('click', () => addStage('agent'));
	$('w-add-checks').addEventListener('click', () => addStage('checks'));
	$('w-new').addEventListener('click', () => {
		const used = new Set(library.workflows.map((entry) => entry.id));
		const id = unique('workflow', used);
		library.workflows.push({
			id,
			name: 'New workflow',
			description: '',
			when: 'manual',
			stages: [
				{ id: 'implement', title: 'Implement', run: 'agent', graph: defaultGraph(), mode: 'inherit', objective: '' },
				{ id: 'verify', title: 'Verify', run: 'checks', checks: { diagnostics: true, commands: [], timeout: 120, repairs: 1, repairTo: 'implement' } },
			],
		});
		selected = id;
		stageId = 'implement';
		mark();
		renderAll();
	});
	$('w-duplicate').addEventListener('click', () => {
		const current = workflow();
		if (!current) {
			return;
		}
		const used = new Set(library.workflows.map((entry) => entry.id));
		const copy = clone(current);
		copy.id = unique(current.id + '-copy', used);
		copy.name = current.name + ' copy';
		copy.when = 'manual';
		library.workflows.push(copy);
		selected = copy.id;
		stageId = copy.stages[0]?.id || null;
		mark();
		renderAll();
	});
	$('w-delete').addEventListener('click', () => {
		const current = workflow();
		if (!current || library.workflows.length <= 1) {
			showErrors(['The last workflow cannot be removed.']);
			return;
		}
		if (!window.confirm(`Delete workflow ${current.name}?`)) {
			return;
		}
		library.workflows = library.workflows.filter((entry) => entry.id !== current.id);
		if (library.default === current.id) {
			library.default = library.workflows[0].id;
		}
		selected = null;
		stageId = null;
		ensureSelection();
		mark();
		renderAll();
	});

	for (const button of document.querySelectorAll('[data-wmode]')) {
		button.addEventListener('click', () => setMode(button.dataset.wmode));
	}
	$('w-json').addEventListener('input', () => {
		jsonDirty = true;
		$('w-json-status').textContent = '';
	});
	$('w-json-apply').addEventListener('click', () => applyJson(false));
	$('w-json-validate').addEventListener('click', () => {
		if (!applyJson(true)) {
			return;
		}
		post({ action: 'validate', library });
	});
	$('w-save').addEventListener('click', () => {
		if (mode === 'json' && jsonDirty && !applyJson(true)) {
			return;
		}
		post({ action: 'save', library });
	});
	$('w-validate').addEventListener('click', () => {
		if (mode === 'json' && jsonDirty && !applyJson(true)) {
			return;
		}
		post({ action: 'validate', library });
	});

	/* ------------------------------------------------------------------ pane */

	pane.register('workflow', {
		render,
		show() {
			if (library && mode === 'json' && !jsonDirty) {
				$('w-json').value = JSON.stringify(library, null, 2);
			}
		},
		note(message) {
			if (Array.isArray(message.suggestions)) {
				if (message.suggestions.length) {
					const target = suggestionsFor && workflow()?.stages.find((entry) => entry.id === suggestionsFor);
					if (target) {
						target.checks = target.checks || { diagnostics: true, commands: [], timeout: 120, repairs: 1, repairTo: '' };
						target.checks.commands = message.suggestions;
						mark();
						renderStages();
						renderInspector();
					}
				}
				suggestionsFor = null;
				status(message.message || 'Suggested commands.');
				return;
			}
			if (message.errors !== undefined) {
				showErrors(message.errors);
				status(message.message || (message.errors.length ? 'Invalid workflow.' : 'Valid.'), Boolean(message.errors.length));
				return;
			}
			showErrors([]);
			if (message.message) {
				status(message.message, Boolean(message.error));
			}
			if (!message.error) {
				dirty = false;
			}
		},
	});
})();
