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

/** A browser bundle for a webview: IIFE, no node externals, minified only for a release. */
async function buildWebview(entry, outfile) {
	const context = await esbuild.context({
		entryPoints: [entry],
		outfile,
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
		await context.watch();
	} else {
		await context.rebuild();
		await context.dispose();
	}
}

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

	// The chat's markdown renderer, as its own browser bundle: it carries markdown-it, the highlighter
	// and the math hooks, is loaded before chat.js, and exposes the `__comonadMarkdown` global. Built
	// here (not as a plugin) because every chat uses it.
	await buildWebview('src/webview/markdown.ts', 'resources/markdown.js');
	// The Review tab's guest: one browser bundle against the resource directory, so the tab has no
	// runtime dependency beyond the extension's own files.
	await buildWebview('src/webview/review.ts', 'resources/review.js');
	// The File Review tab's guest: CodeMirror plus the unified merge view, which draws removed lines
	// as real rows. Bundled the same way — no runtime dependency outside the resource directory.
	await buildWebview('src/webview/file-review.ts', 'resources/file-review.js');

	const ctx = await esbuild.context(
		tests
			? {
					...common,
					// Object form: output names stay flat under `out/test` no matter where a
					// test entry lives (the kernel's under `src/test`, the model package's
					// under `packages/comonad-model/tests`).
					entryPoints: {
						'extension.test': 'src/test/extension.test.ts',
						'activation.test': 'src/test/activation.test.ts',
						'agent-output.test': 'src/test/agent-output.test.ts',
						'authorization.test': 'src/test/authorization.test.ts',
						'cancellation.test': 'src/test/cancellation.test.ts',
						'graph.test': 'src/test/graph.test.ts',
						'policy.test': 'src/test/policy.test.ts',
						'settings-file.test': 'src/test/settings-file.test.ts',
						'trace.test': 'src/test/trace.test.ts',
						'subagent.test': 'src/test/subagent.test.ts',
						'agents.test': 'src/test/agents.test.ts',
						'task-graph.test': 'src/test/task-graph.test.ts',
						'locks.test': 'src/test/locks.test.ts',
						'mailbox.test': 'src/test/mailbox.test.ts',
						'orchestration.test': 'src/test/orchestration.test.ts',
						'plans.test': 'src/test/plans.test.ts',
						'review.test': 'src/test/review.test.ts',
						'model-errors.test': 'packages/comonad-model/tests/errors.test.ts',
						'model-sse.test': 'packages/comonad-model/tests/sse.test.ts',
						'model-merge.test': 'packages/comonad-model/tests/merge.test.ts',
						'model-pricing.test': 'packages/comonad-model/tests/pricing.test.ts',
						'model-runtime.test': 'packages/comonad-model/tests/runtime.test.ts',
						'model-replay.test': 'packages/comonad-model/tests/replay.test.ts',
						'model-boundary.test': 'packages/comonad-model/tests/boundary.test.ts',
						'model-conformance-openai-chat.test': 'packages/comonad-model/tests/conformance/openai-chat.test.ts',
						'model-brands.test': 'packages/comonad-model/tests/brands.test.ts',
						'model-conformance-anthropic.test': 'packages/comonad-model/tests/conformance/anthropic-messages.test.ts',
						'model-conformance-gemini.test': 'packages/comonad-model/tests/conformance/gemini.test.ts',
						'model-conformance-matrix.test': 'packages/comonad-model/tests/conformance/cross-protocol.test.ts',
					},
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
