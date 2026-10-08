import type { Context } from 'cordis';
import { host, type HostConfig } from './host';
import { openaiPlugin } from './llm/openai';
import { reactions } from './plugins/reactions';
import { agentPlugin } from './services/agent';
import { approvalPlugin } from './services/approval';
import { auditPlugin } from './services/audit';
import { catalogPlugin } from './services/catalog';
import { checkpointsPlugin } from './services/checkpoints';
import { commandsPlugin } from './services/commands';
import { hooksPlugin } from './services/hooks';
import { llmPlugin } from './services/llm';
import { logPlugin } from './services/log';
import { mcpPlugin } from './services/mcp';
import { sessionsPlugin } from './services/sessions';
import { settingsPlugin } from './services/settings';
import { tavernPlugin } from './services/tavern';
import { tasksPlugin } from './services/tasks';
import { toolsPlugin } from './services/tools';
import { usagePlugin } from './services/usage';
import { fsTools } from './tools/fs';
import { mathTools } from './tools/math';
import { agentTools, askTools, memoryTools, skillTools } from './tools/misc';
import { planTools } from './tools/plan';
import { shellTools } from './tools/shell';
import { todoTools } from './tools/todo';
import { vscodeTools } from './tools/vscode';
import { loreToolPlugin } from './tools/tavern';import { webTools } from './tools/web';
import { chatPanel } from './ui/chat-panel';
import { inline } from './ui/inline';
import { palette } from './ui/palette';
import { participant } from './ui/participant';
import { review } from './ui/review';
import { sessionsView } from './ui/sessions-view';
import { settingsPanel } from './ui/settings-panel';
import { slashCommands } from './ui/slash';
import { tavernCommands } from './ui/tavern';
import { controls } from './ui/status';
import { tasksView } from './ui/tasks-view';

/** The Comonad application: one Cordis plugin tree, assembled here and nowhere else. */
export interface ComonadConfig {
	extension: HostConfig['extension'];
}

export const name = 'comonad';

export function apply(ctx: Context, config: ComonadConfig): void {
	// Platform: logging, host bindings, settings.
	ctx.plugin(logPlugin);
	ctx.plugin(host, { extension: config.extension });
	ctx.plugin(settingsPlugin);

	// Kernel services. Load order is irrelevant: `inject` resolves dependencies.
	ctx.plugin(auditPlugin);
	ctx.plugin(sessionsPlugin);
	ctx.plugin(checkpointsPlugin);
	ctx.plugin(usagePlugin);
	ctx.plugin(tasksPlugin);
	ctx.plugin(toolsPlugin);
	ctx.plugin(catalogPlugin);
	ctx.plugin(tavernPlugin);
	ctx.plugin(llmPlugin);
	ctx.plugin(hooksPlugin);
	ctx.plugin(mcpPlugin);
	ctx.plugin(approvalPlugin);
	ctx.plugin(commandsPlugin);
	ctx.plugin(agentPlugin);

	// The model adapter: every profile is an OpenAI-compatible endpoint (DeepSeek by default).
	ctx.plugin(openaiPlugin);

	// Tool providers.
	for (const tools of [fsTools, shellTools, planTools, todoTools, webTools, vscodeTools, mathTools, askTools, agentTools]) {
		ctx.plugin(tools);
	}
	ctx.plugin(skillTools);
	ctx.plugin(memoryTools);
	ctx.plugin(loreToolPlugin);

	// Command surfaces and UI.
	ctx.plugin(slashCommands);
	ctx.plugin(tavernCommands);
	ctx.plugin(palette);
	ctx.plugin(controls);
	ctx.plugin(sessionsView);
	ctx.plugin(tasksView);
	ctx.plugin(review);
	ctx.plugin(settingsPanel);
	ctx.plugin(inline);
	ctx.plugin(chatPanel);
	ctx.plugin(participant);

	// Environment reactions (watchers, initial loads).
	ctx.plugin(reactions);
}
