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
 * The plan tools' name rule: the basename they actually read or write. A name that is no file —
 * empty, `.` or `..` — is null, so a plan tool and a Build click refuse it before touching the disk.
 */
export function planFileName(name: unknown): string | null {
	const clean = typeof name === 'string' ? basename(name.trim()) : '';
	return !clean || clean === '.' || clean === '..' ? null : clean;
}

/** Whether a plan file name already carries the extension the built-in preview renders. */
export function isMarkdownPlanName(name: string): boolean {
	return /\.(?:md|markdown)$/i.test(name);
}

/**
 * The name `write_plan` writes: a plan is a Markdown document, so a name without a Markdown
 * extension gets `.md` appended. The result reports this name, and `edit_plan`, `read_plan` and
 * recorded legacy names keep the exact rule, so older plans without an extension still resolve.
 */
export function planWriteFileName(name: unknown): string | null {
	const file = planFileName(name);
	if (!file) {
		return null;
	}
	return isMarkdownPlanName(file) ? file : `${file}.md`;
}

export interface PlanTarget {
	name: string;
	/** Workspace-relative when inside it; the configured path otherwise. Forward slashes. */
	relative: string;
	/** The path the tool feeds to `guardPath`; callers still guard it themselves. */
	path: string;
}

/** The plan a chat's plan name resolves to, as the plan tools would resolve it. */
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

/** Tools whose successful result records a plan file; both feed the plan card. */
export const PLAN_WRITER_TOOLS = ['write_plan', 'edit_plan'] as const;

export function isPlanWriterTool(name: string | undefined): boolean {
	return name !== undefined && (PLAN_WRITER_TOOLS as readonly string[]).includes(name);
}

/** The name and recorded path a successful plan write or edit result carries. */
export interface RecordedPlan {
	name: string;
	/** The path line the tool recorded; absent for transcripts from older builds. */
	relative?: string;
	/** The result updated an existing plan rather than writing it from scratch. */
	edited?: boolean;
}

/** Parses the first two lines of a successful plan write or edit result. */
export function parsePlanResult(output: string): RecordedPlan | undefined {
	const [first, second] = output.split('\n');
	const match = first?.match(/^(wrote|edited) plan (.+)$/);
	const name = planFileName(match?.[2]);
	if (!name) {
		return undefined;
	}
	const edited = match?.[1] === 'edited';
	const relative = second?.match(/^plan path: (.+)$/)?.[1]?.trim();
	return relative ? { name, relative, edited } : { name, edited };
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

/**
 * What a Build click sends: the file the plan lives in, then the plan itself. The closing line names
 * the shell a workspace write needs — in Full Access a `run_shell_test` call would still be confined
 * to the scratch tree and fail.
 */
export function buildPlanPrompt(relativePath: string, content: string, mode: BuildMode): string {
	const body = content.trim();
	const shell =
		mode === 'aw'
			? 'This build runs in Full Access: use `run_shell` for commands that change the workspace; `run_shell_test` can only write `.comonad/scratch`.'
			: 'This build runs in Semi-Write: change the workspace with the file tools, not the shell; `run_shell_test` can only write `.comonad/scratch`.';
	if (!body || body.length > MAX_BUILD_PLAN_CHARS) {
		return `Read the plan at \`${relativePath}\` and implement it. Carry out the changes and verify them.\n\n${shell}`;
	}
	return `Implement the plan at \`${relativePath}\`:\n\n${body}\n\nCarry out the plan now: make the described changes and verify them.\n\n${shell}`;
}
