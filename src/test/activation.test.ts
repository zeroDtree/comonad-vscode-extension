import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Comonad extension', () => {
	test('activates and registers commands', async () => {
		const extension = vscode.extensions.getExtension('comonad.comonad');
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
		// The tavern is a plugin of its own, mounted from a `cordis.yml` row: its commands come and go
		// with that row, so a fresh window has none of them.
		for (const id of ['comonad.pickCharacter', 'comonad.pickPersona', 'comonad.reloadTavern']) {
			assert.ok(!commands.includes(id), `${id} belongs to the tavern plugin, not the kernel`);
		}
		// The change journal is a row of the shipped tree — on by default, and its review commands are
		// there with it (the manifest's `enablement: comonad.checkpoints` hides them again when the row
		// is turned off). Exporting a chat is not the journal's: that one is the sessions view's.
		for (const id of [
			'comonad.review',
			'comonad.keepAll',
			'comonad.undoAll',
			'comonad.keepFile',
			'comonad.undoFile',
			'comonad.openChangeDiff',
			'comonad.keepHunk',
			'comonad.undoHunk',
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
