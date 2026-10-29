// SPDX-License-Identifier: AGPL-3.0-only
/** Domain types shared by the agent kernel. This module must not import `vscode` or `cordis`. */

import type { SandboxMode, SandboxOptions } from './sandbox';

export type { SandboxMode } from './sandbox';

/** Work modes, least capable first: chat only, then reads, writes and a full shell, then plan files. */
export type WorkMode = 'chat' | 'ro' | 'sw' | 'aw' | 'pl';

/** The tool approval policy: what happens to a call no user rule matched. */
export type Approval = 'manual' | 'universal_reject' | 'blacklist_reject' | 'whitelist_accept' | 'universal_accept';

/** The approval response policy: who answers the requests the approval policy raised. */
export type ApprovalResponse = 'ask' | 'never';

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
export type AttachmentMime = ImageMime | 'application/pdf';

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

/** A line range for text, or a page range for a document. */
export interface SourceRange {
	start: number;
	end: number;
	unit: 'line' | 'page';
}

/** Text resolved from a reference. `origin` decides whether an edit re-resolves it. */
export interface TextAttachment {
	kind: 'text';
	origin: 'user' | 'reference';
	form: 'file' | 'folder' | 'symbol' | 'note' | 'error';
	/** A display name for a composer paste; resolved references leave it empty. */
	name?: string;
	source: { path?: string; range?: SourceRange; symbol?: string; hash?: string };
	text: string;
	truncated?: boolean;
}

/** An image attachment: composer input (`user`), an `@` reference, or a tool result. */
export interface ImageAttachment extends ImagePart {
	kind: 'image';
	origin: 'user' | 'reference' | 'tool';
}

/** PDF bytes with the text extracted for the selected pages. */
export interface DocumentAttachment {
	kind: 'document';
	origin: 'user' | 'reference';
	id: string;
	mime: 'application/pdf';
	name?: string;
	pageCount?: number;
	pages?: SourceRange;
	text?: string;
	textUnavailable?: boolean;
	truncated?: boolean;
}

export type AttachmentPart = TextAttachment | ImageAttachment | DocumentAttachment;

/**
 * The model-facing view of a compacted conversation. It never lives in the canonical transcript:
 * the agent derives a summary message from it and sends the tail after `covers`.
 */
export interface ModelContext {
	summary: string;
	/** How many messages at the head of the canonical transcript the summary represents. */
	covers: number;
	version: number;
	at: number;
	model?: string;
	/** A stable digest of the covered prefix, for diagnostics and lazy staleness checks. */
	hash?: string;
}

/** A resolved reference, in the shape a tool needs without importing the reference service. */
export interface ReferenceResolution {
	attachments: AttachmentPart[];
	notices?: string[];
	errors?: { token: string; message: string }[];
}

/** What a resolver produces; the core stamps `origin` before placing it. */
export type ResolvedPart =
	| Omit<TextAttachment, 'origin'>
	| Omit<ImageAttachment, 'origin'>
	| Omit<DocumentAttachment, 'origin'>;

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
	/** Typed context the message carries: resolved references, prompt images, or tool images. */
	attachments?: AttachmentPart[];
	reasoning?: string;
	toolCalls?: ToolCall[];
	toolCallId?: string;
	/** When the message was recorded; the UI groups messages into turns with it. */
	at?: number;
	/** When the request that produced this message was sent, so the step can report its duration. */
	startedAt?: number;
	/** A character's opening line: the one assistant message that has no prompt behind it. */
	greeting?: true;
	/** A derived model-context summary; it never lives in the canonical transcript. */
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

export interface SessionPolicy {
	workMode: WorkMode;
	approval: Approval;
	/** Who answers an approval request: a surface (`ask`) or nobody (`never`). */
	approvalResponse: ApprovalResponse;
	network: boolean;
	/** The OS-enforced read and write range every call runs under. */
	sandboxMode: SandboxMode;
	workingDirectory: string;
	commandTimeout: number;
	/**
	 * Use the configured `commandTimeout` for every foreground shell call, ignoring a `timeout` the
	 * model asks for. Sessions stored by older builds lack it; absent reads as `false`.
	 */
	commandTimeoutOverride: boolean;
	denyReadPaths: string[];
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
	/** Resolve a path through the same guards and format resolvers `@` uses. */
	resolveReference?(path: string, options?: { range?: SourceRange }): Promise<ReferenceResolution | undefined>;
	/** Remove secret-shaped environment variables from spawned commands. Defaults to true. */
	sensitiveEnv?: boolean;
	/**
	 * Journal a write to one workspace file: its content before and after `write` runs. Every file
	 * tool writes through this, so the per-file checkpoints see each change the agent makes.
	 */
	edit?(path: string, write: () => Promise<void>): Promise<void>;
	/** Note that this session created the absolute workspace file `path`. */
	noteCreated?(path: string): void;
	/** Note that this session created the absolute workspace directory `path` and its subtree. */
	noteCreatedDir?(path: string): void;
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
	 * Runs outside the OS sandbox (a VS Code task, a plugin's own process). Such a tool can only
	 * run under `danger-full-access`, because no other sandbox mode could be enforced for it.
	 */
	unsandboxed?: boolean;
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
	/** `never` rejects without reaching a surface; absent reads as `ask`. */
	response?: ApprovalResponse;
}
