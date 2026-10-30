// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Service, type Context } from 'cordis';
import { asAttachments, attachmentIdOf } from '../lib/attachments';
import { asReasoningEffort } from '../lib/effort';
import { asApproval, asApprovalResponse, asCapabilities, asRuleSet, asWorkMode } from '../lib/policy';
import { asSandboxMode, DEFAULT_SANDBOX_MODE, isInside } from '../lib/sandbox';
import { modelContextDigest, type ContextForm } from '../lib/prompt';
import { turnsOf } from '../lib/turns';
import type { AttachmentPart, Message, ModelContext, ReasoningEffort, SessionPolicy, SwipeInfo } from '../lib/types';

/** Session persistence and the active-session pointer. One JSON document per chat. */

/** The variants of the reply a regenerate or a swipe is about, handed to the turn that replaces it. */
export interface SwipeCarry {
	swipes: string[];
	swipeId: number;
	swipeInfo: SwipeInfo[];
}

export interface SessionUsage {
	inputTokens: number;
	outputTokens: number;
	requests: number;
	cost: number;
}

/** A restore point: the journal position and the transcript prompt index at one turn. */
export interface Mark {
	turn: number;
	/** Journal entries that existed at this point; restoring keeps these and undoes the rest. */
	entryCount: number;
	length: number;
	at: number;
}

/**
 * The restore point for an edited prompt: the first turn at or after it that wrote. Every turn that
 * writes records a mark at its own prompt index, so when the edited turn wrote nothing the first
 * later mark's `entryCount` is exactly the journal position at the edited prompt.
 */
export function markForRestore(marks: readonly Mark[], promptAt: number): Mark | undefined {
	return marks.find((mark) => mark.length >= promptAt);
}

/** Whether the message at `index` is a prompt an edit can replace. */
export function canRewrite(session: Session, index: number): boolean {
	if (session.cursor || !Number.isInteger(index) || index < 0) {
		return false;
	}
	return session.transcript[index]?.role === 'user';
}

export interface Cursor {
	node: string;
	payload: unknown;
	step: number;
	state: unknown;
}

/**
 * Whether a chat belongs to `workspace`: the folder recorded when it was created; for a chat
 * written before that field existed, the directory it ran in, which may be a folder inside the
 * workspace when `comonad.workingDirectory` was narrowed.
 */
export function inWorkspace(session: Session, workspace: string): boolean {
	if (session.workspace !== undefined) {
		return session.workspace === workspace;
	}
	const home = session.policy.workingDirectory ?? '';
	return workspace ? home === workspace || isInside(workspace, home) : home === '';
}

export interface Session {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	policy: SessionPolicy;
	/**
	 * The workspace folder the chat was started in. The recent-chats list shows only this workspace
	 * by default, so chats from another folder stay in their own history.
	 */
	workspace?: string;
	/** How much of the transcript this chat sends back (new chats start from the Context setting). */
	contextForm?: ContextForm;
	/** Thinking effort for this chat (new chats start from the Reasoning effort setting). */
	reasoningEffort?: ReasoningEffort;
	/**
	 * Window override in tokens for this chat; `0` (the default) resolves from the model profile, so
	 * switching models re-resolves it. It overrides the model's window, it does not cap history.
	 */
	contextWindow?: number;
	/** The model-facing summary and coverage; the canonical transcript below is never rewritten by it. */
	modelContext?: ModelContext;
	transcript: Message[];
	turnIndex: number;
	cursor: Cursor | null;
	marks: Mark[];
	/**
	 * Workspace-relative forward-slash paths this chat created: file-tool writes and conservatively
	 * parsed shell creations. Bound to `createdRoot`; a different workspace discards them.
	 */
	created?: string[];
	/**
	 * Workspace-relative directories this chat created. Their whole subtree is the chat's own, so
	 * build output written there by a later command may be removed without asking.
	 */
	createdDirs?: string[];
	/** The resolved workspace `created` and `createdDirs` paths are relative to. */
	createdRoot?: string;
	/** The chat that spawned this one; a subagent session is hidden from the ordinary history. */
	parentId?: string;
	/** The subagent definition that owns this session. */
	subagent?: string;
	/** The effective policy fingerprint this session was created or last tightened under. */
	policyRevision?: string;
	/** The subagent run has finished. */
	subagentDone?: boolean;
	/** Tool call id → subagent session id: what lets an `agent` card open the child conversation. */
	subagents?: Record<string, string>;
	usage: SessionUsage;
	/**
	 * The prompt size the provider reported for the last request, in tokens. It is the only exact
	 * measure of how full the window is — everything else about the context is an estimate — so the
	 * panels read it rather than counting the transcript themselves.
	 */
	lastInputTokens?: number;
	/** Instruction files loaded into the last system prompt. */
	instructions?: string[];
	/** Tavern selection: a character and persona by id, world books by name, a preset by id. */
	character?: string;
	persona?: string;
	lorebooks?: string[];
	preset?: string;
	/** Standing text for the author's-note slot, when the chat sets its own. */
	authorNote?: string;
	/** Which of the character's greetings this chat opened with (0 is the card's own). */
	greetingIndex?: number;
	/** World-info sticky/cooldown windows carried across turns. */
	tavernEffects?: Record<string, { activatedAt: number; stickyUntil?: number; cooldownUntil?: number }>;
	/** What the books contributed to the last turn, for the chat's readout. */
	tavernActivated?: Array<{ book: string; comment: string; reason: string }>;
	/** True when the last scan ran out of world-info budget and had to drop entries. */
	tavernOverflow?: boolean;
}

