// SPDX-License-Identifier: AGPL-3.0-only
/** Parsing a `git diff` into per-file counts and hunks. Pure module: no `vscode`, no `cordis`. */

export interface JournalHunk {
	header: string;
	lines: { type: 'add' | 'del' | 'ctx'; text: string }[];
}

/** Parses a `git diff` over several files into per-path counts and hunks. */
export function parseDiffs(text: string): Map<string, { additions: number; deletions: number; hunks: JournalHunk[] }> {
	const out = new Map<string, { additions: number; deletions: number; hunks: JournalHunk[] }>();
	let current: { additions: number; deletions: number; hunks: JournalHunk[] } | null = null;
	let hunk: JournalHunk | null = null;
	for (const line of text.split('\n')) {
		if (line.startsWith('diff --git ')) {
			const at = line.lastIndexOf(' b/');
			const path = unquote(at === -1 ? '' : line.slice(at + 1).slice(2));
			current = { additions: 0, deletions: 0, hunks: [] };
			hunk = null;
			out.set(path, current);
			continue;
		}
		if (!current) {
			continue;
		}
		if (line.startsWith('@@')) {
			hunk = { header: line, lines: [] };
			current.hunks.push(hunk);
			continue;
		}
		// `---` and `+++` header lines come before the first hunk, so they are never counted.
		if (!hunk) {
			continue;
		}
		if (line.startsWith('+')) {
			current.additions += 1;
			hunk.lines.push({ type: 'add', text: line.slice(1) });
		} else if (line.startsWith('-')) {
			current.deletions += 1;
			hunk.lines.push({ type: 'del', text: line.slice(1) });
		} else if (line.startsWith(' ')) {
			hunk.lines.push({ type: 'ctx', text: line.slice(1) });
		}
	}
	return out;
}

function unquote(path: string): string {
	if (path.startsWith('"') && path.endsWith('"')) {
		try {
			return JSON.parse(path) as string;
		} catch {
			return path;
		}
	}
	return path;
}
