// SPDX-License-Identifier: AGPL-3.0-only
const esbuild = require("esbuild");
const { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } = require("node:fs");
const { dirname, join } = require("node:path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');
// A plugin package is built as its own bundle: a plugin is loaded by the host at runtime, from a file
// beside its own resources, so it cannot be folded into the extension's one file.
const plugin = process.argv.includes('--plugin');

/**
 * Every package under `packages/` that declares itself a plugin row, with the bundle it builds to.
 * The list is read rather than written down, so a plugin added to the tree needs no build change.
 */
function pluginPackages() {
	const found = [];
	for (const entry of readdirSync('packages', { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const dir = join('packages', entry.name);
		try {
			const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
			if (manifest.comonad && manifest.comonad.plugin) {
				found.push({
					name: manifest.name ?? entry.name,
					dir,
					manifest,
					entry: join(dir, 'src', 'index.ts'),
					outfile: join(dir, 'dist', 'index.js'),
				});
			}
		} catch {
			// A folder without a readable manifest is not a plugin package.
		}
	}
	return found;
}

/** A browser bundle a plugin declares (its webview half), and the files it copies from the repo. */
async function buildPluginAssets(target) {
	const webview = target.manifest.comonad?.webview;
	if (webview) {
		const ctx = await esbuild.context({
			entryPoints: [join(target.dir, webview.entry)],
			outfile: join(target.dir, webview.outfile),
			bundle: true,
			format: 'iife',
			platform: 'browser',
			target: 'es2022',
			minify: production,
			sourcemap: !production,
			sourcesContent: false,
			logLevel: 'silent',
			plugins: [esbuildProblemMatcherPlugin],
		});
		if (watch) {
			await ctx.watch();
		} else {
			await ctx.rebuild();
			await ctx.dispose();
		}
	}
	for (const item of target.manifest.comonad?.copy ?? []) {
		const from = existsSync(join(__dirname, item.from)) ? join(__dirname, item.from) : join(target.dir, item.from);
		const to = join(target.dir, item.to);
		if (!existsSync(from)) {
			throw new Error(`[${target.name}] missing asset ${item.from} — run npm install first`);
		}
		mkdirSync(dirname(to), { recursive: true });
		if (statSync(from).isDirectory()) {
			cpSync(from, to, { recursive: true, force: true });
		} else {
			copyFileSync(from, to);
		}
	}
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const common = {
		bundle: true,
		format: 'cjs',
		platform: 'node',
		// The tokenizers are megabytes of rank tables and an inlined wasm blob. Bundling them would put
		// that in front of every activation; left external they are read from `node_modules` the first
		// time a token is actually counted. `.vscodeignore` re-includes them for the packaged build.
		external: ['vscode', '@agnai/web-tokenizers', 'gpt-tokenizer/*'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	};
	// Every plugin package, each as its own bundle: the platform modules are the host's, and it lends
	// them to the plugin at run time (`src/services/plugin-modules.ts`) — bundling a second cordis would
	// give the plugin a context class no Comonad service belongs to.
	if (plugin) {
		for (const target of pluginPackages()) {
			const ctx = await esbuild.context({
				...common,
				entryPoints: [target.entry],
				outfile: target.outfile,
				external: ['vscode', 'cordis', 'schemastery'],
				minify: production,
				sourcemap: !production,
				sourcesContent: false,
			});
			if (watch) {
				await ctx.watch();
			} else {
				await ctx.rebuild();
				await ctx.dispose();
			}
			await buildPluginAssets(target);
		}
		return;
	}

	// The chat's code highlighter, as its own browser bundle: it is loaded before chat.js and exposes
	// the `hljs` global. Built here (not as a plugin) because every chat uses it.
	const highlight = await esbuild.context({
		entryPoints: ['src/webview/highlight.ts'],
		outfile: 'resources/highlight.js',
		bundle: true,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});
	if (watch) {
		await highlight.watch();
	} else {
		await highlight.rebuild();
		await highlight.dispose();
	}

	const ctx = await esbuild.context(
		tests
			? {
					...common,
					entryPoints: [
						'src/test/extension.test.ts',
						'src/test/activation.test.ts',
						'src/test/cancellation.test.ts',
						'src/test/workflow.test.ts',
					],
					outdir: 'out/test',
					sourcemap: true,
				}
			: {
					...common,
					entryPoints: ['src/main.ts'],
					outfile: 'dist/extension.js',
					minify: production,
					sourcemap: !production,
					sourcesContent: false,
				},
	);
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
