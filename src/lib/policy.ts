// SPDX-License-Identifier: AGPL-3.0-only
import { deletionTargetsAreOwned, type DeletionOwnership } from './deletions';
import { sandboxAllowsWrites, type SandboxKind, type SandboxMode } from './sandbox';
import { RM_PATTERN } from './shell';
import type { Approval, ApprovalResponse, Capability, SessionPolicy, ToolCall, ToolSpec, WorkMode } from './types';

/**
 * Modes, capability gating, user rules, the tool approval policy and the approval response policy.
 * Pure module.
 *
 * One call walks the layers in this order and leaves at the first one that stops it:
 * capability → network → user rules → tool approval policy. A confirmation then enters the approval
 * response policy (the `Approval` service); a run enters the sandbox (the executor). The rules and
 * the tool approval policy are the two layers a user configures here; sandbox mode is enforced by
 * `lib/sandbox`.
 */

export const MODE_CAPS: Record<WorkMode, ReadonlySet<Capability>> = {
	chat: new Set(),
	ro: new Set(['ro', 'shell_ro']),
	sw: new Set(['ro', 'rw', 'shell_ro', 'shell_test']),
	aw: new Set(['ro', 'rw', 'shell_ro', 'shell_test', 'shell_rw']),
	pl: new Set(['ro', 'shell_ro', 'rw_plan']),
};

export const MODE_LABELS: Record<WorkMode, string> = {
	chat: 'Chat Only — no tools, plain conversation',
	ro: 'Read-Only — read files, read-only shell',
	sw: 'Semi-Write — write files, run tests in a scratch shell',
	aw: 'Full Access — write files, full shell',
	pl: 'Plan — read files, read-only shell, writes plan files only',
};

/** Every capability that runs a command. Kept in one place so the gate, rules and the parser agree. */
export function isShellCapability(capability: Capability | undefined): boolean {
	return capability === 'shell_ro' || capability === 'shell_test' || capability === 'shell_rw';
}

/** Whether the capability writes project files, which a sandbox that refuses writes cannot honor. */
export function writesWorkspace(capability: Capability): boolean {
	return capability === 'rw' || capability === 'rw_plan';
}

export const APPROVAL_LABELS: Record<Approval, string> = {
	manual: 'Manual — ask for every call no rule matched',
	whitelist_accept: 'Whitelist — run whitelisted capabilities, ask for the rest',
	blacklist_reject: 'Blacklist — reject blacklisted capabilities, ask for dangerous commands',
	universal_accept: 'Accept all — run everything, ask for dangerous commands',
	universal_reject: 'Reject all — reject every call no rule matched',
};

export const APPROVAL_RESPONSE_LABELS: Record<ApprovalResponse, string> = {
	ask: 'Ask — send each request to a surface; no surface means deny',
	never: 'Never — deny every approval request without asking',
};

export const SANDBOX_LABELS: Record<SandboxMode, string> = {
	'workspace-read': 'Workspace read — read the workspace and system runtime, write nothing',
	'read-only': 'Read only — read anywhere, write nothing',
	'workspace-write': 'Workspace write — write inside the workspace, read anywhere',
	'danger-full-access': 'Full access — no file sandbox (careful)',
};

/** A mode or approval read from a settings file or a session on disk: a value outside these maps
 *  falls back, rather than reaching a gate that indexes them and crashes. Own keys only: `in` would
 *  also accept `toString` and friends off the prototype. */
export function asWorkMode(value: unknown, fallback: WorkMode = 'sw'): WorkMode {
	return typeof value === 'string' && Object.hasOwn(MODE_CAPS, value) ? (value as WorkMode) : fallback;
}

export function asApproval(value: unknown, fallback: Approval = 'manual'): Approval {
	return typeof value === 'string' && Object.hasOwn(APPROVAL_LABELS, value) ? (value as Approval) : fallback;
}

