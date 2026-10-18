import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { COMONAD_BLOCK, COMONAD_BLOCKS, DEFAULT_BLOCK_PREFIX, isComonadBlockId, type ComonadBlockId } from '../lib/blocks';
import { defaultPromptLayout, mergePromptPrefixes, parsePromptLayout, parseToolLayout } from '../lib/prompt-layout';
import { compileGraphs } from '../lib/graph';
import { DEFAULT_GRAPH_SOURCE, parseGraphSource } from '../lib/mermaid';
import { pluginNodeStatus, pluginTree, type PluginNode } from '../lib/plugins';
import { APPROVAL_LABELS, capabilityAllowed, gateFlow, modeCapabilities, MODE_LABELS, parseRule } from '../lib/policy';
import { type ContextForm } from '../lib/prompt';
import { estimateTokens } from '../lib/tokens';
import type { TavernApi } from 'comonad-plugin-tavern';
import { describe } from '../lib/util';
import { profileKeyEnvs, type Config, type Profile } from '../services/settings';
import type { PaneController, PaneHost, PaneSpec } from '../services/panes';
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
		refresh: () => void schedulePush(),
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
		void schedulePush();
	};
	ctx.inject(['panes'], (scope) => {
		scope.on('panes/changed', () => buildPanes(scope));
		// The row resolves a moment after the panel is built, so the first pass is made once it does.
		void Promise.resolve().then(() => buildPanes(scope));
		return () => {
			controllers = new Map();
		};
	});

	/** Nodes and routes of a Mermaid source, or the reason it does not compile. Cached: the graph
	 *  source almost never moves between two pushes, and compiling it is not free. */
	const graphCache = new Map<string, { nodes: string[]; routes: string[]; error: string }>();
	const inspectGraph = (source: string): { nodes: string[]; routes: string[]; error: string } => {
		const cached = graphCache.get(source);
		if (cached) {
			return cached;
		}
		let info: { nodes: string[]; routes: string[]; error: string };
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
			info = { nodes: [...nodes].sort(), routes: [...routes].sort(), error: '' };
		} catch (error) {
			info = { nodes: [], routes: [], error: describe(error) };
		}
		graphCache.set(source, info);
		if (graphCache.size > 16) {
			const oldest = graphCache.keys().next().value;
			if (oldest !== undefined) {
				graphCache.delete(oldest);
			}
		}
		return info;
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
	 * a user can take by hand — and `uninstallPlugin` is the same two steps taken back.
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

	/**
	 * Uninstalls a plugin: the host takes its row out of every list (which disposes it) and deletes the
	 * folder an install copied into the library. A row that was never installed is still removed — its
	 * files are a user's own and stay — so the confirmation says which of the two this one is.
	 */
	const uninstallPlugin = async (id: string): Promise<void> => {
		const host = pluginHost();
		if (!host) {
			return;
		}
		const dir = host.installedDirOf(id);
		const sure = await vscode.window.showWarningMessage(
			dir
				? `Uninstall "${id}"? Its row is removed from your cordis.yml, and ${dir} is deleted.`
				: `Uninstall "${id}"? Its row is removed from your cordis.yml; the files it loads stay where they are.`,
			{ modal: true },
			'Uninstall',
		);
		if (sure !== 'Uninstall') {
			return;
		}
		await host.uninstall(id);
		void vscode.window.showInformationMessage(`Comonad: ${id} is uninstalled.`);
	};

	/** What the panes own of a save: every controller is asked for the keys it is responsible for. */
	const panePatch = (patch: Record<string, unknown>): Record<string, unknown> => {
		const owned: Record<string, unknown> = {};
		for (const controller of controllers.values()) {
			Object.assign(owned, controller.patch?.(patch) ?? {});
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
			...panePatch(patch),
		};
		// Pane keys live outside the kernel's `Config`, so what is compared against is the raw store
		// under the defaulted view: a kernel key reads exactly as it always did, and a pane's own key
		// against the value the host reports for it.
		const seen: Record<string, unknown> = { ...ctx.host.config(), ...current };
		for (const [key, value] of Object.entries(next)) {
			if (!same(seen[key], value)) {
				await ctx.settings.update(key, value);
			}
		}
		if (patch.mcpServers && typeof patch.mcpServers === 'object') {
			await ctx.settings.update('mcpServers', patch.mcpServers);
			await ctx.mcp.reload();
		}
	};

	/**
	 * The model list the panel shows. It is fetched off the push path — an endpoint that is slow or
	 * down must never stall a state message — and posted on its own when it lands.
	 */
	let lastModels: Awaited<ReturnType<typeof ctx.llm.availableModels>> = [];
	let modelsAt = 0;
	let modelsInFlight: Promise<void> | null = null;
	const refreshModels = (force = false): Promise<void> => {
		if (modelsInFlight) {
			return modelsInFlight;
		}
		if (!force && Date.now() - modelsAt < 60_000) {
			return Promise.resolve();
		}
		modelsInFlight = (async () => {
			try {
				lastModels = await ctx.llm.availableModels({ refresh: force });
				modelsAt = Date.now();
				if (panel) {
					void panel.webview.postMessage({ type: 'models', models: lastModels });
				}
			} catch (error) {
				void panel?.webview.postMessage({ type: 'error', message: describe(error) });
			} finally {
				modelsInFlight = null;
			}
		})();
		return modelsInFlight;
	};

	const pushState = (): void => {
		if (!panel) {
			return;
		}
		const config = ctx.settings.get();
		const graph = config.graph || DEFAULT_GRAPH_SOURCE;
		// One walk of the plugin tree answers every question the panel asks about it.
		const dependencies = pluginDependencies();
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
				rows: dependencies,
				dependencies,
				project: String(pluginHost()?.projectFile ?? ''),
				user: String(pluginHost()?.userFile ?? ''),
				writable: String(pluginHost()?.patchFile ?? ''),
				trusted: Boolean(ctx.host.trusted()),
			},
			labels: { modes: MODE_LABELS, approvals: APPROVAL_LABELS, displays: DISPLAY_LABELS, contexts: CONTEXT_LABELS },
			models: lastModels,
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
		void refreshModels();
	};

	/**
	 * The one way a state is pushed. A single action lands as two or three events — the answer to the
	 * message, `tavern/changed`, `settings/changed` — and each of them used to rebuild and resend the
	 * whole state; they collapse into one push here. Never cancelled, only pushed later: the panes
	 * treat the push after a note as its ack.
	 */
	let pushTimer: NodeJS.Timeout | undefined;
	const schedulePush = (): void => {
		clearTimeout(pushTimer);
		pushTimer = setTimeout(() => {
			pushTimer = undefined;
			pushState();
		}, 50);
	};

	/**
	 * The layout editor's data: Comonad's blocks (their order, switch, editable prefix and generated
	 * body) and every tool definition with its order/switch. Read on demand — it reads instruction
	 * files and memory from disk — so the tab asks for it rather than waiting for a state push.
	 *
	 * Under ST the Comonad order and switches are the active preset's, mirrored read-only here; the
	 * prefixes are still the kernel's and are used by the composed request.
	 */
	const promptsSlice = async (): Promise<Record<string, unknown>> => {
		const session = ctx.sessions.active();
		// The pane answers "what would the next turn carry": the settings the chat's mode/approval
		// pills just changed, merged exactly as `runTurn` merges them.
		const policy = session ? { ...session.policy, ...ctx.agent.policyFor() } : undefined;
		const effective = session && policy ? { ...session, policy } : undefined;
		const visible = new Set(effective && policy ? ctx.tools.visible(policy).map((tool) => tool.name) : []);
		const blocks = effective ? await ctx.agent.promptBlocks(effective) : [];
		const byId = new Map(blocks.map((block) => [block.id, block]));
		const layout = ctx.settings.get().prompts;
		const takeover = tavern()?.enabled() === true;
		let st: ReturnType<TavernApi['promptsFor']> = [];
		if (takeover && session) {
			try {
				st = tavern()?.promptsFor(session.id) ?? [];
			} catch {
				st = [];
			}
		}
		const stComonad = st.filter((prompt) => isComonadBlockId(prompt.identifier));
		const stById = new Map(stComonad.map((prompt) => [prompt.identifier, prompt]));
		const stToolsEnabled = takeover ? stById.get(COMONAD_BLOCK.tools)?.enabled !== false : true;
		const toolsBlockEnabled = layout.find((entry) => entry.id === COMONAD_BLOCK.tools)?.enabled !== false;
		const toolsGate = takeover ? stToolsEnabled : toolsBlockEnabled;

		const comonadRow = (id: ComonadBlockId, enabled: boolean, order: number): Record<string, unknown> => {
			const block = byId.get(id);
			const setting = layout.find((entry) => entry.id === id);
			return {
				id,
				name: block?.name ?? COMONAD_BLOCKS.find((entry) => entry.id === id)?.name ?? id,
				prefix: setting?.prefix ?? DEFAULT_BLOCK_PREFIX[id],
				defaultPrefix: DEFAULT_BLOCK_PREFIX[id],
				body: block?.body ?? '',
				text: block?.text ?? '',
				tokens: block ? estimateTokens(block.text) : 0,
				enabled,
				order,
				readOnlyOrder: takeover,
			};
		};
		const comonad = takeover
			? (() => {
					// The tavern's completeOrder guarantees all nine; a broken old build may not, so the
					// missing ones follow in canonical order rather than vanishing from the editor.
					const ids: ComonadBlockId[] = stComonad.map((prompt) => prompt.identifier as ComonadBlockId);
					for (const block of COMONAD_BLOCKS) {
						if (!stById.has(block.id)) {
							ids.push(block.id);
						}
					}
					return ids.map((id, index) => comonadRow(id, stById.get(id)?.enabled ?? true, index));
				})()
			: layout.map((entry, index) => comonadRow(entry.id, entry.enabled, index));

		const mode = policy ? (MODE_LABELS[policy.workMode] ?? policy.workMode).split(' — ')[0] : '';
		const tools = ctx.tools.layout().map(({ tool, enabled }, order) => {
			const policyOffered = visible.has(tool.name);
			const offered = enabled && policyOffered && toolsGate;
			const reason = !enabled
				? 'switched off in Prompts'
				: !toolsGate
					? takeover
						? 'ST Tools entry is off'
						: 'the Tools block is off'
					: policyOffered
						? undefined
						: !policy
							? 'no active chat'
							: !capabilityAllowed(tool.capability, policy.workMode)
								? `not in ${mode} mode`
								: tool.needsNetwork && !policy.network
									? 'network is off'
									: tool.needsWorkspace && !policy.workingDirectory.trim()
										? 'no workspace'
										: 'not offered';
			return {
				name: tool.name,
				capability: tool.capability,
				description: tool.description,
				parameters: tool.parameters,
				visible: offered,
				reason,
				enabled,
				order,
				// What travels with every request is the whole definition, parameter schema included — the
				// panel counts the same thing the context budget does, not just the prose.
				tokens: estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })),
			};
		});
		return {
			chat:
				session && policy
					? {
							title: session.title,
							mode: MODE_LABELS[policy.workMode] ?? policy.workMode,
							approval: APPROVAL_LABELS[policy.approval] ?? policy.approval,
						}
					: null,
			takeover,
			stToolsEnabled,
			toolsBlockEnabled,
			comonad,
			tools,
			defaults: {
				comonad: defaultPromptLayout(),
				tools: ctx.tools.all().map((tool) => ({ name: tool.name })),
			},
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
					pushState();
					void refreshModels(true);
					return;
				case 'ready':
					pushState();
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
					} else if (message.action === 'uninstall') {
						await uninstallPlugin(String(message.id ?? ''));
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
				case 'savePrompts': {
					const incoming = parsePromptLayout(message.prompts);
					// Under ST the rows mirror the preset's order and switches. Only the prefixes are the
					// core layout's to change; saving the mirror as the fallback order would overwrite it.
					const takeover = tavern()?.enabled() === true;
					const prompts = takeover ? mergePromptPrefixes(ctx.settings.get().prompts, incoming) : incoming;
					const nextTools = parseToolLayout(message.toolPrompts);
					// A tool that is temporarily unregistered keeps its saved place and switch: the editor
					// only knows the tools loaded right now, so anything it did not mention is carried over.
					const seen = new Set(nextTools.map((entry) => entry.name));
					for (const entry of ctx.settings.get().toolPrompts) {
						if (!seen.has(entry.name)) {
							nextTools.push(entry);
							seen.add(entry.name);
						}
					}
					await ctx.settings.update('prompts', prompts);
					await ctx.settings.update('toolPrompts', nextTools);
					// Not the generic `ok`: that also clears the form's dirty flag, which belongs to the
					// other tabs and may hold edits this save does not write.
					void panel.webview.postMessage({ type: 'prompts', prompts: await promptsSlice(), saved: true });
					break;
				}
				case 'openTab':
					open(String(message.tab ?? 'agent'));
					return;
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
		schedulePush();
	};

	/** Reveal the panel, optionally on one of its tabs — `st` is where the content lives. */
	const open = (tab?: string): void => {
		wanted = tab ?? wanted;
		if (panel) {
			panel.reveal();
			if (tab) {
				void panel.webview.postMessage({ type: 'openTab', tab });
			}
			pushState();
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
		pushState();
	};

	ctx.on('settings/changed', schedulePush);
	ctx.on('tools/changed', schedulePush);
	ctx.on('plugins/changed', schedulePush);

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

/** A 16px stroke icon: the sidebar draws these alone when it is collapsed to the icon rail. */
const tabIcon = (body: string): string => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;

const TAB_ICONS = {
	agent: tabIcon(
		'<rect x="3" y="5" width="10" height="7" rx="2"/><path d="M8 2.3v2.7M5.7 8.1h.01M10.3 8.1h.01M6.2 11.9v1.6M9.8 11.9v1.6"/>',
	),
	graph: tabIcon(
		'<circle cx="4" cy="4" r="1.5"/><circle cx="12" cy="5" r="1.5"/><circle cx="7" cy="12" r="1.5"/><path d="M5.4 4.4l5.1.5M4.8 5.4l1.6 5.1M10.9 6.3l-2.6 4.2"/>',
	),
	rules: tabIcon(
		'<path d="M8 2l4.8 1.9v3.8c0 2.8-2 4.8-4.8 5.8-2.8-1-4.8-3-4.8-5.8V3.9z"/><path d="M5.9 7.9l1.4 1.4 2.8-2.8"/>',
	),
	mcp: tabIcon(
		'<path d="M6 2.4v3M10 2.4v3"/><path d="M4.4 5.4h7.2v2.2a3.6 3.6 0 0 1-7.2 0z"/><path d="M8 11.2v2.4"/>',
	),
	tools: tabIcon(
		'<path d="M10.7 2.7a3.1 3.1 0 0 0-3.9 3.9l-4 4a1.4 1.4 0 0 0 2 2l4-4a3.1 3.1 0 0 0 3.9-3.9L10.7 6 9.3 4.6z"/>',
	),
	prompts: tabIcon('<path d="M3 4h10M3 8h7M3 12h5"/><path d="M12.2 9.8l.5 1.2 1.3.5-1.3.5-.5 1.2-.5-1.2-1.3-.5 1.3-.5z"/>'),
	inspect: tabIcon('<circle cx="7" cy="7" r="4"/><path d="M10 10l3.3 3.3"/><path d="M5.4 7h3.2M7 5.4v3.2"/>'),
	plugins: tabIcon(
		'<path d="M6.1 3.2a1.2 1.2 0 0 1 2.4 0V4h2.1v2.1h.8a1.2 1.2 0 0 1 0 2.4h-.8V12H8.5v-.8a1.2 1.2 0 0 0-2.4 0v.8H3V9.5h.8a1.2 1.2 0 0 0 0-2.4H3V4h3.1z"/>',
	),
} as const;

const tabButton = (id: string, label: string, title: string, icon: string): string =>
	`        <button class="tab" type="button" role="tab" data-tab="${escapeHtml(id)}" title="${escapeHtml(title)}"><span class="tab-icon">${icon}</span><span class="tab-label">${escapeHtml(label)}</span></button>`;

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
		.map((pane) => tabButton(pane.id, pane.label, pane.title ?? pane.label, pane.icon ?? TAB_ICONS.plugins))
		.join('\n');
	// A pane is a guest page: its section is the markup it brings, undressed by the host.
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
  <aside id="side">
    <input id="search" class="control" type="search" placeholder="Search settings" spellcheck="false" autocomplete="off" />
    <nav id="tabs" role="tablist" aria-orientation="vertical" aria-label="Comonad settings">
${tabButton('agent', 'Agent', 'Agent — model, policy, workspace', TAB_ICONS.agent)}
${tabButton('graph', 'Graph', 'Graph — the Mermaid agent loop', TAB_ICONS.graph)}
${paneTabs}
${tabButton('rules', 'Rules', 'Rules — allow, ask and deny rules for tool calls', TAB_ICONS.rules)}
${tabButton('mcp', 'MCP', 'MCP — servers and their status', TAB_ICONS.mcp)}
${tabButton('tools', 'Tools', 'Tools — what a turn may run', TAB_ICONS.tools)}
${tabButton('prompts', 'Prompts', 'Prompts — Comonad blocks and tool definitions', TAB_ICONS.prompts)}
${tabButton('inspect', 'Inspect', 'Inspect — the tool policy flow and plugin dependencies', TAB_ICONS.inspect)}
${tabButton('plugins', 'Plugins', 'Plugins — every row of the tree, and what became of it', TAB_ICONS.plugins)}
    </nav>
    <div id="side-foot">
      <div id="status"></div>
      <div class="row">
        <button class="primary" id="save" type="button" title="Save — write these settings to this workspace"><span class="btn-icon" aria-hidden="true">✓</span><span class="btn-label">Save</span></button>
        <button class="secondary" id="close" type="button" title="Close — unsaved edits are dropped"><span class="btn-icon" aria-hidden="true">✕</span><span class="btn-label">Close</span></button>
      </div>
    </div>
  </aside>
  <div id="side-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the settings sidebar" tabindex="0"></div>

  <main id="content">
  <section data-pane="agent">
    <h1 class="page-title">Agent</h1>
    <h2 class="group-title">Model</h2>
    <div class="group">
      <div class="field">
        <label for="model">Default model</label>
        <p class="hint">What a new chat talks to. A profile is any OpenAI-compatible endpoint.</p>
        <div class="row">
          <select id="model" class="control" data-key="model"></select>
          <button class="secondary" id="model-refresh" type="button">Refresh</button>
          <button class="secondary" id="model-add" type="button">Add provider…</button>
        </div>
      </div>
    </div>
    <h2 class="group-title">Policy</h2>
    <div class="group">
      <div class="field">
        <label for="mode">Work mode</label>
        <p class="hint">What a turn may do at all — the capability set behind every tool call.</p>
        <select id="mode" class="control" data-key="mode"></select>
      </div>
      <div class="field">
        <label for="approval">Approval</label>
        <p class="hint">How a tool call is gated before it runs, on top of the mode.</p>
        <select id="approval" class="control" data-key="approval"></select>
      </div>
    </div>
    <h2 class="group-title">Conversation</h2>
    <div class="group">
      <div class="field">
        <label for="display">Display</label>
        <p class="hint">How the context sent with a turn is shown in the chat.</p>
        <select id="display" class="control" data-key="displayForm"></select>
      </div>
      <div class="field">
        <label for="context">Context</label>
        <p class="hint">What the model actually receives: rendered text, token counts or raw form.</p>
        <select id="context" class="control" data-key="contextForm"></select>
      </div>
      <div class="field">
        <label for="network">Network</label>
        <p class="hint">Network tools and network access inside the shell sandbox.</p>
        <label class="check"><input type="checkbox" id="network" data-key="network" /></label>
      </div>
    </div>
    <h2 class="group-title">Workspace</h2>
    <div class="group">
      <div class="field">
        <label for="wd">Working directory</label>
        <p class="hint">Where the agent works. Empty uses the first workspace folder.</p>
        <div class="combo">
          <input id="wd" class="control" type="text" data-key="workingDirectory" spellcheck="false" autocomplete="off" placeholder="Empty uses the first workspace folder" />
          <div id="dirs" hidden></div>
        </div>
      </div>
      <div class="field">
        <label for="timeout">Command timeout</label>
        <p class="hint">Seconds before a shell command is killed.</p>
        <input id="timeout" class="control" type="number" min="1" data-key="commandTimeout" />
      </div>
      <div class="field">
        <label for="plans">Plan directory</label>
        <p class="hint">Workspace-relative folder for plan files.</p>
        <input id="plans" class="control" type="text" data-key="planDirectory" spellcheck="false" placeholder=".comonad/plans" />
      </div>
    </div>
    <h2 class="group-title">Safety</h2>
    <div class="group">
      <div class="field">
        <label for="deny">Deny read paths</label>
        <p class="hint">One workspace-relative path or basename per line — file and shell tools refuse to read or write them.</p>
        <textarea id="deny" class="control" data-key="denyReadPaths" spellcheck="false" rows="3"></textarea>
      </div>
      <div class="field">
        <label for="confine-read">Confine reads</label>
        <p class="hint">Reads outside the working directory are refused.</p>
        <label class="check"><input type="checkbox" id="confine-read" data-key="confineRead" /></label>
      </div>
      <div class="field">
        <label for="confine-write">Confine writes</label>
        <p class="hint">Writes outside the working directory are refused.</p>
        <label class="check"><input type="checkbox" id="confine-write" data-key="confineWrite" /></label>
      </div>
      <p class="group-note">Confinement applies to the file tools and to commands run in the shell sandbox. Confining reads also hides files like <code>~/.gitconfig</code> and <code>~/.npmrc</code> from git and npm.</p>
    </div>
  </section>

  <section data-pane="graph" hidden>
    <h1 class="page-title">Graph</h1>
    <h2 class="group-title">Agent loop</h2>
    <div class="group">
      <div id="graph-wrap">
        <div class="field">
          <label for="graph">Graph</label>
          <p class="hint">The Mermaid source the turn walks — nodes, routes and soft routes.</p>
          <textarea id="graph" class="control" data-key="graph" spellcheck="false"></textarea>
          <div class="row">
            <button class="secondary" id="graph-reset" type="button">Use default</button>
          </div>
        </div>
        <div class="field">
          <label>Preview</label>
          <div id="preview" class="diagram"></div>
          <p class="hint error" id="graph-error"></p>
          <p class="hint" id="graph-nodes"></p>
          <p class="hint" id="graph-routes"></p>
        </div>
      </div>
      <div class="field">
        <label for="steps">Max steps</label>
        <p class="hint">Maximum graph steps per turn.</p>
        <input id="steps" class="control" type="number" min="1" data-key="maxSteps" />
      </div>
    </div>
  </section>


${paneSections}

  <section data-pane="rules" hidden>
    <h1 class="page-title">Rules</h1>
    <h2 class="group-title">Tool rules</h2>
    <div class="group">
      <div class="field">
        <label for="rules-deny">Deny</label>
        <p class="hint">Rejected in every policy, before anything else — the deny rules win over the rest.</p>
        <textarea id="rules-deny" class="control" data-key="permissions" spellcheck="false" rows="3" placeholder="run_shell(rm:*)"></textarea>
      </div>
      <div class="field">
        <label for="rules-ask">Ask</label>
        <p class="hint">Always confirmed before they run, even under an accept policy.</p>
        <textarea id="rules-ask" class="control" data-key="permissions" spellcheck="false" rows="3" placeholder="run_shell(git push:*)"></textarea>
      </div>
      <div class="field">
        <label for="rules-allow">Allow</label>
        <p class="hint">Run without asking, even under Ask. One rule per line: <code>tool</code> or <code>tool(pattern)</code> — <code>run_shell(npm run test:*)</code>, <code>read_file(./.env)</code>, <code>fetch_url(domain:example.com)</code>. “Always allow” in the approval prompt appends here.</p>
        <textarea id="rules-allow" class="control" data-key="permissions" spellcheck="false" rows="3" placeholder="run_shell(npm run test:*)"></textarea>
      </div>
    </div>
  </section>

  <section data-pane="prompts" hidden>
    <h1 class="page-title">Prompts</h1>
    <div class="group">
      <p class="hint" id="prompts-note"></p>
      <div id="pr-wrap">
        <div class="field">
          <label>Comonad blocks and tool definitions</label>
          <p class="hint">Comonad's blocks carry the static prefix you can edit here; the dynamic content below it is generated every turn. Tools keep the definitions their plugins register — this page only orders and switches them. When ST takes over, the block order and switches mirror the active preset.</p>
          <p class="hint" id="pr-chat"></p>
          <div id="pr-list"></div>
        </div>
        <div class="field">
          <label id="pr-title">Preview</label>
          <p class="hint" id="pr-meta"></p>
          <div id="pr-editor"></div>
          <pre id="pr-view" class="pr-view"></pre>
        </div>
      </div>
      <div class="row">
        <button class="primary" id="pr-save" type="button" title="Write this layout to settings">Save</button>
        <button class="secondary" id="pr-reset" type="button" title="Reset prefixes and tool switches; block order returns to the shipped order when ST is off">Reset to defaults</button>
        <button class="secondary" id="pr-refresh" type="button" title="Read the prompts again">Refresh</button>
      </div>
    </div>
  </section>

  <section data-pane="inspect" hidden>
    <h1 class="page-title">Inspect</h1>
    <nav id="inspect-tabs" role="tablist" aria-label="Inspect">
      <button class="subtab" type="button" role="tab" data-inspect="flow" title="Tool Policy Flow — how one tool call is gated">Tool Policy Flow (TPF)</button>
      <button class="subtab" type="button" role="tab" data-inspect="plugins" title="Plugins — how the tree is wired: what each row provides, and what needs it">Plugins</button>
    </nav>

    <div data-inspect-pane="flow">
      <div class="group">
        <div class="field">
          <label>Tool Policy Flow</label>
          <p class="hint">Every call walks the gates in order and leaves at the first one that stops it. The framed part is what you configure: the rules from the <strong>Rules</strong> tab, then the approval policy for the calls no rule matched.</p>
          <ul class="legend" id="flow-legend"></ul>
          <p class="hint">Red ends the call, amber asks you first, green runs without asking.</p>
        </div>
        <div id="flow" class="diagram"></div>
      </div>
    </div>

    <div data-inspect-pane="plugins" hidden>
      <div class="group">
        <div class="field">
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
          <table id="pg-deps"></table>
        </div>
        <div class="field" id="pg-detail-wrap" hidden>
          <label id="pg-detail-title">Dependency tree</label>
          <pre id="pg-detail" class="pr-view"></pre>
        </div>
      </div>
    </div>
  </section>

  <section data-pane="mcp" hidden>
    <h1 class="page-title">MCP</h1>
    <div class="group">
      <div class="field">
        <label for="mcp">Servers</label>
        <p class="hint">JSON object keyed by server name: { "name": { "command": "npx", "args": ["-y", "server"], "capability": "ro" } }</p>
        <textarea id="mcp" class="control" spellcheck="false" style="min-height:160px"></textarea>
        <div class="row">
          <button class="secondary" id="mcp-save" type="button">Save and reload</button>
          <button class="secondary" id="mcp-reload" type="button">Reload</button>
        </div>
      </div>
      <div class="field">
        <label>Status</label>
        <table id="mcp-status"></table>
      </div>
    </div>
  </section>

  <section data-pane="plugins" hidden>
    <h1 class="page-title">Plugins</h1>
    <div class="group">
      <div class="field">
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
    <h1 class="page-title">Tools</h1>
    <div class="group">
      <div class="field">
        <label>Tools</label>
        <p class="hint">Every registered tool with what it needs. The work mode and the approval policy decide which ones a turn may actually use.</p>
        <table id="tools"></table>
      </div>
    </div>
  </section>
  </main>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script nonce="${nonce}" src="${script}" data-tab="${tab}"></script>
${paneScripts.map((src) => `<script nonce="${nonce}" src="${src}"></script>`).join('\n')}
</body>
</html>`;
}
