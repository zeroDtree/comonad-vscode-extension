// SPDX-License-Identifier: AGPL-3.0-only

/** One exact-text replacement. `new` is inserted literally: no `$` pattern expansion. */
export interface LiteralEdit {
	old: string;
	new: string;
}

/**
 * Applies edits in order against the running text, so each edit sees the previous result. Every
 * `old` must occur exactly once; an empty, missing or ambiguous anchor throws and the caller writes
 * nothing. `label` names the target, e.g. `plan "plan.md"`.
 */
export function applyLiteralEdits(text: string, edits: readonly LiteralEdit[], label: string): string {
	let current = text;
	edits.forEach((edit, index) => {
		current = replaceUnique(current, edit, `${label}, edit ${index + 1}`);
	});
	return current;
}

function replaceUnique(text: string, edit: LiteralEdit, where: string): string {
	const { old, new: next } = edit;
	if (!old) {
		throw new Error(`${where}: old text is empty; pass the exact text to replace`);
	}
	// Count every start position, including overlapping matches: an ambiguous anchor must be
	// refused, not silently resolved by the first indexOf. A non-empty `old` guarantees progress.
	let first = -1;
	let count = 0;
	for (let found = text.indexOf(old); found >= 0; found = text.indexOf(old, found + 1)) {
		if (first < 0) {
			first = found;
		}
		count += 1;
	}
	if (count === 0) {
		throw new Error(`${where}: old text was not found; call read_plan and copy the current text exactly`);
	}
	if (count > 1) {
		throw new Error(`${where}: old text occurs ${count} times; include more surrounding text so it matches exactly once`);
	}
	// Slice insertion, not String.replace: `$&`, `$1` and `$'` in next stay literal.
	return text.slice(0, first) + next + text.slice(first + old.length);
}
