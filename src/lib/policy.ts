import type { Approval, Capability, SessionPolicy, ToolCall, ToolSpec, WorkMode } from './types';

/** Modes, capability gating, permission rules and the approval gate. Pure module. */

export const MODE_CAPS: Record<WorkMode, ReadonlySet<Capability>> = {
	chat: new Set(),
	ro: new Set(['ro', 'shell_ro']),
	sw: new Set(['ro', 'rw', 'shell_ro']),
	aw: new Set(['ro', 'rw', 'shell_ro', 'shell_rw']),
	pl: new Set(['ro', 'shell_ro', 'rw_plan']),
};

export const MODE_LABELS: Record<WorkMode, string> = {
	chat: 'Chat Only — no tools, plain conversation',
	ro: 'Read-Only — read files, read-only shell',
	sw: 'Semi-Write — write files, read-only shell',
	aw: 'Full Access — write files, full shell',
	pl: 'Plan — read files, read-only shell, writes plan files only',
};

export const APPROVAL_LABELS: Record<Approval, string> = {
	manual: 'Ask — confirm every tool call',
	universal_reject: 'Reject all — never run tools',
	blacklist_reject: 'Blacklist — reject the blacklisted calls, run the rest',
	whitelist_accept: 'Whitelist — run the whitelisted calls, ask for the rest',
	universal_accept: 'Accept all — run everything the mode allows',
};

export const PRESET_LABELS: Record<string, string> = {
	ask: 'Ask — edit files with approval, sandboxed shell',
	plan: 'Plan — research read-only, write a plan',
	auto: 'Auto — apply edits automatically, no network',
	readonly: 'Read only — inspect without changes',
	full: 'Unrestricted — no sandbox, network on (careful)',
};

export function presetPolicy(preset: string): { workMode: WorkMode; approval: Approval; network: boolean } {
	switch (preset) {
		case 'plan':
			return { workMode: 'pl', approval: 'whitelist_accept', network: false };
		case 'auto':
			return { workMode: 'aw', approval: 'universal_accept', network: false };
		case 'readonly':
			return { workMode: 'ro', approval: 'whitelist_accept', network: false };
		case 'full':
			return { workMode: 'aw', approval: 'universal_accept', network: true };
		default:
			return { workMode: 'sw', approval: 'manual', network: false };
	}
}

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
const DEFAULT_BLACKLIST: ReadonlySet<Capability> = new Set(['rw', 'shell_rw', 'rw_plan']);

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
	if (tool?.capability === 'shell_ro' || tool?.capability === 'shell_rw') {
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

export interface GateResult {
	decision: 'allow' | 'confirm' | 'reject';
	reason: string;
}

export function gateCalls(
	calls: ToolCall[],
	lookup: (name: string) => ToolSpec | undefined,
	policy: SessionPolicy,
	rules: RuleSet,
): GateResult {
	let confirm = '';
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
		const denied = rules.deny.find((rule) => ruleMatches(rule, call, tool));
		if (denied) {
			return { decision: 'reject', reason: `deny rule ${ruleText(denied)} blocks ${call.name}` };
		}
		if (rules.ask.some((rule) => ruleMatches(rule, call, tool))) {
			confirm ||= `ask rule matches ${call.name}`;
			continue;
		}
		if (rules.allow.some((rule) => ruleMatches(rule, call, tool))) {
			continue;
		}
		// Escalation and dangerous commands never run silently, even under accept policies.
		if (tool.name.endsWith('_unsandboxed')) {
			confirm ||= `${call.name} runs outside the OS sandbox`;
			continue;
		}
		if (isDangerous(call, tool)) {
			confirm ||= `dangerous command requires explicit confirmation (${call.name})`;
			continue;
		}
		switch (policy.approval) {
			case 'universal_reject':
				return { decision: 'reject', reason: 'approval policy rejects all calls' };
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
		return { decision: 'confirm', reason: confirm };
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
 * Shape: the mode / network / workspace checks first, then two frames — the user's rules and the
 * approval policy, with the built-in unsandboxed / dangerous-command escalation between them. Every
 * gate ends in **its own** `Rejected` / `Asks you` / `Runs` node directly below it: sharing one sink
 * per outcome made every edge run back across the whole chart. Only edges whose two ends are both
 * inside a frame may be written inside that frame — mermaid pulls both ends of an inner edge into
 * the subgraph, which would otherwise swallow the outcome nodes and the frame label.
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
		'  ws --> deny',
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
		'  allow -- no --> danger{{"unsandboxed or dangerous?"}}',
		'  danger -- yes --> dangerConfirm(["Asks you"])',
		'  danger -- no --> approval',
		'',
		'  subgraph policy["approval policy"]',
		'    approval{{"no rule matched — which policy?"}}',
		'    policyManual["manual"]',
		'    policyReject["universal_reject"]',
		'    policyAccept["universal_accept"]',
		'    policyWhitelist["whitelist_accept"]',
		'    policyBlacklist["blacklist_reject"]',
		'    approval --> policyManual',
		'    approval --> policyReject',
		'    approval --> policyAccept',
		'    approval --> policyWhitelist',
		'    approval --> policyBlacklist',
		'  end',
		'',
		'  policyManual --> manualConfirm(["Asks you"])',
		'  policyReject --> rejectAll(["Rejected"])',
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
		'  class modeNo,netNo,wsNo,denyReject,rejectAll,blacklistReject reject',
		'  class askConfirm,dangerConfirm,manualConfirm,whitelistConfirm confirm',
		'  class allowRun,runAll,whitelistRun,blacklistRun run',
	].join('\n');
}

const DANGEROUS_PATTERNS: RegExp[] = [
	/\brm\s+(-[a-z-]*[rf][a-z-]*\s+)+\S/i,
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

/** Flags shell commands that deserve an explicit prompt even when the policy auto-approves. */
export function isDangerous(call: ToolCall, tool: ToolSpec | undefined): boolean {
	if (tool?.capability !== 'shell_ro' && tool?.capability !== 'shell_rw') {
		return false;
	}
	const command = callTarget(call, tool);
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
	if (tool?.capability === 'shell_ro' || tool?.capability === 'shell_rw') {
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
