// SPDX-License-Identifier: AGPL-3.0-only
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The highest ancestor of `directory` that does not exist yet, or `undefined` when the directory is
 * already there or the path leaves `workspace`. A command that creates it owns that whole subtree,
 * so recording this one path is enough for the deletion check to trust everything below it.
 */
export async function missingAncestor(directory: string, workspace: string): Promise<string | undefined> {
	const root = resolve(workspace);
	let current = resolve(directory);
	let missing: string | undefined;
	for (;;) {
		const rel = relative(root, current);
		if (rel === '') {
			// Reached the workspace root: it is the user's, so nothing above the missing chain is ours.
			return missing;
		}
		if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
			return undefined;
		}
		try {
			await lstat(current);
			return missing;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				return undefined;
			}
			missing = current;
			current = dirname(current);
		}
	}
}
