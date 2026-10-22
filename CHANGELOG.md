# Change Log

All notable changes to the "comonad" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

The next release turns the transcript into a readable record and closes the remaining safety gaps.
Highlights are below; the full implementation notes are linked at the end. The user guide lives at
<https://zeroDtree.github.io/comonad-vscode-extension/>.

### Highlights

- **Tool cards** now carry the model's one-line description, the command utilities, an optional
  preview and a copy menu; `comonad.toolCard` starts them collapsed (the default), preview or open.
- **The step budget is optional.** `comonad.maxSteps` — the Graph tab's **Max steps** — now caps
  the turn instead of being ignored; it defaults to 0 (no limit), so a long tool loop never stops
  on a step budget unless one is set.
- **Stop actually stops** the turn, its process tree and its pending approval; background tasks stay
  independent.
- **Shell calls** take a model-chosen timeout, keep loopback available when network is off, and never
  run unconfined without a prompt when no OS sandbox exists.
- **Model keys belong to the endpoint**, not the profile, and the model menu is read from each
  endpoint.
- **The workspace boundary** is enforced where the panel says it is, with a writable scratch
  directory for confined shells and a narrow exemption for cleaning up the agent's own files.
- **Subagents can implement and test.** A new `run_shell_test` keeps the workspace read-only and
  writes only a private scratch tree. Subagent capabilities are granted per agent in
  **Settings → Subagents** (`comonad.subagents`), intersected with the parent mode and the agent
  definition's `tools`. Full shell and plan writes are never granted; every file write a subagent
  makes is journaled under the parent chat and appears in its diff.
- **Subagent conversations are watchable.** Each `agent` call creates a hidden child session; its
  card gains **Open session** as soon as the child exists. The read-only overlay shows the
  subagent's prompt, steps and tool results and follows the run live, without touching the parent
  chat's stream or scroll. Removing the parent removes its children.
- **Remote SSH, WSL and Dev Containers** are first-class; credentials stay client-side and model calls
  originate on the remote host.
- **Images, `@` references and in-place prompt editing** make the chat a working surface, not just a
  log.
- **The SillyTavern content layer** is complete enough to move cards, books, personas and presets
  between the two tools, and it ships as an optional plugin.
- **Every feature is a plugin** — including the tool tree and the journal — and a plugin can be
  installed, disabled or uninstalled from the settings panel.
- **Markdown math and syntax highlighting** ship as optional or generated assets, not core weight.

### Detailed notes

The full, implementation-level notes for this release are kept at
[docs/internal/release-notes.md](https://github.com/zeroDtree/comonad-vscode-extension/blob/main/docs/internal/release-notes.md).

## [0.2.0] — Cordis rewrite

- The extension is now a [Cordis](https://github.com/cordiverse/cordis) application: one plugin
  tree in `src/app.ts`, kernel/tools/adapters/UI all mounted as plugins and services on a shared
  Context; `deactivate()` disposes the root fiber and every registration unwinds.
- Kernel restructured into services (`agent`, `tools`, `llm`, `sessions`, `checkpoints`, `mcp`,
  `hooks`, `catalog`, `commands`, `approval`, `tasks`, `usage`, `audit`, `log`, `settings`) with a
  fakeable `Host` contract; `src/lib/` holds the pure domain code.
- Surfaces now communicate through typed events (`agent/token`, `agent/tool-result`,
  `sessions/changed`, …) instead of callback plumbing; approvals use a Cordis waterfall where each
  surface answers for its own turns and the command palette provides the modal fallback.
- Tool registration, MCP server trees and UI disposables are plugin effects: disposing a plugin
  removes exactly what it registered (verified by tests).
- Model adapters are pluggable: the OpenAI-compatible adapter registers into `ctx.llm` via
  `ctx.llm.use()`.
- Build: `tsc` now checks with bundler resolution (cordis is ESM-only); esbuild bundles both the
  extension and the test suite. The fast suite (24 tests) runs a headless Cordis kernel including a
  scripted agent turn; host tests activate the real extension in VS Code.

## [0.1.0]

- Initial release