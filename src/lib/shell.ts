// SPDX-License-Identifier: AGPL-3.0-only
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * A conservative scanner for the POSIX `sh` commands Comonad runs. It answers two questions for the
 * gate — may this `rm` be treated as deleting the session's own files, and what may this command
 * create — and it is deliberately not a shell: anything it cannot prove returns no answer, which the
 * callers treat as "ask the user". Pure module: `node:path` only.
 */

/** An rm with at least one short-flag group containing `r` or `f`, and a target. */
export const RM_PATTERN = /\brm\s+(-[a-z-]*[rf][a-z-]*\s+)+\S/i;

export interface RmInvocation {
	/** Offset of the `rm` word in the command. */
	start: number;
	/** Offset just past the simple command. */
	end: number;
	/** Model cwd at this invocation: workspace-relative POSIX, `.` at the root. */
	cwd: string;
	/** A recursive form was present (`-r`, `-R`, `-d`, `--recursive`, `--dir`). */
	recursive: boolean;
	/** Literal operands after quote removal. */
	operands: string[];
}

interface Word {
	value: string;
	literal: boolean;
	start: number;
	end: number;
}

interface Redirect {
	target: Word;
}

interface SimpleCommand {
	cwd: string;
	words: Word[];
	redirects: Redirect[];
	start: number;
	end: number;
}

const SPACE = new Set([' ', '\t', '\r']);

/**
 * Words whose simple command we cannot model. Compound syntax can change cwd in ways the `cd`
 * model does not see (`if … then cd …`), and `eval`/`.`/`source`/`pushd`/`command`/`builtin` can
 * too. A command containing any of them gets no exemption and lends no provenance.
 */
const UNMODELLED = new Set([
	'if',
	'then',
	'else',
	'elif',
	'fi',
	'for',
	'in',
	'do',
	'done',
	'while',
	'until',
	'case',
	'esac',
	'function',
	'select',
	'!',
	'time',
	'eval',
	'.',
	'source',
	'pushd',
	'popd',
	'builtin',
	'command',
	'exec',
	'alias',
	'unalias',
]);

/** Lexically joins a relative cwd and an operand; `undefined` when the result cannot be modelled. */
function joinRelative(cwd: string, operand: string): string | undefined {
	if (isAbsolute(operand) || operand.startsWith('~')) {
		return undefined;
	}
	const parts = (cwd === '.' ? [] : cwd.split('/')).concat(operand.split('/'));
	const out: string[] = [];
	for (const part of parts) {
		if (!part || part === '.') {
			continue;
		}
		if (part === '..') {
			if (out.length && out[out.length - 1] !== '..') {
				out.pop();
			} else {
				out.push('..');
			}
		} else {
			out.push(part);
		}
	}
	return out.length ? out.join('/') : '.';
}

/**
 * Splits a command into simple commands, modelling `cd` so later targets can be resolved. Returns
 * `undefined` for any construct whose effect cannot be proven: subshells, groups, heredocs,
 * background jobs, assignments, non-literal `cd`, unbalanced quotes, and unknown expansions.
 */
