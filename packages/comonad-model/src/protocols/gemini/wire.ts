// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The gemini wire: `generateContent` bodies and `streamGenerateContent` chunks. Usage
 * reports as `usageMetadata` where cache hits are a slice of the prompt and thinking
 * tokens bill as output; a thinking model's call signature rides on the part itself.
 */
import type { OptionSchema, OptionValues } from '../../config/schema';
import type { FinishReason, UsageRecord } from '../../types';
import { toGeminiContents, toGeminiTools, type GeminiPart } from './messages';
import type { Message, ToolDeclaration } from '../../types';

/** What this wire calls its knobs. */
export const GEMINI_OPTIONS: OptionSchema = {
	maxTokens: { type: 'number' },
	temperature: { type: 'number' },
	topP: { type: 'number' },
	reasoningEffort: { type: 'string', enum: ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] },
	// A host knob, not a wire one: the ceiling the effort picker may ask for.
	topEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
	extraBody: { type: 'object' },
};

/** The generateContent request body for one chat call. */
export function chatBody(
	request: { model: string; messages: readonly Message[]; tools: readonly ToolDeclaration[]; options: OptionValues },
): Record<string, unknown> {
	const options = request.options;
	const { systemInstruction, contents } = toGeminiContents(request.messages);
	const generationConfig: Record<string, unknown> = {};
	if (typeof options.maxTokens === 'number') {
		generationConfig.maxOutputTokens = options.maxTokens;
	}
	if (typeof options.temperature === 'number') {
		generationConfig.temperature = options.temperature;
	}
	if (typeof options.topP === 'number') {
		generationConfig.topP = options.topP;
	}
	if (options.reasoningEffort === 'none') {
		// The only thinking switch this wire has: a zero budget.
		generationConfig.thinkingConfig = { thinkingBudget: 0 };
	}
	const body: Record<string, unknown> = { contents };
	if (systemInstruction) {
		body.systemInstruction = systemInstruction;
	}
	const tools = toGeminiTools(request.tools);
	if (tools.length) {
		body.tools = tools;
	}
	if (Object.keys(generationConfig).length) {
		body.generationConfig = generationConfig;
	}
	const extra = options.extraBody;
	if (extra && typeof extra === 'object') {
		Object.assign(body, extra);
	}
	return body;
}

/** One streamed chunk, before interpretation. */
export interface GeminiStreamEvent {
	candidates?: {
		content?: { parts?: GeminiPart[]; role?: string };
		finishReason?: string | null;
	}[];
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		thoughtsTokenCount?: number;
		cachedContentTokenCount?: number;
	};
}

/** The usage a chunk reports: cache hits slice the prompt, thinking bills as output. */
export function usageOf(event: GeminiStreamEvent): UsageRecord | undefined {
	const meta = event.usageMetadata;
	if (!meta) {
		return undefined;
	}
	const cached = meta.cachedContentTokenCount;
	return {
		input: meta.promptTokenCount ?? 0,
		output: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
		...(typeof cached === 'number' ? { cached } : {}),
	};
}

/** The wire's finish reasons onto the protocol-neutral set. */
export function mapFinish(reason: string | null | undefined, hasToolCalls: boolean): FinishReason {
	switch (reason) {
		case 'MAX_TOKENS':
			return 'length';
		case 'SAFETY':
		case 'RECITATION':
		case 'BLOCKLIST':
		case 'PROHIBITED_CONTENT':
			return 'content_filter';
		case 'STOP':
		default:
			return hasToolCalls ? 'tool_calls' : 'stop';
	}
}