export function threadTitle(text: string): string {
	const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? 'New session';
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function newSessionId(): string {
	return randomUUID();
}

export function safeId(id: string): string {
	if (!id || id.length > 200 || /[/\\\0]/.test(id) || id.includes('..')) {
		throw new Error(`invalid session id: ${id}`);
	}
	return id;
}

/** A delegated tool allowlist read from a session: names only, bounded and de-duplicated. */
function toolNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item === 'string' && item.trim() && item.length <= 200) {
			seen.add(item.trim());
		}
	}
	return [...seen].slice(0, 256);
}

/** Provenance is an approval shortcut, not a record: bound it so a long session stays a JSON file. */
export const MAX_CREATED_PATHS = 4096;
export const MAX_CREATED_PATH_LENGTH = 4096;

/** Normalise one untrusted created path; `undefined` when it must not be trusted. */
export function createdPath(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const path = value.replaceAll('\\', '/').replace(/^\.\//, '');
	if (!path || path.length > MAX_CREATED_PATH_LENGTH || path.startsWith('/') || path.includes('\0')) {
		return undefined;
	}
	const parts = path.split('/');
	if (parts.some((part) => part === '' || part === '.' || part === '..')) {
		return undefined;
	}
	return path;
}

/** The provenance the gate may use for this workspace: empty when the root does not match. */
export function createdInWorkspace(session: Session, workspace: string): ReadonlySet<string> {
	if (!workspace.trim() || session.createdRoot !== resolve(workspace)) {
		return new Set();
	}
	return new Set(session.created ?? []);
}

/** The directories this session created, bound to the same workspace as `createdInWorkspace`. */
export function createdDirsInWorkspace(session: Session, workspace: string): ReadonlySet<string> {
	if (!workspace.trim() || session.createdRoot !== resolve(workspace)) {
		return new Set();
	}
	return new Set(session.createdDirs ?? []);
}

/** A parent's tool-call → child-session map, sanitised: it is read back from an untrusted JSON file. */
const MAX_SUBAGENT_LINKS = 256;
function sanitizeSubagentLinks(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [rawCall, rawSession] of Object.entries(value as Record<string, unknown>).slice(-MAX_SUBAGENT_LINKS)) {
		const call = rawCall.trim();
		if (!call || call.length > 200 || call === '__proto__' || call === 'prototype' || call === 'constructor') {
			continue;
		}
		if (typeof rawSession !== 'string' || rawSession.length > 200) {
			continue;
		}
		try {
			out[call] = safeId(rawSession);
		} catch {
			// A hand-edited link must not become a path.
		}
	}
	return Object.keys(out).length ? out : undefined;
}

function uniqueCreated(paths: string[]): string[] {
	return [...new Set(paths)];
}

const UNTITLED = 'New session';

/**
 * The conversation's base title: fork markers (`(fork)`, `(fork 2)`, `(2)`, ` 2`) are stripped so
 * every fork of a conversation continues one numbering series.
 */
export function forkBase(title: string): string {
	return title.replace(/(?:\s*\(fork(?:\s*\d+)?\)|\s*\(\d+\)|\s+\d+)+$/iu, '').trim() || 'Chat';
}

/**
 * A chat that was created but never used: nothing worth keeping in the history. A character's
 * opening line counts as content, so a chat that shows one comes back after a reload — with the
 * character, its book and the greeting still in place.
 */
export function unusedChat(session: Session): boolean {
	return !session.transcript.length && !session.modelContext?.summary && !session.usage.requests && session.title === UNTITLED;
}

