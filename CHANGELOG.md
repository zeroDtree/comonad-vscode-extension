# Change Log

All notable changes to the "comonad" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- **Images are part of the conversation.** `read_file` reads PNG, JPEG, WebP and GIF files and sends
  them to the model as image content, and the chat composer accepts images pasted or dropped into it
  (six per message, 4 MiB each, 12 MiB in total). Tool cards and prompt bubbles show thumbnails in
  both live and replayed turns. Bytes live in a content-addressed store under the extension's global
  storage, so a session file keeps only the reference; requests resolve it to a data URL at the model
  boundary, and the webview loads each image on demand. Pasted pictures larger than 1568px are
  downscaled and re-encoded before upload. Images count toward the context budget and older
  tool-result pictures are elided first; a model that refuses images is remembered for that chat,
  and a connection reset during an image request is retried once before the request is resent as
  text. The `read_file` tool description and the tool-result API now allow a structured
  `{ content, images }` answer (bare strings still work).

- **The project is now licensed under AGPL-3.0-only.** A few utility routines in the
  tavern plugin are adapted from SillyTavern (AGPL-3.0); `NOTICE` records the files and
  modifications, and `THIRD_PARTY_NOTICES.md` lists the bundled dependencies. The
  packaged extension also stops shipping the development-only `pkgs/` reference tree.

- **A first-class Prompts tab edits Comonad's blocks and tool list.** The read-only Prompts sub-tab
  moved out of Inspect into its own settings page. It lists only Comonad's nine prompt blocks and the
  registered tool definitions: blocks can be reordered, switched off, and their static prefix edited
  (dynamic content stays generated and read-only); tools can be reordered and individually switched,
  while their descriptions and schemas remain read-only. Under ST the block order and switches mirror
  the active preset read-only, with a link to ST → Presets; the edited prefixes still reach the
  composed request. The layout is stored in `comonad.prompts` and `comonad.toolPrompts`.

- **ST takes over every turn, with a built-in Default preset.** When the tavern row is loaded and
  `tavernEnabled` is on, each user-facing turn is composed by the ST collection — even with no
  character, persona, book or preset selected, which now uses the built-in **Default**. Comonad's
  nine blocks (Identity, Tools, Instructions, Memory, Todos, Skills, Sub-agents, Lore index, Context)
  are ordinary preset rows: reorder or switch them like any other entry, while their generated text
  stays read-only and is previewed in the editor and in Inspect → Prompts. A single **Tools** row
  controls the request's API tool list: definitions still travel in the `tools` parameter, and with
  the row off no tools are offered and a call is refused before it runs. Presets store only the
  generated rows' place and switch; *Start from Default* writes an editable copy, and merely loading
  the plugin writes nothing. A `compose` failure still falls back to `[system, …history]`.

- **The settings sidebar resizes and collapses to an icon rail.** Drag the sash between the sidebar
  and the page (150–380px); below the minimum it snaps to a 52px rail with only the tab icons — one
  hand-drawn 16px stroke icon per page (Agent, Graph, ST, Rules, MCP, Tools, Inspect, Plugins), and
  a plugin pane can bring its own SVG icon. Double-click the sash toggles the rail; arrow keys,
  Home and End work on it when focused; the width is kept with the panel's tab state.

- **Fenced code blocks are syntax-highlighted.** A generated `resources/highlight.js` (highlight.js's
  common language set) loads before `chat.js`; code fences are colored by their language — Python,
  JavaScript/TypeScript, JSON, shell, C/C++, Java, Go, Rust, SQL, Markdown and the rest — with
  theme-aware token colors, while `text`/`plaintext` stay literal and unknown languages fall back to
  auto-detection. Shell tool cards use the same highlighter. Copy still returns the exact source.

- **Markdown math is an external KaTeX plugin, and selecting it copies the source.** The new
  `comonad-plugin-math` row contributes its browser bundle, KaTeX stylesheet and fonts to the chat
  through a generic `chatWebview` asset service; the core renderer recognizes `$...$`, `$$...$$`,
  `\(...\)` and `\[...\]` in assistant and command Markdown and calls the plugin's renderer (code
  stays literal, and with the row off the delimiters stay literal). The same webview script
  intercepts in-message copy: a selection is walked back to Markdown, formulas come out as
  `$...$` / `$$...$$`, code as fences, and emphasis/links as Markdown — while the message Copy
  buttons still copy the exact raw text. Install it from Settings → Plugins; fonts are local.

- **A prompt can be edited and resent in place; Rewind is gone.** A user message now carries a pencil:
  the bubble becomes a textarea (Enter resends, Shift+Enter is a newline, Esc cancels), and sending
  discards that turn's reply and every later turn. When the agent wrote files at or after the turn,
  the editor offers **Restore files too**, using the journal's per-turn restore point with the usual
  dirty-editor and outside-change checks. The `comonad.rewind` command, `/rewind` and its QuickPick
  were removed: they were not discoverable from the chat, and the edit makes the same decision where
  the prompt is.

- **Cursor-style `@` references in the composer.** Typing `@` opens a keyboard-driven picker for
  files, folders, symbols and the current editor selection. Choosing an item inserts a text token in
  the prompt — `@src/a.ts`, `@src/a.ts:9-13`, `@src/lib/`, `@symbol:src/a.ts:AuthService`, with
  quoted paths for spaces — which the transcript paints as a chip. The token is resolved when the
  turn runs (and again on regenerate/edit-and-resend) into a numbered context block: 20k chars per
  reference, 60k total, read confinement and deny rules applied, missing/denied references reported
  as error blocks instead of failing the turn. Selecting code in an editor and pressing **Cmd+L**
  (`Ctrl+L`, or **Comonad: Add Selection to Chat**) appends the same `@path:lines` token to the
  composer and opens the chat; with no selection the chord still falls through to VS Code's
  select-line command. `@` references in custom command templates now use this richer resolver too.

- **An expanded shell card shows the command before its output.** `run_shell` / `run_shell_readonly`
  cards now open with the whole command — not the clipped JSON args in the header — highlighted as
  bash with a Copy button, followed by the result. The same highlighter is used for fenced `bash`
  blocks in replies and tool output.

- **Pending changes are a list above the composer, and Regenerate can restore files too.** The
  journal's pending files now sit above the input as a collapsible Cursor-style list — path, `+N −M`,
  **Undo / Keep / Review** for all of them, and a click opens the file in the normal editor with the
  inline review (the separate Comonad diff tab is still on **Show Diff**). When nothing is pending,
  the list stays as the files already reviewed, newest decision first; a new pending change takes
  the list back, so it never mixes the two. Regenerating the last
  reply asks whether the files the agent wrote since that prompt should be restored too, with the
  same dirty-editor and outside-change checks as the edit flow. The old `⊞ N changes` chip is gone.
  The Comonad diff tab's baseline side was empty — the baseline document's own URI scheme was
  rejected when resolving its path — so it painted every current line as an addition; it now shows
  the accepted baseline and the real hunks.

