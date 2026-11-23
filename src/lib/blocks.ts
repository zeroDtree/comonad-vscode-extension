// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The stable names of Comonad's own prompt blocks. The Prompts tab orders and switches these, but
 * their text is generated every turn, so the identifiers — not the text — are the contract.
 *
 * This module is pure: no `vscode`, no `cordis`, and no import from a plugin.
 */

/** The identifiers, named for the code that builds a block. */
export const COMONAD_BLOCK = {
	identity: 'comonad',
	tools: 'comonad-tools',
	instructions: 'comonad-instructions',
	memory: 'comonad-memory',
	todos: 'comonad-todos',
	skills: 'comonad-skills',
	orchestrator: 'comonad-orchestrator',
	context: 'comonad-context',
} as const;

export type ComonadBlockId = (typeof COMONAD_BLOCK)[keyof typeof COMONAD_BLOCK];

/** The blocks in the order the default layout places them, with the name the panel shows. */
export const COMONAD_BLOCKS: readonly { id: ComonadBlockId; name: string }[] = [
	{ id: COMONAD_BLOCK.identity, name: 'Identity' },
	{ id: COMONAD_BLOCK.tools, name: 'Tools' },
	{ id: COMONAD_BLOCK.instructions, name: 'Instructions' },
	{ id: COMONAD_BLOCK.memory, name: 'Memory' },
	{ id: COMONAD_BLOCK.todos, name: 'Todos' },
	{ id: COMONAD_BLOCK.skills, name: 'Skills' },
	{ id: COMONAD_BLOCK.orchestrator, name: 'Orchestration' },
	{ id: COMONAD_BLOCK.context, name: 'Context' },
];

/**
 * The static opening of each block. It is the part a user may edit in the Prompts tab; everything
 * the agent generates for the turn is appended after it.
 */
export const DEFAULT_BLOCK_PREFIX: Record<ComonadBlockId, string> = {
	[COMONAD_BLOCK.identity]:
		'You are Comonad, an agentic coding assistant running inside VS Code.\nNever ask the user for permission in your reply; the host asks whenever a tool needs approval.',
	[COMONAD_BLOCK.tools]:
		'Inspect the workspace with the provided tools before editing. Call a tool by name with JSON arguments; never write a tool call into your reply as text.',
	[COMONAD_BLOCK.instructions]: 'Project instructions:',
	[COMONAD_BLOCK.memory]: 'Memory from earlier sessions:',
	[COMONAD_BLOCK.todos]: 'Current todo list:',
	[COMONAD_BLOCK.skills]: 'Skills (load one with the skill tool before following it):',
	[COMONAD_BLOCK.orchestrator]: 'You are the Orchestrator: answer directly when the work is trivial; otherwise plan, delegate, verify, and deliver.',
	[COMONAD_BLOCK.context]: 'Context:',
};

/** What a turn says when the policy, the mode or a silent generation offers no tools. */
export const NO_TOOLS_PREFIX = 'This turn offers no tools: answer from the conversation and your own knowledge.';

/**
 * One named part of the system prompt, as the agent hands it to a composer. `prefix` is the
 * user-editable static part; `body` is generated for the turn; `text` is what is actually sent.
 */
export interface PromptBlock {
	id: ComonadBlockId;
	name: string;
	/** The configured static opening; a caller that only composes text may omit the split. */
	prefix?: string;
	/** The dynamic part generated for this turn; omitted when only `text` is known. */
	body?: string;
	text: string;
}

/** Joins a block's static prefix and its generated body. Both are trimmed independently. */
export function composeBlockText(prefix: string, body: string, separator = '\n'): string {
	const head = prefix.trim();
	const tail = body.trim();
	return head && tail ? `${head}${separator}${tail}` : head || tail;
}

/** Every identifier, in the order the default collection places them. */
export const COMONAD_BLOCK_IDS: readonly ComonadBlockId[] = COMONAD_BLOCKS.map((block) => block.id);

const COMONAD_IDS: ReadonlySet<string> = new Set<string>(COMONAD_BLOCK_IDS);

/** Whether an identifier names one of Comonad's generated blocks. */
export function isComonadBlockId(value: string): value is ComonadBlockId {
	return COMONAD_IDS.has(value);
}
