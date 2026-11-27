// SPDX-License-Identifier: AGPL-3.0-only
/**
 * resolve: the last mile of the layering. Folds the three layers (`mergeWire`), locks the
 * independently configured chat and models paths to the base origin, and fills the
 * credential from the injected KeyProvider — the package itself never reads a secret.
 */
import { resolveSameOrigin } from '../transport/security';
import type { BrandDefinition, KeyProvider, ProtocolDefinition, ProviderInstanceConfig, ResolvedProvider } from './schema';
import { mergeWire } from './merge';

/** Normalizes `keyEnv` to the ordered list of names to try. */
export function keyEnvNames(instance: ProviderInstanceConfig): string[] {
	const names = instance.keyEnv ?? [];
	return (Array.isArray(names) ? names : [names]).map((name) => name.trim()).filter(Boolean);
}

export async function resolveProvider(
	protocol: ProtocolDefinition,
	brand: BrandDefinition,
	instance: ProviderInstanceConfig,
	keys: KeyProvider,
): Promise<ResolvedProvider> {
	const wire = mergeWire(protocol, brand, instance);
	const envNames = keyEnvNames(instance);
	const stored = (await keys.keyFor(wire.baseURL, instance.id))?.trim();
	let key = stored || undefined;
	let keySource: ResolvedProvider['keySource'] = key ? 'stored' : 'none';
	if (!key) {
		for (const name of envNames) {
			const value = keys.env(name)?.trim();
			if (value) {
				key = value;
				keySource = 'env';
				break;
			}
		}
	}
	return {
		...wire,
		instanceId: instance.id,
		brandId: brand.id,
		protocolId: protocol.id,
		chatURL: resolveSameOrigin(wire.baseURL, wire.chatPath),
		modelsURL: resolveSameOrigin(wire.baseURL, wire.modelsPath),
		key,
		keySource,
		keyEnvNames: envNames,
	};
}
