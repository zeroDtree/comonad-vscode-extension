// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path';
import type { Context } from 'cordis';
import type { PaneController, PaneHost, PaneSpec } from '@comonad/services/panes';
import { markup } from './markup';
import { contentCatalog, contentController, type ContentController } from './controller';
import { tavernSettings, type TavernSettings } from '../lib/settings';

/**
 * The **ST** tab, as the settings panel takes it: the markup, the client files beside this package's
 * `resources` folder, and the editor the panel talks to. Everything the panel needs is here, so the
 * panel has no content code of its own — it draws whatever panes are registered.
 */

/** The settings half of the tab: the content keys, and the world-info scoring beside them. */
function settingsOf(ctx: Context): Record<string, unknown> {
	const config = tavernSettings(ctx);
	return {
		enabled: config.tavernEnabled,
		character: config.tavernCharacter,
		persona: config.tavernPersona,
		userName: config.tavernUserName,
		lorebooks: config.tavernLorebooks,
		preset: config.tavernPreset,
		authorNote: config.tavernAuthorNote,
		noteDepth: config.tavernNoteDepth,
		wiFormat: config.tavernWiFormat,
		scenarioFormat: config.tavernScenarioFormat,
		personalityFormat: config.tavernPersonalityFormat,
		wi: {
			scanDepth: config.wiScanDepth,
			budget: config.wiBudget,
			budgetCap: config.wiBudgetCap,
			recursive: config.wiRecursive,
			maxRecursionSteps: config.wiMaxRecursionSteps,
			minActivations: config.wiMinActivations,
			maxActivationsDepth: config.wiMaxActivationsDepth,
			caseSensitive: config.wiCaseSensitive,
			matchWholeWords: config.wiMatchWholeWords,
			includeNames: config.wiIncludeNames,
			characterStrategy: config.wiCharacterStrategy,
			groupScoring: config.wiGroupScoring,
		},
	};
}

/** The editor the panel drives, and the slices it pushes beside its own config. */
function controller(ctx: Context, host: PaneHost): PaneController {
	let editor: ContentController | undefined;
	ctx.inject(['tavern'], (scope) => {
		editor = contentController(scope, { uri: host.uri });
		// The injection lands a moment after the open, so the first state the panel pushed was thin.
		void Promise.resolve().then(() => host.refresh());
	});
	// The preset editor previews Comonad's generated text, which the agent keeps from its last prompt
	// build. Opening the panel may be the first thing after a reload, so build once and refresh.
	const session = ctx.sessions.active();
	if (session) {
		void Promise.resolve()
			.then(() => ctx.get('agent')?.promptBlocks?.(session))
			.then(() => host.refresh(), () => undefined);
	}
	// A reload or a save moves the content list, so the pane is told what the catalog now holds.
	ctx.on('tavern/changed', () => host.refresh());
	return {
		state: () => ({ content: editor?.state(), catalog: contentCatalog(ctx), tavern: settingsOf(ctx) }),
		action: async (message) => (await editor?.action(message)) as Record<string, unknown> | null,
		patch: (patch) => ownedSettings(patch, tavernSettings(ctx)),
	};
}

/** A book list, from a textarea's lines or an array — a book name may not contain a comma. */
function bookList(value: unknown, fallback: string[]): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => String(item).trim()).filter(Boolean);
	}
	if (typeof value === 'string') {
		return value
			.split('\n')
			.flatMap((line) => line.split(','))
			.map((name) => name.trim())
			.filter(Boolean);
	}
	return fallback;
}

/**
 * The settings the **ST** tab owns, read out of the panel's save. The patch is untrusted — it comes
 * from a webview — so every value is taken through a shape this plugin accepts, and the keys the rest
 * of the panel owns are left alone.
 */