/** The newest message that mentions `needle`, as a one-line excerpt. */
function matchSnippet(session: Session, needle: string): string | undefined {
	for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
		const content = session.transcript[index].content ?? '';
		const at = content.toLowerCase().indexOf(needle);
		if (at < 0) {
			continue;
		}
		const start = Math.max(0, at - 40);
		const end = Math.min(content.length, at + needle.length + 80);
		const body = content.slice(start, end).replace(/\s+/g, ' ').trim();
		return `${start > 0 ? '…' : ''}${body}${end < content.length ? '…' : ''}`;
	}
	return undefined;
}

function emptyUsage(): SessionUsage {
	return { inputTokens: 0, outputTokens: 0, requests: 0, cost: 0 };
}

export class SessionStore {
	constructor(private readonly dir: string) {
		mkdirSync(dir, { recursive: true });
	}

	list(): Session[] {
		const sessions: Session[] = [];
		let names: string[] = [];
		try {
			names = readdirSync(this.dir);
		} catch {
			return sessions;
		}
		for (const name of names) {
			if (!name.endsWith('.json')) {
				continue;
			}
			try {
				sessions.push(this.normalize(JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as Session));
			} catch {
				continue;
			}
		}
		return sessions.sort((left, right) => right.updatedAt - left.updatedAt);
	}

	get(id: string): Session | undefined {
		try {
			return this.normalize(JSON.parse(readFileSync(this.file(id), 'utf8')) as Session);
		} catch {
			return undefined;
		}
	}

	/** Builds the document for a new chat without writing it — unused chats are never persisted. */
	build(
		policy: SessionPolicy,
		id: string = newSessionId(),
		defaults: { contextForm?: ContextForm; reasoningEffort?: ReasoningEffort; contextWindow?: number; workspace?: string } = {},
	): Session {
		const now = Date.now();
		return {
			id: safeId(id),
			title: UNTITLED,
			createdAt: now,
			updatedAt: now,
			policy: { ...policy },
			workspace: defaults.workspace,
			contextForm: defaults.contextForm ?? 'rendered',
			reasoningEffort: defaults.reasoningEffort ?? 'auto',
			contextWindow: defaults.contextWindow ?? 0,
			transcript: [],
			turnIndex: 0,
			cursor: null,
			marks: [],
			created: [],
			createdDirs: [],
			usage: emptyUsage(),
		};
	}

	/** Drops chats that were created but never used, so they never show up in the history. */
	prune(): number {
		let dropped = 0;
		for (const session of this.list()) {
			if (!unusedChat(session)) {
				continue;
			}
			try {
				unlinkSync(this.file(session.id));
				dropped += 1;
			} catch {
				continue;
			}
		}
		return dropped;
	}

	/**
	 * Rewrites the legacy `(fork)` titles into the numbered scheme (`Title (fork 1)`, `(fork 2)`, …)
	 * in creation order, so forks made by earlier versions stop stacking “(fork)” onto “(fork)”.
	 */
	tidyForkTitles(): number {
		const sessions = this.list();
		const used = new Set(sessions.map((session) => session.title));
		let renamed = 0;
		for (const session of [...sessions].sort((left, right) => left.createdAt - right.createdAt)) {
			if (!/\(fork\)/i.test(session.title)) {
				continue;
			}
			const base = forkBase(session.title);
			let number = 1;
			while (used.has(`${base} (fork ${number})`)) {
				number += 1;
			}
			used.delete(session.title);
			session.title = `${base} (fork ${number})`;
			used.add(session.title);
			this.save(session);
			renamed += 1;
		}
		return renamed;
	}

	/** Fork a session: same conversation, fresh identity, no restore points. */
	copy(source: Session, id: string = newSessionId(), title?: string): Session {
		const clean = safeId(id);
		if (this.get(clean)) {
			throw new Error(`session ${clean} already exists`);
		}
		const now = Date.now();
		const session: Session = {
			...structuredClone(source),
			id: clean,
			title: title ?? `${source.title} (fork)`,
			createdAt: now,
			updatedAt: now,
			cursor: null,
			marks: [],
			// A fork is a new chat: the files its parent created are not its own to delete unreviewed.
			created: [],
			createdDirs: [],
			createdRoot: undefined,
			usage: emptyUsage(),
		};
		this.save(session);
		return session;
	}

	save(session: Session): void {
		session.updatedAt = Date.now();
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(this.file(session.id), JSON.stringify(session));
	}

	remove(id: string): void {
		try {
			unlinkSync(this.file(id));
		} catch {
			return;
		}
	}

	private file(id: string): string {
		return join(this.dir, `${safeId(id)}.json`);
	}

