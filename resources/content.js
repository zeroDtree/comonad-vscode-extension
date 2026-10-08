// Comonad Content — the SillyTavern pane of the settings panel: the four kinds of content, in
// Comonad's own library and in SillyTavern's file formats. The settings panel owns the webview API
// and forwards this pane its state slice and its notes; the pane posts {type:'content', action}
// messages back and renders into the st-* elements of the ST tab.
window.comonadContentPane = function contentPane(options) {
	'use strict';

	const $ = (id) => document.getElementById(id);
	// The panel owns the webview channel, so every message here is filed under `content` and carries
	// the pane's own verb as `action` — the panel routes those back to us and keeps the rest.
	const post = (message) => {
		const { type, ...rest } = message;
		options.post({ type: 'content', action: type, ...rest });
	};

	let state = null;
	let kind = 'characters';
	let item = null;
	let dirty = false;
	let selection = null;

	const esc = (value) =>
		String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

	const status = (text, isError) => {
		const node = $('st-status');
		node.textContent = text || '';
		node.className = isError ? 'error' : '';
	};
	const markDirty = () => {
		dirty = true;
		$('st-save').classList.add('is-dirty');
	};
	const clearDirty = () => {
		dirty = false;
		$('st-save').classList.remove('is-dirty');
	};

	/* ------------------------------------------------------------------ option sets */

	const POSITIONS = [
		[0, 'Before character'],
		[1, 'After character'],
		[2, "Author's note top"],
		[3, "Author's note bottom"],
		[4, 'In chat at depth'],
		[5, 'Example block top'],
		[6, 'Example block bottom'],
		[7, 'Outlet (never injected)'],
	];
	const ROLES = [
		[0, 'System'],
		[1, 'User'],
		[2, 'Assistant'],
	];
	const LOGICS = [
		[0, 'AND any'],
		[1, 'NOT all'],
		[2, 'NOT any'],
		[3, 'AND all'],
	];
	const TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];
	const PERSONA_POSITIONS = [
		[0, 'In prompt'],
		[1, 'After character (deprecated)'],
		[2, "Author's note top"],
		[3, "Author's note bottom"],
		[4, 'In chat at depth'],
	];
	const NAMES_BEHAVIOR = [
		[0, 'Never'],
		[1, 'Default'],
		[2, 'Always'],
	];
	const CARD_ROLES = ['system', 'user', 'assistant'];

	/* ------------------------------------------------------------------ field specs */

	// A field is `{key, label, type, hint}`; the renderer in `fieldEl` knows every type, so adding a
	// setting is one line here. `group` nests fields under a heading.
	const SPEC = {
		characters: [
			{
				group: 'Identity',
				fields: [
					{ key: 'name', label: 'Name', type: 'text' },
					{ key: 'creator', label: 'Creator', type: 'text' },
					{ key: 'version', label: 'Version', type: 'text' },
					{ key: 'tags', label: 'Tags', type: 'lines', hint: 'One per line.' },
				],
			},
			{
				group: 'The card',
				fields: [
					{ key: 'description', label: 'Description', type: 'textarea', rows: 6 },
					{ key: 'personality', label: 'Personality', type: 'textarea', rows: 3 },
					{ key: 'scenario', label: 'Scenario', type: 'textarea', rows: 3 },
					{ key: 'greeting', label: 'First message', type: 'textarea', rows: 4, hint: 'Inserted as the chat’s opening turn.' },
					{ key: 'alternateGreetings', label: 'Alternate greetings', type: 'list', hint: 'Offered when a chat opens with this card.' },
					{ key: 'examples', label: 'Example messages', type: 'textarea', rows: 5, hint: 'Split on <START>, the way SillyTavern does.' },
				],
			},
			{
				group: 'Prompts',
				fields: [
					{ key: 'systemPrompt', label: 'System prompt', type: 'textarea', rows: 4, hint: 'Replaces the main prompt for this card.' },
					{ key: 'postHistoryInstructions', label: 'Post-history instructions', type: 'textarea', rows: 3 },
					{ key: 'creatorNotes', label: 'Creator notes', type: 'textarea', rows: 3, hint: 'Available to the model as {{creatorNotes}}.' },
				],
			},
			{ group: 'Depth prompt', fields: [{ key: 'depthPrompt', label: 'Depth prompt', type: 'depthPrompt' }] },
			{
				group: 'World',
				fields: [
					{ key: 'world', label: 'Bound world book', type: 'select', from: 'lorebooks', empty: 'None' },
					{ key: 'book', label: 'Embedded book', type: 'note' },
				],
			},
			{ group: 'Regex scripts', fields: [{ key: 'regex', label: 'Scripts', type: 'json', hint: 'The same shape the settings use: findRegex, replaceString, placement.' }] },
		],
		personas: [
			{ group: 'Persona', fields: [
				{ key: 'name', label: 'Name', type: 'text', hint: 'What {{user}} expands to.' },
				{ key: 'title', label: 'Title', type: 'text', hint: 'How the picker shows it.' },
				{ key: 'description', label: 'Description', type: 'textarea', rows: 6 },
			] },
			{ group: 'Injection', fields: [
				{ key: 'position', label: 'Where', type: 'select', options: PERSONA_POSITIONS },
				{ key: 'depth', label: 'Depth', type: 'number', hint: 'Messages from the end, for “in chat”.' },
				{ key: 'role', label: 'Role', type: 'select', options: ROLES },
			] },
			{ group: 'Binding', fields: [
				{ key: 'lorebook', label: 'World book', type: 'select', from: 'lorebooks', empty: 'None', hint: 'Scanned alongside this persona.' },
				{ key: 'connections', label: 'Bound to characters', type: 'lines', hint: 'Card names or ids. A chat speaking as one of them uses this persona automatically.' },
			] },
		],
		presets: [
			{ group: 'Samplers', fields: [
				{ key: 'temperature', label: 'Temperature', type: 'numberOrNull' },
				{ key: 'top_p', label: 'Top P', type: 'numberOrNull' },
				{ key: 'top_k', label: 'Top K', type: 'numberOrNull' },
				{ key: 'top_a', label: 'Top A', type: 'numberOrNull' },
				{ key: 'min_p', label: 'Min P', type: 'numberOrNull' },
				{ key: 'frequency_penalty', label: 'Frequency penalty', type: 'numberOrNull' },
				{ key: 'presence_penalty', label: 'Presence penalty', type: 'numberOrNull' },
				{ key: 'repetition_penalty', label: 'Repetition penalty', type: 'numberOrNull' },
				{ key: 'maxContext', label: 'Context size', type: 'numberOrNull', hint: 'Used for the world-info budget.' },
				{ key: 'maxTokens', label: 'Reply length', type: 'numberOrNull' },
			] },
			{ group: 'Formats', fields: [
				{ key: 'wi_format', label: 'World-info format', type: 'text', hint: '{0} is the entry text.' },
				{ key: 'scenario_format', label: 'Scenario format', type: 'text' },
				{ key: 'personality_format', label: 'Personality format', type: 'text' },
				{ key: 'impersonation_prompt', label: 'Impersonation prompt', type: 'textarea', rows: 2 },
				{ key: 'names_behavior', label: 'Name prefixes', type: 'select', options: NAMES_BEHAVIOR },
				{ key: 'assistant_prefill', label: 'Assistant prefill', type: 'textarea', rows: 2 },
				{ key: 'squash_system_messages', label: 'Squash system messages', type: 'checkbox' },
			] },
		],
	};

	/* ------------------------------------------------------------------ form rendering */

	function labelEl(text) {
		const label = document.createElement('label');
		label.textContent = text;
		return label;
	}

	function hintEl(text) {
		const hint = document.createElement('p');
		hint.className = 'hint';
		hint.textContent = text;
		return hint;
	}

	function catalogOptions(from) {
		const list = (state.catalog && state.catalog[from]) || [];
		return list.map((entry) => [entry.id, entry.name]);
	}

	function fieldEl(spec) {
		const wrap = document.createElement('div');
		wrap.className = 'field' + (spec.type === 'textarea' || spec.type === 'json' || spec.type === 'list' ? ' wide' : '');
		const value = item[spec.key];
		const control = (node) => {
			node.addEventListener('input', markDirty);
			node.addEventListener('change', markDirty);
			return node;
		};
		switch (spec.type) {
			case 'textarea': {
				wrap.append(labelEl(spec.label));
				const area = document.createElement('textarea');
				area.className = 'control';
				area.rows = spec.rows || 3;
				area.spellcheck = false;
				area.value = String(value ?? '');
				control(area).addEventListener('input', () => {
					item[spec.key] = area.value;
				});
				wrap.append(area);
				break;
			}
			case 'json': {
				wrap.append(labelEl(spec.label));
				const area = document.createElement('textarea');
				area.className = 'control mono';
				area.rows = 5;
				area.spellcheck = false;
				area.value = JSON.stringify(value ?? [], null, 2);
				control(area).addEventListener('input', () => {
					area.classList.toggle('bad', !validJson(area.value));
					item[spec.key] = validJson(area.value) ? JSON.parse(area.value) : [];
				});
				wrap.append(area);
				break;
			}
			case 'list': {
				wrap.append(labelEl(spec.label));
				const list = Array.isArray(item[spec.key]) ? item[spec.key] : (item[spec.key] = []);
				const rows = document.createElement('div');
				rows.className = 'list-rows';
				list.forEach((entry, index) => {
					const row = document.createElement('div');
					row.className = 'list-row';
					const area = document.createElement('textarea');
					area.className = 'control';
					area.rows = 2;
					area.spellcheck = false;
					area.value = String(entry);
					control(area).addEventListener('input', () => {
						list[index] = area.value;
					});
					const remove = document.createElement('button');
					remove.type = 'button';
					remove.className = 'link';
					remove.textContent = '✕';
					remove.title = 'Remove';
					remove.addEventListener('click', () => {
						list.splice(index, 1);
						markDirty();
						render();
					});
					row.append(area, remove);
					rows.append(row);
				});
				const add = document.createElement('button');
				add.type = 'button';
				add.className = 'secondary';
				add.textContent = 'Add';
				add.addEventListener('click', () => {
					list.push('');
					markDirty();
					render();
				});
				wrap.append(rows, add);
				break;
			}
			case 'lines': {
				wrap.append(labelEl(spec.label));
				const area = document.createElement('textarea');
				area.className = 'control';
				area.rows = Math.min(6, Math.max(2, (value || []).length + 1));
				area.spellcheck = false;
				area.value = (value || []).join('\n');
				control(area).addEventListener('input', () => {
					item[spec.key] = area.value.split('\n').map((line) => line.trim()).filter(Boolean);
				});
				wrap.append(area);
				break;
			}
			case 'number':
			case 'numberOrNull': {
				wrap.append(labelEl(spec.label));
				const input = document.createElement('input');
				input.className = 'control';
				input.type = 'number';
				input.value = value === null || value === undefined ? '' : String(value);
				control(input).addEventListener('input', () => {
					const empty = input.value.trim() === '';
					item[spec.key] = empty && spec.type === 'numberOrNull' ? null : Number(input.value) || 0;
				});
				wrap.append(input);
				break;
			}
			case 'checkbox': {
				const line = document.createElement('label');
				line.className = 'check';
				const input = document.createElement('input');
				input.type = 'checkbox';
				input.checked = value === true;
				control(input).addEventListener('change', () => {
					item[spec.key] = input.checked;
				});
				line.append(input, document.createTextNode(' ' + spec.label));
				wrap.append(line);
				break;
			}
			case 'select': {
				wrap.append(labelEl(spec.label));
				const select = document.createElement('select');
				select.className = 'control';
				const options = spec.options || [['', spec.empty || '—']].concat(catalogOptions(spec.from));
				if (spec.from) {
					options.unshift(['', spec.empty || 'None']);
				}
				for (const [optionValue, text] of options) {
					const option = document.createElement('option');
					option.value = String(optionValue);
					option.textContent = text;
					option.selected = String(value ?? '') === String(optionValue);
					select.append(option);
				}
				if (!spec.from && value !== undefined && !options.some(([optionValue]) => String(optionValue) === String(value))) {
					const option = document.createElement('option');
					option.value = String(value);
					option.textContent = String(value);
					select.append(option);
				}
				control(select).addEventListener('change', () => {
					item[spec.key] = spec.from ? select.value : Number(select.value);
				});
				wrap.append(select);
				break;
			}
			case 'depthPrompt': {
				const line = document.createElement('label');
				line.className = 'check';
				const toggle = document.createElement('input');
				toggle.type = 'checkbox';
				toggle.checked = Boolean(item.depthPrompt);
				toggle.addEventListener('change', () => {
					item.depthPrompt = toggle.checked ? { prompt: '', depth: 4, role: 'system' } : null;
					markDirty();
					render();
				});
				line.append(toggle, document.createTextNode(' Inject a depth prompt in chat'));
				wrap.append(line);
				if (item.depthPrompt) {
					const nested = document.createElement('div');
					nested.className = 'grid';
					nested.append(
						fieldEl({ key: 'depthPrompt', label: 'Prompt', type: 'nestedText' }),
						fieldEl({ key: 'depthPrompt', label: 'Depth', type: 'nestedNumber' }),
						fieldEl({ key: 'depthPrompt', label: 'Role', type: 'nestedSelect' }),
					);
					wrap.append(nested);
				}
				break;
			}
			case 'nestedText': {
				wrap.append(labelEl(spec.label));
				const area = document.createElement('textarea');
				area.className = 'control';
				area.rows = 3;
				area.spellcheck = false;
				area.value = item.depthPrompt.prompt || '';
				control(area).addEventListener('input', () => {
					item.depthPrompt.prompt = area.value;
				});
				wrap.append(area);
				break;
			}
			case 'nestedNumber': {
				wrap.append(labelEl(spec.label));
				const input = document.createElement('input');
				input.className = 'control';
				input.type = 'number';
				input.value = String(item.depthPrompt.depth ?? 4);
				control(input).addEventListener('input', () => {
					item.depthPrompt.depth = Number(input.value) || 0;
				});
				wrap.append(input);
				break;
			}
			case 'nestedSelect': {
				wrap.append(labelEl(spec.label));
				const select = document.createElement('select');
				select.className = 'control';
				for (const role of CARD_ROLES) {
					const option = document.createElement('option');
					option.value = role;
					option.textContent = role;
					option.selected = item.depthPrompt.role === role;
					select.append(option);
				}
				control(select).addEventListener('change', () => {
					item.depthPrompt.role = select.value;
				});
				wrap.append(select);
				break;
			}
			case 'note': {
				wrap.append(labelEl(spec.label));
				const note = document.createElement('p');
				note.className = 'hint';
				const entries = item.book && Array.isArray(item.book.entries) ? item.book.entries.length : 0;
				note.textContent = entries
					? `${entries} entries inside the card file — kept as they are, and scanned with this character.`
					: 'No book inside the card. Bind a library world book above, or use a card that carries one.';
				wrap.append(note);
				break;
			}
			default: {
				wrap.append(labelEl(spec.label));
				const input = document.createElement('input');
				input.className = 'control';
				input.type = 'text';
				input.spellcheck = false;
				input.value = String(value ?? '');
				control(input).addEventListener('input', () => {
					item[spec.key] = input.value;
				});
				wrap.append(input);
			}
		}
		if (spec.hint) {
			wrap.append(hintEl(spec.hint));
		}
		return wrap;
	}

	function validJson(text) {
		try {
			JSON.parse(text);
			return true;
		} catch {
			return false;
		}
	}

	function sectionEl(title, children) {
		const section = document.createElement('section');
		const heading = document.createElement('h2');
		heading.textContent = title;
		const grid = document.createElement('div');
		grid.className = 'grid';
		grid.append(...children);
		section.append(heading, grid);
		return section;
	}

	function renderSpec() {
		const host = $('st-form');
		host.innerHTML = '';
		for (const block of SPEC[kind] || []) {
			host.append(sectionEl(block.group, block.fields.map(fieldEl)));
		}
	}

	/* ------------------------------------------------------------------ world books */

	let entryUid = null;

	function entryTitle(entry) {
		return (entry.comment || '').trim() || (entry.key || []).join(', ') || `entry ${entry.uid}`;
	}

	function renderBook() {
		const host = $('st-form');
		host.innerHTML = '';
		host.append(fieldEl({ key: 'name', label: 'Book name', type: 'text' }));
		const entries = item.entries || {};
		const keys = Object.keys(entries);
		if (entryUid === null || !entries[entryUid]) {
			entryUid = keys[0] ?? null;
		}

		const listSection = document.createElement('section');
		const head = document.createElement('h2');
		head.textContent = `Entries (${keys.length})`;
		const row = document.createElement('div');
		row.className = 'row';
		const add = document.createElement('button');
		add.type = 'button';
		add.className = 'secondary';
		add.textContent = 'Add entry';
		add.addEventListener('click', () => {
			const uid = Object.values(entries).reduce((max, entry) => Math.max(max, Number(entry.uid) + 1), 0);
			entries[String(uid)] = {
				uid,
				key: [],
				keysecondary: [],
				comment: '',
				content: '',
				constant: false,
				selective: true,
				selectiveLogic: 0,
				order: 100,
				position: 0,
				disable: false,
				probability: 100,
				useProbability: true,
				depth: 4,
			};
			item.entries = entries;
			entryUid = String(uid);
			markDirty();
			render();
		});
		row.append(add);
		listSection.append(head, row);

		const table = document.createElement('div');
		table.className = 'entries';
		for (const key of keys) {
			const entry = entries[key];
			const line = document.createElement('button');
			line.type = 'button';
			line.className = 'entry';
			line.classList.toggle('is-on', key === entryUid);
			line.innerHTML =
				'<span class="entry-title">' +
				esc(entryTitle(entry)) +
				'</span><span class="entry-keys">' +
				esc((entry.key || []).slice(0, 3).join(', ')) +
				'</span>';
			if (entry.disable) {
				line.classList.add('is-off');
			}
			line.addEventListener('click', () => {
				entryUid = key;
				render();
			});
			table.append(line);
		}
		listSection.append(table);
		host.append(listSection);

		const entry = entryUid ? entries[entryUid] : null;
		if (!entry) {
			host.append(hintEl('No entries yet — add one to give the book something to scan.'));
			return;
		}
		host.append(
			sectionEl('Entry', [
				fieldEl({ key: 'comment', label: 'Title', type: 'text', hint: 'Shown in the activated-lore readout.' }),
				fieldEl({ key: 'disable', label: 'Disabled', type: 'checkbox' }),
			]),
		);
		const entryFields = (spec) => entryFieldEl(entry, entryUid, spec);
		const groups = [
			{
				group: 'Content',
				fields: [
					{ key: 'key', label: 'Keys', type: 'lines', hint: 'One per line. A key may be a /regex/ with flags.' },
					{ key: 'keysecondary', label: 'Secondary keys', type: 'lines' },
					{ key: 'selectiveLogic', label: 'Secondary logic', type: 'select', options: LOGICS },
					{ key: 'selective', label: 'Require a secondary key', type: 'checkbox' },
					{ key: 'content', label: 'Content', type: 'textarea', rows: 6 },
				],
			},
			{
				group: 'Activation',
				fields: [
					{ key: 'constant', label: 'Always active', type: 'checkbox' },
					{ key: 'probability', label: 'Probability %', type: 'number' },
					{ key: 'useProbability', label: 'Use probability', type: 'checkbox' },
					{ key: 'scanDepth', label: 'Scan depth override', type: 'numberOrNull' },
					{ key: 'caseSensitive', label: 'Case sensitive', type: 'trinary' },
					{ key: 'matchWholeWords', label: 'Whole words only', type: 'trinary' },
					{ key: 'matchCharacterDescription', label: 'Match card description', type: 'checkbox' },
					{ key: 'matchCharacterPersonality', label: 'Match card personality', type: 'checkbox' },
					{ key: 'matchCharacterDepthPrompt', label: 'Match depth prompt', type: 'checkbox' },
					{ key: 'matchScenario', label: 'Match scenario', type: 'checkbox' },
					{ key: 'matchPersonaDescription', label: 'Match persona', type: 'checkbox' },
					{ key: 'matchCreatorNotes', label: 'Match creator notes', type: 'checkbox' },
				],
			},
			{
				group: 'Insertion',
				fields: [
					{ key: 'position', label: 'Where', type: 'select', options: POSITIONS },
					{ key: 'depth', label: 'Depth', type: 'number' },
					{ key: 'role', label: 'Role', type: 'select', options: ROLES },
					{ key: 'order', label: 'Order', type: 'number', hint: 'Higher goes first.' },
					{ key: 'outletName', label: 'Outlet name', type: 'text' },
					{ key: 'ignoreBudget', label: 'Ignore the token budget', type: 'checkbox' },
				],
			},
			{
				group: 'Timing',
				fields: [
					{ key: 'sticky', label: 'Sticky turns', type: 'numberOrNull' },
					{ key: 'cooldown', label: 'Cooldown turns', type: 'numberOrNull' },
					{ key: 'delay', label: 'Delay turns', type: 'numberOrNull' },
				],
			},
			{
				group: 'Grouping',
				fields: [
					{ key: 'group', label: 'Group', type: 'text' },
					{ key: 'groupWeight', label: 'Weight', type: 'number' },
					{ key: 'groupOverride', label: 'Override the group', type: 'checkbox' },
					{ key: 'useGroupScoring', label: 'Score the group together', type: 'trinary' },
				],
			},
			{
				group: 'Recursion',
				fields: [
					{ key: 'excludeRecursion', label: 'Skip in recursive scans', type: 'checkbox' },
					{ key: 'preventRecursion', label: 'Do not trigger recursion', type: 'checkbox' },
					{ key: 'delayUntilRecursion', label: 'From recursion level', type: 'number' },
					{ key: 'vectorized', label: 'Vectorized (reserved)', type: 'checkbox' },
					{ key: 'automationId', label: 'Automation id', type: 'text' },
					{ key: 'triggers', label: 'Generation triggers', type: 'lines', hint: 'Empty means every generation: ' + TRIGGERS.join(', ') },
				],
			},
			{
				group: 'Character filter',
				fields: [
					{ key: 'characterFilter', label: 'Names', type: 'filterNames' },
					{ key: 'characterFilter', label: 'Tags', type: 'filterTags' },
					{ key: 'characterFilter', label: 'Exclude', type: 'filterExclude' },
				],
			},
		];
		for (const block of groups) {
			host.append(sectionEl(block.group, block.fields.map(entryFields)));
		}
	}

	/** The entry form's fields read and write one entry of the selected world book. */
	function entryFieldEl(entry, uid, spec) {
		const wrap = document.createElement('div');
		wrap.className = 'field' + (['textarea', 'lines'].includes(spec.type) ? ' wide' : '');
		const set = (value) => {
			if (spec.key === 'characterFilter') {
				entry.characterFilter = { ...(entry.characterFilter || {}), ...value };
			} else {
				entry[spec.key] = value;
			}
			item.entries[uid] = entry;
		};
		const control = (node) => {
			node.addEventListener('input', markDirty);
			node.addEventListener('change', markDirty);
			return node;
		};
		switch (spec.type) {
			case 'lines': {
				wrap.append(labelEl(spec.label));
				const area = document.createElement('textarea');
				area.className = 'control';
				area.rows = 3;
				area.spellcheck = false;
				area.value = (entry[spec.key] || []).join('\n');
				control(area).addEventListener('input', () => {
					set(area.value.split('\n').map((line) => line.trim()).filter(Boolean));
				});
				wrap.append(area);
				break;
			}
			case 'trinary': {
				wrap.append(labelEl(spec.label));
				const select = document.createElement('select');
				select.className = 'control';
				for (const [value, text] of [['inherit', 'Use the global setting'], ['true', 'On'], ['false', 'Off']]) {
					const option = document.createElement('option');
					option.value = value;
					option.textContent = text;
					option.selected = value === 'inherit' ? entry[spec.key] === null || entry[spec.key] === undefined : String(entry[spec.key]) === value;
					select.append(option);
				}
				control(select).addEventListener('change', () => {
					set(select.value === 'inherit' ? null : select.value === 'true');
				});
				wrap.append(select);
				break;
			}
			case 'filterNames':
			case 'filterTags': {
				wrap.append(labelEl(spec.label));
				const field = spec.type === 'filterNames' ? 'names' : 'tags';
				const area = document.createElement('textarea');
				area.className = 'control';
				area.rows = 2;
				area.spellcheck = false;
				area.value = ((entry.characterFilter || {})[field] || []).join('\n');
				control(area).addEventListener('input', () => {
					set({ [field]: area.value.split('\n').map((line) => line.trim()).filter(Boolean) });
				});
				wrap.append(area);
				break;
			}
			case 'filterExclude': {
				const line = document.createElement('label');
				line.className = 'check';
				const input = document.createElement('input');
				input.type = 'checkbox';
				input.checked = Boolean((entry.characterFilter || {}).isExclude);
				control(input).addEventListener('change', () => set({ isExclude: input.checked }));
				line.append(input, document.createTextNode(' ' + spec.label));
				wrap.append(line);
				break;
			}
			case 'select': {
				wrap.append(labelEl(spec.label));
				const select = document.createElement('select');
				select.className = 'control';
				for (const [value, text] of spec.options) {
					const option = document.createElement('option');
					option.value = String(value);
					option.textContent = text;
					option.selected = Number(entry[spec.key]) === Number(value);
					select.append(option);
				}
				control(select).addEventListener('change', () => set(Number(select.value)));
				wrap.append(select);
				break;
			}
			case 'checkbox': {
				const line = document.createElement('label');
				line.className = 'check';
				const input = document.createElement('input');
				input.type = 'checkbox';
				input.checked = entry[spec.key] === true;
				control(input).addEventListener('change', () => set(input.checked));
				line.append(input, document.createTextNode(' ' + spec.label));
				wrap.append(line);
				break;
			}
			case 'number':
			case 'numberOrNull': {
				wrap.append(labelEl(spec.label));
				const input = document.createElement('input');
				input.className = 'control';
				input.type = 'number';
				input.value = entry[spec.key] === null || entry[spec.key] === undefined ? '' : String(entry[spec.key]);
				control(input).addEventListener('input', () => {
					const empty = input.value.trim() === '';
					set(empty && spec.type === 'numberOrNull' ? null : Number(input.value) || 0);
				});
				wrap.append(input);
				break;
			}
			default: {
				wrap.append(labelEl(spec.label));
				const input = document.createElement('input');
				input.className = 'control';
				input.type = 'text';
				input.spellcheck = false;
				input.value = String(entry[spec.key] ?? '');
				control(input).addEventListener('input', () => {
					set(input.value);
				});
				wrap.append(input);
			}
		}
		if (spec.hint) {
			wrap.append(hintEl(spec.hint));
		}
		return wrap;
	}

	/* ------------------------------------------------------------------ prompt table */

	function renderPrompts() {
		const host = $('st-form');
		host.innerHTML = '';
		host.append(sectionEl('Prompts', [fieldEl({ key: 'name', label: 'Preset name', type: 'text' })]));
		const prompts = Array.isArray(item.prompts) ? item.prompts : (item.prompts = []);
		const section = document.createElement('section');
		const heading = document.createElement('h2');
		heading.textContent = `Collection (${prompts.length})`;
		const hint = hintEl('Order is the order the model reads. “In chat” injects the block into the conversation at a depth.');
		const table = document.createElement('table');
		const head = document.createElement('tr');
		for (const title of ['On', 'Prompt', 'Role', 'Where', 'Depth', 'Order', '']) {
			const th = document.createElement('th');
			th.textContent = title;
			head.append(th);
		}
		table.append(head);
		const move = (index, delta) => {
			const target = index + delta;
			if (target < 1 || target >= prompts.length) {
				return;
			}
			const moved = prompts.splice(index, 1)[0];
			prompts.splice(target, 0, moved);
			markDirty();
			render();
		};
		prompts.forEach((prompt, index) => {
			const tr = document.createElement('tr');
			const identity = prompt.identifier === 'comonad';
			if (identity) {
				tr.classList.add('is-fixed');
			}
			const cell = (node) => {
				const td = document.createElement('td');
				if (node) {
					td.append(node);
				}
				return td;
			};
			const on = document.createElement('input');
			on.type = 'checkbox';
			on.checked = prompt.enabled !== false;
			on.disabled = identity;
			on.addEventListener('change', () => {
				prompt.enabled = on.checked;
				markDirty();
			});
			tr.append(cell(on));
			const label = document.createElement('td');
			label.textContent = prompt.name || prompt.identifier;
			tr.append(label);
			const role = document.createElement('select');
			role.className = 'control';
			role.disabled = identity;
			for (const value of CARD_ROLES) {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = value;
				option.selected = (prompt.role || 'system') === value;
				role.append(option);
			}
			role.addEventListener('change', () => {
				prompt.role = role.value;
				markDirty();
			});
			tr.append(cell(role));
			const where = document.createElement('select');
			where.className = 'control';
			where.disabled = identity;
			for (const [value, text] of [['relative', 'In list'], ['absolute', 'In chat']]) {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = text;
				option.selected = Number(prompt.injection_position) === (value === 'absolute' ? 1 : 0);
				where.append(option);
			}
			where.addEventListener('change', () => {
				prompt.injection_position = where.value === 'absolute' ? 1 : 0;
				markDirty();
				render();
			});
			tr.append(cell(where));
			const numeric = (key, fallback) => {
				const input = document.createElement('input');
				input.type = 'number';
				input.className = 'control';
				input.disabled = identity || Number(prompt.injection_position) !== 1;
				input.value = String(prompt[key] ?? fallback);
				input.addEventListener('input', () => {
					prompt[key] = Number(input.value) || 0;
					markDirty();
				});
				return input;
			};
			tr.append(cell(numeric('injection_depth', 4)), cell(numeric('injection_order', 100)));
			const buttons = document.createElement('td');
			buttons.className = 'prompt-move';
			for (const [delta, glyph, tip] of [[-1, '↑', 'Move up'], [1, '↓', 'Move down']]) {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'link';
				button.textContent = glyph;
				button.title = tip;
				button.disabled = identity;
				button.addEventListener('click', () => move(index, delta));
				buttons.append(button);
			}
			tr.append(buttons);
			table.append(tr);
		});
		section.append(heading, hint, table);
		host.append(section);
	}

	/* ------------------------------------------------------------------ the page */

	/** The kind sub-tabs live in the panel's markup; the pane labels them and marks the current one. */
	function renderKinds() {
		for (const button of document.querySelectorAll('.subtab[data-st]')) {
			const value = button.dataset.st;
			if (!(state.kindLabels && state.kindLabels[value])) {
				continue;
			}
			button.textContent = state.kindLabels[value] + ' (' + ((state.counts && state.counts[value]) || 0) + ')';
			button.classList.toggle('is-on', value === kind);
		}
	}

	function renderList() {
		const host = $('st-items');
		host.innerHTML = '';
		for (const entry of state.items || []) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'item';
			row.dataset.id = entry.id;
			row.classList.toggle('is-on', entry.id === selection);
			row.innerHTML =
				'<span class="item-name">' +
				esc(entry.name) +
				'</span><span class="item-detail">' +
				esc(entry.detail) +
				'</span>';
			const adopted = ((state.adopted && state.adopted[kind]) || []).includes(entry.id);
			if (adopted) {
				row.classList.add('is-adopted');
				row.title = 'Used by this chat';
			}
			row.addEventListener('click', () => {
				if (dirty && !window.confirm('Discard the unsaved changes to this item?')) {
					return;
				}
				clearDirty();
				post({ type: 'select', kind, id: entry.id });
			});
			host.append(row);
		}
		if (!(state.items || []).length) {
			host.append(hintEl('Nothing here yet. Use New, or drop files into the library folder.'));
		}
		$('st-library').textContent = 'Library: ' + (state.library || '') + ' — SillyTavern-compatible files; a card may also be a PNG.';
	}

	function renderActions() {
		const host = $('st-form');
		const bar = document.createElement('div');
		bar.className = 'actions';
		const adopted = ((state.adopted && state.adopted[kind]) || []).includes(selection);
		const use = document.createElement('button');
		use.type = 'button';
		use.className = 'secondary';
		use.textContent = adopted ? 'Remove from this chat' : 'Use in this chat';
		use.disabled = Boolean(item && !item.source && !adopted);
		use.addEventListener('click', () => post({ type: 'adopt', kind, id: selection, on: !adopted }));
		bar.append(use);
		if (kind !== 'lorebooks') {
			const makeDefault = document.createElement('button');
			makeDefault.type = 'button';
			makeDefault.className = 'secondary';
			makeDefault.textContent = 'Make default';
			makeDefault.addEventListener('click', () => post({ type: 'adopt', kind, id: selection, asDefault: true, on: true }));
			const clearDefault = document.createElement('button');
			clearDefault.type = 'button';
			clearDefault.className = 'secondary';
			clearDefault.textContent = 'Clear default';
			clearDefault.addEventListener('click', () => post({ type: 'adopt', kind, id: selection, asDefault: true, on: false }));
			bar.append(makeDefault, clearDefault);
		}
		if (kind === 'characters') {
			const png = document.createElement('button');
			png.type = 'button';
			png.className = 'secondary';
			png.textContent = 'Export PNG…';
			png.title = 'Write a shareable card: SillyTavern reads the same PNG.';
			png.addEventListener('click', () => post({ type: 'exportPng', kind, id: selection }));
			bar.append(png);
		}
		host.prepend(bar);
	}

	function render() {
		if (!state || !item) {
			$('st-form').innerHTML = '<p class="hint">Pick something on the left, or start a new item.</p>';
			renderActions();
			renderList();
			return;
		}
		if (kind === 'lorebooks') {
			renderBook();
		} else if (kind === 'presets') {
			renderPrompts();
			const extra = document.createElement('div');
			extra.className = 'extra';
			for (const block of SPEC.presets) {
				extra.append(sectionEl(block.group, block.fields.map(fieldEl)));
			}
			$('st-form').append(extra);
		} else {
			renderSpec();
		}
		renderActions();
		renderList();
	}

	/* ------------------------------------------------------------------ wiring */

	for (const id of ['st-new', 'st-duplicate', 'st-delete', 'st-save', 'st-reveal']) {
		$(id).addEventListener('click', () => {
			switch (id) {
				case 'st-new':
					post({ type: 'new', kind });
					break;
				case 'st-duplicate':
					post({ type: 'duplicate', kind });
					break;
				case 'st-delete':
					if (selection && window.confirm(`Delete ${selection} from Comonad’s library? The file is removed from disk.`)) {
						post({ type: 'delete', kind, id: selection });
					}
					break;
				case 'st-save':
					post({ type: 'save', kind, item });
					break;
				case 'st-reveal':
					post({ type: 'reveal', kind });
					break;
			}
		});
	}

	return {
		// The host state slice, pushed with every settings state.
		render(content) {
			state = content;
			kind = content.kind;
			item = content.item;
			selection = item && item.id ? item.id : kind === 'lorebooks' && item ? item.name : null;
			entryUid = null;
			renderKinds();
			render();
			if (!dirty) {
				clearDirty();
			}
		},
		// A note about the last action: a save, a delete, or why it failed.
		note(message) {
			status(message.message, message.error === true);
			if (message.error !== true) {
				clearDirty();
			}
		},
		// Said out loud when the panel pushes a state this pane cannot use, rather than going blank.
		notice(text) {
			status(text, true);
		},
		// The panel's sub-tabs run through here, so unsaved edits are not dropped by accident.
		select(next) {
			if (next === kind) {
				return true;
			}
			if (dirty && !window.confirm('Discard the unsaved changes to ' + selection + '?')) {
				return false;
			}
			clearDirty();
			post({ type: 'select', kind: next, id: '' });
			return true;
		},
	};
};