- **Agent edits are reviewed inline, block by block — and the repository has its own changes view.**
  A file the agent wrote now opens with its changed lines painted in the editor — additions as solid
  green blocks with a green gutter bar, deletions as a red-marked block with the removed text on a red
  chip — and **Undo / Keep** at the bottom edge of every change block, while **Undo File / Keep
  File / Show Diff** are both a text row at the top of the file and coloured actions in the editor
  title bar (a green Keep, a neutral Undo, a blue Diff; a code lens itself cannot carry colours).
  **Show Diff** opens the
  one-column (inline) diff editor, so the same review is also available as real red and green lines
  with VS Code's own hunk navigation. Keep accepts that block into the file's *accepted
  baseline* and leaves the rest pending; Undo puts the block back; the review survives further agent
  turns until every block is accepted. The journal therefore tracks an accepted baseline per file
  (`keepHunk`), `undo` now restores that baseline rather than the pre-agent file, and a restore drops
  the blocks accepted after its mark while keeping the ones accepted before it. A dirty editor hides
  the block actions until it is saved; a file changed outside the agent keeps only the file-level
  actions, so a manual edit is never silently folded into an agent change. `comonad.inlineDiff` turns
  the editor layer off; the QuickPick review and `/review` are unchanged. Alongside it, the
  new **Git Changes** view (Sessions → Git Changes) lists the real repository's **Staged**,
  **Changes**, **Untracked** and **Merge** files through the built-in Git extension: clicking opens
  VS Code's diff, and stage / unstage / discard (confirmed when destructive) work from the item and
  from the view title. The journal still only records what the agent's own tools write — shell
  commands show up in the Git view, not in the inline review.

- **The ST world-book page is laid out without the settings cards.** The settings panel's own `.group`
  card style — border, padding, a 22px margin and a max width — leaked into the world-book toolbar,
  which used the same generic class name for its button clusters: the file verbs, the list tools and
  the search row were drawn as three separate cards, and the verbs wrapped onto a line of their own.
  The toolbar clusters are `wi-tools` now, so only their own layout applies. The *Active World(s)*
  and character/tag filter lists also size to their contents up to their scroll limit instead of
  reserving 76px of empty box under a single tick.

- **An installed plugin copy follows the extension's build.** A plugin the extension ships is copied
  into `~/.comonad/plugins` when it is installed, and the tree loads *that* copy — which used to stay
  at whatever the extension looked like the day it was installed. After an update the kernel and the
  plugin then disagreed about what the plugin can do (the settings panel calling a method the old
  bundle no longer had), and reinstalling was the only cure. A plugin host now refreshes an installed
  copy of a bundled plugin from the extension's own `dist` and `resources` at startup, copying only
  files whose bytes differ; a plugin of the user's own is never touched. The ST pane also opens each
  kind on its first item (switching tabs sent an empty selection, which blanked the editor beside a
  full list), heals its selection when the open item disappears, and the Inspect → Prompts pane says
  why the SillyTavern collection could not be read instead of waiting on "Reading the prompts…"
  forever.

- **Editing in the ST tab no longer stutters.** One autosave used to cost two full library re-reads
  (the save itself re-read every file, including parsing every PNG card, and the `.comonad` file
  watcher re-read everything again for the write Comonad had just made) plus two or three full state
  pushes that re-counted every entry's tokens and redrew every tab of the settings panel. Now a save
  writes one file and puts *that file* back into the catalog — exactly what a full read would have
  produced — the watcher only reacts to edits made elsewhere (it compares what is on disk with what
  Comonad last wrote there), and the pushes a single action used to multiply into are coalesced into
  one. The panels redraw only what changed: a state push that lands mid-keystroke no longer rebuilds
  the form under the caret (every field has a stable id and is put back if it must be redrawn), the
  world-book pickers and knobs are guarded like the entry list already was, and only the tab on screen
  is rendered. The model list is fetched off the push path, so a slow endpoint cannot stall a state
  message, and token counts are cached per text. The `comonad.tavernSource` setting is gone — it has
  been ignored for a while, and content is read from Comonad's own library only.

- **Bugs fixed along the way.** An action whose id was no longer in the library (favourite, avatar,
  export, card lore, rename) fell back to the *first* character and acted on the wrong card; renaming
  a world book onto a name that was taken overwrote that book's file and deleted the old one — it is
  refused now, and a renamed book follows into the settings, chats and personas that named it. The
  unnamed subagent spawn was `agents[0]`, which silently became whichever custom agent sorts first
  alphabetically; it is the `explore` agent by name. Two parallel background subagents deleted each
  other's depth tracking, so the depth limit never tripped for nested spawns. A hand-edited settings
  file or a stale session with an unknown mode crashed the policy gate; both fall back to safe values
  now. Saving the settings without ever opening the ST tab wrote the tab's empty form over the whole
  content configuration — a pane only contributes what it has drawn. A restore whose outside-changes
  question was cancelled still cut the conversation; an *Undo* chosen per file could never restore
  the picked subset. Two drafts of the same name wrote over each other's file; a character rename
  onto a name another card owns did too. The chat panel's lorebook picker no longer errors when the
  tavern row is off (it says which row to turn on). A journal that cannot be reached (git missing)
  no longer fails the write itself — the write lands unrecorded, as with the row off — and
  `journal.json` is replaced atomically instead of being truncated into an empty history. Token
  counting now always goes through the kernel's counter (a plugin's bundle carries its own copy of
  the pure estimator, which never sees the loaded tokenizer), and the web-tokenizer files — DeepSeek,
  Qwen2, Claude, Llama and the rest — are a provider the *kernel* installs again: counting is not a
  feature that may go missing with a content row, and `comonad.tokenizerDir` moved to the kernel's
  keys with it. The journal's vocabulary moved to `lib/journal.ts`, so the review surface and the
  service behind it no longer import each other, and the ST file-format types moved into the tavern
  plugin beside the code that reads those formats.



- **A plugin can be uninstalled.** Every row that is not built in gets an **Uninstall** button in
  **Settings → Plugins**, behind a confirmation that names the folder it will delete. The row is taken
  out of every `cordis.yml` that names it — which disposes the plugin and anything that stood on it —
  and the folder an install copied into `~/.comonad/plugins` goes with it; the modules lent to plugins
  stay. A row that was never installed is uninstalled the same way, but only its row goes: the files it
  loads are yours. Both steps can still be done by hand.

- **The change journal (shadow git) is a row of the shipped tree — on by default.** An irreversible
  write is a worse default than a shadow repository, so the journal ships in `dist/extension.js` and
  loads with the kernel (`src/services/checkpoints.ts`, with its `src/lib/diff.ts` and
  `src/ui/review.ts`): every window has the review commands and `Cmd+Alt+D` with no install step. One
  `cordis.yml` line still turns the row off — and then a write is simply a write: nothing is journaled,
  no review command is registered, and `comonad.checkpoints: false` still pauses a journal that is
  there. The agent and the chat panel still reach it through
  `ctx.get('checkpoints')`, so the row toggle is the same optional read it always was. Exporting a chat
  is not the journal's business, so `comonad.exportSession` stays with the sessions view.