export function asApprovalResponse(value: unknown, fallback: ApprovalResponse = 'ask'): ApprovalResponse {
	return typeof value === 'string' && Object.hasOwn(APPROVAL_RESPONSE_LABELS, value) ? (value as ApprovalResponse) : fallback;
}

export const PRESET_LABELS: Record<string, string> = {
	ask: 'Ask — edit files with approval, sandboxed shell',
	plan: 'Plan — research read-only, write a plan',
	auto: 'Auto — apply edits automatically, no network',
	readonly: 'Read only — inspect without changes',
	full: 'Unrestricted — no file sandbox, network on (careful)',
};

export interface PresetPolicy {
	workMode: WorkMode;
	approval: Approval;
	approvalResponse: ApprovalResponse;
	network: boolean;
	sandboxMode: SandboxMode;
}

export function presetPolicy(preset: string): PresetPolicy {
	switch (preset) {
		case 'plan':
			return { workMode: 'pl', approval: 'whitelist_accept', approvalResponse: 'ask', network: false, sandboxMode: 'workspace-write' };
		case 'auto':
			return { workMode: 'aw', approval: 'universal_accept', approvalResponse: 'ask', network: false, sandboxMode: 'workspace-write' };
		case 'readonly':
			return { workMode: 'ro', approval: 'whitelist_accept', approvalResponse: 'ask', network: false, sandboxMode: 'read-only' };
		case 'full':
			return { workMode: 'aw', approval: 'universal_accept', approvalResponse: 'ask', network: true, sandboxMode: 'danger-full-access' };
		default:
			return { workMode: 'sw', approval: 'manual', approvalResponse: 'ask', network: false, sandboxMode: 'workspace-write' };
	}
}

export function capabilityAllowed(capability: Capability, mode: WorkMode): boolean {
	return MODE_CAPS[mode].has(capability);
}

/**
 * The whitelist's built-in contents: read-only calls, plus the plan tools (which only `pl` mode
 * grants anyway). A user `allow` rule is a separate layer and runs its call directly.
 */
const DEFAULT_WHITELIST: ReadonlySet<Capability> = new Set(['ro', 'shell_ro', 'rw_plan']);

/**
 * The blacklist's built-in contents: everything that can write. A user `deny` rule is a separate
 * layer and rejects its call in every policy.
 */
const DEFAULT_BLACKLIST: ReadonlySet<Capability> = new Set(['rw', 'shell_test', 'shell_rw', 'rw_plan']);

export function whitelistedByDefault(capability: Capability): boolean {
	return DEFAULT_WHITELIST.has(capability);
}

export function blacklistedByDefault(capability: Capability): boolean {
	return DEFAULT_BLACKLIST.has(capability);
}

export interface PolicyRule {
	tool: string;
	pattern?: string;
}

export interface RuleSet {
	allow: PolicyRule[];
	ask: PolicyRule[];
	deny: PolicyRule[];
}

export function parseRule(text: string): PolicyRule | null {
	const match = text.trim().match(/^([A-Za-z_][\w.-]*)\s*(?:\(([\s\S]*)\))?$/);
	if (!match) {
		return null;
	}
	const pattern = match[2]?.trim();
	return pattern ? { tool: match[1]!, pattern } : { tool: match[1]! };
}

export function parseRules(config: { allow?: readonly string[]; ask?: readonly string[]; deny?: readonly string[] } | undefined): RuleSet {
	const parse = (list: readonly string[] | undefined) => (list ?? []).map(parseRule).filter((rule): rule is PolicyRule => rule !== null);
	return { allow: parse(config?.allow), ask: parse(config?.ask), deny: parse(config?.deny) };
}

