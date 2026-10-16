import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { compileGraphs } from '../lib/graph';
import { DEFAULT_GRAPH_SOURCE, parseGraphSource } from '../lib/mermaid';
import { pluginNodeStatus, pluginTree, type PluginNode } from '../lib/plugins';
import { APPROVAL_LABELS, gateFlow, modeCapabilities, MODE_LABELS, parseRule } from '../lib/policy';
import { estimateTokens, type ContextForm } from '../lib/prompt';
import { INJECTION_POSITION } from '../lib/tavern/types';
import type { TavernApi } from 'comonad-plugin-tavern';
import { describe } from '../lib/util';
import { promptText } from '../services/agent';
import { profileKeyEnvs, type Config, type Profile } from '../services/settings';
import type { PaneController, PaneHost, PaneSpec } from '../services/panes';
import { registerCommand } from './register';

/** Webview settings panel: tabs for the agent policy, the graph editor, MCP servers and tools. */

/**
 * Where a marker's text comes from when no chat value can stand for it: the two that are only known
 * while a turn is being built.
 */
const MARKER_SOURCE: Record<string, string> = {
	worldInfoBefore: 'the world-book entries this turn activates',
	worldInfoAfter: 'the world-book entries this turn activates',
	chatHistory: 'the conversation itself',
};

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
	// The plugin list is the host's own service, and the host is what mounts this row: it is read when
	// the tab is drawn rather than captured here, because at this moment it does not exist yet.
	const pluginHost = () => ctx.get('plugins');
	/** One row per plugin, with what it provides, what it needs and who needs it. */
	const pluginDependencies = () => (pluginHost()?.dependencies() ?? []).map((row) => ({ ...row, requires: row.requires.map((require) => ({ ...require })) }));
	const pluginNodes = (): PluginNode[] =>
		pluginDependencies().map((row) => ({
			id: row.id,
			group: row.group,
			status: pluginNodeStatus(row),
			provides: row.provides,
			requires: row.requires,
			usedBy: row.usedBy,
		}));
	// The tavern service is a row of its own, so the panel names it where it needs it — the prompt list
	// shows the collection the active chat would send — and a tree without that row still draws.
	const tavern = () => ctx.get('tavern') as TavernApi | undefined;
	// The panel draws whatever panes the tree registered: the **ST** tab, its markup, its scripts and
	// its editor are the tavern plugin's, so with that row off there is no tab and no content code at
	// all. Each pane is fed the whole state push and asked, at save time, for the keys it owns.
	let controllers = new Map<string, PaneController>();
	const paneList = (): PaneSpec[] => ctx.get('panes')?.list() ?? [];
	const paneHost = (): PaneHost => ({
		uri: (file: string) => (panel ? String(panel.webview.asWebviewUri(vscode.Uri.file(file))) : ''),
		refresh: () => void pushState(),
	});
	// A pane arrives with its row, so its reveal command is registered the first time it is seen.
	const paneCommands = new Set<string>();
	/** The tab the document opens on: what the panel was last asked for, built again when a pane moves. */
	let wanted = 'agent';
	/** Rebuilds the controllers, the commands that reveal them, and the open document. */
	const buildPanes = (scope: Context): void => {
		controllers = new Map(
			paneList()
				.filter((pane) => pane.controller)
				.map((pane) => [pane.id, pane.controller!(paneHost())] as const),
		);
		for (const pane of paneList()) {
			if (pane.command && !paneCommands.has(pane.command)) {
				paneCommands.add(pane.command);
				registerCommand(scope, pane.command, () => open(pane.id));
			}
		}
		if (panel) {
			// The tab, its markup and its files are part of the document, so a row going on or off is a
			// document, not a list, that changes.
			panel.webview.html = settingsDocument(panel.webview, ctx.host.extensionUri as vscode.Uri, wanted, paneList());
		}
		void pushState();
	};
	ctx.inject(['panes'], (scope) => {
		scope.on('panes/changed', () => buildPanes(scope));
		// The row resolves a moment after the panel is built, so the first pass is made once it does.
		void Promise.resolve().then(() => buildPanes(scope));
		return () => {
			controllers = new Map();
		};
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

	/**
	 * Installs a plugin: the ones that ship with Comonad are offered by name, and anything else by its
	 * folder. The host copies it into the library and writes the row, so this is a shortcut for a step
	 * a user can take by hand — and undo by deleting the row.
	 */
	const installPlugin = async (): Promise<void> => {
		const sources = pluginHost()?.bundled() ?? [];
		const picked = await vscode.window.showQuickPick(
			[
				...sources.map((source) => ({ label: source.label, description: `ships with Comonad — ${source.id}`, id: source.id, dir: source.dir })),
				{ label: '$(folder) A folder on disk…', description: 'a plugin you built or downloaded', id: '', dir: '' },
			],
			{ title: 'Comonad plugin to install', ignoreFocusOut: true },
		);
		if (!picked) {
			return;
		}
		let dir = picked.dir;
		let id = picked.id;
		if (!dir) {
			const chosen = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: 'Install this plugin',
				title: 'The plugin folder — the one with its package.json',
			});
			const folder = chosen?.[0]?.fsPath;
			if (!folder) {
				return;
			}
			dir = folder;
			id = basename(folder);
		}
		const states = await pluginHost()?.install(dir, id);
		const row = states?.find((entry) => entry.id === id);
		void vscode.window.showInformationMessage(
			row?.loaded
				? `Comonad: ${id} is installed and loaded.`
				: `Comonad: ${id} is installed and written into your cordis.yml — the Plugins tab says what it is waiting for.`,
		);
	};

	/** What the panes own of a save: every controller is asked for the keys it is responsible for. */
	const panePatch = (patch: Record<string, unknown>, current: Config): Record<string, unknown> => {
		const owned: Record<string, unknown> = {};
		for (const controller of controllers.values()) {
			Object.assign(owned, controller.patch?.(patch, current) ?? {});
		}
		return owned;
	};

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
			confineRead: Boolean(patch.confineRead),
			confineWrite: Boolean(patch.confineWrite),
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
			...panePatch(patch, current),
		};
		for (const [key, value] of Object.entries(next)) {
			if (!same(current[key as keyof typeof current], value)) {
				await ctx.settings.update(key as keyof typeof current, value);
			}
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
				confineRead: config.confineRead,
				confineWrite: config.confineWrite,
				maxSteps: config.maxSteps,
				displayForm: config.displayForm,
				contextForm: config.contextForm,
				model: config.model,
				graph,
				permissions: config.permissions,
			},
			// Each pane's own slices travel under its id: the panel has no content code of its own, and a
			// pane that is not registered is simply a tab that is not there.
			panes: Object.fromEntries([...controllers].map(([id, controller]) => [id, controller.state()])),
			plugins: {
				rows: pluginDependencies(),
				dependencies: pluginDependencies(),
				project: String(pluginHost()?.projectFile ?? ''),
				user: String(pluginHost()?.userFile ?? ''),
				writable: String(pluginHost()?.patchFile ?? ''),
				trusted: Boolean(ctx.host.trusted()),
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

	/**
	 * Every prompt the model can be given: the agent's own blocks, each tool's definition, and the
	 * SillyTavern collection the active chat would send. Read on demand — it reads instruction files and
	 * memory from disk — so the tab asks for it rather than waiting for a state push.
	 */
	const promptsSlice = async (): Promise<Record<string, unknown>> => {
		const session = ctx.sessions.active();
		const visible = new Set(session ? ctx.tools.visible(session.policy).map((tool) => tool.name) : []);
		const blocks = session ? await ctx.agent.promptBlocks(session) : [];
		// A marker carries no text of its own: the assembler fills it while the turn is built, so the
		// panel asks the tavern for the same values the assembler would use. What is left over is filled
		// from the turn itself and is reported as such rather than as an empty prompt with no tokens.
		const shown = session ? (tavern()?.displayPrompts(session.id, promptText(blocks)) ?? {}) : {};
		return {
			chat: session ? { title: session.title, mode: session.policy.workMode, approval: session.policy.approval } : null,
			comonad: blocks.map((block) => ({ name: block.name, text: block.text, tokens: estimateTokens(block.text) })),
			tools: ctx.tools.all().map((tool) => ({
				name: tool.name,
				capability: tool.capability,
				description: tool.description,
				parameters: tool.parameters,
				visible: visible.has(tool.name),
				// What travels with every request is the whole definition, parameter schema included — the
				// panel counts the same thing the context budget does, not just the prose.
				tokens: estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })),
			})),
			// Nothing sends these when the tavern row is off, so the tab shows no collection at all.
			st: (tavern()?.promptsFor(session?.id) ?? []).map((prompt) => {
				const text = shown[prompt.identifier];
				const marker = prompt.marker === true;
				return {
					identifier: prompt.identifier,
					name: prompt.name || prompt.identifier,
					role: prompt.role,
					content: text ?? '',
					enabled: prompt.enabled,
					marker,
					inChat: Number(prompt.injection_position ?? 0) === INJECTION_POSITION.absolute,
					depth: prompt.injection_depth,
					// A marker with no text here is one only a turn can fill, and saying which is honest
					// where reporting the empty slot as "0 tokens" was not.
					source: marker && text === undefined ? (MARKER_SOURCE[prompt.identifier] ?? 'the turn being built') : undefined,
					tokens: marker && text === undefined ? null : estimateTokens(text ?? ''),
				};
			}),
		};
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
				case 'plugins': {
					if (message.action === 'reload') {
						await pluginHost()?.reconcile();
					} else if (message.action === 'toggle') {
						await pluginHost()?.set(String(message.id ?? ''), { disabled: Boolean(message.disabled) });
					} else if (message.action === 'install') {
						await installPlugin();
					}
					break;
				}
				case 'pluginTree': {
					// The chain is text the client prints as it is: the panel has the whole list already.
					void panel.webview.postMessage({ type: 'pluginTree', id: String(message.id ?? ''), text: pluginTree(pluginNodes(), String(message.id ?? '')) });
					return;
				}
				case 'prompts': {
					void panel.webview.postMessage({ type: 'prompts', prompts: await promptsSlice() });
					break;
				}
				case 'pane': {
					// A pane's message is its own: it is routed by id and answered with a note of its own.
					const id = String(message.pane ?? '');
					const note = await controllers.get(id)?.action((message.message ?? {}) as Record<string, unknown>);
					if (note) {
						void panel.webview.postMessage({ type: 'note', pane: id, ...note });
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
		wanted = tab ?? wanted;
		if (panel) {
			panel.reveal();
			if (tab) {
				void panel.webview.postMessage({ type: 'openTab', tab });
			}
			void pushState();
			return;
		}
		const extensionUri = ctx.host.extensionUri as vscode.Uri;
		// The panes' files and library folders come along: a pane's client travels beside its package,
		// and a persona's picture is a file in the library the pane displays.
		const roots = new Set<string>([join(extensionUri.fsPath, 'resources')]);
		for (const pane of paneList()) {
			for (const file of [...(pane.scripts ?? []), ...(pane.styles ?? [])]) {
				roots.add(dirname(file));
			}
			for (const root of pane.roots?.() ?? []) {
				roots.add(root);
			}
		}
		panel = vscode.window.createWebviewPanel('comonad.settings', 'Comonad Settings', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [...roots].map((root) => vscode.Uri.file(root)),
		});
		panel.onDidDispose(() => {
			panel = null;
		});
		panel.webview.html = settingsDocument(panel.webview, extensionUri, tab ?? 'agent', paneList());
		panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => void handle(message));
		void pushState();
	};

	ctx.on('settings/changed', () => void pushState());
	ctx.on('tools/changed', () => void pushState());
	ctx.on('plugins/changed', () => void pushState());

	registerCommand(ctx, 'comonad.openSettings', () => open());
	registerCommand(ctx, 'comonad.reloadMcp', async () => {
		await ctx.mcp.reload();
		void vscode.window.showInformationMessage('Comonad: MCP servers reloaded.');
	});
	registerCommand(ctx, 'comonad.pickModel', () => pickModel(ctx));
	registerCommand(ctx, 'comonad.configureModel', () => configureModel(ctx));
}
settingsPanel.inject = ['host', 'settings', 'llm', 'tools', 'mcp', 'sessions', 'agent'];

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

