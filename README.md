# Comonad Agent for VS Code

A local-first, auditable coding agent inside VS Code. It runs a graph-orchestrated tool loop
against the model you choose — DeepSeek by default, or any OpenAI-compatible endpoint — keeps every turn in a
shadow-git checkpoint, and asks before anything leaves the sandbox.

The kernel — graph runtime, capability model, approval policies and checkpoint design — comes from
an earlier Comonad project; the interaction layer is rebuilt for VS Code: Chat participant, language
model API, diff editors, tasks and terminal sandbox.

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

## Remote SSH, WSL and Dev Containers

Comonad is a workspace extension: in a remote window VS Code installs it on the remote host and the
agent runs there, beside the files, shell, git, MCP servers and hooks it drives. That is the same
split Cursor (remote server) and Copilot (workspace extension) use — the work happens remotely, the
window only renders it. No local-agent split is involved.

- **Credentials stay on your machine.** API keys are stored with VS Code's `SecretStorage`, which is
  client-side even for a remote extension: the key is encrypted by your local OS keychain and is not
  written to the remote workspace or `~/.vscode-server`. It is read into the remote extension host's
  memory when a request is made. A stored key belongs to the **endpoint** (its normalized base URL),
  so every profile that points at that endpoint shares it — the two shipped DeepSeek profiles need
  one key, not two. `keyEnv` is the exception — it reads the **remote** environment.
- **Model calls originate from the remote host.** A profile whose base URL is `localhost` points at
  the remote machine. To reach a model server on your own computer, forward it in `~/.ssh/config`:

  ```sshconfig
  Host devbox
    HostName devbox.example.com
    RemoteForward 11434 127.0.0.1:11434
  ```

  then use `http://127.0.0.1:11434/v1` in the remote window. (**Comonad: Configure Model** warns
  when a loopback base is saved remotely.)
- **Sandboxing degrades visibly.** Linux uses `bwrap`, macOS `sandbox-exec`. When neither is
  available — common on servers and on Windows — `/status`, the chat and the settings panel say
  `no OS sandbox`, and every shell call asks for approval even under an accept policy. Install
  bubblewrap on the remote or set `comonad.allowUnsandboxedShell` to skip that prompt.
- **Everything else is remote too.** Sessions, audit logs, checkpoints and tokenizer files live in
  the remote extension's global storage; MCP servers and hooks spawn on the remote; multi-root
  workspaces still use the first folder as the working directory.

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
Cursor-style menu: **Reasoning** effort (thinking strength), a **Context window** in tokens, and the
**Model** list — all remembered per chat, with new chats starting from `comonad.reasoningEffort` and
`comonad.contextWindow`. **Auto** takes the window from the model's profile, which is the only setting
that stays right when the model changes; the fixed sizes override it for a model whose window is not
what its provider documents. The two pills that list Rendered / Token /
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
slow call shows its cost instead of only a spinner. A shell tool card, expanded, shows the whole
command first — highlighted, with a Copy button — and the command's output underneath. Fenced code
blocks are syntax-highlighted for highlight.js's common languages (Python, JavaScript/TypeScript,
JSON, shell, C/C++, Java, Go, Rust, SQL, Markdown, …) with theme-aware token colors; Copy still
copies the code source, not the markup. Each turn ends with a dated footer — *Worked for
12s · 3 tools*, or *Working…* / *Stopped* — and carries the action row, Cursor-style: **copy** (the answer,
or the raw record in Raw), **fork chat from here** (a new chat with the same conversation through
the end of that turn) and, on the newest turn, **regenerate** (drops that answer and runs the
prompt again; when that turn or a later one wrote files, it asks whether to restore them too). A
user prompt also carries a **pencil**: it turns the bubble into an editor and resends it. Sending
discards that turn's reply and every later turn; when the agent wrote files since then, the editor
also offers **Restore files too**. Because the fork point is always a turn boundary, a forked chat
can never hold a tool call without the result that answers it. The agent's pending changes are
listed above the composer — file, `+N −M`, with **Undo / Keep / Review** at the top; clicking a row
opens the file itself, with the inline review's blocks and Keep/Undo actions. Once everything is
reviewed, the list stays on screen as a **reviewed** list (no actions); as soon as a new change is
pending, it switches back to showing only the pending files.

**Reference code with `@`.** Type `@` in the composer to open a picker — **Files**, **Folders**,
**Symbols**, or **Current selection**. Choosing one inserts a token in Cursor's format:

```
@src/auth.ts              whole file
@src/auth.ts:9-13         lines 9–13
@src/lib/                 folder overview
@symbol:src/auth.ts:AuthService
@"a file with spaces.md":3-8
```

Select code in an editor and press **Cmd+L** (`Ctrl+L`) to append its token to the chat composer
without leaving the editor; the same command is under the editor context menu as **Comonad: Add
Selection to Chat**. The token stays in the prompt text (you can edit it by hand), is painted as a
chip in the transcript, and is resolved when the turn runs: the referenced content is added to that
turn's context with numbered lines, capped at 20k chars per reference and 60k in total and filtered
by the session's read confinement and deny rules. References are resolved again on regenerate and
on edit-and-resend; a missing or denied reference becomes a small error note instead of failing the
turn. Automatic discovery still belongs to the agent's `find_files`, `find_symbols` and
`grep_files` tools.

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