function normalizeTarget(value: string): string {
	return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function callTarget(call: ToolCall, tool: ToolSpec | undefined): string {
	let args: Record<string, unknown>;
	try {
		args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
	} catch {
		return call.arguments;
	}
	const string = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
	if (isShellCapability(tool?.capability)) {
		return string('command') ?? '';
	}
	return string('url') ?? string('path') ?? string('file_path') ?? string('file') ?? call.arguments;
}

export function ruleMatches(rule: PolicyRule, call: ToolCall, tool: ToolSpec | undefined): boolean {
	if (rule.tool.toLowerCase() !== call.name.toLowerCase()) {
		return false;
	}
	if (!rule.pattern) {
		return true;
	}
	const target = normalizeTarget(callTarget(call, tool));
	const pattern = rule.pattern.trim();
	const domain = pattern.match(/^domain:(.+)$/i);
	if (domain) {
		try {
			const host = new URL(target).hostname;
			const wanted = domain[1]!.trim().toLowerCase();
			return host.toLowerCase() === wanted || host.toLowerCase().endsWith(`.${wanted}`);
		} catch {
			return false;
		}
	}
	const expression = globToRegExp(pattern);
	if (expression.test(target)) {
		return true;
	}
	if (pattern.endsWith(':*')) {
		const prefix = pattern.slice(0, -2);
		return target === prefix || target.startsWith(`${prefix}:`) || target.startsWith(`${prefix} `);
	}
	if (!pattern.includes('*') && !pattern.includes('?')) {
		return target === pattern || target.startsWith(`${pattern} `) || target.startsWith(`${pattern}/`);
	}
	return false;
}

export function globToRegExp(pattern: string): RegExp {
	const normalized = normalizeTarget(pattern);
	let out = '';
	for (let index = 0; index < normalized.length; index += 1) {
		const char = normalized[index]!;
		if (char === '*') {
			if (normalized[index + 1] === '*') {
				if (normalized[index + 2] === '/') {
					out += '(?:.*/)?';
					index += 2;
				} else {
					out += '.*';
					index += 1;
				}
			} else {
				out += '[^/]*';
			}
			continue;
		}
		out += char === '?' ? '[^/]' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${out}$`);
}

/**
 * What the gate is told about the host and the session: the OS sandbox the host can apply, and —
 * when known — the files and directories this session created plus symlink-aware containment for
 * deletions. All of it is read afresh every turn.
 */
export interface GateEnvironment {
	sandbox: SandboxKind;
	/** Workspace-relative files this session created; absent disables the rm exemption. */
	created?: ReadonlySet<string>;
	/** Workspace-relative directories this session created; their subtrees are the session's too. */
	createdDirs?: ReadonlySet<string>;
	/** Symlink-aware containment for a deletion target; production always supplies one. */
	deletionStaysInside?: (absoluteTarget: string) => boolean;
	/** True for a path under a tree only this session can write (its scratch roots). */
	deletionScratch?: (absoluteTarget: string) => boolean;
}

/** Which layer decided. The sandbox is the executor's layer and is not a gate decision. */
export type PolicyStage = 'capability' | 'network' | 'rules' | 'approval';

export interface GateResult {
	decision: 'allow' | 'confirm' | 'reject';
	reason: string;
	stage: PolicyStage;
	/** A confirmation a subagent's delegated approval must not answer. */
	escalated?: boolean;
}

const EMPTY_PATHS: ReadonlySet<string> = new Set();

/**
 * One call through the pipeline. The order is the contract:
 *
 * 1. capability — the tool exists and the work mode grants it; a capability the sandbox cannot
 *    enforce is not granted either;
 * 2. network — a network tool needs the network access policy on;
 * 3. user rules — deny rejects, ask confirms, allow runs, checked in that order;
 * 4. tool approval policy — only for a call no rule matched.
 *
 * A confirmation is answered by the approval response policy; an allow runs under the sandbox mode.
 */
export function gateCall(
	call: ToolCall,
	tool: ToolSpec | undefined,
	policy: SessionPolicy,
	rules: RuleSet,
	env: GateEnvironment,
): GateResult {
	// 1. Capability.
	if (!tool) {
		return { decision: 'reject', reason: `unknown tool: ${call.name}`, stage: 'capability' };
	}
	if (!capabilityAllowed(tool.capability, policy.workMode)) {
		return {
			decision: 'reject',
			reason: `tool ${call.name} (${tool.capability}) is not allowed in mode ${policy.workMode}`,
			stage: 'capability',
		};
	}
	if (tool.needsWorkspace && !policy.workingDirectory.trim()) {
		return { decision: 'reject', reason: `tool ${call.name} needs a working directory`, stage: 'capability' };
	}
	// A shell capability is only honest when the sandbox can enforce it. Without an OS sandbox the
	// only mode that can run a command is the explicit full-access mode; every other mode refuses.
	if (isShellCapability(tool.capability) && env.sandbox === 'none' && policy.sandboxMode !== 'danger-full-access') {
		return {
			decision: 'reject',
			reason: `${call.name} needs an OS sandbox; only sandbox mode danger-full-access can run commands on this host`,
			stage: 'capability',
		};
	}
	// A read-only shell promises an OS-enforced read-only view. The full-access mode may run a
	// writable shell unconfined, but it cannot make that promise.
	if (tool.capability === 'shell_ro' && env.sandbox === 'none') {
		return {
			decision: 'reject',
			reason: `${call.name} needs an OS sandbox to keep the shell read-only; none is available`,
			stage: 'capability',
		};
	}
	// The test shell's whole contract is a workspace that stays read-only while its scratch tree is
	// writable. A sandbox mode that refuses every write cannot keep it.
	if (tool.capability === 'shell_test' && env.sandbox === 'none') {
		return {
			decision: 'reject',
			reason: `${call.name} needs an OS sandbox to keep the workspace read-only; none is available`,
			stage: 'capability',
		};
	}
	if (tool.capability === 'shell_test' && !sandboxAllowsWrites(policy.sandboxMode)) {
		return {
			decision: 'reject',
			reason: `${call.name} needs a writable scratch tree; sandbox mode ${policy.sandboxMode} refuses every write`,
			stage: 'capability',
		};
	}
	// With no OS sandbox, the network access policy would be unenforceable for an unconfined shell.
	if (isShellCapability(tool.capability) && env.sandbox === 'none' && !policy.network) {
		return {
			decision: 'reject',
			reason: `${call.name} needs an OS sandbox to enforce the network access policy; turn network on or install a sandbox`,
			stage: 'capability',
		};
	}
	if (writesWorkspace(tool.capability) && !sandboxAllowsWrites(policy.sandboxMode)) {
		return {
			decision: 'reject',
			reason: `${call.name} writes files; sandbox mode ${policy.sandboxMode} refuses every write`,
			stage: 'capability',
		};
	}
	// A tool that runs outside the OS sandbox cannot satisfy any mode but the explicit full access
	// one; no rule or policy can make it sandboxed after the fact.
	if ((tool.unsandboxed === true || tool.name.endsWith('_unsandboxed')) && policy.sandboxMode !== 'danger-full-access') {
		return {
			decision: 'reject',
			reason: `${call.name} runs outside the OS sandbox; only sandbox mode danger-full-access can run it`,
			stage: 'capability',
		};
	}

	// 2. Network.
	if (tool.needsNetwork && !policy.network) {
		return { decision: 'reject', reason: `tool ${call.name} requires network, which is off`, stage: 'network' };
	}

	// 3. User rules, in the order the document defines: deny, then ask, then allow.
	const denied = rules.deny.find((rule) => ruleMatches(rule, call, tool));
	if (denied) {
		return { decision: 'reject', reason: `deny rule ${ruleText(denied)} blocks ${call.name}`, stage: 'rules' };
	}
	if (rules.ask.some((rule) => ruleMatches(rule, call, tool))) {
		return { decision: 'confirm', reason: `ask rule matches ${call.name}`, stage: 'rules', escalated: true };
	}
	const allowed = rules.allow.find((rule) => ruleMatches(rule, call, tool));
	if (allowed) {
		return { decision: 'allow', reason: `allow rule ${ruleText(allowed)}`, stage: 'rules' };
	}

	// 4. Tool approval policy: reached only when all three rule lists were silent.
	const danger = (): boolean =>
		isDangerous(
			call,
			tool,
			env.created
				? {
						workspace: policy.workingDirectory,
						files: env.created,
						dirs: env.createdDirs ?? EMPTY_PATHS,
						inside: env.deletionStaysInside,
						scratch: env.deletionScratch,
					}
				: undefined,
		);
	switch (policy.approval) {
		case 'manual':
			return { decision: 'confirm', reason: 'manual approval', stage: 'approval' };
		case 'whitelist_accept':
			if (whitelistedByDefault(tool.capability)) {
				return { decision: 'allow', reason: `whitelist runs ${tool.capability} calls`, stage: 'approval' };
			}
			return { decision: 'confirm', reason: `whitelist policy asks for ${call.name}`, stage: 'approval' };
		case 'blacklist_reject':
			if (blacklistedByDefault(tool.capability)) {
				return { decision: 'reject', reason: `blacklist policy rejects ${tool.capability} calls`, stage: 'approval' };
			}
			if (danger()) {
				return {
					decision: 'confirm',
					reason: `dangerous command requires explicit confirmation (${call.name})`,
					stage: 'approval',
					escalated: true,
				};
			}
			return { decision: 'allow', reason: `blacklist policy runs ${call.name}`, stage: 'approval' };
		case 'universal_accept':
			if (danger()) {
				return {
					decision: 'confirm',
					reason: `dangerous command requires explicit confirmation (${call.name})`,
					stage: 'approval',
					escalated: true,
				};
			}
			return { decision: 'allow', reason: 'approval policy accepts every call', stage: 'approval' };
		case 'universal_reject':
			return { decision: 'reject', reason: 'approval policy rejects every call no rule matched', stage: 'approval' };
	}
}

function ruleText(rule: PolicyRule): string {
	return rule.pattern ? `${rule.tool}(${rule.pattern})` : rule.tool;
}

/**
 * The batch view of `gateCall`: a rejection anywhere rejects the batch, otherwise a confirmation
 * anywhere confirms it. Escalation is carried so a delegated approval cannot answer it.
 */
export function gateCalls(
	calls: ToolCall[],
	lookup: (name: string) => ToolSpec | undefined,
	policy: SessionPolicy,
	rules: RuleSet,
	env: GateEnvironment,
): GateResult {
	let confirm: GateResult | undefined;
	for (const call of calls) {
		const gate = gateCall(call, lookup(call.name), policy, rules, env);
		if (gate.decision === 'reject') {
			return gate;
		}
		if (gate.decision === 'confirm') {
			confirm = confirm ? { ...confirm, escalated: confirm.escalated === true || gate.escalated === true } : gate;
		}
	}
	return confirm ?? { decision: 'allow', reason: 'allowed by policy', stage: 'approval' };
}

/** Short capability names for the flow tab's mode legend, so it cannot drift from the table. */
const CAP_SHORT: Record<Capability, string> = {
	ro: 'read files',
	rw: 'write files',
	shell_ro: 'read-only shell',
	shell_test: 'test shell (scratch only)',
	shell_rw: 'full shell',
	rw_plan: 'plan files',
};

/** One `Name — calls it grants` line per mode, for the flow tab's legend. */
export function modeCapabilities(): string[] {
	return (Object.keys(MODE_CAPS) as WorkMode[]).map((mode) => {
		const [name] = MODE_LABELS[mode].split(' — ');
		const caps = [...MODE_CAPS[mode]].map((capability) => CAP_SHORT[capability]).join(', ');
		return `${name} — ${caps || 'no tools'}`;
	});
}

/** One line per sandbox mode, for the flow tab's legend. */
export function sandboxCapabilities(): string[] {
	return (Object.keys(SANDBOX_LABELS) as SandboxMode[]).map((mode) => SANDBOX_LABELS[mode]);
}

/**
 * Mermaid source for the tool-call pipeline, generated from the tables above so the diagram shown
 * in the settings panel's Flow tab cannot drift from `gateCall`.
 *
 * The frames are the layers the user configures: the capability check, the user's rules, the tool
 * approval policy, and the approval response policy. The sandbox is the executor's last step.
 * Every branch ends in its own `Rejected` / `Asks you` / `Runs` node directly below it; only edges
 * whose two ends are both inside a frame are written inside that frame, because mermaid pulls both
 * ends of an inner edge into the subgraph.
 */
export function gateFlow(): string {
	return [
		'flowchart TD',
		// `call` and `end` are mermaid keywords, so the entry node is `entry`. Hexagons keep a long
		// label from making the chart taller than the pane the way diamonds do.
		'  entry(["a tool call"])',
		'',
		'  subgraph cap["capability"]',
		'    direction TB',
		'    mode{{"work mode grants it?"}}',
		'    net{{"network allowed?"}}',
		'    feasible{{"sandbox can enforce it?"}}',
		'    mode -- yes --> net',
		'    net -- yes --> feasible',
		'  end',
		'',
		'  entry --> mode',
		'  mode -- no --> capReject(["Rejected"])',
		'  net -- no --> netReject(["Rejected"])',
		'  feasible -- no --> feasibleReject(["Rejected"])',
		'  feasible -- yes --> deny',
		'',
		'  subgraph rules["user rules"]',
		'    direction TB',
		'    deny{{"deny rule?"}}',
		'    askRule{{"ask rule?"}}',
		'    allow{{"allow rule?"}}',
		'    deny -- no --> askRule',
		'    askRule -- no --> allow',
		'  end',
		'',
		'  deny -- yes --> denyReject(["Rejected"])',
		'  askRule -- yes --> askRuleAsk(["Asks you"])',
		'  allow -- yes --> allowRun(["Runs"])',
		'  allow -- no --> which',
		'',
		'  subgraph policy["tool approval policy"]',
		'    direction TB',
		'    which{{"no rule matched — which policy?"}}',
		'    manual["manual"]',
		'    whitelist["whitelist_accept"]',
		'    blacklist["blacklist_reject"]',
		'    accept["universal_accept"]',
		'    rejectAll["universal_reject"]',
		'    which --> manual',
		'    which --> whitelist',
		'    which --> blacklist',
		'    which --> accept',
		'    which --> rejectAll',
		'    whitelist --> whitelistQ{{"whitelisted capability?"}}',
		'    blacklist --> blacklistQ{{"blacklisted capability?"}}',
		'    blacklistQ -- no --> blacklistDanger{{"dangerous command?"}}',
		'    accept --> acceptDanger{{"dangerous command?"}}',
		'  end',
		'',
		'  manual --> manualAsk(["Asks you"])',
		'  whitelistQ -- yes --> whitelistRun(["Runs"])',
		'  whitelistQ -- no --> whitelistAsk(["Asks you"])',
		'  blacklistQ -- yes --> blacklistReject(["Rejected"])',
		'  blacklistDanger -- yes --> blacklistAsk(["Asks you"])',
		'  blacklistDanger -- no --> blacklistRun(["Runs"])',
		'  acceptDanger -- yes --> acceptAsk(["Asks you"])',
		'  acceptDanger -- no --> acceptRun(["Runs"])',
		'  rejectAll --> rejectAllNode(["Rejected"])',
		'  manualAsk --> toAsk',
		'  whitelistAsk --> toAsk',
		'  blacklistAsk --> toAsk',
		'  acceptAsk --> toAsk',
		'',
		'  subgraph response["approval response policy"]',
		'    direction TB',
		'    toAsk["submit approval request"]',
		'    responseQ{{"ask or never?"}}',
		'    responder{{"a surface answers?"}}',
		'    verdict{{"approved?"}}',
		'    toAsk --> responseQ',
		'    responseQ -- ask --> responder',
		'    responder -- yes --> verdict',
		'  end',
		'',
		'  responseQ -- never --> neverReject(["Rejected"])',
		'  responder -- no --> noResponder(["Rejected"])',
		'  verdict -- no --> verdictReject(["Rejected"])',
		'  verdict -- yes --> sandbox["sandbox mode limits this call"]',
		'  whitelistRun --> sandbox',
		'  blacklistRun --> sandbox',
		'  acceptRun --> sandbox',
		'  allowRun --> sandbox',
		'',
		'  style cap fill:transparent,stroke:#8a8a8a,stroke-dasharray:4 4',
		'  style rules fill:transparent,stroke:#8a8a8a,stroke-dasharray:4 4',
		'  style policy fill:transparent,stroke:#8a8a8a,stroke-dasharray:4 4',
		'  style response fill:transparent,stroke:#8a8a8a,stroke-dasharray:4 4',
		'  classDef reject fill:#6d2f2f,stroke:#c26060,color:#ffffff',
		'  classDef confirm fill:#6d5620,stroke:#d5a33a,color:#ffffff',
		'  classDef run fill:#1e5c39,stroke:#43b581,color:#ffffff',
		'  class capReject,netReject,feasibleReject,denyReject,blacklistReject,rejectAllNode,neverReject,noResponder,verdictReject reject',
		'  class askRuleAsk,manualAsk,whitelistAsk,blacklistAsk,acceptAsk,toAsk confirm',
		'  class allowRun,whitelistRun,blacklistRun,acceptRun,sandbox run',
	].join('\n');
}

const DANGEROUS_PATTERNS: RegExp[] = [
	/\bsudo\b|\bdoas\b/,
	/\bchmod\s+(-R\s+)?(777|a\+rwx)\b/i,
	/\b(curl|wget)\b[^\n|]*\|\s*(ba|z|da|k)?sh\b/i,
	/\bgit\s+push\b[^\n]*(--force\b|\s-f\b)/i,
	/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i,
	/\bmkfs\b|\bdd\s+[^\n]*of=\/dev\//i,
	/\b(shutdown|reboot|halt)\b/,
	/>\s*\/dev\/(sd|disk|nvme)/i,
	/:\(\)\s*\{[^}]*\}\s*;?\s*:/,
	/\bdiskutil\b[^\n]*\berase\b/i,
];

export type DeletionContext = DeletionOwnership;

/** Flags shell commands that deserve an explicit prompt even when the policy auto-approves. */
export function isDangerous(call: ToolCall, tool: ToolSpec | undefined, deletion?: DeletionContext): boolean {
	if (!isShellCapability(tool?.capability)) {
		return false;
	}
	const command = callTarget(call, tool);
	// The test shell writes only its scratch and a private temp tree: its sandbox already answers the
	// deletion question, so an rm there is never a reason to stop. A workspace-writable shell still
	// asks unless every operand lands under a tree this session owns or made.
	if (tool?.capability !== 'shell_test' && RM_PATTERN.test(command) && !(deletion && deletionTargetsAreOwned(command, deletion))) {
		return true;
	}
	return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

export function suggestAllowRule(call: ToolCall, tool: ToolSpec | undefined): string {
	const name = call.name;
	let args: Record<string, unknown> = {};
	try {
		args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
	} catch {
		return name;
	}
	if (isShellCapability(tool?.capability)) {
		const command = typeof args.command === 'string' ? args.command.trim() : '';
		const tokens = command.split(/\s+/).filter((token) => token && !token.startsWith('-'));
		if (tokens.length >= 2) {
			return `${name}(${tokens[0]} ${tokens[1]}:*)`;
		}
		if (tokens.length === 1) {
			return `${name}(${tokens[0]}:*)`;
		}
		return name;
	}
	const url = typeof args.url === 'string' ? args.url : '';
	if (url) {
		try {
			return `${name}(domain:${new URL(url).hostname})`;
		} catch {
			return name;
		}
	}
	const path = args.path ?? args.file_path ?? args.file;
	if (typeof path === 'string' && path.trim()) {
		return `${name}(${normalizeTarget(path)})`;
	}
	return name;
}
