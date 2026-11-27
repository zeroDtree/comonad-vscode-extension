// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The publish boundary, enforced as a test: nothing under `packages/comonad-model/src`
 * may reach the host — not `src/` modules (any relative escape), not `vscode`, not
 * `cordis`, not the `@comonad/*` host namespace. Credentials arrive through KeyProvider.
 */

const packageSrc = resolve(__dirname, '..', '..', 'packages', 'comonad-model', 'src');

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			out.push(...sources(path));
		} else if (path.endsWith('.ts')) {
			out.push(path);
		}
	}
	return out;
}

function specifiersOf(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
		found.push(match[1] ?? '');
	}
	return found;
}

suite('package boundary', () => {
	test('no source under comonad-model/src imports the host', () => {
		const violations: string[] = [];
		for (const file of sources(packageSrc)) {
			for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
				if (specifier === 'vscode' || specifier === 'cordis' || specifier === 'schemastery') {
					violations.push(`${relative(packageSrc, file)} → ${specifier}`);
				} else if (specifier.startsWith('@comonad/')) {
					violations.push(`${relative(packageSrc, file)} → ${specifier}`);
				} else if (specifier.startsWith('.')) {
					const target = resolve(dirname(file), specifier);
					if (!target.startsWith(packageSrc + sep) && target !== packageSrc) {
						violations.push(`${relative(packageSrc, file)} → ${specifier}`);
					}
				}
			}
		}
		assert.deepStrictEqual(violations, []);
	});

	test('the manifest stays out of the plugin build', () => {
		const manifest = JSON.parse(
			readFileSync(join(packageSrc, '..', 'package.json'), 'utf8'),
		) as { comonad?: unknown };
		assert.strictEqual(manifest.comonad, undefined);
	});
});
