# Decision trace

Every tool call that reaches the runtime policy pipeline leaves an authorization record. The record
is not a second copy of the policy: each layer writes one immutable decision node, and a terminal
event names the node that ended the call. An audit walks the `parent_id` links from that terminal
back to the root.

## The record

A node is one layer's decision:

```json
{
  "kind": "node",
  "node_id": "9e0e…",
  "parent_id": null,
  "call_id": "6e0c…",
  "layer": "capability",
  "decision": "allow",
  "matched_rule": "ro",
  "policy_revision": "8f3c1a2b7d4e5f60",
  "reason": "mode sw grants ro",
  "at": 1760000000000
}
```

| Field | Meaning |
| --- | --- |
| `node_id` | Unique node id |
| `parent_id` | The node before it; `null` at the root |
| `call_id` | The audit call id (a UUID; not the provider's call id) |
| `layer` | `capability`, `network`, `rules`, `approval`, `response`, `sandbox`, `hook` or `plugin` |
| `decision` | `allow`, `ask`, `deny` or `no_match` |
| `matched_rule` | The matching user rule or policy entry, or `""` |
| `policy_revision` | The effective policy used for this decision |
| `reason` | A short human-readable explanation |

Only layers that were actually reached appear. A deny rule ends the chain at `rules`; a capability
failure ends it at `capability`; an allow rule never produces an `approval` node.

## Terminal events

A terminal event is written once per call:

```json
{
  "kind": "event",
  "event_id": "e0a1…",
  "call_id": "6e0c…",
  "trace_head_id": "b71f…",
  "event": "dispatch_started",
  "timestamp": 1760000000123,
  "session_id": "…",
  "turn": 3,
  "provider_call_id": "call_0",
  "tool_name": "read_file"
}
```

- `denied` — the call did not run. The reason is in `reason` (`deny rule`, `approval denied`,
  `hook`, `plugin`, `batch rejected`, `stopped before dispatch`, …).
- `dispatch_started` — the call entered dispatch; `trace_head_id` is the sandbox node.

The terminal event never duplicates the policy facts. Reconstruct the path with
`/audit <call_id>` or **Comonad: Show Decision Trace**.

## Where the records live

```text
<storage>/audit/decisions/YYYY-MM-DD.jsonl
```

One JSON object per line. Three record kinds share the file:

- `policy` — the full `PolicySnapshot` for a `policy_revision`, written once per revision in a
  process (a restart may write an identical copy; reconstruction uses either);
- `node` — one decision node;
- `event` — one terminal event.

A call writes all of its nodes to the day it started, even if the terminal lands after midnight.
The existing `audit/YYYY-MM-DD.jsonl` still records user messages, tool arguments/results and turn
ends; its tool records carry `trace_id`, which is the same `call_id`, so the two logs can be joined.
The decision files are append-only daily logs; archive or delete old days as your retention policy
requires.

## Policy revision

The revision is a short SHA-256 of the effective policy:

- work mode, network access, tool approval policy, approval response policy and sandbox mode;
- the three user-rule lists, in their effective order;
- the deny-read paths, sorted.

Changing any of them changes the revision. Whitespace-only changes to a rule file do not, because
the revision is computed from the parsed rules. The snapshot record lets an audit show exactly what
the revision meant, even after the settings have changed.

## Reconstructing a call

Open the chat and run:

```text
/audit                 # the 20 most recent terminal events
/audit <call_id>       # the full path for one call
```

Or run **Comonad: Show Decision Trace** from the command palette, pick a recent terminal, and open
the path as a Markdown document. The document lists every node in order, the terminal, the provider
call id, the session/turn and the policy snapshot.

A call that is suspended on an approval has no terminal until it is answered or stopped; `/audit`
shows the nodes written so far and reports **no terminal**.

## What is not recorded

- Tool arguments and outputs. They stay in the existing audit log, correlated by `trace_id`.
- Prompt text, model replies and secrets.
- Plugin-internal state. A `tools/pre-execute` refusal is recorded as a `plugin` node; a
  `PreToolUse` block as a `hook` node.

## Failure behaviour

Writing a trace is best effort. An unwritable storage directory logs one message and never fails a
turn. A damaged JSONL line is skipped; the rest of the file remains readable.

## Next

- [Safety](/guide/safety) — the layers the trace records
- [Settings](/reference/settings) — the policy values a revision names
