// SPDX-License-Identifier: AGPL-3.0-only
/** Domain types shared by the agent kernel. This module must not import `vscode` or `cordis`. */

import type {
	AttachmentPart,
	DocumentAttachment,
	ImageAttachment,
	ImageMime,
	JsonSchema,
	SourceRange,
	TextAttachment,
	ToolCall,
	ToolDeclaration,
	UsageRecord,
} from '@comonad/model';
import type { ToolAuthorization } from './authorization';
import type { BudgetInput, BudgetLimits, BudgetReport } from './budget';
import type { PolicyStep, RuleSet } from './policy';
import type { SandboxMode, SandboxOptions } from './sandbox';
import type { AgentEvidence, TaskGraphAccess } from './task-graph';

export type { SandboxMode } from './sandbox';

// The conversation message model is the model runtime's vocabulary; @comonad/model owns it
// and this module re-exports it for the kernel and the plugins that import `@comonad/lib/types`.
export type {
	AttachmentPart,
	DocumentAttachment,
	ImageAttachment,
	ImageMime,
	ImagePart,
	JsonSchema,
	Message,
	ReasoningEffort,
	SourceRange,
	SwipeInfo,
	TextAttachment,
	ToolCall,
	UsageRecord,
} from '@comonad/model';

/** The pre-rename name for {@link UsageRecord}; swept when the old LLM layer goes. */
export type CompletionUsage = UsageRecord;

/** Work modes, least capable first: chat only, then reads, writes and a full shell, then plan files. */
export type WorkMode = 'chat' | 'ro' | 'sw' | 'aw' | 'plan';

/** The tool approval policy: what happens to a call no user rule matched. */
export type Approval = 'manual' | 'universal_reject' | 'blacklist_reject' | 'whitelist_accept' | 'universal_accept';

/** The approval response policy: who answers the requests the approval policy raised. */
export type ApprovalResponse = 'ask' | 'never';

export type Capability = 'ro' | 'ro_plan' | 'rw' | 'rw_plan' | 'shell_ro' | 'shell_test' | 'shell_rw';

export type AttachmentMime = ImageMime | 'application/pdf';

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

/**
 * One automatic fold, remembered for the chat surface. It is not a transcript message: `anchor` is
 * the canonical transcript length when the fold finished, so grouping puts the marker back inside
 * the turn where it happened — live and after a reload alike.
 */
export interface TurnNote {
	/** Canonical transcript length when the fold finished: the marker's place in the chat. */
	anchor: number;
	at: number;
	version: number;
	/** Messages this fold newly added to the summary. */
	folded: number;
	/** Messages the summary covers in total at this point. */
	covers: number;
	before: number;
	after: number;
	window: number;
	/** The summary produced by this fold, for the card body. */
	summary: string;
}

