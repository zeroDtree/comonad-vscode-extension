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
- the **canonical transcript** (the full chat, which is always kept),
- the **model context** actually sent: summary + recent tail,
- the summary's coverage and version,
- the actual prompt size and share used on the last request.

The status line above the composer shows the same share, e.g. `context 43% · 55K/128K`.

## Compaction

Compaction is a **model-context operation**, not a chat edit. `Session.transcript` is the canonical
record and is never shortened by a summary; the model instead receives a derived summary plus the
turns after its coverage. The newest turn is always kept word for word; a later summarization extends
the first instead of starting over.

The chat shows the summary as a card. Turns the summary covers are kept in the canonical record and
are folded under **Show original messages** (closed by default); **Load older messages** pages
further back through the full transcript. `Rebuild` (or `/summarize --rebuild`) rewrites the summary
from the full canonical transcript.

Consequences:

- A turn that outgrows the window mid-flight is handled in two steps, cheapest first: old tool output
  is elided, and only a request that still does not fit extends the summary. The current turn is
  never summarized.
- A summary that fails changes nothing. The model context stays as it was and the turn is answered
  from it.
- **Restore points are not moved by compaction.** They name canonical message indices, so file
  restoration still works after any number of summaries.
- Old attachments stay referenced by the canonical transcript; compaction does not sweep them away.

A request the endpoint refuses as too long is retried once after being shrunk hard, so a mis-sized
window costs a retry rather than the turn.

Run `/summarize [notes]` (aliases `/compress`, `/compact`) to extend the summary on demand;
`--rebuild` rewrites it from the complete chat.

## What the model sees

The **Context** pill decides what a chat sends back. It applies to the recent tail; the summary is
always included, so it cannot be filtered away:

| Form | What is sent |
| --- | --- |
| Rendered | Summary + text, thoughts and tool results, with long tool output trimmed |
| Token | Summary + only user and assistant text |
| Raw | Summary + the full recent record |

The **Display** pill only changes what you see; Context changes what the model receives.

## References and attachments

`@` references are resolved into typed attachments on the **user message**, not into the system
prompt: numbered text, images, or page-marked PDF text. They are capped at 20k characters per
reference and 60k in total, and filtered by sandbox read scope and deny rules. The resolved snapshot is
stored with the turn, so later turns and replays do not read the file again.

Images and PDFs live in a content-addressed store; the transcript keeps only their metadata. See
[Chat](/guide/chat#images-and-pdfs).

## Next

- [Checkpoints and review](/guide/checkpoints) — restore points and file history
- [Settings](/reference/settings) — `contextWindow`, `contextForm`, `displayForm`
