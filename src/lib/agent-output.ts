// SPDX-License-Identifier: AGPL-3.0-only
import { readEvidence } from './agent-evidence';
import { MAX_ACCEPTANCE, type AgentEvidence, type CriterionResult } from './task-graph';

/**
 * The structured report a worker or verifier returns. The contract is a single JSON object so the
 * task graph can decide acceptance deterministically; prose around it is tolerated, and evidence or
 * acceptance defects are reported as warnings rather than discarding a semantically valid report.
 * Only a missing/ill-typed envelope or an invalid status/verdict is fatal. Pure module.
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

export type EnvelopeResult =
	| { ok: true; value: AgentEnvelope; warnings: string[] }
	| { ok: false; reason: string };

const text = (value: unknown, limit: number): string => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

function truth(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') {
		return value;
	}
	if (value === 'true') {
		return true;
	}
	if (value === 'false') {
		return false;
	}
	return undefined;
}

function acceptanceOf(value: unknown): { items: CriterionResult[]; warnings: string[] } {
	const warnings: string[] = [];
	if (value === undefined) {
		return { items: [], warnings };
	}
	if (!Array.isArray(value)) {
		return { items: [], warnings: ['acceptance was not an array; ignored'] };
	}
	const items: CriterionResult[] = [];
	value.forEach((item, index) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			warnings.push(`acceptance[${index}] was not an object; dropped`);
			return;
		}
		const raw = item as Record<string, unknown>;
		const id = text(raw.id, 64);
		const met = truth(raw.met);
		if (!id || met === undefined) {
			warnings.push(`acceptance[${index}] needs an id and a boolean met; dropped`);
			return;
		}
		items.push({ id, met, ...(typeof raw.note === 'string' ? { note: text(raw.note, 1000) } : {}) });
	});
	if (items.length > MAX_ACCEPTANCE) {
		warnings.push(`acceptance had ${items.length} entries; kept the first ${MAX_ACCEPTANCE}`);
		items.length = MAX_ACCEPTANCE;
	}
	return { items, warnings };
}

function questionsOf(value: unknown): { items: string[]; warnings: string[] } {
	const warnings: string[] = [];
	if (value === undefined) {
		return { items: [], warnings };
	}
	if (!Array.isArray(value)) {
		return { items: [], warnings: ['questions was not an array; ignored'] };
	}
	const parsed = value.map((item) => (typeof item === 'string' ? text(item, 1000) : '')).filter(Boolean);
	if (parsed.length < value.length) {
		warnings.push('empty or non-string questions were dropped');
	}
	const items = parsed.slice(0, 8);
	if (parsed.length > 8) {
		warnings.push(`questions had ${parsed.length} entries; kept the first 8`);
	}
	return { items, warnings };
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
	const evidence = readEvidence(raw.evidence);
	const acceptance = acceptanceOf(raw.acceptance);
	const questions = questionsOf(raw.questions);
	const warnings = [...evidence.warnings, ...acceptance.warnings, ...questions.warnings];
	return {
		ok: true,
		value: {
			...(status !== undefined ? { status } : {}),
			...(verdict !== undefined ? { verdict } : {}),
			summary: text(raw.summary, 2000),
			evidence: evidence.items,
			...(raw.acceptance !== undefined ? { acceptance: acceptance.items } : {}),
			...(raw.questions !== undefined ? { questions: questions.items } : {}),
		},
		warnings,
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
