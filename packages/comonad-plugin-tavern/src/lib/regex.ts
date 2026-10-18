import type { RegexScript } from './types';

/**
 * Regex scripts: the find-and-replace pass SillyTavern runs over prompts, replies and world info.
 * A script says *where* it applies (`placement`), whether it wants markdown, prompt or raw text,
 * how deep in the chat it is allowed, and how macros inside its pattern are treated.
 */

/** Where a regex script applies, verbatim from SillyTavern's `regex_placement`. */
export const REGEX_PLACEMENT = {
	userInput: 1,
	aiOutput: 2,
	slashCommand: 3,
	worldInfo: 5,
	reasoning: 6,
} as const;

/** How macros inside `findRegex` are treated, verbatim from `substitute_find_regex`. */
export const SUBSTITUTE_REGEX = {
	none: 0,
	raw: 1,
	escaped: 2,
} as const;

export interface RegexContext {
	/** One of `REGEX_PLACEMENT`: which text is being rewritten. */
	placement: number;
	/** The text is already rendered markdown. */
	isMarkdown?: boolean;
	/** The text is on its way to the model. */
	isPrompt?: boolean;
	/** The message is being edited, so only scripts that opt in run. */
	isEdit?: boolean;
	/** Distance from the newest message, for the min/max depth gate. */
	depth?: number;
	/** Resolves macros inside the pattern, for `substituteRegex`. */
	substitute?: (text: string, escape?: (value: string) => string) => string;
}

/** A fresh script with every field a SillyTavern script carries. */
export function makeScript(patch: Partial<RegexScript> = {}): RegexScript {
	return {
		id: patch.id ?? `regex-${Math.random().toString(36).slice(2, 10)}`,
		scriptName: patch.scriptName ?? 'Untitled',
		findRegex: patch.findRegex ?? '',
		replaceString: patch.replaceString ?? '',
		trimStrings: patch.trimStrings ?? [],
		placement: patch.placement ?? [REGEX_PLACEMENT.aiOutput],
		disabled: patch.disabled ?? false,
		markdownOnly: patch.markdownOnly ?? false,
		promptOnly: patch.promptOnly ?? false,
		runOnEdit: patch.runOnEdit ?? false,
		substituteRegex: patch.substituteRegex ?? SUBSTITUTE_REGEX.none,
		minDepth: patch.minDepth ?? null,
		maxDepth: patch.maxDepth ?? null,
	};
}

/** Escapes a macro value so it can sit inside a regular expression literally. */
export function escapeForRegex(value: string): string {
	return value.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, (character) => {
		switch (character) {
			case '\n':
				return '\\n';
			case '\r':
				return '\\r';
			case '\t':
				return '\\t';
			case '\v':
				return '\\v';
			case '\f':
				return '\\f';
			case '\0':
				return '\\0';
			default:
				return `\\${character}`;
		}
	});
}

/**
 * Compiles a `findRegex`. `/pattern/flags` is honoured; anything else is a plain pattern, which —
 * as in SillyTavern — replaces only its first match because it carries no flags.
 */
export function regexFromString(input: string): RegExp | null {
	if (!input) {
		return null;
	}
	try {
		const match = /^(\/?)(.+)\1([a-z]*)$/is.exec(input);
		if (match?.[3]) {
			return new RegExp(match[2], match[3]);
		}
		return new RegExp(match?.[2] ?? input);
	} catch {
		return null;
	}
}

/** Whether a script applies to this text at all. */
function applies(script: RegexScript, context: RegexContext): boolean {
	if (script.disabled || !script.findRegex) {
		return false;
	}
	const markdown = script.markdownOnly === true;
	const prompt = script.promptOnly === true;
	const wanted =
		(markdown && context.isMarkdown === true) ||
		(prompt && context.isPrompt === true) ||
		(!markdown && !prompt && context.isMarkdown !== true && context.isPrompt !== true);
	if (!wanted) {
		return false;
	}
	if (context.isEdit && script.runOnEdit !== true) {
		return false;
	}
	if (typeof context.depth === 'number') {
		const { minDepth, maxDepth } = script;
		if (typeof minDepth === 'number' && minDepth >= -1 && context.depth < minDepth) {
			return false;
		}
		if (typeof maxDepth === 'number' && maxDepth >= 0 && context.depth > maxDepth) {
			return false;
		}
	}
	return Array.isArray(script.placement) ? script.placement.includes(context.placement) : false;
}

/** Runs one script over one string. */
export function runScript(script: RegexScript, text: string, context: RegexContext): string {
	if (!applies(script, context) || !text) {
		return text;
	}
	let pattern = script.findRegex;
	if (script.substituteRegex === SUBSTITUTE_REGEX.raw && context.substitute) {
		pattern = context.substitute(pattern);
	} else if (script.substituteRegex === SUBSTITUTE_REGEX.escaped && context.substitute) {
		pattern = context.substitute(pattern, escapeForRegex);
	}
	const regex = regexFromString(pattern);
	if (!regex) {
		return text;
	}
	const replacement = script.replaceString.replace(/\{\{match\}\}/gi, '$0');
	// Capture groups are resolved by hand: `$0` is the whole match, `$1` the first group, `$<name>`
	// a named one — the same shapes SillyTavern's scripts are written against.
	let result = text.replace(regex, (...args: unknown[]) => {
		const whole = String(args[0] ?? '');
		const named = args[args.length - 1];
		return replacement.replace(/\$(\d+)|\$<([^>]+)>/g, (_match, number: string | undefined, name: string | undefined) => {
			if (number !== undefined) {
				const index = Number.parseInt(number, 10);
				return index === 0 ? whole : String(args[index] ?? '');
			}
			const group = named && typeof named === 'object' ? (named as Record<string, string>)[name ?? ''] : undefined;
			return group ?? '';
		});
	});
	for (const trim of script.trimStrings ?? []) {
		if (trim) {
			result = result.split(trim).join('');
		}
	}
	return result;
}

/** Runs every applicable script, in order. */
export function applyRegex(scripts: readonly RegexScript[], text: string, context: RegexContext): string {
	let result = text;
	for (const script of scripts) {
		result = runScript(script, result, context);
	}
	return result;
}

/** Reads scripts off a card or a settings blob, dropping anything that is not a script. */
export function regexScriptsFrom(value: unknown): RegexScript[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
		.filter((item) => typeof item.findRegex === 'string' && item.findRegex.length > 0)
		.map((item) => makeScript({ ...(item as Partial<RegexScript>), id: String(item.id ?? `regex-${Math.random().toString(36).slice(2, 10)}`) }));
}
