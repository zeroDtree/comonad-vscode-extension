// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { COMONAD_BLOCK, COMONAD_BLOCKS, DEFAULT_BLOCK_PREFIX, type ComonadBlockId } from '../lib/blocks';
import { isLoopbackBase, normalizeEndpoint } from '../lib/endpoint';
import { defaultPromptLayout, parsePromptLayout, parseToolLayout } from '../lib/prompt-layout';
import { pluginNodeStatus, pluginTree, type PluginNode } from '../lib/plugins';
import {
	APPROVAL_LABELS,
	APPROVAL_RESPONSE_LABELS,
	capabilityAllowed,
	gateFlow,
	MODE_LABELS,
	parseRule,
	SANDBOX_LABELS,
} from '../lib/policy';
import { type ContextForm } from '../lib/prompt';
import { ensureSettingsFile, settingsDisplayPath, workspaceFirstScope, type SettingsScope } from '../lib/settings-file';
import { estimateTokens } from '../lib/tokens';
import { describe } from '../lib/util';
import { asList, normalizeAgentPatch, profileKeyEnvs, sanitizeSubagentGrants, subagentGrant, type Profile, type ToolCardMode } from '../services/settings';
import { unavailableInSandbox } from '../services/tools';
import { registerCommand } from './register';

/** Webview settings panel: the core tabs. */

/** A message's scope, defaulting to the user's own file when an older client sends none. */
const panelScope = (value: unknown): SettingsScope => (value === 'workspace' ? 'workspace' : 'user');

const DISPLAY_LABELS: Record<ContextForm, string> = {
	rendered: 'Rendered — folded thoughts, tool cards',
	token: 'Token — assistant text only',
	raw: 'Raw — the full record',
};

const TOOL_CARD_LABELS: Record<ToolCardMode, string> = {
	collapsed: 'Collapsed — header only (default)',
	preview: 'Preview — folded, with the first lines',
	open: 'Open — command and output',
};

const CONTEXT_LABELS: Record<ContextForm, string> = {
	rendered: 'Rendered — text, thoughts, and tool results',
	token: 'Token — assistant text only',
	raw: 'Raw — the full record',
};

