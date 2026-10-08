/** Minimal YAML-frontmatter parser for skills, agents and custom commands. Pure module. */

export interface Frontmatter {
	data: Record<string, unknown>;
	body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
	const source = text.replace(/^\uFEFF/, '');
	if (!source.startsWith('---')) {
		return { data: {}, body: source.trim() };
	}
	const end = source.indexOf('\n---', 3);
	if (end === -1) {
		return { data: {}, body: source.trim() };
	}
	const head = source.slice(source.indexOf('\n') + 1, end + 1);
	const body = source.slice(end + 4).replace(/^\r?\n/, '');
	return { data: parseBlock(head), body: body.trim() };
}

function parseBlock(head: string): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	let currentKey: string | null = null;
	let list: string[] | null = null;
	for (const raw of head.split(/\r?\n/)) {
		const line = raw.replace(/\t/g, '  ');
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		if (trimmed.startsWith('- ') && currentKey && list) {
			list.push(unquote(trimmed.slice(2).trim()));
			continue;
		}
		const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (!match) {
			continue;
		}
		currentKey = match[1]!;
		const value = match[2]!.trim();
		if (value === '') {
			list = [];
			data[currentKey] = list;
			continue;
		}
		list = null;
		data[currentKey] = parseScalar(value);
	}
	return data;
}

function parseScalar(value: string): unknown {
	if (value.startsWith('[') && value.endsWith(']')) {
		const inner = value.slice(1, -1).trim();
		if (!inner) {
			return [];
		}
		return inner.split(',').map((item) => unquote(item.trim()));
	}
	if (value.includes(',')) {
		const parts = value.split(',').map((item) => item.trim()).filter(Boolean);
		if (parts.length > 1 && parts.every((item) => /^[\w.\-/ ]+$/.test(item))) {
			return parts;
		}
	}
	if (value === 'true') {
		return true;
	}
	if (value === 'false') {
		return false;
	}
	if (/^-?\d+(\.\d+)?$/.test(value)) {
		return Number(value);
	}
	return unquote(value);
}

function unquote(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

export function stringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	if (typeof value === 'string' && value.trim()) {
		return value.trim();
	}
	return undefined;
}

export function booleanField(data: Record<string, unknown>, key: string): boolean | undefined {
	const value = data[key];
	if (typeof value === 'boolean') {
		return value;
	}
	return undefined;
}

export function numberField(data: Record<string, unknown>, key: string): number | undefined {
	const value = data[key];
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	return undefined;
}

export function stringListField(data: Record<string, unknown>, key: string): string[] | undefined {
	const value = data[key];
	if (Array.isArray(value)) {
		return value.map((item) => String(item)).filter(Boolean);
	}
	if (typeof value === 'string' && value.trim()) {
		return value.split(',').map((item) => item.trim()).filter(Boolean);
	}
	return undefined;
}
