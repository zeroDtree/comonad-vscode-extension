// SPDX-License-Identifier: AGPL-3.0-only
import { PERSONA_DEPTH_DEFAULT, PERSONA_POSITION, readPersonaConnections } from './authoring';
import type { Character, Persona, PersonaDescription } from './types';

/**
 * Personas in SillyTavern's own shapes: one description block, the backup document that holds every
 * persona at once, and the conversion of a character card into a persona. Pure — the service owns
 * the files, so the merge rules can be tested without touching disk.
 */

const numberOr = (value: unknown, fallback: number): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** One persona read from a description block — our own file shape, or one entry of a backup. */
export function personaFrom(value: unknown, id: string, fallbackName: string, source: string): Persona {
	const raw = (value && typeof value === 'object' ? value : {}) as PersonaDescription & { name?: string };
	const named = text(raw.name).trim();
	return {
		id,
		name: named || fallbackName.trim() || id,
		description: text(raw.description),
		title: text(raw.title),
		position: numberOr(raw.position, PERSONA_POSITION.inPrompt),
		depth: numberOr(raw.depth, PERSONA_DEPTH_DEFAULT),
		role: numberOr(raw.role, 0),
		lorebook: text(raw.lorebook),
		connections: readPersonaConnections(raw.connections),
		source,
		raw,
	};
}

/**
 * The spellings a connection id may have. Upstream stores a card's *avatar file name* — `Kestrel.png`
 * — where Comonad calls the same card `Kestrel`, so both are compared whenever a connection is
 * matched against a character.
 */
export function connectionKeys(id: string): string[] {
	const name = id.trim().toLowerCase();
	const stem = name.replace(/\.(png|jpe?g|webp|gif)$/, '');
	return stem && stem !== name ? [name, stem] : [name];
}

/** The description block of a persona: what a persona file and a backup entry both hold. */
export function personaDescription(persona: Persona): PersonaDescription {
	return {
		description: persona.description,
		title: persona.title,
		position: persona.position,
		depth: persona.depth,
		role: persona.role,
		lorebook: persona.lorebook,
		connections: persona.connections.map((connection) => ({ ...connection })),
	};
}

/**
 * SillyTavern's persona backup: the names keyed by persona id, the descriptions keyed the same way,
 * and which persona is the default. Avatars travel as their own files upstream, so they are not part
 * of the document here either.
 */
export interface PersonaBackup {
	personas: Record<string, string>;
	persona_descriptions: Record<string, PersonaDescription>;
	default_persona?: string | null;
}

/** Every persona as one backup document, in upstream's own shape. */
export function personaBackup(personas: readonly Persona[], defaultPersona = ''): PersonaBackup {
	const backup: PersonaBackup = { personas: {}, persona_descriptions: {}, default_persona: defaultPersona || null };
	for (const persona of personas) {
		backup.personas[persona.id] = persona.name;
		// The file's own unknown keys ride along, so a backup round-trips a field we do not model.
		backup.persona_descriptions[persona.id] = { ...persona.raw, ...personaDescription(persona) };
	}
	return backup;
}

export interface PersonaRestore {
	/** The personas the document held that were not already in the library. */
	personas: Persona[];
	/** The backup's default persona, when it names one the document also carries. */
	defaultPersona: string;
	/** What the merge left out, in upstream's own wording. */
	skipped: string[];
}

/**
 * Reads a backup document the way upstream restores one: a persona the library already has is left
 * exactly as it is, and a description whose persona is not in the document is skipped too. The
 * document says nothing about pictures, so a restored persona has none until one is chosen.
 */
export function readPersonaBackup(value: unknown, taken: ReadonlySet<string> = new Set()): PersonaRestore {
	const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
	const names = record.personas;
	const descriptions = record.persona_descriptions;
	if (!names || typeof names !== 'object' || Array.isArray(names) || !descriptions || typeof descriptions !== 'object' || Array.isArray(descriptions)) {
		throw new Error('the file is not a persona backup: it needs personas and persona_descriptions');
	}
	const personas: Persona[] = [];
	const skipped: string[] = [];
	const seen = new Set(taken);
	for (const [id, name] of Object.entries(names as Record<string, unknown>)) {
		if (seen.has(id)) {
			skipped.push(`Persona "${id}" (${text(name)}) already exists, skipping`);
			continue;
		}
		const block = (descriptions as Record<string, unknown>)[id];
		personas.push(personaFrom(block, id, text(name), ''));
		seen.add(id);
	}
	for (const id of Object.keys(descriptions as Record<string, unknown>)) {
		if (!(id in (names as Record<string, unknown>))) {
			skipped.push(`Persona for "${id}" does not exist, skipping`);
		}
	}
	const wanted = text(record.default_persona);
	const defaultPersona = wanted && seen.has(wanted) ? wanted : '';
	if (wanted && !defaultPersona) {
		skipped.push(`Default persona "${wanted}" does not exist, skipping`);
	}
	return { personas, defaultPersona, skipped };
}

/**
 * A character card as a persona, the way upstream's *Convert to Persona* does it: the name comes
 * across, the position is *in prompt* at a fresh persona's depth, and nothing is bound to it. The
 * description may have its macros swapped, because the conversion reverses who is who — upstream
 * asks before doing that, and so does the caller here.
 */
export function convertCharacterToPersona(character: Character, id: string, source: string, swapMacros = false): Persona {
	// The two temporary names are upstream's own; they exist only for the length of the swap.
	const description = swapMacros
		? character.description
				.replace(/\{\{char\}\}/gi, '{{personaChar}}')
				.replace(/\{\{user\}\}/gi, '{{personaUser}}')
				.replace(/\{\{personaUser\}\}/gi, '{{char}}')
				.replace(/\{\{personaChar\}\}/gi, '{{user}}')
		: character.description;
	return {
		id,
		name: character.name,
		description,
		title: '',
		position: PERSONA_POSITION.inPrompt,
		depth: PERSONA_DEPTH_DEFAULT,
		role: 0,
		lorebook: '',
		// Upstream binds nothing either: the new persona is picked or locked by hand afterwards.
		connections: [],
		source,
		raw: {},
	};
}
