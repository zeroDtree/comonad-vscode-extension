# Comonad Agent for VS Code

A local-first, auditable coding agent inside VS Code. It runs a graph-orchestrated tool loop
against the model you choose — DeepSeek by default, or any OpenAI-compatible endpoint — keeps every turn in a
shadow-git checkpoint, and asks before anything leaves the sandbox.

The kernel is a port of `pkgs/Comonad` (its graph runtime, capability model, approval policies and
checkpoint design) with the interaction layer rebuilt on VS Code: Chat participant, language model
API, diff editors, tasks and terminal sandbox.

The extension is built as a [Cordis](https://github.com/cordiverse/cordis) application: everything —
kernel, tools, model adapters, UI — is a plugin on one context, capabilities are services
(`ctx.agent`, `ctx.tools`, `ctx.llm`, `ctx.checkpoints`, …) and cross-module signals are typed
events. Registrations are effects of the plugin that made them, so unload and deactivate clean up
automatically.

## Getting started

```sh
npm install
npm run compile       # typecheck + lint + bundle
```

Press `F5` to launch the Extension Development Host.

## The Comonad chat

Comonad ships its own chat — no other chat extension required. Open it with **Comonad: Open Chat** or
`Cmd+Alt+C` (`Ctrl+Alt+C`): the chat lives in the **Secondary Side Bar on the right**
(Cursor-style) and streams replies, asks for approvals inline (Allow once / Always allow / Deny),
lists background tasks and todos. The chat's own controls are the three buttons in the panel's title
bar, next to VS Code's own: **Recent Chats** (`$(history)`), **Settings** (`$(gear)`) and **New
Session** (`$(edit)`) — the same commands as the palette, so the panel needs no header row of its
own. **Recent Chats** drops the list down: the three most recent chats with their age and a **View
all (n)** link — click a row to continue that chat. The list folds away when you click anywhere else
in the panel, press `Esc`, or move focus out of the panel. **Search recent chats** matches both the titles and the text of your
messages, newest chat first, and shows the matching line under the title (Esc clears the field).
A chat only enters that history once you send something: **＋ / ✎ New
session** (or `Cmd+N`) opens a clean chat without leaving an empty “New session” behind, and the
unused ones earlier versions stored are pruned on the next start. New session is also `Cmd+N` while
a Comonad surface has focus
(`Ctrl+Alt+N` elsewhere), and it brings the chat forward with the caret already in the input — from
the chat, the Activity Bar trees, the title-bar icon or the palette alike. That scope is written as
the `comonad.chatFocused` context key: the chat's own webview reports its focus (a chord pressed
inside a webview is resolved against the workbench's root context, where `focusedView` and
`auxiliaryBarFocus` are not visible), and it is what keeps the chord from stealing VS Code's New Text
File. Forking a chat and the rest live in the **Comonad** view in the Activity
Bar and in the command palette. The composer
keeps the model pill and send button; under the input box sit the **Work mode**, **Approval**, **↑
Context**, **👁 Display** and **Network** pills — no status-bar buttons. The model pill opens the
Cursor-style menu: **Reasoning** effort (thinking strength), a **Context** budget in tokens for the
history sent to the model, and the **Model** list — all remembered per chat, with new chats starting
from `comonad.reasoningEffort` and `comonad.contextLimit`. The two pills that list Rendered / Token /
Raw are told apart by their icons: **↑ Context** decides the shape of what this chat sends back
(new chats start from the Context setting), **👁 Display** is the one control for how the whole
transcript is drawn and redraws it at once (`comonad.displayForm`): **Rendered** draws every step in
order with the noise folded away — a turn starts as the prompt, a *Thinking* line and one row per
tool call (name, arguments and whether it worked), and a click opens the reasoning or that call's
output — **Token** shows only what the model said plus a count of the calls it made, **Raw** shows the
whole record as plain text. **Comonad: Open Chat in a New Window** opens the chat as an editor
tab instead — set `comonad.chatWindow` to move it straight into its own floating window. `@comonad`
In the built-in chat view still works and shares the same sessions, policy and commands.

