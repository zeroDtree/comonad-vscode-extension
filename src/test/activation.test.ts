// SPDX-License-Identifier: AGPL-3.0-only
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Comonad extension', () => {
	test('activates and registers commands', async () => {
		const extension = vscode.extensions.getExtension('zeroDtree.comonad');
		assert.ok(extension, 'extension is installed');
		await extension!.activate();
		assert.ok(extension!.isActive, 'extension is active');
		const commands = await vscode.commands.getCommands(true);
		for (const id of [
			'comonad.newSession',
			'comonad.stop',
			'comonad.openChat',
			'comonad.referenceSelection',
			'comonad.openSettings',
			'comonad.pickPreset',
			'comonad.toggleHistory',
			'comonad.reloadMcp',
			'comonad.chat.focus',
			'workbench.view.extension.comonadChat',
			'comonad.exportSession',
		]) {
			assert.ok(commands.includes(id), `${id} is registered`);
		}
		// The change journal is a row of the shipped tree — on by default, and its review commands are
		// there with it (the manifest's `enablement: comonad.checkpoints` hides them again when the row
		// is turned off). Exporting a chat is not the journal's: that one is the sessions view's.
		for (const id of [
			'comonad.review',
			'comonad.keepAll',
			'comonad.undoAll',
			'comonad.openChangeDiff',
			'comonad.reviewFile',
			'comonad.git.openDiff',
			'comonad.git.openFile',
			'comonad.git.stage',
			'comonad.git.unstage',
			'comonad.git.discard',
			'comonad.git.stageAll',
			'comonad.git.unstageAll',
			'comonad.git.refresh',
		]) {
			assert.ok(commands.includes(id), `${id} comes with its row`);
		}

	});
});