/** Structured detail beside an `agent/notice` line; a surface may draw a card instead. */
export interface NoticeDetail {
	kind: 'compaction';
	note: TurnNote;
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

export interface SessionPolicy {
	/** The selected mode. It caps the effective capability set; `capabilities` is the effective subset the gate enforces. */
	workMode: WorkMode;
	/** The effective capability set, never wider than `MODE_CAPS[workMode]`. Absent means the mode's full set. */
	capabilities?: Capability[];
	/** The effective user rules. Absent falls back to the global settings. */
	rules?: RuleSet;
	/** A delegated agent's tool allowlist. Absent means every visible tool is allowed. */
	tools?: string[];
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
	/** The four native run budgets for this session; absent means unlimited. */
	budget?: BudgetLimits;
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
	/** Resolve the role from the code-owned built-in table, not the editable catalog (acceptance). */
	pinned?: boolean;
	/** The task graph node this child is running; identifies the sender in the mailbox. */
	taskId?: string;
	/** Worker or verifier output contract in the child system prompt. */
	contract?: 'worker' | 'verifier';
	/** Further narrow the role's capability set; never widens it. */
	capabilities?: Capability[];
	/** `false` turns network off; `true` or absent inherits, and never turns it on. */
	network?: boolean;
	/** A sandbox ceiling; the child gets the stricter of this and the parent's sandbox. */
	sandboxMode?: SandboxMode;
	/** The child's own tool approval policy; absent inherits the parent's. */
	approval?: Approval;
	/** A per-task budget; each dimension can only tighten the role/global defaults. */
	budget?: BudgetInput;
	/** Continue an existing child session from its transcript instead of creating a new one. */
	resumeSessionId?: string;
	/** The parent's tool call, so its card can link to the child session. */
	callId?: string;
	/** Called as soon as the child session exists, before the graph starts. */
	onStart?: (sessionId: string) => void;
	/**
	 * Validates the child's final report. The child gets exactly one repair round in its own session
	 * when this returns an error; the error text is shown to the child.
	 */
	checkReport?: (report: string) => string | null;
	signal: AbortSignal;
}

export interface AgentSpawnOutcome {
	/** The child produced a usable final report (not paused, stopped or errored). */
	ok: boolean;
	/** The child's final assistant text, unmodified (the structured envelope lives here). */
	report: string;
	/** Workspace-relative files the child wrote through tracked tools. */
	writes: string[];
	sessionId?: string;
	stopped?: boolean;
	error?: string;
	/** A native budget stopped the run; the report is the partial output. */
	paused?: boolean;
	/** The budget report for this run segment. */
	budget?: BudgetReport;
	/** The last tool the child attempted, useful when a budget cut it off. */
	lastTool?: string;
	/** `checkReport` still rejected the report after the one repair round. */
	contractError?: string;
	/** Shell commands the runtime observed in the child transcript, with their real exit codes. */
	observedCommands?: AgentEvidence[];
}

export type AgentSpawnFunction = (request: AgentSpawnRequest) => Promise<AgentSpawnOutcome>;

export interface ToolContext {
	sessionId: string;
	/** The chat that owns this run's plan files and journal; a subagent's own session is `sub-…`. */
	rootSessionId?: string;
	/** The tool call being dispatched, when known; a spawned subagent links its session to it. */
	callId?: string;
	/** The orchestration task this child is running, when known. */
	taskId?: string;
	/** The subagent role, for the message tool's sender identity. */
	agentName?: string;
	/** The turn's tool batch, which the authorization is bound to. */
	batch: number;
	/** The gate-issued, single-use grant for this call; the executor refuses a call without one. */
	authorization?: ToolAuthorization;
	workspace: string;
	policy: SessionPolicy;
	signal: AbortSignal;
	/** Streams a progress note to the UI. */
	log(text: string): void;
	ask: AskFunction;
	todos(items?: TodoItem[]): TodoItem[];
	tasks: TaskApi;
	spawnAgent: AgentSpawnFunction;
	/** The root Orchestrator's live task-graph accessor; absent in a child session. */
	taskGraph?: TaskGraphAccess;
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
	/** Append one execution-gate decision to this call's decision trace. */
	traceStep?(step: PolicyStep): void;
	/** Write this call's terminal denial; the trace service ignores a second terminal. */
	traceDenied?(reason: string): void;
	/** Append the sandbox step and write `dispatch_started`, just before the tool body runs. */
	traceDispatch?(reason: string): void;
}

export interface ToolSpec extends ToolDeclaration {
	capability: Capability;
	needsNetwork: boolean;
	needsWorkspace: boolean;
	/** Never run in the read-only parallel batch: it mutates shared state (the task graph). */
	serial?: boolean;
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

/** One `ask_user` question, before a surface renders it. */
export interface QuestionRequest {
	question: string;
	options?: string[];
	multi?: boolean;
	/** The chat that owns the request; a surface shows the card only for that chat. */
	sessionId: string;
	/** The turn's surface id; absent for child runs and surfaces without a UI. */
	surface?: string;
	/** The turn's cancellation: an aborted request resolves with no answer. */
	signal: AbortSignal;
}
