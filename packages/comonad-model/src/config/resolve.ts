// SPDX-License-Identifier: AGPL-3.0-only
/**
 * resolve: the last mile of the layering. Folds the three layers (`mergeWire`), locks the
 * independently configured chat and models paths to the base origin, and fills the
 * credential from the injected KeyProvider — the package itself never reads a secret.
 */
import { resolveSameOrigin } from '../transport/security';
import type { ProviderDefinition, KeyProvider, ProtocolDefinition, ProviderEntry, ResolvedProvider } from './schema';
import { mergeWire } from './merge';

/** Normalizes a `keyEnv` value to the ordered list of names to try. */
export function keyEnvNames(value: string | string[] | undefined): string[] {
	const names = value ?? [];
	return (Array.isArray(names) ? names : [names]).map((name) => name.trim()).filter(Boolean);
}

export async function resolveProvider(
	protocol: ProtocolDefinition,
	definition: ProviderDefinition,
	entry: ProviderEntry,
	keys: KeyProvider,
): Promise<ResolvedProvider> {
	const wire = mergeWire(protocol, definition, entry);
	// The entry's `keyEnv` replaces the definition's list wholesale when present.
	const envNames = keyEnvNames(entry.keyEnv ?? definition.keyEnv);
	const stored = (await keys.keyFor(wire.baseURL, entry.id))?.trim() || undefined;
	let env: string | undefined;
	for (const name of envNames) {
		const value = keys.env(name)?.trim();
		if (value) {
			env = value;
			break;
		}
	}
	// The entry's `keySource` decides which credential wins when both exist; the other one
	// stays as the fallback so a preference never leaves the provider without a key.
	const preferEnv = entry.keySource === 'env';
	const key = preferEnv ? env ?? stored : stored ?? env;
	const keySource: ResolvedProvider['keySource'] = key ? (preferEnv ? (env ? 'env' : 'stored') : stored ? 'stored' : 'env') : 'none';
	return {
		...wire,
		providerId: entry.id,
		definitionId: definition.id,
		protocolId: protocol.id,
		chatURL: resolveSameOrigin(wire.baseURL, wire.chatPath),
		modelsURL: resolveSameOrigin(wire.baseURL, wire.modelsPath),
		key,
		keySource,
		keyEnvNames: envNames,
	};
}
