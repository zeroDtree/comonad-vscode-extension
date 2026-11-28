# Chat

Comonad ships its own chat. Open it with **Comonad: Open Chat** (`Cmd+Alt+C` / `Ctrl+Alt+C`); it
lives in the Secondary Side Bar on the right. The same sessions are available from the `@comonad`
participant in VS Code's built-in chat view.

## Sessions

The title bar has three controls: **Recent Chats**, **Settings** and **New Session**.

- A chat enters history after its first sent message.
- **Recent chats** searches titles and message text; the matching line is shown under the title.
- The list shows this workspace's chats by default. Its **This workspace** button switches to
  **All workspaces**, so chats from another folder never mix into the current one by accident.
- `Cmd+N` (`Ctrl+Alt+N` outside the chat) starts a clean session and focuses the composer.
- Right-click a session in the **Comonad** Activity Bar view to rename, delete or fork it.
- Forks are numbered (`Title (fork 1)`, …) and start with a fresh checkpoint identity.

## Composer

Type a prompt, a slash command, or `@` to reference code. Typing `/` at the start of a prompt opens
the command picker — the same list, keys and filters as the `@` picker, with each command's
description and argument hint. `Enter` sends; `Shift+Enter` adds a line.
Paste or drop images to attach them (up to six per message, 4 MiB each, 12 MiB total). A text paste
of 20,000 characters or more becomes a **Pasted text** chip above the input and travels as a text
attachment (a single paste keeps up to 200,000 characters), so the composer stays small and typing
stays fast; removing the chip drops the block. After the message is sent, its **Pasted text** chip
opens the stored block in a read-only tab.

The model pill opens one menu with three controls:

| Control | What it does |
| --- | --- |
| **Reasoning** | Thinking effort: Auto, Off, Low, Medium, High or Max |
| **Context window** | Auto uses the provider; fixed sizes override it |
| **Model** | The model for new turns; the list is read from each endpoint |

**Max** runs as deep as the endpoint goes. The provider's `topEffort` caps it — Gemini stops at
**High** — and the menu then reads the pick as `Max → high`.

Below the input:

| Control | What it does |
| --- | --- |
| **Mode** | What the agent may do at all — see [Safety](/guide/safety) |
| **Tool approval** | What happens to a call no rule matched |
| **Sandbox** | The OS-enforced read and write range |
| **Tool cards** | How a tool card starts: collapsed (default), preview or open |

Every pick is saved under its key in Comonad's settings files. With a trusted folder open, the
Model, Reasoning and Context window menus and the Mode, Tool approval and Sandbox pills are saved
in this workspace's file; without one they go to your user file. A new chat starts from the same
values, and the plan card's **Build** saves its model and mode the same way.

**Context**, **Display** and **Network** are set in Settings instead: Context under **Agent**,
Display under **UI**, and Network under **Policies** (or with **Comonad: Toggle Network**).
Changing Context applies to the active chat and is the default for new chats.

**Tool cards** is the `comonad.toolCard` setting. Its three modes:

| Mode | Card starts as |
| --- | --- |
| `collapsed` | Header only (the default) |
| `preview` | Folded, with the first five output lines |
| `open` | Open, with the command and full output |

Changing the mode redraws the transcript and resets per-card toggles. A click still toggles one card.

## Transcript

A **turn** is one prompt plus every step the agent took for it: thoughts, text and tool calls, in
order. A live turn and the same turn after a reload use the same renderer, so a refresh never changes
its shape.

- **Thinking** is folded into a *Thought* line; it reads *Thinking…* while the model is still
  reasoning and settles on a duration.
- **Tool cards** show the model's one-line description as the title, the utilities the command used
  (`ls, echo, find, sort`), the duration, and a preview or the full command and output. A hover `…`
  menu copies the command/arguments or the output. Failed calls are outlined in the error color.
- **Step timers** climb live and settle on the duration the extension measured.
- **Turn footer** shows *Worked for 12s · 3 tools*, or *Working…* / *Stopped*, plus copy, fork and
  regenerate actions.
- **The Task Graph** is a pill beside the model picker whenever the chat has a graph: accepted/total
  plus a status dot. Clicking it opens the Agent-Map-style **Task Graph** modal — the chat/orchestrator
  as the root card, one card per task with its state (a rejected node names the rejection code, e.g.
  `stopped`), duration and token total, and a chip for every worker/verifier child with its own
  duration and tokens. A child chip opens that read-only session; **← Back** returns to the map.
  The pill and the map follow `orchestrator/changed` while the turn runs.
