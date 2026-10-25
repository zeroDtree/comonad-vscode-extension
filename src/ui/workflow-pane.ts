// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path';
import type { Context } from 'cordis';
import type { PaneController, PaneHost, PaneSpec } from '../services/panes';

/** The Workflow settings tab: the library, its stages, and a JSON escape hatch. */

const ICON =
	'<svg viewBox="0 0 16 16"><rect x="2.2" y="3" width="3.2" height="3.2" rx=".8"/><rect x="10.6" y="3" width="3.2" height="3.2" rx=".8"/><rect x="6.4" y="9.8" width="3.2" height="3.2" rx=".8"/><path d="M5.6 4.6h4.8M4.2 6.4l2.6 3.2M11.8 6.4l-2.6 3.2"/></svg>';

const MARKUP = `  <h1 class="page-title">Workflows</h1>
  <p class="group-note">A workflow is a sequence of stages. An <b>agent</b> stage runs a named graph with its own mode, objective and gate; a <b>checks</b> stage runs the host's diagnostics and commands and can send the run back to an earlier agent stage. The shipped <code>standard</code> workflow is the best-practice preset; duplicate it to make a variant.</p>
  <div class="w-top">
    <label class="check"><input type="checkbox" id="w-enabled" /> Run workflows automatically</label>
    <span class="w-label">Default</span>
    <select id="w-default" class="control w-select"></select>
    <span id="w-automatic" class="w-note"></span>
    <span class="w-spacer"></span>
    <span id="w-status" class="w-note"></span>
    <button class="secondary" id="w-validate" type="button">Validate</button>
    <button class="primary" id="w-save" type="button">Save</button>
  </div>
  <div id="w-errors" class="w-errors" hidden></div>
  <div class="w-layout" id="w-layout">
    <aside class="w-list">
      <div class="w-list-head"><span>Library</span><button class="secondary" id="w-new" type="button">+ New</button></div>
      <div id="w-workflows"></div>
    </aside>
    <section class="w-main">
      <div class="w-meta">
        <div class="w-meta-row">
          <label>Name <input id="w-name" class="control" type="text" /></label>
          <label>Id <input id="w-id" class="control w-mono" type="text" /></label>
          <label>When
            <select id="w-when" class="control">
              <option value="auto">Auto — coding tasks</option>
              <option value="always">Always</option>
              <option value="manual">Manual — /workflow only</option>
            </select>
          </label>
          <span class="w-spacer"></span>
          <button class="secondary" id="w-duplicate" type="button">Duplicate</button>
          <button class="secondary" id="w-delete" type="button">Delete</button>
        </div>
        <label class="w-desc">Description <input id="w-description" class="control" type="text" /></label>
        <p class="w-hint">Auto uses the default workflow for coding tasks. Always runs this workflow first. Manual only runs from <code>/workflow &lt;id&gt; &lt;task&gt;</code>.</p>
      </div>
      <div class="w-pipeline" id="w-pipeline"></div>
      <div class="w-stages" id="w-stages"></div>
      <div class="w-add-row">
        <button class="secondary" id="w-add-agent" type="button">+ Agent stage</button>
        <button class="secondary" id="w-add-checks" type="button">+ Checks stage</button>
      </div>
    </section>
    <aside class="w-inspector" id="w-inspector"></aside>
  </div>
  <div class="w-bottom">
    <div class="w-mode-tabs" role="tablist" aria-label="Workflow editor mode">
      <button type="button" class="w-mode active" data-wmode="visual">Visual</button>
      <button type="button" class="w-mode" data-wmode="json">JSON</button>
    </div>
    <div id="w-run" class="w-run" hidden></div>
    <div id="w-json-wrap" hidden>
      <textarea id="w-json" class="control w-json" spellcheck="false"></textarea>
      <div class="row">
        <button class="secondary" id="w-json-apply" type="button">Apply JSON</button>
        <button class="secondary" id="w-json-validate" type="button">Validate JSON</button>
        <span id="w-json-status" class="w-note"></span>
      </div>
    </div>
  </div>`;

function controller(ctx: Context, host: PaneHost): PaneController {
	const workflows = ctx.workflows;
	ctx.on('workflows/changed', () => host.refresh());
	ctx.on('agent/workflow', () => host.refresh());
	const state = (): Record<string, unknown> => {
		const library = workflows.library();
		const session = ctx.sessions.active();
		return {
			library,
			graphs: ctx.graphs.list().map((graph) => ({ id: graph.id, default: graph.default, nodes: graph.nodes.length, error: undefined })),
			validation: workflows.validate(library),
			run: session?.workflow ?? null,
			workspace: ctx.settings.workspace(),
		};
	};
	return {
		state,
		async action(message) {
			const action = String(message.action ?? '');
			try {
				if (action === 'save') {
					const library = message.library;
					const validation = workflows.validate(library);
					if (validation.errors.length) {
						return { message: 'Fix the errors before saving.', errors: validation.errors, error: true };
					}
					await workflows.saveLibrary(library);
					return { message: 'Workflow library saved.' };
				}
				if (action === 'validate') {
					const validation = workflows.validate(message.library);
					return {
						message: validation.errors.length ? validation.errors[0] : 'Valid.',
						errors: validation.errors,
						error: validation.errors.length > 0,
					};
				}
				if (action === 'suggest') {
					const suggestions = await workflows.suggestCommands(ctx.settings.workspace());
					return { suggestions, message: suggestions.length ? 'Suggested commands.' : 'No package.json checks found.' };
				}
				return null;
			} catch (error) {
				return { message: error instanceof Error ? error.message : String(error), error: true };
			}
		},
	};
}

export function workflowPane(ctx: Context): PaneSpec {
	const resources = join(__dirname, '..', 'resources');
	return {
		id: 'workflow',
		label: 'Workflow',
		title: 'Workflow — staged tasks, gates and host checks',
		icon: ICON,
		order: 20,
		command: 'comonad.openWorkflow',
		markup: MARKUP,
		scripts: [join(resources, 'workflow.js')],
		styles: [join(resources, 'workflow.css')],
		controller: (host) => controller(ctx, host),
	};
}
