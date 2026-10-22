// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RM_PATTERN, rmInvocations, type RmOperand } from './shell';

/**
 * Whether every `rm` in a command deletes only what this session owns.
 *
 * A literal operand is checked against the workspace and the session's created set. A dynamic one —
 * a glob, or a variable the sandboxed shell sets — is expanded first, so `rm -f "$TMPDIR/out"/*.png`
 * is known to delete the test shell's own scratch files rather than the user's. Anything the
 * expansion cannot prove (an unknown variable, command substitution, a recursive rm, an unreadable
 * directory) stays dangerous and asks the user. This module reads the filesystem; the command
 * scanner it builds on stays pure.
 */

export interface DeletionExpansion {
	/** Variables the command's shell sets; `$NAME` expands only when it names one of these. */
	variables?: Record<string, string>;
	/** True when the absolute target is inside a tree only this session can write (the test scratch). */
	scratch?: (absoluteTarget: string) => boolean;
}

export function deletionTargetsAreOwned(
	command: string,
	workspace: string,
	created: ReadonlySet<string>,
	inside?: (absoluteTarget: string) => boolean,
	expansion: DeletionExpansion = {},
): boolean {
	if (!workspace.trim()) {
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
	const root = resolve(workspace);
	for (const invocation of invocations) {
		if (invocation.recursive) {
			return false;
		}
		for (const operand of invocation.operands) {
			const targets = expandOperand(operand, invocation.cwd, root, expansion.variables ?? {});
			if (!targets) {
				return false;
			}
			for (const target of targets) {
				// The test shell's scratch is its own: only this chat's commands can write there.
				if (expansion.scratch?.(target)) {
					continue;
				}
				const rel = relative(root, target);
				if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
					return false;
				}
				if (inside && !inside(target)) {
					return false;
				}
				if (!created.has(rel.split(sep).join('/'))) {
					return false;
				}
			}
		}
	}
	return true;
}

/** A glob can name a whole tree; past this many matches the expansion is treated as unprovable. */
const MAX_MATCHES = 4096;

function expandOperand(operand: RmOperand, cwd: string, root: string, variables: Record<string, string>): string[] | undefined {
	if (operand.literal) {
		return [resolve(root, cwd, operand.value)];
	}
	const pattern = expandWord(operand.raw, variables);
	if (pattern === undefined) {
		return undefined;
	}
	const plain = unescape(pattern);
	if (!hasGlob(pattern)) {
		return [resolve(root, cwd, plain)];
	}
	return expandGlob(pattern, cwd, root);
}

/**
 * Rewrites one word the way the shell would, keeping only the expansions the gate can prove:
 * quotes, backslash escapes, the variables in `variables`, and the globs `*`/`?`. Command
 * substitution, unknown variables, `[` classes and `~` make the word unprovable.
 *
 * The result is a pattern string: glob metacharacters stay active, and every literal metacharacter
 * is escaped with a backslash.
 */
function expandWord(raw: string, variables: Record<string, string>): string | undefined {
	let out = '';
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < raw.length; ) {
		const char = raw[i]!;
		if (!quote && (char === '"' || char === "'")) {
			quote = char;
			i += 1;
			continue;
		}
		if (quote === "'") {
			if (char === "'") {
				quote = undefined;
			} else {
				out += escapeGlob(char);
			}
			i += 1;
			continue;
		}
		if (quote === '"') {
			if (char === '"') {
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
				if (next === '$' || next === '`' || next === '"' || next === '\\') {
					out += escapeGlob(next);
					i += 2;
					continue;
				}
				out += escapeGlob('\\');
				i += 1;
				continue;
			}
			if (char === '`') {
				return undefined;
			}
			if (char === '$') {
				const ref = readVariable(raw, i);
				const value = ref ? variables[ref.name] : undefined;
				if (!ref || value === undefined) {
					return undefined;
				}
				out += literal(value);
				i = ref.end;
				continue;
			}
			out += escapeGlob(char);
			i += 1;
			continue;
		}
		// Unquoted.
		if (char === '\\') {
			const next = raw[i + 1];
			if (next === undefined) {
				return undefined;
			}
			out += escapeGlob(next);
			i += 2;
			continue;
		}
		if (char === '`') {
			return undefined;
		}
		if (char === '$') {
			const ref = readVariable(raw, i);
			const value = ref ? variables[ref.name] : undefined;
			if (!ref || value === undefined) {
				return undefined;
			}
			// An unquoted variable is split and globbed by the shell; a value with either could turn
			// one operand into several, so only a plain path may pass unquoted.
			if (/[\s*?[\]]/.test(value)) {
				return undefined;
			}
			out += literal(value);
			i = ref.end;
			continue;
		}
		if (char === '*' || char === '?') {
			out += char;
			i += 1;
			continue;
		}
		if (char === '[' || char === ']') {
			return undefined;
		}
		if (char === '~' && out === '') {
			return undefined;
		}
		out += escapeGlob(char);
		i += 1;
	}
	return quote ? undefined : out;
}

