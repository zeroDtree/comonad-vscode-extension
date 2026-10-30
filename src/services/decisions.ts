// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Service, type Context } from 'cordis';
import type { PolicyStep } from '../lib/policy';
import {
	policyRevision,
	type CallTrace,
	type DecisionNode,
	type DecisionView,
	type EventRecord,
	type NodeRecord,
	type PolicyRecord,
	type PolicySnapshot,
	type TerminalEvent,
	type TerminalKind,
	type TraceContext,
	type TraceRecord,
} from '../lib/trace';
import { describe } from '../lib/util';

declare module 'cordis' {
	interface Context {
		decisions: Decisions;
	}
}

/**
 * The decision-trace store and reader. Nodes are appended as the gate and the execution gates
 * decide them, so a crash leaves the facts up to that point on disk. A terminal event names the node
 * that ended the call; `reconstruct()` walks its `parent_id` links back to the root.
 *
 * Writes are best effort: an audit store that cannot be written must never fail a turn.
 */
export class Decisions extends Service {
	static inject = ['host', 'log'];

	/** Revisions whose snapshot was written by this process. */
	private readonly policies = new Set<string>();
	/** A batch hands the same snapshot object to every call; hash it once. */
	private readonly revisions = new WeakMap<PolicySnapshot, string>();
	/** Calls that already have a terminal event, so a second write is ignored. */
	private readonly terminals = new Set<string>();

	constructor(ctx: Context) {
		super(ctx, 'decisions');
	}

	/** Creates the chain for one freshly gated call and persists it immediately. */
	begin(context: TraceContext, steps: PolicyStep[], policy: PolicySnapshot): CallTrace {
		const revision = this.revisions.get(policy) ?? policyRevision(policy);
		this.revisions.set(policy, revision);
		const day = dayKey();
		const callId = randomUUID();
		this.snapshot(day, revision, policy);
		const nodes = steps.length
			? steps
			: [{ layer: 'capability' as const, decision: 'no_match' as const, matchedRule: '', reason: 'no policy step recorded' }];
		let headId = '';
		let parent: string | null = null;
		for (const step of nodes) {
			const node = this.makeNode(callId, parent, revision, step, headId === '' ? context : undefined);
			this.append(day, node);
			headId = node.node_id;
			parent = node.node_id;
		}
		return { callId, headId, revision, day, context };
	}

	/** Appends one later decision (approval response, sandbox, hook, plugin) to an existing chain. */
	extend(trace: CallTrace, step: PolicyStep): CallTrace {
		const node = this.makeNode(trace.callId, trace.headId || null, trace.revision, step);
		this.append(trace.day, node);
		return { ...trace, headId: node.node_id };
	}

	/** Writes the one terminal event for a call; later attempts are ignored in this process. */
	terminal(trace: CallTrace, event: TerminalKind, reason?: string): void {
		if (this.terminals.has(trace.callId)) {
			return;
		}
		this.terminals.add(trace.callId);
		const record: EventRecord = {
			kind: 'event',
			event_id: randomUUID(),
			call_id: trace.callId,
			trace_head_id: trace.headId,
			event,
			timestamp: Date.now(),
			...(reason ? { reason } : {}),
			session_id: trace.context.sessionId,
			turn: trace.context.turn,
			provider_call_id: trace.context.providerCallId,
			tool_name: trace.context.toolName,
			...(trace.context.subagent ? { subagent: trace.context.subagent } : {}),
		};
		this.append(trace.day, record);
	}

