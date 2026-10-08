import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { compileGraphs } from '../lib/graph';
import { DEFAULT_GRAPH_SOURCE, parseGraphSource } from '../lib/mermaid';
import { APPROVAL_LABELS, gateFlow, modeCapabilities, MODE_LABELS, parseRule } from '../lib/policy';
import type { ContextForm } from '../lib/prompt';
import { INJECTION_POSITION } from '../lib/tavern/types';
import { describe } from '../lib/util';
import { profileKeyEnvs, type Config, type Profile } from '../services/settings';
import { contentController } from './tavern-content';
import { registerCommand } from './register';

/** Webview settings panel: tabs for the agent policy, the graph editor, MCP servers and tools. */

const DISPLAY_LABELS: Record<ContextForm, string> = {
	rendered: 'Rendered — folded thoughts and tool calls',
	token: 'Token — assistant text only',
	raw: 'Raw — the full record',
};

const CONTEXT_LABELS: Record<ContextForm, string> = {
	rendered: 'Rendered — text, thoughts, and tool results',
	token: 'Token — assistant text only',
	raw: 'Raw — the full record',
};

export function settingsPanel(ctx: Context): void {
	let panel: vscode.WebviewPanel | null = null;
	// The ST tab's editor: the four kinds of content, in the library this panel also configures.
	const content = contentController(ctx);

	/** Nodes and routes of a Mermaid source, or the reason it does not compile. */
	const inspectGraph = (source: string): { nodes: string[]; routes: string[]; error: string } => {
		try {
			const parsed = parseGraphSource(source.trim() || DEFAULT_GRAPH_SOURCE);
			compileGraphs(parsed, { nodes: new Map(), routes: new Map() }, { ignoreMissing: true });
			const nodes = new Set<string>();
			const routes = new Set<string>();
			for (const node of Object.values(parsed.graphs[parsed.default]?.nodes ?? {})) {
				if (node.use) {
					nodes.add(node.use);
				}
				if (node.route) {
					routes.add(node.route);
				}
			}
			return { nodes: [...nodes].sort(), routes: [...routes].sort(), error: '' };
		} catch (error) {
			return { nodes: [], routes: [], error: describe(error) };
		}
	};

	/** One level of directories for the working-directory picker. */
	const listDirs = (raw: string): { path: string; parent: string; entries: { name: string; path: string }[]; error: string } => {
		const home = ctx.settings.home();
		const wanted = raw.trim() || ctx.settings.workspace() || home;
		const expanded = wanted === '~' ? home : wanted.startsWith('~/') ? join(home, wanted.slice(2)) : wanted;
		const path = resolve(expanded);
		const parent = dirname(path) === path ? '' : dirname(path);
		try {
			const entries = readdirSync(path, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
				.sort((left, right) => left.name.localeCompare(right.name))
				.slice(0, 300);
			return { path, parent, entries, error: '' };
		} catch (error) {
			return { path, parent, entries: [], error: describe(error) };
		}
	};

	const asList = (value: unknown): string[] =>
		Array.isArray(value)
			? value.map((item) => String(item).trim()).filter(Boolean)
			: String(value ?? '')
					.split('\n')
					.map((line) => line.trim())
					.filter(Boolean);

	/** The rule lists from the Rules tab, rejecting anything `parseRule` cannot read. */
	const ruleList = (value: unknown, key: string): string[] => {
		const rules = asList(value);
		for (const rule of rules) {
			if (!parseRule(rule)) {
				throw new Error(`${key}: "${rule}" is not a rule — write tool or tool(pattern), e.g. run_shell(npm run test:*)`);
			}
		}
		return rules;
	};

	const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

	/** Writes what the panel sent, validating the graph first. */
	const apply = async (patch: Record<string, unknown>): Promise<void> => {
		const current = ctx.settings.get();
		const graph = String(patch.graph ?? current.graph).trim();
		const info = inspectGraph(graph);
		if (info.error) {
			throw new Error(`graph: ${info.error}`);
		}
		const next: Record<string, unknown> = {
			mode: patch.mode ?? current.mode,
			approval: patch.approval ?? current.approval,
			network: Boolean(patch.network),
			workingDirectory: String(patch.workingDirectory ?? '').trim(),
			commandTimeout: Math.max(1, Number(patch.commandTimeout) || current.commandTimeout),
			planDirectory: String(patch.planDirectory ?? '').trim(),
			denyReadPaths: asList(patch.denyReadPaths),
			maxSteps: Math.max(1, Number(patch.maxSteps) || current.maxSteps),
			displayForm: patch.displayForm ?? current.displayForm,
			contextForm: patch.contextForm ?? current.contextForm,
			model: String(patch.model ?? current.model),
			graph: graph === DEFAULT_GRAPH_SOURCE.trim() ? '' : graph,
			permissions: {
				allow: ruleList(patch.allow ?? current.permissions.allow, 'allow'),
				ask: ruleList(patch.ask ?? current.permissions.ask, 'ask'),
				deny: ruleList(patch.deny ?? current.permissions.deny, 'deny'),
			},
			...tavernPatch(patch, current),
		};
		for (const [key, value] of Object.entries(next)) {
			if (!same(current[key as keyof typeof current], value)) {
				await ctx.settings.update(key as keyof typeof current, value);
			}
		}
		// A moved source or a new character means re-reading; the reload emits `tavern/changed`.
		const before = JSON.stringify(tavernKeys.map((key) => current[key as keyof typeof current]));
		const after = JSON.stringify(tavernKeys.map((key) => next[key]));
		if (before !== after) {
			await ctx.tavern.reload();
		}
		if (patch.mcpServers && typeof patch.mcpServers === 'object') {
			await ctx.settings.update('mcpServers', patch.mcpServers);
			await ctx.mcp.reload();
		}
	};

	const pushState = async (refresh = false): Promise<void> => {
		if (!panel) {
			return;
		}
		const config = ctx.settings.get();
		const graph = config.graph || DEFAULT_GRAPH_SOURCE;
		void panel.webview.postMessage({
			type: 'state',
			config: {
				mode: config.mode,
				approval: config.approval,
				network: config.network,
				workingDirectory: config.workingDirectory,
				commandTimeout: config.commandTimeout,
				planDirectory: config.planDirectory,
				denyReadPaths: config.denyReadPaths,
				maxSteps: config.maxSteps,
				displayForm: config.displayForm,
				contextForm: config.contextForm,
				model: config.model,
				graph,
				permissions: config.permissions,
			},
			// The ST tab is fed here, beside `config`: `content` is the editor's slice (which kind,
			// which items, which item is being edited) and `tavern` is the settings half of that tab.
			content: content.state(),
			tavern: {
				enabled: config.tavernEnabled,
				character: config.tavernCharacter,
				persona: config.tavernPersona,
				userName: config.tavernUserName,
				lorebooks: config.tavernLorebooks,
				preset: config.tavernPreset,
				authorNote: config.tavernAuthorNote,
				noteDepth: config.tavernNoteDepth,
				wiFormat: config.tavernWiFormat,
				scenarioFormat: config.tavernScenarioFormat,
				personalityFormat: config.tavernPersonalityFormat,
				wi: {
					scanDepth: config.wiScanDepth,
					budget: config.wiBudget,
					budgetCap: config.wiBudgetCap,
					recursive: config.wiRecursive,
					maxRecursionSteps: config.wiMaxRecursionSteps,
					minActivations: config.wiMinActivations,
					maxActivationsDepth: config.wiMaxActivationsDepth,
					caseSensitive: config.wiCaseSensitive,
					matchWholeWords: config.wiMatchWholeWords,
					includeNames: config.wiIncludeNames,
					characterStrategy: config.wiCharacterStrategy,
					groupScoring: config.wiGroupScoring,
				},
			},
			catalog: {
				characters: ctx.tavern.characters.map((character) => ({ id: character.id, name: character.name, source: character.source })),
				personas: ctx.tavern.personas.map((persona) => ({ id: persona.id, name: persona.title || persona.name, source: persona.source })),
				books: ctx.tavern.books.map((book) => ({ name: book.name, entries: Object.keys(book.book.entries).length, source: book.source })),
				presets: ctx.tavern.presets.map((preset) => ({ id: preset.id, name: preset.name })),
			},
			labels: { modes: MODE_LABELS, approvals: APPROVAL_LABELS, displays: DISPLAY_LABELS, contexts: CONTEXT_LABELS },
			models: await ctx.llm.availableModels({ refresh }),
			mcpServers: config.mcpServers,
			mcp: ctx.mcp.status(),
			tools: ctx.tools.all().map((tool) => ({
				name: tool.name,
				capability: tool.capability,
				network: tool.needsNetwork,
				workspace: tool.needsWorkspace,
				description: tool.description,
			})),
			graphInfo: inspectGraph(graph),
			flow: gateFlow(),
			modeLegend: modeCapabilities(),
			defaultGraph: DEFAULT_GRAPH_SOURCE,
			workspace: config.workingDirectory,
			home: ctx.settings.home(),
		});
	};

	const handle = async (message: Record<string, unknown>): Promise<void> => {
		if (!panel) {
			return;
		}
		try {
			switch (message.type) {
				case 'refresh':
					// A refresh is the user asking the endpoints again, so skip the cached model lists.
					await pushState(true);
					return;
				case 'ready':
					await pushState();
					return;
				case 'validateGraph':
					void panel.webview.postMessage({ type: 'graphInfo', ...inspectGraph(String(message.source ?? '')) });
					return;
				case 'listDirs':
					void panel.webview.postMessage({ type: 'dirs', ...listDirs(String(message.path ?? '')) });
					return;
				case 'close':
					panel.dispose();
					return;
				case 'save':
					await apply((message.config ?? {}) as Record<string, unknown>);
					void panel.webview.postMessage({ type: 'ok', message: 'Saved.' });
					break;
				case 'configureModel':
					await vscode.commands.executeCommand('comonad.configureModel');
					break;
				case 'saveMcp': {
					const parsed = JSON.parse(String(message.json ?? '{}')) as Record<string, unknown>;
					await ctx.settings.update('mcpServers', parsed);
					await ctx.mcp.reload();
					void panel.webview.postMessage({ type: 'ok', message: 'MCP servers updated.' });
					break;
				}
				case 'reloadMcp':
					await ctx.mcp.reload();
					void panel.webview.postMessage({ type: 'ok', message: 'MCP servers reloaded.' });
					break;
				case 'content': {
					const note = await content.action(message);
					if (note) {
						void panel.webview.postMessage({ type: 'contentNote', ...note });
					}
					break;
				}
			}
		} catch (error) {
			void panel.webview.postMessage({ type: 'error', message: describe(error) });
		}
		await pushState();
	};

	/** Reveal the panel, optionally on one of its tabs — `st` is where the content lives. */
	const open = (tab?: string): void => {
		if (panel) {
			panel.reveal();
			if (tab) {
				void panel.webview.postMessage({ type: 'openTab', tab });
			}
			void pushState();
			return;
		}
		const extensionUri = ctx.host.extensionUri as vscode.Uri;
		panel = vscode.window.createWebviewPanel('comonad.settings', 'Comonad Settings', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
		});
		panel.onDidDispose(() => {
			panel = null;
		});
		panel.webview.html = html(panel.webview, extensionUri, tab === 'st' ? 'st' : 'agent');
		panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => void handle(message));
		void pushState();
	};

	ctx.on('settings/changed', () => void pushState());
	ctx.on('tools/changed', () => void pushState());
	// A reload or a save moves the content list, so the pane is told what the catalog now holds.
	ctx.on('tavern/changed', () => void pushState());

	registerCommand(ctx, 'comonad.openSettings', () => open());
	registerCommand(ctx, 'comonad.openContent', () => open('st'));
	registerCommand(ctx, 'comonad.reloadMcp', async () => {
		await ctx.mcp.reload();
		void vscode.window.showInformationMessage('Comonad: MCP servers reloaded.');
	});
	registerCommand(ctx, 'comonad.pickModel', () => pickModel(ctx));
	registerCommand(ctx, 'comonad.configureModel', () => configureModel(ctx));
}
settingsPanel.inject = ['host', 'settings', 'llm', 'tools', 'mcp', 'tavern', 'sessions', 'agent'];

