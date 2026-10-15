import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Service, type Context, type Fiber, type Plugin } from 'cordis';
import type * as vscode from 'vscode';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { writeModuleShims } from './plugin-modules';

/**
 * The plugin host: what Comonad is made of, and what a user's own files add to it.
 *
 * The extension's tree is a list of rows — the shape the Cordis loader and the DeepSeek Harness use,
 * `{ id, name, disabled, config }` — and so is a user's. A `cordis.yml` in the project
 * (`<workspace>/.comonad`) or in the user's library (`~/.comonad`) turns a built-in row off, gives it
 * a config of its own, or mounts a plugin of its own beside it. Nothing here is privileged: a row that
 * is disabled is never loaded, and a row that fails is reported rather than fatal.
 */

/** One row of a `cordis.yml`: what to load, whether to load it, and what to hand it. */
export interface PluginRow {
	/** The id a `cordis.yml` addresses this row by. */
	id: string;
	/**
	 * What the row loads — another built-in row's id, `./x.js` beside the yml, or an installed package
	 * name. A built-in row may leave it out, in which case its id names the plugin.
	 */
	name?: string;
	/** A disabled row is listed and nothing else: the feature it stands for is not loaded at all. */
	disabled?: boolean;
	/** What the plugin's `apply(ctx, config)` is handed. */
	config?: unknown;
	/**
	 * Which layer of the tree the row belongs to (`kernel`, `tools`, `ui`, …). Nothing is loaded by it:
	 * it is how the dependency diagram groups the rows, which is the only place the tree's shape is
	 * visible at all.
	 */
	group?: string;
}

/** Where a row came from, and what became of it. */
export interface PluginState {
	id: string;
	source: 'builtin' | 'project' | 'user';
	/** What it resolves to: `built-in`, a file path, or a package name. */
	target: string;
	/** The layer the row belongs to, as the row list declares it. */
	group?: string;
	enabled: boolean;
	loaded: boolean;
	error?: string;
	/**
	 * The services this row provides that other rows can see: what they resolve to it, plus anything the
	 * plugin declares with `provide`. A service nobody injects and nothing declares is not in here —
	 * `fiber.store` cannot be asked directly, because cordis keeps the resolved injections in the same
	 * object.
	 */
	provides: string[];
	/** The services the row declares it needs. */
	injects: string[];
}

/** One row of the dependency diagram: what it provides, what it needs, and who needs it in turn. */
export interface PluginDependency extends PluginState {
	/**
	 * Every injected service, with the row that provides it. No provider and `external` means something
	 * outside the rows provides it (the platform: `host`, `log`, `settings`); no provider at all means
	 * nothing does, which is the case the diagram draws as a node of its own.
	 */
	requires: { name: string; provider?: string; external?: boolean }[];
	/** The rows that would go inactive if this one were turned off. */
	usedBy: string[];
}

export interface PluginHostConfig {
	/** The extension's own rows, in load order. */
	rows: PluginRow[];
	/** The plugin each built-in row's name resolves to. */
	plugins: Record<string, Plugin>;
}

/** `FiberState.ACTIVE`; the const enum is erased at build time, so it is spelled out once here. */
const ACTIVE = 2;
/** `FiberState.PENDING`, spelled out for the same reason. */
const PENDING = 0;

/**
 * The services a plugin says it provides, when it can say so: a `Service` subclass names itself, and
 * `provide` is the declaration cordis understands. `Object.keys(fiber.store)` only sees what the row's
 * own context provides, so this is what a service row that has not activated yet is known by.
 */
function servicesOf(plugin: Plugin): string[] {
	const declaration = (plugin as { provide?: string | string[] }).provide;
	if (!declaration) {
		return [];
	}
	return Array.isArray(declaration) ? declaration : [declaration];
}

/** The resolved side of a service: cordis records the name, the value and the fiber that provides it. */
interface Impl {
	name: string;
	fiber: Fiber;
}

/**
 * The impl behind a service name, as cordis's own lookup finds it — the same one property access uses,
 * walking the shared store rather than this row's context, which is why a service provided by a nested
 * plugin of another row is visible from here at all.
 */