- A `write_plan` call renders a **Plan ready** card; an `edit_plan` call renders a **Plan updated**
  card. Both carry **Preview** and **Build plan**. Build plan switches the chat to Semi-Write or Full
  Access, archives the research task graph and sends a new implementation turn; the build turn starts
  with a fresh graph and the plan file as its handoff.
- **A delegation opens its conversations.** A `delegate`/`resume` card carries the task's state
  plus an **Open** link named for the worker's role (for example **Open coder**) and **Verify** for
  the active verifier; both links follow the task as it moves from running to verifying. The
  read-only overlay lists the task's worker and verifier sessions as chips, marks which one is
  finished or working, and switches between them. It shows the child's prompt, steps and tool
  results and follows the run as it works; **← Back** returns to the parent chat unchanged.
- **Display** (Settings → UI) switches the whole transcript: **Rendered** folds thoughts and draws tool cards,
  **Token** shows assistant text plus a call count, **Raw** shows the full record as plain text.

### Editing and regenerating

A user prompt carries a **pencil**. It turns the bubble into an editor; sending replaces that prompt
and every later turn. If the agent wrote files at or after that turn, the editor offers **Restore
files too**. **Regenerate** on the newest turn does the same for its reply.

### Generation types

The ▾ beside **Send** offers six generation types:

| Type | Effect |
| --- | --- |
| Normal | Answer the box |
| Continue | Carry the last message on as one message |
| Impersonate | Write your next message into the composer |
| Swipe | Add another version of the last reply |
| Regenerate | Run the last prompt again |
| Quiet | Generate without writing to the transcript; the reply, its thinking, read-only tool calls and tool images are saved as a copyable history beside the chat, each card dismissable on its own and kept across reloads |

Replies with several versions show `‹ n/m ›` in the turn footer.

## References

Type `@` in the composer to open a picker: **Files**, **Folders**, **Symbols** or **Current
selection**. A chosen item becomes a token:

```text
@src/auth.ts              whole file
@src/auth.ts:9-13         lines 9–13
@src/lib/                 folder overview
@symbol:src/auth.ts:AuthService
```

Matching ignores case and full-width/half-width differences. A Chinese name also matches by pinyin —
the full reading (`guangyi`) or its initials (`gy`) — always after literal matches. A full-width `＠`,
`／` or Chinese punctuation typed by an IME is treated like its ASCII form.

With the chat showing in the window's side bar, select code in an editor and press `Cmd+L` (`Ctrl+L`)
to append its token to the chat. The chord follows that side bar: switching it to another agent's chat
releases `Cmd+L`, a collapsed side bar keeps it once Comonad has been used, and an open Comonad chat
panel keeps it regardless. References are resolved when the turn runs, with numbered lines, sandbox
read scope and deny rules applied. A missing or denied reference becomes an error note instead of
failing the turn.

Resolved references are **part of that user message**: they are kept in the transcript, survive a
reload, and are reused by swipe/regenerate/edit. They are a snapshot — a later turn does not re-read
the file. Ask the agent to use `read_file` when you want the current contents.

A file token can name an image or a PDF too. Images become image content; PDFs become page-marked
text when the optional **PDF documents** plugin is installed (see [Images and PDFs](#images-and-pdfs)).

Resolved reference chips under a sent message — and the `@` tokens in its text — are clickable: a
file or symbol reference opens in the editor with its line range selected. Folder and PDF chips stay
read-only.

## Summary and full history

When a chat is compacted, a summary card heads the transcript. The original turns are still in the
chat record and sit folded under **Show original messages**; **Load older messages** pages further
back through the canonical transcript. **Rebuild** or `/summarize --rebuild` rewrites the summary from
the full history. Compaction never deletes chat messages or moves restore points.

## Images and PDFs

`read_file` reads PNG, JPEG, WebP and GIF images and sends them to the model (up to 4 MiB each).
Prompts and tool results show thumbnails in the transcript. Image bytes live in a content-addressed
store; the session keeps only the reference. A model that refuses images is remembered for that chat,
and the request is retried as text.

The composer accepts PDFs by `@`, drag or paste. `comonad-plugin-pdf` extracts their text page by page
and `@file.pdf:1-5` reads a page range. Scanned PDFs have no extractable text and say so; OCR is not
part of the plugin. Install it from **Settings → Plugins → Install… → PDF documents**. Without it, a
PDF reference gets an installation hint instead of being decoded as text.

## Next

- [Safety](/guide/safety) — modes, approvals, rules and the sandbox
- [Checkpoints and review](/guide/checkpoints) — what happens to files a turn writes
- [Commands](/reference/commands) — every slash command