**The transcript is turns, not messages.** One prompt and everything the agent did for it — its
thoughts, its text and its tool calls — is a single turn, drawn as one block in the order it
happened, no matter how many rounds the model took between tools. A turn that is streaming and the
same turn after a reload are built by the same renderer, so a refresh never changes the shape of an
answer (no more one bubble becoming five). Every step also carries **how long it took** —
`🧠 Thought 12.4s` (it reads *Thinking…* while the model is still reasoning), `✓ run_shell {"command":"pytest"} 8.1s`, and a plain answer's own round trip —
climbing live while it runs and settling on the number the extension measured when it finishes, so a
slow call shows its cost instead of only a spinner. Each turn ends with a dated footer — *Worked for
12s · 3 tools*, or *Working…* / *Stopped* — and carries the action row, Cursor-style: **copy** (the answer,
or the raw record in Raw), **fork chat from here** (a new chat with the same conversation through
the end of that turn) and, on the newest turn, **regenerate** (drops that answer and runs the
prompt again). Because the fork point is always a turn boundary, a forked chat can never hold a tool
call without the result that answers it.

Inside the panel you can type plain prompts or slash commands (`/help` lists them all).

Comonad ships with its providers and picks the key up from your environment:

| profile | endpoint | default model | key |
| --- | --- | --- | --- |
| **DeepSeek Flash** — the default, `Auto` runs on it | `https://api.deepseek.com` | `deepseek-flash` | `DEEPSEEK_API_KEY` |
| DeepSeek V4 Pro | `https://api.deepseek.com` | `deepseek-v4-pro` | `DEEPSEEK_API_KEY` |
| Gemini 3.8 Flash | `generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash` | `GEMINI_API_KEY` (`GOOGLE_API_KEY` works too) |

Export one of those and the chat works — nothing to configure.

**The model menu is read from the endpoints** (`GET /models` on each profile's base URL), so a model
released tomorrow is on the menu without an update; the list is cached for ten minutes and a
**Refresh** re-reads it. Two profile fields shape what that list looks like, because providers report
ids in their own way: `modelPrefix` strips a prefix the endpoint puts on every id (Gemini answers
`models/gemini-3.8-flash`, chats as `gemini-3.8-flash`), and `modelSkip` is a regex of ids to leave
out — Gemini's address space carries image, computer-use, deep-research and embedding models that
cannot run a chat turn. Selecting a model stores `profile:model` in `comonad.model` (a bare profile
id means its default model), which is also what the session remembers. A profile whose list cannot be
fetched — no key yet, offline — still offers the model it declares, marked *models not listed*.

Keys are data, not code: each profile lists the variables it reads (`keyEnv`, tried in order) before
falling back to the OS keychain, and the menu says `no key — set DEEPSEEK_API_KEY` on any profile it
found none for. Nothing in the extension knows a provider's name except the shipped profile data.

- **Comonad: Select Model** lists the profiles plus **Auto** (the first one); the menu's last row
  opens the provider wizard.
- **Comonad: Configure Model Provider** adds any OpenAI-compatible endpoint: base URL, model name and
  key (leave the key empty to keep reading the environment).

`comonad.profiles` is an array of `{ id, label, base, model, keyEnv, ... }` entries — edit it in
settings when your account answers to different model ids, or to add Ollama, LM Studio, OpenAI,
Moonshot or anything else that speaks the OpenAI protocol. An empty list means “use the shipped
profiles”, and `comonad.model` names the profile a new chat starts on (`auto` = the first one).

`pricingIn` / `pricingCachedIn` / `pricingOut` (USD per million tokens) switch on real `/cost`
numbers; the DeepSeek profiles ship with the list rates from
<https://api-docs.deepseek.com/quick_start/pricing> — peak cache-miss input, cache-hit input and
output — so the estimate is an upper bound (off-peak is half) that stays honest when the prompt cache
kicks in, which it does on every long agent loop.

**Thinking.** A reply's chain of thought is the *Thought* block above its answer — the past tense
arrives when the model stops reasoning and the next step starts: folded away, one
per reasoning pass, kept per message so it survives a reload and shows up in the Raw display. Both
DeepSeek models think by default; the composer's **Reasoning** pill maps onto the endpoint's own
switch — `None` sends DeepSeek's `thinking: {type: "disabled"}` (or `reasoning_effort: "none"` on
Gemini), `Low`/`Medium`/`High` send `reasoning_effort`. Thinking is part of the wire protocol, not
just display: when a request carries tools DeepSeek requires the `reasoning_content` of earlier turns
back, so Comonad passes it along (endpoints that do not know the field ignore it).

## Content layer (characters, lore, personas, presets)

The agent can wear a character. Content lives in **Comonad's own library** —
`.comonad/{characters,lorebooks,presets,personas}` in the project plus `~/.comonad/…` for the user —
written in **SillyTavern's file formats**, so a card, book, persona or preset can be moved between
the two tools. It is all managed in one place: the settings panel's **ST** tab
(`Comonad: Manage Content`, the book icon in the chat's title bar, or the character pill's *Manage
content…*), whose sub-tabs are **Characters / World books / Personas / Presets / Settings**. Create,
edit, duplicate and delete every kind, then use it in this chat or make it the default for new chats.

