// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Service, type Context } from 'cordis';
import { asImagePart } from '../lib/images';
import { WORKSPACE_BOUNDARY, asApproval, asWorkMode } from '../lib/policy';
import type { ContextForm } from '../lib/prompt';
import { turnsOf } from '../lib/turns';
import type { ImagePart, Message, ReasoningEffort, SessionPolicy, SwipeInfo } from '../lib/types';

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
 * The record of a compaction. `covers` is how many messages of the conversation the text stands in
 * for — counted in the conversation, not in the transcript the summary now heads, so a summary that is
 * extended reports everything it covers — which is what lets the next compaction carry on from it and
 * what `/context` tells the reader.
 */
export interface SessionSummary {
	text: string;
	covers: number;
	at: number;
}

/** The message a compaction leaves at the head of the transcript. */
export function summaryMessage(text: string): Message {
	return { role: 'system', content: `Conversation summary (compacted):\n\n${text}`, summarized: true };
}

/** Whether a message is a compaction's summary, which is how a transcript says what its head stands for. */
export function isSummaryMessage(message: Message | undefined): boolean {
	return message?.summarized === true;
}

/**
 * Moves the restore points when `removed` messages were folded into one summary at the head. A mark
 * inside the folded stretch cannot be honoured any more — those messages are gone — so it is dropped;
 * the rest shift by what was removed, plus the summary that now sits in front of them.
 */
export function rebaseMarks(marks: readonly Mark[], removed: number): Mark[] {
	return marks
		.filter((mark) => mark.length >= removed)
		.map((mark) => ({ ...mark, length: mark.length - removed + 1 }));
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
	const message = session.transcript[index];
	return message?.role === 'user' && !isSummaryMessage(message);
}

export interface Cursor {
	node: string;
	payload: unknown;
	step: number;
	state: unknown;
}

export interface Session {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	policy: SessionPolicy;
	/** How much of the transcript this chat sends back (new chats start from the Context setting). */
	contextForm?: ContextForm;
	/** Thinking effort for this chat (new chats start from the Reasoning effort setting). */
	reasoningEffort?: ReasoningEffort;
	/**
	 * Window override in tokens for this chat; `0` (the default) resolves from the model profile, so
	 * switching models re-resolves it. It overrides the model's window, it does not cap history.
	 */
	contextWindow?: number;
	/** The last compaction: what it covers, so the next one extends it instead of starting over. */
	summary?: SessionSummary;
	transcript: Message[];
	turnIndex: number;
	cursor: Cursor | null;
	marks: Mark[];
	/**
	 * Workspace-relative forward-slash paths this chat created: file-tool writes and conservatively
	 * parsed shell creations. Bound to `createdRoot`; a different workspace discards them.
	 */
	created?: string[];
	/** The resolved workspace `created` paths are relative to. */
	createdRoot?: string;
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
	return !session.transcript.length && !session.usage.requests && session.title === UNTITLED;
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
		defaults: { contextForm?: ContextForm; reasoningEffort?: ReasoningEffort; contextWindow?: number } = {},
	): Session {
		const now = Date.now();
		return {
			id: safeId(id),
			title: UNTITLED,
			createdAt: now,
			updatedAt: now,
			policy: { ...policy },
			contextForm: defaults.contextForm ?? 'rendered',
			reasoningEffort: defaults.reasoningEffort ?? 'auto',
			contextWindow: defaults.contextWindow ?? 0,
			transcript: [],
			turnIndex: 0,
			cursor: null,
			marks: [],
			created: [],
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
		return {
			...session,
			title: session.title || UNTITLED,
			// A session on disk is untrusted input like any other: a stale or hand-edited policy that
			// names a mode or approval the gates do not know falls back to the safe pair.
			policy: {
				...session.policy,
				workMode: asWorkMode(session.policy?.workMode),
				approval: asApproval(session.policy?.approval),
			},
			// Image references are checked too: a hand-edited id must never become a path, and a media
			// type is derived from the id rather than trusted.
			transcript: (session.transcript ?? []).map((message) => {
				if (!message.images?.length) {
					return message;
				}
				const images = message.images.map(asImagePart).filter((image): image is ImagePart => image !== undefined);
				return { ...message, images: images.length ? images : undefined };
			}),
			turnIndex: session.turnIndex ?? 0,
			cursor: session.cursor ?? null,
			// Marks from the shadow-snapshot era have no journal to restore to, so they are dropped.
			marks: (session.marks ?? []).filter((mark) => typeof mark.entryCount === 'number'),
			created: uniqueCreated(
				(Array.isArray(session.created) ? session.created : [])
					.map(createdPath)
					.filter((path): path is string => path !== undefined),
			).slice(-MAX_CREATED_PATHS),
			createdRoot: typeof session.createdRoot === 'string' ? session.createdRoot : undefined,
			usage: session.usage ?? emptyUsage(),
			instructions: session.instructions ?? [],
		};
	}
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

	/** The history: chats that have been used. An unused draft is not part of it. */
	list(): Session[] {
		return this.store.list();
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

	/** Chats whose title or transcript mentions `query`, most recently updated first. */
	search(query: string, limit = 40): { id: string; title: string; updatedAt: number; snippet?: string }[] {
		const needle = query.trim().toLowerCase();
		if (!needle) {
			return [];
		}
		const hits: { id: string; title: string; updatedAt: number; snippet?: string }[] = [];
		for (const session of this.list()) {
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
			this._activeId = this.list()[0]?.id ?? null;
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
		});
		this._draft = session;
		this._activeId = session.id;
		this.changed(session.id);
		return session;
	}

	fork(sourceId?: string): Session {
		const source = (sourceId ? this.get(sourceId) : undefined) ?? this.active();
		if (!source) {
			return this.create({
				workMode: 'sw',
				approval: 'manual',
				network: false,
				workingDirectory: '',
				commandTimeout: 60,
				commandTimeoutOverride: false,
				denyReadPaths: [],
				confinement: { ...WORKSPACE_BOUNDARY },
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

	/** Every attachment id a stored chat mentions, including the state of a suspended turn. */
	attachmentIds(): Set<string> {
		const ids = new Set<string>();
		const collect = (messages: readonly Message[] | undefined): void => {
			for (const message of messages ?? []) {
				for (const image of message.images ?? []) {
					ids.add(image.id);
				}
			}
		};
		for (const session of this.list()) {
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
		session.cursor = null;
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
	replayLast(id: string): { text: string; images?: ImagePart[]; replaced: Message[] } {
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
		const replay = { text: message.content, images: message.images, replaced: [...session.transcript] };
		session.transcript = session.transcript.slice(0, at);
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
	 * Writes a compaction down: the summary replaces the turns it covers in the chat record, and the
	 * restore points that sat inside those turns move with it. `removed` is how many messages the
	 * record itself loses, which is not `summary.covers` once a summary is extended. The caller has
	 * already decided what the summary says; this only keeps the record and the marks consistent.
	 *
	 * It takes the caller's own session object rather than an id, because a turn holds one live copy
	 * while it runs — reading the chat back from disk here would return a second copy, and whichever of
	 * the two was saved last would silently win.
	 */
	compacted(session: Session, summary: SessionSummary, transcript: Message[], removed: number): void {
		session.summary = summary;
		session.marks = rebaseMarks(session.marks, removed);
		session.transcript = transcript;
		session.cursor = null;
		this.save(session);
		this.changed(session.id);
	}
}

export const sessionsPlugin = Sessions;