	private normalize(session: Session): Session {
		// A summary message at the head belongs to the old destructive model; the canonical transcript
		// never holds one. Keep the text as model context, then remove the message.
		const stored = Array.isArray(session.transcript) ? session.transcript.filter((message) => message && typeof message === 'object') : [];
		const legacyHead = stored.find((message) => message?.summarized === true);
		const transcript = sanitizeMessages(stored).filter((message) => message?.summarized !== true);
		const legacy = (session as Session & { summary?: { text?: unknown; at?: unknown } }).summary;
		const modelContext = normalizeModelContext(session.modelContext, transcript) ?? legacyModelContext(legacy, legacyHead);
		const { summary: _legacy, workflow: _workflow, ...rest } = session as Session & { summary?: unknown; workflow?: unknown };
		// A delegated session fails closed on a missing or damaged capability/tool snapshot: falling
		// back to the mode's full set would silently widen a child.
		const delegated = Boolean(session.subagent || session.parentId);
		const capabilities =
			session.policy?.capabilities === undefined
				? delegated
					? []
					: undefined
				: (asCapabilities(session.policy.capabilities) ?? []);
		return {
			...rest,
			title: session.title || UNTITLED,
			// A session on disk is untrusted input like any other: a stale or hand-edited policy that
			// names a mode, approval or sandbox the gates do not know falls back to the safe value.
			policy: {
				...session.policy,
				workMode: asWorkMode(session.policy?.workMode),
				capabilities,
				// A delegated session cannot fall back to the live settings for rules: that could grant
				// an allow it never held. Empty rules are the fail-closed snapshot.
				rules: delegated ? (asRuleSet(session.policy?.rules) ?? { allow: [], ask: [], deny: [] }) : asRuleSet(session.policy?.rules),
				tools: delegated ? (toolNames(session.policy?.tools) ?? []) : toolNames(session.policy?.tools),
				network: session.policy?.network === true,
				approval: asApproval(session.policy?.approval),
				// A delegated session can never ask a surface, whatever the file says.
				approvalResponse: delegated ? 'never' : asApprovalResponse(session.policy?.approvalResponse),
				sandboxMode: asSandboxMode(session.policy?.sandboxMode, delegated ? 'workspace-read' : DEFAULT_SANDBOX_MODE),
			},
			policyRevision: typeof session.policyRevision === 'string' ? session.policyRevision : undefined,
			// Only a string is a workspace; a hand-edited value falls back to the directory the chat ran
			// in, which is what the history uses for sessions written before the field existed.
			workspace: typeof session.workspace === 'string' ? session.workspace : undefined,
			// Levels come from a menu in one build and from a JSON file the next: an unknown value must
			// not travel to an endpoint. A session without one keeps inheriting the setting.
			reasoningEffort: session.reasoningEffort === undefined ? undefined : asReasoningEffort(session.reasoningEffort),
			// Attachment references are checked too: a hand-edited id must never become a path, and a
			// media type is derived from the id rather than trusted.
			transcript,
			modelContext,
			turnIndex: session.turnIndex ?? 0,
			cursor: sanitizeCursor(session.cursor ?? null),
			// Marks from the shadow-snapshot era have no journal to restore to, so they are dropped.
			marks: (session.marks ?? []).filter((mark) => typeof mark.entryCount === 'number'),
			created: uniqueCreated(
				(Array.isArray(session.created) ? session.created : [])
					.map(createdPath)
					.filter((path): path is string => path !== undefined),
			).slice(-MAX_CREATED_PATHS),
			createdDirs: uniqueCreated(
				(Array.isArray(session.createdDirs) ? session.createdDirs : [])
					.map(createdPath)
					.filter((path): path is string => path !== undefined),
			).slice(-MAX_CREATED_PATHS),
			createdRoot: typeof session.createdRoot === 'string' ? session.createdRoot : undefined,
			parentId: typeof session.parentId === 'string' ? session.parentId : undefined,
			subagent: typeof session.subagent === 'string' ? session.subagent : undefined,
			subagentDone: session.subagentDone === true,
			subagents: sanitizeSubagentLinks(session.subagents),
			usage: session.usage ?? emptyUsage(),
			instructions: session.instructions ?? [],
		};
	}
}

/** A stored message list with its attachments validated; a hand-edited file is untrusted input. */
function sanitizeMessages(messages: unknown): Message[] {
	if (!Array.isArray(messages)) {
		return [];
	}
	return messages.map((value) => {
		if (!value || typeof value !== 'object') {
			return value as Message;
		}
		const message = value as Message;
		const attachments = asAttachments((value as { attachments?: unknown }).attachments);
		return { ...message, attachments };
	});
}

