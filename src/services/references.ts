// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { Service, type Context } from 'cordis';
import { MAX_DOCUMENT_BYTES, sniffDocument } from '../lib/attachments';
import { MAX_IMAGE_BYTES, sniffImage } from '../lib/images';
import { formatReference, looksLikePath, parseReferences, type ParsedReference } from '../lib/references';
import { guardPath, isDeniedRead } from '../lib/sandbox';
import type {
	AttachmentPart,
	DocumentAttachment,
	ImageAttachment,
	ReferenceResolution,
	ResolvedPart,
	SandboxMode,
	SessionPolicy,
	SourceRange,
	TextAttachment,
} from '../lib/types';

/**
 * Explicit `@` references, as one core service.
 *
 * The parser is pure (`lib/references`); this service owns the part that touches the workspace:
 * path guards, type recognition, budgets, and the stable framing inputs. Resolvers may add formats;
 * the core still decides placement, clamping and rendering. It deliberately does not import `vscode`
 * — the VS Code text/symbol providers are registered by the UI layer, and the headless test kernel
 * uses the filesystem fallback.
 */

declare module 'cordis' {
	interface Context {
		references: References;
	}
}

export interface ReferenceScope {
	workingDirectory: string;
	sandboxMode: SandboxMode;
	denyReadPaths: readonly string[];
}

export function scopeOf(policy: Pick<SessionPolicy, 'workingDirectory' | 'sandboxMode' | 'denyReadPaths'>): ReferenceScope {
	return {
		workingDirectory: policy.workingDirectory,
		sandboxMode: policy.sandboxMode,
		denyReadPaths: policy.denyReadPaths,
	};
}

export interface ReferenceLimits {
	perReference: number;
	total: number;
	references: number;
	folderEntries: number;
	mentionItems: number;
	queryChars: number;
	maxReadBytes: number;
	maxImageBytes: number;
	maxImages: number;
	maxImageTotalBytes: number;
	maxDocumentBytes: number;
	maxDocuments: number;
	maxDocumentPages: number;
	maxDocumentTotalPages: number;
	maxDocumentText: number;
}

export const REFERENCE_LIMITS: ReferenceLimits = {
	perReference: 20_000,
	total: 60_000,
	references: 20,
	folderEntries: 200,
	mentionItems: 25,
	queryChars: 256,
	maxReadBytes: 2_000_000,
	maxImageBytes: MAX_IMAGE_BYTES,
	maxImages: 6,
	maxImageTotalBytes: 12 * 1024 * 1024,
	maxDocumentBytes: MAX_DOCUMENT_BYTES,
	maxDocuments: 4,
	maxDocumentPages: 20,
	maxDocumentTotalPages: 40,
	maxDocumentText: 60_000,
};

export interface TextReader {
	read(absolute: string): Promise<string>;
}

export interface SymbolProvider {
	/** 1-based inclusive line range of the smallest symbol matching `name`. */
	range(absolute: string, name: string): Promise<SourceRange | undefined>;
}

export interface UriLike {
	scheme: string;
	fsPath: string;
}

export interface ClaimInput {
	reference: ParsedReference;
	path: string;
	displayPath: string;
	size: number;
	head: Uint8Array;
}

export interface ResolveInput extends ClaimInput {
	readText(maxBytes: number): Promise<string>;
	readBytes(maxBytes: number): Promise<Uint8Array>;
	store(data: Uint8Array, name?: string): Promise<Omit<ImageAttachment, 'origin'> | Omit<DocumentAttachment, 'origin'>>;
	limits: ReferenceLimits;
	signal: AbortSignal;
}

export interface ReferenceResolver {
	id: string;
	/** Lower claims first. Built-in text is the fallback, after every registered resolver. */
	priority?: number;
	mimes?: readonly string[];
	extensions?: readonly string[];
	claim(input: ClaimInput): boolean | Promise<boolean>;
	resolve(input: ResolveInput): Promise<ResolvedPart[]>;
}

export type ResolveResult = ReferenceResolution;

interface BudgetState {
	text: number;
	images: number;
	imageBytes: number;
	documents: number;
	pages: number;
}

