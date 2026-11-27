// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The version of @comonad/model's external API surface.
 *
 * Protocol and brand definitions declare the apiVersion they were written against;
 * registration rejects anything this build does not support. Additive, optional
 * fields do not bump the version; removals or semantic changes do.
 */
export const MODEL_API_VERSION = 1;

/** Throws when a definition declares an apiVersion this build cannot serve. */
export function assertApiVersion(declared: number, what: string): void {
	if (declared !== MODEL_API_VERSION) {
		throw new Error(
			`${what} declares apiVersion ${declared}, but @comonad/model supports ${MODEL_API_VERSION}`,
		);
	}
}