Keys are data, not code, and a key belongs to the endpoint rather than to the profile that was on
screen: once stored, every profile whose `base` normalizes to the same address uses it. A key saved
under an older profile id is still found through a sibling profile on that base. With no stored key,
a profile reads the variables it names (`keyEnv`, in order), then those of a sibling on the same
endpoint. The menu marks a row whose endpoint has no key with `no key — set DEEPSEEK_API_KEY`, and
picking it offers the provider wizard instead of failing the next turn. Nothing in the extension
knows a provider's name except the shipped profile data.

- **Comonad: Select Model** lists the profiles plus **Auto** (the first one); the menu's last row
  opens the provider wizard.
- **Comonad: Configure Model Provider** adds any OpenAI-compatible endpoint: base URL, model name and
  key (leave the key empty to keep reading the environment or to reuse a key already saved for that
  endpoint).

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
back, so Comonad passes it along (endpoints that do not know the field ignore it). Gemini 3 goes
further — every function call comes back with a `thought_signature` and the *next* request is refused
without it — so the signature is kept on the call (it travels with the chat) and handed back the same
way; a call that has none carries Google's own `skip_thought_signature_validator` bypass rather than
losing the turn.

## Content layer (characters, lore, personas, presets)

The agent can wear a character. Content lives in **Comonad's own library** —
`.comonad/{characters,lorebooks,presets,personas}` in the project plus `~/.comonad/…` for the user —
written in **SillyTavern's file formats**, so a card, book, persona or preset can be moved between
the two tools. The layer is **not built into Comonad**: it is a plugin package that ships beside the
bundle, and it does nothing at all until you install it — **Settings → Plugins → Install… →
SillyTavern content (ST)**, one click that copies it into `~/.comonad/plugins` and writes its row into
your `cordis.yml` ([Installing a plugin](#installing-a-plugin)). With the row loaded and the content
layer on, **every turn is assembled by the ST layer** — with no character, persona, book or preset
selected it uses the built-in **Default** collection, so the takeover is complete from the first
turn. With the row off, or the plugin never installed, a turn is a plain request and the ST tab and
its commands are simply not there. It is all managed in one place: the settings panel's **ST** tab
(`Comonad: Manage Content` or the book icon in the chat's title bar), whose sub-tabs are
**Characters / World books / Personas / Presets / Settings**. Create,
edit, duplicate and delete every kind, then use it in this chat or make it the default for new chats.

- **Characters.** Cards are read as PNG (`chara` / `ccv3` chunks) or JSON, all three card versions,
  and written back in the same shape — a PNG card keeps its picture, a JSON card stays JSON. The
  editor covers the whole card: description, personality, scenario, first message and alternates,
  example messages, system prompt, post-history instructions, creator notes, tags, the depth prompt
  and `extensions.world` (a world book the card binds, scanned without being listed) — plus the fields
  upstream keeps outside the V2 spec: the **favourite** star (`fav`, written at the V1 root and under
  `extensions`), **talkativeness**, the **create date** and the **source link**. **Choose picture…**
  gives the card a picture, and since upstream keeps a card *as* its picture, that writes the card as a
  PNG beside it — which is also why the list shows each card's picture, and its ★. The list has
  **search**, an **order** (name A-Z/Z-A, newest, oldest), a favourites filter, a grid view, paging
  and avatars. The **More…** menu is upstream's own: *Import Card Lore* (the book the card carries
  becomes a library world book, and the card is linked to it), *Convert to Persona*, *Rename* (the
  file, the tag key, persona connections, the default character and open chats all follow), *Link to
  Source*, *Import cards…*, *Export JSON…*, and *Export PNG…* writes a shareable card.
- **World books.** The page is SillyTavern's own *Worlds/Lorebooks* panel, in its shape: **Active
  World(s) for all chats** and the global activation knobs on top (scan depth, context %, budget cap,
  min activations, max depth, max recursion steps, insertion strategy, include names, recursive scan,
  case-sensitive, whole words, group scoring, *alert on overflow*, *automation*, and the vector
  settings), then the book toolbar (**Create** — which asks for the name, as *Rename* does — *pick /
  Import / Export / Rename / Duplicate / Delete*), then the entry list — **search** (Fuse.js
  over keys, group, title, secondary keys, body, uid and automation id, ignoring where in the text a
  match sits, with `'exact` and `!not` understood) **sort** (priority, custom, title, size, depth,
  order, uid, trigger %) and paging, with **drag-to-reorder** under the *custom* sort and *Apply
  sorting as Order* to write that order into the entries. Every row unfolds into the full editor:
  primary keywords (**chips**, with a ✨/⌨️ switch to the plaintext list), secondary keys and their
  logic, the optional filter, outlet name, per-entry scan depth, case/whole-word/group-scoring
  overrides, recursion level, content with its **token count and uid**, the four recursion/budget
  flags, inclusion group and weight, *Prioritize*/*Sticky*/*Cooldown*/*Delay*, the entry state
  (**🟢 Normal / 🔵 Constant / 🔗 Vectorized**), an **Automation ID** (offered from the ids the other
  entries use), **Filter to Generation Triggers** (*Normal, Continue, Impersonate, Swipe, Regenerate,
  Quiet*), the character-or-tag filter (the library's characters, and the tag registry's tags by id),
  *Selective*/*Use Probability*/*Add Memo*, and the *Additional Matching Sources* drawer. There is no
  Save button: the pane holds the book and writes it back as you type. Files are written the way
  SillyTavern writes them, with the camelCase names at the root mirrored under `extensions` and the
  character filter under its own `character_filter` key.
- **Tags.** The tag registry lives in `.comonad/tags.json` (project over user), in SillyTavern's own
  shape: `{tags: [{id, name, color, color2, folder_type, sort_order, …}], tag_map: {<character id>:
  [tag id]}}`. Tags are referred to by **id** everywhere — an entry's character/tag filter stores
  ids, so renaming a tag never breaks a filter. The **Characters** tab shows a character's tags as
  chips above its fields, with an *Add* box that accepts a new name, *Manage tags…* (create, rename,
  colour, folder type, hide-on-card, delete, and delete-merge into another tag, plus *Prune unused*)
  and *Import card tags*, which reads the card's own `tags` field the way upstream does: the
  generator tags (`ROOT`, `TAVERN`) are skipped, at most 50 at a time, names are matched case- and
  accent-insensitively, and `comonad.tagImportSetting` decides between asking, importing everything,
  only what already exists, or nothing.
- **How a turn is generated.** The ▾ beside *Send* offers SillyTavern's six generation types, and
  each is a real generation: **Normal** answers the box, **Continue** carries the last message on
  (one message, no new prompt), **Impersonate** writes your next message for you — it streams into
  the box, for you to edit and send yourself, exactly as upstream's own button does, **Swipe** adds
  another version of the last reply, **Regenerate** runs the last
  prompt again, and **Quiet** generates without writing anything to the chat. An entry limited to a
  generation type only fires for those. Replies keep their versions: `‹ n/m ›` on the turn walks
  them, and a regenerate only overwrites the very first version — after that it adds one, as
  upstream does. `/continue`, `/impersonate`, `/swipe`, `/regenerate` and `/quiet [text]` are the
  same thing from the keyboard.
- **Personas.** The page is SillyTavern's *Persona Management*: the avatar tiles on the left (create,
  search, A-Z / Z-A / search order, paging, grid toggle, and the upload tile that makes a persona out
  of a picture) and the open persona on the right — name, title, picture, description with a live token
  count, where the description goes (**None (disabled)** first, which is upstream's own order: the
  persona still names you, its description is left out), depth and role, the three locks (*Default*,
  *Character*, *Chat*) with the connection list, the world book it scans, and the three persona-wide
  settings (`comonad.personaAutoLock`, `comonad.personaAllowMultiConnections`,
  `comonad.personaShowNotifications`). It saves as you type, the way upstream's does. Connections are
  stored in upstream's
  `{type, id}` shape, so a **Backup** made in either tool restores in the other — and a connection
  written `Kestrel.png` matches the card Comonad calls `Kestrel`. **Duplicate** copies the persona and
  its picture; **Convert a character…** makes one out of a card, swapping `{{char}}`/`{{user}}` if you
  say so; deleting a persona takes its picture with it.
- **Presets.** A chat-completion preset is the whole of upstream's OpenAI settings, edited in the
  **Presets** tab: a block is **saved before it is inserted** — the **Prompt library** is one entry box
  whose small button switches between **Built-in** (shared by every preset) and **Custom**
  (this preset's own), with a picker and **+ New** / **Insert**; *Insert* copies the picked entry to the
  top of the list, after Comonad's leading blocks, and *+ New* saves one into the library being shown
  with its editor opened in place. The **system library** lives in `.comonad/prompt-library.json`,
  seeded from the eight built-in blocks; a preset's **own library** is stored inside the preset's file,
  so it travels with the preset. Picking an entry opens its editor in the space right below the box,
  with a **Delete** button. The prompt list
  itself follows (switch a block off, move it,
  duplicate it, delete it, restore the shipped list, and **edit any entry** — which opens
  under its own row, as a world-book entry does — its name, its role, the **generation types** it
  fires for, *Relative* / *In-chat @ depth*, its depth and order, its text and **Forbid Overrides**,
  with upstream's own hints and its *Reset* putting a shipped block back; a marker says its text is
  pulled from elsewhere and cannot be edited, as upstream says). Comonad's own blocks — **Identity**,
  **Tools**, **Instructions**, **Memory**, **Todos**, **Skills**, **Sub-agents**, **Lore index** and
  **Context** — are rows in this same list: their text is generated for every turn, so the editor
  shows it read-only (the current text is also in the **Prompts** tab), while their place and switch
  are ordinary preset state. The single **Tools** row is the request's tool switch: definitions still
  travel beside the request in the API's `tools` parameter, and with the row off no tools are offered
  and a call is refused before it runs. The order —
  including **an order per character**, which is used for the character it names — the samplers, the
  formats (`wi_format`, `scenario_format`, `personality_format`, `impersonation_prompt`,
  `names_behavior`, `assistant_prefill`, `squash_system_messages`), the six **nudge prompts** (the
  history is headed by *New chat*, a history ending on a reply is filled by *Send if empty* as the
  user, and a continue carries *Continue nudge*, `{{lastChatMessage}}` and all), `seed`, a
  **logit-bias** set to send, and `stream_openai` / `max_context_unlocked` / `use_sysprompt`. Only what
  a preset sets is sent, and only what a chat-completions endpoint understands: the fields it does not
  (`top_k`, `top_a`, `min_p`, `repetition_penalty`, `stream_openai: false`) say so in their own hint
  rather than being dropped silently. **Import…** takes a preset from anywhere, **Export…** writes it
  out as SillyTavern reads it, and **five templates ship with Comonad** — *Default*, *Balanced*,
  *Creative*, *Precise*, *Long-form* — which copy themselves into the library when you pick one, where
  they are ordinary presets. *Default* is the collection an unselected chat already uses: picking it
  writes an editable copy, and loading the plugin itself writes nothing. *Update current preset* is the
  tab's own Save button.
- **Takeover.** With the layer on, every user-facing turn is assembled by the ST collection:
  Comonad's generated blocks, the character, persona and world books, the preset's prompts and the
  conversation. Comonad's blocks are preset rows like any other — move them, switch them off, or read
  their current text in the preset editor and in the **Prompts** tab. With no preset selected the
  built-in **Default** is used; *Start from Default* makes an editable copy. Subagent, summary and
  chooser calls are not chat turns and keep their own shape.
- **Runtime.** A chat can pick a character (its opening line — or an alternate — is inserted as the
  first turn and pinned when the history is trimmed), books (scanned every turn for keywords, with
  the scan depth, budget, cap, recursion, groups, sticky/cooldown/delay and per-entry positions all
  honoured, and an entry's generation type and character/tag filter decided before it can activate),
  a persona and a
  preset (whose samplers override the profile's). The **◈ lore** chip
  above the composer lists what the last turn injected, and `lore_lookup` lets the model search the
  books on demand — read-only, it never changes what the next turn injects. When the budget stops the
  scan, *Alert On Overflow* says so once per chat. **Exact counts:** the token counter is the model's
  own — tiktoken for the GPT families, and SillyTavern's own tokenizer files (downloaded or read from
  a SillyTavern checkout, see `comonad.tokenizerDir`) for Claude, Gemini, Llama, Mistral and the
  rest — with upstream's `+6` message framing on top.
- **Vectorized entries.** With `comonad.wiVectorEnabled`, an entry whose state is 🔗 **Vectorized** is
  found by meaning instead of by its keys: the newest `wiVectorQuery` messages of the chat are
  embedded by an OpenAI-compatible `/embeddings` endpoint (the chat's profile, or
  `comonad.wiVectorProfile`), compared by cosine similarity against each entry's own vector, and the
  best `wiVectorMaxEntries` above `wiVectorThreshold` are injected. Vectors are cached per book and
  model under the extension's storage, keyed by a hash of the entry's text, so an edited entry is the
  only thing re-embedded. Nothing here can cost a turn: with no endpoint, or an endpoint that will
  not answer, the scan runs on keys alone.
- **Automation.** An entry's **Automation ID** runs what it names when the entry activates: the
  `WorldInfoActivated` hook, then a slash command of that name (a built-in, or one of your own
  `.comonad/commands/*.md`). Once per turn, not once per entry, and off unless
  `comonad.wiAutomation` is on — a name is all it takes to run a command.
- **Macros and regex.** `{{char}}`, `{{charIfNotGroup}}`, `{{user}}`, `{{persona}}`, `{{scenario}}`,
  `{{lastChatMessage}}`, `{{time}}`, `{{random}}`, `{{pick}}`, `{{roll}}`, `{{outlet::Name}}` and
  friends are substituted in every block; regex scripts (from `comonad.tavern.regex` or the card) run
  on the prompt and on replies with SillyTavern's placement/depth rules. An entry whose position is
  *outlet* is never injected where it sits: `{{outlet::Name}}` is how its text lands, and the outlet
  name is what ties the two together.

Licensing note: Comonad's content layer re-implements SillyTavern's file formats and prompt assembly.
A few small utility routines — regex substitution, persona macro swapping, world-info search weights
and tag constants — are adapted from SillyTavern, which is AGPL-3.0; see [NOTICE](NOTICE) for the
file-by-file record. SillyTavern itself is not bundled, and its default content is never copied.

## Chat commands

| command | purpose |
| --- | --- |
| `/plan [task]` | research read-only, then write a plan file |
| `/review [focus]` | review pending changes without editing |
| `/summarize [notes]` | summarize the conversation to free up context (`/compress` and `/compact` are aliases) |
| `/clear`, `/new` | start a fresh session |
| `/fork` | fork this session and keep exploring in a fresh one |
| `/context` | window, budget breakdown and how full the window was on the last request |
| `/status` | mode, model, workspace, sandbox and usage |
| `/cost` | token usage for today and the session |
| `/permissions` | mode capabilities and permission rules |
| `/model` | switch the active model |
| `/continue` | carry the last message on from where it stops |
| `/impersonate` | write your next message for you |
| `/swipe` | generate another version of the last reply |
| `/regenerate` | generate the last reply again |
| `/quiet [text]` | generate a reply without adding it to the transcript |
| `/init` | create a `COMONAD.md` project instruction file |
| `/export` | export the session as markdown |
| `/resume` | resume a suspended (waiting for approval) turn |
| `/char [name]` | pick the character this chat speaks as (inserts its opening line) |
| `/persona [name]` | pick who you are in this chat |
| `/lore [names]` | pick the world books this chat scans (`/lore none` clears) |
| `/preset [name]` | pick the prompt and sampler preset |
| `/note [text]` | set or clear the chat's standing author's note |

Custom commands are markdown files under `.comonad/commands/*.md` with optional frontmatter
(`description`, `argument-hint`, `allowed-tools`, `model`). Bodies support `$ARGUMENTS`,
`` !`shell` ``, and the same `@` references the composer uses (files, folders, symbols and line
ranges).

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
   "Always allow" adds an allow rule. **Stop** — the composer button or Esc — cancels the running
   turn for real: a foreground shell command is killed with its process tree, a pending approval is
   withdrawn and denied, and the composer is free again. Background tasks started with `start_shell`
   are independent and keep running; stop them from the Tasks view or with `stop_shell`. Sending
   while a turn is running shows a notice and keeps the draft instead of dropping it.

Shell commands run under `sandbox-exec` (macOS) or `bwrap` (Linux). The workspace boundary is set by
pair of settings: **`comonad.confineWrite`** (on by default) keeps writes inside the working
directory, and **`comonad.confineRead`** (off by default) does the same for reads. Both apply to the
file tools and to the shell sandbox, so a path the model names and a path a command touches meet the
same rule; turning read confinement on also hides files like `~/.gitconfig` and `~/.npmrc` from `git`
and `npm`. The file tools resolve symlinks before checking containment, so a link inside the workspace
cannot reach outside it. A write-confined shell gets a writable scratch directory at
`<working directory>/.comonad/tmp` with `TMPDIR` pointing at it, so `mktemp`, test runners and package
managers keep working without reaching outside the boundary; a read-only shell can write no temp
files at all. The settings panel's **Agent** tab
saves each control as it changes; because a running turn keeps the policy it started with, a change
takes effect from the next message. Shell commands and tasks search the login shell's `PATH` as well
as the extension host's. Foreground shell calls take an optional model-chosen `timeout` in seconds,
clamped to 1–300; `comonad.commandTimeout` is the fallback, and **Always use the command timeout**
replaces the model's choice with that fixed value. `start_shell` tasks have no timeout. Network is
off by default, but loopback TCP and UDP stay available on both
sandboxes, so test servers that listen on `127.0.0.1` work; only traffic that leaves the machine is
blocked. `.env` files are denied to both reading and writing. Commands shaped like `rm -rf`, `sudo`, `curl | sh`, `git push --force` and friends always
prompt, even under accept policies. Cleaning up its own work is the exception: a literal,
non-recursive `rm` whose every target is inside the workspace and recorded as created by this session
— file-tool writes, plus `touch`, `>`/`>>` and `tee` from its shell commands, verified by a
before/after check — runs without that prompt. Recursive deletes, globs, variables, symlinked parents
that resolve outside the workspace, and anything the scanner cannot prove still prompt. Secrets (API keys, tokens, passwords) are stripped from the
environment of commands and tasks unless `comonad.filterSensitiveEnv` is disabled, and `.git` is
never writable by file tools. When no OS sandbox is available — Windows, or a Linux/macOS host
without `bwrap`/`sandbox-exec` — every shell call asks for confirmation even under an accept policy.
`comonad.allowUnsandboxedShell` opts out of that extra prompt; tools named `*_unsandboxed` always
ask. Presets combine all three layers: **Ask**, **Plan**, **Auto**, **Read only**, **Full access**
(**Comonad: Select Preset**; `comonad.allowFullAccess: false` hides the unrestricted preset, and
**Full access** is the one preset that drops the workspace boundary).

## The context window

A request carries more than the conversation: a system prompt, the definitions of every tool the turn
may run, and whatever the tavern layer composes. Those are paid for out of the same window, which is
why a `128K` model does not hold 128K of chat. Comonad subtracts both before deciding whether the
conversation fits.

The window itself is data on the model profile (`contextWindow`), so **Auto** in the model menu
resolves to whatever the current model actually is; the fixed entries override it for an endpoint
whose window is not what its provider documents. A model with no window configured falls back to
128K and says so in `/context` rather than pretending to know.

**Past the window, older turns are folded into a summary — not cut.** The newest request is kept word
for word, the summary is written into the chat itself where you can see it, and a second summarization
extends the first instead of starting over. Three things follow from that being the only mechanism:

- A turn that outgrows the window mid-flight is handled in two steps, cheapest first: old tool output
  is elided, and only a request that still does not fit has the turns before it folded away. The
  current turn is never folded — it is what you just asked for.
- A summary that fails changes nothing. The conversation stays exactly as it was and the turn is
  answered from it, because losing the record would be worse than a refused request.
- **Restore points follow the summary.** Compacting replaces turns, so the restore points that sat
  inside them cannot be honoured and are dropped; the rest keep naming the same message they always
  did. After a compaction the earliest point to restore to is the summary itself.

A request the endpoint refuses as too long — the case the estimate cannot predict — is retried once
after being shrunk hard, so a mis-sized window costs a retry rather than the turn.

## Checkpoints and review

Comonad journals each file the agent writes, one entry per write, in a shadow store outside your
project (`globalStorage/checkpoints/...`). **It is a row of the shipped tree** — on by default,
because an irreversible write is a worse default than a shadow repository — and one `cordis.yml` line
turns it off when the disk costs more than the safety is worth ([Plugins](#plugins)). Nothing is
snapshotted on every turn: a turn that writes no file costs nothing, and the review only looks at the
files the journal names. Your own `.git` is never touched.

- **Changes made by shell commands (`run_shell`) are not tracked.** Review those with git. This is
  the same limit Claude Code and Cursor have: a shell can change any file, and the journal only
  knows what the agent's own write tools wrote.
- A file you have edited since the agent last wrote it, or one open with unsaved text, is never
  overwritten silently: the review asks, or refuses until you save.
- Shadow stores from the earlier snapshot design are removed when the journal is mounted. Their
  sessions keep their transcripts, but cannot be restored to an earlier file state.
- **Editing a prompt can restore files.** Edit a user prompt with the pencil and resend it; if the
  agent wrote files at or after that turn, the editor offers **Restore files too**, with the same
  dirty-editor and outside-change checks as undo. **Regenerate** asks the same question about the
  last turn.
- **Pending changes sit above the composer.** The list shows each file with its `+N −M` counts;
  **Undo** and **Keep** act on all of them, and a row opens the file in the normal editor with the
  inline review (the separate Comonad diff tab is still offered by **Show Diff**). With nothing
  pending, the list shows the files already reviewed, newest decision first; a new pending change
  takes the list back.

- **Comonad: Review Pending Changes** — open a diff, keep/undo a file or a single hunk, or keep/undo everything.
- The journal's commands (with `Cmd+Alt+D`) are declared in Comonad's manifest behind
  `enablement: comonad.checkpoints`: the palette and the keybinding offer them while the row is
  loaded, and a window without the row has nothing to click rather than something that fails.
- `Cmd+Alt+.` stops a turn, `Cmd+N` starts a new session while a Comonad surface has focus.
- Right-click a session in the Comonad view to rename, delete or fork it; sessions fork with a
  a numbered fork title (`Title (fork 1)`, `Title (fork 2)`, …) and a fresh checkpoint identity. The **Tasks** view lists background commands
  with output preview and a stop action. Select code and use the lightbulb or editor context menu
  to *Explain* or *Fix* it with Comonad.

## Extensibility

| mechanism | location | notes |
| --- | --- | --- |
| instructions | `COMONAD.md`, `AGENTS.md`, `.comonad/instructions.md` | hierarchical, trusted workspaces only |
| rules | `.comonad/rules/*.md` | loaded into the system prompt |
| skills | `.comonad/skills/<name>/SKILL.md` | listed in the prompt, loaded on demand via the `skill` tool |
| subagents | `.comonad/agents/*.md` | frontmatter: `tools`, `disallowedTools`, `model`, `maxTurns`; built-ins: explore, plan, review |
| commands | `.comonad/commands/*.md` | custom slash commands |
| hooks | `.comonad/hooks.json` (project), `globalStorage/hooks.json` (user) | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`; handlers: `command`, `http`, `mcp_tool`, `prompt`; JSON decisions: `permissionDecision` deny/ask/allow, `additionalContext`, `updatedInput`; exit code 2 blocks |
| MCP | `comonad.mcpServers` | stdio (`command`,`args`,`env`) or streamable HTTP (`url`,`headers`); per-server `capability`, `writeTools`, `exclude`, `overrides` |
| memory | agent-owned `MEMORY.md` under global storage | loaded into the prompt, editable via the `memory` tool |
| plugins | `cordis.yml` in `.comonad` (project) or `~/.comonad` (user) | every feature is a row: turn one off, configure it, or mount your own; [Plugins](#plugins) |

### Plugins

**A plugin is what a feature is.** The storage layer, the tools and the panels are rows in
`cordis.yml`, and so is anything you write — including features Comonad ships but does not build in,
like the ST content layer:

```yaml
# .comonad/cordis.yml — an installed plugin of Comonad's own, one of mine off for now, one on.
- { id: comonad-plugin-tavern, name: ./plugins/comonad-plugin-tavern/dist/index.js }
- { id: mine, name: ./mine.js, config: { greeting: hello } }
- { id: scratch, name: ./scratch.js, disabled: true }
```

A `name` that is a path is read as a file: `./x` and `../x` relative to the `cordis.yml` that names it, `~/x` from your home folder, and `/abs/x` as it is. Any other name is a package.

```js
// mine.js — a policy and a tool, both of them effects of the plugin
export const name = 'mine';
export const inject = ['tools']; // declared, never inferred: cordis refuses what it was not asked for

export function apply(ctx, config) {
	ctx.on('tools/pre-execute', (exec, next) =>
		exec.name === 'run_shell' && /rm -rf/.test(String(exec.arguments?.command ?? ''))
			? { kind: 'deny', reason: 'not that command' }
			: next(),
	);
	ctx.tools.register({
		name: 'hello',
		description: 'Say hello.',
		capability: 'ro',
		needsNetwork: false,
		needsWorkspace: false,
		parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
		execute: async () => config.greeting,
	});
}
```

**Settings → Plugins** is that list, live: every row in load order, where it came from (the extension,
this workspace's `cordis.yml`, or yours), what it resolved to, and what became of it — `loaded`, `off`, or
`not loaded` with the reason in the tooltip (`pending: waiting for tools`, or the error the plugin threw).
**Disable**/**Enable** writes the change into the workspace's list when the workspace is trusted and into
yours when it is not, and applies **that row** again — not the whole tree, so the panel you are clicking
in stays where it is. **Uninstall** takes a row that is not built in away entirely — that is
[Installing a plugin](#installing-a-plugin), undone. A row that others inject takes them with it: they
go inactive and say what they are waiting for (`pending: waiting for tavern`), and come back when it
does. The file that changed is named above the table, and a `cordis.yml` you edit by hand is applied in
full as soon as it is saved — the host can tell its own write from yours.

What is worth knowing before writing one:

- **Everything a plugin registers goes away with it.** A row that is turned off is disposed, so its tools,
  commands, watchers and panels disappear with it — and a plugin's registrations are only ever its own.
- **Reading a service needs `inject`.** A row that injects something that is not loaded stays *pending*,
  which is what "this feature is off" is spelled out as. The one exception is the host's own list: a row
  reads `ctx.get('plugins')`, because the host is what is mounting it.
- **A feature can be missing.** The journal is reached as `ctx.get('checkpoints')` and the ST layer as
  `ctx.get('tavern')`: with those rows off a turn is a plain `[system, …history]` request, writes are not
  journaled, and the surfaces only they own — the ST tab, `/char`, `/lore`, `/preset`, and the review
  commands the journal registers — are simply not there. A feature can even be missing *as a package*:
  nothing in the shipped tree names the ST layer, so a window that never installed it has no content
  code at all — not even a row to turn off. What the host still names of an absent feature is only its
  vocabulary: the content types as *types* and the session fields it reads.
- **A pane is a plugin's tab.** The settings panel draws the tabs the `panes` service knows: the **ST**
  tab, its markup, its stylesheets, its scripts and its editor are the tavern plugin's own files, loaded
  from its folder. Its settings keys are the pane's too — the panel asks every pane for the keys it owns
  when it saves, so the host's config schema knows nothing about characters or world books.

### Installing a plugin

**Settings → Plugins → Install…** offers the plugins that ship with Comonad by name, and a folder of
your own otherwise (`dist/index.js`, or whatever the manifest's `main` says). An install is two steps
you could take by hand — the folder is copied into `~/.comonad/plugins/<id>` and a row is written into
your `cordis.yml` — and **Uninstall** on the row's line is those two steps taken back, after a
confirmation that names the folder it will delete: the row goes from every list that names it (which
disposes the plugin), the installed folder goes with it, and the modules lent to plugins stay. A row
that was never installed can be uninstalled too — only its row goes, because the files it loads are
yours — and either step can still be done by hand.

```yaml
# ~/.comonad/cordis.yml, written by an install
- { id: comonad-plugin-tavern, name: ./plugins/comonad-plugin-tavern/dist/index.js }
```

**Markdown math (KaTeX)** ships as another optional row. It typesets `$...$`, `$$...$$`, `\(...\)`
and `\[...\]` in assistant replies and command Markdown (code spans and fenced blocks stay literal),
bundling KaTeX, its stylesheet and its fonts in the plugin folder so it works offline. Select
typeset text in the chat and copy it, and the clipboard gets the original Markdown back — formulas
as `$...$` / `$$...$$`, code as fences, emphasis and links in Markdown — while the transcript's own
Copy buttons still copy the exact raw text. With the row off the delimiters simply stay literal.

The library lives in Comonad's home — `.comonad` under your home directory, or under whatever
`COMONAD_HOME` names instead, which moves the whole of it: the plugin library, the harness shims, the
catalog, the instruction layers.

A plugin loaded from the library is handed the platform modules instead of carrying its own copies:
`~/.comonad/plugins/node_modules/{cordis,schemastery,vscode}` are generated bridges into the running
Comonad (the same trick the harness compatibility shims use), so a plugin's `Service` subclass belongs
to the same cordis as the tree's, and `vscode` is the extension host's own module. Write your plugin as
CommonJS or ESM; `require('cordis')` and `import { Service } from 'cordis'` both work.
- **A broken row is reported, not fatal.** `Plugins.state()` names every row that is on and why one is
  not (pending on which service, or the error it threw); the rest of the tree loads anyway.
- **A config is the plugin's own schema.** Export `Config` (a schemastery schema) and the row's config is
  validated before `apply` runs; a config that does not fit is that row's error.

### Seeing the tree: Inspect → Plugins

**Settings → Inspect → Plugins** lists what the tree is wired with, plugin by plugin: what each plugin
**provides** (a service another plugin can inject), the services it **needs** — in a service column and
a provider column: the providing plugin, or `(built in)` for the three services Comonad mounts *before*
the tree (`host`, `log`, `settings`: not plugins, and not switchable), or `not provided` when nothing
does — its layer, and its state (`loaded`, `off`, `waiting` or `failed` with the reason on hover).
Clicking a plugin prints its **dependency tree** — what it stands on, who needs it, and the whole chain
that goes down with it when the plugin is turned off, which is what a toggle is really asking.

### DeepSeek Harness plugins

The `harness` row redirects `@deepseek-ai/*` imports, so a plugin written for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) loads as it is, row and all:

```yaml
- { id: permission-gate, name: ./permission-gate.mjs }
```

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'permission-gate'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', (exec, next) => {
    if (String(exec.arguments?.command ?? '').includes('rm -rf')) {
      return { kind: 'deny', reason: 'Denied by policy.' }
    }
    return next()
  })
}
```

What is implemented is the tool and policy half of the harness: `ctx.tools.register()` (Comonad's specs
and the harness's `ToolDefinition`s, via `defineTool`), `@deepseek-ai/cordis` itself — the same `Service`
and `Context` classes the tree is built from, so a plugin's own service is a service like any other —
`@deepseek-ai/schemastery` schemas, `@deepseek-ai/dsh-brand` and `@deepseek-ai/dsh-llm`'s
`createUserMessage`, and the four waterfalls `tools/pre-execute`, `tools/execute`, `tools/post-execute`
and `tools/result` with the harness's payloads and decisions (`{kind:'deny',reason}`,
`{kind:'accept',content}`, `{kind:'block',feedback}`, and `ask` through Comonad's approval surfaces).

What is not implemented is the harness's agent and session internals — `ctx.agents`, `session/event`, the
PTC runtime. A name Comonad neither implements nor finds installed resolves to an empty module and says
so in the log, so such a plugin fails where it used the service, naming the package, rather than looking
like Comonad's fault. The redirect is installed for the process (`module.registerHooks` on Node 22.15+,
and a `require` resolver everywhere); turning the row off empties the table, so harness names then
resolve the way they would with Comonad out of the picture.

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
`start_shell` / `shell_output` / `stop_shell` (background), `list_plans` / `read_plan` / `write_plan`,
`todo_write`, `calculate` / `describe_numbers` / `percentile` / `convert_units`, `fetch_url`,
`web_search`, `find_files`, `find_symbols`, `get_diagnostics`, `apply_edits`, `git_diff`, `run_task`,
`ask_user`, `agent` (subagents), `skill`, `memory`, plus `server__tool` for every MCP tool.

Every tool declares a capability, whether it needs network, and whether it needs a workspace; the
registry filters by all three before the model ever sees it. Read and write paths go through the same
workspace guard, and every shell — foreground or background — runs under the OS sandbox.

`read_file` also reads PNG, JPEG, WebP and GIF images and hands them to the model as image content
(up to 4 MiB each). The chat composer accepts images pasted or dropped into it — up to six per
message, 4 MiB each and 12 MiB in total; larger pictures are downscaled to 1568px before upload —
and tool results and prompts show thumbnails in the transcript. Image bytes live in a content-addressed store under the extension's global storage; the
session file keeps only the reference. A model that refuses images is remembered for that chat, and
the request is resent as text.

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
  gate, hooks, usage and subagents, and mirrors everything to the audit log. A file write goes
  through `ctx.edit` when the change-journal row is loaded, which is how the journal sees every write
  without the agent knowing what a journal is.

```
src/
  main.ts         activate/deactivate: create the root Context, mount the app
  app.ts          the plugin tree — the whole composition in one file
  host.ts         the VS Code implementation of the Host contract (config, secrets, storage)
  events.ts       typed event declarations (declaration merging on Cordis' Events)
  lib/            pure domain: types, policy gate, graph runtime, mermaid parser, sandbox,
                  prompt shaping, frontmatter, OpenAI protocol, instructions/memory
  services/       Cordis services: log, settings, audit, sessions, usage, tasks, tools,
                  catalog (skills/agents/commands), llm, hooks, mcp, approval, commands,
                  agent (turn pipeline)
  llm/            model adapter: OpenAI-compatible SSE (DeepSeek and friends)
  tools/          tool plugins: fs, shell, plan, todo, web, vscode, math, misc
  ui/             surfaces: chat panel, participant, status bar, sessions/tasks views,
                  settings panel, inline actions, slash commands, command palette
  plugins/        reactions: watchers that reload catalogs and MCP on config/trust changes
```

The default agent loop is a Mermaid graph (`comonad.graph`); edit it in **Comonad: Open Settings**.
The panel is tabbed — **Graph** (Mermaid source beside a live preview, Max steps, parsed Nodes /
Routes), **Agent** (model, work mode, approval, display, context, network, working directory,
command timeout with its **Always use the command timeout** override, plan directory, deny read
paths, and the **Restrict to workspace** pair that narrows reads and writes to the working
directory), **Rules** (the `comonad.permissions` allow / ask /
deny lists, one rule per line, validated on save), **Prompts** (Comonad's own prompt blocks and every
tool definition: reorder them, switch them, and edit each block's static prefix; when ST takes over,
the block order and switches mirror the active preset read-only, while the prefix still applies),
**Inspect** (a read-only tab with two sub-tabs: **Tool Policy Flow (TPF)** — the tool-call gate as a
Mermaid diagram: the work-mode, network and workspace checks, then two frames — **your rules** and the
**approval policy**, whose five settings each get their own node — with the unsandboxed /
dangerous-command escalation between them; every gate ends in its own **Rejected** / **Asks you** /
**Runs** node right beside it, so the chart never draws an edge across itself; generated from the
policy tables, so it cannot drift from the code — and **Plugins**, the dependency tree of the loaded
rows), **MCP**, and **Tools** —
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

esbuild bundles the extension into a single CJS file; the test bundle is built
the same way, so the fast suite runs the real services on a headless Cordis context with a fake
host (`src/test/harness.ts`). Tests cover the policy gate, rule syntax, graph parse/compile/
suspend, frontmatter, path guards, diff parsing and session persistence — plus the Cordis kernel
itself: tool-effect unwinding, visibility filtering, and a full scripted agent turn (tool loop,
streamed events, approval waterfall).

Four packages are bundled or shipped beside the bundle, and nothing else: `cordis` (the plugin
kernel), `fuse.js` (the world-book search, with upstream's own options and field weights),
`gpt-tokenizer` and `@agnai/web-tokenizers` (the tokenizer chain — the first is bundled, the second
is kept as a real file because its wasm would bloat the bundle four megabytes).

Two packages ship beside the bundle as plugins: `packages/comonad-plugin-tavern` (the SillyTavern
content layer, its vectors and its tokenizer files) and `packages/comonad-plugin-math` (KaTeX, its
stylesheet and its fonts). Each is built as its own bundle
(`npm run build:plugins`, part of `npm run compile`, one bundle per folder that declares
`comonad.plugin` in its `package.json`) and is not part of `dist/extension.js`, which is what makes
them plugins rather than features. The tavern plugin imports the host's shared vocabulary by name
(`@comonad/*` — the content types, the prompt estimator, the command helper) and those imports are
bundled into its own file, so an install is one folder. Its *settings* are its own too: the keys, the
defaults and the typing live in the plugin (`lib/settings.ts`), read over the same store every
setting uses.

The journal is the seam that shows what the other side of the line looks like: the agent, the chat
panel and the review reach it through `ctx.get('checkpoints')`, so with its row off nothing is
journaled, no review command is registered, and a write is simply a write — but the code is in
`dist/extension.js`, because a silent loss of the undo story is a worse default than a shadow
repository.

The test host runs against a home of Comonad's own — a temporary directory named by `COMONAD_HOME` — so
the plugins installed in your real `~/.comonad`, and the rows you wrote for them, never change what a
test sees.

## License

Comonad Agent for VS Code is licensed under the **GNU Affero General Public License, version 3**
(`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full text.

The corresponding source for each published build is this repository at the matching version tag.
Third-party components and their licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the modifications relative to SillyTavern are
recorded in [NOTICE](NOTICE).