interface OneResult {
	attachments: AttachmentPart[];
	notice?: string;
	error?: { token: string; message: string };
}

const IGNORED = new Set(['node_modules', '.git', 'bower_components', '.next', 'dist', 'out', 'build', 'vendor']);

export class References extends Service {
	static inject = ['attachments'];

	private readonly resolvers: ReferenceResolver[] = [];
	private textReader: TextReader | undefined;
	private symbols: SymbolProvider | undefined;

	constructor(ctx: Context) {
		super(ctx, 'references');
	}

	/** Adds a resolver, or replaces the one with the same id. Registration is an effect of the caller. */
	register(resolver: ReferenceResolver): () => void {
		const at = this.resolvers.findIndex((entry) => entry.id === resolver.id);
		if (at >= 0) {
			this.resolvers.splice(at, 1);
		}
		this.resolvers.push(resolver);
		this.resolvers.sort((left, right) => (left.priority ?? 100) - (right.priority ?? 100));
		return () => this.unregister(resolver.id);
	}

	unregister(id: string): void {
		const at = this.resolvers.findIndex((entry) => entry.id === id);
		if (at >= 0) {
			this.resolvers.splice(at, 1);
		}
	}

	/** The UI's text reader; until one is registered, files are read as UTF-8. */
	provideTextReader(reader: TextReader): () => void {
		this.textReader = reader;
		return () => {
			if (this.textReader === reader) {
				this.textReader = undefined;
			}
		};
	}

	/** The UI's symbol search; without it, `@symbol` reports that search is unavailable. */
	provideSymbols(symbols: SymbolProvider): () => void {
		this.symbols = symbols;
		return () => {
			if (this.symbols === symbols) {
				this.symbols = undefined;
			}
		};
	}

	/** Whether the picker should present this type as supported. */
	supports(extension: string, mime?: string): boolean {
		const ext = extension.toLowerCase().replace(/^\./, '');
		if (mime === 'application/pdf' || ext === 'pdf') {
			return this.resolvers.some(
				(resolver) =>
					resolver.mimes?.includes('application/pdf') ||
					resolver.extensions?.some((value) => value.toLowerCase().replace(/^\./, '') === 'pdf'),
			);
		}
		return true;
	}