- **A plugin owns its settings and its formats; the kernel keeps only the seam.** The line between the
  kernel and the ST content layer now follows one rule — a feature whose absence is a *simpler* product
  may live in a plugin, one whose absence is a silently *worse* one may not — and the code says so:
  the tavern's 37 settings keys, their defaults and their typing moved into the plugin's own
  `lib/settings.ts` (the kernel's `Config` and `CONFIG_KEYS` know none of them; writes still go through
  `ctx.settings.update`, and `Host.config()` reports every key the manifest declares, kernel and plugin
  alike). `src/lib/tavern/types.ts` is types only now — the format constants and factories live in the
  plugin beside the code that reads the formats, and the generation vocabulary (`/continue`, the Send
  menu) turned out to be the kernel's own and moved to `src/lib/generations.ts`. The vectors service
  and `lib/vectors.ts` went where their only customer is: the tavern mounts them and `compose` (now
  async) runs the vectorized world-info scan itself, handing the agent an overflow alert and the
  automations to run instead of asking it to read `wi*` settings. The kernel keeps the whole counter —
  tiktoken, the bytes estimate, the `ctx.tokenizers.use(...)` socket, and the web-tokenizer files it
  installs itself. The build
  now bundles *every* folder under `packages/` that declares `comonad.plugin`, so a third plugin needs
  no build change.

- **A setting picked from the chat sticks in a window with no folder open.** A mode, an approval, a model or
  the display form all write through the host, which asked for *workspace* settings — a write VS Code refuses
  where there is no workspace, so the pick failed with an error instead of landing. It falls back to your own
  settings, which is the only place left. An MCP server that answers with a string `id` — the spec allows
  either type — is answered as the request it came from rather than waiting for a timeout, and the background
  task tool stops listening for a task it has given up on. The world info a turn carries in chat is spliced in
  even when the collection has no **Chat History** block, which used to drop an author's note silently.

- **A compaction can no longer write a `/continue` onto the wrong message.** A fold rewrites the transcript,
  and the reply a continue extends has a new index in the transcript it leaves: the turn finds it again there
  instead of keeping the index it took before the fold. A continuation therefore still extends the reply it was
  asked to continue — the stale index could name the turn's own tool call, which left the record with an
  assistant call no result answered (every later request refused) or wrote the text twice onto itself. A fold
  during a quiet turn or an impersonation keeps the summary it wrote, so the record, the restore points and the
  summary describe the same conversation again, and a summary that is extended keeps the count of turns it
  already stood in for rather than restarting at the one message it replaced. Elision steps every oversized
  tool result down when the request still does not fit (the running estimate no longer forgets the steps it
  already took), and an embedding answer that comes back with a vector missing is refused instead of pairing
  a vector with the wrong text.

- **An impersonation and a quiet turn run no tools.** Both used to be offered every tool the chat has, so a tool
  they called ran for real (a write was approved in the chat, and the reply was discarded afterwards), and both
  counted as a turn of the chat. Neither is offered tools now, a call either makes anyway is dropped, and neither
  leaves the turn count alone.

- **The ST content layer is a plugin you install, not a feature built in.** It moved out of `src/` into
  a package of its own, `packages/comonad-plugin-tavern`, built as its own bundle (`npm run build:plugins`)
  and loaded by the host at run time: nothing in the shipped tree names it, so `dist/extension.js` carries
  no content code at all — no library, no `lore_lookup`, no `/char` `/persona` `/lore` `/preset`, no **ST**
  tab — until the row is there. **Settings → Plugins → Install…** offers it by name (and any other plugin
  folder): the folder is copied into `~/.comonad/plugins/<id>`, a row is written into your `cordis.yml`,
  and the list is applied again. Uninstalling is deleting either one.

- **The settings panel draws panes, not tabs it knows about.** A pane is what a plugin contributes to the
  panel — its tab, its markup, its stylesheets, its scripts, an optional editor and the config keys it
  owns — and the panel asks each pane for its slice of every state push and for its keys at save time. The
  **ST** tab is the tavern plugin's pane: with the row off the tab is not in the document at all, and with
  it on the tab, its client files and its editor come from the plugin's own folder. The three services the
  panel mounts before the tree (`host`, `log`, `settings`) are unchanged and still not rows.

- **`cordis` and `vscode` are lent to an installed plugin.** A plugin loaded from `~/.comonad/plugins`
  cannot resolve the platform modules from its own folder, so Comonad writes
  `~/.comonad/plugins/node_modules/{cordis,schemastery,vscode}` beside it — generated bridges into the
  running process, the way the harness shims are, so a plugin shares the host's classes rather than
  carrying a second cordis. A plugin of your own can therefore be a single folder installed with
  **Install…**, or mounted straight from a `cordis.yml` row. `COMONAD_HOME` names a different home for
  all of it, and the test host sets it: the plugins you run never change what a test sees.


- **Every feature is a plugin now, and the list is yours to edit.** The extension is one Cordis tree
  written down as rows (`{ id, name, disabled, config }`) instead of assembled by hand, and a
  `cordis.yml` in the project (`<workspace>/.comonad/cordis.yml`) or in your library (`~/.comonad`) turns
  a row off, gives it a config of its own, or mounts a plugin of your own beside the shipped ones
  (`name: ./mine.js`, or an installed package). Nothing here is privileged: a disabled row is never
  loaded, a row that fails is reported with what became of it (`pending: waiting for …`, or the error it
  threw) while the rest of the tree loads, and a row that changes behaviour does it through the same
  extension points everyone else has to use. A plugin is a module — `export const name`, an optional
  `inject` (declared, never inferred: cordis refuses a property that was not asked for), and `apply(ctx,
  config)` — and everything it registers inside `apply` is an effect of it, so unloading the row takes
  its tools, commands and watchers with it. A plugin that exports a `Config` schema has its row config
  validated before `apply` runs. One rule is worth repeating: a row cannot *inject* the host's own list
  — it reads `ctx.get('plugins')`, because the host is what is mounting it.

