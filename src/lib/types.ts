// SPDX-License-Identifier: AGPL-3.0-only
/** Domain types shared by the agent kernel. This module must not import `vscode` or `cordis`. */

import type { SandboxOptions } from './sandbox';

/** Work modes, least capable first: chat only, then reads, writes and a full shell, then plan files. */
export type WorkMode = 'chat' | 'ro' | 'sw' | 'aw' | 'pl';

export type Approval = 'manual' | 'universal_reject' | 'blacklist_reject' | 'whitelist_accept' | 'universal_accept';

/**
 * The thinking levels a chat can ask for. `auto` leaves the provider default alone; `none` turns
 * thinking off where the model allows it; `max` is the deepest level the endpoint offers.
 */
export type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'max';

export type Preset = 'ask' | 'plan' | 'auto' | 'readonly' | 'full';

export type Capability = 'ro' | 'rw' | 'rw_plan' | 'shell_ro' | 'shell_test' | 'shell_rw';

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

/** The image formats the readers and the OpenAI-compatible wire understand. */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/**
 * An image attached to a message. The bytes live in the content-addressed attachment store, named
 * `<sha256>.<ext>`; only that metadata is persisted. `dataUrl` is filled on a request copy and never
 * written down.
 */
export interface ImagePart {
	id: string;
	mime: ImageMime;
	name?: string;
	width?: number;
	height?: number;
	dataUrl?: string;
}

/** Raw bytes a tool hands back; the attachment store sniffs the real type. */
export interface ToolImage {
	data: Uint8Array;
	mime: ImageMime;
	name?: string;
}

/** A tool's non-text result. A bare string is still a complete answer. */
export interface ToolResult {
	content: string;
	images?: ToolImage[];
}

export interface Message {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	/** Images the message carries: a prompt's attachments, or what a tool read. */
	images?: ImagePart[];
	reasoning?: string;
	toolCalls?: ToolCall[];
	toolCallId?: string;
	/** When the message was recorded; the UI groups messages into turns with it. */
	at?: number;
	/** When the request that produced this message was sent, so the step can report its duration. */
	startedAt?: number;
	/** A character's opening line: the one assistant message that has no prompt behind it. */
	greeting?: true;
	/** A compaction's summary, which heads the transcript it stands in for. */
	summarized?: true;
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

/** What the workspace boundary applies to. `false` leaves that direction unrestricted. */
export interface Confinement {
	/** Reads outside the workspace are refused, by the file tools and inside the shell sandbox. */
	read: boolean;
	/** Writes outside the workspace are refused, by the file tools and inside the shell sandbox. */
	write: boolean;
}

export interface SessionPolicy {
	workMode: WorkMode;
	approval: Approval;
	network: boolean;
	workingDirectory: string;
	commandTimeout: number;
	/**
	 * Use the configured `commandTimeout` for every foreground shell call, ignoring a `timeout` the
	 * model asks for. Sessions stored by older builds lack it; absent reads as `false`.
	 */
	commandTimeoutOverride: boolean;
	denyReadPaths: string[];
	/** How far outside the working directory reads and writes may reach. */
	confinement: Confinement;
	/** Workspace-relative folder for plan files; empty uses `.comonad/plans`. */
	planDirectory?: string;
	/** Maximum graph steps for one turn; absent uses the compiled graph's own limit. */
	maxSteps?: number;
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
	start(command: string, cwd: string, options: SandboxOptions): Promise<BackgroundTask>;
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
	/** The parent's tool call, so its card can link to the child session. */
	callId?: string;
	signal: AbortSignal;
}

export type AgentSpawnFunction = (request: AgentSpawnRequest) => Promise<string>;

export interface ToolContext {
	sessionId: string;
	/** The tool call being dispatched, when known; a spawned subagent links its session to it. */
	callId?: string;
	workspace: string;
	policy: SessionPolicy;
	signal: AbortSignal;
	/** Streams a progress note to the UI. */
	log(text: string): void;
	ask: AskFunction;
	todos(items?: TodoItem[]): TodoItem[];
	tasks: TaskApi;
	spawnAgent: AgentSpawnFunction;
	/** The session's private scratch directory: the only place a test shell may write. */
	scratchDirectory?: string;
	/** Remove secret-shaped environment variables from spawned commands. Defaults to true. */
	sensitiveEnv?: boolean;
	/**
	 * Journal a write to one workspace file: its content before and after `write` runs. Every file
	 * tool writes through this, so the per-file checkpoints see each change the agent makes.
	 */
	edit?(path: string, write: () => Promise<void>): Promise<void>;
	/** Note that this session created the absolute workspace file `path`. */
	noteCreated?(path: string): void;
	/** Note that `path` no longer exists, dropping it and its descendants from provenance. */
	noteDeleted?(path: string): void;
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
	/**
	 * Its writes go through `ToolContext.edit`, so the journal records them. A subagent is offered a
	 * write tool only when this is true; a plugin tool that writes without the seam is not tracked and
	 * therefore not delegated.
	 */
	trackedWrite?: boolean;
	execute(args: unknown, ctx: ToolContext): Promise<string | ToolResult>;
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
	/** The turn's cancellation: an aborted request resolves deny. */
	signal: AbortSignal;
	/** The chat that owns the request; a surface shows the card only for that chat. */
	sessionId: string;
	surface?: string;
}
