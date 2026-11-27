// SPDX-License-Identifier: AGPL-3.0-only
/**
 * @comonad/model — the Comonad Model Runtime.
 *
 * A protocol-driven, brand-extensible model calling stack:
 *
 *   Model Runtime        resolve · stream · retry · fallback · usage · cost
 *   Brand Adapters       openai · deepseek · opencode-go · anthropic · google · custom
 *   Protocol Impls       openai-chat · anthropic-messages · gemini
 *   Transport            HTTP · Auth · Headers · SSE · Abort · Origin/Secret security
 *
 * This barrel is the frozen public API surface (MODEL_API_VERSION).
 */
export { MODEL_API_VERSION, assertApiVersion } from './api-version';
export { customBrand } from './brands/custom';
export { deepseekBrand } from './brands/deepseek';
export { SKIP_SIGNATURE, demandsSignature, googleBrand, googleSignatures } from './brands/google';
export { openaiBrand } from './brands/openai';
export { opencodeGoBrand } from './brands/opencode-go';
export {
	isDocumentAttachment,
	isImageAttachment,
	isTextAttachment,
	renderAttachments,
	renderReference,
} from './messages/render';
export {
	OPENAI_CHAT_OPTIONS,
	ToolSlots,
	chatBody,
	mapFinish,
	openaiChatProtocol,
	retryAfterMsOf,
	toOpenAiMessages,
	usageOf,
} from './protocols/openai-chat';
export type { OpenAiStreamEvent } from './protocols/openai-chat';
export {
	ANTHROPIC_MESSAGES_OPTIONS,
	anthropicMessagesProtocol,
	toAnthropicMessages,
	toAnthropicTools,
} from './protocols/anthropic-messages';
export type { AnthropicStreamEvent } from './protocols/anthropic-messages';
export { GEMINI_OPTIONS, geminiProtocol, toGeminiContents, toGeminiTools } from './protocols/gemini';
export type { GeminiStreamEvent } from './protocols/gemini';
export { anthropicBrand } from './brands/anthropic';
export {
	ModelError,
	classifyHttpRefusal,
	isAbortedError,
	isContextOverflow,
	isImageUnsupported,
	isRetryable,
	isTransportFailure,
	modelHttpError,
	toTransportError,
} from './errors';
export type { ModelErrorCode, ModelErrorOptions } from './errors';
export {
	MERGE_RULES,
	compileModelRules,
	concatHooks,
	mergeHeaders,
	mergeModels,
	mergeRetry,
	mergeWire,
	protocolIdFor,
	validateOptions,
} from './config/merge';
export type { MergeRule, MergeRuleRow } from './config/merge';
export { keyEnvNames, resolveProvider } from './config/resolve';
export { SHIPPED_INSTANCES } from './config/shipped-instances';
export {
	DEFAULT_RETRY_POLICY,
} from './config/schema';
export type {
	BrandDefaults,
	BrandDefinition,
	KeyProvider,
	OptionField,
	OptionSchema,
	OptionValues,
	ProtocolDefinition,
	ProtocolImpl,
	ProviderInstanceConfig,
	RequestHook,
	ResolvedProvider,
	ResolvedWire,
	RetryPolicy,
	HeaderHook,
} from './config/schema';
export { costFor, isPriced } from './pricing/cost';
export { ModelCatalog, shapeModelIds } from './runtime/catalog';
export { fallbackChain } from './runtime/fallback';
export { chatRequest, modelsRequest } from './runtime/request';
export { backoffMs, planRetry, sleep } from './runtime/retry';
export type { RetryPlan } from './runtime/retry';
export { ModelRuntime, parseModelRef } from './runtime/runtime';
export type { CompleteRequest, Disposable, ModelRef, ModelRuntimeDeps, ResolvedCall } from './runtime/runtime';
export { addUsage } from './runtime/usage';
export { RecordingTransport, formatSse } from './replay/record';
export { ReplayTransport } from './replay/replay-transport';
export type { FixtureEnvelope } from './replay/replay-transport';
export { FAKE_OPTIONS_SCHEMA, makeFakeBrand, makeFakeInstance, makeFakeProtocol } from './testing';
export type { FakeCall, FakeOutcome, FakeProtocol, FakeProtocolOptions } from './testing';
export { BEARER, applyAuth, maskSecret, redactSecrets } from './transport/auth';
export type { AuthScheme } from './transport/auth';
export { HttpTransport } from './transport/http';
export { parseSse } from './transport/sse';
export { DEFAULT_SSE_LIMITS, normalizeEndpoint, originOf, resolveSameOrigin } from './transport/security';
export type { SseLimits } from './transport/security';
export type { SseEvent, Transport, TransportRequest, TransportResponse } from './transport/transport';
export type {
	AttachmentPart,
	AttemptRecord,
	ChatOptions,
	ChatRequest,
	ChatResult,
	DocumentAttachment,
	FinishReason,
	ImageAttachment,
	ImageMime,
	ImagePart,
	InvocationContext,
	JsonSchema,
	Message,
	ModelInfo,
	Pricing,
	ProviderStreamEvent,
	ReasoningEffort,
	RuntimeStreamEvent,
	SourceRange,
	SwipeInfo,
	TextAttachment,
	ToolCall,
	ToolCallDelta,
	ToolDeclaration,
	UsageRecord,
} from './types';