export function ownedSettings(patch: Record<string, unknown>, current: TavernSettings): Record<string, unknown> {
	const text = (key: string, fallback: string): string => String(patch[key] ?? fallback).trim();
	const number = (key: string, fallback: number): number => {
		const value = Number(patch[key]);
		return Number.isFinite(value) && value >= 0 ? value : fallback;
	};
	return {
		tavernEnabled: patch.tavernEnabled === undefined ? current.tavernEnabled : Boolean(patch.tavernEnabled),
		tavernCharacter: text('tavernCharacter', current.tavernCharacter),
		tavernPersona: text('tavernPersona', current.tavernPersona),
		tavernUserName: text('tavernUserName', current.tavernUserName) || current.tavernUserName,
		tavernLorebooks: bookList(patch.tavernLorebooks, current.tavernLorebooks),
		tavernPreset: text('tavernPreset', current.tavernPreset),
		tavernAuthorNote: String(patch.tavernAuthorNote ?? current.tavernAuthorNote),
		tavernNoteDepth: number('tavernNoteDepth', current.tavernNoteDepth),
		tavernWiFormat: String(patch.tavernWiFormat ?? current.tavernWiFormat),
		tavernScenarioFormat: String(patch.tavernScenarioFormat ?? current.tavernScenarioFormat),
		tavernPersonalityFormat: String(patch.tavernPersonalityFormat ?? current.tavernPersonalityFormat),
		wiScanDepth: number('wiScanDepth', current.wiScanDepth),
		wiBudget: number('wiBudget', current.wiBudget),
		wiBudgetCap: number('wiBudgetCap', current.wiBudgetCap),
		wiRecursive: patch.wiRecursive === undefined ? current.wiRecursive : Boolean(patch.wiRecursive),
		wiMaxRecursionSteps: number('wiMaxRecursionSteps', current.wiMaxRecursionSteps),
		wiMinActivations: number('wiMinActivations', current.wiMinActivations),
		wiMaxActivationsDepth: number('wiMaxActivationsDepth', current.wiMaxActivationsDepth),
		wiCaseSensitive: patch.wiCaseSensitive === undefined ? current.wiCaseSensitive : Boolean(patch.wiCaseSensitive),
		wiMatchWholeWords: patch.wiMatchWholeWords === undefined ? current.wiMatchWholeWords : Boolean(patch.wiMatchWholeWords),
		wiIncludeNames: patch.wiIncludeNames === undefined ? current.wiIncludeNames : Boolean(patch.wiIncludeNames),
		wiCharacterStrategy: number('wiCharacterStrategy', current.wiCharacterStrategy),
		wiGroupScoring: patch.wiGroupScoring === undefined ? current.wiGroupScoring : Boolean(patch.wiGroupScoring),
	};
}

/** A book, for the content layer's tab; it uses the panel's currentColor stroke. */
const BOOK_ICON =
	'<svg viewBox="0 0 16 16"><path d="M3 3.2h4.1c.7 0 1.2.5 1.2 1.2v8.2c0-.7-.5-1.2-1.2-1.2H3z"/><path d="M13 3.2H8.9c-.7 0-1.2.5-1.2 1.2v8.2c0-.7.5-1.2 1.2-1.2H13z"/></svg>';

export function tavernPane(ctx: Context): PaneSpec {
	// The client files travel with the package, beside its build, so an install is a copy of the folder.
	const resources = join(__dirname, '..', 'resources');
	return {
		id: 'st',
		label: 'ST',
		order: 30,
		title: 'ST — characters, world books, personas, presets and their settings',
		icon: BOOK_ICON,
		command: 'comonad.openContent',
		markup,
		// The world-book and persona pages are guest modules: they load before the pane that hands them
		// the `lorebooks` and `personas` kinds, and the pane's own client comes last, to register it.
		scripts: [join(resources, 'worldinfo.js'), join(resources, 'persona.js'), join(resources, 'content.js'), join(resources, 'st.js')],
		styles: [join(resources, 'content.css'), join(resources, 'worldinfo.css'), join(resources, 'persona.css')],
		// An avatar is a file in the library folder, which the webview may only read when it is allowed.
		roots: () => ctx.get('tavern')?.roots() ?? [],
		controller: (host) => controller(ctx, host),
	};
}
