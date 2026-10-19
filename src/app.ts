// SPDX-License-Identifier: AGPL-3.0-only
import type { Context, Plugin } from 'cordis';
import { host, type HostConfig } from './host';
import { openaiPlugin } from './llm/openai';
import { reactions } from './plugins/reactions';
import { harnessCompat } from './plugins/harness';
import { agentPlugin } from './services/agent';
import { approvalPlugin } from './services/approval';
import { attachmentsPlugin } from './services/attachments';
import { auditPlugin } from './services/audit';
import { catalogPlugin } from './services/catalog';
import { checkpointsPlugin } from './services/checkpoints';
import { commandsPlugin } from './services/commands';
import { hooksPlugin } from './services/hooks';
import { llmPlugin } from './services/llm';
import { logPlugin } from './services/log';
import { mcpPlugin } from './services/mcp';
import { panesPlugin } from './services/panes';
import { pluginHost, type PluginRow } from './services/plugins';
import { sessionsPlugin } from './services/sessions';
import { settingsPlugin } from './services/settings';
import { tasksPlugin } from './services/tasks';
import { tokenizersPlugin } from './services/tokenizers';
import { toolsPlugin } from './services/tools';
import { usagePlugin } from './services/usage';
import { fsTools } from './tools/fs';
import { mathTools } from './tools/math';
import { agentTools, askTools, memoryTools, skillTools } from './tools/misc';
import { planTools } from './tools/plan';
import { shellTools } from './tools/shell';
import { todoTools } from './tools/todo';
import { vscodeTools } from './tools/vscode';
import { webTools } from './tools/web';
import { chatPanel } from './ui/chat-panel';
import { gitView } from './ui/git-view';
import { inline } from './ui/inline';
import { palette } from './ui/palette';
import { participant } from './ui/participant';
import { sessionsView } from './ui/sessions-view';
import { settingsPanel } from './ui/settings-panel';
import { slashCommands } from './ui/slash';
import { controls } from './ui/status';
import { tasksView } from './ui/tasks-view';

/**
 * The Comonad application: one Cordis plugin tree, written down as rows rather than assembled by hand,
 * so a `cordis.yml` in the project or in the user's library can disable a row, give it a config of its
 * own, or mount a plugin of its own beside it. Only the platform below is not a row: logging, the host
 * bindings and settings are what everything else is loaded *with*, and a tree without them has nothing
 * to load into.
 */
export interface ComonadConfig {
	extension: HostConfig['extension'];
	/**
	 * The rows to apply, and what their ids resolve to. The shipped tree, unless a host wants its own —
	 * which is also how a test can mount the real tree and ask it a question.
	 */
	rows?: PluginRow[];
	plugins?: Record<string, Plugin>;
}

export const name = 'comonad';

/** Every plugin a row can name, by the id the row uses. */
export const PLUGINS: Record<string, Plugin> = {
	// Compatibility with DeepSeek Harness plugins, deliberately first in the list: it redirects the
	// imports every row below may make, so it has to have run before any of them are loaded.
	harness: harnessCompat,
	audit: auditPlugin,
	sessions: sessionsPlugin,
	attachments: attachmentsPlugin,
	checkpoints: checkpointsPlugin,
	usage: usagePlugin,
	tasks: tasksPlugin,
	tools: toolsPlugin,
	catalog: catalogPlugin,
	panes: panesPlugin,
	tokenizers: tokenizersPlugin,
	llm: llmPlugin,
	hooks: hooksPlugin,
	mcp: mcpPlugin,
	approval: approvalPlugin,
	commands: commandsPlugin,
	agent: agentPlugin,
	'provider-openai': openaiPlugin,
	'tools-fs': fsTools,
	'tools-shell': shellTools,
	'tools-plan': planTools,
	'tools-todo': todoTools,
	'tools-web': webTools,
	'tools-vscode': vscodeTools,
	'tools-math': mathTools,
	'tools-ask': askTools,
	'tools-agent': agentTools,
	'tools-skill': skillTools,
	'tools-memory': memoryTools,
	'ui-slash': slashCommands,
	'ui-palette': palette,
	'ui-controls': controls,
	'ui-sessions': sessionsView,
	'ui-tasks': tasksView,
	'ui-git': gitView,
	'ui-settings': settingsPanel,
	'ui-inline': inline,
	'ui-chat': chatPanel,
	'ui-participant': participant,
	reactions,
};