export function settingsPanel(ctx: Context): void {
	let panel: vscode.WebviewPanel | null = null;
	// One message at a time: two live saves must not interleave their writes.
	let queue: Promise<void> = Promise.resolve();
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
	/** What the document and the first state push both say about the scope selector. */
	const scopeState = (): SettingsDocumentScope => {
		const workspace = ctx.settings.workspace();
		const trusted = ctx.settings.trusted();
		return {
			defaultScope: workspaceFirstScope(workspace, trusted),
			folderOpen: Boolean(workspace),
			trusted,
			userFile: settingsDisplayPath(ctx.host.settingsPath('user'), homedir()),
			workspaceFile: settingsDisplayPath(ctx.host.settingsPath('workspace'), homedir()),
		};
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

	/** The rule lists from the Agent tab, rejecting anything `parseRule` cannot read. */
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
				? `Uninstall "${id}"? Its entry is removed from your cordis.yml, and ${dir} is deleted.`
				: `Uninstall "${id}"? Its entry is removed from your cordis.yml; the files it loads stay where they are.`,
			{ modal: true },
			'Uninstall',
		);
		if (sure !== 'Uninstall') {
			return;
		}
		await host.uninstall(id);
		void vscode.window.showInformationMessage(`Comonad: ${id} is uninstalled.`);
	};

	/**
	 * Writes what the panel sent. Only keys the patch actually carries are touched: the live controls
	 * send one key at a time, and none may write a stale value for something it does not own.
	 */
	const apply = async (patch: Record<string, unknown>, scope: SettingsScope): Promise<void> => {
		const current = ctx.settings.get();
		const next: Record<string, unknown> = { ...normalizeAgentPatch(patch, current) };
		if (Object.hasOwn(patch, 'allow') || Object.hasOwn(patch, 'ask') || Object.hasOwn(patch, 'deny')) {
			next.permissions = {
				allow: ruleList(patch.allow ?? current.permissions.allow, 'allow'),
				ask: ruleList(patch.ask ?? current.permissions.ask, 'ask'),
				deny: ruleList(patch.deny ?? current.permissions.deny, 'deny'),
			};
		}
		const mcpServers =
			patch.mcpServers && typeof patch.mcpServers === 'object'
				? (patch.mcpServers as Record<string, unknown>)
				: undefined;
		// A key reads against the raw store under the defaulted view, so a value that did not actually
		// change is not written back.
		const seen: Record<string, unknown> = { ...ctx.host.config(), ...current };
		for (const [key, value] of Object.entries(next)) {
			if (!same(seen[key], value)) {
				await ctx.settings.update(key, value, scope);
			}
		}
		if (mcpServers) {
			await ctx.settings.update('mcpServers', mcpServers, scope);
		}
		// The composer's Context pill used to write the chat and this setting together. With the
		// pill gone, a Settings pick must reach the active chat too, or `session.contextForm`
		// would keep shadowing the new default.
		if (Object.hasOwn(patch, 'contextForm')) {
			const session = ctx.sessions.active();
			const form = ctx.settings.get().contextForm;
			if (session && session.contextForm !== form) {
				session.contextForm = form;
				ctx.sessions.save(session);
				ctx.sessions.changed(session.id);
			}
		}
		if (mcpServers) {
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
	/** A forced refresh arrived while a fetch was running: its answer is already stale. */
	let modelsDirty = false;
	const refreshModels = (force = false): Promise<void> => {
		if (modelsInFlight) {
			if (force) {
				modelsDirty = true;
			}
			return modelsInFlight;
		}
		if (!force && Date.now() - modelsAt < 60_000) {
			return Promise.resolve();
		}
		modelsInFlight = (async () => {
			try {
				let refresh = force;
				for (;;) {
					modelsDirty = false;
					lastModels = await ctx.llm.availableModels({ refresh });
					modelsAt = Date.now();
					if (!modelsDirty) {
						break;
					}
					refresh = true;
				}
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
		const scope = scopeState();
		// One walk of the plugin tree answers every question the panel asks about it.
		const dependencies = pluginDependencies();
		void panel.webview.postMessage({
			type: 'state',
			config: {
				mode: config.mode,
				approval: config.approval,
				approvalResponse: config.approvalResponse,
				network: config.network,
				sandboxMode: config.sandboxMode,
				workingDirectory: config.workingDirectory,
				commandTimeout: config.commandTimeout,
				commandTimeoutOverride: config.commandTimeoutOverride,
				planDirectory: config.planDirectory,
				denyReadPaths: config.denyReadPaths,
				budget: config.budget,
				subagentBudget: config.subagentBudget,
				subagentBudgetMode: config.subagentBudgetMode,
				displayForm: config.displayForm,
				toolCard: config.toolCard,
				contextForm: config.contextForm,
				compactionHeadroom: config.compactionHeadroom,
				compactionRetainPercent: config.compactionRetainPercent,
				questionNotification: config.questionNotification,
				model: config.model,
				permissions: config.permissions,
			},
			subagents: {
				grants: config.subagents,
				agents: ctx.catalog.agents.map((agent) => {
					const grant = subagentGrant(config, agent);
					const listed = agent.tools ?? [];
					return {
						name: agent.id,
						title: agent.title,
						description: agent.description,
						builtin: agent.builtin === true,
						capabilities: agent.capabilities,
						network: agent.network,
						risk: agent.risk,
						budget: agent.budget ?? {},
						tools: listed,
						canFiles: listed.some((name) => {
							const tool = ctx.tools.get(name);
							return tool?.capability === 'rw' && tool.trackedWrite === true;
						}),
						canTest: listed.some((name) => ctx.tools.get(name)?.capability === 'shell_test'),
						files: grant.files,
						test: grant.test,
					};
				}),
			},
			plugins: {
				rows: dependencies,
				dependencies,
				project: String(pluginHost()?.projectFile ?? ''),
				user: String(pluginHost()?.userFile ?? ''),
				// Not shown as a row any more, but the toggle/uninstall buttons need to know a write
				// has a file to land in.
				writable: String(pluginHost()?.patchFile ?? ''),
				trusted: Boolean(ctx.host.trusted()),
			},
			labels: {
				modes: MODE_LABELS,
				approvals: APPROVAL_LABELS,
				approvalResponses: APPROVAL_RESPONSE_LABELS,
				sandboxes: SANDBOX_LABELS,
				displays: DISPLAY_LABELS,
				toolCards: TOOL_CARD_LABELS,
				contexts: CONTEXT_LABELS,
			},
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
			flow: gateFlow(),
			workspace: config.workingDirectory,
			home: ctx.settings.home(),
			settingsFiles: { user: scope.userFile, workspace: scope.workspaceFile },
			folderOpen: scope.folderOpen,
			trusted: scope.trusted,
			environment: { remote: ctx.host.remoteName() ?? '', sandbox: ctx.host.sandboxKind() },
		});
		void refreshModels();
	};

	/**
	 * The one way a state is pushed. A single action lands as two or three events — the answer to the
	 * message, `settings/changed`, `tools/changed` — and each of them used to rebuild and resend the
	 * whole state; they collapse into one push here. Never cancelled, only pushed later.
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
		const toolsBlockEnabled = layout.find((entry) => entry.id === COMONAD_BLOCK.tools)?.enabled !== false;
		const toolsGate = toolsBlockEnabled;

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
			};
		};
		const comonad = layout.map((entry, index) => comonadRow(entry.id, entry.enabled, index));

		const mode = policy ? (MODE_LABELS[policy.workMode] ?? policy.workMode).split(' — ')[0] : '';
		const tools = ctx.tools.layout().map(({ tool, enabled }, order) => {
			const policyOffered = visible.has(tool.name);
			const offered = enabled && policyOffered && toolsGate;
			const reason = !enabled
				? 'switched off in Prompts'
				: !toolsGate
					? 'the Tools block is off'
					: policyOffered
						? undefined
						: !policy
							? 'no active chat'
							: !capabilityAllowed(tool.capability, policy)
								? `not in ${mode} mode`
								: tool.needsNetwork && !policy.network
									? 'network is off'
									: tool.needsWorkspace && !policy.workingDirectory.trim()
										? 'no workspace'
										: unavailableInSandbox(tool, policy)
											? `not available under ${policy.sandboxMode}`
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
							approvalResponse: APPROVAL_RESPONSE_LABELS[policy.approvalResponse] ?? policy.approvalResponse,
							sandbox: SANDBOX_LABELS[policy.sandboxMode] ?? policy.sandboxMode,
						}
					: null,
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
				case 'listDirs':
					void panel.webview.postMessage({ type: 'dirs', ...listDirs(String(message.path ?? '')) });
					return;
				case 'close':
					panel.dispose();
					return;
				case 'saveAgent':
					// No `ok`: the state push after the write redraws the live controls.
					await apply((message.config ?? {}) as Record<string, unknown>, panelScope(message.scope));
					break;
				case 'saveSubagents':
					await ctx.settings.update(
						'subagents',
						sanitizeSubagentGrants(message.subagents),
						panelScope(message.scope),
					);
					break;
				case 'configureModel':
					await vscode.commands.executeCommand('comonad.configureModel');
					break;
				case 'saveMcp': {
					const parsed = JSON.parse(String(message.json ?? '{}')) as Record<string, unknown>;
					const scope = panelScope(message.scope);
					await ctx.settings.update('mcpServers', parsed, scope);
					await ctx.mcp.reload();
					void panel.webview.postMessage({
						type: 'ok',
						message: `MCP servers updated in ${settingsDisplayPath(ctx.host.settingsPath(scope), homedir())}.`,
					});
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
					const scope = panelScope(message.scope);
					const prompts = parsePromptLayout(message.prompts);
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
					await ctx.settings.update('prompts', prompts, scope);
					await ctx.settings.update('toolPrompts', nextTools, scope);
					// Not the generic `ok`: that also clears the form's dirty flag, which belongs to the
					// other tabs and may hold edits this save does not write.
					void panel.webview.postMessage({ type: 'prompts', prompts: await promptsSlice(), saved: true });
					break;
				}
				case 'openConfig': {
					const scope = panelScope(message.scope);
					const file = ctx.host.settingsPath(scope);
					if (!file) {
						throw new Error('Open a workspace folder before using workspace settings.');
					}
					if (scope === 'workspace' && !ctx.host.trusted()) {
						throw new Error('Trust this workspace before using workspace settings.');
					}
					ensureSettingsFile(file);
					const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
					await vscode.window.showTextDocument(document, { preview: false });
					return;
				}
			}
		} catch (error) {
			void panel.webview.postMessage({ type: 'error', message: describe(error) });
		}
		schedulePush();
	};

	/** Reveal the panel. */
	const open = (): void => {
		if (panel) {
			panel.reveal();
			pushState();
			return;
		}
		const extensionUri = ctx.host.extensionUri as vscode.Uri;
		panel = vscode.window.createWebviewPanel('comonad.settings', 'Comonad Settings', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.file(join(extensionUri.fsPath, 'resources'))],
		});
		panel.onDidDispose(() => {
			panel = null;
		});
		panel.webview.html = settingsDocument(panel.webview, extensionUri, scopeState());
		panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
			queue = queue.then(() => handle(message));
		});
		pushState();
	};

	ctx.on('settings/changed', schedulePush);
	ctx.on('tools/changed', schedulePush);
	ctx.on('plugins/changed', schedulePush);
	ctx.on('catalog/changed', schedulePush);
	// A saved key changes both the no-key markers and the lists each endpoint can now report.
	ctx.on('llm/keys-changed', () => {
		schedulePush();
		void refreshModels(true);
	});

	registerCommand(ctx, 'comonad.openSettings', () => open());
	registerCommand(ctx, 'comonad.reloadMcp', async () => {
		await ctx.mcp.reload();
		void vscode.window.showInformationMessage('Comonad: MCP servers reloaded.');
	});
	registerCommand(ctx, 'comonad.pickModel', () => pickModel(ctx));
	registerCommand(ctx, 'comonad.configureModel', () => configureModel(ctx));
}
settingsPanel.inject = ['host', 'settings', 'llm', 'tools', 'mcp', 'sessions', 'agent', 'catalog'];