/** A pane names its own tab and titles it, and that text lands in the host's markup: it is escaped. */
function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function settingsDocument(webview: vscode.Webview, extensionUri: vscode.Uri, tab: string, panes: readonly PaneSpec[]): string {
	const nonce = randomBytes(16).toString('base64');
	const uri = (file: string): string => String(webview.asWebviewUri(vscode.Uri.file(file)));
	const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'settings.js'));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'settings.css'));
	// A pane brings its own files: they are listed after the host's client, which is what hands them the
	// message channel they post a pane's actions through.
	const paneStyles = panes.flatMap((pane) => pane.styles ?? []).map(uri);
	const paneScripts = panes.flatMap((pane) => pane.scripts ?? []).map(uri);
	const paneTabs = panes
		.map((pane) => `      <button class="tab" type="button" role="tab" data-tab="${escapeHtml(pane.id)}" title="${escapeHtml(pane.title ?? pane.label)}">${escapeHtml(pane.label)}</button>`)
		.join('\n');
	// The pane sections sit after Graph, where a content tab has always been: the host's own tabs come
	// first and a pane is a guest among them.
	const paneSections = panes
		.map((pane) => `  <section data-pane="${escapeHtml(pane.id)}" hidden>\n${pane.markup}  </section>`)
		.join('\n');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; connect-src https://cdn.jsdelivr.net; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