- **Characters.** Cards are read as PNG (`chara` / `ccv3` chunks) or JSON, all three card versions,
  and written back in the same shape — a PNG card keeps its picture, a JSON card stays JSON. The
  editor covers the whole card: description, personality, scenario, first message and alternates,
  example messages, system prompt, post-history instructions, creator notes, tags, the depth prompt
  and `extensions.world` (a world book the card binds, scanned without being listed). *Export PNG…*
  writes a shareable PNG card.
- **World books.** Every entry field is editable: keys (including `/regex/`), secondary keys and
  their logic, content, position and depth, role, order, probability, always-on, groups and weights,
  sticky/cooldown/delay, recursion flags, generation triggers, per-entry scan depth, case/whole-word
  overrides and the character filter. Files are written the way SillyTavern writes them, with the
  camelCase names at the root mirrored under `extensions`.
- **Personas.** Name (`{{user}}`), title, description, where its text goes (in prompt, at a depth,
  in the author's note), and the world book it binds. `connections` ties a persona to characters, so
  a chat speaking as that card uses it automatically.
- **Presets.** An OpenAI preset — prompts, prompt order, samplers and formats — is edited in the
  **Presets** tab: switch a block off, change its role, inject it in chat at a depth, move it, and
  edit temperature/top_p/top_k/top_a/min_p/penalties/context/reply length plus `wi_format`,
  `scenario_format`, `personality_format`, `impersonation_prompt`, `names_behavior`,
  `assistant_prefill` and `squash_system_messages`.
- **Identity stays first.** The agent's own block (mode, approval, instructions, memory, skills,
  todos, tool rules) still leads every request; content only *adds* blocks. With nothing selected,
  the request is byte-identical to a plain agent turn.
