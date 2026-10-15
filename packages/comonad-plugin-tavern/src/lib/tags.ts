import { randomUUID } from 'node:crypto';

/**
 * SillyTavern's tag registry, as data.
 *
 * Upstream keeps two things side by side — the tags themselves and a map from an entity to the tags
 * it carries — and refers to a tag by its **id** everywhere, because a name can be changed and an id
 * cannot. An entry's character filter stores those ids too, which is why the registry has to exist
 * before the filter can mean anything. Pure module: no `vscode`, no `cordis`, no file system.
 */

/** One tag. Only `id` and `name` are always there; the rest is what the manager edits. */
export interface Tag {
	id: string;
	name: string;
	/** Upstream's "bogus folder" behaviour: `OPEN` shows every character, `CLOSED` hides them. */
	folder_type?: string;
	/** The saved state of the tag filter in the character list; carried, not interpreted here. */
	filter_state?: number;
	sort_order?: number;
	/** Background and foreground of the chip, both `rgba(...)` or empty for the default. */
	color?: string;
	color2?: string;
	create_date?: number;
	is_hidden_on_character_card?: boolean;
}

/** The whole registry: the tags, and which entity carries which of them. */
export interface TagStore {
	tags: Tag[];
	tag_map: Record<string, string[]>;
}

/** The folder types a tag can be, in the order upstream cycles through them. */
export const TAG_FOLDER_TYPES = ['NONE', 'OPEN', 'CLOSED'] as const;
export const TAG_FOLDER_DEFAULT = 'NONE';

/**
 * What to do with the tags a card ships in its own `tags` field — upstream's numbers, so a value in
 * a copied settings file keeps its meaning.
 */
import { TAG_IMPORT } from '@comonad/lib/tavern/types';

export { TAG_IMPORT };

/** Card tags that are never turned into library tags: they are generator metadata. */
export const IMPORT_EXCLUDED_TAGS = ['ROOT', 'TAVERN'];

/** A card may carry hundreds of junk tags; upstream refuses to import more than this many. */
export const ANTI_TROLL_MAX_TAGS = 50;

export function emptyStore(): TagStore {
	return { tags: [], tag_map: {} };
}

/** Name matching is upstream's: case- and accent-insensitive. */
function foldName(name: string): string {
	return name
		.trim()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase();
}

