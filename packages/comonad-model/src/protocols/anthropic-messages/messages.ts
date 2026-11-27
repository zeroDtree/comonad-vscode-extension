// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Internal messages → Anthropic Messages shape. The wire wants `system` at the top,
 * `tool_use`/`tool_result` blocks paired across one assistant/user turn, and images as
 * base64 sources. A `reasoning` chain is display bookkeeping and is not sent back —
 * thinking blocks are bound to the conversation turn that produced them, so echoing
 * a stripped copy gains nothing and risks a signature refusal.
 */
import { isImageAttachment, renderAttachments } from '../../messages/render';
import type { ImagePart, Message, ToolCall, ToolDeclaration } from '../../types';

export interface AnthropicWireMessage {
	role: 'user' | 'assistant';
	content: unknown[];
}

/** The request's system and messages in Messages API shape. */
export function toAnthropicMessages(messages: readonly Message[]): {
	system: string;
	messages: AnthropicWireMessage[];
} {
	const system: string[] = [];
	const out: AnthropicWireMessage[] = [];

	for (const message of messages) {
		if (message.role === 'system') {
			system.push(message.content);
			continue;
		}
		if (message.role === 'tool') {
			// Consecutive tool results merge into one user turn — the wire pairs one user
			// message with the assistant turn that made the calls.
			const result: Record<string, unknown> = {
				type: 'tool_result',
				tool_use_id: message.toolCallId,
				content: message.content,
			};
			const images = (message.attachments ?? []).filter(isImageAttachment).filter((part) => part.dataUrl);
			if (images.length) {
				result.content = [message.content, ...images.map(toImageBlock)].filter(Boolean);
			}
			const last = out[out.length - 1];
			if (last && last.role === 'user' && last.content.every((block) => (block as { type?: string }).type === 'tool_result')) {
				last.content.push(result);
			} else {
				out.push({ role: 'user', content: [result] });
			}
			continue;
		}
		if (message.role === 'assistant') {
			const blocks: unknown[] = [];
			if (message.content) {
				blocks.push({ type: 'text', text: message.content });
			}
			for (const call of message.toolCalls ?? []) {
				blocks.push({
					type: 'tool_use',
					id: call.id,
					name: call.name,
					input: parseArguments(call.arguments),
				});
			}
			out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
			continue;
		}
		const blocks: unknown[] = [];
		const references = renderAttachments(message.attachments);
		const text = [references, message.content].filter(Boolean).join('\n\n');
		if (text) {
			blocks.push({ type: 'text', text });
		}
		for (const part of (message.attachments ?? []).filter(isImageAttachment)) {
			if (part.dataUrl) {
				blocks.push(toImageBlock(part));
			}
		}
		out.push({ role: 'user', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
	}
	return { system: system.join('\n\n'), messages: out };
}

function toImageBlock(part: ImagePart): unknown {
	const dataUrl = part.dataUrl ?? '';
	const comma = dataUrl.indexOf(',');
	const header = dataUrl.slice(0, comma);
	const data = dataUrl.slice(comma + 1);
	const mediaType = header.replace(/^data:/, '').replace(/;base64$/, '') || part.mime;
	return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

/** Tool arguments travel as JSON text; the wire wants the parsed object. */
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

/** The wire's tool shape: `input_schema`, not `parameters`. */
export function toAnthropicTools(tools: readonly ToolDeclaration[]): unknown[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));
}

/** A tool call assembled from `tool_use` + `input_json_delta` stream pieces. */
export interface AnthropicCallPiece {
	id: string;
	name: string;
	arguments: string;
}

export function toToolCall(piece: AnthropicCallPiece): ToolCall {
	return { id: piece.id, name: piece.name, arguments: piece.arguments };
}