/** A stored model context is untrusted too: coverage must be a real turn boundary. */
function normalizeModelContext(value: unknown, transcript: readonly Message[]): ModelContext | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
	const covers = record.covers;
	const version = record.version;
	const at = record.at;
	if (!summary || !Number.isInteger(covers) || (covers as number) < 0 || (covers as number) > transcript.length) {
		return undefined;
	}
	if (!Number.isInteger(version) || (version as number) < 1 || typeof at !== 'number') {
		return undefined;
	}
	const count = covers as number;
	if (count > 0 && count < transcript.length && transcript[count]?.role !== 'user') {
		return undefined;
	}
	const context: ModelContext = { summary, covers: count, version: version as number, at };
	if (typeof record.model === 'string' && record.model.trim()) {
		context.model = record.model.trim().slice(0, 200);
	}
	if (typeof record.hash === 'string' && /^[a-f0-9]{16,64}$/.test(record.hash)) {
		context.hash = record.hash;
	}
	return context;
}

/** The old `summary` field and its head message, kept as context with no recoverable originals. */
function legacyModelContext(
	legacy: { text?: unknown; at?: unknown } | undefined,
	head: Message | undefined,
): ModelContext | undefined {
	const fromField = typeof legacy?.text === 'string' ? legacy.text.trim() : '';
	const fromHead = head?.summarized
		? head.content.replace(/^Conversation summary \(compacted\):\s*/i, '').trim()
		: '';
	const summary = fromField || fromHead;
	if (!summary) {
		return undefined;
	}
	const at = typeof legacy?.at === 'number' ? legacy.at : typeof head?.at === 'number' ? head.at : Date.now();
	return { summary, covers: 0, version: 1, at };
}

/** A suspended turn's graph state may carry messages; those attachments are session input too. */
function sanitizeCursor(cursor: Cursor | null): Cursor | null {
	if (!cursor || !cursor.state || typeof cursor.state !== 'object') {
		return cursor;
	}
	const state = cursor.state as Record<string, unknown>;
	const next = { ...state };
	if (Array.isArray(state.messages)) {
		next.messages = sanitizeMessages(state.messages);
	}
	if (Array.isArray(state.transcript)) {
		next.transcript = sanitizeMessages(state.transcript);
	}
	if (Array.isArray(state.trailer)) {
		next.trailer = sanitizeMessages(state.trailer);
	}
	// `Set` is not JSON: a cursor written by the turn pipeline carries `{}` here, and a resumed
	// turn would crash on `writes.add`. Revive it from its array.
	if (state.writes !== undefined) {
		next.writes = new Set(Array.isArray(state.writes) ? state.writes.filter((path): path is string => typeof path === 'string') : []);
	}
	// A cursor written while workflows existed may carry their state; it is dead weight now.
	delete next.workflow;
	delete next.basePolicy;
	return { ...cursor, state: next };
}

declare module 'cordis' {
	interface Context {
		sessions: Sessions;
	}
}

/**
 * The session service owns the store and the active pointer, and announces changes as
 * `sessions/changed` events so every surface refreshes without being wired together.
 */
export class Sessions extends Service {
	static inject = ['host', 'settings', 'log'];

	private _store: SessionStore | undefined;
	private _activeId: string | null = null;
	/** A chat that has been created but never used yet: it stays in memory until its first turn. */
	private _draft: Session | null = null;
	/** Sessions whose model context hash this process already checked against the covered prefix. */
	private readonly verified = new WeakSet<Session>();

	constructor(ctx: Context) {
		super(ctx, 'sessions');
	}

	private get store(): SessionStore {
		if (!this._store) {
			this._store = new SessionStore(this.ctx.host.storage.sessions);
			const dropped = this._store.prune();
			if (dropped) {
				this.ctx.log.message(`sessions: dropped ${dropped} unused chat(s)`);
				this.sweepAttachments();
			}
			const renamed = this._store.tidyForkTitles();
			if (renamed) {
				this.ctx.log.message(`sessions: numbered ${renamed} legacy fork(s)`);
			}
		}
		return this._store;
	}

	changed(id?: string): void {
		this.ctx.emit('sessions/changed', id);
	}

	/**
	 * The history: chats that have been used. An unused draft is not part of it, and neither is a
	 * subagent session — it is reached from the `agent` card that spawned it, not from the chat list.
	 */
	list(): Session[] {
		return this.store.list().filter((session) => !session.parentId);
	}

