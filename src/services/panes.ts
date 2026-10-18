import { Service, type Context } from 'cordis';

/**
 * Panes: the settings panel's tabs, as something a plugin can contribute.
 *
 * A pane is a tab, the markup its section holds, the files its client loads, and an optional editor.
 * The panel asks this service for the list when it builds its document and when it pushes state, so
 * the tavern plugin's **ST** tab is built by the tavern plugin: with the row off there is no tab, no
 * markup and no script, and turning the row on brings all three back.
 */

/** What a pane's editor hands the panel: its state slices, and a handler for its messages. */
export interface PaneController {
	/** The slices the panel pushes beside its own config — `{ content, catalog, tavern }`, say. */
	state(): Record<string, unknown>;
	/** Handles one message from the pane's client; the answer is shown as a note, when there is one. */
	action(message: Record<string, unknown>): Promise<Record<string, unknown> | null | void>;
	/**
	 * What the pane owns of a save: the keys it is responsible for, read out of the panel's untrusted
	 * patch (a pane reads its own current values for the keys it leaves out). Everything else in the
	 * patch is the panel's, so a pane may only name its own — and its keys are its own business, which
	 * is why none of them appear in the kernel's `Config`.
	 */
	patch?(patch: Record<string, unknown>): Record<string, unknown>;
}

/** What the panel lends a pane: webview URIs for files outside the extension, and a refresh. */
export interface PaneHost {
	/** A file as the webview may see it — empty when the panel cannot reach it. */
	uri(file: string): string;
	/** Ask the panel to push its state again, after something changed under it. */
	refresh(): void;
}

export interface PaneSpec {
	/** The tab id and the section's `data-pane` name, so the client's own messages are its own. */
	id: string;
	/** The tab's label and tooltip, as the panel writes them. */
	label: string;
	title?: string;
	/** A 16px inline SVG for the tab, drawn with currentColor; a pane without one gets the plugin icon. */
	icon?: string;
	/** A command the panel registers to reveal this pane — `comonad.openContent`, say. */
	command?: string;
	/** The markup of the pane's `<section>`, as the panel writes it into the document. */
	markup: string;
	/** Files the pane's client loads, by absolute path: scripts and stylesheets, in order. */
	scripts?: string[];
	styles?: string[];
	/** Folders the pane's client reads from, beside its own files — a library of avatars, say. */
	roots?: () => string[];
	/** Built when the panel opens; a pane without one has markup only. */
	controller?(host: PaneHost): PaneController;
}

export class Panes extends Service {
	private specs: PaneSpec[] = [];

	constructor(ctx: Context) {
		super(ctx, 'panes');
	}

	/** Adds a pane, or replaces the one already registered under the same id. Returns the remover. */
	register(spec: PaneSpec): () => void {
		this.specs = [...this.specs.filter((pane) => pane.id !== spec.id), spec];
		this.ctx.emit('panes/changed');
		return () => this.unregister(spec.id);
	}

	unregister(id: string): void {
		const rest = this.specs.filter((pane) => pane.id !== id);
		if (rest.length !== this.specs.length) {
			this.specs = rest;
			this.ctx.emit('panes/changed');
		}
	}

	/** The panes right now, in registration order: what the panel builds its document from. */
	list(): PaneSpec[] {
		return [...this.specs];
	}

	/** Where a pane's client files live, so the panel can allow the webview to reach them. */
	directories(): string[] {
		return [...new Set(this.specs.flatMap((pane) => [...(pane.scripts ?? []), ...(pane.styles ?? [])].map(dirname)))];
	}
}

declare module 'cordis' {
	interface Context {
		panes: Panes;
	}
	interface Events {
		/** A pane was added or removed: the panel builds its document again. */
		'panes/changed'(): void;
	}
}

/** `path.dirname` without pulling `node:path` in twice; two separators, because both are in the wild. */
function dirname(file: string): string {
	const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
	return cut > 0 ? file.slice(0, cut) : file;
}

/** The row: a service, like every other. */
export const panesPlugin = Panes;