	/** Resolve every `@` reference in a prompt, in order, deduped. */
	async resolve(text: string, scope: ReferenceScope, signal: AbortSignal): Promise<ResolveResult> {
		if (!scope.workingDirectory.trim()) {
			return { attachments: [] };
		}
		const parsed = parseReferences(text);
		if (!parsed.length) {
			return { attachments: [] };
		}
		const attachments: AttachmentPart[] = [];
		const notices: string[] = [];
		const errors: { token: string; message: string }[] = [];
		const seen = new Set<string>();
		const state: BudgetState = { text: 0, images: 0, imageBytes: 0, documents: 0, pages: 0 };
		let count = 0;
		for (const reference of parsed) {
			signal.throwIfAborted();
			const key = `${reference.kind}|${reference.path}|${reference.range?.start ?? ''}-${reference.range?.end ?? ''}|${reference.name ?? ''}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			if (count >= REFERENCE_LIMITS.references || state.text >= REFERENCE_LIMITS.total) {
				const token = formatReference(reference);
				notices.push(`${token} omitted: reference budget reached`);
				attachments.push(note(`[reference ${token} omitted: reference budget reached]`));
				continue;
			}
			count += 1;
			const result = await this.resolveOne(reference, scope, signal, state);
			attachments.push(...result.attachments);
			if (result.notice) {
				notices.push(result.notice);
			}
			if (result.error) {
				errors.push(result.error);
			}
		}
		return { attachments, notices: notices.length ? notices : undefined, errors: errors.length ? errors : undefined };
	}

	/** Resolve one path, for a tool or a surface that already knows which file it means. */
	async resolvePath(
		path: string,
		scope: ReferenceScope,
		signal: AbortSignal,
		options: { range?: SourceRange } = {},
	): Promise<ResolveResult> {
		if (!scope.workingDirectory.trim()) {
			return { attachments: [], errors: [{ token: path, message: 'no working directory is set' }] };
		}
		const reference: ParsedReference = {
			kind: 'file',
			path,
			range: options.range ? { start: options.range.start, end: options.range.end } : undefined,
			start: 0,
			end: 0,
		};
		const state: BudgetState = { text: 0, images: 0, imageBytes: 0, documents: 0, pages: 0 };
		const result = await this.resolveOne(reference, scope, signal, state);
		return {
			attachments: result.attachments,
			notices: result.notice ? [result.notice] : undefined,
			errors: result.error ? [result.error] : undefined,
		};
	}

	/**
	 * Fill the text of a PDF that was attached as bytes (the composer's drag/paste path). The `@` path
	 * already carries text; this is the one place a stored document is parsed after the fact.
	 */
	async completeDocument(part: DocumentAttachment, signal: AbortSignal): Promise<DocumentAttachment> {
		if (part.text !== undefined || part.textUnavailable) {
			return part;
		}
		const read = this.ctx.attachments.read(part.id);
		if (!read) {
			return { ...part, textUnavailable: true, text: '[PDF bytes are unavailable]' };
		}
		const reference: ParsedReference = { kind: 'file', path: part.name ?? part.id, start: 0, end: 0 };
		const head = read.data.subarray(0, 8 * 1024);
		const resolver = this.claiming(reference, part.id, part.name ?? part.id, read.data.byteLength, head);
		if (!resolver) {
			return {
				...part,
				textUnavailable: true,
				text: '[PDF text extraction is unavailable: install the PDF documents plugin]',
			};
		}
		const input: ResolveInput = {
			reference,
			path: part.id,
			displayPath: part.name ?? part.id,
			size: read.data.byteLength,
			head,
			readText: async () => '',
			readBytes: async () => new Uint8Array(read.data),
			store: async () => part,
			limits: REFERENCE_LIMITS,
			signal,
		};
		try {
			const parts = await resolver.resolve(input);
			const document = parts.find((entry): entry is Omit<DocumentAttachment, 'origin'> => entry.kind === 'document');
			return document ? { ...part, ...document, origin: part.origin } : { ...part, textUnavailable: true };
		} catch (error) {
			return { ...part, textUnavailable: true, text: `[PDF could not be read: ${describeError(error)}]` };
		}
	}

	/** Resolve VS Code's native references; non-file schemes are ignored. */
	async resolveUris(uris: readonly UriLike[], scope: ReferenceScope, signal: AbortSignal): Promise<ResolveResult> {
		const attachments: AttachmentPart[] = [];
		const notices: string[] = [];
		const errors: { token: string; message: string }[] = [];
		const seen = new Set<string>();
		const state: BudgetState = { text: 0, images: 0, imageBytes: 0, documents: 0, pages: 0 };
		for (const uri of uris) {
			if (uri.scheme !== 'file' || seen.has(uri.fsPath)) {
				continue;
			}
			seen.add(uri.fsPath);
			const reference: ParsedReference = { kind: 'file', path: uri.fsPath, start: 0, end: 0 };
			const one = await this.resolveOne(reference, scope, signal, state);
			attachments.push(...one.attachments);
			if (one.notice) {
				notices.push(one.notice);
			}
			if (one.error) {
				errors.push(one.error);
			}
		}
		return { attachments, notices: notices.length ? notices : undefined, errors: errors.length ? errors : undefined };
	}

	private async resolveOne(
		reference: ParsedReference,
		scope: ReferenceScope,
		signal: AbortSignal,
		state: BudgetState,
	): Promise<OneResult> {
		try {
			const absolute = await guardPath(scope.workingDirectory, reference.path, {
				access: 'read',
				sandboxMode: scope.sandboxMode,
				denyReadPaths: scope.denyReadPaths,
			});
			const info = await stat(absolute);
			const displayPath = relativePath(scope.workingDirectory, absolute) ?? reference.path;
			if (reference.kind === 'folder') {
				if (!info.isDirectory()) {
					throw new Error('not a folder');
				}
				return { attachments: [await this.folderPart(absolute, displayPath, scope)] };
			}
			if (info.isDirectory()) {
				throw new Error('it is a folder; add a trailing / to reference the folder');
			}
			if (reference.kind === 'symbol') {
				return { attachments: [await this.symbolPart(absolute, displayPath, reference, info.size)] };
			}
			const head = await readHead(absolute, 8 * 1024);
			const image = sniffImage(head);
			if (image) {
				return this.imagePart(absolute, displayPath, info.size, state);
			}
			if (sniffDocument(head)) {
				const resolver = this.claiming(reference, absolute, displayPath, info.size, head);
				if (!resolver) {
					throw new Error(
						'PDF support is not installed. Install "PDF documents" from Settings → Plugins → Install…',
					);
				}
				return this.pluginPart(resolver, reference, absolute, displayPath, info.size, head, state, signal);
			}
			const resolver = await this.claimingAsync(reference, absolute, displayPath, info.size, head);
			if (resolver) {
				return this.pluginPart(resolver, reference, absolute, displayPath, info.size, head, state, signal);
			}
			return this.textPart(reference, absolute, displayPath, info.size, head, state);
		} catch (error) {
			if (!looksLikePath(reference) && reference.kind === 'file') {
				return { attachments: [] };
			}
			const token = formatReference(reference);
			const message = describeError(error);
			return {
				attachments: [note(`[reference ${token} failed: ${message}]`, 'error', reference.path)],
				error: { token, message },
			};
		}
	}

	private claiming(reference: ParsedReference, path: string, displayPath: string, size: number, head: Uint8Array): ReferenceResolver | undefined {
		const input: ClaimInput = { reference, path, displayPath, size, head };
		for (const resolver of this.resolvers) {
			const pdf =
				resolver.mimes?.includes('application/pdf') ||
				resolver.extensions?.some((ext) => ext.toLowerCase().replace(/^\./, '') === 'pdf');
			if (!pdf) {
				continue;
			}
			try {
				if (resolver.claim(input)) {
					return resolver;
				}
			} catch {
				// A claim that throws is a claim that did not happen; the next resolver gets a look.
			}
		}
		return undefined;
	}

	private async claimingAsync(
		reference: ParsedReference,
		path: string,
		displayPath: string,
		size: number,
		head: Uint8Array,
	): Promise<ReferenceResolver | undefined> {
		const input: ClaimInput = { reference, path, displayPath, size, head };
		for (const resolver of this.resolvers) {
			try {
				if (await resolver.claim(input)) {
					return resolver;
				}
			} catch {
				// A broken plugin must not take the turn down; the text fallback still runs.
			}
		}
		return undefined;
	}

	private async pluginPart(
		resolver: ReferenceResolver,
		reference: ParsedReference,
		path: string,
		displayPath: string,
		size: number,
		head: Uint8Array,
		state: BudgetState,
		signal: AbortSignal,
	): Promise<OneResult> {
		const input: ResolveInput = {
			reference,
			path,
			displayPath,
			size,
			head,
			readText: (maxBytes) => this.readText(path, size, maxBytes),
			readBytes: (maxBytes) => this.readBytes(path, size, maxBytes),
			store: (data, name) => this.store(data, name),
			limits: REFERENCE_LIMITS,
			signal,
		};
		const parts = await resolver.resolve(input);
		const attachments: AttachmentPart[] = [];
		for (const part of parts) {
			signal.throwIfAborted();
			attachments.push(this.accept(part, reference, state));
		}
		return { attachments };
	}

	private accept(part: ResolvedPart, reference: ParsedReference, state: BudgetState): AttachmentPart {
		if (part.kind === 'image') {
			if (state.images >= REFERENCE_LIMITS.maxImages) {
				throw new Error('the image budget for one turn is reached');
			}
			state.images += 1;
			return { ...part, origin: 'reference' };
		}
		if (part.kind === 'document') {
			const pages = part.pages ? part.pages.end - part.pages.start + 1 : part.pageCount ?? 1;
			if (state.documents >= REFERENCE_LIMITS.maxDocuments || state.pages + pages > REFERENCE_LIMITS.maxDocumentTotalPages) {
				throw new Error(`PDF page budget reached for ${formatReference(reference)}`);
			}
			state.documents += 1;
			state.pages += pages;
			const clipped = part.text ? this.clipText(part.text, state, REFERENCE_LIMITS.maxDocumentText) : undefined;
			return { ...part, text: clipped?.text, truncated: part.truncated || clipped?.truncated === true, origin: 'reference' };
		}
		const text = this.clipText(part.text, state, REFERENCE_LIMITS.perReference);
		return { ...part, text: text.text, truncated: part.truncated || text.truncated, origin: 'reference' };
	}

	private clipText(text: string, state: BudgetState, perPart: number): { text: string; truncated: boolean } {
		const room = Math.max(0, Math.min(perPart, REFERENCE_LIMITS.total - state.text));
		if (text.length <= room) {
			state.text += text.length;
			return { text, truncated: false };
		}
		const clipped = text.slice(0, room);
		state.text += clipped.length;
		return { text: clipped, truncated: true };
	}

	private async imagePart(absolute: string, displayPath: string, size: number, state: BudgetState): Promise<OneResult> {
		if (size > REFERENCE_LIMITS.maxImageBytes) {
			throw new Error(`the image is larger than ${REFERENCE_LIMITS.maxImageBytes / 1_048_576} MB`);
		}
		if (state.images >= REFERENCE_LIMITS.maxImages) {
			throw new Error('the image budget for one turn is reached');
		}
		if (state.imageBytes + size > REFERENCE_LIMITS.maxImageTotalBytes) {
			throw new Error('the images together are over the 12 MiB limit');
		}
		const bytes = await readFile(absolute);
		if (bytes.byteLength > REFERENCE_LIMITS.maxImageBytes) {
			throw new Error(`the image is larger than ${REFERENCE_LIMITS.maxImageBytes / 1_048_576} MB`);
		}
		const stored = await this.ctx.attachments.putImage(bytes, displayPath);
		state.images += 1;
		state.imageBytes += bytes.byteLength;
		return { attachments: [{ ...stored, origin: 'reference' }] };
	}

	private async textPart(
		reference: ParsedReference,
		absolute: string,
		displayPath: string,
		size: number,
		head: Uint8Array,
		state: BudgetState,
	): Promise<OneResult> {
		if (size > REFERENCE_LIMITS.maxReadBytes) {
			throw new Error(`it is larger than ${Math.round(REFERENCE_LIMITS.maxReadBytes / 1_000_000)} MB`);
		}
		if (hasNul(head)) {
			throw new Error('it is not a text file');
		}
		const text = await this.readText(absolute, size, REFERENCE_LIMITS.maxReadBytes);
		const lines = text.replaceAll('\r\n', '\n').split('\n');
		const start = reference.range?.start ?? 1;
		if (start > lines.length) {
			throw new Error(`line ${start} is past the end (${lines.length} lines)`);
		}
		const end = Math.min(reference.range?.end ?? lines.length, lines.length);
		if (end < start) {
			throw new Error('the line range is empty');
		}
		const numbered = lines.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`).join('\n');
		const clipped = this.clipText(numbered, state, REFERENCE_LIMITS.perReference);
		const part: TextAttachment = {
			kind: 'text',
			origin: 'reference',
			form: 'file',
			source: {
				path: displayPath,
				...(reference.range ? { range: { start, end, unit: 'line' } } : {}),
				hash: createHash('sha256').update(text).digest('hex').slice(0, 16),
			},
			text: clipped.text,
			truncated: clipped.truncated,
		};
		return { attachments: [part] };
	}

