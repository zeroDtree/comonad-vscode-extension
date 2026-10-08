import { spawn } from 'node:child_process';
import { Service, type Context, type Fiber } from 'cordis';
import type { Capability, ToolSpec } from '../lib/types';
import { describe } from '../lib/util';
import type { McpServerSettings } from './settings';

/**
 * Minimal MCP client (stdio + streamable HTTP) with no external dependency.
 * Each reload disposes the previous server tree and mounts a fresh one; tools are
 * registered through `ctx.tools`, so the normal policy gate applies and unloads cleanly.
 */

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpStatus {
	name: string;
	connected: boolean;
	tools: number;
	error?: string;
}

interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	result?: unknown;
	error?: { code: number; message: string };
}

interface Transport {
	send(message: Record<string, unknown>): void;
	handler: (message: RpcMessage) => void;
	close(): void;
}

class StdioTransport implements Transport {
	handler: (message: RpcMessage) => void = () => {};
	private buffer = '';
	private readonly child;

	constructor(command: string, args: string[], env: Record<string, string>, cwd: string) {
		this.child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
		this.child.stdout.setEncoding('utf8');
		this.child.stdout.on('data', (chunk: string) => {
			this.buffer += chunk;
			let index = this.buffer.indexOf('\n');
			while (index >= 0) {
				const line = this.buffer.slice(0, index).trim();
				this.buffer = this.buffer.slice(index + 1);
				if (line) {
					try {
						this.handler(JSON.parse(line) as RpcMessage);
					} catch {
						// ignore malformed lines
					}
				}
				index = this.buffer.indexOf('\n');
			}
		});
		this.child.stderr.setEncoding('utf8');
		this.child.stderr.on('data', () => undefined);
		this.child.on('error', () => undefined);
	}

	send(message: Record<string, unknown>): void {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	close(): void {
		this.child.kill();
	}
}

class HttpTransport implements Transport {
	handler: (message: RpcMessage) => void = () => {};
	private session: string | undefined;

	constructor(private readonly url: string, private readonly headers: Record<string, string>, private readonly timeoutMs: number) {}

	send(message: Record<string, unknown>): void {
		void this.deliver(message);
	}

	private async deliver(message: Record<string, unknown>): Promise<void> {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			...this.headers,
		};
		if (this.session) {
			headers['mcp-session-id'] = this.session;
		}
		try {
			const response = await fetch(this.url, {
				method: 'POST',
				headers,
				body: JSON.stringify(message),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			const session = response.headers.get('mcp-session-id');
			if (session) {
				this.session = session;
			}
			if (!response.ok) {
				return;
			}
			const type = response.headers.get('content-type') ?? '';
			const text = await response.text();
			if (!text.trim()) {
				return;
			}
			const messages = type.includes('text/event-stream') ? parseSse(text) : parseJsonMessages(text);
			for (const item of messages) {
				this.handler(item);
			}
		} catch {
			// network errors surface through request timeouts
		}
	}

	close(): void {
		this.session = undefined;
	}
}

function parseJsonMessages(text: string): RpcMessage[] {
	try {
		return [JSON.parse(text) as RpcMessage];
	} catch {
		return [];
	}
}

function parseSse(text: string): RpcMessage[] {
	const messages: RpcMessage[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('data:')) {
			continue;
		}
		try {
			messages.push(JSON.parse(trimmed.slice(5).trim()) as RpcMessage);
		} catch {
			// ignore malformed events
		}
	}
	return messages;
}

export class McpConnection {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

	private constructor(private readonly transport: Transport, private readonly timeoutMs: number) {
		transport.handler = (message) => this.route(message);
	}

	static async connect(settings: McpServerSettings, cwd: string): Promise<McpConnection> {
		const timeoutMs = settings.timeoutMs && settings.timeoutMs > 0 ? settings.timeoutMs : 30_000;
		let transport: Transport;
		if (settings.url) {
			transport = new HttpTransport(settings.url, settings.headers ?? {}, timeoutMs);
		} else if (settings.command) {
			transport = new StdioTransport(settings.command, settings.args ?? [], settings.env ?? {}, cwd);
		} else {
			throw new Error('server needs command or url');
		}
		const connection = new McpConnection(transport, timeoutMs);
		await connection.request('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'comonad', version: '0.2.0' },
		});
		connection.notify('notifications/initialized', {});
		return connection;
	}

	async listTools(): Promise<McpToolInfo[]> {
		const result = (await this.request('tools/list', {})) as { tools?: McpToolInfo[] };
		return result.tools ?? [];
	}

	async callTool(name: string, args: unknown): Promise<string> {
		const result = (await this.request('tools/call', { name, arguments: args ?? {} })) as {
			content?: { type?: string; text?: string }[];
			isError?: boolean;
			structuredContent?: unknown;
		};
		const parts: string[] = [];
		for (const item of result.content ?? []) {
			if (typeof item.text === 'string') {
				parts.push(item.text);
			}
		}
		if (result.structuredContent !== undefined) {
			parts.push(JSON.stringify(result.structuredContent));
		}
		const text = parts.join('\n') || '(no output)';
		return result.isError ? `Error: ${text}` : text;
	}

	close(): void {
		for (const waiter of this.pending.values()) {
			waiter.reject(new Error('connection closed'));
		}
		this.pending.clear();
		this.transport.close();
	}