function scan(command: string): SimpleCommand[] | undefined {
	const commands: SimpleCommand[] = [];
	let words: Word[] = [];
	let redirects: Redirect[] = [];
	let cwd = '.';
	let start = -1;
	let piped = false;
	let i = 0;
	const n = command.length;

	const end = (pipeNext = false): boolean => {
		if (words.length || redirects.length) {
			const first = words[0];
			if (first && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first.value) || UNMODELLED.has(first.value))) {
				return false;
			}
			if (first?.value === 'cd') {
				// `cd` in a pipeline runs in a subshell and cannot change the parent's directory.
				if (piped || pipeNext) {
					return false;
				}
				const rest = words.slice(1);
				let index = 0;
				if (rest[index]?.value === '--') {
					index += 1;
				}
				const operand = rest[index];
				if (rest.length !== index + 1 || !operand?.literal || !operand.value || operand.value.startsWith('-')) {
					return false;
				}
				const moved = joinRelative(cwd, operand.value);
				if (moved === undefined) {
					return false;
				}
				cwd = moved;
			}
			commands.push({ cwd, words, redirects, start: start >= 0 ? start : i, end: i });
		}
		words = [];
		redirects = [];
		start = -1;
		piped = pipeNext;
		return true;
	};

	const skipBacktick = (): boolean => {
		i += 1;
		while (i < n) {
			if (command[i] === '\\') {
				i += 2;
				continue;
			}
			if (command[i] === '`') {
				i += 1;
				return true;
			}
			i += 1;
		}
		return false;
	};

	const skipParens = (): boolean => {
		let depth = 0;
		while (i < n) {
			const char = command[i];
			if (char === '\\') {
				i += 2;
				continue;
			}
			if (char === "'") {
				i += 1;
				while (i < n && command[i] !== "'") {
					i += 1;
				}
				if (i >= n) {
					return false;
				}
				i += 1;
				continue;
			}
			if (char === '"') {
				i += 1;
				while (i < n) {
					if (command[i] === '\\') {
						i += 2;
						continue;
					}
					if (command[i] === '"') {
						break;
					}
					i += 1;
				}
				if (i >= n) {
					return false;
				}
				i += 1;
				continue;
			}
			if (char === '(') {
				depth += 1;
				i += 1;
				continue;
			}
			if (char === ')') {
				depth -= 1;
				i += 1;
				if (depth === 0) {
					return true;
				}
				continue;
			}
			i += 1;
		}
		return false;
	};

	const skipBraces = (): boolean => {
		let depth = 0;
		while (i < n) {
			const char = command[i];
			if (char === '\\') {
				i += 2;
				continue;
			}
			if (char === '{') {
				depth += 1;
				i += 1;
				continue;
			}
			if (char === '}') {
				depth -= 1;
				i += 1;
				if (depth === 0) {
					return true;
				}
				continue;
			}
			i += 1;
		}
		return false;
	};

	const skipDollar = (): boolean => {
		if (command[i] !== '$') {
			return false;
		}
		const next = command[i + 1];
		if (next === '(') {
			i += 1;
			return skipParens();
		}
		if (next === '{') {
			i += 1;
			return skipBraces();
		}
		if (next === "'" || next === '"') {
			const quote = next;
			i += 2;
			while (i < n) {
				if (command[i] === '\\') {
					i += 2;
					continue;
				}
				if (command[i] === quote) {
					i += 1;
					return true;
				}
				i += 1;
			}
			return false;
		}
		i += 1;
		if (i < n && /[A-Za-z0-9_@*#$?!-]/.test(command[i]!)) {
			i += 1;
		}
		return true;
	};

	const readWord = (): Word | undefined => {
		const wordStart = i;
		let value = '';
		let literal = true;
		while (i < n) {
			const char = command[i]!;
			if (
				SPACE.has(char) ||
				char === ';' ||
				char === '\n' ||
				char === '|' ||
				char === '&' ||
				char === '<' ||
				char === '>' ||
				char === '(' ||
				char === ')' ||
				char === '{' ||
				char === '}'
			) {
				break;
			}
			if (char === "'") {
				i += 1;
				const closing = command.indexOf("'", i);
				if (closing < 0) {
					return undefined;
				}
				value += command.slice(i, closing);
				i = closing + 1;
				continue;
			}
			if (char === '"') {
				i += 1;
				let closed = false;
				while (i < n) {
					const inner = command[i]!;
					if (inner === '"') {
						i += 1;
						closed = true;
						break;
					}
					if (inner === '\\') {
						const escaped = command[i + 1];
						if (escaped === '$' || escaped === '`' || escaped === '"' || escaped === '\\') {
							value += escaped;
							i += 2;
							continue;
						}
						if (escaped === '\n') {
							i += 2;
							continue;
						}
						value += inner;
						i += 1;
						continue;
					}
					if (inner === '$') {
						literal = false;
						if (!skipDollar()) {
							return undefined;
						}
						continue;
					}
					if (inner === '`') {
						literal = false;
						if (!skipBacktick()) {
							return undefined;
						}
						continue;
					}
					value += inner;
					i += 1;
				}
				if (!closed) {
					return undefined;
				}
				continue;
			}
			if (char === '\\') {
				const escaped = command[i + 1];
				if (escaped === undefined) {
					return undefined;
				}
				if (escaped === '\n') {
					i += 2;
					continue;
				}
				value += escaped;
				i += 2;
				continue;
			}
			if (char === '$') {
				literal = false;
				if (!skipDollar()) {
					return undefined;
				}
				continue;
			}
			if (char === '`') {
				literal = false;
				if (!skipBacktick()) {
					return undefined;
				}
				continue;
			}
			if (char === '*' || char === '?' || char === '[') {
				literal = false;
				value += char;
				i += 1;
				continue;
			}
			if (char === '~' && value === '') {
				literal = false;
				value += char;
				i += 1;
				continue;
			}
			value += char;
			i += 1;
		}
		return { value, literal, start: wordStart, end: i };
	};

	const readRedirect = (): boolean => {
		if (command[i] !== '<') {
			return false;
		}
		if (command[i + 1] === '<' || command[i + 1] === '>') {
			return false;
		}
		i += 1;
		while (i < n && SPACE.has(command[i]!)) {
			i += 1;
		}
		if (i >= n) {
			return false;
		}
		if (command[i] === '&') {
			i += 1;
			while (i < n && /[0-9-]/.test(command[i]!)) {
				i += 1;
			}
			return true;
		}
		const target = readWord();
		return Boolean(target?.value);
	};

	const writeRedirect = (): boolean => {
		if (command[i] === '&') {
			i += 2;
			if (command[i] === '>') {
				i += 1;
			}
		} else {
			i += 1;
			if (command[i] === '>') {
				i += 1;
			} else if (command[i] === '|') {
				i += 1;
			}
		}
		while (i < n && SPACE.has(command[i]!)) {
			i += 1;
		}
		if (i >= n) {
			return false;
		}
		if (command[i] === '&') {
			i += 1;
			while (i < n && /[0-9-]/.test(command[i]!)) {
				i += 1;
			}
			return true;
		}
		const target = readWord();
		if (!target?.value) {
			return false;
		}
		redirects.push({ target });
		return true;
	};

	while (i < n) {
		while (i < n && SPACE.has(command[i]!)) {
			i += 1;
		}
		if (i >= n) {
			break;
		}
		const char = command[i]!;
		if (char === '\n' || char === ';') {
			i += 1;
			if (!end()) {
				return undefined;
			}
			continue;
		}
		if (char === '&') {
			if (command[i + 1] === '&') {
				i += 2;
				if (!end()) {
					return undefined;
				}
				continue;
			}
			if (command[i + 1] === '>') {
				if (!writeRedirect()) {
					return undefined;
				}
				continue;
			}
			return undefined;
		}
		if (char === '|') {
			if (command[i + 1] === '|') {
				i += 2;
				if (!end()) {
					return undefined;
				}
				continue;
			}
			i += 1;
			if (!end(true)) {
				return undefined;
			}
			continue;
		}
		if (char === '<') {
			if (!readRedirect()) {
				return undefined;
			}
			continue;
		}
		if (char === '>') {
			if (!writeRedirect()) {
				return undefined;
			}
			continue;
		}
		if (char === '(' || char === ')' || char === '{' || char === '}') {
			return undefined;
		}
		if (char === '#') {
			while (i < n && command[i] !== '\n') {
				i += 1;
			}
			continue;
		}
		const word = readWord();
		if (!word) {
			return undefined;
		}
		if (/^\d+$/.test(word.value) && word.literal && word.end === i && (command[i] === '>' || command[i] === '<')) {
			// A file-descriptor prefix such as `2>`; it is not a word.
			continue;
		}
		if (start < 0) {
			start = word.start;
		}
		words.push(word);
	}
	if (!end()) {
		return undefined;
	}
	return commands;
}

