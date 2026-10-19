// SPDX-License-Identifier: AGPL-3.0-only
import type { PluginState } from '../services/plugins';

/**
 * The plugin tree, as text. Pure module: the inspector lists what each row gives, wants and is wanted by,
 * and prints the chain that stops with a row — which is what a toggle is really asking.
 */

/** One row, as the tree needs to know it: what it is, what it gives, what it wants, who wants it. */
export interface PluginNode {
	id: string;
	/** `loaded` is the quiet case; the other three are what a reader is looking for. */
	status: 'loaded' | 'off' | 'waiting' | 'failed';
	/** The services the row provides: what another row names when it asks for it. */
	provides: readonly string[];
	/**
	 * The services the row injects, with the row that provides each. `external` means something outside
	 * the rows provides it — `host`, `log` and `settings`, which Comonad mounts before the tree; absent
	 * altogether means nothing does.
	 */
	requires: readonly { name: string; provider?: string; external?: boolean }[];
	/** The rows that would go inactive if this one were turned off. */
	usedBy: readonly string[];
}

/** What a row's state means in one word: off, still waiting for a service, or failed on its own. */
export function pluginNodeStatus(row: Pick<PluginState, 'enabled' | 'loaded' | 'error'>): PluginNode['status'] {
	if (!row.enabled) {
		return 'off';
	}
	if (row.loaded) {
		return 'loaded';
	}
	// A row that is not running is either waiting for an injection or reporting why it threw; the message
	// is the difference, and the plugin host writes the first kind with a `pending` prefix.
	return (row.error ?? '').startsWith('pending') ? 'waiting' : 'failed';
}

/**
 * One row's dependency tree, as text: what it stands on, what stands on it, and — the question a toggle
 * actually asks — everything that goes down with it, following the chain rather than one hop. The table
 * is the overview and the diagram is the shape; this is the drill-down.
 */
export function pluginTree(nodes: readonly PluginNode[], id: string): string {
	const by = new Map(nodes.map((node) => [node.id, node]));
	const node = by.get(id);
	if (!node) {
		return '';
	}
	const lines = [`${id} — ${node.status}${node.provides.length ? ` — provides ${node.provides.join(', ')}` : ''}`];
	const requires = node.requires.filter((require) => require.provider && require.provider !== id);
	if (requires.length) {
		lines.push('requires');
		for (const require of requires) {
			const provider = by.get(require.provider!);
			lines.push(`  └─ ${require.name} ← ${require.provider} (${provider?.status ?? 'off'})`);
		}
	}
	for (const require of node.requires.filter((entry) => !entry.provider && !entry.external)) {
		lines.push(`waits for ${require.name} — nobody provides it`);
	}
	// The table leaves "who needs this row" to the drill-down, so say it for every row — including
	// the rows nothing depends on.
	lines.push('needed by');
	lines.push(node.usedBy.length ? `  └─ ${node.usedBy.join(', ')}` : '  └─ (none)');
	// The transitive closure: rows that only need this one through another row still stop with it.
	const stops: string[] = [];
	const seen = new Set([id]);
	for (const direct of node.usedBy) {
		const queue = [direct];
		while (queue.length) {
			const current = queue.shift()!;
			if (seen.has(current)) {
				continue;
			}
			seen.add(current);
			stops.push(current);
			queue.push(...(by.get(current)?.usedBy ?? []));
		}
	}
	if (stops.length > node.usedBy.length) {
		lines.push('turning this plugin off also stops');
		lines.push(`  └─ ${stops.join(', ')}`);
	}
	return lines.join('\n');
}