function lookup(fiber: Fiber, name: string): Impl | undefined {
	const reflect = (fiber.ctx as unknown as { reflect?: { _getImpl?: (name: string) => Impl | undefined } }).reflect;
	return reflect?._getImpl?.(name);
}

/**
 * The row that provides a service, found from the fiber that does: a service row is its own fiber, and a
 * row that provides one through a nested plugin reaches it by walking up the contexts it was created in.
 */
function providerOf(fiber: Fiber | undefined, mounted: readonly { row: { id: string }; fiber: Fiber }[]): string | undefined {
	const rowOf = new Map(mounted.map((entry) => [entry.fiber.uid, entry.row.id]));
	let current: Fiber | undefined = fiber;
	for (let depth = 0; current && depth < 16; depth += 1) {
		const owner = current.uid === null ? undefined : rowOf.get(current.uid);
		if (owner) {
			return owner;
		}
		current = current.parent?.fiber;
	}
	return undefined;
}

/** Whether two rows would hand their plugin the same config: a row that did not change is left alone. */
function sameConfig(left: unknown, right: unknown): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** Why a row is not loaded: what it is waiting for, or the state it is in instead. */
function describeFiber(fiber: Fiber): string {
	const state = STATE_NAMES[fiber.state] ?? String(fiber.state);
	// Only a pending fiber is waiting for something; naming injections it already resolved would send the
	// reader after a service that is right there.
	if (fiber.state === PENDING) {
		return `${state}: waiting for ${waiting(fiber)}`;
	}
	// Why a row failed is what a reader wants, and cordis keeps the error for its own logger alone.
	const thrown = (fiber as unknown as { _error?: unknown })._error;
	return thrown ? `${state}: ${thrown instanceof Error ? thrown.message : String(thrown)}` : state;
}

/**
 * What a row that is still pending is waiting on: the injections it declared that cordis cannot resolve
 * yet. A row may only read what it declared, so this is also the list of names to look for.
 */
function waiting(fiber: Fiber): string {
	const unresolved = Object.keys(fiber.inject ?? {}).filter((name) => !lookup(fiber, name));
	return unresolved.length ? unresolved.join(', ') : 'a service it injects';
}

/** The state names, for a row that is not loaded: `pending` is a missing service, `failed` an error. */
const STATE_NAMES: Record<number, string> = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: 'disposed', 5: 'unloading' };

/** A row as it is loaded: the file it came from decides where a relative `name` resolves. */
interface ResolvedRow extends PluginRow {
	source: PluginState['source'];
	dir: string;
}

declare module 'cordis' {
	interface Context {
		plugins: Plugins;
	}
}

/** The rows a `cordis.yml` holds, or an empty list when there is no such file. */
export function readRows(file: string): PluginRow[] {
	if (!file || !existsSync(file)) {
		return [];
	}
	const parsed: unknown = parseYaml(readFileSync(file, 'utf8'));
	if (parsed === null || parsed === undefined) {
		return [];
	}
	if (!Array.isArray(parsed)) {
		throw new Error(`${file}: a plugin list is a YAML sequence of rows`);
	}
	return parsed.map((row, index) => {
		const entry = (row ?? {}) as Record<string, unknown>;
		const id = String(entry.id ?? '').trim();
		if (!id) {
			throw new Error(`${file}: row ${index + 1} has no id`);
		}
		return {
			id,
			name: entry.name === undefined ? undefined : String(entry.name),
			disabled: entry.disabled === true,
			config: entry.config,
		};
	});
}

/** Writes one row's patch into a `cordis.yml`, keeping the rows already there (comments are not). */
export function writeRow(file: string, patch: PluginRow): void {
	const rows = readRows(file).filter((row) => row.id !== patch.id);
	rows.push(patch);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, stringifyYaml(rows.map((row) => ({ ...row, name: row.name || undefined, config: row.config ?? undefined }))));
}

/**
 * The host itself. Mounting a row is what applies it: a built-in plugin by name, a user's by file URL
 * or package name — loaded with a real `import()`, because a plugin is a module like any other.
 */
export class Plugins extends Service {
	static inject = ['host', 'log'];

