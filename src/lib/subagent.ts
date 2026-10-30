// SPDX-License-Identifier: AGPL-3.0-only
import { capabilitiesOf, ruleText, type PolicyRule, type RuleSet } from './policy';
import { sandboxReads, sandboxWrites, type SandboxMode } from './sandbox';
import type { Approval, Capability, SessionPolicy } from './types';

/**
 * The subagent policy algebra. A child inherits a parent's effective policy, then only narrows it:
 * capabilities intersect, network is an AND, the sandbox takes the stricter of the two, ancestor
 * rules accumulate their restrictions, and the child's tool approval policy is its own (with a
 * fixed `never` response). Spawn and Fork use exactly this construction; only their context differs.
 */

export const SUBAGENT_CAPABILITIES: readonly Capability[] = ['ro', 'shell_ro', 'rw', 'shell_test'];
export const SUBAGENT_WRITE_CAPABILITIES: readonly Capability[] = ['rw', 'shell_test'];
export const DEFAULT_SUBAGENT_APPROVAL: Approval = 'whitelist_accept';

const CAPABILITY_ORDER: readonly Capability[] = ['ro', 'rw', 'rw_plan', 'shell_ro', 'shell_test', 'shell_rw'];

export interface DelegationConstraints {
	/** Further narrows the parent's capability set; it can never add one. */
	capabilities?: Capability[];
	/** `false` turns network off. `true` or absent inherits the parent (and cannot turn it on). */
	network?: boolean;
	/** A ceiling; the child gets the stricter of this and the parent's sandbox. */
	sandboxMode?: SandboxMode;
	/** The child's own tool approval policy. Defaults to `whitelist_accept`. */
	approval?: Approval;
}

/** The parent facts a child tightening reads: capabilities, network, sandbox and rules only. */
export interface ParentFacts {
	capabilities: Capability[];
	network: boolean;
	sandboxMode: SandboxMode;
	rules: RuleSet;
}

/** The stricter of two sandbox modes, component by component. */
export function meetSandboxMode(left: SandboxMode, right: SandboxMode): SandboxMode {
	const read = sandboxReads(left) === 'workspace' || sandboxReads(right) === 'workspace' ? 'workspace' : 'all';
	const leftWrite = sandboxWrites(left);
	const rightWrite = sandboxWrites(right);
	const write =
		leftWrite === 'none' || rightWrite === 'none'
			? 'none'
			: leftWrite === 'workspace' || rightWrite === 'workspace'
				? 'workspace'
				: 'all';
	if (read === 'workspace') {
		// There is no mode with workspace-only reads and a writable workspace; workspace-read is the
		// stricter representable result.
		return 'workspace-read';
	}
	return write === 'none' ? 'read-only' : write === 'workspace' ? 'workspace-write' : 'danger-full-access';
}

/** Capabilities present in every list, in the canonical mode order. */
export function intersectCapabilities(...lists: readonly (readonly Capability[])[]): Capability[] {
	const sets = lists.map((list) => new Set(list));
	return CAPABILITY_ORDER.filter((capability) => sets.every((set) => set.has(capability)));
}

export function emptyRules(): RuleSet {
	return { allow: [], ask: [], deny: [] };
}

export function cloneRules(rules: RuleSet): RuleSet {
	return { allow: [...rules.allow], ask: [...rules.ask], deny: [...rules.deny] };
}

function uniqueRules(rules: readonly PolicyRule[]): PolicyRule[] {
	const seen = new Set<string>();
	const out: PolicyRule[] = [];
	for (const rule of rules) {
		const key = ruleText(rule);
		if (!seen.has(key)) {
			seen.add(key);
			out.push(rule);
		}
	}
	return out;
}

/**
 * The child rules after one tightening step:
 *
 * - deny/ask accumulate: a restriction an ancestor ever imposed stays;
 * - allow is an intersection with the current ancestor allows: removing an allow tightens the child,
 *   adding one never widens it.
 */
export function tightenRules(previous: RuleSet, parent: RuleSet): RuleSet {
	const currentAllow = new Set(parent.allow.map(ruleText));
	return {
		deny: uniqueRules([...previous.deny, ...parent.deny]),
		ask: uniqueRules([...previous.ask, ...parent.ask]),
		allow: uniqueRules(previous.allow.filter((rule) => currentAllow.has(ruleText(rule)))),
	};
}

/** The parent's own live rules: its snapshot restricted by the current settings. */
export function parentRules(snapshot: RuleSet | undefined, current: RuleSet): RuleSet {
	return snapshot ? tightenRules(snapshot, current) : cloneRules(current);
}

/** The parent facts a child reads while it tightens. */
export function parentFacts(parent: SessionPolicy, current: SessionPolicy): ParentFacts {
	const currentRules = current.rules ?? emptyRules();
	return {
		capabilities: intersectCapabilities([...capabilitiesOf(parent)], [...capabilitiesOf(current)]),
		network: parent.network && current.network,
		sandboxMode: meetSandboxMode(parent.sandboxMode, current.sandboxMode),
		rules: parentRules(parent.rules, currentRules),
	};
}

/**
 * The effective policy a delegated child is created with. `tools` is the final allowlist; `undefined`
 * is only for the candidate used to compute that list (it means "not narrowed by name yet").
 */
export function buildSubagentPolicy(
	parent: SessionPolicy,
	constraints: DelegationConstraints,
	tools: readonly string[] | undefined,
	model?: string,
): SessionPolicy {
	const capabilities = intersectCapabilities(
		[...capabilitiesOf(parent)],
		[...(constraints.capabilities ?? SUBAGENT_CAPABILITIES)],
		[...SUBAGENT_CAPABILITIES],
	);
	return {
		...parent,
		...(model ? { model } : {}),
		capabilities,
		rules: cloneRules(parent.rules ?? emptyRules()),
		tools: tools === undefined ? undefined : [...tools],
		approval: constraints.approval ?? DEFAULT_SUBAGENT_APPROVAL,
		// A delegated agent has nobody to ask: every confirmation is a denial.
		approvalResponse: 'never',
		network: parent.network && constraints.network !== false,
		sandboxMode: constraints.sandboxMode ? meetSandboxMode(parent.sandboxMode, constraints.sandboxMode) : parent.sandboxMode,
	};
}

/**
 * One monotonic tightening of an existing child. Capabilities, network and sandbox only narrow;
 * rules only accumulate restrictions; tools are intersected with the currently visible set. The
 * child's own approval policy and fixed `never` response are untouched.
 */
export function tightenSubagentPolicy(
	child: SessionPolicy,
	parent: ParentFacts,
	visible: (policy: SessionPolicy) => readonly string[],
): SessionPolicy {
	const narrowed: SessionPolicy = {
		...child,
		capabilities: intersectCapabilities([...capabilitiesOf(child)], parent.capabilities),
		rules: tightenRules(child.rules ?? emptyRules(), parent.rules),
		network: child.network && parent.network,
		sandboxMode: meetSandboxMode(child.sandboxMode, parent.sandboxMode),
	};
	const allowed = new Set(visible(narrowed));
	return {
		...narrowed,
		tools: child.tools ? child.tools.filter((name) => allowed.has(name)) : undefined,
	};
}