${paneStyles.map((src) => `<link rel="stylesheet" href="${src}" />`).join('\n')}
</head>
<body>
  <header id="bar">
    <nav id="tabs" role="tablist" aria-label="Comonad settings">
      <button class="tab" type="button" role="tab" data-tab="graph" title="Graph — the Mermaid agent loop">Graph</button>
      <button class="tab" type="button" role="tab" data-tab="agent" title="Agent — preset, model, policy, workspace">Agent</button>
${paneTabs}
      <button class="tab" type="button" role="tab" data-tab="rules" title="Rules — allow, ask and deny rules for tool calls">Rules</button>
      <button class="tab" type="button" role="tab" data-tab="mcp" title="MCP — servers and their status">MCP</button>
      <button class="tab" type="button" role="tab" data-tab="tools" title="Tools — what a turn may run">Tools</button>
      <button class="tab" type="button" role="tab" data-tab="inspect" title="Inspect — the tool policy flow and every prompt the model can be given">Inspect</button>
      <button class="tab" type="button" role="tab" data-tab="plugins" title="Plugins — every row of the tree, and what became of it">Plugins</button>
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
      <div class="field wide">
        <label>Restrict to workspace</label>
        <label class="check"><input type="checkbox" id="confine-read" data-key="confineRead" /> Reads outside the working directory are refused</label>
        <label class="check"><input type="checkbox" id="confine-write" data-key="confineWrite" /> Writes outside the working directory are refused</label>
        <p class="hint">Applies to the file tools and to commands run in the shell sandbox. Confining reads also hides files like <code>~/.gitconfig</code> and <code>~/.npmrc</code> from git and npm.</p>
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