export async function pickModel(ctx: Context): Promise<void> {
	const choices = await ctx.llm.availableModels({ refresh: true });
	const picked = await vscode.window.showQuickPick(
		[
			...choices.map((choice) => ({ label: choice.label, description: choice.description, id: choice.id })),
			{ label: '$(gear) Configure a provider…', description: 'Add an OpenAI-compatible endpoint', id: '' },
		],
		{ title: 'Comonad model', ignoreFocusOut: true },
	);
	if (!picked) {
		return;
	}
	if (!picked.id) {
		await configureModel(ctx);
		return;
	}
	await ctx.settings.update('model', picked.id);
}

export async function configureModel(ctx: Context): Promise<void> {
	const shipped = ctx.settings.get().profiles[0];
	const id = await vscode.window.showInputBox({
		prompt: 'Profile id (letters, digits, dash, no colon)',
		value: `${shipped?.id ?? 'my-model'}-2`,
		ignoreFocusOut: true,
	});
	if (!id) {
		return;
	}
	if (id.includes(':')) {
		void vscode.window.showWarningMessage('Comonad: a profile id cannot contain ":", it separates the model in `comonad.model`.');
		return;
	}
	const base = await vscode.window.showInputBox({ prompt: 'API base URL', value: shipped?.base ?? '', ignoreFocusOut: true });
	if (!base) {
		return;
	}
	// The key lookup is data on the profile: the environment variables named here are tried in order
	// before the OS keychain, and nothing in the code has to know the provider.
	const keyEnvAnswer = await vscode.window.showInputBox({
		prompt: 'Environment variable(s) holding the key, comma separated (optional)',
		value: profileKeyEnvs(shipped ?? { id: '', model: '' }).join(', '),
		ignoreFocusOut: true,
	});
	if (keyEnvAnswer === undefined) {
		return;
	}
	const keyEnv = keyEnvAnswer
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);
	const key = await vscode.window.showInputBox({
		prompt: keyEnv.length ? `API key — stored in the OS keychain; leave empty to read ${keyEnv.join(' or ')}` : 'API key (stored in the OS keychain)',
		password: true,
		ignoreFocusOut: true,
	});
	if (key === undefined) {
		return;
	}
	if (key) {
		await ctx.llm.setSecret(id, key);
	}
	const profile: Profile = { id, base, model: shipped?.model ?? '', keyEnv: keyEnv.length ? keyEnv : undefined, includeUsage: true };
	// Ask the endpoint what it offers, so the saved profile names a model that exists.
	const listed = await ctx.llm.endpointModels(profile, key || (await ctx.llm.resolveKey(profile)), true);
	const model = await vscode.window.showQuickPick(
		[...listed, ...(shipped?.model ? [shipped.model] : [])].filter((value, index, all) => all.indexOf(value) === index),
		{ title: `${id}: pick the model`, ignoreFocusOut: true },
	);
	if (!model) {
		const typed = await vscode.window.showInputBox({ prompt: 'Model name', value: shipped?.model ?? '', ignoreFocusOut: true });
		if (!typed) {
			return;
		}
		profile.model = typed;
	} else {
		profile.model = model;
	}
	const profiles = ctx.settings.get().profiles.filter((item) => item.id !== id);
	profiles.push(profile);
	await ctx.settings.update('profiles', profiles);
	await ctx.settings.update('model', `${id}:${profile.model}`);
	void vscode.window.showInformationMessage(`Comonad: profile ${id} saved (${profile.model}).`);
}

