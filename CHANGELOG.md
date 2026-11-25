# Change Log

All notable changes to the "comonad" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.2.2] — 2026-11-25

- Reference chips under a sent message, and the `@` tokens in its text, are now clickable: a file
  or symbol reference opens in the editor with its line range selected. Folder and PDF chips stay
  read-only.
- A sent message's **Pasted text** chip opens the stored block in a read-only tab.
- Added host tests for single-token reference parsing, line-range clamping and the chip wiring.

## [0.2.1] — 2026-11-25

This release turns the transcript into a readable record and closes the remaining safety gaps.
Highlights are below; the full implementation notes are linked at the end. The user guide lives at
<https://zeroDtree.github.io/comonad-vscode-extension/>.

### Highlights

- **The SillyTavern content layer is removed.** The optional tavern plugin, its settings and
  commands, the pane framework, the character/world-book/persona/preset library, greetings, the
  lore tool and the `fuse.js` dependency are gone. Chat, the six generation types, swipes,
  tokenizers and compaction remain.
- **Compaction is proactive.** Before every model request — not only at a turn's start — the agent
  measures the whole request, calibrates the local estimate against the prompt size the provider
  last reported, and once fewer than `compactionHeadroom` tokens remain (20,000 by default) it
  summarizes the older turns and keeps only `compactionRetainPercent` of the window verbatim (10% by
  default). Summarizing now comes before tool-output trimming; trimming is the hard-limit fallback.
  Both settings are in Settings → Agent, and a successful fold reports its before/after size once.
- **One plan vocabulary.** The Orchestrator's execution DAG is `task_graph`; the Plan work mode is
  `plan`; `write_plan` / `edit_plan` / `read_plan` / `list_plans` are the plan-file tools. The mode
  is now a hard capability ceiling, Build archives the research task graph and starts a fresh one,
  and role `workMode` labels are gone. The tool rename has no alias; a stored `workMode: "pl"` still reads as
  `plan` only so an old Plan chat cannot silently become write-capable. The `plan` policy preset and
  the `/plan` command are removed; the Plan work mode and the plan-file tools are unchanged — select
  Plan mode and ask for the plan. The five policy layers stay independently configurable, and a
  custom `.comonad/commands/plan.md` now runs as an ordinary custom command.
- **Plans are editable in place.** `edit_plan` patches an existing plan file with a batch of
  exact-text replacements. Each anchor must occur exactly once; edits apply in order and
  all-or-nothing, so a missing or ambiguous anchor leaves the file unchanged. The plan card shows
  **Plan updated** with the same **Preview** and **Build plan** actions.
- **The root turn is an Orchestrator.** It records a persistent task graph with `task_graph`, runs
  ready nodes with `delegate`, and reads `task_status`; a shared `message` mailbox lets parallel
  children coordinate through one JSONL file. The old `agent` tool and the four generic built-ins
  (`explore`/`plan`/`review`/`implement`) are replaced by fourteen leaf roles: `general-purpose`,
  `researcher`, `math-researcher`, `explorer`, `planner`, `coder`, `tester`, `reviewer`, `debugger`,
  `security-auditor`, `data-analyst`, `scientist`, `technical-writer` and `architect`. There is no
  compatibility alias.
- **Acceptance is independent.** A write task must have a `review` or `command` criterion; the runtime
  derives a pinned built-in reviewer/tester after the worker batch and recomputes acceptance from the
  structured JSON envelope. The model cannot mark a task accepted. Read and write tasks run in
  parallel; tracked writes are serialised per absolute path, and each child gets its own test scratch
  subtree.

- **Verification survives a formatting slip.** The worker/verifier envelope is read tolerantly:
  malformed evidence is dropped and over-long lists are trimmed with warnings instead of discarding
  the report. A report that still fails the contract gets one repair round in the same child session,
  command evidence is harvested from the transcript's real exit codes, and a verifier that remains
  invalid is `verification_unavailable` — linked to its session, not reported as failed work.

- **Compaction sees the whole request.** The context budget now counts assistant reasoning, which
  DeepSeek sends back with every tool request, so a summary actually lands the next prompt under the
  configured window instead of leaving it at 145%. The user prompt is saved before compaction (a
  reload during a summary no longer drops it or binds the stream to the previous turn), the summary
  is a short non-thinking call bounded to four attempts per turn, and the transient “Summarizing…”
  row is replaced by a live footer timer.