${paneSections}

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

  <section data-pane="inspect" hidden>
    <nav id="inspect-tabs" role="tablist" aria-label="Inspect">
      <button class="subtab" type="button" role="tab" data-inspect="flow" title="Tool Policy Flow — how one tool call is gated">Tool Policy Flow (TPF)</button>
      <button class="subtab" type="button" role="tab" data-inspect="prompts" title="Prompts — every prompt the model can be given">Prompts</button>
      <button class="subtab" type="button" role="tab" data-inspect="plugins" title="Plugins — how the tree is wired: what each row provides, and what needs it">Plugins</button>
    </nav>

    <div data-inspect-pane="flow">
      <div class="field wide">
        <label>Tool Policy Flow</label>
        <p class="hint">Every call walks the gates in order and leaves at the first one that stops it. The framed part is what you configure: the rules from the <strong>Rules</strong> tab, then the approval policy for the calls no rule matched.</p>
        <ul class="legend" id="flow-legend"></ul>
        <p class="hint">Red ends the call, amber asks you first, green runs without asking.</p>
      </div>
      <div id="flow" class="diagram"></div>
    </div>

    <div data-inspect-pane="prompts" hidden>
      <div id="pr-wrap">
        <div class="field">
          <label>Prompts</label>
          <p class="hint">Every prompt the model can be given: Comonad's own blocks, each tool's definition, and the SillyTavern collection this chat would send. Pick one to read it.</p>
          <div id="pr-list"></div>
        </div>
        <div class="field">
          <label id="pr-title">Preview</label>
          <p class="hint" id="pr-meta"></p>
          <pre id="pr-view" class="pr-view"></pre>
        </div>
      </div>
      <div class="row">
        <button class="secondary" id="pr-refresh" type="button" title="Read the prompts again">Refresh</button>
      </div>
    </div>

    <div data-inspect-pane="plugins" hidden>
      <div class="field wide">
        <label>Plugins</label>
        <p class="hint">
          What the tree is wired with, row by row: what each one <strong>provides</strong> (a service other
          rows can inject), what it <strong>needs</strong> (and which row provides that, or
          <span class="mono">(built in)</span> for the services Comonad mounts before the tree —
          <span class="mono">host</span>, <span class="mono">log</span> and
          <span class="mono">settings</span>, which are not rows and have nothing to turn off), who needs
          it, and its state. A service nobody provides is written <span class="mono">?name</span> — that is
          what a row is waiting for. Pick a row to see the whole chain that goes down with it.
        </p>
      </div>
      <div class="field wide">
        <table id="pg-deps"></table>
      </div>
      <div class="field wide" id="pg-detail-wrap" hidden>
        <label id="pg-detail-title">Dependency tree</label>
        <pre id="pg-detail" class="pr-view"></pre>
      </div>
    </div>
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

  <section data-pane="plugins" hidden>
    <div class="grid">
      <div class="field wide">
        <label>Rows</label>
        <p class="hint">
          Everything Comonad is made of, in load order. A row comes from the extension's own list,
          from <span class="mono" id="plugins-project"></span> (this workspace, when it is trusted) or
          from <span class="mono" id="plugins-user"></span> (yours, shared by every window). Turning a
          row off writes into <span class="mono" id="plugins-writable"></span> and applies the list
          again — the same change you could make by hand, and the same place a plugin of your own is
          mounted from.
        </p>
        <div class="row">
          <button class="secondary" id="plugins-install" type="button" title="Install — copy a plugin into your library and add its row">Install…</button>
          <button class="secondary" id="plugins-reload" type="button">Apply the list again</button>
          <span class="hint" id="plugins-note"></span>
        </div>
        <table id="plugins"></table>
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
<script nonce="${nonce}" src="${script}" data-tab="${tab}"></script>
${paneScripts.map((src) => `<script nonce="${nonce}" src="${src}"></script>`).join('\n')}
</body>
</html>`;
}