/** `$NAME` or `${NAME}` only: process state (`$?`, `$1`) and substitutions are unprovable. */
function readVariable(raw: string, at: number): { name: string; end: number } | undefined {
	let index = at + 1;
	if (raw[index] === '{') {
		const close = raw.indexOf('}', index + 1);
		if (close < 0) {
			return undefined;
		}
		const name = raw.slice(index + 1, close);
		return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? { name, end: close + 1 } : undefined;
	}
	const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(index));
	return match ? { name: match[0], end: index + match[0].length } : undefined;
}

/** Every character escaped, so a substituted value is a literal path rather than a pattern. */
function literal(text: string): string {
	return [...text].map(escapeGlob).join('');
}

function escapeGlob(char: string): string {
	return char === '*' || char === '?' || char === '[' || char === ']' || char === '\\' ? `\\${char}` : char;
}

function unescape(pattern: string): string {
	let out = '';
	for (let i = 0; i < pattern.length; i += 1) {
		if (pattern[i] === '\\' && i + 1 < pattern.length) {
			out += pattern[i + 1];
			i += 1;
			continue;
		}
		out += pattern[i];
	}
	return out;
}

function hasGlob(pattern: string): boolean {
	for (let i = 0; i < pattern.length; i += 1) {
		if (pattern[i] === '\\') {
			i += 1;
			continue;
		}
		if (pattern[i] === '*' || pattern[i] === '?') {
			return true;
		}
	}
	return false;
}

/** Expands a pattern one path segment at a time, the way the shell's own globbing would. */
function expandGlob(pattern: string, cwd: string, root: string): string[] | undefined {
	const full = isAbsolute(pattern) ? pattern : `${resolve(root, cwd)}/${pattern}`;
	const absolute = full.startsWith('/');
	const segments = full.split('/').filter((segment, index) => segment || index > 0);
	let paths = [absolute ? '/' : '.'];
	for (const segment of segments) {
		if (!segment || segment === '.') {
			continue;
		}
		const next: string[] = [];
		for (const base of paths) {
			if (!hasGlob(segment)) {
				next.push(resolve(base, unescape(segment)));
				continue;
			}
			const expression = segmentExpression(segment);
			if (!expression) {
				return undefined;
			}
			let names: string[];
			try {
				names = readdirSync(base);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				// A branch that is not there simply has no matches; anything else is unreadable.
				if (code === 'ENOENT' || code === 'ENOTDIR') {
					continue;
				}
				return undefined;
			}
			const visible = unescape(segment).startsWith('.');
			for (const name of names) {
				if (!visible && name.startsWith('.')) {
					continue;
				}
				if (expression.test(name)) {
					next.push(join(base, name));
				}
			}
		}
		if (!next.length || next.length > MAX_MATCHES) {
			// A glob with nothing to match is not a no-op this check can prove: an earlier command in
			// the same line may create the files before the rm expands them.
			return undefined;
		}
		paths = next;
	}
	return paths;
}

function segmentExpression(segment: string): RegExp | undefined {
	let out = '^';
	for (let i = 0; i < segment.length; i += 1) {
		const char = segment[i]!;
		if (char === '\\') {
			const next = segment[i + 1];
			if (next === undefined) {
				return undefined;
			}
			out += regexEscape(next);
			i += 1;
			continue;
		}
		if (char === '*') {
			out += '[^/]*';
			continue;
		}
		if (char === '?') {
			out += '[^/]';
			continue;
		}
		out += regexEscape(char);
	}
	return new RegExp(`${out}$`);
}

function regexEscape(char: string): string {
	return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}
