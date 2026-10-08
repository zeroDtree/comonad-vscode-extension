import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// To run the harness against your locally installed VS Code instead of downloading one:
	// useInstallation: { fromPath: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' },
});
