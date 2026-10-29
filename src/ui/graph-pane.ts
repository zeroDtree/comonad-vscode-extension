// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path';
import type { Context } from 'cordis';
import type { PaneController, PaneHost, PaneSpec } from '../services/panes';
import {
	addGraphBlock,
	composeGraphBlocks,
	defaultGraphId,
	duplicateGraphBlock,
	removeGraphBlock,
	setDefaultGraph,
	splitGraphBlocks,
} from '../lib/mermaid';

/** The Graph settings tab: the multi-graph editor and its live preview. */

const ICON =
	'<svg viewBox="0 0 16 16"><circle cx="4" cy="4" r="1.6"/><circle cx="12" cy="5" r="1.6"/><circle cx="7" cy="12" r="1.6"/><path d="M5.5 4.4l5 .6M4.8 5.5l1.6 5M11 6.4l-2.7 4.1"/></svg>';

const MARKUP = `  <h1 class="page-title">Graphs</h1>
  <p class="group-note">The Mermaid source the turn walks. A source may hold several named graphs; <code>%% default: id</code> picks the turn's own loop. <code>%% graph: id</code> names a graph and <code>%% soft node: instruct</code> lets the model choose a target.</p>
  <div class="g-layout">
    <section class="g-picker">
      <label for="g-select">Graphs</label>
      <select id="g-select" class="g-select"></select>
      <span id="g-default-badge" class="g-badge" hidden>default</span>
      <span class="g-spacer"></span>
      <button class="secondary" id="g-set-default" type="button">Set default</button>
      <button class="secondary" id="g-duplicate" type="button">Duplicate</button>
      <button class="secondary" id="g-delete" type="button">Delete</button>
      <button class="secondary" id="g-new" type="button">+ New</button>
    </section>
    <section class="g-main">
      <div class="g-toolbar">
        <span class="g-spacer"></span>
        <button class="secondary" id="g-validate" type="button">Validate</button>
        <button class="primary" id="g-save" type="button">Save</button>
      </div>
      <div class="g-editor">
        <div class="g-gutter" id="g-gutter">1</div>
        <textarea id="g-source" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"></textarea>
      </div>
      <div class="g-editor-foot">
        <label class="check"><input type="checkbox" id="g-whole" /> Whole source</label>
        <span id="g-status"></span>
        <span class="g-spacer"></span>
        <button class="secondary" id="g-reset" type="button">Use shipped default</button>
      </div>
    </section>
    <aside class="g-preview">
      <div class="g-preview-head">Preview</div>
      <div id="g-preview" class="g-diagram"></div>
      <div class="g-preview-body">
        <div class="g-inspector" id="g-inspector"></div>
        <div class="g-insert">
          <div class="g-insert-label">Registered nodes</div>
          <div id="g-nodes" class="g-chips"></div>
          <div class="g-insert-label">Routes</div>
          <div id="g-routes" class="g-chips"></div>
        </div>
      </div>
    </aside>
  </div>
  <div id="g-prompt" class="g-prompt" hidden>
    <div class="g-prompt-card" role="dialog" aria-modal="true" aria-labelledby="g-prompt-title">
      <div id="g-prompt-title" class="g-prompt-title"></div>
      <input id="g-prompt-input" class="control" type="text" spellcheck="false" autocomplete="off" />
      <div class="row"><button class="primary" id="g-prompt-ok" type="button">OK</button><button class="secondary" id="g-prompt-cancel" type="button">Cancel</button></div>
    </div>
  </div>`;

