// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEvidence, CriterionResult } from './task-graph';

/**
 * The structured report a worker or verifier returns. The contract is a single JSON object so the
 * task graph can decide acceptance deterministically; prose around it is tolerated, a wrong shape is
 * not. Pure module.
 */

export interface AgentEnvelope {
	/** Worker only. */
	status?: 'ok' | 'blocked' | 'failed';
	/** Verifier only; advisory — the service recomputes acceptance from `acceptance`. */
	verdict?: 'pass' | 'fail';
	summary: string;
	evidence: AgentEvidence[];
	/** Acceptance id -> met. */
	acceptance?: CriterionResult[];
	questions?: string[];
}

export type EnvelopeResult = { ok: true; value: AgentEnvelope } | { ok: false; reason: string };

const text = (value: unknown, limit: number): string => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

function evidenceOf(value: unknown): AgentEvidence[] | undefined {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 16) {
		return undefined;
	}
	const out: AgentEvidence[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') {
			return undefined;
		}
		const raw = item as Record<string, unknown>;
		switch (raw.kind) {
			case 'file':
				if (typeof raw.path !== 'string' || !raw.path.trim()) {
					return undefined;
				}
				out.push({
					kind: 'file',
					path: text(raw.path, 256),
					...(typeof raw.note === 'string' ? { note: text(raw.note, 1000) } : {}),
				});
				break;
			case 'search':
				if (typeof raw.query !== 'string' || !raw.query.trim()) {
					return undefined;
				}
				out.push({
					kind: 'search',
					query: text(raw.query, 500),
					...(typeof raw.note === 'string' ? { note: text(raw.note, 1000) } : {}),
				});
				break;
			case 'command':
				if (
					typeof raw.command !== 'string' ||
					!raw.command.trim() ||
					typeof raw.exitCode !== 'number' ||
					!Number.isFinite(raw.exitCode)
				) {
					return undefined;
				}
				out.push({
					kind: 'command',
					command: text(raw.command, 2000),
					exitCode: Math.trunc(raw.exitCode),
					...(typeof raw.output === 'string' ? { output: text(raw.output, 2000) } : {}),
				});
				break;
			case 'note':
				if (typeof raw.text !== 'string' || !raw.text.trim()) {
					return undefined;
				}
				out.push({ kind: 'note', text: text(raw.text, 2000) });
				break;
			default:
				return undefined;
		}
	}
	return out;
}

function acceptanceOf(value: unknown): CriterionResult[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.length > 8) {
		return undefined;
	}
	const out: CriterionResult[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') {
			return undefined;
		}
		const raw = item as Record<string, unknown>;
		const id = text(raw.id, 64);
		if (!id || typeof raw.met !== 'boolean') {
			return undefined;
		}
		out.push({ id, met: raw.met, ...(typeof raw.note === 'string' ? { note: text(raw.note, 1000) } : {}) });
	}
	return out;
}

function questionsOf(value: unknown): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.length > 8) {
		return undefined;
	}
	return value.map((item) => (typeof item === 'string' ? text(item, 1000) : '')).filter(Boolean);
}

function fromObject(value: unknown): EnvelopeResult {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, reason: 'the report is not a JSON object' };
	}
	const raw = value as Record<string, unknown>;
	const status = raw.status;
	if (status !== undefined && status !== 'ok' && status !== 'blocked' && status !== 'failed') {
		return { ok: false, reason: 'invalid status' };
	}
	const verdict = raw.verdict;
	if (verdict !== undefined && verdict !== 'pass' && verdict !== 'fail') {
		return { ok: false, reason: 'invalid verdict' };
	}
	const evidence = evidenceOf(raw.evidence);
	if (!evidence) {
		return { ok: false, reason: 'invalid evidence' };
	}
	const acceptance = acceptanceOf(raw.acceptance);
	if (raw.acceptance !== undefined && !acceptance) {
		return { ok: false, reason: 'invalid acceptance' };
	}
	const questions = questionsOf(raw.questions);
	if (raw.questions !== undefined && !questions) {
		return { ok: false, reason: 'invalid questions' };
	}
	return {
		ok: true,
		value: {
			...(status !== undefined ? { status } : {}),
			...(verdict !== undefined ? { verdict } : {}),
			summary: text(raw.summary, 2000),
			evidence,
			...(acceptance !== undefined ? { acceptance } : {}),
			...(questions !== undefined ? { questions } : {}),
		},
	};
}

function parse(textValue: string): unknown {
	try {
		return JSON.parse(textValue);
	} catch {
		return undefined;
	}
}

/** Parses the first complete JSON object in a report: whole text, a fenced block, then braces. */
export function parseAgentEnvelope(report: string): EnvelopeResult {
	const source = report.trim();
	if (!source) {
		return { ok: false, reason: 'the report is empty' };
	}
	const whole = parse(source);
	if (whole !== undefined) {
		return fromObject(whole);
	}
	const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		const value = parse(fenced[1].trim());
		if (value !== undefined) {
			return fromObject(value);
		}
	}
	const start = source.indexOf('{');
	const end = source.lastIndexOf('}');
	if (start !== -1 && end > start) {
		const value = parse(source.slice(start, end + 1));
		if (value !== undefined) {
			return fromObject(value);
		}
	}
	return { ok: false, reason: 'the report contains no valid JSON object' };
}
