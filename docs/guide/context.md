# Context

A request carries more than the conversation: a system prompt, the definitions of every tool the
turn may run, and anything the content layer composes. All of it is paid out of the model's window,
which is why a 128K model does not hold 128K of chat.

## The window

The window is data on the model profile (`contextWindow`). **Auto** in the model menu resolves to
the current model's own window; fixed sizes override it for an endpoint whose window is not what its
provider documents. A model with no configured window falls back to 128K and says so in `/context`.

Use `/context` to see:

- the window and the reply's share,
- the system prompt and tool-definition cost,
- the transcript and instruction cost,
- the actual prompt size and share used on the last request.

The status line above the composer shows the same share, e.g. `context 43% · 55K/128K`.

## Compaction

Past the window, older turns are **summarized, not cut**. The newest request is kept word for word;
the summary is written into the chat where you can see it; a later summarization extends the first
instead of starting over.

Three consequences:

- A turn that outgrows the window mid-flight is handled in two steps, cheapest first: old tool output
  is elided, and only a request that still does not fit has earlier turns folded away. The current
  turn is never folded.
- A summary that fails changes nothing. The conversation stays as it was and the turn is answered
  from it.
- **Restore points follow the summary.** Compacting replaces turns, so restore points inside them are
  dropped; the rest keep naming the same message. After a compaction the earliest point to restore to
  is the summary itself.

A request the endpoint refuses as too long is retried once after being shrunk hard, so a mis-sized
window costs a retry rather than the turn.

Run `/summarize` (aliases `/compress`, `/compact`) to fold the conversation on demand. Compaction
keeps the newest turn and writes the summary into the chat.

## What the model sees

The **Context** pill decides what a chat sends back:

| Form | What is sent |
| --- | --- |
| Rendered | Text, thoughts and tool results, with long tool output trimmed |
| Token | Only user and assistant text |
| Raw | The full record |

The **Display** pill only changes what you see; Context changes what the model receives.

## References and images

`@` references are resolved into numbered blocks when the turn runs, capped at 20k characters per
reference and 60k in total, and filtered by read confinement and deny rules. Images are stored
outside the transcript and sent as image content; see [Chat](/guide/chat#images).

## Next

- [Checkpoints and review](/guide/checkpoints) — restore points and file history
- [Settings](/reference/settings) — `contextWindow`, `contextForm`, `displayForm`
