// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from 'cordis';
import {
	makeFakeProtocol,
	type Disposable,
	type Message,
	type ToolCall,
	type UsageRecord,
} from '@comonad/model';
import { DEFAULT_COMPACTION_RETAIN_PERCENT } from '../lib/prompt';
import type { SandboxKind } from '../lib/sandbox';
import { defaultWriteScope, type SettingsScope } from '../lib/settings-file';
import { hostStorage, type Host } from '../services/host';
import { tokenizersPlugin } from '../services/tokenizers';
import { logPlugin } from '../services/log';
import { settingsPlugin } from '../services/settings';
import { auditPlugin } from '../services/audit';
import { decisionsPlugin } from '../services/decisions';
import { sessionsPlugin } from '../services/sessions';
import { attachmentsPlugin } from '../services/attachments';
import { referencesPlugin } from '../services/references';
import { Checkpoints } from '../services/checkpoints';
import { usagePlugin } from '../services/usage';
import { tasksPlugin } from '../services/tasks';
import { toolsPlugin } from '../services/tools';
import { catalogPlugin } from '../services/catalog';
import { commandsPlugin } from '../services/commands';
import { modelPlugin } from '../services/model';
import { hooksPlugin } from '../services/hooks';
import { approvalPlugin } from '../services/approval';
import { graphPlugin } from '../services/graph';
import { mailboxPlugin } from '../services/mailbox';
import { orchestratorPlugin } from '../services/orchestrator';
import { agentPlugin } from '../services/agent';

/**
 * A headless Cordis kernel for tests: the real services on a temporary storage root,
 * with a fake Host. No vscode, no network.
 */

