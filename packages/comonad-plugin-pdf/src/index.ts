// SPDX-License-Identifier: AGPL-3.0-only
import type { Context, Plugin } from 'cordis';
import { pdfResolver } from './extract';

/**
 * PDF documents for Comonad, as an installable row.
 *
 * The plugin contributes one reference resolver: `%PDF-` files are parsed for their text, page by
 * page. The core keeps the message model, budgets, framing and placement; turning this row off
 * removes PDF support without touching anything already stored in a transcript.
 */

export async function apply(ctx: Context): Promise<void> {
	ctx.effect(() => ctx.references.register(pdfResolver));
}

const plugin = apply as Plugin.Function;
Object.defineProperty(plugin, 'name', { value: 'pdf', configurable: true });
plugin.inject = ['references'];
export default plugin;
