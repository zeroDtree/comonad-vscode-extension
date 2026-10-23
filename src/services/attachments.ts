// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Service, type Context } from 'cordis';
import {
	ATTACHMENT_ID,
	MAX_DOCUMENT_BYTES,
	mimeFromAttachmentId,
	publicAttachments as publicAttachmentMeta,
	sniffDocument,
} from '../lib/attachments';
import { MAX_IMAGE_BYTES, extensionForImage, sniffImage } from '../lib/images';
import type {
	AttachmentMime,
	AttachmentPart,
	DocumentAttachment,
	ImageAttachment,
	Message,
} from '../lib/types';

/**
 * Bytes the agent or the user attached: images and PDFs.
 *
 * The store is content-addressed (`<sha256>.<ext>`), so reading the same screenshot twice costs one
 * file, and a session stores only the id and metadata. Requests resolve ids to data URLs at the
 * `Llm.chat` boundary; the webview asks for one id at a time, so a chat with several clients never
 * broadcasts bytes it does not use. PDF bytes are kept for a future renderer; the extracted text is
 * what travels today.
 */

declare module 'cordis' {
	interface Context {
		attachments: Attachments;
	}
}

/** How many resolved image data URLs are kept in memory; an image is immutable, so a cache is always right. */
const CACHE_LIMIT = 8;

/** How long an unreferenced attachment is kept before a sweep may remove it. */
const SWEEP_AGE_MS = 24 * 60 * 60_000;

type StoredImage = Omit<ImageAttachment, 'origin'>;
type StoredDocument = Omit<DocumentAttachment, 'origin'>;

export class Attachments extends Service {
	static inject = ['host'];

	private readonly dir: string;
	/** id → image data URL, in insertion order, so the oldest entry is the one to drop. */
	private readonly urls = new Map<string, string>();

	constructor(ctx: Context) {
		super(ctx, 'attachments');
		this.dir = ctx.host.storage.attachments;
	}

	/**
	 * Stores one image and returns its reference. The bytes decide the format; a caller's media type
	 * is only a hint and is not trusted. The original file name never becomes part of the path.
	 */
	async putImage(data: Uint8Array, name?: string): Promise<StoredImage> {
		if (!data.byteLength) {
			throw new Error('the image is empty');
		}
		const image = sniffImage(data);
		if (!image) {
			throw new Error('not a PNG, JPEG, GIF or WebP image');
		}
		if (data.byteLength > MAX_IMAGE_BYTES) {
			throw new Error(`the image is ${(data.byteLength / 1_048_576).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1_048_576} MB`);
		}
		const id = await this.write(data, extensionForImage(image.mime));
		const part: StoredImage = { kind: 'image', id, mime: image.mime, width: image.width, height: image.height };
		const clean = cleanName(name);
		if (clean) {
			part.name = clean;
		}
		return part;
	}

	/** Stores one PDF's bytes. Parsing and page counts belong to the PDF resolver, not the store. */
	async putDocument(data: Uint8Array, name?: string): Promise<StoredDocument> {
		if (!data.byteLength) {
			throw new Error('the PDF is empty');
		}
		if (!sniffDocument(data)) {
			throw new Error('not a PDF file');
		}
		if (data.byteLength > MAX_DOCUMENT_BYTES) {
			throw new Error(`the PDF is ${(data.byteLength / 1_048_576).toFixed(1)} MB; the limit is ${MAX_DOCUMENT_BYTES / 1_048_576} MB`);
		}
		const id = await this.write(data, 'pdf');
		const part: StoredDocument = { kind: 'document', id, mime: 'application/pdf' };
		const clean = cleanName(name);
		if (clean) {
			part.name = clean;
		}
		return part;
	}

	/** The bytes behind one reference, or `undefined` when the id is malformed or the file is gone. */
	read(id: string): { data: Buffer; mime: AttachmentMime } | undefined {
		const mime = mimeFromAttachmentId(id);
		if (!mime) {
			return undefined;
		}
		try {
			return { data: readFileSync(join(this.dir, id)), mime };
		} catch {
			return undefined;
		}
	}

