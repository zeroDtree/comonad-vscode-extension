# Context

A request carries more than the conversation: a system prompt and the definitions of every tool the
turn may run. All of it is paid out of the model's window, which is why a 128K model does not hold
128K of chat.

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
- the automatic-compaction trigger, retain target and current estimated pressure,
- the actual prompt size and share used on the last request.

The status line above the composer shows the same share, e.g.
`15.7M tokens · $0.000 · cache 8M (51%) · turn 5 · context 80% · 204K/256K`. Counts scale to K/M/G.
`cache` is the cumulative input the provider served from its prompt cache and its share of all
input; a provider that reports no cache statistics is left off the line rather than shown as
`0 (0%)`. The context share is not clamped: `context 117% · 299K/256K` means the last request
exceeded the configured window. A provider may accept it anyway; the fix is to correct the model
profile's `contextWindow`, not to read 100% as a hard ceiling.

## Compaction

Compaction is a **model-context operation**, not a chat edit. `Session.transcript` is the canonical
record and is never shortened by a summary; the model instead receives a derived summary plus the
turns after its coverage. The newest turn is always kept word for word; a later summarization extends
the first instead of starting over.

Automatic compaction is proactive. Before every model request — not only at a user turn's start —
the agent estimates the whole request (system prompt, tool definitions and messages), calibrates that
estimate against the last prompt size the provider reported for the same request, and compares it
with the window. When fewer than `compactionHeadroom` tokens remain (20,000 by default; `0` turns
proactive compaction off), it summarizes the turns before the current one and keeps a small verbatim
tail: `compactionRetainPercent` percent of the window (10% by default). The current turn is never
folded, and the reply's reserve is still held back. Both settings live in Settings → Agent.

The order of work is: summarize first at the headroom, then elide old tool output only if the request
still cannot fit the reply-reserved window, and only then let the endpoint's refusal trigger one hard
shrink and retry. Subagent requests are not foldable from the chat record, so they only elide. A
successful fold reports the before/after size once; a trimmed request
reports at most once per turn. A summary is a short, non-thinking call and is attempted at most four
times per turn; one that fails is reported once and the turn continues.

The chat shows the summary as a card. Turns the summary covers are kept in the canonical record and
are folded under **Show original messages** (closed by default); **Load older messages** pages
further back through the full transcript. `Rebuild` (or `/summarize --rebuild`) rewrites the summary
from the full canonical transcript.

Consequences:

- The budget counts everything the request carries, including the assistant reasoning that
  DeepSeek requires back as `reasoning_content`. That reasoning is why an estimate can sit below the
  window while the provider reports a larger prompt; the calibration is what keeps the trigger honest.
- The user prompt is committed to the canonical transcript before turn-start compaction, so a
  reload, Stop or failed turn never loses it; a summary cannot delay the prompt reaching disk.
- **Restore points are not moved by compaction.** They name canonical message indices, so file
  restoration still works after any number of summaries.
- Old attachments stay referenced by the canonical transcript; compaction does not sweep them away.

A request the endpoint refuses as too long is retried once after being shrunk hard, so a mis-sized
window costs a retry rather than the turn.

Run `/summarize [notes]` (aliases `/compress`, `/compact`) to extend the summary on demand;
`--rebuild` rewrites it from the complete chat.

## What the model sees

The **Context** setting (Settings → Agent → Context) decides what a chat sends back. It applies to
the recent tail; the summary is always included, so it cannot be filtered away:

| Form | What is sent |
| --- | --- |
| Rendered | Summary + text, thoughts and tool results, with long tool output trimmed |
| Token | Summary + only user and assistant text |
| Raw | Summary + the full recent record |

The **Display** setting (Settings → UI → Display) only changes what you see; Context changes what
the model receives.

## References and attachments

`@` references are resolved into typed attachments on the **user message**, not into the system
prompt: numbered text, images, or page-marked PDF text. They are capped at 20k characters per
reference and 60k in total, and filtered by sandbox read scope and deny rules. The resolved snapshot is
stored with the turn, so later turns and replays do not read the file again.

Images and PDFs live in a content-addressed store; the transcript keeps only their metadata. See
[Chat](/guide/chat#images-and-pdfs).

## Next

- [Checkpoints and review](/guide/checkpoints) — restore points and file history
- [Settings](/reference/settings) — `contextWindow`, `compactionHeadroom`, `compactionRetainPercent`, `contextForm`, `displayForm`
