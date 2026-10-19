// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path';
import type { SandboxKind } from '../lib/sandbox';

/**
 * The Host contract: everything the kernel needs from its embedding environment,
 * implemented by the VS Code plugin and trivially fakeable in tests.
 */

export interface HostStorage {
	root: string;
	sessions: string;
	attachments: string;
	checkpoints: string;
	memory: string;
	audit: string;
	tmp: string;
}

export interface Host {
	readonly storage: HostStorage;
	/** `vscode.Uri` of the extension root; typed opaquely to keep this module vscode-free. */
	readonly extensionUri: unknown;
	home(): string;
	workspace(): string;
	trusted(): boolean;
	/** Raw values of the `comonad.*` settings section. */
	config(): Record<string, unknown>;
	update(key: string, value: unknown): Promise<void>;
	secret(id: string): Promise<string | undefined>;
	setSecret(id: string, value: string): Promise<void>;
	/**
	 * A variable of the extension host process, so a provider key can come from the environment. In
	 * a remote window that is the *remote* environment; `secret()` stays on the client.
	 */
	env(name: string): string | undefined;
	/** The remote kind (`ssh-remote`, `wsl`, `dev-container`, …), or undefined in a local window. */
	remoteName(): string | undefined;
	/** The OS sandbox shell tools can actually use on this host. */
	sandboxKind(): SandboxKind;
	ask(question: string, options?: string[], multi?: boolean): Promise<string[]>;
	notify(message: string): void;
}

declare module 'cordis' {
	interface Context {
		host: Host;
	}
}

export function hostStorage(root: string): HostStorage {
	return {
		root,
		sessions: join(root, 'sessions'),
		attachments: join(root, 'attachments'),
		checkpoints: join(root, 'checkpoints'),
		memory: join(root, 'memory'),
		audit: join(root, 'audit'),
		tmp: join(root, 'tmp'),
	};
}
