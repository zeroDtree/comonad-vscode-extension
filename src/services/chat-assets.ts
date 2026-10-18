// SPDX-License-Identifier: AGPL-3.0-only
import { Service, type Context } from 'cordis';

/**
 * Chat webview assets: the scripts and styles a plugin adds to the standalone chat document.
 *
 * A contribution is plain paths — the panel turns them into webview URIs when it builds the document.
 * Scripts load before `chat.js`, so a renderer can install its hook before the first message is drawn;
 * styles load after `chat.css`. The panel reloads its webview when the list changes, which is also how
 * a plugin being installed, disabled or removed reaches a chat that is already open.
 */

export interface ChatAssetSpec {
	/** A stable id: registering it again replaces the earlier contribution. */
	id: string;
	/** Absolute paths, in load order, for the client's scripts. */
	scripts?: string[];
	/** Absolute paths, in load order, for the client's stylesheets. */
	styles?: string[];
	/** Extra folders the client may read from — fonts or images beside the files above. */
	roots?: string[];
}

export class ChatWebviewAssets extends Service {
	private specs: ChatAssetSpec[] = [];

	constructor(ctx: Context) {
		super(ctx, 'chatWebview');
	}

	/** Adds a contribution, or replaces the one already registered under the same id. */
	register(spec: ChatAssetSpec): () => void {
		this.specs = [...this.specs.filter((entry) => entry.id !== spec.id), spec];
		this.ctx.emit('chatWebview/changed');
		return () => this.unregister(spec.id);
	}

	unregister(id: string): void {
		const rest = this.specs.filter((entry) => entry.id !== id);
		if (rest.length !== this.specs.length) {
			this.specs = rest;
			this.ctx.emit('chatWebview/changed');
		}
	}

	/** The contributions right now, in registration order: what the panel builds its document from. */
	list(): ChatAssetSpec[] {
		return [...this.specs];
	}

	/** Every folder a contribution's files live in, so the panel can allow the webview to reach them. */
	directories(): string[] {
		return [
			...new Set(
				this.specs.flatMap((spec) => [
					...(spec.scripts ?? []).map(dirname),
					...(spec.styles ?? []).map(dirname),
					...(spec.roots ?? []),
				]),
			),
		];
	}
}

declare module 'cordis' {
	interface Context {
		chatWebview: ChatWebviewAssets;
	}
	interface Events {
		/** A contribution was added, replaced or removed: the chat document is stale. */
		'chatWebview/changed'(): void;
	}
}

/** `path.dirname` without pulling `node:path` in twice; two separators, because both are in the wild. */
function dirname(file: string): string {
	const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
	return cut > 0 ? file.slice(0, cut) : file;
}
