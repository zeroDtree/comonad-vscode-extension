// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	defaultWriteScope,
	ensureSettingsFile,
	explicitSettings,
	mergeSettings,
	migrateLegacySettings,
	readMigrationState,
	readSettings,
	settingsDisplayPath,
	settingsFile,
	writeSettings,
} from '../lib/settings-file';

const parsed = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;

suite('Settings files', () => {
	let root: string;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'comonad-settings-'));
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('the paths follow the user and workspace conventions', () => {
		assert.strictEqual(settingsFile('/home/me', '/ws', 'user'), join('/home/me', '.comonad', 'settings.json'));
		assert.strictEqual(settingsFile('/home/me', '/ws', 'workspace'), join('/ws', '.comonad', 'settings.json'));
		assert.strictEqual(settingsFile('/home/me', '', 'workspace'), '', 'no folder means no workspace file');
	});

	test('a missing file reads as an empty object', () => {
		assert.deepStrictEqual(readSettings(join(root, 'nope.json')), { data: {} });
	});

	test('a malformed file reads as empty with the reason kept', () => {
		const file = join(root, 'settings.json');
		writeFileSync(file, '{ not json', 'utf8');
		const result = readSettings(file);
		assert.deepStrictEqual(result.data, {});
		assert.match(String(result.error), /settings\.json: /);
	});

	test('a top level that is not an object is refused', () => {
		const file = join(root, 'settings.json');
		writeFileSync(file, '[]', 'utf8');
		assert.match(String(readSettings(file).error), /must hold a JSON object/);
		writeFileSync(file, 'null', 'utf8');
		assert.match(String(readSettings(file).error), /must hold a JSON object/);
	});

	test('a byte-order mark does not defeat the parser', () => {
		const file = join(root, 'settings.json');
		writeFileSync(file, `﻿{"model":"auto"}`, 'utf8');
		assert.deepStrictEqual(readSettings(file).data, { model: 'auto' });
	});

	test('unsafe keys are dropped while reading', () => {
		const file = join(root, 'settings.json');
		writeFileSync(file, '{"__proto__":{"polluted":true},"ok":1}', 'utf8');
		const data = readSettings(file).data;
		assert.strictEqual(data.ok, 1);
		assert.ok(!Object.hasOwn(data, '__proto__'));
		assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
	});

	test('the workspace layer wins per key', () => {
		const merged = mergeSettings({ model: 'user', network: true }, { model: 'workspace' });
		assert.deepStrictEqual(merged, { model: 'workspace', network: true });
		// Nested values are replaced whole, not deep-merged.
		const permissions = mergeSettings(
			{ permissions: { allow: ['a'], ask: [], deny: [] } },
			{ permissions: { allow: [], ask: [], deny: ['b'] } },
		);
		assert.deepStrictEqual(permissions.permissions, { allow: [], ask: [], deny: ['b'] });
	});

	test('a write creates folders, sorts keys and ends with a newline', () => {
		const file = join(root, 'nested', 'settings.json');
		writeSettings(file, { z: 1, a: { y: 2, x: 3 } });
		assert.strictEqual(readFileSync(file, 'utf8'), '{\n  "a": {\n    "y": 2,\n    "x": 3\n  },\n  "z": 1\n}\n');
		assert.deepStrictEqual(parsed(file), { a: { y: 2, x: 3 }, z: 1 });
	});

	test('a malformed file is copied aside before it is replaced', () => {
		const file = join(root, 'settings.json');
		writeFileSync(file, '{ broken', 'utf8');
		const result = writeSettings(file, { model: 'auto' });
		assert.ok(result.backup, 'a backup path is reported');
		assert.strictEqual(readFileSync(result.backup!, 'utf8'), '{ broken');
		assert.deepStrictEqual(parsed(file), { model: 'auto' });
	});

	test('ensureSettingsFile creates an empty object and leaves existing text alone', () => {
		const file = join(root, 'settings.json');
		ensureSettingsFile(file);
		assert.strictEqual(readFileSync(file, 'utf8'), '{}\n');
		writeFileSync(file, '{ broken', 'utf8');
		ensureSettingsFile(file);
		assert.strictEqual(readFileSync(file, 'utf8'), '{ broken', 'an existing file is never truncated');
	});

	test('the implicit write scope follows the key', () => {
		assert.strictEqual(defaultWriteScope('model', undefined), 'user');
		assert.strictEqual(defaultWriteScope('model', {}), 'user');
		assert.strictEqual(defaultWriteScope('model', { model: 'auto' }), 'workspace');
	});

	test('explicit values split into the user and workspace layers', () => {
		const values: Record<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }> = {
			model: { globalValue: 'global', workspaceValue: 'workspace', workspaceFolderValue: 'folder' },
			network: { globalValue: true },
			unset: {},
			nothing: { globalValue: null, workspaceValue: undefined },
		};
		const split = explicitSettings(['model', 'network', 'unset', 'nothing', 'missing'], (key) => values[key]);
		assert.deepStrictEqual(split.user, { model: 'global', network: true }, 'manifest defaults are never imported');
		assert.deepStrictEqual(split.workspace, { model: 'folder' }, 'the folder value is what wins');
	});

	test('display paths abbreviate only the user file', () => {
		const home = join(root, 'home');
		assert.strictEqual(settingsDisplayPath(join(home, '.comonad', 'settings.json'), home), '~/.comonad/settings.json');
		assert.strictEqual(settingsDisplayPath(join(root, 'ws', '.comonad', 'settings.json'), home), join(root, 'ws', '.comonad', 'settings.json'));
		assert.strictEqual(settingsDisplayPath('', home), '');
	});

	test('migration imports each scope once and never re-imports', () => {
		const input = {
			markerFile: join(root, 'storage', 'settings-migration.json'),
			userFile: join(root, 'home', '.comonad', 'settings.json'),
			workspaceFile: join(root, 'ws', '.comonad', 'settings.json'),
			keys: ['model', 'network'],
			inspect: (key: string) =>
				key === 'model'
					? { globalValue: 'auto', workspaceValue: 'workspace', workspaceFolderValue: 'folder' }
					: key === 'network'
						? { globalValue: true }
						: undefined,
			trusted: true,
		};
		migrateLegacySettings(input);
		assert.deepStrictEqual(parsed(input.userFile), { model: 'auto', network: true });
		assert.deepStrictEqual(parsed(input.workspaceFile), { model: 'folder' });
		const marker = readMigrationState(input.markerFile);
		assert.strictEqual(marker.user, true);
		assert.deepStrictEqual(marker.workspaces, [input.workspaceFile]);

		// Deleting a file after migration must not bring the old VS Code values back.
		rmSync(input.userFile);
		rmSync(input.workspaceFile);
		migrateLegacySettings(input);
		assert.ok(!existsSync(input.userFile));
		assert.ok(!existsSync(input.workspaceFile));
	});

	test('migration never overwrites a file that already exists', () => {
		const file = join(root, 'home', '.comonad', 'settings.json');
		const input = {
			markerFile: join(root, 'storage', 'settings-migration.json'),
			userFile: file,
			workspaceFile: '',
			keys: ['model'],
			inspect: () => ({ globalValue: 'from-vscode' }),
			trusted: true,
		};
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, '{"model":"mine"}', 'utf8');
		migrateLegacySettings(input);
		assert.deepStrictEqual(parsed(file), { model: 'mine' });
		assert.strictEqual(readMigrationState(input.markerFile).user, true);
	});

	test('an untrusted workspace is skipped but not marked', () => {
		const input = (trusted: boolean) => ({
			markerFile: join(root, 'storage', 'settings-migration.json'),
			userFile: join(root, 'home', '.comonad', 'settings.json'),
			workspaceFile: join(root, 'ws', '.comonad', 'settings.json'),
			keys: ['model'],
			inspect: () => ({ workspaceValue: 'project' }),
			trusted,
		});
		migrateLegacySettings(input(false));
		assert.ok(!existsSync(input(true).workspaceFile));
		assert.deepStrictEqual(readMigrationState(input(false).markerFile).workspaces, []);
		migrateLegacySettings(input(true));
		assert.deepStrictEqual(parsed(input(true).workspaceFile), { model: 'project' });
	});

	test('an import with nothing to copy still marks the user scope', () => {
		const input = {
			markerFile: join(root, 'storage', 'settings-migration.json'),
			userFile: join(root, 'home', '.comonad', 'settings.json'),
			workspaceFile: '',
			keys: ['model'],
			inspect: () => undefined,
			trusted: true,
		};
		migrateLegacySettings(input);
		assert.ok(!existsSync(input.userFile));
		assert.strictEqual(readMigrationState(input.markerFile).user, true);
	});

	test('a corrupt marker starts the import from scratch', () => {
		const markerFile = join(root, 'storage', 'settings-migration.json');
		mkdirSync(dirname(markerFile), { recursive: true });
		writeFileSync(markerFile, 'not json', 'utf8');
		assert.deepStrictEqual(readMigrationState(markerFile), { version: 1, user: false, workspaces: [] });
		migrateLegacySettings({
			markerFile,
			userFile: join(root, 'home', '.comonad', 'settings.json'),
			workspaceFile: '',
			keys: [],
			inspect: () => undefined,
			trusted: true,
		});
		assert.strictEqual(readMigrationState(markerFile).user, true);
	});
});
