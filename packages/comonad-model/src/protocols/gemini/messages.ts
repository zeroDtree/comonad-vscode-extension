// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Internal messages → Gemini `contents` parts. The wire wants `systemInstruction` on
 * the side, `user`/`model` turns, and tool traffic as `functionCall`/`functionResponse`
 * parts. A thinking model's call carries its signature on the part itself — kept in
 * `extraContent.google.thought_signature` and handed back verbatim.
 */
import { isImageAttachment, renderAttachments } from '../../messages/render';
import type { Message, ToolCall, ToolDeclaration } from '../../types';

export interface GeminiPart {
	text?: string;
	inlineData?: { mimeType: string; data: string };
	functionCall?: { name: string; args: unknown; thoughtSignature?: string };
	functionResponse?: { name: string; response: unknown };
	thought?: boolean;
}

export interface GeminiContent {
	role: 'user' | 'model';
	parts: GeminiPart[];
}

/** The request's system instruction and contents in Gemini shape. */
export function toGeminiContents(messages: readonly Message[]): {
	systemInstruction?: { parts: GeminiPart[] };
	contents: GeminiContent[];
} {
	const system: string[] = [];
	const contents: GeminiContent[] = [];
	// The wire answers a function call by name; a tool message keeps only the id, so the
	// names come from the assistant turns that made the calls.
	const names = new Map<string, string>();
	for (const message of messages) {
		for (const call of message.toolCalls ?? []) {
			names.set(call.id, call.name);
		}
	}

	const lastUser = (): GeminiContent | undefined => {
		const last = contents[contents.length - 1];
		return last && last.role === 'user' ? last : undefined;
	};

	for (const message of messages) {
		if (message.role === 'system') {
			system.push(message.content);
			continue;
		}
		if (message.role === 'tool') {
			const part: GeminiPart = {
				functionResponse: {
					name: names.get(message.toolCallId ?? '') ?? 'unknown',
					response: { result: message.content },
				},
			};
			const last = lastUser();
			const onlyResponses = last?.parts.every((existing) => existing.functionResponse !== undefined);
			if (last && onlyResponses) {
				last.parts.push(part);
			} else {
				contents.push({ role: 'user', parts: [part] });
			}
			continue;
		}
		if (message.role === 'assistant') {
			const parts: GeminiPart[] = [];
			if (message.content) {
				parts.push({ text: message.content });
			}
			for (const call of message.toolCalls ?? []) {
				parts.push({ functionCall: { name: call.name, args: parseArguments(call.arguments), ...signatureOf(call) } });
			}
			contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
			continue;
		}
		const parts: GeminiPart[] = [];
		const references = renderAttachments(message.attachments);
		const text = [references, message.content].filter(Boolean).join('\n\n');
		if (text) {
			parts.push({ text });
		}
		for (const part of (message.attachments ?? []).filter(isImageAttachment)) {
			if (part.dataUrl) {
				const comma = part.dataUrl.indexOf(',');
				const header = part.dataUrl.slice(0, comma);
				parts.push({
					inlineData: {
						mimeType: header.replace(/^data:/, '').replace(/;base64$/, '') || part.mime,
						data: part.dataUrl.slice(comma + 1),
					},
				});
			}
		}
		contents.push({ role: 'user', parts: parts.length ? parts : [{ text: '' }] });
	}
	return {
		systemInstruction: system.length ? { parts: [{ text: system.join('\n\n') }] } : undefined,
		contents,
	};
}

/** The signature the model wants returned with its call, if it sent one. */
export function signatureOf(call: ToolCall): { thoughtSignature?: string } {
	const signature = (call.extraContent?.google as { thought_signature?: unknown } | undefined)?.thought_signature;
	return typeof signature === 'string' ? { thoughtSignature: signature } : {};
}

/** The wire's tool declarations: flat `functionDeclarations` with `parameters`. */
export function toGeminiTools(tools: readonly ToolDeclaration[]): unknown[] {
	if (!tools.length) {
		return [];
	}
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		},
	];
}

function parseArguments(argumentsText: string): unknown {
	if (!argumentsText.trim()) {
		return {};
	}
	try {
		return JSON.parse(argumentsText) as unknown;
	} catch {
		return {};
	}
}
