import { objectSchema, type ToolSpec } from '../lib/types';
import { toolset } from '../services/tools';

/** Deterministic math helpers: exact evaluation, stats, percentiles and unit conversion. */

const FUNCTIONS = new Set([
	'sqrt', 'abs', 'ln', 'log', 'exp', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'floor', 'ceil', 'round', 'min', 'max',
]);

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const LINEAR: Record<string, Record<string, number>> = {
	length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, um: 1e-6, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 },
	mass: { mg: 0.001, g: 1, kg: 1000, t: 1_000_000, lb: 453.59237, oz: 28.349523125 },
	time: { ms: 0.001, s: 1, min: 60, h: 3600, d: 86400 },
	data: { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 },
};

const TEMPERATURE = new Set(['c', 'f', 'k']);

export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new Error('result is not finite');
	}
	return String(Number(value.toPrecision(12)));
}

export function evaluate(expression: string): number {
	const parser = new Parser(expression);
	const value = finite(parser.expression());
	parser.skip();
	if (!parser.done()) {
		throw new Error(`unexpected '${parser.rest()}'`);
	}
	return value;
}

export function summarize(values: number[]): Record<string, number | null> {
	const numbers = finiteList(values);
	if (numbers.length === 0) {
		throw new Error('numbers must not be empty');
	}
	const sorted = [...numbers].sort((left, right) => left - right);
	const count = numbers.length;
	const sum = numbers.reduce((total, value) => total + value, 0);
	const mean = sum / count;
	const median = percentile(numbers, 50);
	if (count < 2) {
		return { count, sum, min: sorted[0]!, max: sorted[count - 1]!, mean, median, variance: null, stddev: null };
	}
	const variance = numbers.reduce((total, value) => total + (value - mean) ** 2, 0) / (count - 1);
	return { count, sum, min: sorted[0]!, max: sorted[count - 1]!, mean, median, variance, stddev: Math.sqrt(variance) };
}

export function percentile(values: number[], p: number): number {
	const numbers = finiteList(values);
	if (numbers.length === 0) {
		throw new Error('numbers must not be empty');
	}
	if (!Number.isFinite(p) || p < 0 || p > 100) {
		throw new Error('p must be between 0 and 100');
	}
	const sorted = [...numbers].sort((left, right) => left - right);
	if (sorted.length === 1) {
		return sorted[0]!;
	}
	const rank = (p / 100) * (sorted.length - 1);
	const lower = Math.floor(rank);
	const upper = Math.ceil(rank);
	const weight = rank - lower;
	return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function convert(value: number, from: string, to: string): number {
	if (!Number.isFinite(value)) {
		throw new Error('value must be finite');
	}
	const left = unitName(from);
	const right = unitName(to);
	if (TEMPERATURE.has(left) || TEMPERATURE.has(right)) {
		if (!TEMPERATURE.has(left) || !TEMPERATURE.has(right)) {
			throw new Error(`cannot convert ${from} to ${to}`);
		}
		return fromKelvin(right, toKelvin(left, value));
	}
	const source = lookup(left);
	const target = lookup(right);
	if (!source) {
		throw new Error(`unknown unit '${from}'`);
	}
	if (!target) {
		throw new Error(`unknown unit '${to}'`);
	}
	if (source.kind !== target.kind) {
		throw new Error(`cannot convert ${from} to ${to}`);
	}
	return (value * source.scale) / target.scale;
}

class Parser {
	private at = 0;

	constructor(private readonly text: string) {}

	done(): boolean {
		return this.at >= this.text.length;
	}

	rest(): string {
		return this.text.slice(this.at);
	}

	expression(): number {
		let value = this.term();
		for (;;) {
			this.skip();
			if (this.eat('+')) {
				value += this.term();
			} else if (this.eat('-')) {
				value -= this.term();
			} else {
				return value;
			}
		}
	}

	private term(): number {
		let value = this.unary();
		for (;;) {
			this.skip();
			if (this.eat('*')) {
				value *= this.unary();
			} else if (this.eat('/')) {
				value /= this.unary();
			} else if (this.eat('%')) {
				value %= this.unary();
			} else {
				return value;
			}
		}
	}

	private unary(): number {
		this.skip();
		if (this.eat('+')) {
			return this.unary();
		}
		if (this.eat('-')) {
			return -this.unary();
		}
		return this.power();
	}

	private power(): number {
		const base = this.primary();
		this.skip();
		if (!this.eat('^')) {
			return base;
		}
		return base ** this.unary();
	}

	private primary(): number {
		this.skip();
		if (this.eat('(')) {
			const value = this.expression();
			this.skip();
			if (!this.eat(')')) {
				throw new Error('missing )');
			}
			return value;
		}
		if (this.at < this.text.length && /[0-9.]/.test(this.text[this.at]!)) {
			return this.number();
		}
		if (this.at < this.text.length && /[A-Za-z_]/.test(this.text[this.at]!)) {
			return this.named();
		}
		if (this.done()) {
			throw new Error(this.at === 0 ? 'empty expression' : 'unexpected end of expression');
		}
		throw new Error(`unexpected '${this.text[this.at]}'`);
	}

	private named(): number {
		const name = this.ident();
		this.skip();
		if (!this.eat('(')) {
			const constant = CONSTANTS[name];
			if (constant === undefined) {
				throw new Error(`unknown name '${name}'`);
			}
			return constant;
		}
		if (!FUNCTIONS.has(name)) {
			throw new Error(`unknown function '${name}'`);
		}
		const args: number[] = [];
		this.skip();
		if (!this.eat(')')) {
			args.push(this.expression());
			this.skip();
			while (this.eat(',')) {
				args.push(this.expression());
				this.skip();
			}
			if (!this.eat(')')) {
				throw new Error('missing )');
			}
		}
		return call(name, args);
	}

	private number(): number {
		const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.at));
		if (!match) {
			throw new Error(`unexpected '${this.text[this.at]}'`);
		}
		this.at += match[0].length;
		return Number(match[0]);
	}

	private ident(): string {
		const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.at));
		if (!match) {
			throw new Error(`unexpected '${this.text[this.at]}'`);
		}
		this.at += match[0].length;
		return match[0].toLowerCase();
	}

	skip(): void {
		while (this.at < this.text.length && /\s/.test(this.text[this.at]!)) {
			this.at += 1;
		}
	}

	private eat(token: string): boolean {
		if (!this.text.startsWith(token, this.at)) {
			return false;
		}
		this.at += token.length;
		return true;
	}
}

