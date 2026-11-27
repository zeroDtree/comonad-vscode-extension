// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The frozen vocabulary of @comonad/model: invocation context, usage and pricing,
 * the conversation message model, and the layered stream events.
 *
 * Additive, optional fields may grow this surface; removals and semantic changes
 * bump MODEL_API_VERSION.
 */

/**
 * Who is calling, and why. Every model request carries one: it is the only
 * cancellation channel into the transport, and the correlation identity that
 * survives retries and fallbacks.
 */
export interface InvocationContext {
	/** The chat this call belongs to; detached callers use a stable synthetic id. */
	conversationId: string;
	/** `` `${conversationId}:${turn}` `` — one per user-visible turn. */
	turnId: string;
	/** Caller-minted per logical model call. A runtime retry keeps the id and counts attempts. */
	requestId: string;
	signal: AbortSignal;
	/**
	 * Free-form call metadata: `kind` (`chat` | `compaction` | `soft-route` | `hook`), `surface`,
	 * `agentName`. Brands read it from header hooks (e.g. OpenCode Go's session header).
	 */
	attributes?: Record<string, string | number | boolean>;
}

/**
 * Token accounting for one request. `input` is the whole prompt the model saw, a superset
 * of `cached` (served from the provider's prompt cache) and `cacheWrite` (written into the
 * cache this request): fresh input is `input − cached − cacheWrite`. A cache field left
 * undefined means the provider reported no such statistic; 0 is a report of zero.
 */
export interface UsageRecord {
	input: number;
	output: number;
	/** Prompt-cache hits, cheaper than fresh input. Presence = "this provider reports cache". */
	cached?: number;
	/** Tokens written into the prompt cache this request (Anthropic-style cache creation). */
	cacheWrite?: number;
}

/**
 * Model prices in USD per million tokens. Any field may be absent: a model the catalog
 * never priced has no `pricing` at all and stays null-cost rather than pretending to be free.
 */
export interface Pricing {
	inPerM?: number;
	/** Absent falls back to the input price. */
	cachedInPerM?: number;
	/** Absent falls back to the input price. */
	cacheWritePerM?: number;
	outPerM?: number;
}

/** What a provider knows about one model: catalog facts merged by model id. */
export interface ModelInfo {
	id: string;
	label?: string;
	contextWindow?: number;
	maxOutput?: number;
	pricing?: Pricing;
}

/**
 * The thinking levels a chat can ask for. `auto` leaves the provider default alone; `none` turns
 * thinking off where the model allows it; `max` is the deepest level the endpoint offers.
 */
export type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'max';

export interface JsonSchema {
	type: 'object';
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
}

/** The wire-relevant shape of a tool: what the model is shown. Host tool specs extend it. */
export interface ToolDeclaration {
	name: string;
	description: string;
	parameters: JsonSchema;
}

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

/**
 * One tool-call stream update, carrying the call's accumulated state so far (the same
 * semantics every consumer of a per-delta callback has always seen).
 */
export interface ToolCallDelta {
	id: string;
	name: string;
	arguments: string;
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

/** What produced one swipe. */
export interface SwipeInfo {
	send_date?: string;
	gen_started?: number | null;
	gen_finished?: number | null;
	extra?: { gen_id?: number; api?: string; model?: string };
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
	/** A derived model-context summary; it never lives in the canonical transcript. */
	summarized?: true;
	/** A reply that continues the one before it (`/continue`) rather than answering a new prompt. */
	continued?: true;
	/**
	 * Every variant of this reply: `content` is the active one, so the wire format and the scan read
	 * the same text the reader sees. Absent until something is swiped.
	 */
	swipes?: string[];
	swipeId?: number;
	/** One record per variant (only the fields a transcript can know). */
	swipeInfo?: SwipeInfo[];
}

/** How a model request ended. */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'aborted';

/**
 * What the model produced, reported by a protocol implementation. Carries content only —
 * runtime behavior (retries, fallbacks) is a `notice` on the runtime stream, never one of these.
 */
export type ProviderStreamEvent =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'tool-call'; call: ToolCallDelta }
	| { type: 'usage'; usage: UsageRecord }
	| { type: 'finish'; reason: FinishReason };

/** Everything a consumer of the model runtime sees on a stream. */
export type RuntimeStreamEvent =
	| ProviderStreamEvent
	| { type: 'notice'; kind: 'retry' | 'fallback' | 'degraded'; message: string; attempt?: number };

/** Sampler overrides a caller sets; they win over the provider instance's own options. */
export interface ChatOptions {
	/**
	 * The wire-level thinking level. Known menu values are the {@link ReasoningEffort} ladder plus
	 * the wire-only `xhigh`; a brand may rank anything its endpoint accepts.
	 */
	reasoningEffort?: string;
	temperature?: number;
	topP?: number;
	maxTokens?: number;
}

export interface ChatRequest {
	/** `instanceId[:model]`, or `auto` for the first configured instance. */
	model: string;
	messages: Message[];
	tools: ToolDeclaration[];
	ctx: InvocationContext;
	options?: ChatOptions;
	onEvent?(event: RuntimeStreamEvent): void;
}

/** One runtime attempt inside a logical call, for diagnostics and cost attribution. */
export interface AttemptRecord {
	requestId: string;
	instanceId: string;
	ok: boolean;
}

export interface ChatResult {
	/** The assistant message the model produced. */
	message: Message;
	/** Assembled, complete calls only; fragments dropped by an abort never appear here. */
	toolCalls: ToolCall[];
	usage?: UsageRecord;
	finish: FinishReason;
	attempts: AttemptRecord[];
}