	/** Rebuilds one call's path from its terminal (or its last node when it has no terminal). */
	reconstruct(callId: string): DecisionView | undefined {
		const nodes = new Map<string, DecisionNode>();
		const policies = new Map<string, PolicySnapshot>();
		let terminal: TerminalEvent | undefined;
		let revision = '';
		let last: DecisionNode | undefined;
		for (const record of this.records()) {
			if (record.kind === 'policy') {
				if (!policies.has(record.policy_revision)) {
					policies.set(record.policy_revision, record.policy);
				}
				continue;
			}
			if (record.kind === 'event') {
				if (record.call_id === callId && (!terminal || record.timestamp >= terminal.timestamp)) {
					terminal = record;
				}
				continue;
			}
			if (record.call_id !== callId) {
				continue;
			}
			nodes.set(record.node_id, record);
			last = record;
			revision ||= record.policy_revision;
		}
		if (!nodes.size && !terminal) {
			return undefined;
		}
		const head = terminal?.trace_head_id || last?.node_id;
		const chain: DecisionNode[] = [];
		const seen = new Set<string>();
		for (let id = head; id && !seen.has(id); ) {
			seen.add(id);
			const node = nodes.get(id);
			if (!node) {
				break;
			}
			chain.push(node);
			id = node.parent_id ?? '';
		}
		chain.reverse();
		const root = chain[0] ?? last;
		const context: Partial<TraceContext> = terminal
			? {
					sessionId: terminal.session_id,
					turn: terminal.turn,
					providerCallId: terminal.provider_call_id,
					toolName: terminal.tool_name,
					subagent: terminal.subagent,
				}
			: {
					sessionId: root?.session_id,
					turn: root?.turn,
					providerCallId: root?.provider_call_id,
					toolName: root?.tool_name,
					subagent: root?.subagent,
				};
		const used = root?.policy_revision || revision;
		const policy = used ? policies.get(used) : undefined;
		return { callId, context, nodes: chain, terminal, policy };
	}

	/** The most recent terminal events, newest first. */
	recent(limit = 20): TerminalEvent[] {
		const events: TerminalEvent[] = [];
		for (const record of this.records()) {
			if (record.kind === 'event') {
				events.push(record);
			}
		}
		return events.sort((left, right) => right.timestamp - left.timestamp).slice(0, Math.max(1, limit));
	}

	/** The snapshot a revision names, from any day's file. */
	policyOf(revision: string): PolicySnapshot | undefined {
		for (const record of this.records()) {
			if (record.kind === 'policy' && record.policy_revision === revision) {
				return record.policy;
			}
		}
		return undefined;
	}

	private makeNode(
		callId: string,
		parent: string | null,
		revision: string,
		step: PolicyStep,
		context?: TraceContext,
	): NodeRecord {
		return {
			kind: 'node',
			node_id: randomUUID(),
			parent_id: parent,
			call_id: callId,
			layer: step.layer,
			decision: step.decision,
			matched_rule: step.matchedRule,
			policy_revision: revision,
			...(step.reason ? { reason: step.reason } : {}),
			at: Date.now(),
			...(context
				? {
						session_id: context.sessionId,
						turn: context.turn,
						provider_call_id: context.providerCallId,
						tool_name: context.toolName,
						...(context.subagent ? { subagent: context.subagent } : {}),
					}
				: {}),
		};
	}

	private snapshot(day: string, revision: string, policy: PolicySnapshot): void {
		if (this.policies.has(revision)) {
			return;
		}
		this.policies.add(revision);
		const record: PolicyRecord = { kind: 'policy', policy_revision: revision, policy, at: Date.now() };
		this.append(day, record);
	}

	private append(day: string, record: TraceRecord): void {
		try {
			const dir = this.dir();
			mkdirSync(dir, { recursive: true });
			appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`);
		} catch (error) {
			this.warn(`decisions: could not write trace: ${describe(error)}`);
		}
	}

	/** A log may itself be gone after the kernel is disposed; auditing must never throw then. */
	private warn(message: string): void {
		try {
			this.ctx.log.message(message);
		} catch {
			// The tree is already gone; the trace failure is not worth an unhandled rejection.
		}
	}

	private *records(): Generator<TraceRecord> {
		const dir = this.dir();
		let files: string[] = [];
		try {
			files = readdirSync(dir)
				.filter((file) => file.endsWith('.jsonl'))
				.sort()
				.reverse();
		} catch {
			return;
		}
		for (const file of files) {
			let text = '';
			try {
				text = readFileSync(join(dir, file), 'utf8');
			} catch (error) {
				this.warn(`decisions: could not read ${file}: ${describe(error)}`);
				continue;
			}
			for (const line of text.split('\n')) {
				if (!line.trim()) {
					continue;
				}
				try {
					const record = JSON.parse(line) as TraceRecord;
					if (record && typeof record === 'object' && (record.kind === 'policy' || record.kind === 'node' || record.kind === 'event')) {
						yield record;
					}
				} catch {
					// One damaged line is skipped; the rest of the audit stays readable.
				}
			}
		}
	}

	private dir(): string {
		return join(this.ctx.host.storage.audit, 'decisions');
	}
}

function dayKey(at = Date.now()): string {
	return new Date(at).toISOString().slice(0, 10);
}

export const decisionsPlugin = Decisions;
