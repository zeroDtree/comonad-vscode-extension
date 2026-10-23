// SPDX-License-Identifier: AGPL-3.0-only
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { findSymbolRange, type SymbolLike } from '../lib/references';
import type { SourceRange } from '../lib/types';

/**
 * The VS Code half of `ctx.references`: encoding-aware text reads and the document/workspace symbol
 * providers. Registered while the UI is loaded; the headless kernel falls back to the filesystem.
 */

export function referenceProviders(ctx: Context): void {
	ctx.effect(() =>
		ctx.references.provideTextReader({
			async read(absolute: string): Promise<string> {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
				return document.getText();
			},
		}),
	);
	ctx.effect(() =>
		ctx.references.provideSymbols({
			async range(absolute: string, name: string): Promise<SourceRange | undefined> {
				const uri = vscode.Uri.file(absolute);
				const symbols = await withTimeout(
					vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri),
					3_000,
				);
				if (symbols?.length) {
					const found = findSymbolRange(symbols as unknown as SymbolLike[], name);
					if (found) {
						const end = found.end.character === 0 && found.end.line > found.start.line ? found.end.line : found.end.line + 1;
						return { start: found.start.line + 1, end, unit: 'line' };
					}
				}
				const infos = await withTimeout(
					vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name),
					3_000,
				);
				if (!infos) {
					return undefined;
				}
				const leaf = name.split('.').pop() ?? name;
				const match = infos.find(
					(info) =>
						info.location.uri.fsPath === uri.fsPath &&
						(info.name === leaf || (info.containerName ? `${info.containerName}.${info.name}` : info.name) === name),
				);
				if (!match) {
					return undefined;
				}
				const range = match.location.range;
				const end = range.end.character === 0 && range.end.line > range.start.line ? range.end.line : range.end.line + 1;
				return { start: range.start.line + 1, end, unit: 'line' };
			},
		}),
	);
}

referenceProviders.inject = ['references'];

function withTimeout<T>(value: Thenable<T> | undefined, milliseconds: number): Promise<T | undefined> {
	if (!value) {
		return Promise.resolve(undefined);
	}
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), milliseconds);
	});
	return Promise.race([Promise.resolve(value), timeout]).finally(() => {
		if (timer) {
			clearTimeout(timer);
		}
	});
}