	/** A `data:` URL for one reference. Synchronous: the chat payloads that use it are synchronous too. */
	dataUrl(part: Pick<ImageAttachment, 'id' | 'mime'> | Pick<DocumentAttachment, 'id' | 'mime'>): string | undefined {
		const cacheable = part.mime.startsWith('image/');
		const cached = cacheable ? this.urls.get(part.id) : undefined;
		if (cached !== undefined) {
			// Refresh insertion order: the entries the next request will ask for stay cached.
			this.urls.delete(part.id);
			this.urls.set(part.id, cached);
			return cached;
		}
		const read = this.read(part.id);
		if (!read) {
			return undefined;
		}
		const url = `data:${read.mime};base64,${read.data.toString('base64')}`;
		if (cacheable) {
			this.urls.set(part.id, url);
			if (this.urls.size > CACHE_LIMIT) {
				const oldest = this.urls.keys().next().value;
				if (oldest !== undefined) {
					this.urls.delete(oldest);
				}
			}
		}
		return url;
	}

	/** A `data:` URL by id, for the webview's lazy image requests. */
	dataUrlById(id: string): string | undefined {
		const mime = mimeFromAttachmentId(id);
		return mime ? this.dataUrl({ id, mime }) : undefined;
	}

	/**
	 * Copies of the messages with their images resolved, for one request. The transcript itself keeps
	 * metadata only: the copy is discarded when the adapter returns. PDF text is already stored; its
	 * bytes are not needed on the Chat Completions wire.
	 */
	resolveMessages(messages: readonly Message[]): Message[] {
		return messages.map((message) => {
			if (!message.attachments?.length) {
				return message;
			}
			const attachments: AttachmentPart[] = [];
			let missing = 0;
			for (const part of message.attachments) {
				if (part.kind !== 'image') {
					attachments.push(part);
					continue;
				}
				if (part.dataUrl) {
					attachments.push(part);
					continue;
				}
				const dataUrl = this.dataUrl(part);
				if (dataUrl) {
					attachments.push({ ...part, dataUrl });
				} else {
					missing += 1;
				}
			}
			const content = missing
				? `${message.content}${message.content ? '\n' : ''}[${missing} attachment(s) unavailable]`
				: message.content;
			return { ...message, content, attachments: attachments.length ? attachments : undefined };
		});
	}

	/** Metadata only, as a webview payload: no base64, and only a preview of reference text. */
	publicAttachments(attachments?: readonly AttachmentPart[]): AttachmentPart[] | undefined {
		return publicAttachmentMeta(attachments);
	}

	/**
	 * Removes attachment files no session mentions any more. The age floor keeps a sweep from racing a
	 * turn that has written an image but not yet saved the transcript that references it.
	 */
	sweep(keep: ReadonlySet<string>, minAgeMs = SWEEP_AGE_MS): number {
		let removed = 0;
		let names: string[];
		try {
			names = readdirSync(this.dir);
		} catch {
			return 0;
		}
		const now = Date.now();
		for (const name of names) {
			if (!ATTACHMENT_ID.test(name) || keep.has(name)) {
				continue;
			}
			const path = join(this.dir, name);
			try {
				if (now - statSync(path).mtimeMs < minAgeMs) {
					continue;
				}
				unlinkSync(path);
				this.urls.delete(name);
				removed += 1;
			} catch {
				// A file another sweep already removed is not an error.
			}
		}
		return removed;
	}

	private async write(data: Uint8Array, extension: string): Promise<string> {
		const id = `${createHash('sha256').update(data).digest('hex')}.${extension}`;
		mkdirSync(this.dir, { recursive: true });
		try {
			await writeFile(join(this.dir, id), data, { flag: 'wx', mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
			// Already stored: content addressing makes this the successful path, not a collision.
		}
		return id;
	}
}

export const attachmentsPlugin = Attachments;

/** A display name: the basename only, bounded, never a path. */
function cleanName(name?: string): string | undefined {
	if (!name) {
		return undefined;
	}
	const base = name.split(/[\\/]/).pop()?.trim() ?? '';
	return base ? base.slice(0, 120) : undefined;
}