/** Every simple command whose first word is exactly `rm`, or `undefined` when anything is ambiguous. */
export function rmInvocations(command: string): RmInvocation[] | undefined {
	const commands = scan(command);
	if (!commands) {
		return undefined;
	}
	const found: RmInvocation[] = [];
	for (const simple of commands) {
		const first = simple.words[0];
		if (!first || !first.literal || first.value !== 'rm') {
			continue;
		}
		let recursive = false;
		let options = true;
		const operands: string[] = [];
		for (const word of simple.words.slice(1)) {
			if (options && word.value === '--') {
				options = false;
				continue;
			}
			if (options && word.value.startsWith('--')) {
				const name = word.value.split('=', 2)[0]!;
				if (name === '--recursive' || name === '--dir') {
					recursive = true;
					continue;
				}
				if (
					name === '--force' ||
					name === '--interactive' ||
					name === '--verbose' ||
					name === '--no-preserve-root' ||
					name === '--preserve-root' ||
					name === '--one-file-system'
				) {
					continue;
				}
				return undefined;
			}
			if (options && word.value.startsWith('-') && word.value !== '-') {
				for (const flag of word.value.slice(1)) {
					if (flag === 'r' || flag === 'R' || flag === 'd') {
						recursive = true;
					} else if (!'fiIv'.includes(flag)) {
						return undefined;
					}
				}
				continue;
			}
			if (!word.literal || !word.value) {
				return undefined;
			}
			operands.push(word.value);
		}
		if (!operands.length) {
			return undefined;
		}
		found.push({ start: first.start, end: simple.end, cwd: simple.cwd, recursive, operands });
	}
	return found;
}

