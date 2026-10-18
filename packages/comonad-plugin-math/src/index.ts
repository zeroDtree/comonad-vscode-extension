// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path';
import type { Context, Plugin } from 'cordis';
import type { ChatAssetSpec } from '@comonad/services/chat-assets';

/**
 * Markdown math for the chat, as an installable plugin: the chat webview gets KaTeX, its stylesheet
 * and the fonts beside this bundle, and the core's math hook calls into it. The copy handler the
 * webview script installs turns a selected formula back into its `$...$` / `$$...$$` source.
 *
 * The client script is loaded before `chat.js`, so `window.__comonadMath` exists before the first
 * message is drawn. It must never call `acquireVsCodeApi`: the chat script owns that one bridge.
 */

export interface MathPluginConfig {
	/** The folder holding `math.js`, `katex.min.css`, `math.css` and `fonts/`; tests override it. */
	resources?: string;
}

export async function apply(ctx: Context, config: MathPluginConfig = {}): Promise<void> {
	const resources = config.resources ?? join(__dirname, '..', 'resources');
	const contribution: ChatAssetSpec = {
		id: 'math',
		scripts: [join(resources, 'math.js')],
		styles: [join(resources, 'katex.min.css'), join(resources, 'math.css')],
		roots: [resources],
	};
	ctx.effect(() => ctx.chatWebview.register(contribution));
}

const plugin = apply as Plugin.Function;
Object.defineProperty(plugin, 'name', { value: 'math', configurable: true });
plugin.inject = ['chatWebview'];
export default plugin;