	private async folderPart(absolute: string, displayPath: string, scope: ReferenceScope): Promise<TextAttachment> {
		const entries: string[] = [];
		let omitted = 0;
		const walk = async (directory: string, prefix: string): Promise<void> => {
			const children = await readdir(directory, { withFileTypes: true });
			children.sort((left, right) => left.name.localeCompare(right.name));
			for (const child of children) {
				if (IGNORED.has(child.name) || child.isSymbolicLink()) {
					continue;
				}
				const path = prefix ? `${prefix}/${child.name}` : child.name;
				const absoluteChild = `${directory}${sep}${child.name}`;
				if (isDeniedRead(scope.workingDirectory, absoluteChild, scope.denyReadPaths)) {
					continue;
				}
				if (entries.length >= REFERENCE_LIMITS.folderEntries) {
					omitted += 1;
					continue;
				}
				if (child.isDirectory()) {
					entries.push(`${path}/`);
					await walk(absoluteChild, path);
				} else if (child.isFile()) {
					entries.push(path);
				}
			}
		};
		await walk(absolute, '');
		const text = entries.length ? entries.join('\n') : '(empty)';
		const clipped = clip(text, REFERENCE_LIMITS.perReference);
		return {
			kind: 'text',
			origin: 'reference',
			form: 'folder',
			source: { path: `${displayPath}/` },
			text: `${clipped.text}${omitted ? `\n[+${omitted} more]` : ''}`,
			truncated: clipped.truncated,
		};
	}

