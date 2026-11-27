// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The declarative merge engine: Protocol Defaults → Brand Defaults → Provider Instance
 * Overrides, one explicit rule per field. Not a deep merge — each field's semantics are
 * spelled out in MERGE_RULES and implemented as its own pure function, so a layer can
 * never accidentally inherit something the rule did not say it inherits.
 */
import { ModelError } from '../errors';
import { BEARER } from '../transport/auth';
import { normalizeEndpoint } from '../transport/security';
import type { ModelInfo } from '../types';
import {
	DEFAULT_RETRY_POLICY,
	type BrandDefinition,
	type OptionField,
	type OptionSchema,
	type OptionValues,
	type ProtocolDefinition,
	type ProviderInstanceConfig,
	type ResolvedWire,
	type RetryPolicy,
} from './schema';

export type MergeRule =
	| 'override' // deepest layer with a value wins, whole value
	| 'replace' // whole-object override, never field-merged
	| 'headers' // case-insensitive map merge, later layer wins per key
	| 'concat' // ordered concatenation (hooks)
	| 'options' // shallow fold, then protocol-schema validation
	| 'models' // merge by model id, per-field override
	| 'scalars' // per-field last-wins over defaults; arrays replace wholesale
	| 'protocol-only'; // provided by the protocol alone; no layer may override

export interface MergeRuleRow {
	field: string;
	rule: MergeRule;
	note: string;
}

/** The layering contract, in one table. Tests walk it row by row. */
export const MERGE_RULES: readonly MergeRuleRow[] = [
	{ field: 'protocol', rule: 'override', note: "instance may re-point the brand's protocol" },
	{ field: 'baseURL', rule: 'override', note: 'normalized; instance over brand, brand over nothing' },
	{ field: 'auth', rule: 'replace', note: 'whole scheme per layer, never field-merged' },
	{ field: 'keyEnv', rule: 'override', note: 'array replaces wholesale; the key itself never appears in config' },
	{ field: 'headers', rule: 'headers', note: 'case-insensitive merge; the winning layer keeps its casing' },
	{ field: 'headerHooks', rule: 'concat', note: 'protocol, then brand, executed in order' },
	{ field: 'requestHooks', rule: 'concat', note: 'protocol, then brand, executed in order' },
	{ field: 'chatPath', rule: 'override', note: 'protocol default /chat/completions; origin-locked at resolve' },
	{ field: 'modelsPath', rule: 'override', note: 'protocol default /models; origin-locked at resolve' },
	{ field: 'options', rule: 'options', note: 'shallow fold; validated by the protocol schema, unknown keys rejected' },
	{ field: 'models', rule: 'models', note: 'merged by model id; per-field override, pricing per price key' },
	{ field: 'modelRules', rule: 'scalars', note: 'prefix/skip last-wins; skip compiles to a RegExp' },
	{ field: 'retry', rule: 'scalars', note: 'per-field over DEFAULT_RETRY_POLICY; retryableCodes replaces wholesale' },
	{ field: 'fallback', rule: 'override', note: "instance's list; empty = none" },
	{ field: 'create()', rule: 'protocol-only', note: 'brands and instances customize via data and hooks, never by swapping it' },
];

/** Which protocol a provider speaks: the instance may re-point the brand's choice. */
export function protocolIdFor(instance: ProviderInstanceConfig, brand: BrandDefinition): string {
	return instance.protocol ?? brand.protocol;
}

/** Folds the three layers into the wire every request runs against. Pure. */
export function mergeWire(
	protocol: ProtocolDefinition,
	brand: BrandDefinition,
	instance: ProviderInstanceConfig,
): ResolvedWire {
	const baseURL = normalizeEndpoint(instance.base || brand.defaults.baseURL || '');
	if (!baseURL) {
		throw new ModelError('invalid_request', `provider instance "${instance.id}" has no base URL`);
	}
	return {
		baseURL,
		chatPath: instance.chatPath ?? brand.defaults.chatPath ?? protocol.defaults.chatPath,
		modelsPath: instance.modelsPath ?? brand.defaults.modelsPath ?? protocol.defaults.modelsPath,
		auth: instance.auth ?? brand.defaults.auth ?? protocol.defaults.auth ?? BEARER,
		headers: mergeHeaders(protocol.defaults.headers, brand.defaults.headers, instance.headers),
		headerHooks: [...(protocol.headerHooks ?? []), ...(brand.headerHooks ?? [])],
		requestHooks: [...(protocol.requestHooks ?? []), ...(brand.requestHooks ?? [])],
		options: validateOptions(protocol.defaults.optionsSchema, {
			...protocol.defaults.options,
			...brand.defaults.options,
			...instance.options,
		}),
		models: mergeModels(brand.modelCatalog, instance.models),
		modelRules: compileModelRules(brand.modelRules, instance.modelRules),
		retry: mergeRetry(instance.retry),
		fallback: instance.fallback ?? [],
	};
}

