import { mkdirSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as cordis from 'cordis';
import * as schemastery from 'schemastery';
import type { Context } from 'cordis';

/**
 * Compatibility with DeepSeek Harness plugins.
 *
 * A harness plugin is a module of the shape Comonad already loads — `{ name, inject, apply(ctx, config) }`
 * — so the only thing between it and Comonad is what it *imports* and what it *calls*. This row closes
 * that gap: every `@deepseek-ai/*` name is redirected to a generated module that re-exports what Comonad
 * means by it, and the pipeline such a plugin calls into — `ctx.on('tools/pre-execute')` and friends —
 * is the one `ctx.tools` already runs for every call.
 *
 * The redirection is a rewrite of the *name*, not a second implementation. `@deepseek-ai/cordis` has to
 * be the very classes the tree is built from, or a plugin's `Service` subclass would be a foreign object
 * cordis cannot see; so the generated module re-exports this file's own `cordis` namespace through a
 * `Symbol.for` bridge, which holds however the extension was bundled. The same trick keeps
 * `@deepseek-ai/schemastery` the copy whose `resolveConfig` our plugin host validates configs with.
 *
 * What is supported is the tool and policy half of the harness: `ctx.tools.register()`, `defineTool`, the
 * `tools/*` waterfalls, and schemastery config schemas. What is not is its agent and session internals
 * (`ctx.agents`, `session/event`, the PTC runtime). A name Comonad does not implement is left to Node: if
 * the real package is installed it is used, and if it is not, it resolves to an empty module with a line
 * in the log — so the plugin fails where it used one of those services, naming the package, instead of
 * failing in a way that looks like Comonad's fault.
 */

/** Where the generated modules read their exports from. */
const BRIDGE = Symbol.for('comonad.harness.bindings');

/** One harness package name Comonad answers, and the files it answers with. */
export interface HarnessAlias {
	/** The `@deepseek-ai/...` name. */
	name: string;
	/** `module` — a Comonad implementation; `shim` — a helper Comonad implements; `empty` — nothing more. */
	kind: 'module' | 'shim' | 'empty';
	/** Where the redirection sends a `require`. */
	cjs: string;
	/** Where it sends an `import`. */
	mjs: string;
}

export interface HarnessCompatState {
	aliases: HarnessAlias[];
	/** Where the generated shims live, so they can be read and argued with. */
	directory: string;
	/** `register-hooks` covers both `require` and `import`; `require-only` leaves bare imports alone. */
	loader: 'register-hooks' | 'require-only';
}

/** The table the resolver consults. Module-global: the resolver outlives any row, so turning the row off empties the table instead. */
let table = new Map<string, HarnessAlias>();

/** Where an unimplemented name lands, and which of those have already been reported. */
let empty: { cjs: string; mjs: string } = { cjs: '', mjs: '' };
const reported = new Set<string>();
let patched = false;

/** The names redirected right now: what a diagnostic surface, or a test, can look at. */
export function harnessAliases(): HarnessAlias[] {
	return [...table.values()];
}

/** A harness user message is content blocks and a source; Comonad's transcript is text. */
function createUserMessage(input: unknown): { role: 'user'; content: string } {
	const content =
		typeof input === 'string'
			? input
			: ((input as { content?: { text?: string }[] } | undefined)?.content ?? []).map((block) => block?.text ?? '').join('');
	return { role: 'user', content };
}

/** The values a harness plugin may import, under the names it imports them by. */
function bindings(): Record<string, Record<string, unknown>> {
	return {
		'@deepseek-ai/cordis': { ...cordis },
		'@deepseek-ai/schemastery': { ...schemastery },
		// A brand is a type-level fiction: the strings and numbers themselves are what a session stores.
		'@deepseek-ai/dsh-brand': {
			brandString: (value: unknown) => value,
			brandNumber: (value: unknown) => value,
			brandBoolean: (value: unknown) => value,
		},
		// `defineTool` exists to type a definition and validate its arguments; Comonad's registry reads the
		// definition it returns and validates the arguments the model sent against `parameters`.
		'@deepseek-ai/dsh-tools': { defineTool: (definition: unknown) => definition },
		'@deepseek-ai/dsh-llm': { createUserMessage },
	};
}

/**
 * Writes the modules the names resolve to. Each one is a bridge to the values in this process, written
 * out one export at a time because a module's exports are static even when the list of them is not.
 */
function writeShims(directory: string, values: Record<string, Record<string, unknown>>): Map<string, HarnessAlias> {
	const resolved = new Map<string, HarnessAlias>();
	for (const [name, exports] of Object.entries(values)) {
		const base = name.replace('@deepseek-ai/', '').replace(/\W+/g, '-');
		const names = Object.keys(exports);
		const cjs = join(directory, `${base}.cjs`);
		const mjs = join(directory, `${base}.mjs`);
		// `exports` is already taken in a CommonJS module; `values` is what the name means here.
		const lookup = `const bridge = globalThis[Symbol.for('comonad.harness.bindings')] ?? {};\nconst values = bridge[${JSON.stringify(name)}] ?? {};\n`;
		writeFileSync(
			cjs,
			[
				`// Generated by Comonad: what ${name} means here (see src/plugins/harness.ts).`,
				'// Written again whenever the compat row loads; safe to delete.',
				lookup,
				'module.exports = values;',
				'',
			].join('\n'),
		);
		writeFileSync(
			mjs,
			[
				`// Generated by Comonad: what ${name} means here (see src/plugins/harness.ts).`,
				'// Written again whenever the compat row loads; safe to delete.',
				lookup,
				...names.map((key) => `export const ${key} = values[${JSON.stringify(key)}];`),
				'export default values;',
				'',
			].join('\n'),
		);
		resolved.set(name, { name, kind: name === '@deepseek-ai/dsh-brand' || name === '@deepseek-ai/dsh-tools' || name === '@deepseek-ai/dsh-llm' ? 'shim' : 'module', cjs, mjs });
	}
	return resolved;
}

/** Where a name resolves, or `undefined` when it is not Comonad's to answer. */
function fileFor(specifier: string, esm: boolean, note: (message: string) => void): string | undefined {
	if (specifier !== '@deepseek-ai' && !specifier.startsWith('@deepseek-ai/')) {
		return undefined;
	}
	const name = specifier.startsWith('@deepseek-ai/') ? specifier.split('/').slice(0, 2).join('/') : specifier;
	const alias = table.get(name);
	if (alias) {
		return esm ? alias.mjs : alias.cjs;
	}
	// Not Comonad's business: the real package, when the harness is installed beside us.
	try {
		return require_.resolve(specifier);
	} catch {
		if (!reported.has(name)) {
			reported.add(name);
			note(`harness compat: ${name} is neither installed nor implemented; it resolves to an empty module`);
		}
		return esm ? empty.mjs : empty.cjs;
	}
}

/**
 * Installs the redirection. The resolver patch covers `require` on any Node; `import` is covered by
 * `module.registerHooks` where the running Node has it (22.15+), and where it does not the state says
 * `require-only` and the log says so, because a silent half-install is worse than a note.
 */
function installResolver(note: (message: string) => void): HarnessCompatState['loader'] {
	const hooks = (Module as unknown as { registerHooks?: (hooks: unknown) => void }).registerHooks;
	if (typeof hooks === 'function') {
		hooks({
			resolve(specifier: string, context: { conditions?: string[] }, next: (specifier: string, context: unknown) => unknown) {
				const file = fileFor(specifier, !(context?.conditions ?? []).includes('require'), note);
				return file ? { url: pathToFileURL(file).href, shortCircuit: true } : next(specifier, context);
			},
		});
	}
	// `_resolveFilename` is how CommonJS actually finds a module and is not part of the types; it is the
	// one seam that covers `require` on every Node the extension can run on.
	const cjs = Module as unknown as { _resolveFilename: (this: unknown, specifier: string, ...rest: unknown[]) => string };
	if (!patched) {
		patched = true;
		const original = cjs._resolveFilename;
		cjs._resolveFilename = function (this: unknown, specifier: string, ...rest: unknown[]): string {
			return fileFor(specifier, false, note) ?? original.call(this, specifier, ...rest);
		};
	}
	return typeof hooks === 'function' ? 'register-hooks' : 'require-only';
}

/**
 * The row. Enabling it installs the redirection for the rest of the process; disabling it empties the
 * table, so harness names resolve the way they would with Comonad out of the picture.
 */
export function harnessCompat(ctx: Context, config: { shimDirectory?: string } = {}): HarnessCompatState {
	const directory = config.shimDirectory ?? join(ctx.host.home(), '.comonad', 'shims');
	mkdirSync(directory, { recursive: true });
	const note = (message: string): void => ctx.log.message(message);
	(globalThis as Record<symbol, unknown>)[BRIDGE] = bindings();

	empty = { cjs: join(directory, 'empty.cjs'), mjs: join(directory, 'empty.mjs') };
	writeFileSync(empty.cjs, '// Generated by Comonad: a harness package it does not implement.\nmodule.exports = {};\n');
	writeFileSync(empty.mjs, '// Generated by Comonad: a harness package it does not implement.\nexport default {};\n');

	table = writeShims(directory, (globalThis as Record<symbol, Record<string, Record<string, unknown>>>)[BRIDGE]!);
	const state: HarnessCompatState = { aliases: harnessAliases(), directory, loader: installResolver(note) };
	if (state.loader === 'require-only') {
		note('harness compat: this Node has no module.registerHooks, so a bare `import` of @deepseek-ai/* is not redirected');
	}
	note(`harness compat: ${state.aliases.length} name(s) redirected to Comonad, shims in ${directory}`);
	ctx.effect(() => () => {
		table = new Map();
	});
	return state;
}
harnessCompat.inject = ['host', 'log'];

/** Resolution is asked the way a plugin's own package would ask it, from beside this file. */
const require_ = Module.createRequire(__filename);