- **Runtime.** A chat can pick a character (its opening line — or an alternate — is inserted as the
  first turn and pinned when the history is trimmed), books (scanned every turn for keywords, with
  the scan depth, budget, cap, recursion, groups, sticky/cooldown/delay and per-entry positions all
  honoured), a persona and a preset (whose samplers override the profile's). The **◈ lore** chip
  above the composer lists what the last turn injected, and `lore_lookup` lets the model search the
  books on demand — read-only, it never changes what the next turn injects.
- **Macros and regex.** `{{char}}`, `{{user}}`, `{{persona}}`, `{{scenario}}`, `{{time}}`,
  `{{random}}`, `{{pick}}`, `{{roll}}` and friends are substituted in every block; regex scripts
  (from `comonad.tavern.regex` or the card) run on the prompt and on replies with SillyTavern's
  placement/depth rules.

Licensing note: Comonad's content layer is an independent re-implementation of the file formats and
the prompt assembly. SillyTavern itself (AGPL-3.0) is not bundled, and its default content is never
copied.

## Chat commands

| command | purpose |
| --- | --- |
| `/plan [task]` | research read-only, then write a plan file |
| `/review [focus]` | review pending changes without editing |
| `/compact [notes]` | summarize the conversation into one message |
| `/clear`, `/new` | start a fresh session |
| `/fork` | fork this session and keep exploring in a fresh one |
| `/context` | token budget breakdown (messages, tools, instructions) |
| `/status` | mode, model, workspace, sandbox and usage |
| `/cost` | token usage for today and the session |
| `/permissions` | mode capabilities and permission rules |
| `/model` | switch the active model |
| `/init` | create a `COMONAD.md` project instruction file |
| `/rewind` | restore files and conversation to an earlier turn |
| `/export` | export the session as markdown |
| `/resume` | resume a suspended (waiting for approval) turn |
| `/char [name]` | pick the character this chat speaks as (inserts its opening line) |
| `/persona [name]` | pick who you are in this chat |
| `/lore [names]` | pick the world books this chat scans (`/lore none` clears) |
| `/preset [name]` | pick the prompt and sampler preset |
| `/note [text]` | set or clear the chat's standing author's note |

Custom commands are markdown files under `.comonad/commands/*.md` with optional frontmatter
(`description`, `argument-hint`, `allowed-tools`, `model`). Bodies support `$ARGUMENTS`,
`` !`shell` `` and `@path` includes.

## Safety model

Three layers, evaluated in order, deny wins:

1. **Mode** — which tool capabilities exist at all:

   | mode | capabilities |
   | --- | --- |
   | `chat` | **Chat Only** — no tools at all, plain conversation |
   | `ro` | **Read-Only** — read files, read-only shell |
   | `sw` | **Semi-Write** — + write files (the shell stays read-only) |
   | `aw` | **Full Access** — + full shell inside the workspace |
   | `pl` | **Plan** — read files, read-only shell, writes plan files only |

2. **Rules** — white- and blacklists for tool calls: `comonad.permissions.allow` / `ask` / `deny` with
   patterns like `run_shell(npm run test:*)`, `read_file(./.env)`, `fetch_url(domain:example.com)` —
   edit them in **Comonad: Open Settings** → **Rules**.
   A deny rule always wins and an allow rule always runs without asking, in every policy. On top of
   your rules the **whitelist** starts with the read-only calls and the **blacklist** starts with the
   write-capable ones (the capabilities `ro`/`shell_ro`/`rw_plan` and `rw`/`shell_rw`/`rw_plan`).
3. **Approval policy** — what happens to a call no rule matched: `manual` asks for every call,
   `whitelist_accept` runs the whitelisted calls and asks for the rest, `blacklist_reject` rejects
   the blacklisted calls (writes, out of the box) and runs the rest, `universal_accept` runs
   everything the mode allows and `universal_reject` runs nothing. Approvals pause the turn;
   "Always allow" adds an allow rule.

Shell commands run under `sandbox-exec` (macOS) or `bwrap` (Linux) with the workspace as the only
writable path, network off by default, and `.env` files denied to both reading and writing.
Commands shaped like `rm -rf`, `sudo`, `curl | sh`, `git push --force` and friends always prompt,
even under accept policies; the `run_shell_unsandboxed` escalation tool prompts on every call.
Secrets (API keys, tokens, passwords) are stripped from the environment of commands and tasks
unless `comonad.filterSensitiveEnv` is disabled, and `.git` is never writable by file tools.
Without an OS sandbox the command still requires approval. Presets combine all three layers:
**Ask**, **Plan**, **Auto**, **Read only**, **Full access** (**Comonad: Select Preset**;
`comonad.allowFullAccess: false` hides the unrestricted preset).

## Checkpoints and review

Before every user message the workspace is snapshotted into a shadow git repository outside your
project (`globalStorage/checkpoints/...`). Your own `.git` is never touched.

- **Comonad: Review Pending Changes** — open a diff, keep/undo a file or a single hunk, or keep/undo everything.
- **Comonad: Rewind Conversation and Files** — restore the workspace *and* truncate the chat to that turn.
- `Cmd+Alt+D` opens review, `Cmd+Alt+.` stops a turn, `Cmd+N` starts a new session while a Comonad
  surface has focus.
- Right-click a session in the Comonad view to rename, delete or fork it; sessions fork with a
  a numbered fork title (`Title (fork 1)`, `Title (fork 2)`, …) and a fresh checkpoint identity. The **Tasks** view lists background commands
  with output preview and a stop action. Select code and use the lightbulb or editor context menu
  to *Explain* or *Fix* it with Comonad.

## Extensibility

| mechanism | location | notes |
| --- | --- | --- |
| instructions | `COMONAD.md`, `AGENTS.md`, `.comonad/instructions.md` | hierarchical, trusted workspaces only; `@path` imports |
| rules | `.comonad/rules/*.md` | loaded into the system prompt |
| skills | `.comonad/skills/<name>/SKILL.md` | listed in the prompt, loaded on demand via the `skill` tool |
| subagents | `.comonad/agents/*.md` | frontmatter: `tools`, `disallowedTools`, `model`, `maxTurns`; built-ins: explore, plan, review |
| commands | `.comonad/commands/*.md` | custom slash commands |
| hooks | `.comonad/hooks.json` (project), `globalStorage/hooks.json` (user) | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`; handlers: `command`, `http`, `mcp_tool`, `prompt`; JSON decisions: `permissionDecision` deny/ask/allow, `additionalContext`, `updatedInput`; exit code 2 blocks |
| MCP | `comonad.mcpServers` | stdio (`command`,`args`,`env`) or streamable HTTP (`url`,`headers`); per-server `capability`, `writeTools`, `exclude`, `overrides` |
| memory | agent-owned `MEMORY.md` under global storage | loaded into the prompt, editable via the `memory` tool |

Hook example:

```json
{
  "PreToolUse": [
    {
      "matcher": "run_shell",
      "hooks": [
        {
          "type": "command",
          "if": "run_shell(rm:*)",
          "command": "echo '{\"hookSpecificOutput\":{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"no rm\"}}'"
        }
      ]
    }
  ]
}
```

## Tools

`list_dir`, `read_file`, `grep_files`, `write_file`, `apply_patch`, `run_shell_readonly`, `run_shell`,
`run_shell_unsandboxed`, `start_shell` / `shell_output` / `stop_shell` (background), `list_plans` / `read_plan` / `write_plan`,
`todo_write`, `calculate` / `describe_numbers` / `percentile` / `convert_units`, `fetch_url`,
`web_search`, `find_files`, `find_symbols`, `get_diagnostics`, `apply_edits`, `git_diff`, `run_task`,
`ask_user`, `agent` (subagents), `skill`, `memory`, plus `server__tool` for every MCP tool.

Every tool declares a capability, whether it needs network, and whether it needs a workspace; the
registry filters by all three before the model ever sees it.

## Architecture

The whole extension is one Cordis plugin tree, assembled in `src/app.ts` and mounted from
`src/main.ts`. Key seams:

- **Surfaces and the agent talk through typed events.** A surface calls
  `ctx.agent.runTurn({ surface })` and renders `agent/*` events for its own surface id;
  `approval/request` is a Cordis *waterfall*, so each surface answers for its own turns and
  delegates the rest to the next listener (default: deny). The command palette provides a modal
  dialog as the fallback.
- **Tools are plugin effects.** `ctx.tools.register(spec)` attaches the registration to the
  calling plugin's lifetime. The MCP manager mounts one child plugin per server and re-mounts the
  tree on reload, so connections close and tools disappear together.
- **One turn pipeline.** UI never assembles prompts — `ctx.agent` owns the graph loop, policy
  gate, hooks, checkpoints, usage and subagents, and mirrors everything to the audit log.

```
src/
  main.ts         activate/deactivate: create the root Context, mount the app
  app.ts          the plugin tree — the whole composition in one file
  host.ts         the VS Code implementation of the Host contract (config, secrets, storage)
  events.ts       typed event declarations (declaration merging on Cordis' Events)
  lib/            pure domain: types, policy gate, graph runtime, mermaid parser, sandbox,
                  prompt shaping, frontmatter, OpenAI protocol, instructions/memory
  services/       Cordis services: log, settings, audit, sessions, checkpoints, usage, tasks,
                  tools, catalog (skills/agents/commands), llm, hooks, mcp, approval, commands,
                  agent (turn pipeline)
  llm/            model adapter: OpenAI-compatible SSE (DeepSeek and friends)
  tools/          tool plugins: fs, shell, plan, todo, web, vscode, math, misc
  ui/             surfaces: chat panel, participant, status bar, sessions/tasks views,
                  review, settings panel, inline actions, slash commands, command palette
  plugins/        reactions: watchers that reload catalogs and MCP on config/trust changes
```

The default agent loop is a Mermaid graph (`comonad.graph`); edit it in **Comonad: Open Settings**.
The panel is tabbed — **Graph** (Mermaid source beside a live preview, Max steps, parsed Nodes /
Routes), **Agent** (model, work mode, approval, display, context, network, working directory,
command timeout, plan directory, deny read paths), **Rules** (the `comonad.permissions` allow / ask /
deny lists, one rule per line, validated on save), **Flow** (the tool-call gate as a Mermaid
diagram: the work-mode, network and workspace checks, then two frames — **your rules** and the
**approval policy**, whose five settings each get their own node — with the built-in unsandboxed /
dangerous-command escalation between them; every gate ends in its own **Rejected** / **Asks you** /
**Runs** node right beside it, so the chart never draws an edge across itself; generated from the
policy tables, so it cannot drift from the code), **MCP** and **Tools** —
remembers the tab you were on, validates the graph as you type, and applies the form only when you
press **Save**. Plan files live under `comonad.planDirectory` (empty keeps `.comonad/plans`).
The built-in flow is `llm.complete → agent.after-llm → agent.tools / agent.confirm / agent.reject → …`.

## Development

```sh
npm run watch        # typecheck + bundle in watch mode
npm run check-types  # tsc --noEmit (bundler resolution; cordis is ESM-only)
npm run lint
npm run compile-tests && npx mocha --ui tdd out/test/extension.test.js   # fast suite
npm test             # full VS Code test host
npm run package      # production bundle
```

esbuild bundles the extension (cordis included) into a single CJS file; the test bundle is built
the same way, so the fast suite runs the real services on a headless Cordis context with a fake
host (`src/test/harness.ts`). Tests cover the policy gate, rule syntax, graph parse/compile/
suspend, frontmatter, path guards, diff parsing and session persistence — plus the Cordis kernel
itself: tool-effect unwinding, visibility filtering, and a full scripted agent turn (tool loop,
streamed events, approval waterfall).