function stringsIn(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringOr(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function numberOr(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Reads one tag from a file, keeping every field we do not model. */
function readTag(value: unknown): Tag | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const raw = value as Record<string, unknown>;
	const id = stringOr(raw.id)?.trim();
	const name = stringOr(raw.name)?.trim();
	if (!id || !name) {
		return null;
	}
	const tag: Tag = { ...(value as Tag), id, name };
	tag.folder_type = stringOr(raw.folder_type) ?? TAG_FOLDER_DEFAULT;
	return tag;
}

/** Reads a `tags.json`, tolerating a truncated or hand-edited file. */
export function readStore(value: unknown): TagStore {
	if (!value || typeof value !== 'object') {
		return emptyStore();
	}
	const raw = value as { tags?: unknown; tag_map?: unknown };
	const tags: Tag[] = [];
	const seen = new Set<string>();
	for (const candidate of Array.isArray(raw.tags) ? raw.tags : []) {
		const tag = readTag(candidate);
		if (tag && !seen.has(tag.id)) {
			seen.add(tag.id);
			tags.push(tag);
		}
	}
	const tag_map: Record<string, string[]> = {};
	if (raw.tag_map && typeof raw.tag_map === 'object' && !Array.isArray(raw.tag_map)) {
		for (const [key, ids] of Object.entries(raw.tag_map as Record<string, unknown>)) {
			// Dangling ids are kept: upstream's own lookups skip them, and a tag that comes back with a
			// merged registry should find its entity again.
			tag_map[key] = stringsIn(ids);
		}
	}
	return { tags, tag_map };
}

/**
 * The store as the file: the tags we know, with the entries an entity carries. Kept in the shape
 * upstream writes, so the file can be read by SillyTavern and vice versa.
 */
export function storeJson(store: TagStore): string {
	return `${JSON.stringify({ tags: store.tags, tag_map: store.tag_map }, null, 4)}\n`;
}

/**
 * Two registries into one: the first root wins per tag id, and every entity keeps the tags both
 * files assigned to it. This is what makes a project `.comonad/tags.json` a local overlay on the
 * user library rather than a replacement for it.
 */
export function mergeStores(base: TagStore, over: TagStore): TagStore {
	const tags = [...base.tags];
	const seen = new Set(tags.map((tag) => tag.id));
	for (const tag of over.tags) {
		if (!seen.has(tag.id)) {
			seen.add(tag.id);
			tags.push(tag);
		}
	}
	const tag_map: Record<string, string[]> = {};
	for (const [key, ids] of [...Object.entries(base.tag_map), ...Object.entries(over.tag_map)]) {
		const room = tag_map[key] ?? [];
		for (const id of ids) {
			if (!room.includes(id)) {
				room.push(id);
			}
		}
		tag_map[key] = room;
	}
	return { tags, tag_map };
}

/** Upstream's order: the manual sort key first, then the name. */
export function compareTags(left: Tag, right: Tag): number {
	const order = (left.sort_order ?? 0) - (right.sort_order ?? 0);
	return order !== 0 ? order : left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}

export function sorted(tags: readonly Tag[]): Tag[] {
	return [...tags].sort(compareTags);
}

export function byId(store: TagStore, id: string | undefined): Tag | undefined {
	const wanted = (id ?? '').trim();
	return wanted ? store.tags.find((tag) => tag.id === wanted) : undefined;
}

/** The tag with this name, any case. */
export function byName(store: TagStore, name: string): Tag | undefined {
	const wanted = foldName(name);
	return wanted ? store.tags.find((tag) => foldName(tag.name) === wanted) : undefined;
}

/** A new tag in upstream's shape: the sort key lands after every existing tag. */
export function newTag(store: TagStore, name: string, now = Date.now()): Tag {
	return {
		id: randomUUID(),
		name: name.trim(),
		folder_type: TAG_FOLDER_DEFAULT,
		sort_order: Math.max(0, ...store.tags.map((tag) => tag.sort_order ?? 0)) + 1,
		is_hidden_on_character_card: false,
		color: '',
		color2: '',
		create_date: now,
	};
}

/**
 * Moves an entity's tag assignments to a new key — upstream's `renameTagKey`, which a character
 * rename needs so its tags do not stay behind under the old file name.
 */
export function renameKey(store: TagStore, from: string, to: string): boolean {
	const source = keyFor(store, from);
	const target = (to ?? '').trim();
	if (!source || !target || source === target) {
		return false;
	}
	const ids = store.tag_map[source];
	if (!ids) {
		return false;
	}
	store.tag_map[target] = [...new Set([...(store.tag_map[target] ?? []), ...ids])];
	delete store.tag_map[source];
	return true;
}

/** The tag with this name, created and added when there is none — upstream's `getTag(createNew)`. */
export function ensureTag(store: TagStore, name: string): Tag | undefined {
	const wanted = name.trim();
	if (!wanted) {
		return undefined;
	}
	const found = byName(store, wanted);
	if (found) {
		return found;
	}
	const tag = newTag(store, wanted);
	store.tags.push(tag);
	return tag;
}

/**
 * The physical key an entity's tags live under. Upstream keys the map by the avatar file name
 * (`Seraphina.png`); Comonad names a character by the file's stem (`Seraphina`), so a file copied
 * from SillyTavern is matched either way, and a new assignment is written under our own name.
 */
export function keyFor(store: TagStore, key: string): string | undefined {
	const wanted = (key ?? '').trim();
	if (!wanted) {
		return undefined;
	}
	if (Object.hasOwn(store.tag_map, wanted)) {
		return wanted;
	}
	const stem = (value: string): string => value.replace(/\.[^./\\]+$/, '').toLowerCase();
	return Object.keys(store.tag_map).find((candidate) => stem(candidate) === stem(wanted));
}

/** A list of the ids one entity carries, created on first use the way upstream's map is. */
export function idsOf(store: TagStore, key: string): string[] {
	const physical = keyFor(store, key) ?? key.trim();
	if (!physical) {
		return [];
	}
	if (!Array.isArray(store.tag_map[physical])) {
		store.tag_map[physical] = [];
	}
	return store.tag_map[physical]!;
}

/** The tags one entity carries, in upstream's order. */
export function tagsOf(store: TagStore, key: string): Tag[] {
	const wanted = (key ?? '').trim();
	if (!wanted) {
		return [];
	}
	const ids = store.tag_map[keyFor(store, wanted) ?? wanted] ?? [];
	return sorted(ids.map((id) => byId(store, id)).filter((tag): tag is Tag => Boolean(tag)));
}

/** The ids one entity carries, which is what an entry's character filter compares against. */
export function tagIdsOf(store: TagStore, key: string): string[] {
	return tagsOf(store, key).map((tag) => tag.id);
}

/** Assigns tags to an entity. Returns how many were new. */
export function addTags(store: TagStore, key: string, tags: readonly Tag[]): number {
	const ids = idsOf(store, key);
	let added = 0;
	for (const tag of tags) {
		if (!ids.includes(tag.id)) {
			ids.push(tag.id);
			added += 1;
		}
	}
	return added;
}

/** Takes one tag off an entity. */
export function removeTag(store: TagStore, key: string, id: string): boolean {
	const ids = idsOf(store, key);
	const at = ids.indexOf(id);
	if (at === -1) {
		return false;
	}
	ids.splice(at, 1);
	return true;
}

/** Renames a tag. The id, and so every entity's reference to it, is untouched. */
export function renameTag(store: TagStore, id: string, name: string): boolean {
	const tag = byId(store, id);
	const wanted = name.trim();
	if (!tag || !wanted) {
		return false;
	}
	tag.name = wanted;
	return true;
}

/**
 * Deletes a tag: it goes, and every entity that carried it loses it. With `into`, those entities
 * gain that tag instead — upstream's "delete and merge", which is how a duplicate is cleaned up.
 */
export function deleteTag(store: TagStore, id: string, into?: string): boolean {
	const at = store.tags.findIndex((tag) => tag.id === id);
	if (at === -1) {
		return false;
	}
	const replacement = into && into !== id && byId(store, into) ? into : '';
	for (const key of Object.keys(store.tag_map)) {
		const ids = store.tag_map[key]!;
		if (!ids.includes(id)) {
			continue;
		}
		store.tag_map[key] = ids.filter((candidate) => candidate !== id);
		if (replacement && !store.tag_map[key]!.includes(replacement)) {
			store.tag_map[key]!.push(replacement);
		}
	}
	store.tags.splice(at, 1);
	return true;
}

/** Deletes every tag no entity carries — upstream's "prune", the cleanup for a busy library. */
export function pruneTags(store: TagStore): number {
	const live = new Set(Object.values(store.tag_map).flat());
	const before = store.tags.length;
	store.tags = store.tags.filter((tag) => live.has(tag.id));
	return before - store.tags.length;
}

/** What an import would do, before anything is written. */
export interface TagImportPlan {
	/** The names the card offers, in card order, already filtered and capped. */
	names: string[];
	/** Those that are already registry tags. */
	existing: Tag[];
	/** Those that would be created. */
	fresh: string[];
}

/**
 * Plans the import of a card's own tags, with upstream's rules: the generator tags are dropped,
 * names the card's entity already carries are dropped, the list is capped, and only then is it
 * split into "already a tag" and "would become one".
 */
export function planTagImport(store: TagStore, key: string, cardTags: readonly string[], setting: number): TagImportPlan {
	const none: TagImportPlan = { names: [], existing: [], fresh: [] };
	if (setting === TAG_IMPORT.NONE) {
		return none;
	}
	const assigned = tagsOf(store, key).map((tag) => tag.id);
	const names: string[] = [];
	const seen = new Set<string>();
	for (const candidate of cardTags) {
		const name = String(candidate).trim();
		const folded = foldName(name);
		if (!folded || IMPORT_EXCLUDED_TAGS.includes(name.toUpperCase()) || seen.has(folded)) {
			continue;
		}
		const found = byName(store, name);
		if (found && assigned.includes(found.id)) {
			continue;
		}
		seen.add(folded);
		names.push(name);
		if (names.length >= ANTI_TROLL_MAX_TAGS) {
			break;
		}
	}
	const existing = names.map((name) => byName(store, name)).filter((tag): tag is Tag => Boolean(tag));
	const fresh = names.filter((name) => !byName(store, name));
	// `ONLY_EXISTING` is the one setting that may not create anything, so the plan says so up front.
	return setting === TAG_IMPORT.ONLY_EXISTING ? { names: existing.map((tag) => tag.name), existing, fresh: [] } : { names, existing, fresh };
}

/** Applies a plan: new tags are created, then everything is assigned. Returns the names imported. */
export function applyTagImport(store: TagStore, key: string, plan: TagImportPlan): string[] {
	const tags: Tag[] = [...plan.existing];
	for (const name of plan.fresh) {
		const tag = ensureTag(store, name);
		if (tag) {
			tags.push(tag);
		}
	}
	if (!tags.length) {
		return [];
	}
	addTags(store, key, tags);
	return tags.map((tag) => tag.name);
}

/**
 * The fields of a tag the manager may change, taken from a webview payload that is otherwise
 * untrusted: anything unrecognised is simply not carried over.
 */
export function tagPatch(value: unknown): Partial<Tag> {
	const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
	const patch: Partial<Tag> = {};
	if (typeof raw.color === 'string') {
		patch.color = raw.color;
	}
	if (typeof raw.color2 === 'string') {
		patch.color2 = raw.color2;
	}
	if (typeof raw.folder_type === 'string' && (TAG_FOLDER_TYPES as readonly string[]).includes(raw.folder_type)) {
		patch.folder_type = raw.folder_type;
	}
	if (typeof raw.sort_order === 'number' && Number.isFinite(raw.sort_order)) {
		patch.sort_order = raw.sort_order;
	}
	if (typeof raw.is_hidden_on_character_card === 'boolean') {
		patch.is_hidden_on_character_card = raw.is_hidden_on_character_card;
	}
	return patch;
}
