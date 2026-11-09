// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { sandboxKind } from './lib/sandbox';
import {
	defaultWriteScope,
	mergeSettings,
	migrateLegacySettings,
	readSettings,
	settingsFile,
	writeSettings,
	type SettingsScope,
} from './lib/settings-file';
import { describe } from './lib/util';
import { hostStorage, type Host } from './services/host';

/** The VS Code implementation of the Host contract. This is the only vscode-bound core module. */

export interface HostConfig {
	extension: vscode.ExtensionContext;
}

/** Every `comonad.*` key the manifest declares, kernel and plugin keys alike: what an import reads. */
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

	// `COMONAD_HOME` moves the user's library — and therefore their settings file — into a home of
	// its own; the test host sets it so a developer's real `~/.comonad` is never read.
	const home = (): string => process.env.COMONAD_HOME?.trim() || homedir();
	const workspace = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	const trusted = (): boolean => vscode.workspace.isTrusted;
	const fileOf = (scope: SettingsScope): string => settingsFile(home(), workspace(), scope);
	/** The manifest's key list is the import registry; the files themselves are the store. */
	const keys = declaredKeys();
	/** Saves made by this process, so the watchers do not answer them as external edits. */
	const written = new Map<string, string>();
	let cached: Record<string, unknown> | undefined;

	const invalidate = (): void => {
		cached = undefined;
	};

	const readLayer = (file: string, label: string): Record<string, unknown> => {
		const result = readSettings(file);
		if (result.error) {
			output.appendLine(`settings: ${label}: ${result.error}`);
		}
		return result.data;
	};

	/** The effective record: user file first, the trusted workspace file over it. */
	const readConfig = (): Record<string, unknown> => {
		if (!cached) {
			const user = readLayer(fileOf('user'), 'user settings');
			const project = workspace() && trusted() ? readLayer(fileOf('workspace'), 'workspace settings') : {};
			cached = mergeSettings(user, project);
		}
		return cached;
	};

	/** Writes one scope file and remembers the text, so its watcher event is recognisable. */
	const writeScope = (file: string, data: Record<string, unknown>): void => {
		const result = writeSettings(file, data);
		if (result.backup) {
			output.appendLine(`settings: ${file} was not valid JSON; copied it to ${result.backup}`);
		}
		if (file === fileOf('user') && process.platform !== 'win32') {
			// MCP headers and env can hold tokens; the user's file is theirs alone.
			try {
				chmodSync(file, 0o600);
			} catch {
				// Best effort: a filesystem that cannot chmod still gets the content.
			}
		}
		try {
			written.set(file, readFileSync(file, 'utf8'));
		} catch {
			// The watcher will simply treat the next event as an external edit.
		}
		invalidate();
	};

	const requireWritable = (scope: SettingsScope): string => {
		const file = fileOf(scope);
		if (!file) {
			throw new Error('Open a workspace folder before using workspace settings.');
		}
		if (scope === 'workspace' && !trusted()) {
			throw new Error('Trust this workspace before using workspace settings.');
		}
		return file;
	};

	const update: Host['update'] = async (key, value, scope) => {
		const project = workspace() && trusted() ? readSettings(fileOf('workspace')).data : undefined;
		const target = scope ?? defaultWriteScope(key, project);
		const file = requireWritable(target);
		const existing = readSettings(file).data;
		writeScope(file, { ...existing, [key]: value });
	};

	// The one-time import of VS Code's explicitly-set `comonad.*` values. It runs before the host is
	// provided, so the very first `settings.get()` already sees the new files.
	const importLegacy = (): void => {
		try {
			const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
			const section = folder ? vscode.workspace.getConfiguration('comonad', folder) : vscode.workspace.getConfiguration('comonad');
			migrateLegacySettings({
				markerFile: join(extension.globalStorageUri.fsPath, 'settings-migration.json'),
				userFile: fileOf('user'),
				workspaceFile: fileOf('workspace'),
				keys,
				inspect: (key) => section.inspect(key),
				trusted: trusted(),
			});
		} catch (error) {
			output.appendLine(`settings: legacy import failed: ${describe(error)}`);
		}
	};
	importLegacy();

	const service: Host = {
		storage: hostStorage(extension.globalStorageUri.fsPath),
		extensionUri: extension.extensionUri,
		home,
		workspace,
		trusted,
		config: () => ({ ...readConfig() }),
		update,
		settingsPath: fileOf,
		secret: (id) => Promise.resolve(extension.secrets.get(id)),
		setSecret: (id, value) => Promise.resolve(extension.secrets.store(id, value)),
		deleteSecret: (id) => Promise.resolve(extension.secrets.delete(id)),
		env: (name) => process.env[name],
		remoteName: () => vscode.env.remoteName,
		sandboxKind: () => sandboxKind(),
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
	ctx.log.message(`host: ${vscode.env.remoteName ? `remote (${vscode.env.remoteName})` : 'local'} · sandbox: ${sandboxKind()}`);

	/** A file change we did not make: drop the cache and let every surface read again. */
	const external = (uri: vscode.Uri): void => {
		let text: string | undefined;
		try {
			text = readFileSync(uri.fsPath, 'utf8');
		} catch {
			text = undefined;
		}
		if (text !== undefined && written.get(uri.fsPath) === text) {
			return;
		}
		invalidate();
		ctx.emit('settings/file-changed');
		ctx.emit('settings/changed');
	};

	ctx.effect(() => {
		// The user's file lives outside the workspace; the workspace pattern follows folder changes.
		const userWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(home()), '.comonad/settings.json'),
		);
		const projectWatcher = vscode.workspace.createFileSystemWatcher('**/.comonad/settings.json');
		for (const watcher of [userWatcher, projectWatcher]) {
			watcher.onDidCreate(external);
			watcher.onDidChange(external);
			watcher.onDidDelete(external);
		}
		const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			importLegacy();
			invalidate();
			ctx.emit('settings/file-changed');
			ctx.emit('settings/changed');
		});
		const trust = vscode.workspace.onDidGrantWorkspaceTrust(() => {
			importLegacy();
			invalidate();
			ctx.emit('settings/file-changed');
			ctx.emit('settings/changed');
		});
		return () => {
			userWatcher.dispose();
			projectWatcher.dispose();
			folders.dispose();
			trust.dispose();
		};
	});
}
host.inject = ['log'];