/** Case-insensitive map merge: later layers win per lower-cased key, keeping the winner's casing. */
export function mergeHeaders(
	...layers: (Record<string, string> | undefined)[]
): Record<string, string> {
	const byName = new Map<string, { casing: string; value: string }>();
	for (const layer of layers) {
		for (const [name, value] of Object.entries(layer ?? {})) {
			byName.set(name.toLowerCase(), { casing: name, value });
		}
	}
	const out: Record<string, string> = {};
	for (const { casing, value } of byName.values()) {
		out[casing] = value;
	}
	return out;
}

/** Shallow fold (later wins per key), then protocol-schema validation. */
export function validateOptions(schema: OptionSchema, options: OptionValues): OptionValues {
	const out: OptionValues = {};
	for (const [key, value] of Object.entries(options)) {
		if (value === undefined) {
			continue;
		}
		const field = schema[key];
		if (!field) {
			throw new ModelError('invalid_request', `unknown option "${key}"`);
		}
		if (!matchesField(field, value)) {
			const shape = field.enum ? `${field.type} (${field.enum.join(' | ')})` : field.type;
			throw new ModelError('invalid_request', `option "${key}" must be a ${shape}`);
		}
		out[key] = value;
	}
	return out;
}

function matchesField(field: OptionField, value: unknown): boolean {
	switch (field.type) {
		case 'any':
			return true;
		case 'string':
			return typeof value === 'string' && (!field.enum || field.enum.includes(value));
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'boolean':
			return typeof value === 'boolean';
		case 'object':
			return typeof value === 'object' && value !== null;
	}
}

/** Catalog facts seeded by the brand, adjusted per model id by the instance. */
export function mergeModels(
	catalog: readonly ModelInfo[] | undefined,
	overrides: Record<string, Partial<ModelInfo>> | undefined,
): Map<string, ModelInfo> {
	const models = new Map<string, ModelInfo>();
	for (const info of catalog ?? []) {
		models.set(info.id, { ...info });
	}
	for (const [id, patch] of Object.entries(overrides ?? {})) {
		const current = models.get(id) ?? { id };
		const merged: ModelInfo = { ...current, ...withoutUndefined(patch) };
		const pricing = { ...(current.pricing ?? {}), ...withoutUndefined(patch.pricing ?? {}) };
		merged.pricing = Object.keys(pricing).length ? (pricing as ModelInfo['pricing']) : undefined;
		merged.id = id;
		models.set(id, merged);
	}
	return models;
}

/** Per-field last-wins over the defaults; an array replaces wholesale. */
export function mergeRetry(overrides: Partial<RetryPolicy> | undefined): RetryPolicy {
	const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...withoutUndefined(overrides ?? {}) };
	if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
		throw new ModelError('invalid_request', 'retry.maxAttempts must be an integer of at least 1');
	}
	return retry;
}

/** Per-field last-wins; `skip` compiles to a RegExp once, here. */
export function compileModelRules(
	...layers: ({ prefix?: string; skip?: string } | undefined)[]
): { prefix: string; skip?: RegExp } {
	let prefix = '';
	let skip: string | undefined;
	for (const layer of layers) {
		if (layer?.prefix !== undefined) {
			prefix = layer.prefix;
		}
		if (layer?.skip !== undefined) {
			skip = layer.skip;
		}
	}
	let compiled: RegExp | undefined;
	if (skip) {
		try {
			compiled = new RegExp(skip);
		} catch (cause) {
			throw new ModelError('invalid_request', `modelRules.skip is not a valid regular expression: ${skip}`, { cause });
		}
	}
	return { prefix, skip: compiled };
}

/** Ordered concatenation; executed in this order, each seeing the accumulated headers. */
export function concatHooks<T>(...layers: (readonly T[] | undefined)[]): T[] {
	return layers.flatMap((layer) => layer ?? []);
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			(out as Record<string, unknown>)[key] = entry;
		}
	}
	return out;
}
