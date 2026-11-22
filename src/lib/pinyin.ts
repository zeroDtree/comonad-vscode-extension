// SPDX-License-Identifier: AGPL-3.0-only
import pinyin from 'tiny-pinyin';

/**
 * Pinyin haystacks for the mention picker. Pure — the picker stores one per Han-containing path
 * and ranks with it; nothing here touches `vscode`.
 *
 * tiny-pinyin covers the 6763 common Han characters and picks one reading for polyphonic
 * characters (`长` is always CHANG), so this is a recall aid: the literal match always ranks
 * above it, and a read the library gets wrong only costs a pinyin hit, never a literal one.
 */

export interface PinyinMatch {
	/** Lowercase syllables with Latin and separators preserved, e.g. `content/jiqixuexi/guangyitezhengzhi.md`. */
	full: string;
	/** One letter per Han character, everything else preserved, e.g. `content/jqxx/gytzz.md`. */
	initials: string;
}

let supported: boolean | undefined;
const memo = new Map<string, PinyinMatch | undefined>();

/** Whether this host has the zh-CN collation tiny-pinyin needs. Cached; a failure is "no". */
export function pinyinSupported(): boolean {
	if (supported === undefined) {
		try {
			supported = pinyin.isSupported();
		} catch {
			supported = false;
		}
	}
	return supported;
}

/**
 * The pinyin haystacks for one path, or `undefined` when the path has no Han character. Paths
 * with no Han never pay for the conversion; repeated names (a rebuild after a file event) are
 * memoized.
 */
export function pinyinOfPath(path: string): PinyinMatch | undefined {
	if (!HAN.test(path)) {
		return undefined;
	}
	if (memo.has(path)) {
		return memo.get(path);
	}
	let match: PinyinMatch | undefined;
	try {
		match = pinyinSupported() ? convert(path) : undefined;
	} catch {
		// `parse` throws when the host lacks zh-CN collation; literal matching still works.
		match = undefined;
	}
	if (memo.size >= 50_000) {
		memo.clear();
	}
	memo.set(path, match);
	return match;
}

/** One token walk gives both haystacks: the full reading and one initial per Han character. */
function convert(path: string): PinyinMatch {
	let full = '';
	let initials = '';
	for (const token of pinyin.parse(path)) {
		const target = token.target;
		if (token.type === 2) {
			const syllable = target.toLowerCase();
			full += syllable;
			initials += syllable.charAt(0);
		} else {
			const text = target.toLowerCase();
			full += text;
			initials += text;
		}
	}
	return { full, initials };
}

const HAN = /\p{Script=Han}/u;
