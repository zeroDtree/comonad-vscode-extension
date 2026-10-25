// SPDX-License-Identifier: AGPL-3.0-only
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { RM_PATTERN, rmInvocations, type RmOperand } from './shell';

/**
 * Whether every `rm` in a command deletes only what this session produced.
 *
 * Ownership is coarse on purpose: a path is owned when this session wrote it, when it lies under a
 * directory this session created, or when it lies under a tree only this session can write (the
 * workspace `.comonad/tmp`). The whole subtree of an owned directory is owned, so build output
 * written there by later commands is removable without a prompt. The test shell does not reach this
 * check: its OS sandbox keeps every write in its own scratch, so its rm never needs an opinion.
 *
 * A `*`/`?` glob is not expanded: it is enough that its fixed directory prefix is owned, because
 * nothing outside an owned tree can match. Anything the check cannot place under an owned root — an
 * unknown variable, a substitution, an unowned path — stays dangerous and asks the user. This
 * module reads no filesystem; the caller supplies the scratch containment.
 */

export interface DeletionOwnership {
	/** The session's working directory; owned paths are relative to it. */
	workspace: string;
	/** Workspace-relative files this session wrote. */
	files: ReadonlySet<string>;
	/** Workspace-relative directories this session created. Their whole subtree is owned. */
	dirs: ReadonlySet<string>;
	/** Symlink-aware containment for a target; production always supplies one. */
	inside?: (absoluteTarget: string) => boolean;
	/** True when an absolute path is inside a tree only this session can write. */
	scratch?: (absoluteTarget: string) => boolean;
}

export function deletionTargetsAreOwned(command: string, owned: DeletionOwnership): boolean {
	if (!owned.workspace.trim()) {
		return false;
	}
	const invocations = rmInvocations(command);
	if (!invocations || !invocations.length) {
		return false;
	}
	// Any raw `rm` match outside a parsed invocation fails the check: a hidden `rm -rf /` inside
	// `sh -c '...'` must not be excused by a safe-looking sibling.
	const raw = new RegExp(RM_PATTERN.source, 'gi');
	for (const match of command.matchAll(raw)) {
		const index = match.index ?? -1;
		if (!invocations.some((invocation) => index >= invocation.start && index < invocation.end)) {
			return false;
		}
	}
	const root = resolve(owned.workspace);
	for (const invocation of invocations) {
		// Recursion is not itself a reason to ask: removing an owned tree is the point. Every operand
		// still has to land under an owned root.
		for (const operand of invocation.operands) {
			const target = operandTarget(operand, invocation.cwd, root);
			if (!target || !isOwned(target, root, owned)) {
				return false;
			}
		}
	}
	return true;
}

interface OperandTarget {
	/** The absolute target, or the fixed directory prefix of a glob. */
	path: string;
	/** The word contains a real glob, so only an owned directory may excuse it. */
	glob: boolean;
}

/**
 * The path an operand reaches, or the fixed directory in front of its first glob. Quotes come off
 * and escapes are honoured; a variable, a command substitution, a `~` or a `[` class makes the word
 * unprovable. The test shell does not need any of this — its sandbox confines deletions — so only a
 * workspace-writable shell reaches here.
 */
function operandTarget(operand: RmOperand, cwd: string, root: string): OperandTarget | undefined {
	if (operand.literal) {
		return { path: resolve(root, cwd, operand.value), glob: false };
	}
	const raw = operand.raw;
	let text = '';
	let quote: '"' | "'" | undefined;
	let globAt = -1;
	for (let i = 0; i < raw.length; ) {
		const char = raw[i]!;
		if (quote !== "'" && (char === '`' || (char === '$' && raw[i + 1] === '('))) {
			return undefined;
		}
		if (!quote && (char === '"' || char === "'")) {
			quote = char;
			i += 1;
			continue;
		}
		if (quote === "'") {
			if (char === "'") {
				quote = undefined;
			} else {
				text += char;
			}
			i += 1;
			continue;
		}
		if (quote === '"' && char === '"') {
			quote = undefined;
			i += 1;
			continue;
		}
		if (char === '\\') {
			const next = raw[i + 1];
			if (next === undefined) {
				return undefined;
			}
			// In double quotes a backslash only escapes these; any other one stays literal.
			if (quote === '"' && !'$`"\\'.includes(next)) {
				text += '\\';
				i += 1;
				continue;
			}
			text += next;
			i += 2;
			continue;
		}
		if (char === '$') {
			return undefined;
		}
		if (char === '*' || char === '?') {
			if (globAt < 0) {
				globAt = text.length;
			}
			text += char;
			i += 1;
			continue;
		}
		if (char === '[' || char === ']' || (char === '~' && !quote && text === '')) {
			return undefined;
		}
		text += char;
		i += 1;
	}
	if (quote || !text) {
		return undefined;
	}
	if (globAt < 0) {
		return { path: resolve(root, cwd, text), glob: false };
	}
	const before = text.slice(0, globAt);
	const slash = before.lastIndexOf('/');
	const dir = slash < 0 ? '.' : before.slice(0, slash) || '/';
	return { path: resolve(root, cwd, dir), glob: true };
}

function isOwned(target: OperandTarget, root: string, owned: DeletionOwnership): boolean {
	// A session-only tree owns everything in it, wherever it lives.
	if (owned.scratch?.(target.path)) {
		return true;
	}
	const rel = relative(root, target.path);
	if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		return false;
	}
	if (owned.inside && !owned.inside(target.path)) {
		return false;
	}
	const clean = rel.split(sep).join('/');
	// A literal operand may name one file this session wrote. A glob needs a directory: its fixed
	// prefix could otherwise match files the session never touched.
	if (!target.glob && owned.files.has(clean)) {
		return true;
	}
	// The target itself or any ancestor directory this session created owns the subtree.
	if (owned.dirs.has(clean)) {
		return true;
	}
	for (let slash = clean.lastIndexOf('/'); slash > 0; slash = clean.lastIndexOf('/', slash - 1)) {
		if (owned.dirs.has(clean.slice(0, slash))) {
			return true;
		}
	}
	return false;
}