- **The plugin list has a panel: Settings → Plugins.** Every row in load order with where it came from
  (the extension, the workspace's `cordis.yml`, or your own), what it resolved to, and what became of it —
  `loaded`, `off`, or `not loaded` with the reason on hover (`pending: waiting for tools`, or the error the
  plugin threw). `Disable`/`Enable` writes the change into the workspace's list when the workspace is
  trusted and into yours when it is not, and applies **that row** again — not the whole tree. That last
  part matters: the panel is a row of the tree it is listing, and a full reload tore it down mid-click, so
  turning `tavern` off looked like nothing happened. A row that others inject now takes them with it —
  they go inactive and say what they are waiting for (`pending: waiting for tavern`) — and come back when
  it does, the states in the table are read from the live fibers rather than from the moment each row was
  applied, and a `cordis.yml` saved by hand is applied in full as soon as it changes (the host can tell
  its own write from yours). A "Apply the list again" button applies everything on demand, and the tab is
  how you get a feature back: the ST tab and its commands reappear the moment `tavern` is enabled.

- **The tree's own wiring is a table: Settings → Inspect → Plugins.** Every row with what it provides
  (a service another row can inject), what it needs — and which row provides each, or `(built in)` for the three
  services Comonad mounts before the tree (`host`, `log`, `settings`: not rows, and not switchable) — who
  needs it, its layer, and its state (`loaded`, `off`,
  `waiting`, or `failed` with the reason on hover). A service nobody provides is written `?name`, so a row
  waiting for something is visible rather than looking like a row that failed. Clicking a row prints its
  **dependency tree**: what it stands on, and the whole chain that goes down with it, which is what a
  toggle is really asking. Rows declare the layer they belong to (`kernel`, `tools`, `ui`, …), and all of
  it is read from the live fibers — including a service a row provides through a plugin of its own.

- **SillyTavern content and the shadow-git journal are plugins, not built-ins.** `{ id: tavern, disabled:
  true }` turns the content layer off, and `{ id: checkpoints, disabled: true }` turns the journal off.
  Neither takes the rest with it: without the tavern plugin a turn is exactly `[system, …history]` (the
  agent reads the layer as `ctx.get('tavern')`, so the composition port is simply absent), the ST tab
  disappears from the settings panel, and `/char`, `/persona`, `/lore`, `/preset` and the tavern's title
  bar commands are not registered — while `/help`, `/status` and the model, tools, MCP, rules and
  inspect tabs are untouched. Without the journal, a write is just a write (nothing is recorded, the
  tool is unaffected), and the review pane goes with it. Every reference the tavern layer had grown into
  the agent, the slash commands, the settings panel and the environment watchers is behind one of those
  seams now, and the agent reaches both features the same way: `ctx.get(...)`, never as an injection.

- **DeepSeek Harness plugins run here.** A plugin written for the harness loads as it is: the `harness`
  row redirects every `@deepseek-ai/*` import — `@deepseek-ai/cordis` is *this* cordis, so a plugin's own
  `Service` subclass is a service the tree can see; `@deepseek-ai/schemastery` is the copy whose schemas
  `Config` exports are validated with; `@deepseek-ai/dsh-brand`, `@deepseek-ai/dsh-tools`'s `defineTool`
  and `@deepseek-ai/dsh-llm`'s `createUserMessage` are answered by small shims written where you can read
  them (`~/.comonad/shims`). Its tool and policy half is implemented: `ctx.tools.register()` takes a
  Comonad spec or a harness `ToolDefinition`, and the four waterfalls `tools/pre-execute`,
  `tools/execute`, `tools/post-execute` and `tools/result` carry the harness's payloads and decisions
  (`{kind:'deny',reason}`, `{kind:'accept',content}`, `{kind:'block',feedback}`, `ask` through the
  approval surfaces) — so a permission gate, a timeout wrapper, a result shaper or a metrics observer
  works unmodified. What is *not* implemented is the harness's agent and session internals
  (`ctx.agents`, `session/event`, the PTC runtime): those names resolve to an empty module and are named
  in the log, so a plugin that needs one fails where it used it instead of looking like Comonad's fault.

- **Tool calls go through a policy pipeline, with or without the harness.** Every dispatch now passes
  `tools/pre-execute` (refuse a call, or ask for it), `tools/execute` (wrap the dispatch — a replaced
  `signal` is the signal the tool body honours), `tools/post-execute` (replace what the model sees, or
  block with feedback) and `tools/result` (observe the settled outcome, refusals included). A refusal
  reaches the model as the reason the plugin gave, because the model is the one who has to try something
  else. The four names, payloads and decisions are the harness's, so the same listener works in both.

- **The preset tool row no longer runs over the buttons beside it.** `#st-form .preset-tools` asked for a
  flex row's `flex: 1 1 100%` inside the *grid* the actions bar is, so the row kept one cell's width and
  its controls were laid out across the buttons next to it ("Restore template" under "Import…"). It spans
  the grid's row now, and its buttons size to their words and wrap instead of shrinking into each other.

- **A continue and an impersonation ask as the user.** Neither has a prompt of its own, so the request
  ended on the model's own turn: OpenAI completes that turn, but Gemini refuses the whole request
  (*"Requests ending with a model turn are not supported"*) and the turn is lost. The ask — the preset's
  own nudge or impersonation prompt, or the agent's words when there is none — is now also sent as the
  turn the model answers, which is where a preset's `send_if_empty` sits upstream. A quiet generation's
  prompt is sent that way too; it used to be dropped entirely, since a quiet turn is never written down.

- **The composer's actions sit at the right edge of the input box.** Send and the generation caret
  were held apart by a `grow` spacer whose rule only exists in the *settings* webview's stylesheet,
  so the whole row read left-aligned. They are one group now (`#sendbar`), pinned
  right and kept together when the row wraps on a narrow panel.
- **Gemini 3's thought signatures are kept.** A Gemini 3 function call comes back with a
  `thought_signature` in `extra_content`, and the next request is refused —
  *"Function call is missing a thought_signature in functionCall parts"* — unless that exact field
  rides back with the call. It is now kept on the call (and travels with the chat, so a reload or a
  resume still sends it) and handed back verbatim; a call that has none, because it was written before
  this or by another provider, carries Google's own `skip_thought_signature_validator` bypass instead,
  so the turn is not lost. Only a model that demands one (Gemini 3 and later) is ever sent the bypass.

- **The generation menu's six types now land where upstream puts them.** A turn of any other type than
  *Normal* is written somewhere other than where it streamed, so the panel is handed the transcript
  again when the turn ends — a **Continue** grows the reply it carries on (in place, no second bubble),
  an **Impersonate** streams your next message into the composer to edit and send (the chat is left
  alone, exactly as upstream's own button does), a **Quiet** turn leaves no bubble behind and reads as
  a notice, and a **Swipe**/**Regenerate** keeps its versions: `‹ n/m ›` is drawn on the turn the
  variants belong to, and switching one redraws the reply it moved instead of the last one in the chat.
  **Continue** also stops cutting the transcript — it grows the last reply only when nothing comes
  after it (a stopped, failed or tool-waiting turn used to lose the messages behind it), and a chat
  that has said nothing is told there is nothing to continue. `/compact` is handed over the same way,
  with the command's own answer printed after the redraw.
- **A fork from a turn stops at that turn.** The panel was handed the copy as it stood *before* the cut
  — a fork is announced twice, as a new chat and then as the copy with the turns after the click
  removed, and the snapshot taken before the second one won — so a fork from a middle turn looked like
  the whole conversation. The transcript a panel is given is now read after the wait, and one that got
  shorter behind its back (the same fork, or a prompt edit) is handed over again.

- **Checkpoints are per file, not per turn.** Every write the agent makes (`write_file`, `apply_patch`,
  `apply_edits`, `write_plan`) is journaled with the file's content before and after it, through
  `ToolContext.edit`. A turn that writes nothing takes no snapshot. Nothing is ever pruned, so a
  session keeps its full history.
  - **Review** lists only the journaled files, from one `git diff` against a temporary index that holds
    just those paths (no `ls-files`, no process per file). A file the user changed outside the agent is
    flagged; undo and restore ask once — *Restore all* or *Choose per file* — and never overwrite it
    silently. A file open with **unsaved** text refuses until it is saved, and nothing is written on a
    refusal.
  - **Shell commands are not tracked**, and the review says so in its title.
  - **Editing a prompt** can restore the files the agent wrote at or after that turn; the restore
    point is taken before the turn's first write.
  - The old `Revert Files to Checkpoint` and `Rewind Conversation and Files` commands are gone: editing
    a prompt covers the file side, with the same checks.
  - Shadow stores from the snapshot design are removed on startup; old restore points are dropped.
- **An Inspect tab: what the model is told, and how a tool call is gated.** The read-only views now live
  under one top-level tab, **Inspect**, with two sub-tabs of its own:
  - **Tool Policy Flow (TPF)** — the old **Flow** tab under a name that says what it draws; the chart is
    only rendered while this sub-tab is on screen, since Mermaid measures its container.
  - **Prompts** — every prompt in one place, grouped by where it comes from — **Comonad** (the agent's
    own named system-prompt blocks: Identity, Instructions, Memory, Todos, Skills, Sub-agents, Lore
    index, and the turn's Context), **Tools** (each tool's definition, description and parameter schema,
    marked when the chat's work mode leaves it out), and **SillyTavern** (the collection the active chat
    would send, with its real order, on/off state, markers and injection depth). Pick a row to read the
    prompt in full; **Refresh** re-reads it. The slice is read on demand rather than on every state push.

  Remembering which sub-tab you were on is part of the panel's saved state, and neither view can change
  anything.
  - The agent's prompt is now built as **named blocks** and joined the way the model receives it, so the
    tab and the request can never disagree.

- **A prompt is saved before it is inserted.** Nothing adds a block to the preset's list any more: the
  **Prompt library** is one entry box whose small button switches between **Built-in** (shared by
  every preset) and **Custom** (this preset's own), holding a picker with **+ New** and
  **Insert**. *Insert* copies the picked entry to the top of the list, right after Comonad's own
  identity block (which still leads the collection); *+ New* saves a new entry into the library the box
  is showing and opens its editor, scrolled into view with the status line saying what happened.
  - There are two libraries. The **system library** lives in `.comonad/prompt-library.json`, is seeded
    from the eight built-in blocks, and is edited in place (rename and delete) — a change there reaches
    every preset. A **preset's own library** is stored inside the preset's file under
    `comonad_prompt_library`, a key SillyTavern ignores, so it travels with the preset and every ST
    field is written back untouched.
  - Picking an entry opens its editor in the space right below the box — name, role and text — with a
    **Delete** button. There is no separate list to keep in step with the picker, and identifiers are
    made unique on insert, so the same block can be inserted twice.

- **The library is read at startup.** `Tavern` and `Catalog` had no initial load at all — `reactions`
  only watches — so they were read for the first time only when a `.comonad` file changed or a setting
  was saved. The ST pane therefore opened on an empty shared prompt library, and its seed file was never
  written. Each service now reads its own library as it is constructed, and `Tavern.ready` is that first
  read so a caller can wait for it.
  - Each library entry has its own small editor (name, role, text) and can be renamed in place. A
    system entry writes straight through to the shared file; a preset entry is saved with the preset.
  - The pane keeps the item it is editing: a state push while the form is dirty (which a
    shared-library save causes) no longer replaces it with the copy on disk, so unsaved edits survive.

- **The ST tab is one design now.** Its pages were built one after another and it showed: five kinds of
  button, three field sizes, icons floating in the middle of a row, a header line that did not sit over
  the columns it named. They now share one scale, declared once as tokens in `settings.css` — every
  pane is loaded into that one document — with a **26px control height**, 6/4px radii, 11.5px labels,
  muted hints, one focus ring, and every colour a theme variable with a neutral fallback, so the panel
  is at home in a light theme and a dark one.
  - The sub-tabs are a **tab strip** whose counts are badges of their own rather than parentheses in
    the tab's name, and the pane's toolbars group their verbs, so a row breaks between groups instead
    of in the middle of one.
  - The **prompt list** reads the way upstream's does: one card per block — a switch, the name with its
    markers (📌 marker, ★ important, the role where it is not the system's, and `@ 2` where the block
    goes into the chat), the block's own controls and its token count — on a grid the header line
    shares, which is what keeps the columns straight. *Add prompt…* and *Restore prompts* sit under it
    with the list's total on the right.
  - The **world-book list's** labels are a row of the entry row's own grid instead of a hand-tuned
    padding, so *Strategy*, *Position*, *Depth*, *Order* and *Trigger %* sit over the fields they name;
    the state column is the bare 🟢/🔵/🔗 upstream shows, and an entry that is switched off dims whole
    (and comes back on hover) rather than striking its title through.
  - The **persona page** lists personas as rows — picture, name, title, and the crown and lock badges —
    with upstream's picture wall one click away; position, depth and role are one row of three fields
    instead of three loose rows, and a connection is a chip with its own ✕.
  - A card's actions are two groups (what the chat uses, then the file verbs), the list's search takes
    a row of its own, and every icon button — ↑ ↓ ✎ ⧉ ✕, the fold arrows, the ★ and ▦ filters — is the
    same 22px square with the same hover.

- **Personas are SillyTavern's own now, pictures and all.** The Personas sub-tab is upstream's persona
  panel: the avatar tiles on the left (create, search, A-Z / Z-A / search order, paging, grid toggle
  and the upload tile) and the open persona on the right — name and title, picture, description with a
  live token count, where the description goes (**None (disabled)** first, upstream's own order),
  depth and role, the three locks (*Default* / *Character* / *Chat*) with the connection list, the
  persona's own book, and the three persona-wide settings. It saves as you type, as upstream's does.

  - Connections are stored in upstream's `{type, id}` shape, so a persona backup made in SillyTavern
    reads here and ours reads there. The bare names an earlier Comonad file carried still load, and a
    connection written `Kestrel.png` now matches the card Comonad calls `Kestrel`.
  - The picture is a file beside the persona, named after it — which is what upstream's avatar is.
    **Backup** writes every persona into the document SillyTavern restores from; **Restore** merges one
    back, skipping what is already there and naming what it skipped; **Duplicate** copies the persona
    and its picture; **Convert a character…** makes a persona out of a card, swapping
    `{{char}}`/`{{user}}` if you say so; deleting a persona takes its picture with it.
  - Three settings joined them: `comonad.personaAutoLock`, `comonad.personaAllowMultiConnections` (off
    means connecting a persona to a character takes the character from whichever persona had it) and
    `comonad.personaShowNotifications`.
  - *Sync user name* is deliberately absent: `{{user}}` is resolved when a request is built, so there
    are no stored names to rewrite.

- **Cards carry the fields upstream keeps outside the V2 spec.** A card's **favourite** (`fav`, at the
  V1 root and under `extensions`), its **talkativeness**, the **create date** upstream stamps on it and
  its **source link** are read from wherever upstream writes them and written back to both places. The
  editor gained a **picture** — and since upstream keeps a card *as* its picture, choosing one writes
  the card as a PNG card beside it and removes the JSON — plus a talkativeness slider and a **More…**
  menu with upstream's own entries: *Import Card Lore* (the book a card carries becomes a library world
  book and the card is linked to it), *Convert to Persona*, *Rename* (the file, the tag-registry key,
  the persona connections, the default character and every open chat follow the new name), *Link to
  Source*, *Import cards…* and *Export JSON…*. The list gained search, order (name, newest, oldest),
  a favourites filter, grid view, paging and avatars. A card's embedded book is no longer scanned twice
  once it has been imported and linked.

- **The whole chat-completion preset, not just its samplers.** The preset form now covers what
  SillyTavern's OpenAI settings hold: the six **nudge prompts** (what is sent when there is otherwise
  nothing to send — the history is headed by *New chat*, a history ending on a reply is filled by *Send
  if empty* as the user, and a continue carries *Continue nudge*, `{{lastChatMessage}}` and all), plus
  `seed`, a **logit-bias** set and the name of the one to send, `stream_openai`, `max_context_unlocked`
  and `use_sysprompt`. A preset can also keep a **prompt order per character**, which is used for the
  character it names; a SillyTavern block whose numeric `character_id` means nothing here is preserved
  verbatim rather than dropped. `frequency_penalty`, `presence_penalty`, `seed` and the selected logit
  bias now reach the request, and a field the preset does not set is never sent. `{{charIfNotGroup}}`
  joined the macros — the shipped *Main Prompt* is upstream's own text, written with it.
  - The preset manager gained **Import…** (validated before it is accepted), **Export…** (a library
    file is copied byte for byte, so nothing unmodelled is lost), **Start from…**, **Restore template**
    and **Restore prompts**, and *Add prompt…* offers eight blocks worth having to hand.
  - **Four templates ship with Comonad**, written here rather than copied from anyone: *Balanced*,
    *Creative*, *Precise* and *Long-form*. Choosing one copies it into `.comonad/presets/`, where it is
    an ordinary preset you can edit or delete.
  - What is kept but not acted on says so in its own hint rather than being dropped silently:
    `top_k`/`top_a`/`min_p`/`repetition_penalty` (a chat-completions endpoint refuses them) and
    `stream_openai: false` (Comonad always shows tokens as they arrive).
  - The context template, instruct mode and sysprompt are still not built, and that is deliberate:
    SillyTavern hides all three while the API is chat completion and never sends them. Their keys ride
    along in a preset's unmodelled ones, so importing an upstream preset loses nothing.

- **A prompt entry is editable, the way upstream edits one.** Every row of the preset's prompt list
  unfolds upstream's *Edit* panel under itself, as the world-book entries do — **Name**, **Role**,
  **Triggers** (the generation types the block fires for; nothing ticked means all of them),
  **Position** (*Relative* or *In-chat @ Depth*), **Depth**, **Order**, the prompt text and
  **Forbid Overrides**, each with upstream's own hint. The
  list draws the row the way upstream draws it — the name with its markers (a pin for a marker, ★ for
  forbid-overrides, ⧉ for an extension block, the role, and `@ depth` when it is in chat), the block's
  token count, and its own controls: move, edit, duplicate, delete. A marker says its text is pulled
  from elsewhere and cannot be edited, in upstream's words, and *Reset* puts a shipped block back to
  the name, role and text Comonad ships. This is not only an editor: a block limited to some
  generation types really is left out of the others, and an in-chat block's **text now reaches the
  request**, spliced into the history at its depth and order — deeper depths further up, and within a
  depth low order first and assistant, user, system, which is upstream's own `populationInjectionPrompts`
  order.

- **Creating a world book asks for its name.** *Create* used to make a `New Lorebook` file the moment
  it was pressed; it now opens the same input box *Rename* uses, prefilled with the first free name,
  and nothing is written if it is dismissed. The name a pane sends outright is still taken as it is,
  and a name that is already taken gets a number rather than overwriting a file.

- **The world-info fields that were hidden are real now.** An entry's **Automation ID**, its
  **Filter to Generation Triggers** and its **🔗 Vectorized** state are back in the editor and mean
  something:
  - *Automation ID*: when the entry activates, the `WorldInfoActivated` hook fires and the
    same-named slash command runs — once per turn, and only with `comonad.wiAutomation` on, because
    a name is all it takes to run a command.
  - *Generation triggers*: SillyTavern's six types (**Normal, Continue, Impersonate, Swipe,
    Regenerate, Quiet**) are now real generations, offered by the ▾ beside *Send* and by
    `/continue`, `/impersonate`, `/swipe`, `/regenerate` and `/quiet`. An entry that names types
    fires only for those. Replies keep their versions — `‹ n/m ›` on the turn walks them — a
    regenerate replaces the first version and adds every later one, a continue extends the message
    it carries on, an impersonation streams into the composer and is written nowhere, and a quiet generation
    leaves no trace in the chat.
  - *Vectorized*: with `comonad.wiVectorEnabled` an entry in that state is found by meaning instead
    of by its keys — the newest messages are embedded through an OpenAI-compatible `/embeddings`
    endpoint, ranked by cosine similarity against each entry's own vector, and the best few above
    the score threshold are injected. Vectors are cached per book and model under the extension's
    storage, keyed by a hash of the entry's text.
- **A real tag registry.** Tags live in `.comonad/tags.json` in SillyTavern's own shape (`tags` plus
  a `tag_map` from character to tag **ids**), the Characters tab shows a character's tags as chips,
  *Manage tags…* creates, renames, colours, folders, deletes and merges them, *Import card tags*
  reads the card's own `tags` field exactly as upstream does (`comonad.tagImportSetting` decides
  between asking, all, only existing, or none), and an entry's character filter now stores tag
  **ids**, so renaming a tag cannot break a filter.
- **Search is Fuse.js, with upstream's options.** The world-book search box now ranks entries the
  way SillyTavern's does — the same key weights, `ignoreLocation`, the extended syntax (`'exact`,
  `!not`) — and `.comonad/tags.json`-style matching is case- and accent-insensitive.
- **Exact token counts.** The counter behind the world-info budget, the context trim and every
  panel readout is now the model's own tokenizer: tiktoken (`o200k_base` / `cl100k_base` / `r50k`)
  for the GPT families, and SillyTavern's own tokenizer files — downloaded from upstream's
  repository, or read from a SillyTavern checkout configured in `comonad.tokenizerDir` — for Claude,
  Gemini, Llama, Mistral and friends, with upstream's `+6` message framing added on top. A model
  nothing is known for falls back to the byte estimate, as upstream does.
- **An entry's character/tag filter reads SillyTavern's own key.** The filter is written as
  `character_filter` (the name upstream's editor writes, holding tag ids), and the three flat keys
  an earlier Comonad file carried are read for compatibility and dropped on the next write.

- **The World books sub-tab is SillyTavern's own panel, in its shape.** Active worlds, the global
  activation knobs (scan depth, context %, budget cap, min activations, max depth, max recursion
  steps, insertion strategy, include names, recursive scan, case-sensitive, whole words, group
  scoring, **alert on overflow**) and the book toolbar (Create / pick / Import / Export / Rename /
  Duplicate / Delete) sit above the entry list, which has SillyTavern's search (weighted over keys,
  group, title, secondary keys and body), its sort rules (priority, custom, title, size, depth,
  order, uid, trigger %) with *Apply sorting as Order*, its paging, *Open all* / *Close all* and
  *Fill empty titles*, and drag-to-reorder under the custom sort. Every row unfolds into the full
  editor — key **chips** with the ✨/⌨️ plaintext switch, the optional filter, outlet name, per-entry
  scan depth and trinary overrides, recursion level, content with its **token count and uid**, the
  inclusion group and weight, sticky/cooldown/delay, the character-or-tag filter, *Selective* / *Use
  Probability* / *Add Memo* and the *Additional Matching Sources* drawer — and there is no Save
  button: the page writes the book back as it is typed into. The world-info knobs moved out of the
  Settings sub-tab, where SillyTavern keeps them.
- **An entry's character/tag filter now decides activation.** It was read from the file and then
  ignored, so an entry SillyTavern would have kept out of a chat was injected there anyway. The
  names are matched against the character's file name and the tags against its own, with *Exclude*
  turning the test around.
- **`{{outlet::Name}}` works.** An entry whose position is *outlet* is not injected where it sits;
  its text is now collectable in a prompt by name. Before this the position was a dead end.
- **Alert On Overflow.** A new setting: when the world-info budget stops the scan, the chat says so
  once, the way SillyTavern's toast does.
- **The content layer has its own library, in SillyTavern's formats.** Characters, world books,
  personas and presets live in `.comonad/{characters,lorebooks,presets,personas}` (project and user
  folder) — Comonad's own folders, written in the same file shapes SillyTavern uses, so an item can
  be moved between the tools either way. Reading a SillyTavern installation directly is gone: the
  `comonad.tavern.source` setting is now ignored (it stays declared so the old value keeps
  validating), and nothing outside the library is ever written or deleted.
- **One ST tab for the whole content layer.** The settings panel's Character and Lore tabs, plus the
  separate content-manager panel, are now a single **ST** tab with five sub-tabs: *Characters*,
  *World books*, *Personas*, *Presets* (the full editors, each with New / Duplicate / Delete /
  Folder / Save, *Use in this chat*, *Make default* and *Export PNG…*) and *Settings* (the defaults,
  the author's note and the world-info knobs). The panel and the content editor share one webview:
  the editor is a self-contained pane the panel feeds its state slice and whose `{type:'content'}`
  messages it routes — so `Comonad: Manage Content` now opens the settings on that tab, and the
  standalone panel and its command are gone.

- **New at runtime:** a card's `extensions.world` binds a library book that is scanned without being
  listed; a card's depth prompt is injected in chat at its own depth and role; a persona's
  `connections` binds it to characters, so a chat speaking as that card uses the persona
  automatically; the world-book reader accepts both SillyTavern's own files and a card's
  `character_book`, and the writer emits SillyTavern's exact shape (camelCase at the root, mirrored
  under `extensions`, unknown keys preserved).

- **The agent can wear a character.** SillyTavern's content layer is ported: character cards (PNG
  `chara`/`ccv3` and JSON, V1/V2/V3), world books with their keyword scan and injection positions,
  personas, and OpenAI presets with their prompt collection, order and samplers. Content is read
  from `.comonad/{characters,lorebooks,presets,personas}` (project and user) and, read-only, from a
  SillyTavern folder you point at with `comonad.tavern.source`. The agent's own identity block stays
  first and a request without any content selected is byte-identical to before, so nothing changes
  until you pick something.
- **Opening greetings.** `Comonad: Pick Character` (or `/char`) binds a card to a chat and inserts
  its `first_mes` — or a chosen alternate — as the chat's first turn: rendered without a prompt
  bubble, never offered a **regenerate**, pinned when the history is trimmed, and persisted, so a
  reload comes back to the same opening line. A chat that already said something is never rewritten.
- **`lore_lookup`.** The model gets a read-only tool to look a world book up on demand (the `/wi`
  family): the identity block lists the books the chat can search, a miss says so, an unknown book
  name is an error rather than a crash, and a lookup never changes what the next turn injects.
- **New commands.** `/char`, `/persona`, `/lore`, `/preset` and `/note` join the chat commands;
  `Comonad: Pick Persona` and `Comonad: Pick Prompt Preset` join the palette. Nothing is layered on
  the composer for it: the character, persona, books and preset of a chat are picked with those
  commands (or the settings panel's defaults), and the **◈ lore** chip reports the entries the last
  turn injected.
- **Settings: Character, Lore and Prompts tabs.** Pick the default character, persona, preset and
  books, edit the user name, the SillyTavern folder, the author's note and its depth, the scan
  depth/budget/cap/recursion/matching knobs and the world-info format; the Prompts tab reorders and
  switches the collection off and saves it as a preset under `.comonad/presets`. The tavern settings
  are now declared in the manifest, so they are editable (and discoverable in JSON settings) instead
  of only working from built-in defaults.

- **`Cmd+N` now starts a new chat instead of a text file.** The chord was bound but never fired: a
  key press inside a webview is resolved against the workbench's *root* context, where the
  part-scoped keys the `when` clause relied on (`focusedView`, `auxiliaryBarFocus`, `activeAuxiliary`)
  are out of scope, so the chord fell through to VS Code's New Text File. The chat now reports its own
  focus (`focusState` from the guest, on focus/blur/mousedown and visibility) and the host publishes it
  as the **`comonad.chatFocused`** context key with `setContext`, which every target can see. New
  session also reveals the chat surface and puts the caret in its input, so it reads the same from the
  chat, the Sessions/Tasks trees, the title-bar ✎ or the palette; a popped-out chat stays in its own
  window; with the editor focused the chord is still VS Code's New Text File.
- Every step now says **how long it took**: the thinking block (`🧠 Thought 12.4s` once it is over —
  it reads `Thinking…` while the model is still reasoning), each tool row
  (`✓ run_shell {…} 8.1s`) and a plain answer's own round trip. While a step runs the number climbs
  live, and at the end of the turn it settles on what the extension measured — the model round trip
  for thinking and answers (stamped as `startedAt` on the message), and result-minus-request for a
  call. One timer per round trip, never a fabricated one.
- A turn's live DOM now matches a replayed one down to the fold state and the timer text, which the
  harness compares; that check found a real bug: a step closed within the same animation frame as its
  last delta kept the empty text it was created with (a thought followed immediately by a tool call
  showed nothing), so the open buffers are flushed before a pointer moves on.

- A turn starts folded: the chain of thought and every tool call are collapsed until you click them.
  The tool row already carries what matters — the name, the arguments and ✓/✗ — so the transcript
  reads as a list of what happened instead of a wall of output, and a click opens one call's output or
  the reasoning behind it. Streaming no longer springs the thinking block open either.

- **The model menu is read from the endpoints** (`GET /models`, both the `data`-wrapped and bare-array
  shapes) instead of being a fixed list per profile, cached for ten minutes with a **Refresh** that
  re-reads it; a profile whose list fails still offers the model it declares. Two profile fields shape
  the list as data, not code: `modelPrefix` (Gemini reports `models/<id>`, stripped so the menu and
  the requests use `gemini-3.8-flash`) and `modelSkip` (a regex that keeps the image, computer-use,
  deep-research and embedding models Gemini also lists out of the menu). A choice stores
  `profile:model` in `comonad.model` (a bare profile id means that profile's default model), and
  `describe()` shows the model name in the pill once one is picked.
- **Every provider fact is profile data, not code**: `keyEnv` (one name or a list, tried in order
  before the OS keychain — `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`), `thinkingOff`, the
  prices and the default model all live on the profile, the wizard asks for the variables instead of
  guessing them from the base URL, and the shipped DeepSeek/Gemini block is the only place a provider
  is named.
- **Comonad now runs on DeepSeek out of the box and no longer uses Copilot.** The Copilot adapter (the
  `vscode.lm` path), the `copilot` provider value and `copilot:<model-id>` model ids are gone. The
  shipped profiles, first one wins for **Auto**, are **DeepSeek Flash** (`deepseek-flash`, 1M context,
  tools, vision), **DeepSeek V4 Pro** and **Gemini 3.8 Flash** (Gemini's OpenAI-compatible endpoint).
  The wizard ends with a **⚙ Configure a provider…** row in the menu. A chat that still remembers a
  `copilot:…` model keeps working on the first profile and says so once, in the transcript.
- **Keys are detected from the environment**: a profile's `keyEnv` may name one variable or a list
  (`DEEPSEEK_API_KEY` for both DeepSeek profiles, `GEMINI_API_KEY` / `GOOGLE_API_KEY` for Gemini),
  tried in order before the OS keychain, and the model menu says `no key — set DEEPSEEK_API_KEY` on
  any profile it found nothing for. The missing-key error names the variable too.
- **`/cost` is real for DeepSeek**: the shipped profiles carry the list rates from the DeepSeek
  pricing page (peak cache-miss input, cache-hit input, output), the adapter reads
  `prompt_cache_hit_tokens`, and cached input is billed at its own much lower rate — so the estimate
  is an upper bound instead of $0.000.
- **Reasoning no longer breaks DeepSeek tool loops, and the Reasoning pill actually switches
  thinking**: `reasoning_content` is passed back with the messages (DeepSeek requires it whenever a
  request carries tools — the previous "never echo it" behaviour would have failed the second round
  of every tool loop on V4, and the token context form now keeps reasoning too), `none` sends
  DeepSeek's `thinking: {type: "disabled"}` or Gemini's `reasoning_effort: "none"` per profile
  (`thinkingOff`), and `low`/`medium`/`high` are forwarded as `reasoning_effort`.

- The transcript is now organized in **turns**: one prompt plus every step the agent took for it
  (thoughts, text, tool calls) in the order they happened, no matter how many model rounds were
  needed. A turn streaming live and the same turn after a reload are drawn by the same renderer, so
  the layout no longer changes on refresh (previously one reply could become several bubbles, and the
  live order of steps was lost). Each turn closes with a dated footer — *Worked for 12s · 3 tools*,
  *Working…* or *Stopped* — and the copy / fork / regenerate row moved from every reply bubble to the
  turn. The per-reply Rendered / Token / Raw tabs are gone: the **Display** pill (👁) is the single
  control for how the whole transcript is drawn.
- Forking now cuts at a turn boundary instead of a message, so a forked chat can never contain a tool
  call without its result (which used to make the next request fail with a 400), and regenerating is
  validated against the last turn.
- Messages carry a timestamp, which is what lets a turn show how long it worked.

- The chat now lives in the Secondary Side Bar on the right (Cursor-style): **Comonad: Open
  Chat** reveals the `comonad.chat` webview view. The `⧉` button and **Comonad: Open Chat in a
  New Window** still open the standalone editor panel (`comonad.chatWindow` pops it out).
- The composer is now the Comonad send-bar: Work mode, Approval, Context and Network pills beside
  the model picker, with pending changes listed above the input. The Comonad status-bar items were
  removed.
- The Context pill decides what this chat sends back and is stored per chat (new chats start from the
  Context setting; replies start from the Display setting).
- The model pill is now a Cursor-style menu: **Reasoning** effort (sent as `reasoning_effort` to
  OpenAI-compatible profiles), a **Context** token budget
  that trims whole turns from the model input, and the **Model** list — all stored per chat and
  seeded from the new `comonad.reasoningEffort` / `comonad.contextLimit` settings.
- The chat header is now a Codex-style top area: the Comonad tile and name, a **Chats** row with
  **history** / **settings** / **new session** icons, and the three most recent chats with their age
  plus **View all (n)**. Clicking a row resumes that chat, the history icon folds the list, and
  `comonad.newSession` is bound to `Cmd+N` (`Ctrl+Alt+N` off macOS) while a Comonad surface has focus;
  it no longer shows a notification.
- Chats that are created but never used are no longer written to disk: they stay in memory until the
  first message, so empty “New session” entries no longer pile up in the Chats list, the sessions
  view or the `View all (n)` count. Unused chats left behind by earlier versions are pruned on the
  next activation.
- The Chats card can search the history: the field matches titles **and** message text (newest chat
  first, with the matching line shown under the title), `Esc` clears it, and switching to a result
  continues that chat.
- Every message has a Cursor-style action row: **copy** (the button flashes a check), **fork** — a new
  chat holding the same conversation up to and including that message — and **regenerate** on the
  newest reply, which drops the answer it gave and runs the last prompt again.
- Forked chats are numbered instead of stacking “(fork)”: the first fork of *你好* is **你好 (fork 1)**,
  the next is **你好 (fork 2)**, and forking a fork keeps counting the same series. Chats left with
  `(fork)` titles by earlier versions are renumbered on the first start.
- The send-bar has a **Display** pill (👁) that sets how the whole transcript is drawn: changing it
  re-renders every turn at once and writes `comonad.displayForm`. The **Context** pill takes the same
  three values, so both now lead with an icon (↑ sends, 👁 displays) to tell them apart.
- The chat header is now one compact row, like Codex: the Comonad tile and name row above the
  **Chats** row is gone, the header padding is halved and the recent-chats card is shorter — the
  history icon still folds the list away.
- The chat's own controls moved into the panel title bar, beside VS Code's: a new
  **Comonad: Recent Chats** command (also contributed to `editor/title` for the popped-out panel),
  plus **Settings** and **New Session** which now carry codicons. The webview therefore has no
  header row of its own — the recent-chats list is the only thing that can appear above the
  transcript, it starts folded away, and it closes on a click elsewhere, `Esc` or focus loss.
- The recent-chats list folds away as soon as you click anywhere else — the transcript, the
  composer, another panel — or press `Esc`, like the pill menus do.
- The settings panel is now the tabbed form from the design: **Graph / Agent / Rules / Flow / MCP /
  Tools** with **Save** and **Close** in the header, labels above full-width controls, and a directory
  picker on the working directory. **Graph** puts the Mermaid source beside a live preview with Max
  steps and the parsed Nodes / Routes; **Agent** exposes the policy surface (model, work mode,
  approval, display, context, network, working directory, command timeout, plan directory, deny read
  paths); **Rules** edits the `comonad.permissions` allow / ask / deny lists as three textareas (one
  rule per line, checked with `parseRule` before saving);
  **Flow** draws the whole tool-call gate as a Mermaid diagram: the work-mode, network and workspace
  checks run first, then two dashed frames — **your rules** (deny / ask / allow) and the **approval
  policy**, whose five settings are each a node of their own — with the built-in unsandboxed /
  dangerous-command escalation between them, and every gate ending in its own coloured
  **Rejected** / **Asks you** / **Runs** node beside it, so no edge runs back across the chart; generated from the policy tables, with the modes' capabilities as a legend above it; the graph is validated while you type, the last tab is remembered, and the panel only
  writes when you save. New `comonad.planDirectory` setting decides where plan files live.
- The white- and blacklist approval policies are no longer tied to read vs write in the code — the
  lists are. `whitelist_accept` runs the calls named by `comonad.permissions.allow` plus the
  read-only default (the capabilities `ro`, `shell_ro`, `rw_plan`) and asks for the rest;
  `blacklist_reject` rejects the write-capable calls by default (the capabilities `rw`, `shell_rw`,
  `rw_plan`) plus whatever `comonad.permissions.deny` names, and runs the rest. Your own deny rules
  still always win and allow rules still always run, in every policy.
- Work modes are now five and named after what they allow: **Chat Only** (`chat`, no tools at all),
  **Read-Only** (`ro`), **Semi-Write** (`sw`, writes files but the shell stays read-only),
  **Full Access** (`aw`, full shell) and **Plan** (`pl`, writes plan files only). The labels spell
  out exactly the capabilities in `MODE_CAPS` (a test pins both), the mode picker and the sessions
  view show the readable name, and the "Full access" preset was renamed **Unrestricted** so it can no
  longer be confused with the Full Access mode.

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