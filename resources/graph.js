/* Graph settings pane. The host owns the source; this client edits one graph block at a time. */
(function () {
	'use strict';

	const $ = (id) => document.getElementById(id);
	const pane = window.comonadPanes;
	if (!pane) {
		return;
	}

	const editor = $('g-source');
	const gutter = $('g-gutter');
	const preview = $('g-preview');
	const inspector = $('g-inspector');
	const list = $('g-graphs');
	const status = $('g-status');
	const whole = $('g-whole');
	const title = $('g-title');
	const defaultBadge = $('g-default-badge');

	let slice = null;
	let validated = null;
	let selected = null;
	let dirty = false;
	let isWhole = false;
	let previewTimer = 0;
	let previewSeq = 0;
	let previewDrawn = '';
	let promptResolve = null;

	function askId(title, value) {
		return new Promise((resolve) => {
			promptResolve = resolve;
			$('g-prompt-title').textContent = title;
			const input = $('g-prompt-input');
			input.value = value || '';
			$('g-prompt').hidden = false;
			input.focus();
			input.select();
		});
	}
	function settlePrompt(value) {
		const resolve = promptResolve;
		promptResolve = null;
		$('g-prompt').hidden = true;
		if (resolve) {
			resolve(value);
		}
	}
	$('g-prompt-ok').addEventListener('click', () => settlePrompt($('g-prompt-input').value.trim().toLowerCase() || null));
	$('g-prompt-cancel').addEventListener('click', () => settlePrompt(null));
	$('g-prompt-input').addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			settlePrompt($('g-prompt-input').value.trim().toLowerCase() || null);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			settlePrompt(null);
		}
	});
	$('g-prompt').addEventListener('click', (event) => {
		if (event.target === $('g-prompt')) {
			settlePrompt(null);
		}
	});

	const post = (message) => pane.post('graph', message);
	const esc = (text) =>
		String(text ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');

	function graphs() {
		return (validated && validated.graphs) || (slice && slice.graphs) || [];
	}
	function blocks() {
		return (validated && validated.blocks) || (slice && slice.blocks) || [];
	}
	function blockSource(id) {
		const block = blocks().find((entry) => entry.id === id);
		return block ? block.source : '';
	}
	function selectedGraph() {
		return graphs().find((graph) => graph.id === selected);
	}
	function setStatus(text, error) {
		status.textContent = text || '';
		status.className = error ? 'g-status error' : 'g-status';
	}

	function renderList() {
		const entries = graphs();
		list.innerHTML = entries
			.map((graph) => {
				const active = graph.id === selected;
				return (
					'<button type="button" class="g-card' +
					(active ? ' active' : '') +
					'" data-graph="' +
					esc(graph.id) +
					'">' +
					'<span class="g-card-id">' +
					(graph.default ? '<span class="g-star" title="default">★</span> ' : '') +
					esc(graph.id) +
					'</span>' +
					'<span class="g-card-meta">' +
					graph.nodes.length +
					' nodes · ' +
					graph.routes.length +
					' routes</span></button>'
				);
			})
			.join('');
		if (!entries.length) {
			list.innerHTML = '<p class="g-hint">No valid graph yet. Fix the source to see it here.</p>';
		}
	}

	function renderMain() {
		const graph = selectedGraph();
		title.textContent = selected || '(no graph)';
		defaultBadge.hidden = !graph || !graph.default;
		$('g-set-default').disabled = !graph || graph.default;
		$('g-duplicate').disabled = !graph;
		$('g-delete').disabled = !graph || graphs().length <= 1;
		$('g-new').disabled = false;
		if (!dirty) {
			editor.value = isWhole ? (slice && slice.source) || '' : blockSource(selected);
		}
		gutter.textContent = lineNumbers(editor.value);
		renderInspector();
		schedulePreview();
	}

	function renderInspector() {
		const graph = selectedGraph();
		const parts = [];
		if (graph) {
			parts.push('<p class="g-inspector-row"><span>start</span><code>' + esc(graph.start) + '</code></p>');
			parts.push(
				'<p class="g-inspector-row"><span>nodes</span>' +
					(graph.nodes.length ? graph.nodes.map((node) => '<code>' + esc(node) + '</code>').join(' ') : '<em>none</em>') +
					'</p>',
			);
			parts.push(
				'<p class="g-inspector-row"><span>routes</span>' +
					(graph.routes.length ? graph.routes.map((route) => '<code>' + esc(route) + '</code>').join(' ') : '<em>none</em>') +
					'</p>',
			);
		}
		const error = validated && validated.error ? validated.error : slice && slice.error;
		if (error) {
			parts.push('<p class="g-error">⚠ ' + esc(error) + '</p>');
		}
		inspector.innerHTML = parts.join('');
	}

	function renderTools() {
		const nodes = (slice && slice.nodes) || [];
		const routes = (slice && slice.routes) || [];
		$('g-nodes').innerHTML = nodes.length
			? nodes
					.map((node) => '<button type="button" class="g-chip" data-node="' + esc(node) + '">' + esc(node) + '</button>')
					.join('')
			: '<span class="g-hint">No node implementations are registered.</span>';
		$('g-routes').innerHTML = routes.length
			? routes
					.map((route) => '<button type="button" class="g-chip" data-route="' + esc(route) + '">' + esc(route) + '</button>')
					.join('')
			: '<span class="g-hint">No route functions are registered.</span>';
	}

	function render() {
		if (!slice) {
			return;
		}
		const entries = graphs();
		if (!selected || !entries.some((graph) => graph.id === selected)) {
			selected = slice.default || entries[0]?.id || null;
		}
		// A source the parser cannot read has no blocks: show the whole text so it can be repaired
		// instead of presenting an empty per-graph editor.
		if (!entries.length) {
			isWhole = true;
			whole.checked = true;
		}
		validated = null;
		renderList();
		renderMain();
		renderTools();
		setStatus(slice.error ? 'Graph source has an error' : '', Boolean(slice.error));
	}

	function lineNumbers(text) {
		const count = Math.max(1, String(text).split('\n').length);
		const lines = [];
		for (let index = 1; index <= count; index += 1) {
			lines.push(index);
		}
		return lines.join('\n');
	}

	function syncGutter() {
		gutter.scrollTop = editor.scrollTop;
	}

	/* ------------------------------------------------------------------ preview */

	function schedulePreview() {
		clearTimeout(previewTimer);
		previewTimer = setTimeout(drawPreview, 220);
	}

	function drawPreview() {
		if (validated && validated.error) {
			preview.textContent = validated.error || 'Invalid graph';
			return;
		}
		if (!isWhole && !dirty && slice && slice.error) {
			preview.textContent = slice.error;
			return;
		}
		const source = isWhole ? '' : blockSource(selected);
		if (isWhole) {
			preview.textContent = 'Preview shows one graph. Switch off “Whole source” to draw the selected graph.';
			return;
		}
		if (!source.trim()) {
			preview.innerHTML = '';
			return;
		}
		if (!window.mermaid) {
			preview.textContent = 'The diagram needs the Mermaid CDN; the editor still works without it.';
			return;
		}
		if (source === previewDrawn) {
			return;
		}
		previewDrawn = source;
		const container = document.createElement('div');
		preview.innerHTML = '';
		preview.append(container);
		try {
			window.mermaid.initialize({
				startOnLoad: false,
				securityLevel: 'strict',
				suppressErrorRendering: true,
				theme: document.body.classList.contains('vscode-light') ? 'default' : 'dark',
				flowchart: {
					nodeSpacing: 18,
					rankSpacing: 30,
					padding: 6,
					curve: 'linear',
					wrappingWidth: 220,
					useMaxWidth: true,
				},
			});
			window.mermaid
				.render('g-preview-' + ++previewSeq, source)
				.then((result) => {
					container.innerHTML = result.svg;
				})
				.catch((error) => {
					container.textContent = String((error && error.message) || error);
				});
		} catch (error) {
			container.textContent = String(error);
		}
	}

	/* ------------------------------------------------------------------ actions */

	editor.addEventListener('input', () => {
		dirty = true;
		validated = null;
		gutter.textContent = lineNumbers(editor.value);
		schedulePreview();
	});
	editor.addEventListener('scroll', syncGutter);
	editor.addEventListener('keydown', (event) => {
		if (event.key !== 'Tab') {
			return;
		}
		event.preventDefault();
		const start = editor.selectionStart;
		const end = editor.selectionEnd;
		editor.setRangeText('  ', start, end, 'end');
		editor.dispatchEvent(new Event('input'));
	});

	list.addEventListener('click', (event) => {
		const card = event.target.closest('[data-graph]');
		if (!card) {
			return;
		}
		if (dirty && !window.confirm('Discard the unsaved changes to this graph?')) {
			return;
		}
		dirty = false;
		validated = null;
		selected = card.dataset.graph;
		renderList();
		renderMain();
	});

	$('g-nodes').addEventListener('click', (event) => {
		const chip = event.target.closest('[data-node]');
		if (!chip) {
			return;
		}
		const at = editor.selectionStart;
		editor.setRangeText(chip.dataset.node, at, editor.selectionEnd, 'end');
		editor.dispatchEvent(new Event('input'));
		editor.focus();
	});
	$('g-routes').addEventListener('click', (event) => {
		const chip = event.target.closest('[data-route]');
		if (!chip) {
			return;
		}
		const at = editor.selectionStart;
		editor.setRangeText('|route: ' + chip.dataset.route + '|', at, editor.selectionEnd, 'end');
		editor.dispatchEvent(new Event('input'));
		editor.focus();
	});

	$('g-save').addEventListener('click', () => {
		if (isWhole) {
			post({ action: 'save', source: editor.value });
		} else if (selected) {
			post({ action: 'saveBlock', id: selected, source: editor.value });
		}
	});
	$('g-validate').addEventListener('click', () => {
		if (isWhole) {
			post({ action: 'validate', source: editor.value });
		} else if (selected) {
			post({ action: 'validateBlock', id: selected, source: editor.value });
		}
	});
	$('g-set-default').addEventListener('click', () => selected && post({ action: 'setDefault', id: selected }));
	$('g-new').addEventListener('click', async () => {
		const id = await askId('New graph id', 'graph-2');
		if (id) {
			post({ action: 'add', id });
		}
	});
	$('g-duplicate').addEventListener('click', async () => {
		if (!selected) {
			return;
		}
		const id = await askId('New graph id', selected + '-2');
		if (id) {
			post({ action: 'duplicate', id: selected, newId: id });
		}
	});
	$('g-delete').addEventListener('click', () => {
		if (selected && graphs().length > 1 && window.confirm(`Remove graph ${selected}?`)) {
			post({ action: 'remove', id: selected });
		}
	});
	$('g-reset').addEventListener('click', () => {
		if (window.confirm('Use the shipped graph source? Your edits to this source are replaced.')) {
			post({ action: 'reset' });
		}
	});
	whole.addEventListener('change', () => {
		if (dirty && !window.confirm('Discard the unsaved changes to switch views?')) {
			whole.checked = isWhole;
			return;
		}
		isWhole = whole.checked;
		dirty = false;
		validated = null;
		renderMain();
	});

	/* ------------------------------------------------------------------ pane */

	pane.register('graph', {
		render(next) {
			slice = next || slice;
			render();
		},
		show() {
			drawPreview();
		},
		note(message) {
			if (message.error) {
				setStatus(message.message || 'Error', true);
				if (message.graphs) {
					validated = message;
					renderList();
					renderInspector();
				}
				return;
			}
			if (message.graphs) {
				validated = message;
				renderList();
				renderInspector();
				setStatus(message.message || 'Valid.', false);
				return;
			}
			if (message.message) {
				setStatus(message.message, false);
				// A save/add/remove note means the host source moved; the next state push replaces the
				// draft, so stop protecting it.
				dirty = false;
			}
		},
	});
})();