	get(id: string): Session | undefined {
		return this._draft?.id === id ? this._draft : this.store.get(id);
	}

	require(id: string): Session {
		const session = this.get(id);
		if (!session) {
			throw new Error(`unknown session ${id}`);
		}
		return session;
	}

	/** Persists a chat — unless it is still an unused draft, which would only add noise. */
	save(session: Session): void {
		if (this._draft?.id === session.id && unusedChat(session)) {
			return;
		}
		this.store.save(session);
		if (this._draft?.id === session.id) {
			this._draft = null;
		}
	}

	/**
	 * Chats whose title or transcript mentions `query`, most recently updated first. `where` filters
	 * before the limit, so a scoped search still fills its page from the scope it names.
	 */
	search(
		query: string,
		limit = 40,
		where?: (session: Session) => boolean,
	): { id: string; title: string; updatedAt: number; snippet?: string }[] {
		const needle = query.trim().toLowerCase();
		if (!needle) {
			return [];
		}
		const hits: { id: string; title: string; updatedAt: number; snippet?: string }[] = [];
		for (const session of this.list()) {
			if (where && !where(session)) {
				continue;
			}
			const snippet = matchSnippet(session, needle);
			if (!snippet && !session.title.toLowerCase().includes(needle)) {
				continue;
			}
			hits.push({ id: session.id, title: session.title, updatedAt: session.updatedAt, snippet });
			if (hits.length >= limit) {
				break;
			}
		}
		return hits;
	}

	active(): Session | undefined {
		if (!this._activeId) {
			// Start on this workspace's newest chat. Reaching into another folder's history here would
			// put a foreign conversation in the composer before the reader asked for it.
			this._activeId = this.list().find((session) => inWorkspace(session, this.ctx.host.workspace()))?.id ?? null;
		}
		return this._activeId ? this.get(this._activeId) : undefined;
	}

	/** Returns the active session, creating one if the workspace has none yet. */
	ensureActive(policy: SessionPolicy): Session {
		const current = this.active();
		if (current) {
			return current;
		}
		return this.create(policy);
	}

	setActive(id: string): void {
		this._activeId = id;
		this.changed(id);
	}

	create(policy: SessionPolicy, id?: string): Session {
		const config = this.ctx.settings.get();
		const session = this.store.build(policy, id, {
			contextForm: config.contextForm,
			reasoningEffort: config.reasoningEffort,
			contextWindow: config.contextWindow,
			workspace: this.ctx.host.workspace(),
		});
		this._draft = session;
		this._activeId = session.id;
		this.changed(session.id);
		return session;
	}

	/**
	 * A subagent's own conversation: persisted immediately, hidden from the history, and never the
	 * active chat. Its parent records the tool-call link that opens it.
	 */
	createChild(
		policy: SessionPolicy,
		id: string,
		init: { title: string; parentId: string; subagent: string; transcript: Message[]; policyRevision?: string },
	): Session {
		const config = this.ctx.settings.get();
		const session = this.store.build(policy, id, {
			contextForm: config.contextForm,
			reasoningEffort: config.reasoningEffort,
			contextWindow: config.contextWindow,
			workspace: this.ctx.host.workspace(),
		});
		session.title = init.title;
		session.parentId = init.parentId;
		session.subagent = init.subagent;
		session.subagentDone = false;
		session.policyRevision = init.policyRevision;
		session.transcript = [...init.transcript];
		session.turnIndex = init.transcript.some((message) => message.role === 'user') ? 1 : 0;
		this.store.save(session);
		return session;
	}

	fork(sourceId?: string): Session {
		const source = (sourceId ? this.get(sourceId) : undefined) ?? this.active();
		if (!source) {
			return this.create({
				workMode: 'sw',
				approval: 'manual',
				approvalResponse: 'ask',
				network: false,
				sandboxMode: DEFAULT_SANDBOX_MODE,
				workingDirectory: '',
				commandTimeout: 60,
				commandTimeoutOverride: false,
				denyReadPaths: [],
				model: 'auto',
			});
		}
		const copy = this.store.copy(source, undefined, this.forkTitle(source.title));
		this._activeId = copy.id;
		this.changed(copy.id);
		return copy;
	}

	/** The next free `(fork N)` for this conversation, counting forks of forks in the same series. */
	private forkTitle(source: string): string {
		const base = forkBase(source);
		let highest = 0;
		for (const session of this.list()) {
			const match = /^(.+?) \(fork (\d+)\)$/iu.exec(session.title);
			if (match && match[1] === base) {
				highest = Math.max(highest, Number(match[2]));
			}
		}
		return `${base} (fork ${highest + 1})`;
	}

