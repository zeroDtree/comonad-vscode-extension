/**
 * Macro substitution, the SillyTavern way: `{{name}}` placeholders and the small set of function
 * macros that shipped presets, cards and world books actually use. Unknown macros are left exactly
 * as they are — a preset that mentions `{{words}}` is asking a later step to fill it in, not asking
 * us to delete it. Pure module: no `vscode`, no `cordis`.
 */

export interface MacroContext {
	/** `{{char}}`: the character's name, or a placeholder when no card is active. */
	char: string;
	/** `{{user}}`: the persona's name. */
	user: string;
	/** `{{persona}}`: the persona description. */
	persona?: string;
	description?: string;
	personality?: string;
	scenario?: string;
	/** `{{charPrompt}}`: the card's `system_prompt` override. */
	charPrompt?: string;
	/** `{{charInstruction}}`: the card's `post_history_instructions`. */
	charInstruction?: string;
	/** `{{charDepthPrompt}}`: the card's depth prompt. */
	charDepthPrompt?: string;
	charVersion?: string;
	creatorNotes?: string;
	/** `{{group}}`: reserved for group chats; empty in Comonad. */
	group?: string;
	/** `{{input}}`: the text the user just sent. */
	input?: string;
	/** `{{original}}`: the pre-replacement text, for regex scripts that rewrite in place. */
	original?: string;
	/** `{{model}}`: the model of the current chat. */
	model?: string;
}

export interface MacroOptions {
	/** Injectable for tests: `{{random}}`, `{{pick}}` and `{{roll}}` draw from this. */
	random?: () => number;
	now?: () => Date;
}

const NAME = /\{\{\s*([a-z0-9_./-]+)\s*\}\}/gi;
const CALL = /\{\{\s*([a-z0-9_]+)\s*:\s*([^{}]*?)\s*\}\}/gi;

/** The values a bare `{{name}}` resolves to. A missing key means "leave the macro alone". */
function values(ctx: MacroContext): Record<string, string | undefined> {
	return {
		char: ctx.char,
		user: ctx.user,
		persona: ctx.persona,
		description: ctx.description,
		personality: ctx.personality,
		scenario: ctx.scenario,
		charprompt: ctx.charPrompt,
		charinstruction: ctx.charInstruction,
		chardepthprompt: ctx.charDepthPrompt,
		charversion: ctx.charVersion,
		creatornotes: ctx.creatorNotes,
		group: ctx.group,
		input: ctx.input,
		original: ctx.original,
		model: ctx.model,
		// Aliases SillyTavern keeps for older cards.
		charactername: ctx.char,
		username: ctx.user,
		personadescription: ctx.persona,
	};
}

/**
 * Replaces every macro it knows. `{{trim}}` and `{{//…}}` are flags: the first trims the finished
 * text, the second disappears with everything after it on that line.
 */
export function substituteMacros(text: string, ctx: MacroContext, options: MacroOptions = {}): string {
	if (!text) {
		return text;
	}
	const random = options.random ?? Math.random;
	const now = (options.now ?? (() => new Date()))();
	// `{{pick}}` stays stable for one pass, so the same macro in a preset cannot disagree with itself.
	const picks = new Map<string, string>();
	const table = values(ctx);
	let result = text;

	// Comments first: their body must never be scanned for names.
	result = result.replace(/\{\{\/\/[^}]*\}\}/g, '');

	result = result.replace(CALL, (whole, rawName: string, body: string) => {
		const name = rawName.toLowerCase();
		switch (name) {
			case 'random':
			case 'pick':
				return choose(body, random, picks, whole);
			case 'roll':
				return String(roll(body, random));
			case 'reverse':
				return [...body].reverse().join('');
			default:
				return whole;
		}
	});

	result = result.replace(NAME, (whole, rawName: string) => {
		const name = rawName.toLowerCase();
		switch (name) {
			case 'trim':
				return '';
			case 'newline':
				return '\n';
			case 'space':
				return ' ';
			case 'noop':
				return '';
			case 'time':
				return now.toLocaleTimeString();
			case 'date':
				return now.toLocaleDateString();
			case 'weekday':
				return now.toLocaleDateString(undefined, { weekday: 'long' });
			case 'isotime':
				return now.toISOString().slice(11, 16);
			case 'isodate':
				return now.toISOString().slice(0, 10);
			default: {
				const value = table[name];
				return value === undefined ? whole : value;
			}
		}
	});

	// `{{trim}}` is a flag: the flag itself is gone by now, so its presence is what matters.
	return /\{\{\s*trim\s*\}\}/i.test(text) ? result.trim() : result;
}

/** One of the comma-separated options. The choice is remembered for the rest of the pass. */
function choose(body: string, random: () => number, picks: Map<string, string>, key: string): string {
	const options = splitOptions(body);
	if (!options.length) {
		return '';
	}
	if (options.length === 1) {
		return options[0];
	}
	const remembered = picks.get(key);
	if (remembered !== undefined) {
		return remembered;
	}
	const picked = options[Math.floor(random() * options.length)] ?? options[0];
	picks.set(key, picked);
	return picked;
}

/** Options may be separated by commas, or by `::` for bodies that contain commas. */
function splitOptions(body: string): string[] {
	const parts = body.includes('::') ? body.split('::') : body.split(',');
	return parts.map((part) => part.trim()).filter(Boolean);
}

/** Dice notation: `d6`, `2d8`, `1d20+3`, or a plain number. A result of `0` means "not a roll". */
function roll(body: string, random: () => number): number {
	const match = /^(\d*)\s*d\s*(\d+)\s*([+-]\s*\d+)?$/i.exec(body.trim());
	if (!match) {
		const plain = Number.parseInt(body.trim(), 10);
		return Number.isFinite(plain) ? plain : 0;
	}
	const count = Math.min(100, Math.max(1, Number.parseInt(match[1] || '1', 10)));
	const sides = Math.max(2, Number.parseInt(match[2], 10));
	const bonus = match[3] ? Number.parseInt(match[3].replace(/\s+/g, ''), 10) : 0;
	let total = bonus;
	for (let index = 0; index < count; index += 1) {
		total += 1 + Math.floor(random() * sides);
	}
	return total;
}

/** Splits a card's `mes_example` into one block per `<START>`, the way SillyTavern does. */
export function parseExamples(examples: string): string[] {
	const text = examples.trim();
	if (!text || text === '<START>') {
		return [];
	}
	return text
		.split(/<START>/gi)
		.slice(text.startsWith('<START>') ? 1 : 0)
		.map((block) => block.trim())
		.filter(Boolean);
}
