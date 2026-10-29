// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { ruleText, type PolicyDecision, type PolicyLayer, type RuleSet } from './policy';
import type { Approval, ApprovalResponse, SandboxMode, SessionPolicy, WorkMode } from './types';

/**
 * Decision-trace records. A tool call walks the policy layers once; every node is an immutable
 * fact about one layer, linked to the node before it through `parent_id`. The terminal event names
 * the node that ended the walk — a denial, or the last node before dispatch — so an audit can
 * reconstruct the path by walking parents. Records are stored as JSONL, one object per line.
 */

/** The effective policy a revision names. Stored once per revision, beside the nodes. */
export interface PolicySnapshot {
	version: 1;
	workMode: WorkMode;
	approval: Approval;
	approvalResponse: ApprovalResponse;
	network: boolean;
	sandboxMode: SandboxMode;
	rules: {
		deny: string[];
		ask: string[];
		allow: string[];
	};
	/** Sorted: the order of read-denials never changes a decision. */
	denyReadPaths: string[];
}

export interface TraceContext {
	sessionId: string;
	turn: number;
	providerCallId: string;
	toolName: string;
	subagent?: string;
}

/**
 * The live handle of one call's chain. It is plain JSON so a suspended turn can carry it in its
 * cursor; `day` keeps every node of the call in the file it started in, even across midnight.
 */
export interface CallTrace {
	callId: string;
	headId: string;
	revision: string;
	day: string;
	context: TraceContext;
}

export interface DecisionNode {
	node_id: string;
	parent_id: string | null;
	call_id: string;
	layer: PolicyLayer;
	decision: PolicyDecision;
	matched_rule: string;
	policy_revision: string;
	reason?: string;
	at: number;
	/** Context travels on the root node, so an incomplete trace is still identifiable. */
	session_id?: string;
	turn?: number;
	provider_call_id?: string;
	tool_name?: string;
	subagent?: string;
}

export type TerminalKind = 'denied' | 'dispatch_started';

export interface TerminalEvent {
	event_id: string;
	call_id: string;
	trace_head_id: string;
	event: TerminalKind;
	timestamp: number;
	reason?: string;
	session_id?: string;
	turn?: number;
	provider_call_id?: string;
	tool_name?: string;
	subagent?: string;
}

export interface PolicyRecord {
	kind: 'policy';
	policy_revision: string;
	policy: PolicySnapshot;
	at: number;
}

export interface NodeRecord extends DecisionNode {
	kind: 'node';
}

export interface EventRecord extends TerminalEvent {
	kind: 'event';
}

export type TraceRecord = PolicyRecord | NodeRecord | EventRecord;

export interface DecisionView {
	callId: string;
	context?: Partial<TraceContext>;
	nodes: DecisionNode[];
	terminal?: TerminalEvent;
	policy?: PolicySnapshot;
}

/** The policy facts a revision identifies. Rules are kept in their effective order. */
export function policySnapshot(
	policy: Pick<SessionPolicy, 'workMode' | 'approval' | 'approvalResponse' | 'network' | 'sandboxMode' | 'denyReadPaths'>,
	rules: RuleSet,
): PolicySnapshot {
	return {
		version: 1,
		workMode: policy.workMode,
		approval: policy.approval,
		approvalResponse: policy.approvalResponse,
		network: policy.network,
		sandboxMode: policy.sandboxMode,
		rules: {
			deny: rules.deny.map(ruleText),
			ask: rules.ask.map(ruleText),
			allow: rules.allow.map(ruleText),
		},
		denyReadPaths: [...policy.denyReadPaths].sort(),
	};
}

/** A stable, short identifier for the policy facts above. */
export function policyRevision(snapshot: PolicySnapshot): string {
	return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16);
}

