# Change Log

All notable changes to the "comonad" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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
    it carries on, an impersonation is recorded as *your* message, and a quiet generation leaves no
    trace in the chat.
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
  `Comonad: Pick Persona` and `Comonad: Pick Prompt Preset` join the palette. The composer's
  character pill shows the chat's character, persona, book count and preset, and the **◈ lore** chip
  reports the entries the last turn injected.
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
  the model picker, plus a chip for pending changes that opens the review. The Comonad status-bar
  items were removed.
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