function controller(ctx: Context, host: PaneHost): PaneController {
	const graphs = ctx.graphs;
	ctx.on('graphs/changed', () => host.refresh());
	const state = (): Record<string, unknown> => {
		const inspected = graphs.inspect();
		return {
			source: inspected.source,
			raw: typeof ctx.host.config().graph === 'string' ? ctx.host.config().graph : '',
			default: inspected.default,
			graphs: inspected.graphs,
			blocks: inspected.blocks,
			error: inspected.error,
			nodes: graphs.nodeNames(),
			routes: graphs.routeNames(),
		};
	};
	const current = (): string => graphs.source();
	const replaceBlock = (source: string, id: string, text: string): string => {
		const blocks = splitGraphBlocks(source);
		const next = blocks.map((block) => (block.id === id ? { id, source: text } : block));
		if (!next.some((block) => block.id === id)) {
			next.push({ id, source: text });
		}
		return composeGraphBlocks(next, defaultGraphId(source) ?? next[0]?.id ?? id);
	};
	return {
		state,
		async action(message) {
			const action = String(message.action ?? '');
			const source = current();
			try {
				if (action === 'save') {
					await graphs.setSource(String(message.source ?? source));
					return { message: 'Saved.' };
				}
				if (action === 'saveBlock') {
					const id = String(message.id ?? '');
					if (!id) {
						throw new Error('choose a graph first');
					}
					await graphs.setSource(replaceBlock(source, id, String(message.source ?? '')));
					return { message: `Saved ${id}.` };
				}
				if (action === 'validate' || action === 'validateBlock') {
					const draft =
						action === 'validateBlock'
							? replaceBlock(source, String(message.id ?? ''), String(message.source ?? ''))
							: String(message.source ?? source);
					const inspected = graphs.inspect(draft);
					return {
						message: inspected.error ? inspected.error : 'Valid.',
						error: inspected.error,
						graphs: inspected.graphs,
						blocks: inspected.blocks,
					};
				}
				if (action === 'reset') {
					await graphs.setSource('');
					return { message: 'Using the shipped graph.' };
				}
				if (action === 'setDefault') {
					const id = String(message.id ?? '');
					await graphs.setSource(setDefaultGraph(source, id));
					return { message: `${id} is the default graph.` };
				}
				if (action === 'add') {
					const id = String(message.id ?? '').trim().toLowerCase();
					if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
						throw new Error('graph ids are lowercase letters, digits, dot, dash or underscore');
					}
					if (graphs.names().includes(id)) {
						throw new Error(`graph ${id} already exists`);
					}
					const blocks = splitGraphBlocks(source);
					const first = (blocks.find((block) => block.id === defaultGraphId(source)) ?? blocks[0])?.source.trim() ?? '';
					const template = first
						? /(^|\n)\s*%%\s*graph\s*:/.test(first)
							? first.replace(/^\s*%%\s*graph\s*:\s*\S+/, `%% graph: ${id}`)
							: `%% graph: ${id}\n${first}`
						: undefined;
					await graphs.setSource(addGraphBlock(source, id, template));
					return { message: `Added ${id}.` };
				}
				if (action === 'duplicate') {
					const id = String(message.id ?? '');
					const newId = String(message.newId ?? `${id}-2`).trim().toLowerCase();
					if (!/^[a-z0-9][a-z0-9._-]*$/.test(newId)) {
						throw new Error('graph ids are lowercase letters, digits, dot, dash or underscore');
					}
					if (graphs.names().includes(newId)) {
						throw new Error(`graph ${newId} already exists`);
					}
					await graphs.setSource(duplicateGraphBlock(source, id, newId));
					return { message: `Duplicated ${id} as ${newId}.` };
				}
				if (action === 'remove') {
					const id = String(message.id ?? '');
					if (graphs.names().length <= 1) {
						throw new Error('the last graph cannot be removed');
					}
					await graphs.setSource(removeGraphBlock(source, id));
					return { message: `Removed ${id}.` };
				}
				return null;
			} catch (error) {
				return { message: error instanceof Error ? error.message : String(error), error: true };
			}
		},
	};
}

/** The pane spec the graph plugin registers. The client travels beside the extension's resources. */
export function graphPane(ctx: Context): PaneSpec {
	const resources = join(__dirname, '..', 'resources');
	return {
		id: 'graph',
		label: 'Graph',
		title: 'Graph — the Mermaid agent loop and its named variants',
		icon: ICON,
		order: 10,
		command: 'comonad.openGraph',
		markup: MARKUP,
		scripts: [join(resources, 'graph.js')],
		styles: [join(resources, 'graph.css')],
		controller: (host) => controller(ctx, host),
	};
}
