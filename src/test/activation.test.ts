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
			'comonad.reloadMcp',
			'comonad.chat.focus',
			'workbench.view.extension.comonadChat',
		]) {
			assert.ok(commands.includes(id), `${id} is registered`);
		}
	});
});