	private async symbolPart(absolute: string, displayPath: string, reference: ParsedReference, size: number): Promise<TextAttachment> {
		if (!this.symbols) {
			throw new Error('symbol search is not available here');
		}
		const range = await this.symbols.range(absolute, reference.name ?? '');
		if (!range) {
			throw new Error(`symbol ${reference.name ?? ''} was not found`);
		}
		const text = await this.readText(absolute, size, REFERENCE_LIMITS.maxReadBytes);
		const lines = text.replaceAll('\r\n', '\n').split('\n');
		const start = Math.max(1, range.start);
		const end = Math.min(range.end, lines.length);
		if (end < start) {
			throw new Error('the symbol range is empty');
		}
		const numbered = lines.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`).join('\n');
		const clipped = clip(numbered, REFERENCE_LIMITS.perReference);
		return {
			kind: 'text',
			origin: 'reference',
			form: 'symbol',
			source: { path: displayPath, symbol: reference.name, range: { start, end, unit: 'line' } },
			text: clipped.text,
			truncated: clipped.truncated,
		};
	}

	private async readText(absolute: string, size: number, maxBytes: number): Promise<string> {
		if (size > maxBytes) {
			throw new Error(`it is larger than ${Math.round(maxBytes / 1_000_000)} MB`);
		}
		return this.textReader ? this.textReader.read(absolute) : readFile(absolute, 'utf8');
	}

	private async readBytes(absolute: string, size: number, maxBytes: number): Promise<Uint8Array> {
		if (size > maxBytes) {
			throw new Error(`it is larger than ${Math.round(maxBytes / 1_048_576)} MB`);
		}
		const data = await readFile(absolute);
		// pdf.js rejects Node's Buffer subclass; hand it a plain view of the same bytes.
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}

	private async store(
		data: Uint8Array,
		name?: string,
	): Promise<Omit<ImageAttachment, 'origin'> | Omit<DocumentAttachment, 'origin'>> {
		if (sniffImage(data)) {
			return this.ctx.attachments.putImage(data, name);
		}
		if (sniffDocument(data)) {
			return this.ctx.attachments.putDocument(data, name);
		}
		throw new Error('the resolver produced bytes that are neither an image nor a PDF');
	}
}

export const referencesPlugin = References;

function note(text: string, form: 'note' | 'error' = 'note', path?: string): TextAttachment {
	return { kind: 'text', origin: 'reference', form, source: path ? { path } : {}, text };
}

function hasNul(head: Uint8Array): boolean {
	return head.includes(0);
}

function clip(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) {
		return { text, truncated: false };
	}
	return { text: `${text.slice(0, limit)}\n[... truncated, ${text.length - limit} chars]`, truncated: true };
}

async function readHead(path: string, size: number): Promise<Uint8Array> {
	const handle = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(size);
		const { bytesRead } = await handle.read(buffer, 0, size, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

function relativePath(root: string, file: string): string | undefined {
	const path = relative(root, file).split(sep).join('/');
	return !path || path.startsWith('../') || path === '..' ? undefined : path;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