- **Native run budgets and resumable pauses.** Every run has four independent hard limits — turns
  (model round trips), tool calls, tokens and wall-clock time. A limit stops the run at a message
  boundary, keeps the partial transcript and pauses the task; `resume` continues the same child
  session with a new segment budget and does not spend an attempt. The main-agent and child-default
  budgets are editable in Settings, and `subagentBudgetMode` (default `inherit`) makes a child copy
  the parent's four limits. The old single-dimensional `maxSteps`/`subagentSteps`/`maxTurns`
  concepts are removed.
- **Verifier and resume hardening.** A verifier's acceptance entries must use the task's exact
  criterion ids; when every reported id differs but the counts agree, the runtime maps them
  positionally and records the mapping, and incomplete coverage is an `invalid_output` rejection
  instead of a silent zero-check rejection. Command rejections now report the tester's observed
  command and exit code. A resume segment can no longer shrink the previous segment's limits
  (smaller values are clamped and reported), a materially changed paused/rejected definition resets
  its resume counter while keeping its attempts, and pause/attempt messages say when a cap is spent.
- **Graphs are plugins.** The graph engine now owns named Mermaid graphs and a node/route registry.
  The source lives in `comonad.graph`; empty uses the shipped `agent` loop.
- **The tool loop is a gate, not a route.** The shipped graph is now `llm → calls → gate →
  {tools, approval, reject}`; `agent.approval` returns to the gate, which re-evaluates the batch
  after the answer. The policy is a pure decision module and the only issuer of a single-use tool
  authorization; the executor refuses a call without one, so a custom graph cannot route around
  the rules. Stored graphs that name the old nodes fall back to the shipped loop.
- **File tools are named for their edits.** `apply_patch` is now `edit_text` and `apply_edits` is
  now `edit_ranges`; `write_file` keeps its name. Agent definitions and rules that name the old
  tools must use the new names — there is no alias.
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
- **The step budget is optional.** `comonad.maxSteps` — the Agent tab's **Max steps** — now caps
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
- **Review is its own tab.** `Comonad: Review Changes` — the chat's Review button and `Cmd+Alt+D` —
  opens a multi-file diff with the pending listing, three lines of context, and Keep/Undo on every
  block. It replaces the old QuickPick; the accepted baseline, the chat's pending list and the
  File Review tab all still read the same journal.
- **A file review tab draws deletions whole — and is a real file tab.** Clicking a pending file (or
  `Comonad: Review Changed File`) opens it as a custom text editor: removed lines are real, wrapping
  rows — text VS Code's decoration API cannot draw — with Undo/Keep under every block.
  It is backed by the real `TextDocument`, so typing, undo/redo, `Cmd/Ctrl+S`, the dirty dot, the
  close prompt and encoding/EOL handling are VS Code's own; **Open in Editor** opens the same
  document in the standard editor as another tab in the same group. Saving behaves like any editor:
  a save that diverges from the agent's last write reads as *changed outside*; block actions stay
  available against that diff, and a whole-file Undo still asks before restoring. Same journal,
  same block keys, same refusals as the other surfaces.
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
- **`ask_user` is inline in the chat.** The Comonad panel renders the model's question as a card in
  the transcript — options as buttons (single-select) or checkboxes (multi-select), plus an
  always-visible free-text field under them so an answer can be typed instead of chosen, or
  submitted together with the checked options — and the answer resumes the tool without a native
  popup. The `@comonad` participant and
  turns with no panel surface keep VS Code's quick pick/input box. A panel-surface question with no
  attached panel stays pending, blocks the turn, and is replayed when the panel reopens; an optional
  `questionNotification` (default on) shows an **Open Chat** notification.

- **The status line scales its numbers and shows prompt-cache reuse.** Session totals print as
  K/M/G, and a provider that reports prompt-cache statistics adds a cumulative `cache 8M (51%)`
  segment — the hits and their share of all input. Providers that report none are left off the
  line rather than shown as `0 (0%)`. The context share is not clamped, so a request over the
  configured window reads `117%` rather than a misleading `100%`.

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