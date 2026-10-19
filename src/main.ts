// SPDX-License-Identifier: AGPL-3.0-only
import * as vscode from 'vscode';
import { Context, type Fiber } from 'cordis';
import * as comonad from './app';
import { warmLoginPath } from './lib/sandbox';

/** Extension entry: build the Cordis application and dispose it on deactivate. */

let app: (Fiber & PromiseLike<Fiber>) | undefined;

export async function activate(extension: vscode.ExtensionContext): Promise<void> {
	const ctx = new Context();
	app = ctx.plugin(comonad, { extension });
	await app;
	// The extension host's PATH is not the login shell's (Remote-SSH, a window manager), and the
	// user's commands expect the latter. Resolving it is slow enough to start in the background.
	if (extension.extensionMode !== vscode.ExtensionMode.Test) {
		void warmLoginPath();
	}
	ctx.log.message('comonad activated');
}

export async function deactivate(): Promise<void> {
	await app?.dispose();
	app = undefined;
}
