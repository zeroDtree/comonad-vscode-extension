// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Service, type Context } from 'cordis';
import {
	IMAGE_ID,
	MAX_IMAGE_BYTES,
	extensionForImage,
	mimeFromImageId,
	sniffImage,
} from '../lib/images';
import type { ImageMime, ImagePart, Message } from '../lib/types';

/**
 * Images the agent has read and images the user has attached.
 *
 * The bytes are content-addressed (`<sha256>.<ext>`), so reading the same screenshot twice costs one
 * file, and a session stores only the id, size and media type. Requests resolve ids to data URLs at
 * the `Llm.chat` boundary; the webview asks for one id at a time, so a chat with several clients never
 * broadcasts the bytes it does not use.
 */

declare module 'cordis' {
	interface Context {
		attachments: Attachments;
	}
}

/** How many resolved data URLs are kept in memory; an image is immutable, so a cache is always right. */
const CACHE_LIMIT = 8;

/** How long an unreferenced attachment is kept before a sweep may remove it. */
const SWEEP_AGE_MS = 24 * 60 * 60_000;

export class Attachments extends Service {
	static inject = ['host'];

	private readonly dir: string;
	/** id → data URL, in insertion order, so the oldest entry is the one to drop. */
	private readonly urls = new Map<string, string>();

	constructor(ctx: Context) {
		super(ctx, 'attachments');
		this.dir = ctx.host.storage.attachments;
	}

	/**
	 * Stores one image and returns its reference. The bytes decide the format; a caller's media type is
	 * only a hint and is not trusted. The original file name never becomes part of the path.
	 */
	async put(data: Uint8Array, name?: string): Promise<ImagePart> {
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
		const id = `${createHash('sha256').update(data).digest('hex')}.${extensionForImage(image.mime)}`;
		mkdirSync(this.dir, { recursive: true });
		try {
			await writeFile(join(this.dir, id), data, { flag: 'wx', mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
			// Already stored: content addressing makes this the successful path, not a collision.
		}
		const part: ImagePart = { id, mime: image.mime, width: image.width, height: image.height };
		const clean = cleanName(name);
		if (clean) {
			part.name = clean;
		}
		return part;
	}

	/** The bytes behind one reference, or `undefined` when the id is malformed or the file is gone. */
	read(id: string): { data: Buffer; mime: ImageMime } | undefined {
		const mime = mimeFromImageId(id);
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
	dataUrl(image: Pick<ImagePart, 'id' | 'mime'>): string | undefined {
		const cached = this.urls.get(image.id);
		if (cached !== undefined) {
			// Refresh insertion order: the entries the next request will ask for stay cached.
			this.urls.delete(image.id);
			this.urls.set(image.id, cached);
			return cached;
		}
		const read = this.read(image.id);
		if (!read) {
			return undefined;
		}
		const url = `data:${read.mime};base64,${read.data.toString('base64')}`;
		this.urls.set(image.id, url);
		if (this.urls.size > CACHE_LIMIT) {
			const oldest = this.urls.keys().next().value;
			if (oldest !== undefined) {
				this.urls.delete(oldest);
			}
		}
		return url;
	}

	/** A `data:` URL by id, for the webview's lazy image requests. */
	dataUrlById(id: string): string | undefined {
		const mime = mimeFromImageId(id);
		return mime ? this.dataUrl({ id, mime }) : undefined;
	}

	/**
	 * Copies of the messages with their images resolved, for one request. The transcript itself keeps
	 * metadata only: the copy is discarded when the adapter returns.
	 */
	resolveMessages(messages: readonly Message[]): Message[] {
		return messages.map((message) => {
			if (!message.images?.length) {
				return message;
			}
			const images: ImagePart[] = [];
			for (const image of message.images) {
				const dataUrl = this.dataUrl(image);
				if (dataUrl) {
					images.push({ ...image, dataUrl });
				}
			}
			const missing = message.images.length - images.length;
			const content = missing
				? `${message.content}${message.content ? '\n' : ''}[${missing} attachment(s) unavailable]`
				: message.content;
			return { ...message, content, images: images.length ? images : undefined };
		});
	}

	/** Metadata only, as a webview payload: no base64 and no accidental `dataUrl`. */
	publicParts(images?: readonly ImagePart[]): ImagePart[] | undefined {
		if (!images?.length) {
			return undefined;
		}
		return images.map((image) => {
			const part: ImagePart = { id: image.id, mime: image.mime };
			if (image.name) {
				part.name = image.name;
			}
			if (image.width !== undefined) {
				part.width = image.width;
			}
			if (image.height !== undefined) {
				part.height = image.height;
			}
			return part;
		});
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
			if (!IMAGE_ID.test(name) || keep.has(name)) {
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