function call(name: string, args: number[]): number {
	const one = () => {
		if (args.length !== 1) {
			throw new Error(`${name} expects 1 argument`);
		}
		return finite(args[0]!);
	};
	switch (name) {
		case 'sqrt':
		case 'abs':
		case 'ln':
		case 'exp':
		case 'sin':
		case 'cos':
		case 'tan':
		case 'asin':
		case 'acos':
		case 'atan':
		case 'floor':
		case 'ceil':
		case 'round':
			return finite(Math[name === 'ln' ? 'log' : name](one()));
		case 'log':
			if (args.length === 1) {
				return finite(Math.log10(finite(args[0]!)));
			}
			if (args.length === 2) {
				return finite(Math.log(finite(args[0]!)) / Math.log(finite(args[1]!)));
			}
			throw new Error('log expects 1 or 2 arguments');
		case 'min':
		case 'max':
			if (args.length < 1) {
				throw new Error(`${name} expects at least 1 argument`);
			}
			return finite(Math[name](...args.map((value) => finite(value))));
		default:
			throw new Error(`unknown function '${name}'`);
	}
}

function finite(value: number): number {
	if (!Number.isFinite(value)) {
		throw new Error('result is not finite');
	}
	return value;
}

function finiteList(values: number[]): number[] {
	if (values.some((value) => !Number.isFinite(value))) {
		throw new Error('numbers must be finite');
	}
	return values;
}

function unitName(raw: string): string {
	return raw.trim().toLowerCase().replaceAll('°', '').replaceAll('µ', 'u').replaceAll('μ', 'u');
}

function lookup(name: string): { kind: string; scale: number } | undefined {
	for (const [kind, scales] of Object.entries(LINEAR)) {
		const scale = scales[name];
		if (scale !== undefined) {
			return { kind, scale };
		}
	}
	return undefined;
}

function toKelvin(unit: string, value: number): number {
	if (unit === 'c') {
		return value + 273.15;
	}
	if (unit === 'f') {
		return ((value - 32) * 5) / 9 + 273.15;
	}
	return value;
}

function fromKelvin(unit: string, kelvin: number): number {
	if (unit === 'c') {
		return kelvin - 273.15;
	}
	if (unit === 'f') {
		return ((kelvin - 273.15) * 9) / 5 + 32;
	}
	return kelvin;
}

function failure(error: unknown): string {
	return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

const SPECS: ToolSpec[] = [
	{
		name: 'calculate',
		description:
			'Evaluate a numeric expression. Operators: + - * / % ^ and parentheses. Functions: sqrt, abs, ln, log, exp, sin, cos, tan, floor, ceil, round, min, max. Constants: pi, e.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema({ expression: { type: 'string' } }, ['expression']),
		async execute(args) {
			try {
				const { expression } = args as { expression: string };
				return formatNumber(evaluate(expression));
			} catch (error) {
				return failure(error);
			}
		},
	},
	{
		name: 'describe_numbers',
		description: 'Summarize a list of numbers: count, sum, min, max, mean, median, sample variance and standard deviation.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema({ numbers: { type: 'array', items: { type: 'number' } } }, ['numbers']),
		async execute(args) {
			try {
				const { numbers } = args as { numbers: number[] };
				const summary = summarize(numbers);
				return Object.entries(summary)
					.map(([name, value]) => `${name}: ${value === null ? 'n/a' : formatNumber(value)}`)
					.join('\n');
			} catch (error) {
				return failure(error);
			}
		},
	},
	{
		name: 'percentile',
		description: 'Percentile of a list of numbers using linear interpolation. p is from 0 to 100.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema({ numbers: { type: 'array', items: { type: 'number' } }, p: { type: 'number' } }, ['numbers', 'p']),
		async execute(args) {
			try {
				const { numbers, p } = args as { numbers: number[]; p: number };
				return formatNumber(percentile(numbers, p));
			} catch (error) {
				return failure(error);
			}
		},
	},
	{
		name: 'convert_units',
		description:
			'Convert between units. Length: m, km, cm, mm, um, in, ft, yd, mi. Mass: mg, g, kg, t, lb, oz. Time: ms, s, min, h, d. Temperature: C, F, K. Data (1024-based): B, KB, MB, GB, TB.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: objectSchema({ value: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } }, ['value', 'from', 'to']),
		async execute(args) {
			try {
				const { value, from, to } = args as { value: number; from: string; to: string };
				return formatNumber(convert(value, from, to));
			} catch (error) {
				return failure(error);
			}
		},
	},
];

export const mathTools = toolset(SPECS);
