# Change Log

All notable changes to the "comonad" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

The next release turns the transcript into a readable record and closes the remaining safety gaps.
Highlights are below; the full implementation notes are linked at the end. The user guide lives at
<https://zeroDtree.github.io/comonad-vscode-extension/>.

### Highlights

- **Graphs are plugins.** The graph engine now owns named Mermaid graphs, a node/route registry and a
  dedicated **Graph** tab with a live preview. Edit the source in Settings → Graph.
- **Compaction no longer rewrites the chat.** The canonical transcript is kept in full; a summary
  card and model-context coverage live beside it. Original turns expand from the card, older turns
  page in on demand, and restore points no longer move. `/summarize --rebuild` can rewrite the
  summary from the complete history.
- **References are typed attachments.** `@` references (text, images, PDFs) resolve into the user
  message and persist there as a snapshot instead of a turn-only system block. Text is framed with a
  content-derived nonce; images are image parts. PDFs ship as the optional `comonad-plugin-pdf`
  resolver (page-marked text, `@file.pdf:1-5` ranges, no OCR), and `read_file` can read PDF pages.
  The mechanism stays in core; only format parsers are pluggable. Old sessions that stored `images`
  no longer render those images — there is no compatibility layer.
- **Tool cards** now carry the model's one-line description, the command utilities, an optional
  preview and a copy menu; `comonad.toolCard` starts them collapsed (the default), preview or open.
- **The step budget is optional.** `comonad.maxSteps` — the Graph tab's **Max steps** — now caps
  the turn instead of being ignored; it defaults to 0 (no limit), so a long tool loop never stops
  on a step budget unless one is set.
- **Stop actually stops** the turn, its process tree and its pending approval; background tasks stay
  independent.
- **Decision traces and authorization audit.** Every tool call that reaches the policy pipeline
  writes one immutable node per layer actually traversed and one terminal event (`denied` or
  `dispatch_started`). Nodes link by `parent_id`; the terminal names the head, so `/audit <call_id>`
  (or **Comonad: Show Decision Trace**) reconstructs the exact path after the fact. Each node carries
  a `policy_revision`, and the effective policy snapshot is stored once per revision. Trace writes
  are best effort and never fail a turn. See [Decision trace](docs/guide/audit.md).
- **Subagents have their own effective policy.** A delegation inherits the parent policy and can
  only narrow it: capabilities intersect, network is an AND, sandbox takes the stricter mode, ancestor
  rules accumulate their restrictions, and the child's tool approval is set separately. Its approval
  response is always `never`, so an ask is denied without a card; a write-capable agent needs an
  inherited allow rule or `approval: "universal_accept"` on the delegation. Spawn and Fork share the
  policy, the snapshot is persisted with a policy revision, and a running child is tightened by
  later parent restrictions (but never widened). See [Safety](docs/guide/safety.md#subagents).
- **One runtime policy pipeline.** Capability, network access, user rules, the tool approval policy,
  the approval response policy and the sandbox mode now run in a fixed order. The new
  `comonad.approvalResponse` (`ask`/`never`) decides who answers a confirmation, and
  `comonad.sandboxMode` (`workspace-read`, `read-only`, `workspace-write`, `danger-full-access`)
  replaces `confineRead`/`confineWrite`. A user rule that matches settles the call; the approval
  policy is consulted only when none of `deny`/`ask`/`allow` matched. A dedicated **Policies** tab
  groups the six layers in their decision order; the chat footer, `/permissions`, `/status` and the
  flow diagram show the same six layers.
- **Shell calls** take a model-chosen timeout and keep loopback available when network is off. With
  no OS sandbox, shell commands are refused unless the sandbox mode is `danger-full-access`; the
  read-only and test shells always need an OS sandbox.
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
  log. Typing `/` at the start of a prompt opens the same picker for every registered command and
  every `.comonad/commands/*.md`, with descriptions and argument hints, filtered as you type; Enter
  on an exact name runs it and Tab completes it.
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