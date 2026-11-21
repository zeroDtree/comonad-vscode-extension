// SPDX-License-Identifier: AGPL-3.0-only
import { effectiveCapabilities, type AgentRole } from './agents';
import { capabilitiesOf } from './policy';
import type { AcceptanceCriterion, TaskGraph } from './task-graph';
import type { Capability, SessionPolicy } from './types';

/**
 * The Plan phase's rules, derived from the one permission language: the effective capability set.
 * `workMode` only names the phase; every permission below comes from `capabilitiesOf`, so a Plan
 * session with an explicit `rw` still cannot write. Pure: no services, no `vscode`, no `cordis`.
 */

/** The write tools a task may use to modify the workspace. */
const TRACKED_WRITE_TOOLS = ['write_file', 'edit_text', 'edit_ranges'] as const;

export type PlanDeliverable = 'plan-file' | 'plan-summary' | 'implementation' | 'research';

export interface PlanRulesInput {
	policy: Pick<SessionPolicy, 'workMode' | 'capabilities'>;
	/** The tool names the session actually offers this turn. */
	visible: ReadonlySet<string>;
}

export interface PlanRules {
	/** The session is in the Plan phase. */
	planMode: boolean;
	/** The effective capability set; never wider than the mode. */
	capabilities: ReadonlySet<Capability>;
	/** `write_plan` is offered, so a new plan file can be created. */
	canCreatePlan: boolean;
	/** `edit_plan` is offered, so an existing plan file can be revised. */
	canEditPlan: boolean;
	/** Either plan writer is offered, so a plan file can be the deliverable. */
	planWriterVisible: boolean;
	/** Both plan readers are offered. */
	canReadPlans: boolean;
	/** A tracked write tool is offered and the session grants `rw`. */
	canWrite: boolean;
	/** A write task can run: `canWrite` and `delegate` is offered. */
	canDelegateWrites: boolean;
	/** A command criterion can run: `shell_test` is granted and the test shell is offered. */
	canCommandCriteria: boolean;
	/** What this turn should deliver. */
	deliverable: PlanDeliverable;
	/** The actionable refusal for a task that needs `rw`, or undefined when it can run. */
	writeRefusal(id: string, nodeCapabilities: readonly Capability[]): string | undefined;
	/** The actionable refusal for a task whose acceptance needs a command, or undefined. */
	commandRefusal(id: string, acceptance: readonly AcceptanceCriterion[]): string | undefined;
	/** Every refusal for a reconciled graph; accepted nodes are history and are skipped. */
	refuseGraph(graph: TaskGraph, roles: ReadonlyMap<string, AgentRole>): string[];
}

export function planRules(input: PlanRulesInput): PlanRules {
	const { visible } = input;
	const capabilities = capabilitiesOf(input.policy);
	const planMode = input.policy.workMode === 'plan';
	const canCreatePlan = visible.has('write_plan');
	const canEditPlan = visible.has('edit_plan');
	const planWriterVisible = canCreatePlan || canEditPlan;
	const canReadPlans = visible.has('list_plans') && visible.has('read_plan');
	const canWrite = capabilities.has('rw') && TRACKED_WRITE_TOOLS.some((name) => visible.has(name));
	const canDelegateWrites = canWrite && visible.has('delegate');
	const canCommandCriteria = capabilities.has('shell_test') && visible.has('run_shell_test');
	const deliverable: PlanDeliverable = planMode
		? planWriterVisible
			? 'plan-file'
			: 'plan-summary'
		: canWrite
			? 'implementation'
			: 'research';

	const writeRefusal = (id: string, nodeCapabilities: readonly Capability[]): string | undefined => {
		if (!nodeCapabilities.includes('rw')) {
			return undefined;
		}
		if (canDelegateWrites) {
			return undefined;
		}
		if (planMode) {
			if (canCreatePlan && canEditPlan) {
				return `${id} needs rw, but Plan mode delegates only read-only research; record or revise the implementation plan with write_plan or edit_plan and let the user build it`;
			}
			if (canCreatePlan) {
				return `${id} needs rw, but Plan mode delegates only read-only research; record the implementation plan with write_plan and let the user build it`;
			}
			if (canEditPlan) {
				return `${id} needs rw, but Plan mode delegates only read-only research; revise the recorded plan with edit_plan and let the user build it, or put the implementation plan in your summary if no plan file exists yet`;
			}
			return `${id} needs rw, but Plan mode delegates only read-only research; put the implementation plan in your summary and let the user switch to a write mode`;
		}
		if (!capabilities.has('rw')) {
			return `${id} writes, but this session has no rw capability; switch to Semi-Write/Full Access to run it`;
		}
		if (!canWrite) {
			return `${id} writes, but the tracked write tools are switched off in Prompts; enable write_file, edit_text or edit_ranges`;
		}
		return `${id} writes, but delegate is switched off in Prompts; enable it or run the write in the main thread`;
	};

	const commandRefusal = (id: string, acceptance: readonly AcceptanceCriterion[]): string | undefined => {
		if (!acceptance.some((criterion) => criterion?.check === 'command')) {
			return undefined;
		}
		if (canCommandCriteria) {
			return undefined;
		}
		if (planMode) {
			return `${id} has a command criterion, but Plan mode has no test shell; use evidence criteria or let the user build the plan`;
		}
		if (!capabilities.has('shell_test')) {
			return `${id} needs command verification, but this session has no shell_test capability`;
		}
		return `${id} needs command verification, but the test shell is unavailable; enable run_shell_test and use a writable sandbox, or use evidence criteria`;
	};

	return {
		planMode,
		capabilities,
		canCreatePlan,
		canEditPlan,
		planWriterVisible,
		canReadPlans,
		canWrite,
		canDelegateWrites,
		canCommandCriteria,
		deliverable,
		writeRefusal,
		commandRefusal,
		refuseGraph(graph, roles) {
			const refusals: string[] = [];
			for (const node of graph.nodes) {
				// An accepted node is history: a later mode switch must not invalidate the graph.
				if (node.status === 'accepted') {
					continue;
				}
				const role = roles.get(node.role);
				if (!role) {
					continue;
				}
				const nodeCapabilities = effectiveCapabilities(role, node.capabilities);
				const refusal = writeRefusal(node.id, nodeCapabilities) ?? commandRefusal(node.id, node.acceptance);
				if (refusal) {
					refusals.push(refusal);
				}
			}
			return refusals;
		},
	};
}