/** Absolute operands of every parsed rm invocation; empty when the command is ambiguous. */
export function rmTargets(command: string, workspace: string): string[] {
	if (!workspace.trim()) {
		return [];
	}
	const invocations = rmInvocations(command);
	if (!invocations) {
		return [];
	}
	const root = resolve(workspace);
	const targets = new Set<string>();
	for (const invocation of invocations) {
		for (const operand of invocation.operands) {
			targets.add(resolve(root, invocation.cwd, operand));
		}
	}
	return [...targets];
}

/** Absolute workspace paths this command may create via `touch`, `tee` or a write redirection. */
export function creationTargets(command: string, workspace: string): string[] {
	if (!workspace.trim()) {
		return [];
	}
	const commands = scan(command);
	if (!commands) {
		return [];
	}
	const root = resolve(workspace);
	const targets = new Set<string>();
	const add = (cwd: string, operand: string): void => {
		if (!operand || operand.startsWith('&') || operand === '/dev/null') {
			return;
		}
		const target = resolve(root, cwd, operand);
		const rel = relative(root, target);
		if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
			return;
		}
		targets.add(target);
	};
	for (const simple of commands) {
		const first = simple.words[0];
		if (first?.literal && (first.value === 'touch' || first.value === 'tee')) {
			const operands: string[] = [];
			let options = true;
			let usable = true;
			for (const word of simple.words.slice(1)) {
				if (options && word.value === '--') {
					options = false;
					continue;
				}
				if (options && first.value === 'tee' && (word.value === '-a' || word.value === '--append')) {
					continue;
				}
				if (options && word.value.startsWith('-') && word.value !== '-') {
					usable = false;
					break;
				}
				if (!word.literal || !word.value || (first.value === 'tee' && word.value === '-')) {
					continue;
				}
				operands.push(word.value);
			}
			if (usable) {
				for (const operand of operands) {
					add(simple.cwd, operand);
				}
			}
		}
		for (const redirect of simple.redirects) {
			if (redirect.target.literal) {
				add(simple.cwd, redirect.target.value);
			}
		}
	}
	return [...targets];
}

/**
 * True only when every `rm` the command contains is literal, non-recursive, inside the workspace and
 * every operand is a path the session created. Any unparsed raw `rm` match fails the check: a hidden
 * `rm -rf /` inside `sh -c '...'` must not be excused by a safe-looking sibling.
 */
export function deletionTargetsAreOwned(
	command: string,
	workspace: string,
	created: ReadonlySet<string>,
	inside?: (absoluteTarget: string) => boolean,
): boolean {
	if (!workspace.trim()) {
		return false;
	}
	const invocations = rmInvocations(command);
	if (!invocations || !invocations.length) {
		return false;
	}
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
			const target = resolve(root, invocation.cwd, operand);
			const rel = relative(root, target);
			if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
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
	return true;
}
