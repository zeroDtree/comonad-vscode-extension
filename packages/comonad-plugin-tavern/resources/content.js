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

	// The world-book page is its own module: it is large enough to live apart, and it owns the open
	// book while it is showing. It posts through this same channel and gets the same state slice.
	const bookPane = window.comonadWorldInfo ? window.comonadWorldInfo({ post, store: options.store }) : null;
	// The persona page is a module of its own too: it saves as it is edited, and it owns the tile list
	// and the connection editor while the `personas` kind is showing.
	const personaPane = window.comonadPersonas ? window.comonadPersonas({ post, store: options.store }) : null;

	let state = null;
	let kind = 'characters';
	let item = null;
	let dirty = false;
	let selection = null;
	// The small per-document preference bag the settings panel owns and the content guests share.
	const store = options.store || { get: () => ({}), set: () => {} };

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

	const ROLES = [
		[0, 'System'],
		[1, 'User'],
		[2, 'Assistant'],
	];
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
					{ key: 'picture', label: 'Picture', type: 'picture' },
					{ key: 'name', label: 'Name', type: 'text' },
					{ key: 'creator', label: 'Creator', type: 'text' },
					{ key: 'version', label: 'Version', type: 'text' },
					{ key: 'tags', label: 'Tags', type: 'lines', hint: 'One per line.' },
					{ key: 'favourite', label: 'Favourite ★', type: 'checkbox', hint: 'Upstream’s `fav`: its character list can show only these.' },
					{
						key: 'talkativeness',
						label: 'Talkativeness',
						type: 'range',
						min: 0,
						max: 1,
						step: 0.05,
						hint: 'How much this character speaks in a group chat. SillyTavern starts a card at 0.5.',
					},
					{ key: 'sourceLink', label: 'Source link', type: 'text', hint: 'Where the card came from: upstream’s *Link to Source* opens it.' },
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
			// What upstream sends when there is otherwise nothing to send. They are set in a request like
			// anything else, so a preset that has them reads the same in either tool.
			{ group: 'Nudges', fields: [
				{ key: 'new_chat_prompt', label: 'New chat', type: 'text', hint: 'Set at the head of the chat history to mark a new chat.' },
				{ key: 'new_group_chat_prompt', label: 'New group chat', type: 'text' },
				{ key: 'new_example_chat_prompt', label: 'Example chat', type: 'text' },
				{ key: 'continue_nudge_prompt', label: 'Continue nudge', type: 'textarea', rows: 2, hint: '{{lastChatMessage}} is the message being carried on from.' },
				{ key: 'group_nudge_prompt', label: 'Group nudge', type: 'text', hint: 'Comonad has no group chats, so this one is kept rather than sent.' },
				{ key: 'send_if_empty', label: 'Send if empty', type: 'text', hint: 'Said as the user when the history would otherwise end on the reply.' },
			] },
			// The request knobs. The two flags that Comonad cannot act on say so in their hint: they are
			// kept so a preset round-trips, never silently dropped.
			{ group: 'Request', fields: [
				{ key: 'seed', label: 'Seed', type: 'numberOrNull', hint: 'Sent when the endpoint takes one.' },
				{ key: 'logitBiasSelected', label: 'Logit bias set', type: 'text', hint: 'The name of the set below that a request sends.' },
				{ key: 'logitBias', label: 'Logit bias sets', type: 'json', hint: 'Upstream’s own shape: [{ id, name, value: { tokenId: bias } }].' },
				{ key: 'stream', label: 'Stream the reply', type: 'checkbox', hint: 'Kept so a preset round-trips: Comonad always shows tokens as they arrive.' },
				{ key: 'maxContextUnlocked', label: 'Context size unlocked', type: 'checkbox', hint: 'Send the full context size even when the model is thought to be smaller.' },
				{ key: 'useSysprompt', label: 'Use system prompt', type: 'checkbox', hint: 'Kept so a preset round-trips: the OpenAI-compatible path always sends a system message.' },
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
		// Every control gets a stable id, so a rebuild that lands mid-keystroke can put the caret back.
		const control = (node, at) => {
			const nested = spec.type.startsWith('nested') ? spec.key + '-' + spec.type : spec.key;
			node.id = 'stf-' + nested + (at === undefined ? '' : '-' + at);
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
					control(area, index).addEventListener('input', () => {
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
				// A select that offers the catalog gets one empty choice; one that lists its own options
				// gets exactly those.
				const options = spec.from
					? [['', spec.empty || 'None']].concat(catalogOptions(spec.from))
					: (spec.options || []).slice();
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
			case 'range': {
				wrap.append(labelEl(spec.label));
				const row = document.createElement('div');
				row.className = 'range-row';
				const input = document.createElement('input');
				input.type = 'range';
				input.min = String(spec.min ?? 0);
				input.max = String(spec.max ?? 1);
				input.step = String(spec.step ?? 0.05);
				input.value = String(typeof value === 'number' ? value : (spec.min ?? 0));
				const readout = document.createElement('output');
				readout.textContent = Number(input.value).toFixed(2);
				control(input).addEventListener('input', () => {
					item[spec.key] = Number(input.value);
					readout.textContent = Number(input.value).toFixed(2);
				});
				row.append(input, readout);
				wrap.append(row);
				break;
			}
			case 'picture': {
				// Upstream keeps a card and its picture in one file, so the picture shown here *is* the
				// card's own file when it is a PNG, and choosing one writes the card as a PNG.
				wrap.append(labelEl(spec.label));
				const row = document.createElement('div');
				row.className = 'picture-row';
				const shot = document.createElement('div');
				shot.className = 'picture-shot';
				if (item && item.picture) {
					const image = document.createElement('img');
					image.src = String(item.picture);
					image.alt = '';
					shot.append(image);
				} else {
					shot.textContent = 'no picture';
					shot.classList.add('is-empty');
				}
				const pick = document.createElement('button');
				pick.type = 'button';
				pick.className = 'secondary';
				pick.textContent = 'Choose picture…';
				pick.title = 'A PNG becomes the card itself, the way SillyTavern stores one.';
				pick.addEventListener('click', () => post({ type: 'characterAvatar', kind, id: selection, item }));
				row.append(shot, pick);
				wrap.append(row);
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

	/* ------------------------------------------------------------------ tags */

	// The tag registry is SillyTavern's: tags have ids, an entity carries ids, and a world info entry's
	// character filter stores ids too. The pane only draws what the host sends — it posts a verb and
	// the host writes `tags.json`. Nothing here goes through the form's Save button, because a tag
	// belongs to the registry and not to any card.

	let managerOpen = false;

	const tagInfo = () => (state && state.tags) || { list: [], counts: {}, assigned: [], import: 1 };
	const tagById = (id) => tagInfo().list.find((tag) => tag.id === id) || null;

	const chip = (tag, onRemove) => {
		const node = document.createElement('span');
		node.className = 'tag-chip';
		node.textContent = tag.name;
		if (tag.color) {
			node.style.background = tag.color;
		}
		if (tag.color2) {
			node.style.color = tag.color2;
		}
		if (onRemove) {
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'tag-chip-x';
			remove.textContent = '✕';
			remove.title = `Take ${tag.name} off this character`;
			remove.addEventListener('click', () => post({ type: 'tagUnassign', kind, id: selection, tag: tag.id }));
			node.append(remove);
		}
		return node;
	};

	const actionButton = (text, title, onClick, className) => {
		const node = document.createElement('button');
		node.type = 'button';
		node.className = className || 'secondary';
		node.textContent = text;
		if (title) {
			node.title = title;
		}
		node.addEventListener('click', onClick);
		return node;
	};

	function renderTags() {
		const info = tagInfo();
		const section = document.createElement('section');
		section.id = 'st-tags';
		const heading = document.createElement('h2');
		heading.textContent = `Tags (${info.assigned.length})`;
		const row = document.createElement('div');
		row.className = 'tag-row';
		for (const id of info.assigned) {
			const tag = tagById(id);
			if (tag) {
				row.append(chip(tag, true));
			}
		}
		if (!info.assigned.length) {
			row.append(hintEl('No tags yet. A tag is stored in `tags.json` and can be renamed without touching what carries it.'));
		}
		const add = document.createElement('div');
		add.className = 'tag-add';
		const input = document.createElement('input');
		input.id = 'st-tag-add';
		input.className = 'control';
		input.type = 'text';
		input.placeholder = 'Add a tag…';
		input.spellcheck = false;
		// Suggestions are the registry's own names, but a name that is not a tag yet is allowed: that is
		// how upstream's tag input creates one.
		input.setAttribute('list', 'st-tag-names');
		const names = document.createElement('datalist');
		names.id = 'st-tag-names';
		for (const tag of info.list) {
			const option = document.createElement('option');
			option.value = tag.name;
			names.append(option);
		}
		const commit = () => {
			const name = input.value.trim();
			if (!name) {
				return;
			}
			post({ type: 'tagAssign', kind, id: selection, name });
			input.value = '';
		};
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				commit();
			}
		});
		add.append(input, names, actionButton('Add', '', commit));
		const tools = document.createElement('div');
		tools.className = 'tag-tools';
		tools.append(
			actionButton(managerOpen ? 'Hide tag manager' : 'Manage tags…', 'Create, rename, colour, merge and prune tags.', () => {
				managerOpen = !managerOpen;
				render();
			}),
			actionButton(
				'Import card tags',
				info.import === 1 ? 'Ask about the tags this card carries in its own file.' : 'The Tag Import Option setting decides what is imported.',
				() => post({ type: 'tagImport', kind, id: selection }),
			),
		);
		section.append(heading, row, add, tools);
		return section;
	}

	function renderManager() {
		const existing = $('st-tag-manager');
		if (existing) {
			existing.remove();
		}
		if (!managerOpen) {
			return;
		}
		const info = tagInfo();
		const box = document.createElement('div');
		box.id = 'st-tag-manager';
		box.className = 'tag-manager';
		const head = document.createElement('div');
		head.className = 'tag-manager-head';
		const title = document.createElement('h2');
		title.textContent = `Tags (${info.list.length})`;
		head.append(
			title,
			actionButton('Prune unused', 'Delete every tag no character carries.', () => post({ type: 'tagPrune', kind }), 'secondary danger'),
			actionButton('Done', 'Close the tag manager.', () => {
				managerOpen = false;
				render();
			}),
		);
		const list = document.createElement('div');
		list.className = 'tag-manager-list';
		if (!info.list.length) {
			list.append(hintEl('No tags yet. Name one below and it appears here.'));
		}
		for (const tag of info.list) {
			list.append(managerRow(tag, info));
		}
		const create = document.createElement('div');
		create.className = 'tag-manager-create';
		const input = document.createElement('input');
		input.className = 'control';
		input.type = 'text';
		input.placeholder = 'New tag name';
		input.spellcheck = false;
		const commit = () => {
			const name = input.value.trim();
			if (!name) {
				return;
			}
			post({ type: 'tagCreate', kind, name });
			input.value = '';
		};
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				commit();
			}
		});
		create.append(input, actionButton('Create', '', commit));
		box.append(head, list, create);
		$('st-pane').append(box);
	}

	function managerRow(tag, info) {
		const row = document.createElement('div');
		row.className = 'tag-manager-row';
		row.dataset.tag = tag.id;
		const name = document.createElement('input');
		name.id = 'tgm-name-' + tag.id;
		name.className = 'control tag-name';
		name.type = 'text';
		name.value = tag.name;
		name.spellcheck = false;
		name.title = 'Rename. The id stays, so nothing that carries this tag loses it.';
		name.addEventListener('change', () => {
			const wanted = name.value.trim();
			if (!wanted || wanted === tag.name) {
				name.value = tag.name;
				return;
			}
			post({ type: 'tagRename', kind, tag: tag.id, name: wanted });
		});
		const colour = (label, key, value) => {
			const wrap = document.createElement('label');
			wrap.className = 'tag-colour';
			wrap.title = label;
			const picker = document.createElement('input');
			picker.type = 'color';
			picker.value = value || '#888888';
			picker.addEventListener('change', () => post({ type: 'tagUpdate', kind, tag: tag.id, patch: { [key]: picker.value } }));
			const clear = actionButton('⌫', `Use the default ${label.toLowerCase()}`, () => post({ type: 'tagUpdate', kind, tag: tag.id, patch: { [key]: '' } }), 'link');
			wrap.append(picker, clear);
			return wrap;
		};
		const folder = actionButton(
			tag.folder_type === 'OPEN' ? '✔' : tag.folder_type === 'CLOSED' ? '👁' : '✕',
			'Folder type: ✕ none, ✔ open, 👁 closed. Open shows every character, closed hides the ones without the tag.',
			() => {
				const order = ['NONE', 'OPEN', 'CLOSED'];
				const next = order[(order.indexOf(tag.folder_type || 'NONE') + 1) % order.length];
				post({ type: 'tagUpdate', kind, tag: tag.id, patch: { folder_type: next } });
			},
			'secondary tag-folder',
		);
		const hidden = document.createElement('label');
		hidden.className = 'tag-hidden';
		hidden.title = 'Do not draw this tag on the character card.';
		const check = document.createElement('input');
		check.type = 'checkbox';
		check.checked = tag.is_hidden_on_character_card === true;
		check.addEventListener('change', () => post({ type: 'tagUpdate', kind, tag: tag.id, patch: { is_hidden_on_character_card: check.checked } }));
		hidden.append(check, document.createTextNode(' hidden'));
		const uses = document.createElement('span');
		uses.className = 'tag-uses';
		uses.textContent = `${info.counts[tag.id] || 0} use${(info.counts[tag.id] || 0) === 1 ? '' : 's'}`;
		const merge = document.createElement('select');
		merge.className = 'control tag-merge';
		merge.title = 'Delete and hand everything that carried it to another tag.';
		const none = document.createElement('option');
		none.value = '';
		none.textContent = 'Do not merge';
		merge.append(none);
		for (const other of info.list) {
			if (other.id === tag.id) {
				continue;
			}
			const option = document.createElement('option');
			option.value = other.id;
			option.textContent = `Merge into ${other.name}`;
			merge.append(option);
		}
		const del = actionButton('✕', `Delete ${tag.name}`, () => post({ type: 'tagDelete', kind, tag: tag.id, into: merge.value }), 'secondary danger');
		row.append(chip(tag, false), name, colour('Background colour', 'color', tag.color), colour('Text colour', 'color2', tag.color2), folder, hidden, uses, merge, del);
		return row;
	}

	/* ------------------------------------------------------------------ prompt table */

	/** The prompt the *Edit* panel is open on. Upstream's pencil opens one just like it. */
	let editingPrompt = null;

	/** The library entry the box has picked: its editor unfolds right below the box. */
	let editingLibrary = null;

	/** Which library the entry box is showing: the shared `system` one, or this preset's own. */
	let libraryScope = 'system';

	/** The shared prompt library the host last sent: every preset inserts from it. */
	let systemLibrary = [];

	/** The token count of a prompt's text, in the same shape the host's counter reports one. */
	const promptTokens = (prompt) => Math.ceil(new TextEncoder().encode(String(prompt.content ?? '')).length / 4);

	/** The little markers upstream puts beside a block's name, in our own glyphs. */
	function promptBadges(prompt, managed = false) {
		const inChat = Number(prompt.injection_position) === 1;
		const badges = [];
		if (managed) {
			badges.push(['◆', 'Comonad block — its text is generated for every turn']);
		}
		if (prompt.marker) {
			badges.push([
				inChat ? '💉' : '📌',
				inChat ? 'Injected into the chat at a depth' : 'Marker: its content is filled from the chat, the card or the world books',
			]);
		}
		if (prompt.forbid_overrides) {
			badges.push(['★', 'Important: a character card cannot replace this block']);
		}
		if (prompt.extension && !managed) {
			badges.push(['⧉', 'An extension prompt']);
		}
		const role = prompt.role === 'user' ? ['👤', 'Sent as the user'] : prompt.role === 'assistant' ? ['🤖', 'Sent as the assistant'] : [];
		if (inChat) {
			role.push(`@ ${Number(prompt.injection_depth ?? 4)}`);
		}
		return { badges, role, inChat };
	}

	/** The editor redraws with the form, so whatever is being typed into is put back afterwards. */
	function captureFocus() {
		const active = document.activeElement;
		const pane = $('st-pane');
		if (!active || !pane || !pane.contains(active) || !active.id) {
			return null;
		}
		return { id: active.id, start: active.selectionStart, end: active.selectionEnd };
	}

	function restoreFocus(saved) {
		if (!saved) {
			return;
		}
		const node = document.getElementById(saved.id);
		if (!node) {
			return;
		}
		node.focus();
		if (typeof saved.start === 'number' && typeof node.setSelectionRange === 'function') {
			try {
				node.setSelectionRange(saved.start, saved.end);
			} catch {
				// A control that holds no text: focusing it is enough.
			}
		}
	}

	/* ------------------------------------------------------------------ prompt libraries */

	/** An identifier that is not taken yet: `base`, else `base-2`, `base-3`… */
	function uniqueId(list, base) {
		const taken = new Set((list || []).map((entry) => entry.identifier));
		if (!taken.has(base)) {
			return base;
		}
		let n = 2;
		while (taken.has(`${base}-${n}`)) {
			n += 1;
		}
		return `${base}-${n}`;
	}

	/** This preset's own library, made on demand: it lives inside the preset and is saved with it. */
	function presetLibrary() {
		if (!Array.isArray(item.promptLibrary)) {
			item.promptLibrary = [];
		}
		return item.promptLibrary;
	}

	/** The shared library is a file of its own, so the pane posts the whole thing and the host writes it. */
	function saveSystemLibrary() {
		post({ type: 'promptLibrarySave', kind: 'presets', prompts: systemLibrary });
	}

	/** A copy of a library entry, with the fields that only belong to a library stripped off. */
	function libraryCopy(entry) {
		const copy = { ...structuredClone(entry) };
		delete copy.description;
		delete copy.tokens;
		return copy;
	}

	/** A name no other entry in the list already has, so new entries never look like duplicates. */
	function uniqueName(list, base) {
		const taken = new Set(list.map((entry) => entry.name));
		if (!taken.has(base)) {
			return base;
		}
		let n = 2;
		while (taken.has(`${base} ${n}`)) {
			n += 1;
		}
		return `${base} ${n}`;
	}

	/**
	 * Saves a copy of a system block — or an empty one — into this preset's own library. Nothing reaches
	 * the prompt list: an entry that lands there by accident is the one mistake this pane can make, so
	 * the status line says out loud what happened and the new editor is scrolled into view.
	 */
	function addToPresetLibrary(entry) {
		const copy = entry ? libraryCopy(entry) : { name: uniqueName(presetLibrary(), 'New prompt'), role: 'system', system_prompt: true, content: '' };
		copy.identifier = uniqueId(presetLibrary(), entry ? entry.identifier : 'prompt');
		presetLibrary().push(copy);
		editingLibrary = { scope: 'preset', id: copy.identifier };
		markDirty();
		render();
		revealLibraryEditor();
		status('Saved to this preset’s own library. It is not in the prompt list — insert it when you want it there.');
	}

	/** A library entry's editor sits below the fold, so a new or edited one is brought into view. */
	function revealLibraryEditor() {
		const node = document.getElementById('le-name');
		if (node && typeof node.scrollIntoView === 'function') {
			node.scrollIntoView({ block: 'nearest' });
		}
	}

	/** Copies one library entry into the prompt list, after the leading Comonad blocks. */
	function insertFromLibrary(entry) {
		const copy = libraryCopy(entry);
		copy.identifier = uniqueId(item.prompts, entry.identifier);
		// Comonad's generated blocks lead by default; a library entry goes after that run, where a
		// user block is easiest to find.
		const managed = new Set((state.preset && state.preset.comonad) || []);
		let at = 0;
		while (at < item.prompts.length && managed.has(item.prompts[at].identifier)) {
			at += 1;
		}
		item.prompts.splice(at, 0, copy);
		markDirty();
		render();
		status(`Inserted “${copy.name || copy.identifier}” after Comonad’s blocks.`);
	}

	/**
	 * A library entry's editor: its name, its role and its text. The positioned-in-chat fields belong
	 * to a block once it is in the list, and are edited there. A preset entry keeps its edits until the
	 * preset is saved; a system entry is written as soon as the field is left, because the shared file
	 * is not the preset's to hold.
	 */
	function libraryEditor(entry, scope) {
		const panel = document.createElement('section');
		panel.className = 'prompt-edit library-edit';
		const heading = document.createElement('h3');
		heading.textContent = scope === 'system' ? 'Edit built-in prompt' : 'Edit custom prompt';
		panel.append(heading);

		const commit = () => {
			if (scope === 'system') {
				saveSystemLibrary();
			} else {
				markDirty();
			}
		};
		const field = (label, hint, node) => {
			const wrap = document.createElement('div');
			wrap.className = 'prompt-field';
			const text = document.createElement('label');
			text.textContent = label;
			wrap.append(text, node);
			if (hint) {
				wrap.append(hintEl(hint));
			}
			return wrap;
		};

		const name = document.createElement('input');
		name.id = 'le-name';
		name.className = 'control';
		name.type = 'text';
		name.spellcheck = false;
		name.value = entry.name || '';
		name.addEventListener('input', () => {
			entry.name = name.value;
		});
		name.addEventListener('blur', commit);

		const role = document.createElement('select');
		role.id = 'le-role';
		role.className = 'control';
		for (const [value, text] of [
			['system', 'System'],
			['user', 'User'],
			['assistant', 'AI Assistant'],
		]) {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = text;
			option.selected = (entry.role || 'system') === value;
			role.append(option);
		}
		role.addEventListener('change', () => {
			entry.role = role.value;
			entry.system_prompt = role.value === 'system';
			commit();
		});

		const content = document.createElement('textarea');
		content.id = 'le-content';
		content.className = 'control';
		content.rows = 6;
		content.spellcheck = false;
		content.placeholder = 'The prompt to be sent.';
		content.value = entry.content ?? '';
		content.disabled = entry.marker === true;
		content.addEventListener('input', () => {
			entry.content = content.value;
		});
		content.addEventListener('blur', commit);

		const rows = document.createElement('div');
		rows.className = 'prompt-edit-rows';
		rows.append(field('Name', 'A name for this prompt.', name), field('Role', 'To whom this message will be attributed.', role));
		const textLabel = document.createElement('div');
		textLabel.className = 'prompt-text-label';
		const textTitle = document.createElement('label');
		textTitle.textContent = 'Prompt';
		textLabel.append(textTitle);
		panel.append(rows, textLabel, content);
		if (entry.marker) {
			panel.append(hintEl('The content of this prompt is pulled from elsewhere and cannot be edited here.'));
		}

		const footer = document.createElement('div');
		footer.className = 'prompt-edit-footer';
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'library-delete';
		remove.textContent = 'Delete';
		remove.title = 'Remove this prompt from this preset’s custom library.';
		// A built-in entry cannot be deleted: the set is fixed by the templates, so only custom ones go.
		remove.hidden = scope === 'system';
		remove.addEventListener('click', () => {
			const list = presetLibrary();
			const index = list.findIndex((candidate) => candidate.identifier === entry.identifier);
			if (index >= 0) {
				list.splice(index, 1);
			}
			editingLibrary = null;
			markDirty();
			render();
			status('Removed from this preset’s custom library.');
		});
		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'secondary';
		close.textContent = 'Close';
		close.addEventListener('click', () => {
			commit();
			editingLibrary = null;
			render();
		});
		footer.append(remove, close);
		panel.append(footer);
		return panel;
	}

	function renderPrompts() {
		const focus = captureFocus();
		const host = $('st-form');
		host.innerHTML = '';
		host.append(sectionEl('Preset', [fieldEl({ key: 'name', label: 'Preset name', type: 'text' })]));
		const prompts = Array.isArray(item.prompts) ? item.prompts : (item.prompts = []);
		// This preset's own library, made on demand: it lives inside the preset and is saved with it.
		const presetEntries = presetLibrary();
		const slice = state.preset || {};
		// Comonad's own blocks: generated for every turn, so their text is read-only here, while their
		// place and switch are the preset's to decide like any other row.
		const managedIds = new Set(slice.comonad || []);
		const isManaged = (prompt) => managedIds.has(prompt.identifier);
		const known = (prompt) => Object.prototype.hasOwnProperty.call(slice.tokens || {}, prompt.identifier);
		// The open block counts itself, so the number follows what is being typed — except for a
		// generated block, whose text is not in the form and whose current value came from the host.
		const countOf = (prompt) => {
			if (known(prompt) && (isManaged(prompt) || prompt.identifier !== editingPrompt)) {
				return slice.tokens[prompt.identifier];
			}
			return promptTokens(prompt);
		};
		const total = prompts.reduce((sum, prompt) => sum + countOf(prompt), 0);
		// The edited block's row, so the counts beside the editor follow what is typed into it, and the
		// toolbar's total, which is built below the list.
		let countCell = null;
		let totalNode = null;

		const section = document.createElement('section');
		const heading = document.createElement('h2');
		heading.textContent = `Prompts (${prompts.length})`;
		const hint = hintEl(
			'Order is the order the model reads. ✎ unfolds a block for editing. The ◆ rows are Comonad’s own blocks: their text is generated for every turn, so only their place and switch can be changed here.',
		);
		const list = document.createElement('div');
		list.className = 'prompt-list';
		// One line of labels over the rows, so the list reads as a table without being one: a row is a card
		// that can grow an editor inside itself.
		const head = document.createElement('div');
		head.className = 'prompt-head';
		const headCell = (text, className) => {
			const cell = document.createElement('span');
			cell.textContent = text;
			if (className) {
				cell.className = className;
			}
			return cell;
		};
		head.append(headCell(''), headCell('Prompt'), headCell(''), headCell('Tokens', 'num'));
		list.append(head);

		const move = (index, delta) => {
			moveTo(index, index + delta);
		};

		// A drop lands at the target index; any row, Comonad's included, may move anywhere in the list.
		const moveTo = (from, to) => {
			if (from === to || from < 0 || to < 0 || from >= prompts.length || to >= prompts.length) {
				return;
			}
			const moved = prompts.splice(from, 1)[0];
			prompts.splice(to, 0, moved);
			markDirty();
			render();
		};
		// The index of the card being dragged, set while a drag is in progress.
		let dragFrom = null;

		prompts.forEach((prompt, index) => {
			// One block is one card: the row, and — while it is open — its editor, so the two read as the
			// single thing they are.
			const block = document.createElement('div');
			block.className = 'prompt-item';
			const managed = isManaged(prompt);
			if (managed) {
				block.classList.add('is-managed');
			}
			// Every row can be dragged, Comonad's generated blocks included.
			block.draggable = true;
			block.addEventListener('dragstart', (event) => {
				dragFrom = index;
				block.classList.add('is-dragging');
				event.dataTransfer.effectAllowed = 'move';
				// Firefox will not start a drag without some data on the transfer.
				event.dataTransfer.setData('text/plain', prompt.identifier);
			});
			block.addEventListener('dragend', () => {
				dragFrom = null;
				block.classList.remove('is-dragging');
				list.querySelectorAll('.is-drop-target').forEach((node) => node.classList.remove('is-drop-target'));
			});
			// A card accepts a drop only from another card in this list.
			block.addEventListener('dragover', (event) => {
				if (dragFrom === null) {
					return;
				}
				event.preventDefault();
				event.dataTransfer.dropEffect = 'move';
				block.classList.add('is-drop-target');
			});
			block.addEventListener('dragleave', () => {
				block.classList.remove('is-drop-target');
			});
			block.addEventListener('drop', (event) => {
				if (dragFrom === null) {
					return;
				}
				event.preventDefault();
				const from = dragFrom;
				dragFrom = null;
				moveTo(from, index);
			});
			if (prompt.identifier === editingPrompt) {
				block.classList.add('is-editing');
			}
			if (prompt.enabled === false) {
				block.classList.add('is-off');
			}
			const row = document.createElement('div');
			row.className = 'prompt-row';

			// The switch: upstream toggles a block with an icon, and this reads the same way.
			const toggle = document.createElement('label');
			toggle.className = 'switch';
			toggle.title = prompt.enabled === false ? 'Send this block' : 'Stop sending this block';
			const on = document.createElement('input');
			on.type = 'checkbox';
			on.checked = prompt.enabled !== false;
			const knob = document.createElement('span');
			knob.className = 'knob';
			toggle.append(on, knob);
			on.addEventListener('change', () => {
				prompt.enabled = on.checked;
				block.classList.toggle('is-off', !on.checked);
				toggle.title = on.checked ? 'Stop sending this block' : 'Send this block';
				markDirty();
			});
			row.append(toggle);

			// The name, with upstream's markers beside it: what kind of block it is, and where it goes.
			const label = document.createElement('div');
			label.className = 'prompt-name-block';
			const { badges, role } = promptBadges(prompt, managed);
			for (const [glyph, tip] of badges) {
				const badge = document.createElement('span');
				badge.className = 'prompt-badge';
				badge.textContent = glyph;
				badge.title = tip;
				label.append(badge);
			}
			const name = document.createElement('button');
			name.type = 'button';
			name.className = 'prompt-open';
			name.textContent = prompt.name || prompt.identifier;
			name.title = managed ? `Read ${prompt.name || prompt.identifier}` : `Edit ${prompt.name || prompt.identifier}`;
			name.addEventListener('click', () => {
				editingPrompt = editingPrompt === prompt.identifier ? null : prompt.identifier;
				render();
			});
			label.append(name);
			// The role is only worth saying when it is not the system's, and the depth only when the block
			// goes into the chat — the same two facts upstream marks, and nothing else.
			if (role.length) {
				const roleGlyph = document.createElement('span');
				roleGlyph.className = 'prompt-role';
				roleGlyph.textContent = role.join(' ');
				label.append(roleGlyph);
			}
			row.append(label);

			const buttons = document.createElement('div');
			buttons.className = 'prompt-controls';
			const control = (glyph, tip, onClick, disabled = false) => {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'icon';
				button.textContent = glyph;
				button.title = tip;
				button.disabled = disabled;
				button.addEventListener('click', onClick);
				buttons.append(button);
				return button;
			};
			control('↑', 'Move up', () => move(index, -1), index === 0);
			control('↓', 'Move down', () => move(index, 1), index === prompts.length - 1);
			control('✎', managed ? 'Read this generated block' : 'Edit this block', () => {
				editingPrompt = editingPrompt === prompt.identifier ? null : prompt.identifier;
				render();
			});
			control('⧉', 'Duplicate this block', () => {
				const copy = { ...structuredClone(prompt), identifier: uniqueId(prompts, `${prompt.identifier}-copy`) };
				copy.name = `${prompt.name || prompt.identifier} (copy)`;
				prompts.splice(index + 1, 0, copy);
				markDirty();
				render();
			}, managed);
			control('✕', 'Delete this block', () => {
				prompts.splice(index, 1);
				if (editingPrompt === prompt.identifier) {
					editingPrompt = null;
				}
				markDirty();
				render();
			}, managed);
			row.append(buttons);

			const counts = document.createElement('div');
			counts.className = 'prompt-tokens';
			counts.textContent = String(countOf(prompt));
			counts.title = 'Tokens this block costs';
			if (prompt.identifier === editingPrompt) {
				countCell = counts;
			}
			row.append(counts);

			block.append(row);
			// The editor unfolds inside the card it belongs to, and refreshes the row's count as it is
			// typed into.
			if (prompt.identifier === editingPrompt) {
				block.append(
					promptEditor(prompt, () => {
						if (countCell) {
							countCell.textContent = String(countOf(prompt));
						}
						if (totalNode) {
							totalNode.textContent = `Total Tokens: ${prompts.reduce((sum, entry) => sum + countOf(entry), 0)}`;
						}
					}),
				);
			}
			list.append(block);
		});
		section.append(heading, hint, list);

		// The toolbar under the list: the restore, and what the list costs. Adding and inserting both live
		// in the two entry boxes below, so nothing up here can put a block in the list by accident.
		const tools = document.createElement('div');
		tools.className = 'prompt-tools';

		const restore = document.createElement('button');
		restore.type = 'button';
		restore.className = 'secondary';
		restore.textContent = 'Restore prompts';
		restore.title = 'Put the shipped prompts and their order back.';
		restore.addEventListener('click', () => post({ type: 'presetRestorePrompts', kind, id: selection }));
		totalNode = document.createElement('span');
		totalNode.className = 'prompt-total';
		totalNode.textContent = `Total Tokens: ${total}`;
		tools.append(restore, totalNode);
		// The toolbar belongs to the list, so it keeps the section's own spacing instead of butting up
		// against whatever group of settings comes next.
		section.append(tools);
		host.append(section);

		// One entry box for both libraries: a small button on the left switches which library it shows, and
		// that library's entries are listed under it, so an entry a *+ New* made is where the eye already is.
		const libraries = document.createElement('section');
		const libraryHead = document.createElement('div');
		libraryHead.className = 'library-head';
		const libraryHeading = document.createElement('h2');
		libraryHeading.textContent = 'Prompt library';
		libraryHead.append(libraryHeading);
		libraries.append(
			libraryHead,
			hintEl('Pick an entry and Insert it, or add a new one. The button switches between the built-in library and this preset’s custom one; the picked entry is edited right below, and nothing reaches the prompt list until it is inserted.'),
		);
		const activeScope = libraryScope;
		const entries = activeScope === 'system' ? systemLibrary : presetEntries;
		const picked = editingLibrary && editingLibrary.scope === activeScope ? entries.find((entry) => entry.identifier === editingLibrary.id) || null : null;

		const box = document.createElement('div');
		box.className = 'library-box';
		// The small button *is* the label: it names the library the box is showing, and clicking it swaps to
		// the other one. A system entry writes straight through, so an open one is saved before the swap.
		const toggle = document.createElement('button');
		toggle.type = 'button';
		toggle.className = 'secondary library-scope';
		// The ⇅ glyph marks it as a switch rather than the name of an entry.
		toggle.textContent = (activeScope === 'system' ? 'Built-in' : 'Custom') + ' ⇅';
		toggle.title = 'Switch between the shared library and this preset’s own.';
		toggle.addEventListener('click', () => {
			if (editingLibrary && editingLibrary.scope === 'system') {
				saveSystemLibrary();
			}
			libraryScope = activeScope === 'system' ? 'preset' : 'system';
			editingLibrary = null;
			render();
		});
		// The picker is the finder: choosing an entry opens its editor in the space right below the box.
		const select = document.createElement('select');
		select.className = 'control';
		select.title = activeScope === 'system' ? 'Pick a prompt from the built-in library.' : 'Pick a prompt from this preset’s custom library.';
		const placeholder = document.createElement('option');
		placeholder.value = '';
		placeholder.textContent = entries.length ? 'Pick an entry…' : 'Nothing saved yet';
		placeholder.selected = !picked;
		select.append(placeholder);
		for (const entry of entries) {
			const option = document.createElement('option');
			option.value = entry.identifier;
			option.textContent = entry.name || entry.identifier;
			option.title = entry.description || '';
			option.selected = Boolean(picked && picked.identifier === entry.identifier);
			select.append(option);
		}
		select.addEventListener('change', () => {
			// A system entry writes straight through, so it is saved before another one is picked.
			if (editingLibrary && editingLibrary.scope === 'system' && editingLibrary.id !== select.value) {
				saveSystemLibrary();
			}
			editingLibrary = select.value ? { scope: activeScope, id: select.value } : null;
			render();
		});
		// The built-in library is fixed by the templates: its entries can be edited and inserted, never added.
		// Only the custom library grows, so only its box carries *+ New*.
		const create = document.createElement('button');
		create.type = 'button';
		create.className = 'secondary';
		create.textContent = '+ New';
		create.title = 'Add a new empty prompt to this preset’s custom library.';
		create.addEventListener('click', () => addToPresetLibrary(null));
		create.hidden = activeScope === 'system';
		const insert = document.createElement('button');
		insert.type = 'button';
		insert.className = 'secondary';
		insert.textContent = 'Insert';
		insert.title = 'Insert the picked entry at the top of the prompt list.';
		// Nothing is insertable until an entry is picked, so the button says so instead of failing on click.
		insert.disabled = !picked;
		insert.addEventListener('click', () => {
			const wanted = select.value;
			const entry = wanted ? entries.find((candidate) => candidate.identifier === wanted) : null;
			if (!entry) {
				status('Pick an entry first, then Insert.', true);
				return;
			}
			insertFromLibrary(entry);
		});
		box.append(toggle, select, create, insert);

		// The picked entry is edited in the space right below the box: the picker is how you find one, so
		// there is no separate list to keep in step with it.
		libraries.append(box);
		if (picked) {
			libraries.append(libraryEditor(picked, activeScope));
		}
		host.append(libraries);
		restoreFocus(focus);
	}

	/**
	 * Upstream's *Edit* panel, field for field: name, role, the generation types it fires for, where it
	 * goes, its depth and order, and the prompt itself. A marker block's text is filled from elsewhere,
	 * so its textarea is closed — upstream says the same thing in the same place.
	 */
	function promptEditor(prompt, refresh) {
		const slice = state.preset || {};
		// A Comonad block's content is built again every turn: the row may be moved and switched, but
		// what it says is the agent's, so its fields are shown read-only.
		const managed = new Set(slice.comonad || []).has(prompt.identifier);
		const panel = document.createElement('section');
		panel.className = 'prompt-edit';
		const heading = document.createElement('h3');
		heading.textContent = managed ? 'Generated block' : 'Edit';
		panel.append(heading);

		const field = (label, hint, node, wide) => {
			const wrap = document.createElement('div');
			wrap.className = 'prompt-field' + (wide ? ' wide' : '');
			const text = document.createElement('label');
			text.textContent = label;
			wrap.append(text, node);
			if (hint) {
				wrap.append(hintEl(hint));
			}
			return wrap;
		};
		const write = (key, value) => {
			prompt[key] = value;
			markDirty();
		};

		const name = document.createElement('input');
		name.id = 'pe-name';
		name.className = 'control';
		name.type = 'text';
		name.spellcheck = false;
		name.value = prompt.name || '';
		name.disabled = managed;
		name.addEventListener('input', () => write('name', name.value));

		const role = document.createElement('select');
		role.id = 'pe-role';
		role.className = 'control';
		for (const [value, text] of [['system', 'System'], ['user', 'User'], ['assistant', 'AI Assistant']]) {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = text;
			option.selected = (prompt.role || 'system') === value;
			role.append(option);
		}
		role.disabled = managed;
		role.addEventListener('change', () => write('role', role.value));

		// *Triggers*: a block limited to some generation types is left out of the others. An empty
		// selection is upstream's "All types (default)".
		// A native multi-select cannot be cleared with a plain click, so this is a list of tick boxes.
		const triggers = document.createElement('div');
		triggers.id = 'pe-triggers';
		triggers.className = 'control pe-checks';
		triggers.setAttribute('role', 'group');
		for (const generation of slice.generations || []) {
			const row = document.createElement('label');
			row.className = 'pe-check';
			const box = document.createElement('input');
			box.type = 'checkbox';
			box.value = generation.value;
			box.checked = Array.isArray(prompt.injection_trigger) && prompt.injection_trigger.includes(generation.value);
			const text = document.createElement('span');
			text.textContent = generation.label;
			row.append(box, text);
			triggers.append(row);
		}
		if (managed) {
			triggers.querySelectorAll('input').forEach((box) => {
				box.disabled = true;
			});
		}
		triggers.addEventListener('change', () => {
			write(
				'injection_trigger',
				[...triggers.querySelectorAll('input[type="checkbox"]:checked')].map((box) => box.value),
			);
		});

		const position = document.createElement('select');
		position.id = 'pe-position';
		position.className = 'control';
		for (const [value, text] of [['0', 'Relative'], ['1', 'In-chat']]) {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = text;
			option.selected = String(Number(prompt.injection_position ?? 0)) === value;
			position.append(option);
		}
		position.disabled = managed;
		position.addEventListener('change', () => {
			write('injection_position', Number(position.value));
			render();
		});

		const numeric = (id, key, fallback, min, max) => {
			const input = document.createElement('input');
			input.id = id;
			input.className = 'control';
			input.type = 'number';
			input.min = String(min);
			input.max = String(max);
			input.value = String(prompt[key] ?? fallback);
			input.addEventListener('input', () => write(key, Number(input.value) || 0));
			return input;
		};
		const depth = numeric('pe-depth', 'injection_depth', 4, 0, 9999);
		depth.disabled = managed || Number(prompt.injection_position ?? 0) !== 1;
		const order = numeric('pe-order', 'injection_order', 100, 0, 9999);
		order.disabled = managed;

		// The prompt itself. A marker's text comes from the chat, the card or the world books, so there
		// is nothing here to type into — upstream disables the same field.
		const content = document.createElement('textarea');
		content.id = 'pe-content';
		content.className = 'control';
		content.rows = 8;
		content.spellcheck = false;
		content.placeholder = managed ? 'Generated for every turn.' : 'The prompt to be sent.';
		content.value = managed ? ((slice.preview || {})[prompt.identifier] ?? '') : (prompt.content ?? '');
		content.disabled = prompt.marker === true;
		content.addEventListener('input', () => {
			write('content', content.value);
			if (refresh) {
				refresh();
			}
		});

		const forbid = document.createElement('input');
		forbid.type = 'checkbox';
		forbid.id = 'pe-forbid';
		forbid.checked = prompt.forbid_overrides === true;
		forbid.disabled = managed;
		forbid.addEventListener('change', () => write('forbid_overrides', forbid.checked));
		const forbidLabel = document.createElement('label');
		forbidLabel.className = 'check';
		forbidLabel.title = 'This prompt cannot be overridden by character cards, even if overrides are preferred.';
		forbidLabel.append(forbid, document.createTextNode(' Forbid Overrides'));

		const textLabel = document.createElement('div');
		textLabel.className = 'prompt-text-label';
		const textTitle = document.createElement('label');
		textTitle.textContent = 'Prompt';
		textLabel.append(textTitle, forbidLabel);

		const rows = document.createElement('div');
		rows.className = 'prompt-edit-rows';
		rows.append(
			field('Name', 'A name for this prompt.', name),
			field('Role', 'To whom this message will be attributed.', role),
			field('Triggers', 'Filter to specific generation types. Nothing selected means all of them.', triggers),
			field('Position', 'Relative (to other prompts in prompt manager) or In-chat @ Depth.', position),
			field('Depth', '0 = after the last message, 1 = before the last message, etc.', depth),
			field('Order', 'Ordered from low/top to high/bottom, and at same order: Assistant, User, System.', order),
		);
		panel.append(rows, textLabel, content);
		if (managed) {
			panel.append(
				hintEl(
					prompt.identifier === slice.toolsPrompt
						? 'Tool definitions travel beside the request in the API’s tools parameter, not in this text. This entry is the switch: with it off, the request offers no tools and a call is rejected before it runs.'
						: 'This block is generated from the agent’s state for every turn. Its place and switch are yours; its text is not editable here. The current text is also shown in Inspect → Prompts.',
				),
			);
		} else if (prompt.marker) {
			panel.append(hintEl('The content of this prompt is pulled from elsewhere and cannot be edited here.'));
		}

		const footer = document.createElement('div');
		footer.className = 'prompt-edit-footer';
		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'secondary';
		close.textContent = 'Close';
		close.addEventListener('click', () => {
			editingPrompt = null;
			render();
		});
		const reset = document.createElement('button');
		reset.type = 'button';
		reset.className = 'secondary reset';
		reset.textContent = 'Reset';
		reset.disabled = managed;
		reset.title = managed
			? 'A generated block has no stored text to put back.'
			: 'Put this block back to what Comonad ships — the text, the name and the role it starts with.';
		reset.addEventListener('click', () => {
			const shipped = (slice.shipped || []).find((entry) => entry.identifier === prompt.identifier);
			if (shipped) {
				prompt.name = shipped.name;
				prompt.role = shipped.role;
				prompt.content = shipped.content ?? '';
				prompt.system_prompt = shipped.system_prompt === true;
				prompt.marker = shipped.marker === true;
			} else {
				// A block that is not one of ours: there is no shipped text to go back to, so it is emptied.
				prompt.content = '';
			}
			markDirty();
			render();
		});
		footer.append(close, reset);
		panel.append(footer);
		return panel;
	}

	/* ------------------------------------------------------------------ the page */

	/** The kind sub-tabs live in the panel's markup; the pane labels them and marks the current one. */
	function renderKinds() {
		for (const button of document.querySelectorAll('.subtab[data-st]')) {
			const value = button.dataset.st;
			if (!(state.kindLabels && state.kindLabels[value])) {
				continue;
			}
			// The label and the count are two elements, so the count can be a badge of its own rather than
			// part of the tab's name.
			const text = document.createElement('span');
			text.textContent = state.kindLabels[value];
			const count = document.createElement('span');
			count.className = 'count';
			count.textContent = String((state.counts && state.counts[value]) || 0);
			button.replaceChildren(text, count);
			button.classList.toggle('is-on', value === kind);
		}
	}

	/* ------------------------------------------------------------------ the character list */

	// The list's own controls, which are SillyTavern's controls for its character list: a search box,
	// the order, the favourites filter, the grid toggle and the pager. They live in the pane, so the
	// host never sees them; the order and the grid are remembered in the webview's own store.
	const SORTS = [
		['name', 'Name (A-Z)'],
		['namedesc', 'Name (Z-A)'],
		['newest', 'Newest first'],
		['oldest', 'Oldest first'],
	];
	const PAGE_SIZE = 50;
	const remembered = store.get() || {};
	const listView = {
		query: '',
		sort: SORTS.some(([value]) => value === remembered.listSort) ? remembered.listSort : 'name',
		favourites: remembered.listFavourites === true,
		grid: remembered.listGrid === true,
		page: 0,
	};

	/** The rows the list shows: the catalog, or the characters after the list's own controls. */
	function visibleItems() {
		const all = state.items || [];
		if (kind !== 'characters') {
			return all;
		}
		const term = listView.query.trim().toLowerCase();
		let rows = term
			? all.filter((entry) => (entry.name + ' ' + entry.detail).toLowerCase().includes(term))
			: all.slice();
		if (listView.favourites) {
			rows = rows.filter((entry) => entry.favourite === true);
		}
		const byName = (left, right) => left.name.localeCompare(right.name);
		// A card upstream never stamped with a date sorts last whichever way the list is ordered.
		const byDate = (left, right, compare) => {
			const a = String(left.createdAt ?? '');
			const b = String(right.createdAt ?? '');
			if (!a || !b) {
				return a === b ? compare(left, right) : a ? 1 : -1;
			}
			return compare(left, right);
		};
		rows.sort(
			listView.sort === 'namedesc'
				? (left, right) => byName(right, left)
				: listView.sort === 'newest'
					? (left, right) => byDate(left, right, (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || byName(a, b))
					: listView.sort === 'oldest'
						? (left, right) => byDate(left, right, (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || byName(a, b))
						: byName,
		);
		return rows;
	}

	/** The little toolbar above the list: search, order, favourites, grid view and the pager. */
	function renderListTools(total) {
		const list = $('st-list');
		let tools = $('st-tools');
		if (kind !== 'characters') {
			if (tools) {
				tools.remove();
			}
			return;
		}
		if (!tools) {
			tools = document.createElement('div');
			tools.id = 'st-tools';
			list.prepend(tools);
			const search = document.createElement('input');
			search.id = 'st-search';
			search.type = 'search';
			search.placeholder = 'Search…';
			const order = document.createElement('select');
			order.id = 'st-sort';
			order.className = 'control';
			for (const [value, label] of SORTS) {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = label;
				order.append(option);
			}
			const stars = document.createElement('button');
			stars.type = 'button';
			stars.id = 'st-favs';
			stars.className = 'icon';
			stars.textContent = '★';
			stars.title = 'Show only favourites';
			const grid = document.createElement('button');
			grid.type = 'button';
			grid.id = 'st-grid';
			grid.className = 'icon';
			grid.textContent = '▦';
			grid.title = 'Toggle grid view';
			tools.append(search, order, stars, grid);
			search.addEventListener('input', () => {
				listView.query = search.value;
				listView.page = 0;
				renderList();
			});
			order.addEventListener('change', () => {
				listView.sort = order.value;
				store.set({ listSort: order.value });
				renderList();
			});
			stars.addEventListener('click', () => {
				listView.favourites = !listView.favourites;
				listView.page = 0;
				store.set({ listFavourites: listView.favourites });
				renderList();
			});
			grid.addEventListener('click', () => {
				listView.grid = !listView.grid;
				store.set({ listGrid: listView.grid });
				renderList();
			});
		}
		$('st-search').value = listView.query;
		$('st-sort').value = listView.sort;
		$('st-favs').classList.toggle('is-on', listView.favourites);
		$('st-grid').classList.toggle('is-on', listView.grid);

		const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
		listView.page = Math.min(listView.page, pages - 1);
		const pager = document.createElement('span');
		pager.id = 'st-pager';
		if (pages > 1) {
			pager.textContent = `${listView.page + 1} / ${pages}`;
			const step = (label, delta, disabled) => {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'icon';
				button.textContent = label;
				button.disabled = disabled;
				button.addEventListener('click', () => {
					listView.page += delta;
					renderList();
				});
				return button;
			};
			pager.prepend(step('‹', -1, listView.page === 0));
			pager.append(step('›', 1, listView.page === pages - 1));
		}
		const stale = $('st-pager');
		if (stale) {
			stale.replaceWith(pager);
		} else {
			tools.append(pager);
		}
	}

	function renderList() {
		const rows = visibleItems();
		renderListTools(rows.length);
		const host = $('st-items');
		host.innerHTML = '';
		host.classList.toggle('is-grid', kind === 'characters' && listView.grid);
		const first = kind === 'characters' ? listView.page * PAGE_SIZE : 0;
		const shown = kind === 'characters' ? rows.slice(first, first + PAGE_SIZE) : rows;
		for (const entry of shown) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'item';
			row.dataset.id = entry.id;
			row.classList.toggle('is-on', entry.id === selection);
			row.innerHTML =
				'<span class="item-name">' +
				esc(entry.name) +
				(entry.favourite ? ' <span class="item-star" title="Favourite">★</span>' : '') +
				'</span><span class="item-detail">' +
				esc(entry.detail) +
				'</span>';
			// A card's picture is its own file when it is a PNG, so the row shows it where there is one.
			if (entry.avatar) {
				const image = document.createElement('img');
				image.className = 'item-avatar';
				image.src = String(entry.avatar);
				image.alt = '';
				row.prepend(image);
			}
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
		if (!rows.length) {
			host.append(
				hintEl(
					(state.items || []).length
						? 'No card matches that search.'
						: 'Nothing here yet. Use New, or drop files into the library folder.',
				),
			);
		}
		$('st-library').textContent = 'Library: ' + (state.library || '') + ' — SillyTavern-compatible files; a card may also be a PNG.';
	}

	function renderActions() {
		const host = $('st-form');
		const bar = document.createElement('div');
		bar.className = 'actions';
		// Two groups: what the chat uses, and the file-level verbs. They wrap as groups, so the row never
		// breaks in the middle of one of them.
		const used = document.createElement('div');
		used.className = 'group';
		const extras = document.createElement('div');
		extras.className = 'group push';
		bar.append(used, extras);
		const adopted = ((state.adopted && state.adopted[kind]) || []).includes(selection);
		const use = document.createElement('button');
		use.type = 'button';
		use.className = 'secondary';
		use.textContent = adopted ? 'Remove from this chat' : 'Use in this chat';
		use.disabled = Boolean(item && !item.source && !adopted);
		use.addEventListener('click', () => post({ type: 'adopt', kind, id: selection, on: !adopted }));
		used.append(use);
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
			used.append(makeDefault, clearDefault);
		}
		if (kind === 'characters') {
			const png = document.createElement('button');
			png.type = 'button';
			png.className = 'secondary';
			png.textContent = 'Export PNG…';
			png.title = 'Write a shareable card: SillyTavern reads the same PNG.';
			png.addEventListener('click', () => post({ type: 'exportPng', kind, id: selection }));
			extras.append(png);
			// Upstream's *More…* menu, with the entries of it that need a file or a question of their own.
			const more = document.createElement('select');
			more.className = 'control more-menu';
			const idle = document.createElement('option');
			idle.value = '';
			idle.textContent = 'More…';
			idle.disabled = true;
			idle.selected = true;
			more.append(idle);
			for (const [value, label] of [
				['characterImportLore', 'Import Card Lore'],
				['personaFromCharacter', 'Convert to Persona'],
				['characterRename', 'Rename'],
				['characterSource', 'Link to Source'],
				['characterImport', 'Import cards…'],
				['characterExportJson', 'Export JSON…'],
			]) {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = label;
				more.append(option);
			}
			more.addEventListener('change', () => {
				const action = more.value;
				more.value = '';
				if (action) {
					post({ type: action, kind, id: selection, item, character: selection });
				}
			});
			extras.append(more);
		}
		if (kind === 'presets' && presetTools) {
			extras.append(presetTools());
		}
		host.prepend(bar);
	}

	/**
	 * The preset manager's row: start from one of Comonad's templates, restore the one a preset came
	 * from, and move a preset in or out as a file. Upstream's *Update current preset* is this pane's
	 * Save button, because the form already writes the prompt list and the order into the preset.
	 */
	function presetTools() {
		const row = document.createElement('span');
		row.className = 'preset-tools';
		const start = document.createElement('select');
		start.className = 'control';
		const idle = document.createElement('option');
		idle.value = '';
		idle.textContent = 'Start from…';
		idle.selected = true;
		start.append(idle);
		for (const template of state.presetTemplates || []) {
			const option = document.createElement('option');
			option.value = template.id;
			option.textContent = template.inLibrary ? `${template.name} (in the library)` : template.name;
			option.title = template.description;
			start.append(option);
		}
		start.addEventListener('change', () => {
			const wanted = start.value;
			start.value = '';
			if (wanted) {
				post({ type: 'presetTemplate', kind, template: wanted });
			}
		});
		const button = (label, tip, action) => {
			const node = document.createElement('button');
			node.type = 'button';
			node.className = 'secondary';
			node.textContent = label;
			node.title = tip;
			node.addEventListener('click', () => post({ type: action, kind, id: selection }));
			return node;
		};
		row.append(
			start,
			button('Restore template', 'Write this preset again from the template it came from.', 'presetRestoreTemplate'),
			button('Import…', 'Bring an OpenAI preset in as a file of its own.', 'presetImport'),
			button('Export…', 'Write this preset out as SillyTavern reads it.', 'presetExport'),
		);
		return row;
	}

	/**
	 * What the form is drawn from. A push that moves none of it does not redraw it — a caret lives in
	 * there — and one that does is drawn again with the caret put back (every control has an id).
	 */
	function formSignature() {
		return JSON.stringify([
			kind,
			item && item.id,
			item && item.source,
			dirty,
			state.counts,
			(state.items || []).map((entry) => entry.id).join(),
			state.tags && state.tags.assigned,
			state.adopted && state.adopted[kind],
			state.preset && state.preset.total,
			state.preset && state.preset.preview,
			managerOpen,
			((state.catalog && state.catalog.lorebooks) || []).map((entry) => entry.id).join(),
			(state.builtInPrompts || []).map((entry) => entry.identifier).join(),
		]);
	}
	let shape = '';

	function render() {
		const focus = captureFocus();
		if (!state || !item) {
			$('st-form').innerHTML = '<p class="hint">Pick something on the left, or start a new item.</p>';
			renderActions();
			renderList();
			shape = formSignature();
			restoreFocus(focus);
			return;
		}
		if (kind === 'lorebooks') {
			// The world-book page is its own module and draws this kind; without it the tab says so
			// rather than drawing a form for a book the pane would not know how to write back.
			$('st-form').innerHTML = '<p class="hint">The world-book page (worldinfo.js) did not load, so books cannot be edited here.</p>';
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
			if (kind === 'characters' && selection) {
				// The tags sit above the card's own fields: they belong to the library, not to the file.
				$('st-form').prepend(renderTags());
			}
		}
		renderActions();
		renderList();
		renderManager();
		shape = formSignature();
		restoreFocus(focus);
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
			// The built-in library is fed on every push, whatever kind is showing: it is a file of its own,
			// written straight through, so what the host last read is the truth.
			// While a built-in entry is open, its editor holds live objects in this array; replacing the array
			// under it would drop keystrokes typed after the push, so the local copy stays until it is closed.
			if (!(editingLibrary && editingLibrary.scope === 'system') && Array.isArray(content.builtInPrompts)) {
				systemLibrary = content.builtInPrompts;
			}
			// The item the pane is editing is its own. Every content message is answered with a fresh
			// state, so a push while the form is dirty — a shared-library save, say — must not replace it
			// with the copy on disk, or the unsaved edits would vanish.
			const incoming = content.item;
			const same = Boolean(incoming && item && incoming.id === item.id);
			item = dirty && same ? item : incoming;
			selection = item && item.id ? item.id : kind === 'lorebooks' && item ? item.name : null;
			renderKinds();
			$('st-pane').dataset.kind = kind;
			if (kind === 'lorebooks' && bookPane) {
				bookPane.render(content);
				return;
			}
			if (kind === 'personas' && personaPane) {
				personaPane.render(content);
				return;
			}
			// A push that moves nothing the form shows does not redraw it — a caret lives in there.
			// The skip is only for an edit in progress, where the local copy is the truth by contract;
			// a clean form takes every push, so an outside change to the file is never left stale.
			if (dirty && same && formSignature() === shape) {
				renderList();
			} else {
				render();
			}
			if (!dirty) {
				clearDirty();
			}
		},
		// A note about the last action: a save, a delete, or why it failed.
		note(message) {
			if (kind === 'lorebooks' && bookPane) {
				bookPane.note(message);
				return;
			}
			if (kind === 'personas' && personaPane) {
				personaPane.note(message);
				return;
			}
			status(message.message, message.error === true);
			if (message.error !== true) {
				clearDirty();
			}
		},
		// Said out loud when the panel pushes a state this pane cannot use, rather than going blank.
		notice(text) {
			if (kind === 'lorebooks' && bookPane && bookPane.notice) {
				bookPane.notice(text);
				return;
			}
			if (kind === 'personas' && personaPane && personaPane.notice) {
				personaPane.notice(text);
				return;
			}
			status(text, true);
		},
		// The panel's sub-tabs run through here, so unsaved edits are not dropped by accident.
		select(next) {
			if (next === kind) {
				return true;
			}
			if (kind === 'lorebooks' && bookPane) {
				// The world-book page writes as it is typed into, so there is nothing to discard.
				bookPane.flush();
				if (next !== 'settings') {
					post({ type: 'select', kind: next, id: '' });
				}
				return true;
			}
			if (kind === 'personas' && personaPane) {
				// The persona page saves as it is edited as well: a pending edit is written, never dropped.
				personaPane.flush();
				if (next !== 'settings') {
					post({ type: 'select', kind: next, id: '' });
				}
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
