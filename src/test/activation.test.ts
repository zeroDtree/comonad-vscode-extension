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
		// So is the change journal: its review commands are declared in the manifest behind
		// `enablement: comonad.checkpoints`, and nothing registers them until the row is installed.
		// Exporting a chat is not the journal's: that one stays in the kernel and is there now.
		for (const id of ['comonad.review', 'comonad.keepAll', 'comonad.undoAll', 'comonad.rewind']) {
			assert.ok(!commands.includes(id), `${id} belongs to the change-journal plugin, not the kernel`);
		}

	});
});