/**
 * The tree as it ships. Order carries no load semantics — `inject` resolves dependencies — so the
 * grouping below is for readers, and the ids are what a user's `cordis.yml` addresses.
 */
export const ROWS: PluginRow[] = [
	// Compatibility, before anything that could import a harness package.
	{ id: 'harness', group: 'compatibility' },

	// Kernel services.
	{ id: 'audit', group: 'kernel' },
	{ id: 'sessions', group: 'kernel' },
	// Image bytes live outside the session JSON; the store is what both the read tool and the composer
	// hand their pictures to.
	{ id: 'attachments', group: 'kernel' },
	// The change journal: on by default, because an irreversible write is a worse default than a
	// shadow repository. One row for the journal and its review surface — off, and a write is just
	// a write again.
	{ id: 'checkpoints', group: 'kernel' },
	{ id: 'usage', group: 'kernel' },
	{ id: 'tasks', group: 'kernel' },
	{ id: 'tools', group: 'kernel' },
	{ id: 'catalog', group: 'kernel' },
	// The settings panel draws whatever panes are registered, whichever plugin brought them.
	{ id: 'panes', group: 'kernel' },
	{ id: 'tokenizers', group: 'kernel' },
	{ id: 'llm', group: 'kernel' },
	{ id: 'hooks', group: 'kernel' },
	{ id: 'mcp', group: 'kernel' },
	{ id: 'approval', group: 'kernel' },
	{ id: 'commands', group: 'kernel' },
	{ id: 'agent', group: 'kernel' },

	// The model adapter: every profile is an OpenAI-compatible endpoint (DeepSeek by default).
	{ id: 'provider-openai', group: 'model' },

	// Tool providers.
	{ id: 'tools-fs', group: 'tools' },
	{ id: 'tools-shell', group: 'tools' },
	{ id: 'tools-plan', group: 'tools' },
	{ id: 'tools-todo', group: 'tools' },
	{ id: 'tools-web', group: 'tools' },
	{ id: 'tools-vscode', group: 'tools' },
	{ id: 'tools-math', group: 'tools' },
	{ id: 'tools-ask', group: 'tools' },
	{ id: 'tools-agent', group: 'tools' },
	{ id: 'tools-skill', group: 'tools' },
	{ id: 'tools-memory', group: 'tools' },

	// Command surfaces and UI.
	{ id: 'ui-slash', group: 'ui' },
	{ id: 'ui-palette', group: 'ui' },
	{ id: 'ui-controls', group: 'ui' },
	{ id: 'ui-sessions', group: 'ui' },
	{ id: 'ui-tasks', group: 'ui' },
	// The real repository's changes: staged, unstaged, untracked and merge.
	{ id: 'ui-git', group: 'ui' },
	{ id: 'ui-settings', group: 'ui' },
	{ id: 'ui-inline', group: 'ui' },
	{ id: 'ui-chat', group: 'ui' },
	{ id: 'ui-participant', group: 'ui' },

	// Environment reactions (watchers). Each service reads its own library when it is constructed.
	{ id: 'reactions', group: 'environment' },
];

export async function apply(ctx: Context, config: ComonadConfig): Promise<void> {
	// Platform: logging, host bindings, settings — mounted directly, in this context, so every row below
	// lands exactly where the application expects its services to be.
	ctx.plugin(logPlugin);
	ctx.plugin(host, { extension: config.extension });
	ctx.plugin(settingsPlugin);

	// Everything else is a row, and the host is the plugin that applies them: one `await` here is what
	// makes the whole tree present by the time this application is active.
	await ctx.plugin(pluginHost, { rows: config.rows ?? ROWS, plugins: config.plugins ?? PLUGINS });
}