	private mounted: { row: ResolvedRow; fiber: Fiber; provides: Set<string>; injects: string[] }[] = [];
	/** What each row provided the last time it was applied: a row that is off still says what it was. */
	private readonly provided = new Map<string, string[]>();
	private states: PluginState[] = [];
	/** Set while the list is being applied: a reload asked for now has to wait for it to finish. */
	private mounting: Promise<void> | undefined = undefined;
	/** The last thing this host wrote to each list, so its own write is not mistaken for an edit. */
	private readonly written = new Map<string, string>();

	constructor(
		ctx: Context,
		private readonly config: PluginHostConfig,
	) {
		super(ctx, 'plugins');
		// An installed plugin is loaded from the library, where `cordis` and `vscode` are the files
		// Comonad lends it: they are written before any row loads, so a row of yours can require them.
		try {
			writeModuleShims(this.library);
		} catch (error) {
			ctx.log.message(`plugins: could not write the modules a plugin requires: ${error instanceof Error ? error.message : String(error)}`);
		}
		ctx.effect(() => () => this.unmount());
	}

	/** The library a plugin of yours is installed in: what `install` fills, and where the shims sit. */
	get library(): string {
		return join(this.ctx.host.home(), '.comonad', 'plugins');
	}

	/**
	 * The plugins that ship with Comonad, as installable sources: a folder of the extension's own
	 * `packages` that declares itself with a `comonad` block in its `package.json`. Nothing here is
	 * loaded from the extension folder — an install is what puts a copy in the library, where the
	 * modules a plugin requires resolve.
	 */
	bundled(): { id: string; label: string; dir: string }[] {
		const extension = this.ctx.host.extensionUri as vscode.Uri | undefined;
		const folder = extension ? join(extension.fsPath, 'packages') : '';
		if (!folder || !existsSync(folder)) {
			return [];
		}
		const found: { id: string; label: string; dir: string }[] = [];
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			if (!entry.isDirectory()) {
				continue;
			}
			const dir = join(folder, entry.name);
			try {
				const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
					name?: string;
					displayName?: string;
					comonad?: { plugin?: boolean; label?: string };
				};
				if (!manifest.comonad?.plugin) {
					continue;
				}
				found.push({ id: manifest.name ?? entry.name, label: manifest.comonad.label ?? manifest.displayName ?? entry.name, dir });
			} catch {
				// A folder without a readable manifest is not a plugin source, and saying so once per
				// folder is noise: the list is what a reader sees, and a source that installs wrong says so.
			}
		}
		return found;
	}

	/**
	 * Installs a plugin from a folder: the files are copied into the library and a row naming them is
	 * written into the user's `cordis.yml` — the same two steps a user would take by hand, so an
	 * install can be undone by deleting the row, the folder, or both. The list is applied again at the
	 * end, which is what mounts it.
	 */
	async install(source: string, id?: string): Promise<PluginState[]> {
		const name = (id ?? basename(source)).trim();
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
			throw new Error(`"${name}" is not a plugin id — use letters, digits, dots, dashes and underscores`);
		}
		if (!existsSync(join(source, 'package.json'))) {
			throw new Error(`${source} is not a plugin folder: it has no package.json`);
		}
		const target = join(this.library, name);
		cpSync(source, target, { recursive: true, force: true });
		// An installed plugin brings its build and its files, never a `node_modules` of its own: the
		// modules it requires are the ones Comonad lends it.
		if (!existsSync(this.userFile)) {
			mkdirSync(dirname(this.userFile), { recursive: true });
		}
		writeRow(this.userFile, { id: name, name: `./plugins/${name}/${this.entryOf(name)}` });
		this.written.set(this.userFile, readFileSync(this.userFile, 'utf8'));
		return this.reconcile();
	}

	/** What in an installed folder the row names: the manifest's own `main`, or the usual bundle. */
	private entryOf(name: string): string {
		try {
			const manifest = JSON.parse(readFileSync(join(this.library, name, 'package.json'), 'utf8')) as { main?: string };
			const main = String(manifest.main ?? '').replace(/^\.\//, '');
			if (main && existsSync(join(this.library, name, main))) {
				return main;
			}
		} catch {
			// A manifest that cannot be read is answered with the default below: the row is still written,
			// and a row that names a file that is not there is reported like any other broken row.
		}
		return 'dist/index.js';
	}

	/** The project's `cordis.yml` — where `set` writes, and where a workspace's own rows live. */
	get projectFile(): string {
		const workspace = this.ctx.host.workspace();
		return workspace ? join(workspace, '.comonad', 'cordis.yml') : '';
	}

	/** The user's `cordis.yml`: shared by every workspace, and read even where the project is not. */
	get userFile(): string {
		return join(this.ctx.host.home(), '.comonad', 'cordis.yml');
	}

	/**
	 * Where a toggle is written: the project's own list when the workspace is trusted (so a change
	 * travels with the project), and the user's library otherwise — never a file inside a workspace
	 * that has not been trusted.
	 */
	get patchFile(): string {
		return this.ctx.host.trusted() ? this.projectFile || this.userFile : this.userFile;
	}

	/** Every row in play, in load order: the extension's own, then what the user's files add to them. */
	rows(): PluginRow[] {
		return this.resolveRows().rows.map((row) => ({ id: row.id, name: row.name, disabled: row.disabled, config: row.config, group: row.group }));
	}

	/**
	 * What is loaded right now, and why anything that is not loaded is not. The answer is read from the
	 * fibers, not from the moment each row was applied: a row that others inject goes inactive when the
	 * service it wanted is turned off, and a list that kept saying `loaded` would be lying about it.
	 */
	state(): PluginState[] {
		this.refreshProvides();
		const live = new Map(this.mounted.map((entry) => [entry.row.id, entry]));
		return this.states.map((state) => {
			// What a row provides is read live as well: a nested plugin's service is only attributable
			// once the row that mounts it is up, and a row that others are waiting for keeps saying so.
			const provides = this.providesOf(state.id);
			const mounted = live.get(state.id);
			if (!mounted) {
				return { ...state, provides };
			}
			const loaded = mounted.fiber.state === ACTIVE;
			return { ...state, loaded, provides, error: loaded ? undefined : describeFiber(mounted.fiber) };
		});
	}

	/**
	 * The tree as a graph: every row with what it provides, what it needs, and who needs it. Read from
	 * the live fibers, so a row that is waiting for a service says so — and rows that are off still say
	 * what they provided, because that is what the rows waiting for them are waiting *for*.
	 */
	dependencies(): PluginDependency[] {
		const states = this.state();
		const providers = new Map<string, string[]>();
		for (const state of states) {
			for (const name of this.providesOf(state.id)) {
				const list = providers.get(name);
				if (list) {
					list.push(state.id);
				} else {
					providers.set(name, [state.id]);
				}
			}
		}
		const requires = new Map<string, { name: string; provider?: string; external?: boolean }[]>();
		for (const state of states) {
			const fiber = this.mounted.find((entry) => entry.row.id === state.id)?.fiber;
			requires.set(
				state.id,
				this.injectsOf(state.id).map((name) => {
					const found = providers.get(name) ?? [];
					const provider = found.length === 1 ? found[0] : found.find((id) => id !== state.id);
					if (provider) {
						return { name, provider };
					}
					// A service provided outside the rows — `log`, `host`, `settings`, which the application
					// mounts before the tree — is not a hole in it; a name nothing resolves is.
					return fiber && lookup(fiber, name) ? { name, external: true } : { name };
				}),
			);
		}
		const usedBy = new Map(states.map((state) => [state.id, [] as string[]]));
		for (const [id, list] of requires) {
			for (const entry of list) {
				if (entry.provider && entry.provider !== id) {
					usedBy.get(entry.provider)?.push(id);
				}
			}
		}
		return states.map((state) => ({ ...state, requires: requires.get(state.id) ?? [], usedBy: usedBy.get(state.id) ?? [] }));
	}

	/**
	 * What each row provides right now: what its own context provides, plus what a plugin of its own
	 * provides for somebody else (`ctx.plugin(SomeService)` makes a child fiber, and the row that owns
	 * that fiber is the row that provides the service).
	 */
	private refreshProvides(): void {
		for (const entry of this.mounted) {
			for (const name of Object.keys(entry.fiber.inject ?? {})) {
				// The lookup cordis itself uses for property access: it answers with the impl, which names
				// the fiber that provides the service — the only way to see a service a *nested* plugin
				// provides, since it never lands in the row's own store.
				const impl = lookup(entry.fiber, name);
				const owner = providerOf(impl?.fiber, this.mounted);
				if (owner && impl) {
					const provider = this.mounted.find((candidate) => candidate.row.id === owner);
					provider?.provides.add(impl.name);
				}
			}
		}
		for (const entry of this.mounted) {
			// Remembered as well, so a row that is turned off still says what its dependents wait for.
			this.provided.set(entry.row.id, [...entry.provides].sort());
		}
	}

	/** What a row provides right now, or what it provided the last time it was applied. */
	private providesOf(id: string): string[] {
		const mounted = this.mounted.find((entry) => entry.row.id === id);
		if (mounted) {
			return [...mounted.provides].sort();
		}
		return this.provided.get(id) ?? [];
	}

	/** What a row says it needs: declared once, when it was mounted, and remembered after it goes. */
	private injectsOf(id: string): string[] {
		const mounted = this.mounted.find((entry) => entry.row.id === id);
		if (mounted) {
			return mounted.injects;
		}
		return this.provided.get(`${id}\u0000injects`) ?? [];
	}

	/** Unloads every row and applies the list again: what a new `cordis.yml` or a toggle means. */
	async reload(): Promise<PluginState[]> {
		// A watcher can fire while the tree is still being mounted, and a mount started from a context
		// that is not active yet would fail. Waiting is the difference between "apply this again" and
		// "quietly keep the list that was already read".
		while (this.mounting) {
			await this.mounting;
		}
		await this.unmount();
		await this.mount();
		this.ctx.emit('plugins/changed');
		return this.state();
	}

	/** Applies every enabled row. Errors are per row: one broken plugin does not take the tree down. */
	async mount(): Promise<PluginState[]> {
		let settle = (): void => undefined;
		this.mounting = new Promise<void>((resolve) => {
			settle = resolve;
		});
		try {
			return await this.mountRows();
		} finally {
			this.mounting = undefined;
			settle();
		}
	}

	private async mountRows(): Promise<PluginState[]> {
		const { rows, errors } = this.resolveRows();
		this.states = [...errors];
		for (const row of rows) {
			if (row.disabled) {
				this.put(this.offState(row));
				continue;
			}
			this.put(await this.loadRow(row));
		}
		return this.state();
	}

	/** A row that is on but not running, or off: where it is from, what it was, and nothing else. */
	private offState(row: ResolvedRow): PluginState {
		return {
			id: row.id,
			source: row.source,
			target: this.target(row),
			group: row.group,
			enabled: false,
			loaded: false,
			provides: this.providesOf(row.id),
			injects: this.injectsOf(row.id),
		};
	}

	/** Records one row's state where it belongs: the list is in load order, and stays that way. */
	private put(state: PluginState): void {
		const index = this.states.findIndex((entry) => entry.id === state.id);
		if (index >= 0) {
			this.states[index] = state;
		} else {
			this.states.push(state);
		}
	}

	/** Loads one row and says what became of it: the unit of work behind every apply. */
	private async loadRow(row: ResolvedRow): Promise<PluginState> {
		try {
			const plugin = await this.load(row);
			const fiber = this.ctx.plugin(plugin, row.config);
			const injects = Object.keys(fiber.inject ?? {});
			// Read after the row is up: a service is registered by an effect of the plugin itself, so the
			// fiber's store is only what it provides once it has activated.
			const provides = new Set<string>(servicesOf(plugin));
			this.mounted.push({ row, fiber, provides, injects });
			await fiber;
			// cordis keeps provided services and resolved injections in the same object, so one is the
			// other taken away: what the row resolved *is not* what it provides.
			for (const name of Object.keys(fiber.store ?? {})) {
				if (!injects.includes(name)) {
					provides.add(name);
				}
			}
			this.provided.set(row.id, [...provides].sort());
			this.provided.set(`${row.id}\u0000injects`, injects);
			const loaded = fiber.state === ACTIVE;
			return {
				id: row.id,
				source: row.source,
				target: this.target(row),
				group: row.group,
				enabled: true,
				loaded,
				provides: this.providesOf(row.id),
				injects,
				// A fiber that is not active is waiting for a service it injects, or it failed; the
				// state is the difference, and a row that says the wrong one wastes an afternoon.
				error: loaded ? undefined : describeFiber(fiber),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.ctx.log.message(`plugins: ${row.id} (${this.target(row)}) failed: ${message}`);
			return { ...this.offState(row), enabled: true, error: message };
		}
	}

	/**
	 * Turns one row on or off (or gives it a config) by writing it into the patchable `cordis.yml`, then
	 * applies **that row** again.
	 *
	 * Not the whole list: the caller is usually a row of this very tree — the settings panel is one — and
	 * a full reload would dispose the surface the user is clicking in, which reads as "nothing happened".
	 * A row that others inject takes its dependents with it and gives them back (cordis resolves
	 * injections on both edges), so the rest of the tree is untouched either way.
	 */
	async set(id: string, patch: { disabled?: boolean; config?: unknown }): Promise<PluginState[]> {
		const file = this.patchFile;
		if (!file) {
			return this.state();
		}
		const existing = readRows(file).find((row) => row.id === id);
		writeRow(file, {
			id,
			name: existing?.name,
			disabled: patch.disabled ?? existing?.disabled,
			config: patch.config ?? existing?.config,
		});
		this.written.set(file, readFileSync(file, 'utf8'));
		return this.apply(id);
	}

	/**
	 * A `cordis.yml` changed on disk. The write this host just made is not an edit — the row is applied
	 * already — so it is only read when the file says something else.
	 */
	async fileChanged(file: string): Promise<PluginState[]> {
		const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
		if (this.written.get(file) === text) {
			this.written.delete(file);
			return this.state();
		}
		return this.reconcile();
	}

	/**
	 * Applies the list again, row by row: a row whose line did not change is left running, and only the
	 * rows that appeared, went away or were edited are applied. Editing a `cordis.yml` therefore does not
	 * restart the whole tree — an open panel, a running turn and a watched folder are not collateral —
	 * while a row's own change still lands at once. `reload()` is the blunt version, for the button: a
	 * plugin's *code* may have changed, and nothing here can tell that from the outside.
	 */
	async reconcile(): Promise<PluginState[]> {
		const { rows, errors } = this.resolveRows();
		// The rows that stay keep the state they had; a file that cannot be read is reported instead.
		const ids = new Set(rows.map((row) => row.id));
		this.states = this.states.filter((state) => ids.has(state.id));
		this.states.push(...errors);
		for (const row of rows) {
			const mounted = this.mounted.find((item) => item.row.id === row.id);
			const changed = !mounted || mounted.row.name !== row.name || !sameConfig(mounted.row.config, row.config);
			if (row.disabled ? Boolean(mounted) : changed) {
				await this.apply(row.id);
				continue;
			}
			if (!mounted) {
				this.put(this.offState(row));
			}
		}
		// A row that is no longer in any list is not a row: its state goes with it.
		const known = new Set(rows.map((row) => row.id));
		this.states = this.states.filter((state) => known.has(state.id));
		this.ctx.emit('plugins/changed');
		return this.state();
	}

	/** Applies one row again: it goes, or comes back, and nothing else about the tree moves. */
	async apply(id: string): Promise<PluginState[]> {
		const going = this.mounted.filter((item) => item.row.id === id);
		this.mounted = this.mounted.filter((item) => item.row.id !== id);
		for (const { fiber } of going.reverse()) {
			try {
				await fiber.dispose();
			} catch (error) {
				this.ctx.log.message(`plugins: unloading ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const { rows, errors } = this.resolveRows();
		for (const error of errors.filter((entry) => entry.id === id)) {
			this.put(error);
		}
		const row = rows.find((entry) => entry.id === id);
		if (row && !row.disabled) {
			this.put(await this.loadRow(row));
		} else if (row) {
			this.put(this.offState(row));
		} else {
			this.states = this.states.filter((state) => state.id !== id);
		}
		this.ctx.emit('plugins/changed');
		return this.state();
	}

	/** The rows to apply, with the file each came from — and whatever went wrong reading one. */
	private resolveRows(): { rows: ResolvedRow[]; errors: PluginState[] } {
		const rows = new Map<string, ResolvedRow>();
		for (const row of this.config.rows) {
			rows.set(row.id, { ...row, source: 'builtin', dir: '' });
		}
		const errors: PluginState[] = [];
		// The user's list first, the project's second: a row of the same id is the project's to decide.
		const files = [
			['user', this.userFile],
			['project', this.projectFile],
		] as const;
		for (const [source, file] of files) {
			if (!file) {
				continue;
			}
			// A file in the workspace is code someone else may have written: loading it is part of what
			// trusting the workspace means, and nothing else here behaves differently for an untrusted one.
			if (source === 'project' && !this.ctx.host.trusted()) {
				continue;
			}
			try {
				for (const row of readRows(file)) {
					const previous = rows.get(row.id);
					rows.set(row.id, {
						...previous,
						...row,
						// A row nobody shipped needs a name; a patch of a built-in row keeps the one it had.
						name: row.name ?? previous?.name,
						source,
						dir: dirname(file),
					});
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push({ id: file, source, target: file, enabled: true, loaded: false, provides: [], injects: [], error: message });
				this.ctx.log.message(`plugins: ${message}`);
			}
		}
		return { rows: [...rows.values()], errors };
	}

	private target(row: ResolvedRow): string {
		return this.config.plugins[row.name ?? row.id] ? 'built-in' : (row.name ?? row.id);
	}

	private async load(row: ResolvedRow): Promise<Plugin> {
		const builtin = this.config.plugins[row.name ?? row.id];
		if (builtin) {
			return builtin;
		}
		const name = row.name ?? row.id;
		if (!name) {
			throw new Error('a row with no name, and no built-in plugin of that id, has nothing to load');
		}
		// A package is resolved by Node, from the extension's own modules; a path is read where the row's
		// own yml sits, so a plugin travels with the list that names it.
		if (!name.startsWith('.') && !isAbsolute(name)) {
			return pickDefault((await import(name)) as { default?: Plugin });
		}
		const file = resolve(row.dir || this.ctx.host.home(), name);
		if (!existsSync(file)) {
			throw new Error(`no plugin at ${file}`);
		}
		return pickDefault((await import(pathToFileURL(file).href)) as { default?: Plugin });
	}

	private async unmount(): Promise<void> {
		const mounted = this.mounted.reverse();
		this.mounted = [];
		for (const { fiber } of mounted) {
			try {
				await fiber.dispose();
			} catch (error) {
				this.ctx.log.message(`plugins: unloading failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}

/**
 * What a module means by "the plugin it exports": the default export, or the module itself when it
 * *is* the plugin — a plain `export function apply(ctx)` file is a plugin without ceremony.
 */
function pickDefault(module: unknown): Plugin {
	// A *built* plugin arrives nested: `import()` of a CommonJS bundle hands back a namespace whose
	// `default` is the bundle's own namespace, whose `default` is the plugin. A function wins over an
	// object because a function is where the plugin's `inject` is written, and a plugin mounted without
	// its injections runs too early — worse than one that never loaded.
	const chain: unknown[] = [];
	for (let current = module; current !== null && current !== undefined && !chain.includes(current); current = (current as { default?: unknown }).default) {
		chain.push(current);
	}
	const plugin = chain.find((value) => typeof value === 'function') ?? chain.find((value) => typeof (value as { apply?: unknown } | undefined)?.apply === 'function');
	if (plugin) {
		return plugin as Plugin;
	}
	throw new Error('the module exports neither a default plugin nor an `apply` function');
}

/**
 * The plugin the application mounts. A function plugin, not the class: `mount` is asynchronous, and a
 * plugin's own `inject` is what lets the service it builds read `host` and `log` at all.
 */
export async function pluginHost(ctx: Context, config: PluginHostConfig): Promise<void> {
	const host = new Plugins(ctx, config);
	await host.mount();
	const state = host.state();
	const failed = state.filter((row) => row.enabled && !row.loaded);
	ctx.log.message(
		`plugins: ${state.filter((row) => row.loaded).length}/${state.length} row(s) loaded` +
			(failed.length ? ` — check: ${failed.map((row) => row.id).join(', ')}` : ''),
	);
}
pluginHost.inject = ['host', 'log'];
