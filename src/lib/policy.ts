// SPDX-License-Identifier: AGPL-3.0-only
import { deletionTargetsAreOwned, type DeletionOwnership } from './deletions';
import type { SandboxKind } from './sandbox';
import { RM_PATTERN } from './shell';
import type { Approval, Capability, Confinement, SessionPolicy, ToolCall, ToolSpec, WorkMode } from './types';

/** Modes, capability gating, permission rules and the approval gate. Pure module. */

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

export const APPROVAL_LABELS: Record<Approval, string> = {
	manual: 'Ask — confirm every tool call',
	universal_reject: 'Reject all — never run tools',
	blacklist_reject: 'Blacklist — reject the blacklisted calls, run the rest',
	whitelist_accept: 'Whitelist — run the whitelisted calls, ask for the rest',
	universal_accept: 'Accept all — run everything the mode allows',
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

export const PRESET_LABELS: Record<string, string> = {
	ask: 'Ask — edit files with approval, sandboxed shell',
	plan: 'Plan — research read-only, write a plan',
	auto: 'Auto — apply edits automatically, no network',
	readonly: 'Read only — inspect without changes',
	full: 'Unrestricted — no sandbox, network on (careful)',
};

export function presetPolicy(preset: string): { workMode: WorkMode; approval: Approval; network: boolean; confinement: Confinement } {
	switch (preset) {
		case 'plan':
			return { workMode: 'pl', approval: 'whitelist_accept', network: false, confinement: WORKSPACE_BOUNDARY };
		case 'auto':
			return { workMode: 'aw', approval: 'universal_accept', network: false, confinement: WORKSPACE_BOUNDARY };
		case 'readonly':
			return { workMode: 'ro', approval: 'whitelist_accept', network: false, confinement: WORKSPACE_BOUNDARY };
		case 'full':
			// The preset's whole point is to drop the boundary, so it is the one that moves it.
			return { workMode: 'aw', approval: 'universal_accept', network: true, confinement: { read: false, write: false } };
		default:
			return { workMode: 'sw', approval: 'manual', network: false, confinement: WORKSPACE_BOUNDARY };
	}
}

/**
 * The boundary the shipped settings use, and the one every preset but `full` restores: writes stay
 * inside the working directory, reads do not. Confining reads is opt-in, because it costs commands
 * like `git` and `npm` access to their per-user configuration.
 */
export const WORKSPACE_BOUNDARY: Confinement = { read: false, write: true };

export function capabilityAllowed(capability: Capability, mode: WorkMode): boolean {
	return MODE_CAPS[mode].has(capability);
}

/**
 * The whitelist's built-in contents: read-only calls, plus the plan tools (which only `pl` mode
 * grants anyway). The whitelist itself is `comonad.permissions.allow`, which adds to this list.
 */
const DEFAULT_WHITELIST: ReadonlySet<Capability> = new Set(['ro', 'shell_ro', 'rw_plan']);

/**
 * The blacklist's built-in contents: everything that can write. `comonad.permissions.deny` adds to
 * this list, and — unlike the built-in defaults — those deny rules reject in every policy.
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
 * What the gate is told about the host and the session: the sandbox it will run on, the setting that
 * opts out of the no-sandbox prompt, and — when known — the files and directories this session
 * created plus symlink-aware containment for deletions. All of it is read afresh every turn.
 */
export interface GateEnvironment {
	sandbox: SandboxKind;
	allowUnsandboxedShell: boolean;
	/** Workspace-relative files this session created; absent disables the rm exemption. */
	created?: ReadonlySet<string>;
	/** Workspace-relative directories this session created; their subtrees are the session's too. */
	createdDirs?: ReadonlySet<string>;
	/** Symlink-aware containment for a deletion target; production always supplies one. */
	deletionStaysInside?: (absoluteTarget: string) => boolean;
	/** True for a path under a tree only this session can write (its scratch roots). */
	deletionScratch?: (absoluteTarget: string) => boolean;
}

export interface GateResult {
	decision: 'allow' | 'confirm' | 'reject';
	reason: string;
	/** A confirmation a subagent's delegated approval must not answer. */
	escalated?: boolean;
}

const EMPTY_PATHS: ReadonlySet<string> = new Set();

export function gateCalls(
	calls: ToolCall[],
	lookup: (name: string) => ToolSpec | undefined,
	policy: SessionPolicy,
	rules: RuleSet,
	env: GateEnvironment,
): GateResult {
	let confirm = '';
	let escalated = false;
	for (const call of calls) {
		const tool = lookup(call.name);
		if (!tool) {
			return { decision: 'reject', reason: `unknown tool: ${call.name}` };
		}
		if (!capabilityAllowed(tool.capability, policy.workMode)) {
			return { decision: 'reject', reason: `tool ${call.name} (${tool.capability}) is not allowed in mode ${policy.workMode}` };
		}
		if (tool.needsNetwork && !policy.network) {
			return { decision: 'reject', reason: `tool ${call.name} requires network, which is off` };
		}
		if (tool.needsWorkspace && !policy.workingDirectory.trim()) {
			return { decision: 'reject', reason: `tool ${call.name} needs a working directory` };
		}
		// "Reject all" means every call, so it is settled before rules and escalations can turn one
		// into an approval prompt.
		if (policy.approval === 'universal_reject') {
			return { decision: 'reject', reason: 'approval policy rejects all calls' };
		}
		// The test shell's whole contract is an OS-enforced read-only workspace. Without a sandbox
		// there is nothing to enforce it with, so no rule and no policy can turn it on.
		if (tool.capability === 'shell_test' && env.sandbox === 'none') {
			return { decision: 'reject', reason: `${call.name} needs an OS sandbox to keep the workspace read-only; none is available` };
		}
		const denied = rules.deny.find((rule) => ruleMatches(rule, call, tool));
		if (denied) {
			return { decision: 'reject', reason: `deny rule ${ruleText(denied)} blocks ${call.name}` };
		}
		// What would make this call unsafe to answer by delegation, whichever confirmation it ends
		// up with: no sandbox for a shell command, a tool that names itself unsandboxed, a dangerous
		// command, or a rule the user wrote to ask about. An explicit allow rule — including "Always
		// allow" — remains consent.
		const shell = isShellCapability(tool.capability);
		const unconfined = !env.allowUnsandboxedShell && env.sandbox === 'none' && shell;
		const outside = tool.name.endsWith('_unsandboxed');
		const dangerous = isDangerous(
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
		if (rules.ask.some((rule) => ruleMatches(rule, call, tool))) {
			confirm ||= `ask rule matches ${call.name}`;
			escalated = true;
			continue;
		}
		if (rules.allow.some((rule) => ruleMatches(rule, call, tool))) {
			continue;
		}
		// Escalation and dangerous commands never run silently under an accept policy. The tool-name
		// suffix is a convention, not a list: the shipped tree registers no unsandboxed tool, but a
		// plugin of yours may register one, and that is the call this catches.
		if (unconfined) {
			escalated = true;
			confirm ||= `no OS sandbox is available; ${call.name} would run unconfined`;
			continue;
		}
		if (outside) {
			escalated = true;
			confirm ||= `${call.name} runs outside the OS sandbox`;
			continue;
		}
		if (dangerous) {
			escalated = true;
			confirm ||= `dangerous command requires explicit confirmation (${call.name})`;
			continue;
		}
		switch (policy.approval) {
			case 'universal_accept':
				break;
			case 'manual':
				confirm ||= 'manual approval';
				break;
			case 'blacklist_reject':
				// The blacklist is the write-capable default plus `permissions.deny`, applied above.
				if (blacklistedByDefault(tool.capability)) {
					return { decision: 'reject', reason: `blacklist policy rejects write tool ${call.name}` };
				}
				break;
			case 'whitelist_accept':
				// The whitelist is `permissions.allow`, already applied above, plus the read-only default.
				if (!whitelistedByDefault(tool.capability)) {
					confirm ||= `whitelist policy asks for ${call.name}`;
				}
				break;
		}
	}
	if (confirm) {
		return escalated ? { decision: 'confirm', reason: confirm, escalated: true } : { decision: 'confirm', reason: confirm };
	}
	return { decision: 'allow', reason: 'allowed by policy' };
}

function ruleText(rule: PolicyRule): string {
	return rule.pattern ? `${rule.tool}(${rule.pattern})` : rule.tool;
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

/**
 * Mermaid source for the tool-call gate, generated from the tables above so the diagram shown in
 * the settings panel's Flow tab cannot drift from `gateCalls`.
 *
 * Shape: the mode / network / workspace checks, the test-shell sandbox check and the reject-all
 * short-circuit first, then two
 * frames — the user's rules and the remaining approval policies, with the built-in no-sandbox /
 * unsandboxed / dangerous-command escalation between them. Every gate ends in **its own**
 * `Rejected` / `Asks you` / `Runs` node directly below it: sharing one sink per outcome made every
 * edge run back across the whole chart. Only edges whose two ends are both inside a frame may be
 * written inside that frame — mermaid pulls both ends of an inner edge into the subgraph, which
 * would otherwise swallow the outcome nodes and the frame label.
 */
export function gateFlow(): string {
	return [
		'flowchart TD',
		// `call` and `end` are mermaid keywords, so the entry node is `entry`. The gates are
		// hexagons: a diamond grows with its label width, which made this chart 2.5× taller than the
		// pane and shrank the text to nothing.
		'  entry(["a tool call"])',
		'  entry --> mode{{"in the work mode set?"}}',
		'  mode -- no --> modeNo(["Rejected"])',
		'  mode --> net{{"network ok?"}}',
		'  net -- no --> netNo(["Rejected"])',
		'  net --> ws{{"workspace ok?"}}',
		'  ws -- no --> wsNo(["Rejected"])',
		'  ws --> testShellQ{{"test shell without an OS sandbox?"}}',
		'  testShellQ -- yes --> testShellNo(["Rejected"])',
		'  testShellQ -- no --> rejectAllQ{{"approval policy universal_reject?"}}',
		'  rejectAllQ -- yes --> rejectAll(["Rejected"])',
		'  rejectAllQ -- no --> deny',
		'',
		'  subgraph rules["your rules"]',
		'    deny{{"deny rule matches?"}}',
		'    ask{{"ask rule matches?"}}',
		'    allow{{"allow rule matches?"}}',
		'    deny -- no --> ask',
		'    ask -- no --> allow',
		'  end',
		'',
		'  deny -- yes --> denyReject(["Rejected"])',
		'  ask -- yes --> askConfirm(["Asks you"])',
		'  allow -- yes --> allowRun(["Runs"])',
		'  allow -- no --> sandbox{{"no OS sandbox and shell?"}}',
		'  sandbox -- yes --> sandboxConfirm(["Asks you"])',
		'  sandbox -- no --> danger{{"unsandboxed or dangerous?"}}',
		'  danger -- yes --> dangerConfirm(["Asks you"])',
		'  danger -- no --> approval',
		'',
		'  subgraph policy["approval policy"]',
		'    approval{{"no rule matched — which policy?"}}',
		'    policyManual["manual"]',
		'    policyAccept["universal_accept"]',
		'    policyWhitelist["whitelist_accept"]',
		'    policyBlacklist["blacklist_reject"]',
		'    approval --> policyManual',
		'    approval --> policyAccept',
		'    approval --> policyWhitelist',
		'    approval --> policyBlacklist',
		'  end',
		'',
		'  policyManual --> manualConfirm(["Asks you"])',
		'  policyAccept --> runAll(["Runs"])',
		'  policyWhitelist --> whitelist{{"in the whitelist?"}}',
		'  whitelist -- yes --> whitelistRun(["Runs"])',
		'  whitelist -- no --> whitelistConfirm(["Asks you"])',
		'  policyBlacklist --> blacklist{{"in the blacklist?"}}',
		'  blacklist -- yes --> blacklistReject(["Rejected"])',
		'  blacklist -- no --> blacklistRun(["Runs"])',
		'',
		'  style rules fill:transparent,stroke:#8a8a8a,stroke-dasharray:4 4',
		'  style policy fill:transparent,stroke:#8a8a8a,stroke-dasharray:4 4',
		'  classDef reject fill:#6d2f2f,stroke:#c26060,color:#ffffff',
		'  classDef confirm fill:#6d5620,stroke:#d5a33a,color:#ffffff',
		'  classDef run fill:#1e5c39,stroke:#43b581,color:#ffffff',
		'  class modeNo,netNo,wsNo,testShellNo,denyReject,rejectAll,blacklistReject reject',
		'  class askConfirm,sandboxConfirm,dangerConfirm,manualConfirm,whitelistConfirm confirm',
		'  class allowRun,runAll,whitelistRun,blacklistRun run',
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
