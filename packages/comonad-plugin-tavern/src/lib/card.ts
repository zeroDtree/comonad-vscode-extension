// SPDX-License-Identifier: AGPL-3.0-only
import { deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Character, CharacterCard, CharacterData, DepthPrompt, RegexScript } from './types';

/**
 * Character cards, read and written the way SillyTavern stores them: a PNG with the card in a `tEXt`
 * chunk (`chara` for V2, `ccv3` for V3, base64 JSON), or a plain JSON document. Dependency-free —
 * only the text chunks are touched, so no image decoding is needed.
 */

/** Upstream's `talkativeness_default`: the value a card without one speaks at. */
export const TALKATIVENESS_DEFAULT = 0.5;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The `tEXt` keywords a card lives in: V2 in `chara`, V3 in `ccv3`, which wins on read. */
const CARD_KEYWORDS = new Set(['chara', 'ccv3']);
const MAX_CARD = 4 * 1024 * 1024;

const CRC_TABLE = ((): Uint32Array => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export interface PngText {
	keyword: string;
	text: string;
}

/** Reads every `tEXt` chunk of a PNG, in file order. Throws when the buffer is not a PNG. */
export function readPngText(image: Buffer): PngText[] {
	if (image.length < 8 || !image.subarray(0, 8).equals(PNG_SIGNATURE)) {
		throw new Error('not a PNG image');
	}
	const chunks: PngText[] = [];
	let offset = 8;
	while (offset + 12 <= image.length) {
		const length = image.readUInt32BE(offset);
		const type = image.toString('latin1', offset + 4, offset + 8);
		const start = offset + 8;
		const end = start + length;
		if (end + 4 > image.length) {
			break;
		}
		if (type === 'tEXt') {
			const data = image.subarray(start, end);
			const split = data.indexOf(0);
			if (split > 0) {
				chunks.push({
					keyword: data.toString('latin1', 0, split),
					text: data.toString('latin1', split + 1),
				});
			}
		}
		if (type === 'IEND') {
			break;
		}
		offset = end + 4;
	}
	return chunks;
}

/** Whether a buffer is a PNG, which is the only image a card can be written onto. */
export function isPng(image: Buffer): boolean {
	return image.length >= 8 && image.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Replaces the card chunks of a PNG, keeping the image itself untouched. */
export function writePngText(image: Buffer, chunks: readonly PngText[]): Buffer {
	if (image.length < 8 || !image.subarray(0, 8).equals(PNG_SIGNATURE)) {
		throw new Error('not a PNG image');
	}
	const card = chunks.some((chunk) => CARD_KEYWORDS.has(chunk.keyword.toLowerCase()));
	const drop = new Set(chunks.map((chunk) => chunk.keyword.toLowerCase()));
	if (card) {
		// Writing one card chunk clears the other: a stale `ccv3` would win the next read.
		for (const keyword of CARD_KEYWORDS) {
			drop.add(keyword);
		}
	}
	const parts: Buffer[] = [image.subarray(0, 8)];
	let offset = 8;
	while (offset + 12 <= image.length) {
		const length = image.readUInt32BE(offset);
		const type = image.toString('latin1', offset + 4, offset + 8);
		const end = offset + 8 + length;
		if (end + 4 > image.length) {
			break;
		}
		const isText = type === 'tEXt' && drop.has(keywordOf(image.subarray(offset + 8, end)));
		if (type === 'IEND') {
			for (const chunk of chunks) {
				parts.push(encodeTextChunk(chunk));
			}
		}
		if (!isText) {
			parts.push(image.subarray(offset, end + 4));
		}
		offset = end + 4;
	}
	return Buffer.concat(parts);
}

function keywordOf(data: Buffer): string {
	const split = data.indexOf(0);
	return split > 0 ? data.toString('latin1', 0, split).toLowerCase() : '';
}

function encodeTextChunk(chunk: PngText): Buffer {
	const body = Buffer.concat([Buffer.from(chunk.keyword, 'latin1'), Buffer.from([0]), Buffer.from(chunk.text, 'latin1')]);
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write('tEXt', 4, 'latin1');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
	return Buffer.concat([head, body, crc]);
}

/** The card document inside a PNG: `ccv3` wins over `chara`, as SillyTavern does. */
export function cardTextFromPng(image: Buffer): string {
	const chunks = readPngText(image);
	for (const keyword of ['ccv3', 'chara']) {
		const found = chunks.find((chunk) => chunk.keyword.toLowerCase() === keyword);
		if (found?.text) {
			return Buffer.from(found.text, 'base64').toString('utf8');
		}
	}
	throw new Error('the PNG carries no character card');
}

/** Parses a card document. V1 (fields at the root) is read as-is; normalisation happens later. */
export function parseCard(text: string): CharacterCard {
	const parsed = JSON.parse(text) as unknown;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('the card is not a JSON object');
	}
	return parsed as CharacterCard;
}

/** The `data` block of a card, deriving one from the V1 root fields when the card predates V2. */
export function cardData(card: CharacterCard): CharacterData {
	if (card.data && typeof card.data === 'object' && !Array.isArray(card.data)) {
		return card.data;
	}
	const flat = card as CharacterData;
	return {
		name: card.name,
		description: card.description,
		personality: card.personality,
		scenario: card.scenario,
		first_mes: card.first_mes,
		mes_example: card.mes_example,
		creator_notes: card.creatorcomment,
		tags: card.tags,
		// Cards written by hand often keep the V2 fields at the root: read them there too.
		system_prompt: flat.system_prompt,
		post_history_instructions: flat.post_history_instructions,
		alternate_greetings: flat.alternate_greetings,
		character_book: flat.character_book,
		extensions: flat.extensions,
		creator: flat.creator,
		character_version: flat.character_version,
	};
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** A flag as upstream writes one: a boolean in V2, the string `true` in a V1 form. */
function flag(value: unknown): boolean {
	return value === true || value === 'true';
}

/** A number that may have arrived as a string; anything else falls back. */
function numberOr(value: unknown, fallback: number): number {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

function depthPromptOf(value: unknown): DepthPrompt | null {	if (!value || typeof value !== 'object') {
		return null;
	}
	const prompt = text((value as { prompt?: unknown }).prompt);
	if (!prompt) {
		return null;
	}
	const role = (value as { role?: unknown }).role;
	return {
		depth: typeof (value as { depth?: unknown }).depth === 'number' ? ((value as { depth: number }).depth) : 4,
		prompt,
		role: role === 'user' || role === 'assistant' ? role : 'system',
	};
}

/** Turns a document into the flat view the rest of the extension uses, keeping the original. */
export function normaliseCard(card: CharacterCard, id: string, source: string): Character {
	const data = cardData(card);
	const extensions = (data.extensions ?? {}) as { depth_prompt?: unknown; regex_scripts?: unknown; world?: unknown };
	const scripts = Array.isArray(extensions.regex_scripts) ? (extensions.regex_scripts as RegexScript[]) : [];
	const root = card as CharacterCard & { talkativeness?: unknown; fav?: unknown; create_date?: unknown };
	return {
		id,
		name: text(data.name) || text(card.name) || id,
		description: text(data.description) || text(card.description),
		personality: text(data.personality) || text(card.personality),
		scenario: text(data.scenario) || text(card.scenario),
		greeting: text(data.first_mes) || text(card.first_mes),
		alternateGreetings: strings(data.alternate_greetings).filter(Boolean),
		examples: text(data.mes_example) || text(card.mes_example),
		systemPrompt: text(data.system_prompt),
		postHistoryInstructions: text(data.post_history_instructions),
		creatorNotes: text(data.creator_notes) || text(card.creatorcomment),
		creator: text(data.creator),
		version: text(data.character_version),
		tags: (strings(data.tags).length ? strings(data.tags) : strings(card.tags)).filter(Boolean),
		// Upstream writes these under `extensions` in V2 and at the root in V1: read either.
		favourite: flag((extensions as { fav?: unknown }).fav) || flag(root.fav),
		talkativeness: numberOr((extensions as { talkativeness?: unknown }).talkativeness, numberOr(root.talkativeness, TALKATIVENESS_DEFAULT)),
		createdAt: text(root.create_date),
		sourceLink: text((extensions as { source_url?: unknown }).source_url),
		depthPrompt: depthPromptOf(extensions.depth_prompt),
		world: typeof extensions.world === 'string' ? extensions.world.trim() : '',
		book: data.character_book && typeof data.character_book === 'object' ? data.character_book : null,
		regex: scripts.filter((script) => script && typeof script.findRegex === 'string'),
		source,
		raw: card,
	};
}

/** A card id taken from the file it came from: `Seraphina.png` and `Seraphina.json` are one name. */
export function cardId(file: string): string {
	const base = basename(file);
	const stem = base.slice(0, base.length - extname(base).length);
	return stem.replace(/[^\w.-]+/g, '-') || 'character';
}

/**
 * The lines a chat may open with: the card's own `first_mes` first, then the alternates. The index
 * in this list is what a session records, so the order is part of the contract.
 */
export function greetingsOf(character: Character): string[] {
	return [character.greeting, ...character.alternateGreetings].map((line) => line.trim()).filter(Boolean);
}

/** Loads one card file — PNG or JSON — and returns the normalised character. */
export async function loadCard(file: string): Promise<Character> {
	const raw = await readFile(file);
	const isPng = extname(file).toLowerCase() === '.png' || raw.subarray(0, 8).equals(PNG_SIGNATURE);
	const text = isPng ? cardTextFromPng(raw) : raw.toString('utf8');
	if (text.length > MAX_CARD) {
		throw new Error(`${basename(file)} is larger than ${MAX_CARD} bytes`);
	}
	return normaliseCard(parseCard(text), cardId(file), file);
}

/** The document to write: a V2 card, carrying over every field the card already had. */
export function characterToCard(character: Character): CharacterCard {
	// Start from what the card actually held, whichever shape it was in, so nothing is lost.
	const data: CharacterData = { ...cardData(character.raw) };
	data.name = character.name;
	data.description = character.description;
	data.personality = character.personality;
	data.scenario = character.scenario;
	data.first_mes = character.greeting;
	data.mes_example = character.examples;
	data.creator_notes = character.creatorNotes;
	data.system_prompt = character.systemPrompt;
	data.post_history_instructions = character.postHistoryInstructions;
	data.alternate_greetings = character.alternateGreetings;
	data.tags = character.tags;
	data.creator = character.creator;
	data.character_version = character.version;
	if (character.book) {
		data.character_book = character.book;
	} else {
		delete data.character_book;
	}
	const extensions = { ...((data.extensions ?? {}) as Record<string, unknown>) };
	if (character.depthPrompt) {
		extensions.depth_prompt = character.depthPrompt;
	} else {
		delete extensions.depth_prompt;
	}
	if (character.regex.length) {
		extensions.regex_scripts = character.regex;
	} else {
		delete extensions.regex_scripts;
	}
	if (character.world.trim()) {
		extensions.world = character.world.trim();
	} else {
		delete extensions.world;
	}
	// Upstream mirrors these two into `extensions`, and keeps `fav` at the root of a V1 card as well.
	if (character.talkativeness !== TALKATIVENESS_DEFAULT) {
		extensions.talkativeness = character.talkativeness;
	} else {
		delete extensions.talkativeness;
	}
	if (character.favourite) {
		extensions.fav = true;
	} else {
		delete extensions.fav;
	}
	if (character.sourceLink.trim()) {
		extensions.source_url = character.sourceLink.trim();
	} else {
		delete extensions.source_url;
	}
	data.extensions = extensions;
	return {
		...character.raw,
		spec: 'chara_card_v2',
		spec_version: '2.0',
		// The V1 root fields stay in step, exactly as SillyTavern writes them.
		name: character.name,
		description: character.description,
		personality: character.personality,
		scenario: character.scenario,
		first_mes: character.greeting,
		mes_example: character.examples,
		tags: character.tags,
		talkativeness: character.talkativeness,
		// A V1 reader looks for `fav` at the root; V2 has it under `extensions`, written above.
		fav: character.favourite,
		...(character.createdAt.trim() ? { create_date: character.createdAt.trim() } : {}),
		data,
	};
}

/**
 * A blank PNG to hang a card on: one flat colour, so an exported card is a valid image every
 * consumer can render. The colour is the extension's accent, so it reads as a Comonad card.
 */
export function blankPng(width = 400, height = 600): Buffer {
	const [r, g, b] = [0x2b, 0x2f, 0x3a];
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y += 1) {
		const row = y * (width * 3 + 1);
		raw[row] = 0; // filter: none
		for (let x = 0; x < width; x += 1) {
			const at = row + 1 + x * 3;
			raw[at] = r;
			raw[at + 1] = g;
			raw[at + 2] = b;
		}
	}
	const chunk = (type: string, body: Buffer): Buffer => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(body.length, 0);
		head.write(type, 4, 'ascii');
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])), 0);
		return Buffer.concat([head, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour
	return Buffer.concat([
		PNG_SIGNATURE,
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/** A card document as JSON text. */export function cardToJson(character: Character): string {
	return JSON.stringify(characterToCard(character), null, 4);
}

/**
 * Writes the card into a PNG: `chara` for V2 and `ccv3` for V3, before `IEND`. SillyTavern reads V3
 * first, so both chunks carry the same card and an older reader still finds the V2 one.
 */
export function cardToPng(image: Buffer, character: Character): Buffer {
	const card = characterToCard(character);
	const v2 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
	const v3 = Buffer.from(JSON.stringify({ ...card, spec: 'chara_card_v3', spec_version: '3.0' }), 'utf8').toString('base64');
	return writePngText(image, [
		{ keyword: 'chara', text: v2 },
		{ keyword: 'ccv3', text: v3 },
	]);
}

/** Whether a file name looks like a character card, so a directory scan can skip the rest. */
export function isCardFile(file: string): boolean {
	return /\.(png|json)$/i.test(file);
}
