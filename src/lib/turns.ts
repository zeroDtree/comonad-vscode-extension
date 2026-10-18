// SPDX-License-Identifier: AGPL-3.0-only
import type { Message } from './types';

/**
 * The transcript is a wire format (one message per model step); the UI's unit is a **turn**: one
 * prompt plus everything the agent did for it, as an ordered list of typed steps. Grouping here —
 * once, purely — is what keeps the live stream and a replayed session identical: both render the
 * same turns, so a tool result is part of the step that asked for it and can never be re-attached
 * to the wrong one.
 */

export type StepStatus = 'running' | 'ok' | 'error';

export interface Step {
	kind: 'thought' | 'text' | 'tool';
	text?: string;
	id?: string;
	name?: string;
	args?: string;
	result?: string;
	status?: StepStatus;
	/** How long this step took, when the transcript can tell: the model round trip, or the call. */
	ms?: number;
	at?: number;
}

export interface Turn {
	index: number;
	prompt: string;
	steps: Step[];
	/** Index of the user message that opened this turn. Absent for a greeting. */
	promptAt?: number;
	/** Transcript length once this turn is complete: the only safe place to fork or truncate. */
	at: number;
	startedAt?: number;
	endedAt?: number;
	/** A character's opening line: there is no prompt behind it, so it cannot be regenerated. */
	greeting?: boolean;
	/**
	 * The reply's variants, when it has been swiped or regenerated: `steps` already holds the active
	 * one, because the transcript's `content` is always the variant that is showing.
	 */
	swipes?: string[];
	swipeId?: number;
	/** This turn's reply was continued rather than answered: it has no prompt of its own. */
	continued?: boolean;
}

function statusOf(output: string | undefined): StepStatus {
	if (output === undefined) {
		// No result: the turn was suspended (waiting for approval) or cut short.
		return 'running';
	}
	return output.startsWith('Error:') ? 'error' : 'ok';
}

/** A positive duration, or `undefined` when the transcript does not carry both ends. */
function duration(from: number | undefined, to: number | undefined): number | undefined {
	if (from === undefined || to === undefined) {
		return undefined;
	}
	const ms = to - from;
	return ms > 0 ? ms : undefined;
}

/** Turns of a transcript, oldest first. `first` numbers the first one (turns already dropped). */
export function turnsOf(transcript: Message[], first = 0): Turn[] {
	const results = new Map<string, { content: string; at?: number }>();
	for (const message of transcript) {
		if (message.role === 'tool' && message.toolCallId) {
			results.set(message.toolCallId, { content: message.content, at: message.at });
		}
	}
	const turns: Turn[] = [];
	let current: Turn | undefined;
	transcript.forEach((message, index) => {
		if (message.role === 'user') {
			if (current) {
				current.at = index;
			}
			current = { index: first + turns.length, prompt: message.content, promptAt: index, steps: [], at: index + 1, startedAt: message.at };
			turns.push(current);
			return;
		}
		if (message.greeting) {
			// A character's opening line is a turn of its own: it belongs to no prompt.
			if (current) {
				current.at = index;
			}
			current = { index: first + turns.length, prompt: '', steps: [], at: index + 1, startedAt: message.at, greeting: true };
			turns.push(current);
		}
		if (!current) {
			// Tool or assistant traffic before any prompt: nothing to attach it to.
			return;
		}
		if (message.role === 'assistant') {
			const round = duration(message.startedAt, message.at);
			if (message.swipes && message.swipes.length > 1) {
				current.swipes = message.swipes;
				current.swipeId = message.swipeId ?? 0;
			}
			if (message.continued) {
				current.continued = true;
			}
			if (message.reasoning?.trim()) {
				current.steps.push({ kind: 'thought', text: message.reasoning, ms: round, at: message.at });
			}
			if (message.content.trim()) {
				// One timer per round trip: a text block carries it only when no thinking block already does.
				current.steps.push({ kind: 'text', text: message.content, ms: message.reasoning?.trim() ? undefined : round, at: message.at });
			}
			for (const call of message.toolCalls ?? []) {
				const output = results.get(call.id);
				current.steps.push({
					kind: 'tool',
					id: call.id,
					name: call.name,
					args: call.arguments,
					result: output?.content,
					status: statusOf(output?.content),
					ms: duration(message.at, output?.at),
					at: message.at,
				});
			}
		}
		if (message.at !== undefined) {
			current.endedAt = message.at;
		}
	});
	if (current) {
		current.at = transcript.length;
	}
	return turns;
}