export interface FakeHost extends Host {
	/** The user's own settings layer; tests mutate this directly. */
	values: Record<string, unknown>;
	/** The workspace layer, merged over the user layer. */
	workspaceValues: Record<string, unknown>;
	/** Every scoped write, so a test can assert where the panel put a key. */
	writes: Array<{ key: string; value: unknown; scope: SettingsScope }>;
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

/** What a scripted model sees per call, and the stream taps it may push. */
export interface FakeModelCall {
	model: string;
	messages: Message[];
	tools: { name: string }[];
	signal: AbortSignal;
	reasoningEffort?: string;
	temperature?: number;
	maxTokens?: number;
	emit(text: string): void;
	emitReasoning(text: string): void;
	emitTool(call: ToolCall): void;
}

export interface FakeModel {
	name?: string;
	chat(request: FakeModelCall): Promise<{ message?: Message; toolCalls?: ToolCall[]; usage?: UsageRecord; finish?: 'stop' | 'tool_calls' | 'length' | 'aborted' }>;
	/** Answer per endpoint: every instance's listing reaches here with its resolved base URL. */
	listModels?(base: string): Promise<string[]>;
}

/**
 * Registers a scripted model on the kernel through the same protocol seam real brands use,
 * so a test's fake exercises the whole runtime path (retry guards, notices, usage) around it.
 */
export function useFakeModel(kernel: TestKernel, fake: FakeModel): Disposable {
	// The fake replaces every shipped wire outright — the old adapter seam's semantics —
	// so every configured instance routes to the script, brands and their facts included.
	const definition = makeFakeProtocol({
			id: 'openai-chat',
			handler: async (call, emit) => {
				const outcome = await fake.chat({
					model: call.model,
					messages: call.messages,
					tools: call.tools,
					signal: call.ctx.signal,
					reasoningEffort: typeof call.options.reasoningEffort === 'string' ? call.options.reasoningEffort : undefined,
					temperature: typeof call.options.temperature === 'number' ? call.options.temperature : undefined,
					maxTokens: typeof call.options.maxTokens === 'number' ? call.options.maxTokens : undefined,
					emit: (text) => emit({ type: 'text', text }),
					emitReasoning: (text) => emit({ type: 'reasoning', text }),
					emitTool: (tool) => emit({ type: 'tool-call', call: tool }),
				});
				return { ...outcome, finish: outcome.finish ?? (outcome.toolCalls?.length ? 'tool_calls' : 'stop') };
			},
			listModels: fake.listModels ? (_ctx, provider) => fake.listModels!(provider.baseURL) : undefined,
		}).definition;
	const disposables = ['openai-chat', 'anthropic-messages', 'gemini'].map((id) =>
		kernel.ctx.model.registerProtocol({ ...definition, id }),
	);
	return {
		dispose: () => {
			for (const disposable of disposables) {
				disposable.dispose();
			}
		},
	};
}

export function fakeHost(root: string, values: Record<string, unknown>, workspace = ''): FakeHost {
	const secrets = new Map<string, string>();
	// Empty on purpose: a machine with DEEPSEEK_API_KEY exported must not change what tests see.
	const envValues: Record<string, string> = {};
	const workspaceValues: Record<string, unknown> = {};
	const writes: FakeHost['writes'] = [];
	const store = (scope: SettingsScope): Record<string, unknown> => {
		if (scope === 'workspace') {
			if (!workspace) {
				throw new Error('Open a workspace folder before using workspace settings.');
			}
			return workspaceValues;
		}
		return values;
	};
	const host: FakeHost = {
		values,
		workspaceValues,
		writes,
		storage: hostStorage(root),
		extensionUri: undefined,
		home: () => join(root, 'home'),
		workspace: () => workspace,
		trusted: () => true,
		config: () => ({ ...values, ...workspaceValues }),
		update: async (key, value, scope) => {
			const target = scope ?? defaultWriteScope(key, workspaceValues);
			store(target)[key] = value;
			writes.push({ key, value, scope: target });
		},
		settingsPath: (scope) =>
			scope === 'workspace' ? (workspace ? join(workspace, '.comonad', 'settings.json') : '') : join(root, 'home', '.comonad', 'settings.json'),
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
	options: { config?: Record<string, unknown>; skip?: Array<'checkpoints'> } = {},
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
		budget: { turns: 12, tools: 0, tokens: 0, milliseconds: 0 },
		subagentBudget: { turns: 24, tools: 100, tokens: 0, milliseconds: 0 },
		subagentBudgetMode: 'custom',
		checkpoints: false,
		instructions: false,
		memory: false,
		skills: true,
		graph: '',
		model: 'auto',
		providers: {},
		mcpServers: {},
		permissions: { allow: [], ask: [], deny: [] },
		contextForm: 'rendered',
		displayForm: 'rendered',
		toolCard: 'collapsed',
		reasoningEffort: 'auto',
		contextWindow: 0,
		// Existing tests assert the hard-limit behavior; a test that wants proactive compaction
		// passes a positive headroom explicitly.
		compactionHeadroom: 0,
		compactionRetainPercent: DEFAULT_COMPACTION_RETAIN_PERCENT,
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
		'references',
		'checkpoints',
		'tools',
		'model',
		'hooks',
		'catalog',
		'tokenizers',
		'usage',
		'tasks',
		'approval',
		'audit',
		'decisions',
		'log',
		'commands',
		'graphs',
		'mailbox',
		'orchestrator',
		'agent',
	].filter((name) => !skipped.has(name));
	const fiber: Fiber & PromiseLike<Fiber> = ctx.plugin(function kernel(child: Context) {
		child.provide('host', host);
		child.plugin(logPlugin);
		child.plugin(settingsPlugin);
		child.plugin(auditPlugin);
		child.plugin(decisionsPlugin);
		child.plugin(sessionsPlugin);
		child.plugin(attachmentsPlugin);
		child.plugin(referencesPlugin);
		if (!skipped.has('checkpoints')) {
			child.plugin(Checkpoints);
		}
		child.plugin(usagePlugin);
		child.plugin(tasksPlugin);
		child.plugin(toolsPlugin);
		child.plugin(catalogPlugin);
		child.plugin(commandsPlugin);
		child.plugin(tokenizersPlugin);
		child.plugin(modelPlugin);
		child.plugin(hooksPlugin);
		child.plugin(approvalPlugin);
		child.plugin(graphPlugin);
		child.plugin(mailboxPlugin);
		child.plugin(orchestratorPlugin);
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
