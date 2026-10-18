// SPDX-License-Identifier: AGPL-3.0-only
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { describe } from '../lib/util';

/** Registers a VS Code command owned by the calling plugin, with unified error reporting. */
export function registerCommand<Args extends unknown[] = unknown[]>(ctx: Context, id: string, handler: (...args: Args) => unknown): void {
	ctx.effect(() => {
		const disposable = vscode.commands.registerCommand(id, (...args: unknown[]) => {
			void Promise.resolve(handler(...(args as Args))).catch((error) => {
				void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
			});
		});
		return () => disposable.dispose();
	});
}
