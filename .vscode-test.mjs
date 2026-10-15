import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@vscode/test-cli';

// A home of Comonad's own for the test window: without it the suite reads your real `~/.comonad`, so
// installing a plugin of your own would change — or break — what a test sees. Created here and removed
// when the runner exits; the extension host sees it as `COMONAD_HOME`.
const home = mkdtempSync(join(tmpdir(), 'comonad-test-home-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	env: { COMONAD_HOME: home },
	// To run the harness against your locally installed VS Code instead of downloading one:
	// useInstallation: { fromPath: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' },
});
