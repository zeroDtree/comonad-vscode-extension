/** Domain types shared by the agent kernel. This module must not import `vscode` or `cordis`. */

/** Work modes, least capable first: chat only, then reads, writes and a full shell, then plan files. */
export type WorkMode = 'chat' | 'ro' | 'sw' | 'aw' | 'pl';

export type Approval = 'manual' | 'universal_reject' | 'blacklist_reject' | 'whitelist_accept' | 'universal_accept';

/** Thinking effort forwarded to models that support it. */
export type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'high';

export type Preset = 'ask' | 'plan' | 'auto' | 'readonly' | 'full';

export type Capability = 'ro' | 'rw' | 'rw_plan' | 'shell_ro' | 'shell_rw';

export interface ToolCall {
	id: string;
	name: string;
	arguments: string;
	/**
	 * What an endpoint wants sent back *with* this call, verbatim. Google's OpenAI-compatible layer
	 * puts the thought signature of its thinking models in `extra_content.google.thought_signature`, and
	 * Gemini 3 refuses the next request without it; no other endpoint reads the field at all.
	 */
	extraContent?: Record<string, unknown>;
}

export interface Message {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	reasoning?: string;
	toolCalls?: ToolCall[];
	toolCallId?: string;
	/** When the message was recorded; the UI groups messages into turns with it. */
	at?: number;
	/** When the request that produced this message was sent, so the step can report its duration. */
	startedAt?: number;
	/** A character's opening line: the one assistant message that has no prompt behind it. */
	greeting?: true;
	/** A reply that continues the one before it (`/continue`) rather than answering a new prompt. */
	continued?: true;
	/**
	 * Every variant of this reply, the way SillyTavern keeps them: `content` is the active one, so the
	 * wire format and the scan read the same text the reader sees. Absent until something is swiped.
	 */
	swipes?: string[];
	swipeId?: number;
	/** One record per variant, upstream's `swipe_info` (only the fields a transcript can know). */
	swipeInfo?: SwipeInfo[];
}

/** What produced one swipe, in SillyTavern's own field names. */
export interface SwipeInfo {
	send_date?: string;
	gen_started?: number | null;
	gen_finished?: number | null;
	extra?: { gen_id?: number; api?: string; model?: string };
}

export interface SessionPolicy {
	workMode: WorkMode;
	approval: Approval;
	network: boolean;
	workingDirectory: string;
	commandTimeout: number;
	denyReadPaths: string[];
	/** Workspace-relative folder for plan files; empty uses `.comonad/plans`. */
	planDirectory?: string;
	/** Model profile id, or `auto` for the first configured profile. */
	model: string;
	temperature?: number;
	maxTokens?: number;
}

export interface TodoItem {
	text: string;
	status: 'pending' | 'in_progress' | 'completed';
}

export interface BackgroundTask {
	id: string;
	command: string;
	cwd: string;
	startedAt: number;
	output: string;
	exitCode: number | null;
}

export interface TaskApi {
	start(command: string, cwd: string): BackgroundTask;
	read(id: string, tail?: number): string;
	stop(id: string): boolean;
	list(): BackgroundTask[];
}

export type AskFunction = (question: string, options?: string[], multi?: boolean) => Promise<string[]>;

export interface AgentSpawnRequest {
	prompt: string;
	description?: string;
	agent?: string;
	background?: boolean;
	/** Share the parent conversation context instead of starting fresh. */
	fork?: boolean;
	signal: AbortSignal;
}

export type AgentSpawnFunction = (request: AgentSpawnRequest) => Promise<string>;

export interface ToolContext {
	sessionId: string;
	workspace: string;
	policy: SessionPolicy;
	signal: AbortSignal;
	/** Streams a progress note to the UI. */
	log(text: string): void;
	ask: AskFunction;
	todos(items?: TodoItem[]): TodoItem[];
	tasks: TaskApi;
	spawnAgent: AgentSpawnFunction;
	/** Remove secret-shaped environment variables from spawned commands. Defaults to true. */
	sensitiveEnv?: boolean;
	/**
	 * Journal a write to one workspace file: its content before and after `write` runs. Every file
	 * tool writes through this, so the per-file checkpoints see each change the agent makes.
	 */
	edit?(path: string, write: () => Promise<void>): Promise<void>;
}

export interface JsonSchema {
	type: 'object';
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
}

export interface ToolSpec {
	name: string;
	description: string;
	parameters: JsonSchema;
	capability: Capability;
	needsNetwork: boolean;
	needsWorkspace: boolean;
	execute(args: unknown, ctx: ToolContext): Promise<string>;
}

export function objectSchema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
	return { type: 'object', properties, required, additionalProperties: false };
}

export function hasWorkspace(policy: Pick<SessionPolicy, 'workingDirectory'>): boolean {
	return policy.workingDirectory.trim() !== '';
}

export interface CompletionUsage {
	input: number;
	output: number;
	/** Input tokens the provider served from its prompt cache, billed at a lower rate. */
	cached?: number;
}

/** A chat surface that can answer approvals: the panel, the participant, or the default modal. */
export interface TurnRef {
	sessionId: string;
	/** Identifies the surface that started the turn; events and approvals are routed by it. */
	surface?: string;
}

export type ApprovalDecision = 'allow' | 'always' | 'deny';

export interface ApprovalRequest {
	calls: ToolCall[];
	reason: string;
	surface?: string;
}
