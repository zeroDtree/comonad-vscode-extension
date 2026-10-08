import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { describe } from '../lib/util';

/** Registers a VS Code command owned by the calling plugin, with unified error reporting. */
export function registerCommand(ctx: Context, id: string, handler: (...args: unknown[]) => unknown): void {
	ctx.effect(() => {
		const disposable = vscode.commands.registerCommand(id, (...args: unknown[]) => {
			void Promise.resolve(handler(...args)).catch((error) => {
				void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
			});
		});
		return () => disposable.dispose();
	});
}