	private route(message: RpcMessage): void {
		if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
			const waiter = this.pending.get(message.id);
			if (!waiter) {
				return;
			}
			this.pending.delete(message.id);
			if (message.error) {
				waiter.reject(new Error(message.error.message));
			} else {
				waiter.resolve(message.result);
			}
			return;
		}
		if (message.method && message.id !== undefined) {
			this.transport.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not supported' } });
		}
	}

	private request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, this.timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolvePromise(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.transport.send({ jsonrpc: '2.0', id, method, params });
		});
	}

	private notify(method: string, params: Record<string, unknown>): void {
		this.transport.send({ jsonrpc: '2.0', method, params });
	}
}

interface ServerState {
	settings: McpServerSettings;
	connection?: McpConnection;
	tools: number;
	error?: string;
}

declare module 'cordis' {
	interface Context {
		mcp: Mcp;
	}
}

export class Mcp extends Service {
	static inject = ['settings', 'tools', 'log'];

	private fiber: Fiber | undefined;
	private readonly state = new Map<string, ServerState>();

	constructor(ctx: Context) {
		super(ctx, 'mcp');
		ctx.effect(() => () => void this.fiber?.dispose());
	}

	/** Disposes the current server tree and mounts a fresh one from settings. */
	async reload(): Promise<void> {
		const previous = this.fiber;
		this.fiber = undefined;
		await previous?.dispose();
		this.state.clear();
		this.fiber = this.ctx.plugin(mcpServers, { owner: this });
	}

	status(): McpStatus[] {
		return [...this.state.entries()].map(([name, entry]) => ({
			name,
			connected: Boolean(entry.connection) && !entry.error,
			tools: entry.tools,
			error: entry.error,
		}));
	}

	async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
		const entry = this.state.get(server);
		if (!entry?.connection) {
			throw new Error(`MCP server ${server} is not connected`);
		}
		return entry.connection.callTool(tool, args);
	}

	/** @internal called by the mounted server plugins */
	expect(name: string, settings: McpServerSettings): void {
		this.state.set(name, { settings, tools: 0 });
	}

	/** @internal */
	attach(name: string, connection: McpConnection, tools: number): void {
		const entry = this.state.get(name);
		if (entry) {
			entry.connection = connection;
			entry.tools = tools;
		}
		this.ctx.emit('tools/changed');
	}

	/** @internal */
	fail(name: string, message: string): void {
		const entry = this.state.get(name) ?? { settings: {}, tools: 0 };
		entry.error = message;
		this.state.set(name, entry);
	}
}

export const mcpPlugin = Mcp;

interface ServerConfig {
	name: string;
	settings: McpServerSettings;
	owner: Mcp;
}

function mcpServers(ctx: Context, config: { owner: Mcp }): void {
	const servers = ctx.settings.get().mcpServers;
	for (const [name, settings] of Object.entries(servers)) {
		if (settings.enabled === false) {
			continue;
		}
		config.owner.expect(name, settings);
		ctx.plugin(mcpServer, { name, settings, owner: config.owner });
	}
}
mcpServers.inject = ['settings'];

async function mcpServer(ctx: Context, config: ServerConfig): Promise<void> {
	const { name, settings, owner } = config;
	try {
		const connection = await McpConnection.connect(settings, ctx.settings.workspace());
		if (ctx.fiber.uid === null) {
			connection.close();
			return;
		}
		ctx.effect(() => () => connection.close());
		const tools = await connection.listTools();
		if (ctx.fiber.uid === null) {
			return;
		}
		owner.attach(name, connection, tools.length);
		const excluded = new Set(settings.exclude ?? []);
		for (const tool of tools) {
			if (excluded.has(tool.name)) {
				continue;
			}
			ctx.tools.register(mcpToolSpec(name, settings, connection, tool));
		}
		ctx.log.message(`mcp ${name}: ${tools.length} tools`);
	} catch (error) {
		const message = describe(error);
		owner.fail(name, message);
		ctx.log.message(`mcp ${name} failed: ${message}`);
	}
}
mcpServer.inject = ['settings', 'tools', 'log'];

function mcpToolSpec(server: string, settings: McpServerSettings, connection: McpConnection, tool: McpToolInfo): ToolSpec {
	const override = settings.overrides?.[tool.name];
	const capability: Capability = override?.capability ?? ((settings.writeTools ?? []).includes(tool.name) ? 'rw' : settings.capability ?? 'ro');
	const needsNetwork = override?.needsNetwork ?? Boolean(settings.url);
	return {
		name: `${sanitize(server)}__${sanitize(tool.name)}`,
		description: tool.description ?? `${tool.name} (MCP server ${server})`,
		parameters: asSchema(tool.inputSchema),
		capability,
		needsNetwork,
		needsWorkspace: false,
		execute: (args) => connection.callTool(tool.name, args),
	};
}

function asSchema(input: Record<string, unknown> | undefined): ToolSpec['parameters'] {
	if (input && typeof input === 'object' && (input as { type?: unknown }).type === 'object') {
		return input as unknown as ToolSpec['parameters'];
	}
	return { type: 'object', properties: {}, additionalProperties: true };
}

function sanitize(value: string): string {
	return value.replace(/[^\w-]/g, '_');
}
