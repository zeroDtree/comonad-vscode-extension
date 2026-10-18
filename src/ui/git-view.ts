// SPDX-License-Identifier: AGPL-3.0-only
import { basename, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { Context } from 'cordis';
import { describe } from '../lib/util';
import { registerCommand } from './register';

/**
 * The repository's own changes, in Comonad's side bar: staged, unstaged, untracked and merge, each
 * file opening VS Code's diff editor and carrying the actions that move it between the index and the
 * working tree.
 *
 * This is the *Git* surface, not the journal: the journal records what the agent wrote (and shell
 * commands touch nothing it sees), while this reads the real repository through the built-in Git
 * extension's API. It is deliberately not the Source Control view: it sits beside Sessions and Tasks,
 * groups by state, and is one click from a diff or a stage.
 */

const EMPTY_SCHEME = 'comonad-git-empty';
const EMPTY_URI = vscode.Uri.parse(`${EMPTY_SCHEME}:/empty`);

/** `Status` from the Git extension's own API, whose values are stable and have no runtime export. */
const STATUS = {
	INDEX_MODIFIED: 1,
	INDEX_ADDED: 2,
	INDEX_DELETED: 3,
	INDEX_RENAMED: 4,
	INDEX_COPIED: 5,
	MODIFIED: 6,
	DELETED: 7,
	UNTRACKED: 8,
	IGNORED: 9,
	INTENT_TO_ADD: 10,
	INTENT_TO_RENAME: 11,
	TYPE_CHANGED: 12,
	ADDED_BY_US: 13,
	ADDED_BY_THEM: 14,
	DELETED_BY_US: 15,
	DELETED_BY_THEM: 16,
	BOTH_ADDED: 17,
	BOTH_DELETED: 18,
	BOTH_MODIFIED: 19,
} as const;

type Group = 'staged' | 'changes' | 'untracked' | 'merge';

const GROUP_LABELS: Record<Group, string> = {
	staged: 'Staged',
	changes: 'Changes',
	untracked: 'Untracked',
	merge: 'Merge',
};

/** The parts of the built-in Git extension's API this view uses, declared structurally. */
interface ChangeLike {
	uri: vscode.Uri;
	originalUri: vscode.Uri;
	renameUri?: vscode.Uri;
	status: number;
}

interface RepositoryLike {
	rootUri: vscode.Uri;
	state: {
		HEAD?: { name?: string };
		indexChanges: ChangeLike[];
		workingTreeChanges: ChangeLike[];
		untrackedChanges?: ChangeLike[];
		mergeChanges?: ChangeLike[];
		onDidChange: vscode.Event<void>;
	};
	add(paths: string[]): Promise<void>;
	revert(paths: string[]): Promise<void>;
	clean(paths: string[]): Promise<void>;
	restore(paths: string[], options?: { staged?: boolean; ref?: string }): Promise<void>;
	status?(): Promise<void>;
}

interface ApiLike {
	repositories: RepositoryLike[];
	onDidOpenRepository: vscode.Event<RepositoryLike>;
	onDidCloseRepository: vscode.Event<RepositoryLike>;
	getRepository(uri: vscode.Uri): RepositoryLike | null;
	toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

interface ExtensionLike {
	enabled: boolean;
	onDidChangeEnablement?: vscode.Event<boolean>;
	getAPI(version: 1): ApiLike;
}

/** One changed file, with the repository and group it belongs to. */
interface Entry {
	repo: RepositoryLike;
	repoName: string;
	uri: vscode.Uri;
	original: vscode.Uri;
	rename?: vscode.Uri;
	status: number;
	group: Group;
	relative: string;
}

interface MessageNode {
	kind: 'message';
	label: string;
	description: string;
	command?: vscode.Command;
}

interface RepoNode {
	kind: 'repo';
	repo: RepositoryLike;
	label: string;
}

interface GroupNode {
	kind: 'group';
	repo: RepositoryLike;
	group: Group;
	entries: Entry[];
}

interface ChangeNode {
	kind: 'change';
	entry: Entry;
}

type Node = MessageNode | RepoNode | GroupNode | ChangeNode;

/** The letter a change is known by, in the same vocabulary as `git status`. */
function letter(status: number): string {
	switch (status) {
		case STATUS.INDEX_MODIFIED:
		case STATUS.MODIFIED:
		case STATUS.TYPE_CHANGED:
		case STATUS.BOTH_MODIFIED:
			return 'M';
		case STATUS.INDEX_ADDED:
		case STATUS.INTENT_TO_ADD:
		case STATUS.ADDED_BY_US:
		case STATUS.ADDED_BY_THEM:
		case STATUS.BOTH_ADDED:
			return 'A';
		case STATUS.INDEX_DELETED:
		case STATUS.DELETED:
		case STATUS.BOTH_DELETED:
		case STATUS.DELETED_BY_US:
		case STATUS.DELETED_BY_THEM:
			return 'D';
		case STATUS.INDEX_RENAMED:
		case STATUS.INTENT_TO_RENAME:
			return 'R';
		case STATUS.INDEX_COPIED:
			return 'C';
		case STATUS.UNTRACKED:
			return 'U';
		default:
			return '?';
	}
}

/** Every changed file, grouped the way the tree shows it. */
function collect(api: ApiLike): Entry[] {
	const entries: Entry[] = [];
	const seen = new Set<string>();
	const add = (repo: RepositoryLike, change: ChangeLike, group: Group): void => {
		const key = `${repo.rootUri.toString()}\u0000${change.uri.toString()}\u0000${group}`;
		if (seen.has(key) || change.status === STATUS.IGNORED) {
			return;
		}
		seen.add(key);
		const repoName = basename(repo.rootUri.fsPath);
		const path = relative(repo.rootUri.fsPath, change.uri.fsPath);
		entries.push({
			repo,
			repoName,
			uri: change.uri,
			original: change.originalUri ?? change.uri,
			rename: change.renameUri,
			status: change.status,
			group,
			relative: path ? path.split(sep).join('/') : basename(change.uri.fsPath),
		});
	};
	for (const repo of api.repositories) {
		const state = repo.state;
		for (const change of state.mergeChanges ?? []) {
			add(repo, change, 'merge');
		}
		for (const change of state.indexChanges) {
			add(repo, change, 'staged');
		}
		for (const change of state.workingTreeChanges) {
			add(repo, change, change.status === STATUS.UNTRACKED ? 'untracked' : 'changes');
		}
		// `git.untrackedChanges: separate` lists untracked files on their own; the `mixed` mode already
		// put them in the working tree, and the dedupe above absorbs the overlap.
		for (const change of state.untrackedChanges ?? []) {
			add(repo, change, 'untracked');
		}
	}
	return entries;
}

/** The two sides of one file's diff, in the Git extension's own ref vocabulary. */
function sides(api: ApiLike, entry: Entry): [vscode.Uri, vscode.Uri] {
	if (entry.group === 'staged') {
		const added = entry.status === STATUS.INDEX_ADDED || entry.status === STATUS.INDEX_COPIED;
		const deleted = entry.status === STATUS.INDEX_DELETED;
		return [added ? EMPTY_URI : api.toGitUri(entry.original, 'HEAD'), deleted ? EMPTY_URI : api.toGitUri(entry.uri, '')];
	}
	if (entry.group === 'untracked') {
		return [EMPTY_URI, entry.uri];
	}
	if (entry.group === 'merge') {
		// The Git extension reads `~2`/`~3` as the two sides of a conflict: ours and theirs.
		return [api.toGitUri(entry.uri, '~2'), api.toGitUri(entry.uri, '~3')];
	}
	const deleted = entry.status === STATUS.DELETED;
	return [api.toGitUri(entry.original, '~'), deleted ? EMPTY_URI : entry.uri];
}

export function gitView(ctx: Context): void {
	const emitter = new vscode.EventEmitter<void>();
	let api: ApiLike | undefined;
	let subscriptions: vscode.Disposable[] = [];
	let timer: NodeJS.Timeout | undefined;
	let loading = false;
	/** The Git extension's own "enabled" switch, so re-enabling it fills the view without a reload. */
	let enablement: vscode.Disposable | undefined;

	const fire = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			emitter.fire();
		}, 80);
	};

	const unwatch = (): void => {
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
		subscriptions = [];
	};

	const watch = (): void => {
		unwatch();
		if (!api) {
			return;
		}
		for (const repo of api.repositories) {
			subscriptions.push(repo.state.onDidChange(() => fire()));
		}
		subscriptions.push(api.onDidOpenRepository(() => {
			watch();
			fire();
		}));
		subscriptions.push(api.onDidCloseRepository(() => {
			watch();
			fire();
		}));
	};

	const load = async (): Promise<void> => {
		if (loading) {
			return;
		}
		loading = true;
		try {
			const extension = vscode.extensions.getExtension<ExtensionLike>('vscode.git');
			if (!extension) {
				api = undefined;
				return;
			}
			await extension.activate();
			const exports = extension.exports;
			if (!exports || exports.enabled === false) {
				api = undefined;
				return;
			}
			api = exports.getAPI(1);
			watch();
			// Now that the extension is active its exports exist: its enablement can change under us.
			enablement?.dispose();
			enablement = exports.onDidChangeEnablement?.(() => void load());
		} catch (error) {
			ctx.log.message(`git: the Git extension is not usable: ${describe(error)}`);
			api = undefined;
		} finally {
			loading = false;
			emitter.fire();
		}
	};

	const entries = (): Entry[] => (api ? collect(api) : []);

	const message = (): MessageNode | undefined => {
		if (!api) {
			return {
				kind: 'message',
				label: 'Git is not available',
				description: 'Enable the built-in Git extension',
				command: { command: 'workbench.action.openSettings', title: 'Open settings', arguments: ['git.enabled'] },
			};
		}
		return api.repositories.length ? undefined : { kind: 'message', label: 'No Git repository in this workspace.', description: '' };
	};

	const provider: vscode.TreeDataProvider<Node> = {
		onDidChangeTreeData: emitter.event,
		getTreeItem: (node) => {
			if (node.kind === 'message') {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
				item.description = node.description;
				item.iconPath = new vscode.ThemeIcon(node.command ? 'warning' : 'info');
				item.command = node.command;
				return item;
			}
			if (node.kind === 'repo') {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
				item.iconPath = new vscode.ThemeIcon('repo');
				item.description = node.repo.state.HEAD?.name ?? '';
				return item;
			}
			if (node.kind === 'group') {
				const item = new vscode.TreeItem(`${GROUP_LABELS[node.group]} (${node.entries.length})`, vscode.TreeItemCollapsibleState.Expanded);
				item.id = `group:${node.repo.rootUri.toString()}:${node.group}`;
				item.contextValue = `git-group-${node.group}`;
				return item;
			}
			const entry = node.entry;
			const item = new vscode.TreeItem(entry.relative, vscode.TreeItemCollapsibleState.None);
			item.id = `change:${entry.repo.rootUri.toString()}:${entry.group}:${entry.uri.toString()}`;
			item.resourceUri = entry.uri;
			item.description = letter(entry.status);
			item.tooltip = `${entry.relative}\n${GROUP_LABELS[entry.group]} · ${letter(entry.status)}`;
			item.contextValue = `git-change-${entry.group}`;
			item.command = { command: 'comonad.git.openDiff', title: 'Open diff', arguments: [node] };
			return item;
		},
		getChildren: (node) => {
			if (!node) {
				const notice = message();
				if (notice) {
					return [notice];
				}
				const all = entries();
				if (!api) {
					return [];
				}
				if (api.repositories.length === 1) {
					return groupsOf(api.repositories[0]!, all);
				}
				return api.repositories.map((repo) => ({ kind: 'repo', repo, label: basename(repo.rootUri.fsPath) }) satisfies RepoNode);
			}
			if (node.kind === 'repo') {
				return groupsOf(node.repo, entries());
			}
			if (node.kind === 'group') {
				return node.entries.map((entry) => ({ kind: 'change', entry }) satisfies ChangeNode);
			}
			return [];
		},
	};

	function groupsOf(repo: RepositoryLike, all: Entry[]): GroupNode[] {
		// Identity by root: the API hands the same repository objects back, but a re-resolve after an
		// enablement change may not, and the tree must not empty itself over that.
		const root = repo.rootUri.toString();
		const mine = all.filter((entry) => entry.repo.rootUri.toString() === root);
		return (['merge', 'staged', 'changes', 'untracked'] as const)
			.map((group) => ({ kind: 'group' as const, repo, group, entries: mine.filter((entry) => entry.group === group) }))
			.filter((node) => node.entries.length > 0);
	}

	const tree = vscode.window.createTreeView('comonad.git', { treeDataProvider: provider, showCollapseAll: true });
	const empty = vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, { provideTextDocumentContent: () => '' });

	/** The entry a command was invoked on: the tree node it came from, if any. */
	const entryOf = (node: unknown): Entry | undefined => (node && typeof node === 'object' && (node as ChangeNode).kind === 'change' ? (node as ChangeNode).entry : undefined);

	registerCommand(ctx, 'comonad.git.refresh', async () => {
		for (const repo of api?.repositories ?? []) {
			await repo.status?.().catch(() => undefined);
		}
		await load();
		fire();
	});

	registerCommand(ctx, 'comonad.git.openDiff', async (node?: ChangeNode) => {
		const entry = entryOf(node);
		if (!entry || !api) {
			return;
		}
		const [left, right] = sides(api, entry);
		await vscode.commands.executeCommand('vscode.diff', left, right, `${entry.relative} (${GROUP_LABELS[entry.group]})`, { preview: true });
	});

	registerCommand(ctx, 'comonad.git.openFile', async (node?: ChangeNode) => {
		const entry = entryOf(node);
		if (entry) {
			await vscode.window.showTextDocument(entry.uri);
		}
	});

	const act = async (node: ChangeNode | undefined, action: (repo: RepositoryLike, paths: string[]) => Promise<void>, done: string): Promise<void> => {
		const entry = entryOf(node);
		if (!entry) {
			return;
		}
		try {
			await action(entry.repo, [entry.uri.fsPath]);
			void vscode.window.showInformationMessage(`Comonad: ${done} ${entry.relative}.`);
			fire();
		} catch (error) {
			void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
		}
	};

	registerCommand(ctx, 'comonad.git.stage', (node?: ChangeNode) => act(node, (repo, paths) => repo.add(paths), 'staged'));
	registerCommand(ctx, 'comonad.git.unstage', (node?: ChangeNode) => act(node, (repo, paths) => repo.revert(paths), 'unstaged'));

	registerCommand(ctx, 'comonad.git.discard', async (node?: ChangeNode) => {
		const entry = entryOf(node);
		if (!entry) {
			return;
		}
		const untracked = entry.group === 'untracked';
		const answer = await vscode.window.showWarningMessage(
			`Discard the changes to ${entry.relative}?`,
			{ modal: true, detail: untracked ? 'The file is deleted, or moved to the trash when the system has one.' : 'The working-tree changes are lost. This cannot be undone.' },
			'Discard',
		);
		if (answer !== 'Discard') {
			return;
		}
		await act(node, (repo, paths) => repo.clean(paths), 'discarded changes in');
	});

	registerCommand(ctx, 'comonad.git.stageAll', async () => {
		const all = entries();
		try {
			for (const repo of api?.repositories ?? []) {
				const root = repo.rootUri.toString();
				const paths = all
					.filter((entry) => entry.repo.rootUri.toString() === root && (entry.group === 'changes' || entry.group === 'untracked'))
					.map((entry) => entry.uri.fsPath);
				if (paths.length) {
					await repo.add(paths);
				}
			}
			fire();
		} catch (error) {
			void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
		}
	});

	registerCommand(ctx, 'comonad.git.unstageAll', async () => {
		const all = entries();
		try {
			for (const repo of api?.repositories ?? []) {
				const root = repo.rootUri.toString();
				const paths = all.filter((entry) => entry.repo.rootUri.toString() === root && entry.group === 'staged').map((entry) => entry.uri.fsPath);
				if (paths.length) {
					await repo.revert(paths);
				}
			}
			fire();
		} catch (error) {
			void vscode.window.showErrorMessage(`Comonad: ${describe(error)}`);
		}
	});

	ctx.effect(() => () => {
		clearTimeout(timer);
		unwatch();
		enablement?.dispose();
		tree.dispose();
		empty.dispose();
		emitter.dispose();
		void vscode.commands.executeCommand('setContext', 'comonad.git', false);
	});

	void vscode.commands.executeCommand('setContext', 'comonad.git', true);
	void load();
}
gitView.inject = ['log'];
