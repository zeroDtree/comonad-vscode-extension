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
			'comonad.review',
			'comonad.stop',
			'comonad.openChat',
			'comonad.openSettings',
			'comonad.pickPreset',
			'comonad.toggleHistory',
			'comonad.reloadMcp',
			'comonad.chat.focus',
			'workbench.view.extension.comonadChat',
		]) {
			assert.ok(commands.includes(id), `${id} is registered`);
		}
		// The tavern is a plugin of its own, mounted from a `cordis.yml` row: its commands come and go
		// with that row, so a fresh window has none of them.
		for (const id of ['comonad.pickCharacter', 'comonad.pickPersona', 'comonad.reloadTavern']) {
			assert.ok(!commands.includes(id), `${id} belongs to the tavern plugin, not the kernel`);
		}
	});
});
