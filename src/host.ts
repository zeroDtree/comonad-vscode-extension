import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { CONFIG_KEYS } from './services/settings';
import { hostStorage, type Host } from './services/host';

/** The VS Code implementation of the Host contract. This is the only vscode-bound core module. */

export interface HostConfig {
	extension: vscode.ExtensionContext;
}

export function host(ctx: Context, config: HostConfig): void {
	const { extension } = config;
	const output = vscode.window.createOutputChannel('Comonad');
	ctx.effect(() => () => output.dispose());

	const service: Host = {
		storage: hostStorage(extension.globalStorageUri.fsPath),
		extensionUri: extension.extensionUri,
		home: () => homedir(),
		workspace: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
		trusted: () => vscode.workspace.isTrusted,
		config: () => {
			const section = vscode.workspace.getConfiguration('comonad');
			const record: Record<string, unknown> = {};
			for (const key of CONFIG_KEYS) {
				const value = section.get(key);
				if (value !== undefined) {
					record[key] = value;
				}
			}
			return record;
		},
		update: async (key, value) => {
			await vscode.workspace.getConfiguration('comonad').update(key, value, vscode.ConfigurationTarget.Workspace);
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
