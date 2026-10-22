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

Type a prompt, a slash command, or `@` to reference code. `Enter` sends; `Shift+Enter` adds a line.
Paste or drop images to attach them (up to six per message, 4 MiB each, 12 MiB total).

The model pill opens one menu with three controls:

| Control | What it does |
| --- | --- |
| **Reasoning** | Thinking effort: Auto, None, Low, Medium or High |
| **Context window** | Auto uses the model profile; fixed sizes override it |
| **Model** | The model for new turns; the list is read from each endpoint |

Below the input:

| Control | What it does |
| --- | --- |
| **Mode** | What the agent may do at all — see [Safety](/guide/safety) |
| **Approval** | What happens to a call no rule matched |
| **Context** | What this chat sends back: Rendered, Token or Raw |
| **Display** | How the whole transcript is drawn |
| **Network** | Network tools and network inside the shell |
| **Tool cards** | How a tool card starts: collapsed (default), preview or open |

Every pick is written back to the matching `comonad.*` setting, so a new chat starts with the same
model, effort, context window and forms.

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
- **A subagent call opens its conversation.** An `agent` card carries **Open session** as soon as the
  child exists. It opens a read-only overlay with the subagent's prompt, steps and tool results, and
  follows the run as it works; **← Back** returns to the parent chat unchanged.
- **Display** switches the whole transcript: **Rendered** folds thoughts and draws tool cards,
  **Token** shows assistant text plus a call count, **Raw** shows the full record as plain text.

### Editing and regenerating

A user prompt carries a **pencil**. It turns the bubble into an editor; sending replaces that prompt
and every later turn. If the agent wrote files at or after that turn, the editor offers **Restore
files too**. **Regenerate** on the newest turn does the same for its reply.

### Generation types

The ▾ beside **Send** offers the six SillyTavern-style generations:

| Type | Effect |
| --- | --- |
| Normal | Answer the box |
| Continue | Carry the last message on as one message |
| Impersonate | Write your next message into the composer |
| Swipe | Add another version of the last reply |
| Regenerate | Run the last prompt again |
| Quiet | Generate without writing to the transcript |

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

Select code in an editor and press `Cmd+L` (`Ctrl+L`) to append its token to the chat. References are
resolved when the turn runs, with numbered lines, read confinement and deny rules applied. A missing
or denied reference becomes an error note instead of failing the turn.

## Images

`read_file` reads PNG, JPEG, WebP and GIF images and sends them to the model (up to 4 MiB each).
Prompts and tool results show thumbnails in the transcript. Image bytes live in a content-addressed
store; the session keeps only the reference. A model that refuses images is remembered for that chat,
and the request is retried as text.

## Next

- [Safety](/guide/safety) — modes, approvals, rules and the sandbox
- [Checkpoints and review](/guide/checkpoints) — what happens to files a turn writes
- [Commands](/reference/commands) — every slash command