	remove(id: string): void {
		// A subagent's conversation has no life of its own: removing its parent removes it too.
		this.removeChildren(id);
		if (this._draft?.id === id) {
			this._draft = null;
		} else {
			this.store.remove(id);
		}
		if (this._activeId === id) {
			this._activeId = null;
		}
		this.sweepAttachments();
		this.changed(id);
	}

	/** Removes a session's descendants, deepest first: a removed chat cannot leave a child behind. */
	private removeChildren(id: string): void {
		for (const child of this.store.list().filter((session) => session.parentId === id)) {
			this.removeChildren(child.id);
			this.store.remove(child.id);
		}
	}

	/** Every attachment id a stored chat mentions, including the state of a suspended turn. */
	attachmentIds(): Set<string> {
		const ids = new Set<string>();
		const collect = (messages: readonly Message[] | undefined): void => {
			for (const message of messages ?? []) {
				for (const part of message.attachments ?? []) {
					const id = attachmentIdOf(part);
					if (id) {
						ids.add(id);
					}
				}
			}
		};
		// Every stored chat, hidden subagent sessions included: their images are still in use.
		for (const session of this.store.list()) {
			collect(session.transcript);
			const state = session.cursor?.state as { messages?: Message[]; transcript?: Message[] } | undefined;
			collect(state?.messages);
			collect(state?.transcript);
		}
		return ids;
	}

	/** Drops attachment files no stored chat mentions any more; the store keeps a grace period. */
	private sweepAttachments(): void {
		this.ctx.get('attachments')?.sweep(this.attachmentIds());
	}

	/** Truncates a fork at a turn boundary: the copy has no marks of its own. */
	truncate(id: string, length: number): void {
		const session = this.require(id);
		session.transcript = session.transcript.slice(0, length);
		session.marks = session.marks.filter((mark) => mark.length <= session.transcript.length);
		session.cursor = null;
		this.invalidateModelContext(session, session.transcript.length);
		this.save(session);
		this.changed(id);
	}

	/**
	 * Cuts the transcript back to `index` for an edited prompt that is about to be re-run. Takes the
	 * live session object a running turn holds: reading the chat back from disk would return a second
	 * copy, and whichever saved last would win. Marks at or after the cut belong to the turns being
	 * discarded (the edited turn's own mark included) and go with them.
	 *
	 * Returns a reason when the message cannot be edited.
	 */
	rewriteAt(session: Session, index: number): string | undefined {
		if (!canRewrite(session, index)) {
			return 'that message is not a prompt that can be edited';
		}
		session.transcript = session.transcript.slice(0, index);
		session.marks = session.marks.filter((mark) => mark.length < index);
		this.invalidateModelContext(session, session.transcript.length);
		this.save(session);
		this.changed(session.id);
	}

	/**
	 * Fork the conversation as it stood after `length` transcript messages — the "fork from this
	 * message" action: same policy and generation settings, fresh id, empty checkpoints.
	 */
	forkAt(sourceId: string | undefined, length: number): Session {
		const copy = this.fork(sourceId);
		if (length > 0 && length < copy.transcript.length) {
			this.truncate(copy.id, length);
			// `truncate` works on the stored copy, so hand back that object.
			return this.require(copy.id);
		}
		return copy;
	}

	/**
	 * Drops the last user turn (its message and everything the model answered with) and returns the
	 * prompt, images included, so the surface can run it again. An empty text is not an empty prompt:
	 * an image-only message is still something to replay. The transcript it replaced travels with the
	 * prompt, so a stopped generation can put the turn back instead of losing it.
	 */
	replayLast(id: string): { text: string; attachments?: AttachmentPart[]; replaced: Message[] } {
		const session = this.require(id);
		if (session.cursor) {
			return { text: '', replaced: [] };
		}
		let at = session.transcript.length - 1;
		while (at >= 0 && session.transcript[at]!.role !== 'user') {
			at -= 1;
		}
		if (at < 0) {
			return { text: '', replaced: [] };
		}
		const message = session.transcript[at]!;
		const replay = { text: message.content, attachments: message.attachments, replaced: [...session.transcript] };
		session.transcript = session.transcript.slice(0, at);
		session.marks = session.marks.filter((mark) => mark.length <= session.transcript.length);
		this.invalidateModelContext(session, session.transcript.length);
		this.save(session);
		return replay;
	}

