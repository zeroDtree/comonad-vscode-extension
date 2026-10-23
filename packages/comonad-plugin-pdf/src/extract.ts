// SPDX-License-Identifier: AGPL-3.0-only
import { getDocumentProxy } from 'unpdf';
import type { ReferenceResolver } from '@comonad/services/references';
import type { DocumentAttachment } from '@comonad/lib/types';

/** The PDF resolver: text extraction only, page ranges included. Scanned pages are reported, not OCR'd. */

const MAX_TEXT = 60_000;

export const pdfResolver: ReferenceResolver = {
	id: 'pdf',
	priority: 10,
	mimes: ['application/pdf'],
	extensions: ['.pdf'],
	claim: (input) => hasPdfMagic(input.head),
	async resolve(input) {
		const bytes = await input.readBytes(input.limits.maxDocumentBytes);
		let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
		let timer: NodeJS.Timeout | undefined;
		const deadline = Date.now() + 20_000;
		try {
			// Store before pdf.js sees the bytes: it transfers the typed array to its worker and takes
			// ownership, which would leave `store` looking at an empty buffer.
			const stored = await input.store(bytes, input.displayPath);
			// PDF.js' serverless bundle assigns `globalThis.navigator` at module load. The VS Code
			// extension host exposes it as a getter-only property; make the same value writable first.
			relaxNavigator();
			const timed = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('PDF parsing timed out')), 20_000);
			});
			pdf = await Promise.race([getDocumentProxy(bytes), timed]);
			clearTimeout(timer);
			timer = undefined;
			const totalPages = pdf.numPages;
			if (!totalPages) {
				throw new Error('the PDF has no pages');
			}
			const requested = pageRange(input.reference.range, totalPages, input.limits.maxDocumentPages);
			const pages: string[] = [];
			let chars = 0;
			let empty = true;
			for (let page = requested.start; page <= requested.end; page += 1) {
				input.signal.throwIfAborted();
				if (Date.now() > deadline) {
					throw new Error('PDF parsing timed out');
				}
				const text = await pageText(pdf, page);
				if (text.trim()) {
					empty = false;
				}
				const block = text.trim() ? text.trimEnd() : `[page ${page}: no extractable text]`;
				pages.push(`[page ${page}]\n${block}`);
				chars += block.length;
				if (chars >= MAX_TEXT) {
					break;
				}
			}
			const pagesIncluded = Math.min(requested.end, requested.start + pages.length - 1);
			const part: Omit<DocumentAttachment, 'origin'> = {
				...stored,
				kind: 'document',
				mime: 'application/pdf',
				pageCount: totalPages,
				pages: { start: requested.start, end: pagesIncluded, unit: 'page' },
				text: trim(pages.join('\n\n'), MAX_TEXT),
				textUnavailable: empty,
				truncated: pagesIncluded < totalPages || chars >= MAX_TEXT,
			};
			return [part];
		} catch (error) {
			if (error instanceof Error && /password|encrypted/i.test(error.message)) {
				throw new Error('encrypted PDFs are not supported');
			}
			throw error instanceof Error ? error : new Error(String(error));
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			if (pdf) {
				await pdf.cleanup().catch(() => undefined);
			}
		}
	},
};

async function pageText(pdf: Awaited<ReturnType<typeof getDocumentProxy>>, number: number): Promise<string> {
	const page = await pdf.getPage(number);
	const content = await page.getTextContent();
	let text = '';
	for (const item of content.items) {
		if (!('str' in item)) {
			continue;
		}
		text += item.str;
		text += item.hasEOL ? '\n' : ' ';
	}
	return text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ');
}

function pageRange(range: { start: number; end: number } | undefined, total: number, limit: number): { start: number; end: number } {
	const start = Math.max(1, range?.start ?? 1);
	if (start > total) {
		throw new Error(`page ${start} is past the end (${total} pages)`);
	}
	const wanted = range ? Math.max(start, range.end) : total;
	return { start, end: Math.min(total, wanted, start + limit - 1) };
}

function hasPdfMagic(head: Uint8Array): boolean {
	const limit = Math.min(head.byteLength, 1_024);
	for (let index = 0; index + 4 < limit; index += 1) {
		if (head[index] === 0x25 && head[index + 1] === 0x50 && head[index + 2] === 0x44 && head[index + 3] === 0x46 && head[index + 4] === 0x2d) {
			return true;
		}
	}
	return false;
}

function trim(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n[... truncated, ${text.length - limit} chars]`;
}

function relaxNavigator(): void {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
		if (!descriptor || descriptor.writable || !descriptor.configurable) {
			return;
		}
		Object.defineProperty(globalThis, 'navigator', {
			value: descriptor.get ? descriptor.get.call(globalThis) : undefined,
			writable: true,
			configurable: true,
			enumerable: descriptor.enumerable,
		});
	} catch {
		// A non-configurable global is left alone; the library error is reported to the model.
	}
}
