# Comonad Agent for VS Code

**A local-first, auditable coding agent inside VS Code.** It runs a graph-orchestrated tool loop
against the model you choose — DeepSeek by default, or any OpenAI-compatible endpoint — journals every
file it writes, and asks before anything leaves the sandbox.

- **Local-first.** Keys live in `SecretStorage`; sessions, checkpoints and logs stay on the machine
  that runs the agent.
- **Auditable by construction.** Typed graph events, a capability gate and an audit log; file writes
  are journaled per file, so nothing is silently overwritten.
- **Extensible as a plugin tree.** The kernel, tools, model adapters and UI are plugins on one
  [Cordis](https://github.com/cordiverse/cordis) context. Turn a row off, configure it, or mount your
  own.
- **The agent loop is a graph.** Edit named Mermaid loops in **Settings → Graph**: the turn's own
  loop, the tools it calls and the routes between them. Plugins can register nodes and routes beside
  the shipped `agent` graph.

## Install

**From a packaged VSIX**

`npm run package` writes `comonad-0.2.0.vsix`. Install it with `code --install-extension
comonad-0.2.0.vsix`, or use **Extensions → … → Install from VSIX…**.

**From source**

```sh
npm install
npm run compile
```

Press `F5` in VS Code to launch the Extension Development Host.

Set a model key — `DEEPSEEK_API_KEY` is enough for the default DeepSeek Flash profile — or add any
OpenAI-compatible endpoint with **Comonad: Configure Model Provider**. Open the chat with
**Comonad: Open Chat** (`Cmd+Alt+C` / `Ctrl+Alt+C`).

## First five minutes

1. Open the chat from the Secondary Side Bar.
2. Ask a question, or describe a change.
3. Approvals appear inline: **Allow once**, **Always allow**, or **Deny**.
4. Shell and file changes are tool cards; click one to see the command and output.
5. Review pending files above the composer with **Keep**, **Undo**, or **Review**.

## Documentation

The full guide is at **<https://zeroDtree.github.io/comonad-vscode-extension/>** (also available in
中文 at `/zh/`). The source lives in
[`docs/`](https://github.com/zeroDtree/comonad-vscode-extension/tree/main/docs).

| Start | What it covers |
| --- | --- |
| [Chat](https://zeroDtree.github.io/comonad-vscode-extension/guide/chat.html) | Sessions, composer, transcript, tool cards, `@` references |
| [Safety](https://zeroDtree.github.io/comonad-vscode-extension/guide/safety.html) | Modes, approval policies, rules, sandboxing, secrets |
| [Context](https://zeroDtree.github.io/comonad-vscode-extension/guide/context.html) | Window budget and compaction |
| [Checkpoints and review](https://zeroDtree.github.io/comonad-vscode-extension/guide/checkpoints.html) | Journal, Keep/Undo, restore points |
| [Content layer](https://zeroDtree.github.io/comonad-vscode-extension/guide/content.html) | Characters, world books, personas, presets |
| [Extending](https://zeroDtree.github.io/comonad-vscode-extension/guide/extend.html) | Plugins, hooks, skills, subagents, MCP |
| [Reference](https://zeroDtree.github.io/comonad-vscode-extension/reference/commands.html) | Commands, tools and settings |

## Development

```sh
npm run watch        # typecheck + bundle in watch mode
npm run check-types
npm run lint
npm test             # full VS Code test host
npm run package      # production bundle
```

To rebuild the extension and install it into VS Code:

```sh
./scripts/reinstall.sh            # build, package and install
./scripts/reinstall.sh --build-only
```

The docs site is VitePress:

```sh
cd docs
npm install
npm run dev
```

See [CONTRIBUTING.md](https://github.com/zeroDtree/comonad-vscode-extension/blob/main/CONTRIBUTING.md)
for the development setup and documentation style.

## License

Comonad Agent for VS Code is licensed under **AGPL-3.0-only**. See
[LICENSE](https://github.com/zeroDtree/comonad-vscode-extension/blob/main/LICENSE).

Third-party components and their licenses are listed in
[THIRD_PARTY_NOTICES.md](https://github.com/zeroDtree/comonad-vscode-extension/blob/main/THIRD_PARTY_NOTICES.md);
the modifications relative to SillyTavern are recorded in
[NOTICE](https://github.com/zeroDtree/comonad-vscode-extension/blob/main/NOTICE).