	/**
	 * The index of the reply a swipe talks about: the last thing the assistant said in full. A turn
	 * that ended in a tool call has no reply of its own, so the answer is the last message with text
	 * and no calls hanging off it. `turn` narrows the search to one turn, which is what the `‹ n/m ›`
	 * nav on a reply that is no longer the last one needs.
	 */
	private replyIndex(session: Session, turn?: number): number {
		const end =
			turn === undefined
				? session.transcript.length
				: (turnsOf(session.transcript).find((item) => item.index === turn)?.at ?? session.transcript.length);
		for (let at = end - 1; at >= 0; at -= 1) {
			const message = session.transcript[at]!;
			if (message.role === 'assistant' && !message.toolCalls?.length && message.content.trim()) {
				return at;
			}
		}
		return -1;
	}

	/**
	 * The variants of the last reply, so a regenerate or a swipe can grow that list instead of losing
	 * what the user already read. A reply that was never swiped has one variant: itself.
	 */
	swipeCarry(id: string): SwipeCarry | undefined {
		const session = this.require(id);
		const at = this.replyIndex(session);
		if (at < 0) {
			return undefined;
		}
		const message = session.transcript[at]!;
		return {
			swipes: [...(message.swipes ?? [message.content])],
			swipeId: message.swipeId ?? 0,
			swipeInfo: [...(message.swipeInfo ?? [])],
		};
	}

	/** Shows another variant of a reply. This only moves the pointer: nothing is generated. */
	setSwipe(id: string, index: number, turn?: number): boolean {
		const session = this.require(id);
		const at = this.replyIndex(session, turn);
		if (at < 0) {
			return false;
		}
		const message = session.transcript[at]!;
		const swipes = message.swipes?.length ? message.swipes : [message.content];
		if (!Number.isInteger(index) || index < 0 || index >= swipes.length) {
			return false;
		}
		message.swipes = swipes;
		message.swipeId = index;
		message.content = swipes[index]!;
		this.invalidateModelContext(session, at);
		this.save(session);
		this.changed(id);
		return true;
	}

	/**
	 * Sets a character's opening line as the first turn of a chat that has not said anything yet.
	 * A chat that already holds a real message is never rewritten: the caller reports that instead.
	 */
	greet(id: string, text: string, index = 0): boolean {
		const session = this.require(id);
		const content = text.trim();
		if (!content || session.cursor || session.transcript.some((message) => !message.greeting)) {
			return false;
		}
		session.transcript = [{ role: 'assistant', content, greeting: true, at: Date.now() }];
		session.modelContext = undefined;
		this.verified.delete(session);
		session.greetingIndex = index;
		this.save(session);
		this.changed(id);
		return true;
	}

	/** Which of a character's greetings a chat opened with, for the UI to show. */
	greeted(id: string): number | undefined {
		return this.get(id)?.greetingIndex;
	}

	/**
	 * Records a summary of the canonical transcript's prefix. The transcript, marks and cursor are
	 * left alone: compaction is a model-context operation, not a chat edit.
	 */
	recordModelContext(session: Session, text: string, covers: number, model?: string): ModelContext | undefined {
		const summary = text.trim();
		if (!summary || !Number.isInteger(covers) || covers < 0 || covers > session.transcript.length) {
			return undefined;
		}
		if (session.modelContext && covers < session.modelContext.covers) {
			return undefined;
		}
		if (covers > 0 && covers < session.transcript.length && session.transcript[covers]?.role !== 'user') {
			return undefined;
		}
		const context: ModelContext = {
			summary,
			covers,
			version: (session.modelContext?.version ?? 0) + 1,
			at: Date.now(),
			...(model ? { model } : {}),
			hash: modelContextDigest(session.transcript.slice(0, covers)),
		};
		session.modelContext = context;
		this.verified.add(session);
		this.save(session);
		this.changed(session.id);
		return context;
	}

	/** A cut below the summarized prefix makes the summary stale; the caller saves the session. */
	invalidateModelContext(session: Session, cutLength: number): void {
		if (session.modelContext && cutLength < session.modelContext.covers) {
			session.modelContext = undefined;
			this.verified.delete(session);
		}
	}

	/**
	 * Checks a stored summary against the canonical prefix once per live session object. A hand-edited
	 * covered message makes it stale; the summary is dropped and the next turn can compact again.
	 */
	verifyModelContext(session: Session): boolean {
		const context = session.modelContext;
		if (!context || !context.hash || this.verified.has(session)) {
			return true;
		}
		if (modelContextDigest(session.transcript.slice(0, context.covers)) === context.hash) {
			this.verified.add(session);
			return true;
		}
		session.modelContext = undefined;
		this.verified.delete(session);
		this.save(session);
		this.changed(session.id);
		return false;
	}
}

export const sessionsPlugin = Sessions;