/** The content settings the panel owns, in one place so `apply` can diff them as a group. */
function tavernPatch(patch: Record<string, unknown>, current: Config): Record<string, unknown> {
	const text = (key: string, fallback: string): string => String(patch[key] ?? fallback).trim();
	const number = (key: string, fallback: number): number => {
		const value = Number(patch[key]);
		return Number.isFinite(value) && value >= 0 ? value : fallback;
	};
	return {
		tavernEnabled: patch.tavernEnabled === undefined ? current.tavernEnabled : Boolean(patch.tavernEnabled),
		tavernCharacter: text('tavernCharacter', current.tavernCharacter),
		tavernPersona: text('tavernPersona', current.tavernPersona),
		tavernUserName: text('tavernUserName', current.tavernUserName) || current.tavernUserName,
		tavernLorebooks: tavernList(patch.tavernLorebooks, current.tavernLorebooks),
		tavernPreset: text('tavernPreset', current.tavernPreset),
		tavernAuthorNote: String(patch.tavernAuthorNote ?? current.tavernAuthorNote),
		tavernNoteDepth: number('tavernNoteDepth', current.tavernNoteDepth),
		tavernWiFormat: String(patch.tavernWiFormat ?? current.tavernWiFormat),
		tavernScenarioFormat: String(patch.tavernScenarioFormat ?? current.tavernScenarioFormat),
		tavernPersonalityFormat: String(patch.tavernPersonalityFormat ?? current.tavernPersonalityFormat),
		wiScanDepth: number('wiScanDepth', current.wiScanDepth),
		wiBudget: number('wiBudget', current.wiBudget),
		wiBudgetCap: number('wiBudgetCap', current.wiBudgetCap),
		wiRecursive: patch.wiRecursive === undefined ? current.wiRecursive : Boolean(patch.wiRecursive),
		wiMaxRecursionSteps: number('wiMaxRecursionSteps', current.wiMaxRecursionSteps),
		wiMinActivations: number('wiMinActivations', current.wiMinActivations),
		wiMaxActivationsDepth: number('wiMaxActivationsDepth', current.wiMaxActivationsDepth),
		wiCaseSensitive: patch.wiCaseSensitive === undefined ? current.wiCaseSensitive : Boolean(patch.wiCaseSensitive),
		wiMatchWholeWords: patch.wiMatchWholeWords === undefined ? current.wiMatchWholeWords : Boolean(patch.wiMatchWholeWords),
		wiIncludeNames: patch.wiIncludeNames === undefined ? current.wiIncludeNames : Boolean(patch.wiIncludeNames),
		wiCharacterStrategy: number('wiCharacterStrategy', current.wiCharacterStrategy),
		wiGroupScoring: patch.wiGroupScoring === undefined ? current.wiGroupScoring : Boolean(patch.wiGroupScoring),
	};
}

