const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');
// A plugin package is built as its own bundle: a plugin is loaded by the host at runtime, from a file
// beside its own resources, so it cannot be folded into the extension's one file.
const plugin = process.argv.includes('--plugin');

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
	const ctx = await esbuild.context(
		plugin
			? {
					...common,
					entryPoints: ['packages/comonad-plugin-tavern/src/index.ts'],
					outfile: 'packages/comonad-plugin-tavern/dist/index.js',
					// The platform modules are the host's, and it lends them to the plugin at run time
					// (`src/services/plugin-modules.ts`): bundling a second cordis would give the plugin a
					// context class no Comonad service belongs to.
					external: ['vscode', 'cordis', 'schemastery'],
					minify: production,
					sourcemap: !production,
					sourcesContent: false,
				}
			: tests
			? {
					...common,
					entryPoints: ['src/test/extension.test.ts', 'src/test/activation.test.ts'],
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
