// SPDX-License-Identifier: AGPL-3.0-only
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { APPROVAL_LABELS, MODE_LABELS, PRESET_LABELS, presetPolicy } from '../lib/policy';
import type { Approval, WorkMode } from '../lib/types';
import type { Config } from '../services/settings';
import { registerCommand } from './register';

/** Preset, mode, approval and network commands. The chat composer embeds the presets and model directly. */

export function presetName(config: Pick<Config, 'mode' | 'approval' | 'network'>): string {
	for (const [name, label] of Object.entries(PRESET_LABELS)) {
		const policy = presetPolicy(name);
		if (policy.workMode === config.mode && policy.approval === config.approval && policy.network === config.network) {
			return label.split(' — ')[0] ?? name;
		}
	}
	return MODE_LABELS[config.mode]?.split(' — ')[0] ?? config.mode;
}

export function controls(ctx: Context): void {
	registerCommand(ctx, 'comonad.pickPreset', () => pickPreset(ctx));
	registerCommand(ctx, 'comonad.pickMode', () => pickMode(ctx));
	registerCommand(ctx, 'comonad.pickApproval', () => pickApproval(ctx));
	registerCommand(ctx, 'comonad.toggleNetwork', async () => {
		await ctx.settings.applyPolicy({ network: !ctx.settings.get().network });
	});
}
controls.inject = ['settings'];

export async function pickPreset(ctx: Context): Promise<void> {
	const current = ctx.settings.get();
	const active = presetName(current);
	const items = Object.entries(PRESET_LABELS)
		.filter(([name]) => current.allowFullAccess || name !== 'full')
		.map(([name, label]) => ({
			label: `${active === label.split(' — ')[0] ? '$(check) ' : ''}${label.split(' — ')[0]}`,
			detail: label.split(' — ')[1] ?? '',
			name,
		}));
	const picked = await vscode.window.showQuickPick(items, { title: 'Comonad preset', ignoreFocusOut: true });
	if (!picked) {
		return;
	}
	const policy = presetPolicy(picked.name);
	await ctx.settings.applyPolicy({
		mode: policy.workMode,
		approval: policy.approval,
		network: policy.network,
		confinement: policy.confinement,
	});
}

export async function pickMode(ctx: Context): Promise<void> {
	const current = ctx.settings.get().mode;
	const items = (Object.entries(MODE_LABELS) as [WorkMode, string][]).map(([name, label]) => ({
		label: `${name === current ? '$(check) ' : ''}${label.split(' — ')[0]}`,
		detail: label.split(' — ')[1] ?? '',
		name,
	}));
	const picked = await vscode.window.showQuickPick(items, { title: 'Comonad work mode', ignoreFocusOut: true });
	if (picked) {
		await ctx.settings.applyPolicy({ mode: picked.name });
	}
}

export async function pickApproval(ctx: Context): Promise<void> {
	const current = ctx.settings.get().approval;
	const items = (Object.entries(APPROVAL_LABELS) as [Approval, string][]).map(([name, label]) => ({
		label: `${name === current ? '$(check) ' : ''}${label.split(' — ')[0]}`,
		detail: label.split(' — ')[1] ?? '',
		name,
	}));
	const picked = await vscode.window.showQuickPick(items, { title: 'Comonad approval policy', ignoreFocusOut: true });
	if (picked) {
		await ctx.settings.applyPolicy({ approval: picked.name });
	}
}