/** The tavern keys whose change means the catalog has to be read again. */
const tavernKeys = ['tavernEnabled', 'tavernCharacter', 'tavernPersona', 'tavernLorebooks', 'tavernPreset'] as const;

/** A book list, from a textarea's lines or an array — a book name may not contain a comma. */
function tavernList(value: unknown, fallback: string[]): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => String(item).trim()).filter(Boolean);
	}
	if (typeof value === 'string') {
		return value
			.split('\n')
			.flatMap((line) => line.split(','))
			.map((name) => name.trim())
			.filter(Boolean);
	}
	return fallback;
}

/** A prompt's text for the preview: one line, clipped, so the panel never ships a whole block. */
function clipSource(text: string | undefined): string {
	const flat = (text ?? '').replace(/\s+/g, ' ').trim();
	return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri, tab: string): string {
	const nonce = randomBytes(16).toString('base64');
	const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'settings.js'));
	const pane = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'content.js'));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'settings.css'));
	const paneStyle = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'content.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; connect-src https://cdn.jsdelivr.net; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
<link rel="stylesheet" href="${paneStyle}" />
</head>
<body>
  <header id="bar">
    <nav id="tabs" role="tablist" aria-label="Comonad settings">
      <button class="tab" type="button" role="tab" data-tab="graph" title="Graph — the Mermaid agent loop">Graph</button>
      <button class="tab" type="button" role="tab" data-tab="agent" title="Agent — preset, model, policy, workspace">Agent</button>
      <button class="tab" type="button" role="tab" data-tab="st" title="ST — characters, world books, personas, presets and their settings">ST</button>
      <button class="tab" type="button" role="tab" data-tab="rules" title="Rules — allow, ask and deny rules for tool calls">Rules</button>
      <button class="tab" type="button" role="tab" data-tab="flow" title="Flow — how one tool call is gated">Flow</button>
      <button class="tab" type="button" role="tab" data-tab="mcp" title="MCP — servers and their status">MCP</button>
      <button class="tab" type="button" role="tab" data-tab="tools" title="Tools — what a turn may run">Tools</button>
    </nav>
    <span class="grow"></span>
    <button class="link" id="save" type="button" title="Save — write these settings to this workspace">Save</button>
    <button class="link" id="close" type="button" title="Close — unsaved edits are dropped">Close</button>
  </header>

  <section data-pane="agent">
    <div class="grid">
      <div class="field wide">
        <label for="model">Model</label>
        <div class="row">
          <select id="model" class="control" data-key="model"></select>
          <button class="secondary" id="model-refresh" type="button">Refresh</button>
          <button class="secondary" id="model-add" type="button">Add provider…</button>
        </div>
      </div>
      <div class="field">
        <label for="mode">Work mode</label>
        <select id="mode" class="control" data-key="mode"></select>
      </div>
      <div class="field">
        <label for="approval">Approval</label>
        <select id="approval" class="control" data-key="approval"></select>
      </div>
      <div class="field">
        <label for="display">Display</label>
        <select id="display" class="control" data-key="displayForm"></select>
      </div>
      <div class="field">
        <label for="context">Context</label>
        <select id="context" class="control" data-key="contextForm"></select>
      </div>
      <div class="field wide">
        <label for="network">Network</label>
        <label class="check"><input type="checkbox" id="network" data-key="network" /> Allow network tools, and network inside the shell sandbox</label>
      </div>
      <div class="field wide">
        <label for="wd">Working directory</label>
        <div class="combo">
          <input id="wd" class="control" type="text" data-key="workingDirectory" spellcheck="false" autocomplete="off" placeholder="Empty uses the first workspace folder" />
          <div id="dirs" hidden></div>
        </div>
      </div>
      <div class="field">
        <label for="timeout">Command timeout</label>
        <input id="timeout" class="control" type="number" min="1" data-key="commandTimeout" />
        <p class="hint">Seconds before a shell command is killed.</p>
      </div>
      <div class="field">
        <label for="plans">Plan directory</label>
        <input id="plans" class="control" type="text" data-key="planDirectory" spellcheck="false" placeholder=".comonad/plans" />
        <p class="hint">Workspace-relative folder for plan files.</p>
      </div>
      <div class="field wide">
        <label for="deny">Deny read paths</label>
        <textarea id="deny" class="control" data-key="denyReadPaths" spellcheck="false" rows="3"></textarea>
        <p class="hint">One workspace-relative path or basename per line — file and shell tools refuse to read or write them.</p>
      </div>
    </div>
  </section>

  <section data-pane="graph" hidden>
    <div id="graph-wrap">
      <div class="field">
        <label for="graph">Graph</label>
        <textarea id="graph" class="control" data-key="graph" spellcheck="false"></textarea>
        <div class="row">
          <button class="secondary" id="graph-reset" type="button">Use default</button>
        </div>
      </div>
      <div class="field">
        <label>Preview</label>
        <div id="preview" class="diagram"></div>
      </div>
    </div>
    <div class="grid" style="margin-top:14px">
      <div class="field">
        <label for="steps">Max steps</label>
        <input id="steps" class="control" type="number" min="1" data-key="maxSteps" />
        <p class="hint">Maximum graph steps per turn.</p>
      </div>
    </div>
    <p class="hint error" id="graph-error"></p>
    <p class="hint" id="graph-nodes"></p>
    <p class="hint" id="graph-routes"></p>
  </section>

  <section data-pane="st" hidden>
    <div id="st-pane" data-view="content">
      <nav id="st-tabs" role="tablist" aria-label="SillyTavern content">
        <button class="subtab" type="button" role="tab" data-st="characters" title="Characters — cards in Comonad's library">Characters</button>
        <button class="subtab" type="button" role="tab" data-st="lorebooks" title="World books — keyword-scanned lore">World books</button>
        <button class="subtab" type="button" role="tab" data-st="personas" title="Personas — who the user is">Personas</button>
        <button class="subtab" type="button" role="tab" data-st="presets" title="Presets — prompts, order and samplers">Presets</button>
        <button class="subtab" type="button" role="tab" data-st="settings" title="Settings — defaults and the keyword scan">Settings</button>
      </nav>

      <div id="st-actions">
        <button class="secondary" id="st-new" type="button" title="Start a new item">New</button>
        <button class="secondary" id="st-duplicate" type="button" title="Copy this item into a new one">Duplicate</button>
        <button class="secondary danger" id="st-delete" type="button" title="Delete the file from Comonad's library">Delete</button>
        <span class="grow"></span>
        <button class="link" id="st-reveal" type="button" title="Open this folder in the file manager">Folder</button>
        <button class="link" id="st-save" type="button" title="Write this item to the library">Save</button>
      </div>

      <div id="st-split">
        <aside id="st-list">
          <div id="st-items"></div>
          <p class="hint" id="st-library"></p>
        </aside>
        <section id="st-form"></section>
      </div>
      <p class="hint" id="st-status"></p>

      <div id="st-pane-settings">
        <div class="grid">
          <div class="field wide">
            <label for="tavern-enabled">Content layer</label>
            <label class="check"><input type="checkbox" id="tavern-enabled" data-key="tavernEnabled" /> Layer a character, world books, a persona and a preset on the agent prompt</label>
            <p class="hint">With this off nothing from the content layer reaches a request; the agent prompt is sent on its own.</p>
          </div>
          <div class="field">
            <label for="tavern-character">Default character</label>
            <select id="tavern-character" class="control" data-key="tavernCharacter"></select>
            <p class="hint">New chats speak as this card. <strong>Comonad: Pick Character</strong> (or <code>/char</code>) binds one to a single chat and inserts its opening line.</p>
          </div>
          <div class="field">
            <label for="tavern-persona">Default persona</label>
            <select id="tavern-persona" class="control" data-key="tavernPersona"></select>
            <p class="hint">Who the user is: the <code>{{user}}</code> name and description.</p>
          </div>
          <div class="field">
            <label for="tavern-preset">Default preset</label>
            <select id="tavern-preset" class="control" data-key="tavernPreset"></select>
            <p class="hint">Prompts, order and samplers for new chats — the Presets sub-tab edits them.</p>
          </div>
          <div class="field">
            <label for="tavern-user">User name</label>
            <input id="tavern-user" class="control" type="text" data-key="tavernUserName" spellcheck="false" />
            <p class="hint">What <code>{{user}}</code> expands to when no persona is selected.</p>
          </div>
          <div class="field">
            <label for="tavern-note-depth">Author's note depth</label>
            <input id="tavern-note-depth" class="control" type="number" min="0" data-key="tavernNoteDepth" />
          </div>
          <div class="field wide">
            <label for="tavern-note">Author's note</label>
            <textarea id="tavern-note" class="control" data-key="tavernAuthorNote" spellcheck="false" rows="3" placeholder="Standing instruction, injected {{depth}} messages from the end"></textarea>
            <p class="hint">Also settable per chat with <code>/note</code>.</p>
          </div>
          <div class="field wide">
            <label for="tavern-books">World books</label>
            <textarea id="tavern-books" class="control" data-key="tavernLorebooks" spellcheck="false" rows="4" placeholder="One book name per line"></textarea>
            <p class="hint">Scanned for keywords every turn, for chats that do not pick their own. <code>/lore</code> changes it per chat; a card's own book comes along without being listed.</p>
            <p class="hint" id="books-known"></p>
          </div>
          <div class="field">
            <label for="wi-scan">Scan depth</label>
            <input id="wi-scan" class="control" type="number" min="0" data-key="wiScanDepth" />
            <p class="hint">How many recent messages are searched for keys.</p>
          </div>
          <div class="field">
            <label for="wi-budget">Budget %</label>
            <input id="wi-budget" class="control" type="number" min="0" data-key="wiBudget" />
            <p class="hint">Share of the context window entries may take.</p>
          </div>
          <div class="field">
            <label for="wi-cap">Budget cap</label>
            <input id="wi-cap" class="control" type="number" min="0" data-key="wiBudgetCap" />
            <p class="hint">Hard token cap, whatever the percentage allows. 0 disables it.</p>
          </div>
          <div class="field">
            <label for="wi-strategy">Book order</label>
            <select id="wi-strategy" class="control" data-key="wiCharacterStrategy"></select>
          </div>
          <div class="field">
            <label for="wi-min">Minimum activations</label>
            <input id="wi-min" class="control" type="number" min="0" data-key="wiMinActivations" />
            <p class="hint">Keep scanning further back until this many entries are active.</p>
          </div>
          <div class="field">
            <label for="wi-min-depth">Activation depth</label>
            <input id="wi-min-depth" class="control" type="number" min="0" data-key="wiMaxActivationsDepth" />
          </div>
          <div class="field">
            <label for="wi-recursion">Recursion</label>
            <label class="check"><input type="checkbox" id="wi-recursion" data-key="wiRecursive" /> Let activated entries activate more</label>
          </div>
          <div class="field">
            <label for="wi-recursion-steps">Recursion steps</label>
            <input id="wi-recursion-steps" class="control" type="number" min="0" data-key="wiMaxRecursionSteps" />
            <p class="hint">0 means unlimited passes.</p>
          </div>
          <div class="field">
            <label for="wi-case">Matching</label>
            <label class="check"><input type="checkbox" id="wi-case" data-key="wiCaseSensitive" /> Case sensitive</label>
            <label class="check"><input type="checkbox" id="wi-words" data-key="wiMatchWholeWords" /> Whole words only</label>
            <label class="check"><input type="checkbox" id="wi-names" data-key="wiIncludeNames" /> Prefix entries with their title</label>
            <label class="check"><input type="checkbox" id="wi-groups" data-key="wiGroupScoring" /> Score groups together</label>
          </div>
          <div class="field wide">
            <label for="wi-format">Entry format</label>
            <input id="wi-format" class="control" type="text" data-key="tavernWiFormat" spellcheck="false" placeholder="{0}" />
            <p class="hint">Wrapper around activated entries: <code>{0}</code> is the entry text, e.g. <code>[Details: {0}]</code>.</p>
          </div>
          <div class="field">
            <label for="fmt-scenario">Scenario format</label>
            <input id="fmt-scenario" class="control" type="text" data-key="tavernScenarioFormat" spellcheck="false" />
          </div>
          <div class="field">
            <label for="fmt-personality">Personality format</label>
            <input id="fmt-personality" class="control" type="text" data-key="tavernPersonalityFormat" spellcheck="false" />
          </div>
          <div class="field wide">
            <label>Catalog</label>
            <p class="hint" id="catalog-summary"></p>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section data-pane="rules" hidden>
    <div class="grid">
      <div class="field wide">
        <label for="rules-deny">Deny</label>
        <textarea id="rules-deny" class="control" data-key="permissions" spellcheck="false" rows="3" placeholder="run_shell(rm:*)"></textarea>
        <p class="hint">Rejected in every policy, before anything else — the deny rules win over the rest.</p>
      </div>
      <div class="field wide">
        <label for="rules-ask">Ask</label>
        <textarea id="rules-ask" class="control" data-key="permissions" spellcheck="false" rows="3" placeholder="run_shell(git push:*)"></textarea>
        <p class="hint">Always confirmed before they run, even under an accept policy.</p>
      </div>
      <div class="field wide">
        <label for="rules-allow">Allow</label>
        <textarea id="rules-allow" class="control" data-key="permissions" spellcheck="false" rows="3" placeholder="run_shell(npm run test:*)"></textarea>
        <p class="hint">Run without asking, even under Ask. One rule per line: <code>tool</code> or <code>tool(pattern)</code> — <code>run_shell(npm run test:*)</code>, <code>read_file(./.env)</code>, <code>fetch_url(domain:example.com)</code>. “Always allow” in the approval prompt appends here.</p>
      </div>
    </div>
  </section>

  <section data-pane="flow" hidden>
    <div class="field wide">
      <label>Tool call gate</label>
      <p class="hint">Every call walks the gates in order and leaves at the first one that stops it. The framed part is what you configure: the rules from the <strong>Rules</strong> tab, then the approval policy for the calls no rule matched.</p>
      <ul class="legend" id="flow-legend"></ul>
      <p class="hint">Red ends the call, amber asks you first, green runs without asking.</p>
    </div>
    <div id="flow" class="diagram"></div>
  </section>

  <section data-pane="mcp" hidden>
    <div class="grid">
      <div class="field wide">
        <label for="mcp">Servers</label>
        <textarea id="mcp" class="control" spellcheck="false" style="min-height:160px"></textarea>
        <p class="hint">JSON object keyed by server name: { "name": { "command": "npx", "args": ["-y", "server"], "capability": "ro" } }</p>
        <div class="row">
          <button class="secondary" id="mcp-save" type="button">Save and reload</button>
          <button class="secondary" id="mcp-reload" type="button">Reload</button>
        </div>
      </div>
      <div class="field wide">
        <label>Status</label>
        <table id="mcp-status"></table>
      </div>
    </div>
  </section>

  <section data-pane="tools" hidden>
    <div class="grid">
      <div class="field wide">
        <label>Tools</label>
        <p class="hint">Every registered tool with what it needs. The work mode and the approval policy decide which ones a turn may actually use.</p>
        <table id="tools"></table>
      </div>
    </div>
  </section>

  <div id="status"></div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script nonce="${nonce}" src="${pane}"></script>
<script nonce="${nonce}" src="${script}" data-tab="${tab}"></script>
</body>
</html>`;
}
