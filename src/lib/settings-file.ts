// SPDX-License-Identifier: AGPL-3.0-only
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe } from './util';

/**
 * Comonad's own settings files. A workspace carries `<workspace>/.comonad/settings.json` and the
 * user carries `<home>/.comonad/settings.json`; the effective value of a key is the workspace's
 * when it declares one, and the user's otherwise. Keys are stored bare (`model`, not
 * `comonad.model`) — these files are Comonad's, not VS Code's configuration.
 *
 * Nothing here touches `vscode`: the Host supplies the two paths, this module only reads, merges
 * and writes them. A settings file is untrusted input, so reads degrade to `{}` (with the error
 * kept for the caller to log) and a malformed file is copied aside before it is ever replaced.
 */

export type SettingsScope = 'user' | 'workspace';
export type SettingsData = Record<string, unknown>;

/** The properties a malicious JSON object must not smuggle into a spread. */
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const FILE = 'settings.json';

/** Distinguishes the temp names of two writes in the same process and millisecond. */
let writeCounter = 0;

/** Where a scope writes: '' means "no workspace folder is open". */
export function settingsFile(home: string, workspace: string, scope: SettingsScope): string {
	if (scope === 'workspace') {
		return workspace ? join(workspace, '.comonad', FILE) : '';
	}
	return join(home, '.comonad', FILE);
}

export interface SettingsReadResult {
	data: SettingsData;
	/** Set when the file exists but is not a JSON object (malformed, an array, `null`, …). */
	error?: string;
}

export interface SettingsWriteResult {
	/** The copy made of a malformed file before it was replaced. */
	backup?: string;
}

/** A JSON object with the unsafe keys dropped; arrays and scalars are the caller's problem. */
function sanitize(data: SettingsData): SettingsData {
	const out: SettingsData = {};
	for (const [key, value] of Object.entries(data)) {
		if (!UNSAFE_KEYS.has(key)) {
			out[key] = value;
		}
	}
	return out;
}