export async function pickModel(ctx: Context): Promise<void> {
	const choices = await ctx.llm.availableModels({ refresh: true });
	const picked = await vscode.window.showQuickPick(
		[
			...choices.map((choice) => ({
				label: choice.needsKey ? `$(warning) ${choice.label}` : choice.label,
				description: choice.description,
				id: choice.id,
			})),
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
	const choice = choices.find((item) => item.id === picked.id);
	if (choice?.needsKey) {
		const action = await vscode.window.showWarningMessage(
			`Comonad: ${choice.label} has no API key for its endpoint.`,
			'Configure provider…',
		);
		if (action) {
			await configureModel(ctx);
		}
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
	const remote = ctx.host.remoteName();
	if (remote && isLoopbackBase(base)) {
		const go = await vscode.window.showWarningMessage(
			`Comonad runs on the remote (${remote}). ${base} is a loopback address there: it reaches the remote machine, not your local one.`,
			'Continue anyway',
		);
		if (go !== 'Continue anyway') {
			return;
		}
	}
	// A profile on an endpoint that is already configured inherits the provider-level facts; the
	// per-model ones (pricing, window, samplers) are copied later only if it declares the same model.
	// Hand-written profiles get the same completion from `inheritProfileDefaults` (services/settings.ts):
	// keep the two field groups in sync.
	const identity = normalizeEndpoint(base);
	const match = ctx.settings.get().profiles.find((profile) => identity && normalizeEndpoint(profile.base) === identity);
	const keyEnvAnswer = await vscode.window.showInputBox({
		prompt: 'Environment variable(s) holding the key, comma separated (optional)',
		value: profileKeyEnvs(match ?? shipped ?? { id: '', model: '' }).join(', '),
		ignoreFocusOut: true,
	});
	if (keyEnvAnswer === undefined) {
		return;
	}
	const keyEnv = keyEnvAnswer
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);
	const profile: Profile = { id, base, model: '', includeUsage: match?.includeUsage ?? true };
	if (match) {
		profile.provider = match.provider;
		profile.modelPrefix = match.modelPrefix;
		profile.modelSkip = match.modelSkip;
		profile.thinkingOff = match.thinkingOff;
		profile.topEffort = match.topEffort;
		profile.keyEnv = keyEnv.length ? keyEnv : match.keyEnv;
	} else if (keyEnv.length) {
		profile.keyEnv = keyEnv;
	}
	const existing = await ctx.llm.resolveKey(profile);
	const key = await vscode.window.showInputBox({
		prompt: existing
			? 'API key — this endpoint already has a saved key; leave empty to reuse it'
			: keyEnv.length
				? `API key — stored by VS Code for this endpoint; leave empty to read ${keyEnv.join(' or ')} from the ${remote ? 'remote ' : ''}environment`
				: 'API key — stored by VS Code for this endpoint',
		password: true,
		ignoreFocusOut: true,
	});
	if (key === undefined) {
		return;
	}
	// Ask the endpoint what it offers, so the saved profile names a model that exists. The key is used
	// here but only stored after the profile is saved, so cancelling leaves no secret behind.
	const probe = await ctx.llm.probeModels(profile, key || existing, true);
	if (probe.error) {
		void vscode.window.showWarningMessage(`Comonad: could not list models from ${base}: ${probe.error}`);
	}
	const declared = match?.model ?? shipped?.model ?? '';
	const offered = probe.ids.length ? probe.ids : declared ? [declared] : [];
	const model = await vscode.window.showQuickPick(
		offered.filter((value, index, all) => all.indexOf(value) === index),
		{ title: `${id}: pick the model`, ignoreFocusOut: true },
	);
	if (!model) {
		const typed = await vscode.window.showInputBox({ prompt: 'Model name', value: declared, ignoreFocusOut: true });
		if (!typed) {
			return;
		}
		profile.model = typed;
	} else {
		profile.model = model;
	}
	// The metadata belongs to the model, not to the endpoint: copy it from any configured profile that
	// declares this exact model (DeepSeek Pro prices and window are not Flash's), not merely from the
	// first profile on the endpoint.
	const declaredBy = identity
		? ctx.settings.get().profiles.find((item) => item.model === profile.model && normalizeEndpoint(item.base) === identity)
		: undefined;
	if (declaredBy) {
		profile.label = declaredBy.label;
		profile.topEffort = declaredBy.topEffort;
		profile.contextWindow = declaredBy.contextWindow;
		profile.pricingIn = declaredBy.pricingIn;
		profile.pricingCachedIn = declaredBy.pricingCachedIn;
		profile.pricingOut = declaredBy.pricingOut;
		profile.temperature = declaredBy.temperature;
		profile.topP = declaredBy.topP;
		profile.maxTokens = declaredBy.maxTokens;
	}
	const profiles = ctx.settings.get().profiles.filter((item) => item.id !== id);
	profiles.push(profile);
	await ctx.settings.update('profiles', profiles);
	await ctx.settings.update('model', `${id}:${profile.model}`);
	if (key) {
		await ctx.llm.setSecret(id, key, base);
	}
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
	policies: tabIcon('<path d="M8 2.2 12.5 4v3.2c0 2.8-1.8 5-4.5 5.6-2.7-.6-4.5-2.8-4.5-5.6V4z"/><path d="M5.8 7.6 7.3 9l3-3"/>'),
	ui: tabIcon(
		'<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6h11M6 6v7"/>',
	),
	subagents: tabIcon(
		'<rect x="2.5" y="4" width="4.2" height="4.2" rx="1"/><rect x="9.3" y="4" width="4.2" height="4.2" rx="1"/><rect x="2.5" y="9.8" width="4.2" height="4.2" rx="1"/><path d="M9.4 10.1h4M11.4 8.1v4"/>',
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

/** What the scope selector needs before the first state push arrives. */
export interface SettingsDocumentScope {
	/** The scope a fresh document (no remembered pick) starts on. */
	defaultScope: SettingsScope;
	folderOpen: boolean;
	trusted: boolean;
	/** Display paths, so the first paint names the right file. */
	userFile: string;
	workspaceFile: string;
}

export function settingsDocument(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	scope: SettingsDocumentScope,
): string {
	const nonce = randomBytes(16).toString('base64');
	const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'settings.js'));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'settings.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; connect-src https://cdn.jsdelivr.net; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
</head>
<body>
  <aside id="side">
    <input id="search" class="control" type="search" placeholder="Search settings" spellcheck="false" autocomplete="off" />
    <nav id="tabs" role="tablist" aria-orientation="vertical" aria-label="Comonad settings">
${tabButton('agent', 'Agent', 'Agent — model, workspace, conversation', TAB_ICONS.agent)}
${tabButton('policies', 'Policies', 'Policies — the runtime policy pipeline', TAB_ICONS.policies)}
${tabButton('ui', 'UI', 'UI — how the conversation is displayed', TAB_ICONS.ui)}
${tabButton('subagents', 'Subagents', 'Subagents — step budget and per-agent capability grants', TAB_ICONS.subagents)}
${tabButton('mcp', 'MCP', 'MCP — servers and their status', TAB_ICONS.mcp)}
${tabButton('tools', 'Tools', 'Tools — what a turn may run', TAB_ICONS.tools)}
${tabButton('prompts', 'Prompts', 'Prompts — Comonad blocks and tool definitions', TAB_ICONS.prompts)}
${tabButton('inspect', 'Inspect', 'Inspect — the tool policy flow and plugin dependencies', TAB_ICONS.inspect)}
${tabButton('plugins', 'Plugins', 'Plugins — every plugin in the tree, and what became of it', TAB_ICONS.plugins)}
    </nav>
    <div id="side-foot">
      <div id="status"></div>
      <div class="row">
        <button class="secondary" id="close" type="button" title="Close"><span class="btn-icon" aria-hidden="true">✕</span><span class="btn-label">Close</span></button>
      </div>
    </div>
  </aside>
  <div id="side-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the settings sidebar" tabindex="0"></div>

  <main id="content">
  <div id="scope-bar" class="scope-bar">
    <div class="scope-row">
      <span class="scope-title">&#9881;&#65039; Setting Scope:</span>
      <div id="scope-tabs" class="scope-tabs" role="tablist" aria-label="Where settings are saved">
        <button class="scope-tab" type="button" role="tab" data-scope="user" aria-selected="${scope.defaultScope === 'user'}" title="User — global defaults for every workspace"><span class="scope-icon" aria-hidden="true">&#128100;</span><span>User</span></button>
        <button class="scope-tab" type="button" role="tab" data-scope="workspace" aria-selected="${scope.defaultScope === 'workspace'}" title="Workspace — this workspace only"><span class="scope-icon" aria-hidden="true">&#128193;</span><span>Workspace</span></button>
      </div>
      <button id="scope-path" class="link scope-path" type="button" title="Open the settings file in the editor"></button>
    </div>
    <p id="scope-hint" class="hint scope-hint"></p>
  </div>
  <section data-pane="agent">
    <h1 class="page-title">Agent</h1>
    <p class="group-note">Work mode, network, user rules, approvals and sandbox live in the <strong>Policies</strong> tab.</p>
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
        <p class="hint">Seconds before a shell command is killed. The model's fallback when it picks no timeout, and the fixed value when the override below is on.</p>
        <input id="timeout" class="control" type="number" min="1" data-key="commandTimeout" />
      </div>
      <div class="field">
        <label for="timeout-override">Always use the command timeout</label>
        <p class="hint">On: every foreground shell command gets the timeout above, ignoring the model's own. Off: the model chooses a timeout per call (clamped to 1–300 seconds), and the timeout above is the fallback when it omits one. Background tasks started with start_shell have no timeout.</p>
        <label class="check"><input type="checkbox" id="timeout-override" data-key="commandTimeoutOverride" /></label>
      </div>
      <div class="field">
        <label for="plans">Plan directory</label>
        <p class="hint">Workspace-relative folder for plan files.</p>
        <input id="plans" class="control" type="text" data-key="planDirectory" spellcheck="false" placeholder=".comonad/plans" />
      </div>
    </div>
    <h2 class="group-title">Conversation</h2>
    <div class="group">
      <div class="field">
        <label for="context">Context</label>
        <p class="hint">What the model actually receives: rendered text, token counts or raw form. Applies to the active chat and is the default for new chats.</p>
        <select id="context" class="control" data-key="contextForm"></select>
      </div>
      <div class="field">
        <label for="compaction-headroom">Summarize headroom</label>
        <p class="hint">Tokens kept free before a request triggers a summary. Checked before every model request; <code>0</code> turns proactive compaction off and leaves only the hard-limit trimming. Capped at half the window.</p>
        <input id="compaction-headroom" class="control" type="number" min="0" max="2000000" step="1000" data-key="compactionHeadroom" />
      </div>
      <div class="field">
        <label for="compaction-retain">Keep after summarizing</label>
        <p class="hint">Percent of the window kept verbatim after a summary. The newest turn is always kept; <code>/summarize</code> still folds everything before it.</p>
        <input id="compaction-retain" class="control" type="number" min="5" max="80" step="1" data-key="compactionRetainPercent" />
      </div>
    </div>
    <h2 class="group-title">Run budgets</h2>
    <div class="group">
      <p class="hint">Four independent hard limits for the main agent. Each one stops the run at its limit and keeps a partial transcript; 0 means no limit. Tokens are input + output; time is wall clock in milliseconds.</p>
      <div class="field">
        <label for="budget-turns">Turns</label>
        <input id="budget-turns" class="control" type="number" min="0" step="1" />
      </div>
      <div class="field">
        <label for="budget-tools">Tool calls</label>
        <input id="budget-tools" class="control" type="number" min="0" step="1" />
      </div>
      <div class="field">
        <label for="budget-tokens">Tokens</label>
        <input id="budget-tokens" class="control" type="number" min="0" step="1" />
      </div>
      <div class="field">
        <label for="budget-milliseconds">Time (ms)</label>
        <input id="budget-milliseconds" class="control" type="number" min="0" step="1" />
      </div>
    </div>
  </section>

  <section data-pane="policies" hidden>
    <h1 class="page-title">Policies</h1>
    <p class="group-note">Every tool call walks these layers in order. The first layer that stops it ends the call; a call that reaches the end runs under the sandbox.</p>
    <h2 class="group-title">1 · Capability</h2>
    <div class="group">
      <div class="field">
        <label for="mode">Work mode</label>
        <p class="hint">The capability set a turn may use at all. A call outside it never reaches the later layers.</p>
        <select id="mode" class="control" data-key="mode"></select>
      </div>
    </div>
    <h2 class="group-title">2 · Network</h2>
    <div class="group">
      <div class="field">
        <label for="network">Network access policy</label>
        <p class="hint">On: network tools and network inside the shell sandbox may run. Off: both are refused; loopback stays available inside the sandbox so local test servers work.</p>
        <label class="check"><input type="checkbox" id="network" data-key="network" /></label>
      </div>
    </div>
    <h2 class="group-title">3 · User rules</h2>
    <div class="group">
      <div class="field">
        <label for="rules-deny">Deny</label>
        <p class="hint">Checked first and rejects the call, whatever the tool approval policy says.</p>
        <textarea id="rules-deny" class="control" data-key="deny" spellcheck="false" rows="3" placeholder="run_shell(rm:*)"></textarea>
      </div>
      <div class="field">
        <label for="rules-ask">Ask</label>
        <p class="hint">Checked second and asks you, even under an accept policy.</p>
        <textarea id="rules-ask" class="control" data-key="ask" spellcheck="false" rows="3" placeholder="run_shell(git push:*)"></textarea>
      </div>
      <div class="field">
        <label for="rules-allow">Allow</label>
        <p class="hint">Checked last and runs the call without asking. One rule per line: <code>tool</code> or <code>tool(pattern)</code> — <code>run_shell(npm run test:*)</code>, <code>read_file(./.env)</code>, <code>fetch_url(domain:example.com)</code>. “Always allow” in the approval prompt appends here. The later layers are consulted only when none of the three lists matches.</p>
        <textarea id="rules-allow" class="control" data-key="allow" spellcheck="false" rows="3" placeholder="run_shell(npm run test:*)"></textarea>
      </div>
    </div>
    <h2 class="group-title">4 · Tool approval</h2>
    <div class="group">
      <div class="field">
        <label for="approval">Tool approval policy</label>
        <p class="hint">Applied only when no user rule matched. It decides which calls run, which ask, and which are rejected.</p>
        <select id="approval" class="control" data-key="approval"></select>
      </div>
    </div>
    <h2 class="group-title">5 · Approval response</h2>
    <div class="group">
      <div class="field">
        <label for="approval-response">Approval response policy</label>
        <p class="hint">Who answers a request the tool approval policy raised. <code>ask</code> sends it to the chat surface and denies when no surface answers; <code>never</code> denies every request outright.</p>
        <select id="approval-response" class="control" data-key="approvalResponse"></select>
      </div>
    </div>
    <h2 class="group-title">6 · Sandbox</h2>
    <div class="group">
      <div class="field">
        <label for="sandbox-mode">Sandbox mode</label>
        <p class="hint">The OS-enforced read and write range for every approved call. It is applied by the file tools and by <code>sandbox-exec</code>/<code>bwrap</code>; a call may narrow it but never widen it.</p>
        <select id="sandbox-mode" class="control" data-key="sandboxMode"></select>
      </div>
      <div class="field">
        <label for="deny">Deny read paths</label>
        <p class="hint">One workspace-relative path or basename per line — file and shell tools refuse to read or write them.</p>
        <textarea id="deny" class="control" data-key="denyReadPaths" spellcheck="false" rows="3"></textarea>
      </div>
      <p class="group-note">A workspace-write shell gets a temporary directory at <code>.comonad/tmp</code>. The test shell (<code>run_shell_test</code>) writes only <code>.comonad/scratch/&lt;session&gt;</code>, exposed as <code>$COMONAD_SCRATCH</code> with <code>TMPDIR</code>, <code>HOME</code> and <code>XDG_CACHE_HOME</code> pointing there. Workspace-read also hides files like <code>~/.gitconfig</code> and <code>~/.npmrc</code> from git and npm. Changes on this tab apply immediately; a running turn keeps its policy, so they take effect from the next message.</p>
      <p class="group-note" id="environment-note"></p>
    </div>
  </section>

  <section data-pane="ui" hidden>
    <h1 class="page-title">UI</h1>
    <h2 class="group-title">Conversation</h2>
    <div class="group">
      <div class="field">
        <label for="display">Display</label>
        <p class="hint">How the context sent with a turn is shown in the chat.</p>
        <select id="display" class="control" data-key="displayForm"></select>
      </div>
      <div class="field">
        <label for="toolCard">Tool cards</label>
        <p class="hint">How a tool call starts out: folded to the header alone (the default), folded with a preview of its output, or open with the command and output.</p>
        <select id="toolCard" class="control" data-key="toolCard"></select>
      </div>
    </div>
    <h2 class="group-title">Notifications</h2>
    <div class="group">
      <div class="field">
        <label for="question-notification">Question notification</label>
        <p class="hint">Show a VS Code notification when a question waits for an answer and the chat panel is closed.</p>
        <label class="check"><input type="checkbox" id="question-notification" data-key="questionNotification" /></label>
      </div>
    </div>
  </section>

  <section data-pane="subagents" hidden>
    <h1 class="page-title">Subagents</h1>
    <h2 class="group-title">Default budget</h2>
    <div class="group">
      <div class="field">
        <label for="subagent-budget-mode">Budget source</label>
        <select id="subagent-budget-mode" class="control" data-key="subagentBudgetMode">
          <option value="inherit">Inherit from parent</option>
          <option value="custom">Custom — the budget below</option>
        </select>
        <p class="hint">Inherit copies the main agent's four limits (not a shared pool); task budgets can still tighten, and a resume segment cannot be smaller than the previous one. If the main agent is unlimited (all 0), children are unlimited too.</p>
      </div>
      <p class="hint" id="subagent-budget-note"></p>
      <p class="hint">Custom four-dimensional budget for a child agent. A role definition and a task plan can only tighten it. 0 means no limit.</p>
      <div class="field">
        <label for="subagent-budget-turns">Turns</label>
        <input id="subagent-budget-turns" class="control" type="number" min="0" step="1" />
      </div>
      <div class="field">
        <label for="subagent-budget-tools">Tool calls</label>
        <input id="subagent-budget-tools" class="control" type="number" min="0" step="1" />
      </div>
      <div class="field">
        <label for="subagent-budget-tokens">Tokens</label>
        <input id="subagent-budget-tokens" class="control" type="number" min="0" step="1" />
      </div>
      <div class="field">
        <label for="subagent-budget-milliseconds">Time (ms)</label>
        <input id="subagent-budget-milliseconds" class="control" type="number" min="0" step="1" />
      </div>
    </div>
    <h2 class="group-title">Agents</h2>
    <p class="group-note">Every subagent can use read-only tools, including the plan readers when the parent's effective capabilities include <code>ro_plan</code>. The grants below add the ability to write files and run tests; full shell and plan writes are never granted. Changes apply to the next spawn.</p>
    <p class="group-note">A delegation inherits the parent policy and can only narrow it. Its approval response is always <code>never</code>, so a call it would ask about is denied; a write-capable agent needs an inherited allow rule or <code>approval: "universal_accept"</code> on the delegation.</p>
    <div id="subagent-rows"></div>
    <details class="help-fold">
      <summary>How permissions work</summary>
      <p class="group-note">Read-only tools are always available; the plan readers (<code>list_plans</code>, <code>read_plan</code>) use <code>ro_plan</code> and appear only when the parent's effective capabilities include it. <b>Write files</b> grants the tracked write tools (<code>write_file</code>, <code>edit_text</code>, <code>edit_ranges</code>); <b>Run tests</b> grants <code>run_shell_test</code>, whose workspace is read-only and whose only writable place is the scratch directory. Full shell and plan writes (<code>write_plan</code>, <code>edit_plan</code>) are never granted to a subagent. The agent's own <code>tools</code> list still selects which tools it uses, and the parent's effective capabilities must include them too. Changes apply to the next spawn.</p>
    </details>
  </section>


  <section data-pane="prompts" hidden>
    <h1 class="page-title">Prompts</h1>
    <div class="group">
      <p class="hint" id="prompts-note"></p>
      <div id="pr-wrap">
        <div class="field">
          <label>Comonad blocks and tool definitions</label>
          <p class="hint">Comonad's blocks carry the static prefix you can edit; the dynamic content below it is generated every turn. Tools keep the definitions their plugins register — this page only orders and switches them. Pick a row to view or edit it.</p>
          <p class="hint" id="pr-chat"></p>
          <div id="pr-list"></div>
        </div>
      </div>
      <div class="row">
        <button class="primary" id="pr-save" type="button" title="Write this layout to settings">Save</button>
        <button class="secondary" id="pr-reset" type="button" title="Reset prefixes and tool switches; block order returns to the shipped order">Reset to defaults</button>
        <button class="secondary" id="pr-refresh" type="button" title="Read the prompts again">Refresh</button>
      </div>
    </div>
  </section>

  <section data-pane="inspect" hidden>
    <h1 class="page-title">Inspect</h1>
    <nav id="inspect-tabs" role="tablist" aria-label="Inspect">
      <button class="subtab" type="button" role="tab" data-inspect="flow" title="Tool Policy Flow — how one tool call is gated">Tool Policy Flow (TPF)</button>
      <button class="subtab" type="button" role="tab" data-inspect="plugins" title="Plugins — how the tree is wired: what each plugin provides, and what needs it">Plugins</button>
    </nav>

    <div data-inspect-pane="flow">
      <div class="group">
        <div id="flow" class="diagram"></div>
      </div>
    </div>

    <div data-inspect-pane="plugins" hidden>
      <div class="group">
        <div class="field">
          <label>Plugins</label>
          <p class="hint">
            What the tree is wired with, plugin by plugin: what each one <strong>provides</strong> (a
            service other plugins can inject) and its state. Pick a plugin for its dependency tree: the
            services it <strong>needs</strong> and who provides each, what it waits for when nobody does,
            and the whole chain that goes down with it.
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
        <label>Plugin list</label>
        <p class="hint">
          Everything Comonad is made of, in load order. A plugin comes from the extension's own list,
          from the workspace's <span class="mono">cordis.yml</span> when it is trusted, or from yours —
          a later file overrides an earlier one. Turning a plugin off writes into the workspace's list
          when the workspace is trusted, or into yours otherwise — the same change you could make by
          hand, and the same place a plugin of your own is mounted from.
        </p>
        <div class="plugin-config">
          <div class="plugin-config-head">
            <span class="plugin-config-title">Config files</span>
            <button class="secondary" id="plugins-reload" type="button" title="Re-read the config files and apply only the rows that changed; plugins that did not change keep running">Refresh from config</button>
          </div>
          <dl class="plugin-config-rows">
            <dt>user</dt>
            <dd class="mono" id="plugins-user"></dd>
            <dt>workspace</dt>
            <dd class="mono" id="plugins-project"></dd>
          </dl>
        </div>
        <div class="row">
          <button class="secondary" id="plugins-install" type="button" title="Install — copy a plugin into your library and add its entry">Install…</button>
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
        <p class="hint">Every registered tool with what it needs. The work mode decides which capabilities exist; the tool approval policy and sandbox mode decide what happens to a call. Hover a row for the tool's description.</p>
        <table id="tools"></table>
      </div>
    </div>
  </section>
  </main>
<script src="https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.min.js"></script>
<script nonce="${nonce}" src="${script}" data-scope="${scope.defaultScope}" data-folder-open="${scope.folderOpen}" data-trusted="${scope.trusted}" data-user-file="${escapeHtml(scope.userFile)}" data-workspace-file="${escapeHtml(scope.workspaceFile)}"></script>
</body>
</html>`;
}
