import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from 'cordis';
import { hostStorage, type Host } from '../services/host';
import { tokenizersPlugin } from '../services/tokenizers';
import { logPlugin } from '../services/log';
import { settingsPlugin } from '../services/settings';
import { auditPlugin } from '../services/audit';
import { sessionsPlugin } from '../services/sessions';
import { checkpointsPlugin } from '../services/checkpoints';
import { usagePlugin } from '../services/usage';
import { tasksPlugin } from '../services/tasks';
import { toolsPlugin } from '../services/tools';
import { catalogPlugin } from '../services/catalog';
import { commandsPlugin } from '../services/commands';
import { tavernPlugin } from '../services/tavern';
import { vectorsPlugin } from '../services/vectors';
import { loreToolPlugin } from '../tools/tavern';
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
	return {
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
		env: (name) => envValues[name],
		envValues,
		ask: async () => [],
		notify: () => undefined,
	};
}

export async function createTestKernel(options: { config?: Record<string, unknown> } = {}): Promise<TestKernel> {
	const root = mkdtempSync(join(tmpdir(), 'comonad-'));
	const workspace = join(root, 'ws');
	mkdirSync(workspace, { recursive: true });
	const values: Record<string, unknown> = {
		mode: 'sw',
		approval: 'universal_accept',
		network: false,
		workingDirectory: workspace,
		commandTimeout: 30,
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
		reasoningEffort: 'auto',
		contextLimit: 0,
		autoCompactChars: 0,
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
	waitForServices.inject = ['host', 'settings', 'sessions', 'checkpoints', 'tools', 'llm', 'hooks', 'catalog', 'tavern', 'vectors', 'tokenizers', 'usage', 'tasks', 'approval', 'audit', 'log', 'commands', 'agent'];
	const fiber: Fiber & PromiseLike<Fiber> = ctx.plugin(function kernel(child: Context) {
		child.provide('host', host);
		child.plugin(logPlugin);
		child.plugin(settingsPlugin);
		child.plugin(auditPlugin);
		child.plugin(sessionsPlugin);
		child.plugin(checkpointsPlugin);
		child.plugin(usagePlugin);
		child.plugin(tasksPlugin);
		child.plugin(toolsPlugin);
		child.plugin(catalogPlugin);
		child.plugin(tavernPlugin);
		child.plugin(vectorsPlugin);
		child.plugin(commandsPlugin);
		child.plugin(tokenizersPlugin);
		child.plugin(loreToolPlugin);
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