/** A missing file reads as `{}`; a malformed one reads as `{}` plus the reason. */
export function readSettings(file: string): SettingsReadResult {
	if (!file || !existsSync(file)) {
		return { data: {} };
	}
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch (error) {
		return { data: {}, error: `${file}: ${describe(error)}` };
	}
	// A BOM is legal at the start of a UTF-8 file but `JSON.parse` refuses it.
	if (text.charCodeAt(0) === 0xfeff) {
		text = text.slice(1);
	}
	if (!text.trim()) {
		return { data: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		return { data: {}, error: `${file}: ${describe(error)}` };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { data: {}, error: `${file}: a settings file must hold a JSON object` };
	}
	return { data: sanitize(parsed as SettingsData) };
}

/**
 * Writes a whole settings file: folders created, top-level keys sorted, pretty JSON with a
 * trailing newline, and a temp file renamed into place so a reader never sees half a file. An
 * existing file that is not valid JSON is copied to `<file>.bak-<timestamp>` first — a save must
 * never silently discard text a user was editing by hand.
 */
export function writeSettings(file: string, data: SettingsData): SettingsWriteResult {
	if (!file) {
		throw new Error('No settings file to write');
	}
	mkdirSync(dirname(file), { recursive: true });
	const existing = readSettings(file);
	let backup: string | undefined;
	if (existing.error) {
		backup = `${file}.bak-${Date.now()}`;
		copyFileSync(file, backup);
	}
	const sorted: SettingsData = {};
	for (const key of Object.keys(data).sort()) {
		const value = data[key];
		if (value !== undefined && !UNSAFE_KEYS.has(key)) {
			sorted[key] = value;
		}
	}
	const text = `${JSON.stringify(sorted, null, 2)}\n`;
	const temp = `${file}.${process.pid}.${(writeCounter += 1).toString(36)}.tmp`;
	try {
		writeFileSync(temp, text, 'utf8');
		renameSync(temp, file);
	} catch {
		// A filesystem that refuses the rename (a locked target on Windows, say) still gets the
		// content; the temp file is cleaned up first so nothing half-written is left behind.
		try {
			rmSync(temp, { force: true });
		} catch {
			// Best effort: the direct write below is what must succeed.
		}
		writeFileSync(file, text, 'utf8');
	}
	return backup ? { backup } : {};
}

/** User layer first, workspace layer second: a workspace key replaces the user's whole value. */
export function mergeSettings(user: SettingsData, workspace: SettingsData): SettingsData {
	return { ...sanitize(user), ...sanitize(workspace) };
}

/**
 * Where a write without an explicit scope goes: the workspace file when it already declares the
 * key, else the user file. This is the old `settingsTarget` rule, now answered by the files.
 */
export function defaultWriteScope(key: string, workspace: SettingsData | undefined): SettingsScope {
	return workspace && Object.hasOwn(workspace, key) ? 'workspace' : 'user';
}

/**
 * Where a composer pick or a freshly opened Settings panel writes by default: the workspace's file
 * when a folder is open and trusted, the user's file otherwise. Unlike `defaultWriteScope` this
 * ignores who owns the key today: a composer pick is a per-project choice even when only the user
 * file has the key. An explicit `update` scope still wins.
 */
export function workspaceFirstScope(workspace: string, trusted: boolean): SettingsScope {
	return workspace && trusted ? 'workspace' : 'user';
}

/** Creates `{}\n` when the file is missing; an existing file is never truncated or repaired here. */
export function ensureSettingsFile(file: string): void {
	if (file && !existsSync(file)) {
		writeSettings(file, {});
	}
}

/** `~` only when the file really is under the OS home; `COMONAD_HOME` paths stay absolute. */
export function settingsDisplayPath(file: string, home: string): string {
	if (!file) {
		return '';
	}
	const canonical = join(home, '.comonad', FILE);
	return resolve(file) === resolve(canonical) ? '~/.comonad/settings.json' : file;
}

/** The values `WorkspaceConfiguration.inspect()` reports, as the migration reads them. */
export interface InspectedScopes {
	globalValue?: unknown;
	workspaceValue?: unknown;
	workspaceFolderValue?: unknown;
}

/**
 * The explicitly-set values of a VS Code settings section, split by where they lived. Manifest
 * defaults are never consulted: only `globalValue` and the project's own value are real choices.
 */
export function explicitSettings(
	keys: readonly string[],
	inspect: (key: string) => InspectedScopes | undefined,
): { user: SettingsData; workspace: SettingsData } {
	const user: SettingsData = {};
	const workspace: SettingsData = {};
	for (const key of keys) {
		const scopes = inspect(key);
		if (!scopes) {
			continue;
		}
		if (scopes.globalValue !== undefined && scopes.globalValue !== null) {
			user[key] = scopes.globalValue;
		}
		const projectValue = scopes.workspaceFolderValue !== undefined ? scopes.workspaceFolderValue : scopes.workspaceValue;
		if (projectValue !== undefined && projectValue !== null) {
			workspace[key] = projectValue;
		}
	}
	return { user, workspace };
}

/** What the one-time import has already done, so deleting a file never imports it again. */
export interface MigrationState {
	version: 1;
	user: boolean;
	workspaces: string[];
	/** The legacy `profiles` → `providers` rewrite has run. */
	providers?: boolean;
}

export interface MigrateInput {
	/** `settings-migration.json`, in the extension's global storage. */
	markerFile: string;
	userFile: string;
	/** '' when no workspace folder is open. */
	workspaceFile: string;
	keys: readonly string[];
	inspect: (key: string) => InspectedScopes | undefined;
	trusted: boolean;
}

export function readMigrationState(file: string): MigrationState {
	const { data } = readSettings(file);
	const workspaces = Array.isArray(data.workspaces)
		? data.workspaces.filter((item): item is string => typeof item === 'string')
		: [];
	return { version: 1, user: data.user === true, workspaces, providers: data.providers === true };
}

/**
 * Imports VS Code's explicitly-set `comonad.*` values once per scope. The marker is written last
 * and only when something changed; an untrusted workspace is skipped *without* being marked, so
 * the import can still happen on a later activation after the user grants trust. An existing
 * target file is never overwritten, even when the marker was lost.
 */
export function migrateLegacySettings(input: MigrateInput): MigrationState {
	const state = readMigrationState(input.markerFile);
	const { user, workspace } = explicitSettings(input.keys, input.inspect);
	let changed = false;

	if (!state.user) {
		if (!existsSync(input.userFile) && Object.keys(user).length > 0) {
			writeSettings(input.userFile, user);
		}
		state.user = true;
		changed = true;
	}

	if (input.workspaceFile && input.trusted) {
		const path = resolve(input.workspaceFile);
		if (!state.workspaces.includes(path)) {
			if (!existsSync(input.workspaceFile) && Object.keys(workspace).length > 0) {
				writeSettings(input.workspaceFile, workspace);
			}
			state.workspaces.push(path);
			changed = true;
		}
	}

	if (changed) {
		writeSettings(input.markerFile, {
			version: 1,
			user: state.user,
			workspaces: state.workspaces,
			providers: state.providers === true ? true : undefined,
		});
	}
	return state;
}

/** A legacy model profile, as builds before the Model Runtime wrote it. Only the migration reads this shape. */
interface LegacyProfile {
	id?: unknown;
	base?: unknown;
	model?: unknown;
	modelPrefix?: unknown;
	modelSkip?: unknown;
	keyEnv?: unknown;
	thinkingOff?: unknown;
	topEffort?: unknown;
	temperature?: unknown;
	topP?: unknown;
	maxTokens?: unknown;
	contextWindow?: unknown;
	includeUsage?: unknown;
	pricingIn?: unknown;
	pricingCachedIn?: unknown;
	pricingOut?: unknown;
}

export interface ProfileMigrationInput {
	markerFile: string;
	/** The settings files to rewrite, in order; a file with `providers` already is left alone. */
	files: string[];
	/** Reads a legacy per-profile secret (`comonad.key.<profileId>`). */
	readLegacyKey(profileId: string): Promise<string | undefined>;
	/** Whether the provider-scoped secret for this base already has a key; one is never overwritten. */
	providerKeyStored(base: string): Promise<boolean>;
	writeProviderKey(base: string, key: string): Promise<void>;
}

/** The brand a legacy profile's endpoint speaks. Facts live on the brand now, not in the config. */
function brandOf(profile: LegacyProfile): string {
	const base = typeof profile.base === 'string' ? profile.base.toLowerCase() : '';
	if (base.includes('deepseek')) {
		return 'deepseek';
	}
	if (base.includes('googleapis.com') || base.includes('generativelanguage')) {
		return 'google';
	}
	if (base.includes('opencode')) {
		return 'opencode-go';
	}
	if (base.includes('openai.com')) {
		return 'openai';
	}
	return 'custom';
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** One legacy profile to one provider instance: identity, options, and per-model facts. */
function toProviderInstance(profile: LegacyProfile): Record<string, unknown> | undefined {
	const base = typeof profile.base === 'string' ? profile.base.trim() : '';
	const model = typeof profile.model === 'string' ? profile.model.trim() : '';
	if (!base || !model) {
		return undefined;
	}
	const instance: Record<string, unknown> = { brand: brandOf(profile), base, model };
	if (profile.keyEnv !== undefined) {
		instance.keyEnv = profile.keyEnv;
	}
	if (profile.modelPrefix !== undefined || profile.modelSkip !== undefined) {
		instance.modelRules = {
			prefix: typeof profile.modelPrefix === 'string' ? profile.modelPrefix : undefined,
			skip: typeof profile.modelSkip === 'string' ? profile.modelSkip : undefined,
		};
	}
	const options: Record<string, unknown> = {};
	if (typeof profile.thinkingOff === 'string') {
		options.thinkingOff = profile.thinkingOff;
	}
	if (typeof profile.topEffort === 'string') {
		options.topEffort = profile.topEffort;
	}
	if (profile.includeUsage !== undefined) {
		options.includeUsage = Boolean(profile.includeUsage);
	}
	const sampler: Record<string, unknown> = {
		temperature: asNumber(profile.temperature),
		topP: asNumber(profile.topP),
		maxTokens: asNumber(profile.maxTokens),
	};
	for (const [key, value] of Object.entries(sampler)) {
		if (value !== undefined) {
			options[key] = value;
		}
	}
	if (Object.keys(options).length > 0) {
		instance.options = options;
	}
	const facts: Record<string, unknown> = {};
	const contextWindow = asNumber(profile.contextWindow);
	if (contextWindow !== undefined) {
		facts.contextWindow = contextWindow;
	}
	const pricing: Record<string, unknown> = {
		inPerM: asNumber(profile.pricingIn),
		cachedInPerM: asNumber(profile.pricingCachedIn),
		outPerM: asNumber(profile.pricingOut),
	};
	const priced = Object.fromEntries(Object.entries(pricing).filter(([, value]) => value !== undefined));
	if (Object.keys(priced).length > 0) {
		facts.pricing = priced;
	}
	if (Object.keys(facts).length > 0) {
		instance.models = { [model]: facts };
	}
	return instance;
}

/**
 * Rewrites legacy `profiles` settings into `providers`, once. Each file with `profiles` and
 * without `providers` gains the converted map; `profiles` stays in the file so a rollback can
 * read it. Legacy per-profile secrets move to the provider-scoped id — which every profile on
 * the same endpoint shares — when nothing is stored there yet. Marker-gated; reruns are no-ops.
 */
export async function migrateProfilesToProviders(input: ProfileMigrationInput): Promise<void> {
	const state = readMigrationState(input.markerFile);
	if (state.providers) {
		return;
	}
	for (const file of input.files) {
		if (!file || !existsSync(file)) {
			continue;
		}
		const { data } = readSettings(file);
		if (data.providers !== undefined || data.profiles === undefined) {
			continue;
		}
		const profiles = Array.isArray(data.profiles) ? (data.profiles as LegacyProfile[]) : [];
		const providers: Record<string, unknown> = {};
		for (const raw of profiles.slice(0, 64)) {
			if (!raw || typeof raw !== 'object') {
				continue;
			}
			const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
			if (!id || UNSAFE_KEYS.has(id)) {
				continue;
			}
			const instance = toProviderInstance(raw);
			if (instance) {
				providers[id] = instance;
			}
			if (typeof raw.base === 'string' && raw.base.trim()) {
				const key = await input.readLegacyKey(id);
				if (key && !(await input.providerKeyStored(raw.base.trim()))) {
					await input.writeProviderKey(raw.base.trim(), key);
				}
			}
		}
		if (Object.keys(providers).length > 0) {
			writeSettings(file, { ...data, providers });
		}
	}
	state.providers = true;
	writeSettings(input.markerFile, {
		version: 1,
		user: state.user,
		workspaces: state.workspaces,
		providers: true,
	});
}
