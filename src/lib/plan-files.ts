// SPDX-License-Identifier: AGPL-3.0-only
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Plan files live under `<workdir>/<planDirectory>/<root chat id>/`. The tool writes them and the
 * chat panel previews and builds them, so the folder and the name rule are derived in one place:
 * the two sides can never disagree about which file a plan name means.
 */

export const DEFAULT_PLAN_DIRECTORY = '.comonad/plans';

/** A plan this large is read from disk by the agent instead of repeated in the Build prompt. */
export const MAX_BUILD_PLAN_CHARS = 200_000;

/** The only modes that can carry a plan out: both write files, differing in shell access. */
export const BUILD_MODES = ['sw', 'aw'] as const;
export type BuildMode = (typeof BUILD_MODES)[number];

/** A requested build mode. There is no fallback: an unknown value is refused, never silently narrowed. */
export function asBuildMode(value: unknown): BuildMode | undefined {
	return typeof value === 'string' && (BUILD_MODES as readonly string[]).includes(value)
		? (value as BuildMode)
		: undefined;
}

/** `planDirectory` (or the default) plus the root chat's folder. */
export function planFolder(planDirectory: string | undefined, rootSessionId: string): string {
	return join(planDirectory || DEFAULT_PLAN_DIRECTORY, rootSessionId);
}

/**
 * `write_plan`'s name rule: the basename it actually writes. A name that is no file — empty, `.`
 * or `..` — is null, so both the writer and a Build click refuse it before touching the disk.
 */
export function planFileName(name: unknown): string | null {
	const clean = typeof name === 'string' ? basename(name.trim()) : '';
	return !clean || clean === '.' || clean === '..' ? null : clean;
}

export interface PlanTarget {
	name: string;
	/** Workspace-relative when inside it; the configured path otherwise. Forward slashes. */
	relative: string;
	/** The path the tool feeds to `guardPath`; callers still guard it themselves. */
	path: string;
}

/** The plan a chat's `write_plan` name resolves to, as the tool would resolve it. */
export function planTargetFor(
	workspace: string,
	planDirectory: string | undefined,
	rootSessionId: string,
	name: unknown,
): PlanTarget | null {
	const file = planFileName(name);
	const path = file ? join(planFolder(planDirectory, rootSessionId), file) : null;
	if (!file || !path || !workspace.trim()) {
		return null;
	}
	const root = resolve(workspace);
	const rel = relative(root, resolve(root, path));
	const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
	return { name: file, relative: (inside ? rel : path).split(sep).join('/'), path };
}

/** The name and recorded path a successful `write_plan` result carries. */
export interface RecordedPlan {
	name: string;
	/** The path line `write_plan` recorded; absent for transcripts from older builds. */
	relative?: string;
}

/** Parses the first two lines of a successful `write_plan` result. */
export function parsePlanWriteResult(output: string): RecordedPlan | undefined {
	const [first, second] = output.split('\n');
	const wrote = first?.match(/^wrote plan (.+)$/);
	const name = planFileName(wrote?.[1]);
	if (!name) {
		return undefined;
	}
	const relative = second?.match(/^plan path: (.+)$/)?.[1]?.trim();
	return relative ? { name, relative } : { name };
}

/**
 * Resolves a recorded plan path without consulting the current `planDirectory`, so a card keeps
 * working after the setting changes. The recorded path must end in `<root chat id>/<name>`;
 * callers still pass the result through `guardPath` before reading it.
 */
export function planPathForRecorded(
	workspace: string,
	rootSessionId: string,
	recorded: RecordedPlan,
): PlanTarget | null {
	const name = planFileName(recorded.name);
	const relative = recorded.relative?.replaceAll('\\', '/').replace(/^\.\//, '');
	if (!name || !relative || !workspace.trim()) {
		return null;
	}
	const base = relative.split('/').pop();
	const folder = `${rootSessionId}/${name}`;
	if (base !== name || (relative !== folder && !relative.endsWith(`/${folder}`))) {
		return null;
	}
	const path = isAbsolute(relative) ? relative : resolve(workspace, relative);
	return { name, relative, path };
}

/** What a Build click sends: the file the plan lives in, then the plan itself. */
export function buildPlanPrompt(relativePath: string, content: string): string {
	const body = content.trim();
	if (!body || body.length > MAX_BUILD_PLAN_CHARS) {
		return `Read the plan at \`${relativePath}\` and implement it. Carry out the changes and verify them.`;
	}
	return `Implement the plan at \`${relativePath}\`:\n\n${body}\n\nCarry out the plan now: make the described changes and verify them.`;
}
