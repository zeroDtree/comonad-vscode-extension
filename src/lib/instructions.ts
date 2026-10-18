import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { COMONAD_BLOCK, DEFAULT_BLOCK_PREFIX } from './blocks';

/** Project instructions (COMONAD.md / AGENTS.md / rules) and auto memory. Pure module. */

export interface InstructionLayer {
	source: string;
	content: string;
}

const MAX_FILE = 64 * 1024;
const MAX_TOTAL = 200 * 1024;
const MAX_RULES = 30;

export async function loadInstructions(workspace: string, home: string, trusted: boolean): Promise<InstructionLayer[]> {
	const layers: InstructionLayer[] = [];
	const user = join(home, '.comonad', 'COMONAD.md');
	const userContent = await readText(user);
	if (userContent) {
		layers.push({ source: user, content: userContent });
	}
	if (!trusted || !workspace.trim()) {
		return layers;
	}
	const chain: string[] = [];
	let dir = resolve(workspace);
	for (let depth = 0; depth < 3; depth += 1) {
		chain.unshift(dir);
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	let total = 0;
	for (const base of chain) {
		for (const name of ['COMONAD.md', '.comonad/instructions.md']) {
			const file = join(base, name);
			const content = await readText(file);
			if (content) {
				layers.push({ source: file, content });
				total += content.length;
			}
		}
		const hasComonad = await exists(join(base, 'COMONAD.md'));
		if (!hasComonad) {
			const agents = await readText(join(base, 'AGENTS.md'));
			if (agents) {
				layers.push({ source: join(base, 'AGENTS.md'), content: agents });
				total += agents.length;
			}
		}
	}
	const rules = await readRules(join(resolve(workspace), '.comonad', 'rules'));
	for (const rule of rules) {
		if (total + rule.content.length > MAX_TOTAL) {
			break;
		}
		layers.push(rule);
		total += rule.content.length;
	}
	return layers;
}

/** The instruction files' own text, without the heading a prompt block adds above it. */
export function instructionBody(layers: InstructionLayer[]): string {
	if (layers.length === 0) {
		return '';
	}
	return layers.map((layer) => `### ${layer.source}\n\n${stripHtmlComments(layer.content)}`).join('\n\n');
}

export function formatInstructions(layers: InstructionLayer[], heading = DEFAULT_BLOCK_PREFIX[COMONAD_BLOCK.instructions]): string {
	const body = instructionBody(layers);
	const head = heading.trim();
	return head && body ? `${head}\n\n${body}` : head || body;
}

export function stripHtmlComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}

async function readRules(dir: string): Promise<InstructionLayer[]> {
	const found: InstructionLayer[] = [];
	const walk = async (current: string, depth: number): Promise<void> => {
		if (depth > 3 || found.length >= MAX_RULES) {
			return;
		}
		let entries: Dirent[] = [];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (found.length >= MAX_RULES) {
				return;
			}
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(path, depth + 1);
			} else if (entry.isFile() && entry.name.endsWith('.md')) {
				const content = await readText(path);
				if (content) {
					found.push({ source: path, content });
				}
			}
		}
	};
	await walk(dir, 0);
	return found.sort((left, right) => left.source.localeCompare(right.source));
}

async function readText(file: string): Promise<string | null> {
	try {
		const info = await stat(file);
		if (!info.isFile() || info.size > MAX_FILE) {
			return null;
		}
		const text = await readFile(file, 'utf8');
		return text.trim() ? text : null;
	} catch {
		return null;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Auto memory: model-maintained notes, kept outside the user's repository. */

export function memoryDir(storageRoot: string, workspace: string): string {
	const key = workspace.trim() ? createHash('sha1').update(resolve(workspace)).digest('hex').slice(0, 16) : 'global';
	return join(storageRoot, 'memory', key);
}

const MEMORY_MAX = 25 * 1024;
const MEMORY_LINES = 200;

export async function readMemory(dir: string): Promise<string> {
	try {
		const text = await readFile(join(dir, 'MEMORY.md'), 'utf8');
		const lines = text.split('\n').slice(0, MEMORY_LINES).join('\n');
		return lines.length > MEMORY_MAX ? lines.slice(0, MEMORY_MAX) : lines;
	} catch {
		return '';
	}
}

export async function appendMemory(dir: string, text: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	const file = join(dir, 'MEMORY.md');
	let existing = '';
	try {
		existing = await readFile(file, 'utf8');
	} catch {
		existing = '# Memory\n\nNotes this agent keeps about the project.\n';
	}
	const stamp = new Date().toISOString().slice(0, 10);
	await writeFile(file, `${existing.trimEnd()}\n- (${stamp}) ${text.replace(/\s+/g, ' ').trim()}\n`);
}
