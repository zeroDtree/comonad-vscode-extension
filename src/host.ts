// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { hostStorage, type Host } from './services/host';

/** The VS Code implementation of the Host contract. This is the only vscode-bound core module. */

export interface HostConfig {
	extension: vscode.ExtensionContext;
}

/**
 * Where a settings write lands. A window with no folder open has no workspace settings to write, and
 * VS Code refuses that write rather than redirecting it, so the value goes to the user's own settings
 * instead: a mode or an approval picked from the chat still sticks in a window with no folder.
 */
export function settingsTarget(hasFolder: boolean): vscode.ConfigurationTarget {
	return hasFolder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

/** Every `comonad.*` key the manifest declares, kernel and plugin keys alike: what the section holds. */
function declaredKeys(): string[] {
	const manifest = vscode.extensions.getExtension('comonad.comonad')?.packageJSON as
		| { contributes?: { configuration?: { properties?: Record<string, unknown> } } }
		| undefined;
	const properties = manifest?.contributes?.configuration?.properties ?? {};
	return Object.keys(properties)
		.filter((key) => key.startsWith('comonad.'))
		.map((key) => key.slice('comonad.'.length));
}

export function host(ctx: Context, config: HostConfig): void {
	const { extension } = config;
	const output = vscode.window.createOutputChannel('Comonad');
	ctx.effect(() => () => output.dispose());

	const service: Host = {
		storage: hostStorage(extension.globalStorageUri.fsPath),
		extensionUri: extension.extensionUri,
		// `COMONAD_HOME` moves everything Comonad keeps in a home of its own — the plugin library and its
		// rows, the harness shims, the catalog, the instruction layers. The test host sets it so the
		// plugins you run, and the rows you wrote for them, never change what a test sees.
		home: () => process.env.COMONAD_HOME?.trim() || homedir(),
		workspace: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
		trusted: () => vscode.workspace.isTrusted,
		config: () => {
			const section = vscode.workspace.getConfiguration('comonad');
			const record: Record<string, unknown> = {};
			// The manifest is the one list of what the section holds — the kernel's keys and a plugin's
			// own alike — so a key a plugin reads is a key the host reports, with no kernel list to update.
			for (const key of declaredKeys()) {
				const value = section.get(key);
				if (value !== undefined) {
					record[key] = value;
				}
			}
			return record;
		},
		update: async (key, value) => {
			const target = settingsTarget(Boolean(vscode.workspace.workspaceFolders?.length));
			await vscode.workspace.getConfiguration('comonad').update(key, value, target);
		},
		secret: (id) => Promise.resolve(extension.secrets.get(id)),
		setSecret: (id, value) => Promise.resolve(extension.secrets.store(id, value)),
		env: (name) => process.env[name],
		ask: async (question, options, multi) => {
			if (options?.length) {
				const picked = await vscode.window.showQuickPick(options, { title: question, canPickMany: Boolean(multi), ignoreFocusOut: true });
				return Array.isArray(picked) ? picked : picked ? [picked] : [];
			}
			const answer = await vscode.window.showInputBox({ prompt: question, ignoreFocusOut: true });
			return answer ? [answer] : [];
		},
		notify: (message) => void vscode.window.showInformationMessage(`Comonad: ${message}`),
	};
	ctx.provide('host', service);
	ctx.log.attach({ write: (line) => output.appendLine(line), show: () => output.show() });

	ctx.effect(() => {
		const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('comonad')) {
				ctx.emit('settings/changed');
			}
		});
		return () => subscription.dispose();
	});
}
host.inject = ['log'];
