// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from 'cordis';
import type { SandboxKind } from '../lib/sandbox';
import { hostStorage, type Host } from '../services/host';
import { tokenizersPlugin } from '../services/tokenizers';
import { logPlugin } from '../services/log';
import { settingsPlugin } from '../services/settings';
import { auditPlugin } from '../services/audit';
import { sessionsPlugin } from '../services/sessions';
import { attachmentsPlugin } from '../services/attachments';
import { Checkpoints } from '../services/checkpoints';
import { usagePlugin } from '../services/usage';
import { tasksPlugin } from '../services/tasks';
import { toolsPlugin } from '../services/tools';
import { catalogPlugin } from '../services/catalog';
import { commandsPlugin } from '../services/commands';
import { tavernPlugin } from 'comonad-plugin-tavern/services/tavern';
import { loreToolPlugin } from 'comonad-plugin-tavern/tools/tavern';
import { llmPlugin } from '../services/llm';
import { hooksPlugin } from '../services/hooks';
import { approvalPlugin } from '../services/approval';
import { agentPlugin } from '../services/agent';

/**
 * A headless Cordis kernel for tests: the real services on a temporary storage root,
 * with a fake Host. No vscode, no network.
 */

export interface FakeHost extends Host {
	values: Record<string, unknown>;
	/** The environment the kernel sees; tests set a provider key here. */
	envValues: Record<string, string>;
	/** The secrets the kernel sees; tests seed legacy keys here. */
	secretValues: Map<string, string>;
	/** What the gate believes about the host; `'bwrap'` keeps CI (which has no sandbox) deterministic. */
	sandboxValue: SandboxKind;
	/** Set to `'ssh-remote'` and the like to exercise remote-aware surfaces. */
	remoteValue?: string;
}

export interface TestKernel {
	ctx: Context;
	root: string;
	host: FakeHost;
	dispose(): Promise<void>;
}

export function fakeHost(root: string, values: Record<string, unknown>, workspace = ''): FakeHost {
	const secrets = new Map<string, string>();
	// Empty on purpose: a machine with DEEPSEEK_API_KEY exported must not change what tests see.
	const envValues: Record<string, string> = {};
	const host: FakeHost = {
		values,
		storage: hostStorage(root),
		extensionUri: undefined,
		home: () => join(root, 'home'),
		workspace: () => workspace,
		trusted: () => true,
		config: () => values,
		update: async (key, value) => {
			values[key] = value;
		},
		secret: async (id) => secrets.get(id),
		setSecret: async (id, value) => void secrets.set(id, value),
		deleteSecret: async (id) => void secrets.delete(id),
		env: (name) => envValues[name],
		remoteName: () => host.remoteValue,
		sandboxKind: () => host.sandboxValue,
		envValues,
		secretValues: secrets,
		sandboxValue: 'bwrap',
		ask: async () => [],
		notify: () => undefined,
	};
	return host;
}

/**
 * A headless kernel. `skip` leaves a *feature* plugin out of the tree, which is how a test asks the
 * question a user asks with `cordis.yml`: does everything else still work without it?
 */
export async function createTestKernel(
	options: { config?: Record<string, unknown>; skip?: Array<'checkpoints' | 'tavern' | 'lore'> } = {},
): Promise<TestKernel> {
	const root = mkdtempSync(join(tmpdir(), 'comonad-'));
	const workspace = join(root, 'ws');
	mkdirSync(workspace, { recursive: true });
	const values: Record<string, unknown> = {
		mode: 'sw',
		approval: 'universal_accept',
		network: false,
		workingDirectory: workspace,
		commandTimeout: 30,
		commandTimeoutOverride: false,
		denyReadPaths: [],
		maxSteps: 12,
		checkpoints: false,
		instructions: false,
		memory: false,
		skills: true,
		graph: '',
		model: 'auto',
		profiles: [],
		mcpServers: {},
		permissions: { allow: [], ask: [], deny: [] },
		contextForm: 'rendered',
		displayForm: 'rendered',
		toolCard: 'collapsed',
		reasoningEffort: 'auto',
		contextWindow: 0,
		budgetUsd: 0,
		filterSensitiveEnv: true,
		allowFullAccess: true,
		chatWindow: false,
		...options.config,
	};
	const host = fakeHost(root, values, workspace);
	const ctx = new Context();
	let ready!: () => void;
	const readyPromise = new Promise<void>((resolve) => {
		ready = resolve;
	});
	// The gate activates only once every service below is ACTIVE, so tests can
	// access ctx.<service> right after createTestKernel() resolves.
	function waitForServices(): void {
		ready();
	}
	const skipped = new Set<string>(options.skip ?? []);
	waitForServices.inject = [
		'host',
		'settings',
		'sessions',
		'attachments',
		'checkpoints',
		'tools',
		'llm',
		'hooks',
		'catalog',
		'tavern',
		'vectors',
		'tokenizers',
		'usage',
		'tasks',
		'approval',
		'audit',
		'log',
		'commands',
		'agent',
		// `vectors` arrives with the tavern that mounts it, so it waits with it and is skipped with it.
	].filter((name) => !skipped.has(name) && (name !== 'vectors' || !skipped.has('tavern')));
	const fiber: Fiber & PromiseLike<Fiber> = ctx.plugin(function kernel(child: Context) {
		child.provide('host', host);
		child.plugin(logPlugin);
		child.plugin(settingsPlugin);
		child.plugin(auditPlugin);
		child.plugin(sessionsPlugin);
		child.plugin(attachmentsPlugin);
		if (!skipped.has('checkpoints')) {
			child.plugin(Checkpoints);
		}
		child.plugin(usagePlugin);
		child.plugin(tasksPlugin);
		child.plugin(toolsPlugin);
		child.plugin(catalogPlugin);
		// The tavern brings its own vectors along: the vector side of world info is its business.
		if (!skipped.has('tavern')) {
			child.plugin(tavernPlugin);
		}
		child.plugin(commandsPlugin);
		child.plugin(tokenizersPlugin);
		if (!skipped.has('lore')) {
			child.plugin(loreToolPlugin);
		}
		child.plugin(llmPlugin);
		child.plugin(hooksPlugin);
		child.plugin(approvalPlugin);
		child.plugin(agentPlugin);
		child.plugin(waitForServices);
	});
	await fiber;
	await readyPromise;
	return {
		ctx,
		root,
		host,
		async dispose() {
			await fiber.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
