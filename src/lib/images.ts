// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Image sniffing, dimensions and token estimates. Pure module: no `vscode`, no `cordis`, no I/O.
 *
 * The agent only needs to recognize the four formats every OpenAI-compatible vision endpoint accepts.
 * The bytes themselves are never decoded here; a header is enough to know the type, the size and the
 * shape, which is all the budget and the UI ask of an image.
 */

import type { ImageMime } from './types';

/** One image, raw. The store's cap applies to these bytes, not to the base64 the wire carries. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** How many images one prompt or one tool result may carry. */
export const MAX_IMAGES_PER_MESSAGE = 6;
/** How many raw image bytes one pasted prompt may carry. */
export const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
/** What a large high-detail image costs when the header does not say how big it is. */
export const IMAGE_TOKEN_FALLBACK = 1_105;

/** An attachment file name: the content hash plus the format's extension. */
export const IMAGE_ID = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;

export interface SniffedImage {
	mime: ImageMime;
	width: number;
	height: number;
}

const EXTENSIONS: Record<ImageMime, 'png' | 'jpg' | 'gif' | 'webp'> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
};

const BY_EXTENSION: Record<string, ImageMime> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
};

/** The file extension an attachment id uses for a media type. */
export function extensionForImage(mime: ImageMime): 'png' | 'jpg' | 'gif' | 'webp' {
	return EXTENSIONS[mime];
}

/** The media type an attachment id names, or `undefined` when the id is malformed. */
export function mimeFromImageId(id: string): ImageMime | undefined {
	const match = IMAGE_ID.exec(id);
	return match ? BY_EXTENSION[match[1]!] : undefined;
}

/** Whether a path merely looks like an image, for the error a broken one deserves. */
export function looksLikeImagePath(path: string): boolean {
	return /\.(png|jpe?g|gif|webp)$/i.test(path);
}

/** The format, width and height a header exposes; `undefined` when this is not a supported image. */
export function sniffImage(bytes: Uint8Array): SniffedImage | undefined {
	if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		// PNG: signature, then IHDR is always the first chunk.
		const width = view(bytes).getUint32(16);
		const height = view(bytes).getUint32(20);
		return width > 0 && height > 0 ? { mime: 'image/png', width, height } : undefined;
	}
	if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
		// GIF87a / GIF89a: logical screen width and height, little-endian.
		const width = bytes[6]! | (bytes[7]! << 8);
		const height = bytes[8]! | (bytes[9]! << 8);
		return width > 0 && height > 0 ? { mime: 'image/gif', width, height } : undefined;
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return jpegSize(bytes);
	}
	if (
		bytes.length >= 30 &&
		bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
	) {
		return webpSize(bytes);
	}
	return undefined;
}

function view(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Walk JPEG markers to the first frame header, which carries the dimensions. */
function jpegSize(bytes: Uint8Array): SniffedImage | undefined {
	let at = 2;
	while (at + 1 < bytes.length) {
		if (bytes[at] !== 0xff) {
			at += 1;
			continue;
		}
		let marker = bytes[at + 1]!;
		while (marker === 0xff && at + 2 < bytes.length) {
			at += 1;
			marker = bytes[at + 1]!;
		}
		// Standalone markers carry no length.
		if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			at += 2;
			continue;
		}
		if (at + 3 >= bytes.length) {
			return undefined;
		}
		const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
		if (length < 2) {
			return undefined;
		}
		const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (sof) {
			if (at + 8 >= bytes.length) {
				return undefined;
			}
			const height = (bytes[at + 5]! << 8) | bytes[at + 6]!;
			const width = (bytes[at + 7]! << 8) | bytes[at + 8]!;
			return width > 0 && height > 0 ? { mime: 'image/jpeg', width, height } : undefined;
		}
		at += 2 + length;
	}
	return undefined;
}

/** VP8 (lossy), VP8L (lossless) and VP8X (extended) each keep the canvas size differently. */
function webpSize(bytes: Uint8Array): SniffedImage | undefined {
	const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
	if (chunk === 'VP8X') {
		const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
		const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
		return { mime: 'image/webp', width, height };
	}
	if (chunk === 'VP8 ') {
		if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
			return undefined;
		}
		const width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
		const height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
		return width > 0 && height > 0 ? { mime: 'image/webp', width, height } : undefined;
	}
	if (chunk === 'VP8L') {
		if (bytes[20] !== 0x2f) {
			return undefined;
		}
		const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
		const width = (bits & 0x3fff) + 1;
		const height = ((bits >>> 14) & 0x3fff) + 1;
		return { mime: 'image/webp', width, height };
	}
	return undefined;
}

/**
 * OpenAI's high-detail tiling, which is the estimate closest to what an OpenAI-compatible endpoint
 * bills: fit 2048, then scale the short side to 768, then count 512-pixel tiles. It is only a budget
 * estimate; the usage the provider reports stays the source of truth.
 */
export function estimateImageTokens(image: { width?: number; height?: number }): number {
	const width = image.width ?? 0;
	const height = image.height ?? 0;
	if (width <= 0 || height <= 0) {
		return IMAGE_TOKEN_FALLBACK;
	}
	let w = width;
	let h = height;
	const longest = Math.max(w, h);
	if (longest > 2048) {
		const scale = 2048 / longest;
		w = Math.max(1, Math.round(w * scale));
		h = Math.max(1, Math.round(h * scale));
	}
	const shortest = Math.min(w, h);
	if (shortest > 768) {
		const scale = 768 / shortest;
		w = Math.max(1, Math.round(w * scale));
		h = Math.max(1, Math.round(h * scale));
	}
	return 85 + 170 * Math.ceil(w / 512) * Math.ceil(h / 512);
}
