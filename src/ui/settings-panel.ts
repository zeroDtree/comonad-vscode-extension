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
	// The ST tab's editor: the four kinds of content, in the library this panel also configures. It
	// asks this late-bound panel for a URI, because an avatar is a file outside the extension folder.
	const content = contentController(ctx, {
		uri: (file) => (panel ? String(panel.webview.asWebviewUri(vscode.Uri.file(file))) : ''),
	});

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
			// The library folders come along: a persona's picture is a file the content pane displays.
			localResourceRoots: [
				vscode.Uri.joinPath(extensionUri, 'resources'),
				...ctx.tavern.roots().map((root) => vscode.Uri.file(root)),
			],
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
	// The world-book page is its own guest module: it is loaded before the content pane, which hands
	// the `lorebooks` kind over to it.
	const book = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'worldinfo.js'));
	const bookStyle = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'worldinfo.css'));
	// The persona page is a guest module of its own: it is loaded before the content pane, which hands
	// the `personas` kind over to it.
	const persona = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'persona.js'));
	const personaStyle = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'persona.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; connect-src https://cdn.jsdelivr.net; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
<link rel="stylesheet" href="${paneStyle}" />
<link rel="stylesheet" href="${bookStyle}" />
<link rel="stylesheet" href="${personaStyle}" />
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
    <button class="primary" id="save" type="button" title="Save — write these settings to this workspace">Save</button>
    <button class="secondary" id="close" type="button" title="Close — unsaved edits are dropped">Close</button>
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

      <!-- The world-book page: SillyTavern's Worlds/Lorebooks panel, in the order it has it — the
           active worlds and the global activation knobs on top, then the book toolbar, then the
           entry list, where every row unfolds into its own editor. The list itself is drawn by
           resources/worldinfo.js from the template below. -->
      <div id="wi-panel">
        <div id="wi-top">
          <div class="wi-block">
            <small class="wi-label">Active World(s) for all chats</small>
            <select id="wi-worlds" multiple size="4" title="Books every chat scans, whatever else is selected"></select>
          </div>
          <div class="wi-block">
            <small class="wi-label">Global World Info/Lorebook activation settings</small>
            <div class="wi-drawer">
              <button class="wi-drawer-head" id="wi-global-toggle" type="button" aria-expanded="false"><b>Click to expand</b><span class="wi-chev">▾</span></button>
              <div class="wi-drawer-body" id="wi-global" hidden>
                <div class="wi-sliders">
                  <label class="wi-slider"><small>Scan Depth</small><input type="range" id="wi-g-scan-range" min="0" max="1000" step="1" /><input type="number" id="wi-g-scan" min="0" max="1000" step="1" /></label>
                  <label class="wi-slider"><small>Context %</small><input type="range" id="wi-g-budget-range" min="1" max="100" step="1" /><input type="number" id="wi-g-budget" min="1" max="100" step="1" /></label>
                  <label class="wi-slider" title="0 disables the cap"><small>Budget Cap</small><input type="range" id="wi-g-cap-range" min="0" max="65536" step="1" /><input type="number" id="wi-g-cap" min="0" max="65536" step="1" /></label>
                  <label class="wi-slider" title="Scan further back until this many entries are active"><small>Min Activations</small><input type="range" id="wi-g-min-range" min="0" max="100" step="1" /><input type="number" id="wi-g-min" min="0" max="100" step="1" /></label>
                  <label class="wi-slider" title="0 = unlimited, use the budget"><small>Max Depth</small><input type="range" id="wi-g-depth-range" min="0" max="100" step="1" /><input type="number" id="wi-g-depth" min="0" max="100" step="1" /></label>
                  <label class="wi-slider" title="0 = unlimited, 1 = scan once without recursing"><small>Max Recursion Steps</small><input type="range" id="wi-g-steps-range" min="0" max="10" step="1" /><input type="number" id="wi-g-steps" min="0" max="10" step="1" /></label>
                  <label class="wi-slider"><small>Insertion Strategy</small><select id="wi-g-strategy"></select></label>
                  <label class="wi-slider" title="The lowest cosine similarity an entry needs to be injected"><small>Score Threshold</small><input type="range" id="wi-g-vector-threshold-range" min="0" max="1" step="0.05" /><input type="number" id="wi-g-vector-threshold" min="0" max="1" step="0.05" /></label>
                  <label class="wi-slider" title="How many vectorized entries one book may contribute to a turn"><small>Max Entries</small><input type="number" id="wi-g-vector-entries" min="0" max="50" step="1" /></label>
                  <label class="wi-slider" title="How many of the newest messages form the search query"><small>Query Messages</small><input type="number" id="wi-g-vector-query" min="1" max="20" step="1" /></label>
                  <label class="wi-slider" title="The embedding model to ask for"><small>Embedding Model</small><input type="text" id="wi-g-vector-model" spellcheck="false" /></label>
                </div>
                <div class="wi-global-checks">
                  <label class="wi-inline"><input type="checkbox" id="wi-g-names" /> Include Names</label>
                  <label class="wi-inline"><input type="checkbox" id="wi-g-recursive" /> Recursive Scan</label>
                  <label class="wi-inline"><input type="checkbox" id="wi-g-case" /> Case-sensitive</label>
                  <label class="wi-inline"><input type="checkbox" id="wi-g-words" /> Match Whole Words</label>
                  <label class="wi-inline"><input type="checkbox" id="wi-g-scoring" /> Use Group Scoring</label>
                  <label class="wi-inline" title="Warn when the budget stops the scan"><input type="checkbox" id="wi-g-overflow" /> Alert On Overflow</label>
                  <label class="wi-inline" title="Run the automation an entry names when that entry activates"><input type="checkbox" id="wi-g-automation" /> Automation</label>
                  <label class="wi-inline" title="Find entries marked vectorized by meaning instead of by keys"><input type="checkbox" id="wi-g-vector" /> Vectorized</label>
                </div>
              </div>
            </div>
          </div>
        </div>

        <hr />

        <div id="wi-toolbar">
          <button class="secondary" id="wi-create" type="button">Create</button>
          <small class="wi-or">or</small>
          <select id="wi-pick" title="Pick a book to edit"></select>
          <span class="grow"></span>
          <div class="group">
            <button class="secondary" id="wi-import" type="button" title="Copy world info files into Comonad's library">Import</button>
            <button class="secondary" id="wi-export" type="button" title="Write this book to a file">Export</button>
            <button class="secondary" id="wi-rename" type="button" title="Rename this book">Rename</button>
            <button class="secondary" id="wi-duplicate" type="button" title="Copy this book into a new file">Duplicate</button>
            <button class="secondary danger" id="wi-delete" type="button" title="Delete this book's file">Delete</button>
          </div>
        </div>

        <div id="wi-toolbar2">
          <div class="group">
            <button class="secondary" id="wi-add" type="button" title="New entry">＋</button>
            <button class="secondary" id="wi-open-all" type="button" title="Open every entry">Open all</button>
            <button class="secondary" id="wi-close-all" type="button" title="Fold every entry">Close all</button>
            <button class="secondary" id="wi-backfill" type="button" title="Fill empty titles with the entry's keys">Fill titles</button>
            <button class="secondary" id="wi-apply-order" type="button" title="Write the current order into every entry's Order">Apply as Order</button>
          </div>
          <div class="group push">
            <input id="wi-search" class="control" type="search" placeholder="Search..." />
            <select id="wi-sort" title="Sort the list"></select>
            <button class="secondary" id="wi-refresh" type="button" title="Re-read the library from disk">Refresh</button>
            <select id="wi-page-size" title="Entries per page"></select>
            <span id="wi-pager"></span>
          </div>
        </div>

        <div id="wi-headers">
          <small class="wi-h-title">Title/Memo</small>
          <small class="wi-h-state">Strategy</small>
          <small class="wi-h-pos">Position</small>
          <small class="wi-h-num">Depth</small>
          <small class="wi-h-num">Order</small>
          <small class="wi-h-num">Trigger %</small>
        </div>
        <div id="wi-list"></div>
        <p class="hint" id="wi-status"></p>
        <datalist id="wi-automation-options"></datalist>
        <datalist id="wi-key-options"></datalist>
        <div id="wi-modal" hidden>
          <div class="wi-modal-body">
            <p class="wi-modal-text" id="wi-modal-text"></p>
            <select id="wi-modal-select"></select>
            <div class="wi-modal-buttons">
              <button class="secondary" type="button" data-answer="">Cancel</button>
              <button class="secondary" type="button" data-answer="move">Move</button>
              <button class="secondary" type="button" data-answer="copy">Copy</button>
            </div>
          </div>
        </div>
      </div>

      <template id="wi-entry-tpl">
        <div class="wi-entry">
          <div class="wi-row">
            <span class="wi-grip" title="Drag to reorder">☰</span>
            <button class="wi-fold" type="button" title="Open this entry"></button>
            <button class="wi-kill" type="button" title="Toggle the entry's active state"></button>
            <textarea class="wi-title" rows="1" placeholder="Entry Title/Memo" spellcheck="false"></textarea>
            <select class="wi-state" title="Entry status"></select>
            <select class="wi-row-position" title="Where the entry is injected"></select>
            <input class="wi-num wi-row-depth" type="number" min="0" title="Depth" />
            <input class="wi-num wi-row-order" type="number" min="0" title="Order" />
            <input class="wi-num wi-row-prob" type="number" min="0" max="100" title="Trigger %" />
            <span class="wi-buttons">
              <button class="wi-move" type="button" title="Move or copy this entry to another book">⇄</button>
              <button class="wi-copy" type="button" title="Duplicate this entry">⧉</button>
              <button class="wi-drop" type="button" title="Delete this entry">✕</button>
            </span>
          </div>
          <div class="wi-edit" hidden>
            <div class="wi-line">
              <div class="wi-field wi-keys">
                <small>Primary Keywords</small>
                <div class="wi-chips" data-for="key"></div>
                <input class="wi-chip-input" data-for="key" type="text" placeholder="Keywords or Regexes" spellcheck="false" />
                <button class="wi-plain" data-for="key" type="button" title="Switch to plaintext mode">✨</button>
                <textarea class="wi-chip-text" data-for="key" rows="2" placeholder="Comma separated list" spellcheck="false" hidden></textarea>
              </div>
              <div class="wi-field wi-thin"><small>Logic</small><select class="wi-logic"></select></div>
              <div class="wi-field wi-keys">
                <small>Optional Filter</small>
                <div class="wi-chips" data-for="keysecondary"></div>
                <input class="wi-chip-input" data-for="keysecondary" type="text" placeholder="Keywords or Regexes (ignored if empty)" spellcheck="false" />
                <button class="wi-plain" data-for="keysecondary" type="button" title="Switch to plaintext mode">✨</button>
                <textarea class="wi-chip-text" data-for="keysecondary" rows="2" placeholder="Comma separated list (ignored if empty)" spellcheck="false" hidden></textarea>
              </div>
            </div>
            <div class="wi-line">
              <div class="wi-field"><small>Outlet Name</small><input class="wi-outlet" type="text" placeholder="Outlet Name" spellcheck="false" /></div>
              <div class="wi-field"><small>Scan Depth</small><input class="wi-scan" type="number" placeholder="Use global setting" /></div>
              <div class="wi-field"><small>Case-Sensitive</small><select class="wi-case"></select></div>
              <div class="wi-field"><small>Whole Words</small><select class="wi-words"></select></div>
              <div class="wi-field"><small>Group Scoring</small><select class="wi-scoring"></select></div>
              <div class="wi-field"><small>Recursion Level</small><input class="wi-level" type="text" placeholder="1" /></div>
            </div>
            <div class="wi-content">
              <div class="wi-content-head">
                <small>Content <span class="wi-tokens"></span> <span class="wi-uid"></span></small>
                <div class="wi-flags">
                  <label class="wi-inline" title="This entry is never activated by another entry"><input type="checkbox" class="wi-exclude-recursion" /> Non-recursable</label>
                  <label class="wi-inline" title="This entry does not activate other entries"><input type="checkbox" class="wi-prevent-recursion" /> Prevent further recursion</label>
                  <label class="wi-inline" title="Only reachable by a recursive scan"><input type="checkbox" class="wi-delay-until" /> Delay until recursion</label>
                  <label class="wi-inline" title="Included even when the budget is spent"><input type="checkbox" class="wi-ignore-budget" /> Ignore budget</label>
                </div>
              </div>
              <textarea class="wi-body" rows="8" placeholder="What this keyword should mean to the AI, sent verbatim" spellcheck="false"></textarea>
            </div>
            <div class="wi-line">
              <div class="wi-field wi-group">
                <small>Inclusion Group <label class="wi-inline" title="This entry wins over the other members"><input type="checkbox" class="wi-override" /> Prioritize</label></small>
                <input class="wi-group-name" type="text" placeholder="Only one entry with the same label will be activated" spellcheck="false" />
              </div>
              <div class="wi-field"><small>Group Weight</small><input class="wi-weight" type="number" min="1" placeholder="100" /></div>
              <div class="wi-field"><small>Sticky</small><input class="wi-sticky" type="number" min="0" placeholder="Non-sticky" /></div>
              <div class="wi-field"><small>Cooldown</small><input class="wi-cooldown" type="number" min="0" placeholder="No cooldown" /></div>
              <div class="wi-field"><small>Delay</small><input class="wi-delay-turns" type="number" min="0" placeholder="No delay" /></div>
            </div>
            <div class="wi-line">
              <div class="wi-field"><small>Automation ID</small><input class="wi-automation" type="text" list="wi-automation-options" placeholder="Automation ID" spellcheck="false" /></div>
              <div class="wi-field wi-wide">
                <small>Filter to Generation Triggers</small>
                <select class="wi-triggers" multiple size="4"></select>
              </div>
            </div>
            <div class="wi-line">
              <div class="wi-field wi-wide">
                <small>Filter to Characters or Tags <label class="wi-inline" title="Turn the filter around: these characters and tags are excluded"><input type="checkbox" class="wi-filter-exclude" /> Exclude</label></small>
                <select class="wi-filter" multiple size="4"></select>
              </div>
            </div>
            <div class="wi-foot">
              <label class="wi-inline"><input type="checkbox" class="wi-selective" /> Selective</label>
              <label class="wi-inline"><input type="checkbox" class="wi-use-probability" /> Use Probability</label>
              <label class="wi-inline"><input type="checkbox" class="wi-memo" /> Add Memo</label>
            </div>
            <div class="wi-sources">
              <button class="wi-sources-head" type="button" aria-expanded="false">Additional Matching Sources <span class="wi-chev">▾</span></button>
              <div class="wi-sources-body" hidden>
                <label class="wi-inline"><input type="checkbox" class="wi-m-desc" /> Character Description</label>
                <label class="wi-inline"><input type="checkbox" class="wi-m-pers" /> Character Personality</label>
                <label class="wi-inline"><input type="checkbox" class="wi-m-scenario" /> Scenario</label>
                <label class="wi-inline"><input type="checkbox" class="wi-m-persona" /> Persona Description</label>
                <label class="wi-inline"><input type="checkbox" class="wi-m-depth" /> Character's Note</label>
                <label class="wi-inline"><input type="checkbox" class="wi-m-creator" /> Creator's Notes</label>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- The persona page: SillyTavern's Persona Management, in its own order — the avatar tiles on
           the left with search, sort, pagination, the grid toggle and the upload tile, and the open
           persona on the right with its picture, description, position, connections, lorebook and the
           persona-wide settings. Drawn by resources/persona.js from the template below. -->
      <div id="pf-panel">
        <div id="pf-head">
          <small class="pf-label">Persona Management</small>
          <span class="grow"></span>
          <button class="link" id="pf-backup" type="button" title="Write every persona to one file SillyTavern can restore">Backup</button>
          <button class="link" id="pf-restore" type="button" title="Read personas back from a backup file">Restore</button>
        </div>
        <div id="pf-split">
          <div id="pf-left">
            <div id="pf-tools">
              <button class="secondary" id="pf-create" type="button" title="Create a persona">Create</button>
              <input id="pf-search" class="control" type="search" placeholder="Search…" autocomplete="off" />
              <select id="pf-sort" class="control" title="How the list is ordered">
                <option value="asc">A-Z</option>
                <option value="desc">Z-A</option>
                <option value="search" hidden>Search</option>
              </select>
              <button class="icon" id="pf-grid" type="button" title="Toggle grid view">▦</button>
              <span id="pf-pager"></span>
            </div>
            <div id="pf-tiles"></div>
          </div>
          <div id="pf-right">
            <p class="hint" id="pf-empty">Pick a persona on the left, or create one.</p>
            <div id="pf-editor" hidden>
              <div id="pf-title-row">
                <button id="pf-picture" type="button" title="Click to set another picture"></button>
                <div id="pf-titles">
                  <input id="pf-name" type="text" spellcheck="false" placeholder="Name" title="What {{user}} expands to" />
                  <input id="pf-title" type="text" spellcheck="false" placeholder="Title (optional)" title="How the picker shows it" />
                </div>
              </div>
              <div class="pf-buttons">
                <button class="secondary" id="pf-image" type="button" title="Copy a picture in beside this persona">Change picture…</button>
                <button class="secondary" id="pf-image-clear" type="button" title="Take the picture away">Clear</button>
                <button class="secondary" id="pf-duplicate" type="button" title="Copy this persona and its picture">Duplicate</button>
                <button class="secondary" id="pf-convert" type="button" title="Make a persona out of one of your characters">Convert a character…</button>
                <button class="secondary danger" id="pf-delete" type="button" title="Delete the persona and its picture">Delete</button>
              </div>
              <div class="pf-field">
                <label for="pf-description">Persona Description <span class="pf-tokens">Tokens: <span id="pf-tokens">0</span></span></label>
                <textarea id="pf-description" rows="8" spellcheck="false" placeholder="Example: [{{user}} is a 28-year-old Romanian cat girl.]"></textarea>
              </div>
              <div class="pf-grid3">
                <div class="pf-field">
                  <label for="pf-position">Position</label>
                  <select id="pf-position"></select>
                </div>
                <div class="pf-field">
                  <label for="pf-depth">Depth</label>
                  <input id="pf-depth" type="number" min="0" max="9999" step="1" title="Messages from the end, for “in chat”" />
                </div>
                <div class="pf-field">
                  <label for="pf-role">Role</label>
                  <select id="pf-role"></select>
                </div>
              </div>
              <div class="pf-field">
                <small class="pf-label">Connections</small>
                <div class="pf-locks">
                  <button class="secondary" id="pf-lock-default" type="button" title="Use this persona for new chats; click again to stop">Default</button>
                  <button class="secondary" id="pf-lock-character" type="button" title="Connect this persona to the character this chat is with">Character</button>
                  <button class="secondary" id="pf-lock-chat" type="button" title="Use this persona for this chat only">Chat</button>
                </div>
                <div id="pf-connections"></div>
                <div id="pf-connect-row">
                  <select id="pf-connect-character"></select>
                  <button class="secondary" id="pf-connect" type="button">Connect</button>
                </div>
              </div>
              <div class="pf-field">
                <label for="pf-lorebook">Persona Lorebook</label>
                <select id="pf-lorebook"></select>
                <p class="hint">Scanned alongside this persona, wherever it is used.</p>
              </div>
              <div class="pf-globals">
                <small class="pf-label">Global Settings</small>
                <label class="check"><input type="checkbox" id="pf-auto-lock" /> Auto-lock a chosen persona to the chat</label>
                <label class="check"><input type="checkbox" id="pf-allow-multi" /> Allow multiple persona connections per character</label>
                <label class="check"><input type="checkbox" id="pf-notify" /> Show notifications on switching personas</label>
              </div>
            </div>
          </div>
        </div>
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
            <label>World books</label>
            <p class="hint" id="books-known"></p>
            <p class="hint">The active books and every keyword-scan knob live with the books themselves, on the <strong>ST → World books</strong> sub-tab, the way SillyTavern keeps them.</p>
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
<script nonce="${nonce}" src="${book}"></script>
<script nonce="${nonce}" src="${persona}"></script>
<script nonce="${nonce}" src="${pane}"></script>
<script nonce="${nonce}" src="${script}" data-tab="${tab}"></script>
</body>
</html>`;
}
