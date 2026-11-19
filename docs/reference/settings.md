# Settings

Settings live in Comonad's own files, not in VS Code's configuration:

| Scope | File | What it is |
| --- | --- | --- |
| **User** | `~/.comonad/settings.json` | Defaults for every workspace |
| **Workspace** | `<workspace>/.comonad/settings.json` | This workspace only; a key here overrides the user's |

The Settings panel's scope selector chooses where a save lands. The panel always shows the merged
effective value; the selector changes only the destination. Keys are stored bare (`model`, not
`comonad.model`).

The workspace file is read, imported and written only in a trusted workspace. Existing VS Code
`comonad.*` values are imported once on activation and are not read afterwards; edit the files
instead. The Model, display and policy tabs save each control as it changes, and a running turn
keeps the policy it started with, so a change applies from the next message.

This page lists the keys you are likely to change. The Settings panel documents each control; the
JSON files hold the same names.

## Model

| Key | Default | Purpose |
| --- | --- | --- |
| `model` | `auto` | `auto` for the first profile, a profile id for its default model, or `profile:model` |
| `profiles` | shipped DeepSeek/Gemini profiles | OpenAI-compatible endpoints; see [Chat](/guide/chat) |
| `reasoningEffort` | `auto` | Thinking effort: `auto`, `none` (Off), `low`, `medium`, `high` or `max`; a profile's `topEffort` caps it |
| `contextWindow` | `0` | Override the model's input window; `0` uses the profile |

## Chat display

| Key | Default | Purpose |
| --- | --- | --- |
| `displayForm` | `rendered` | `rendered`, `token` or `raw` for the whole transcript |
| `contextForm` | `rendered` | What a chat sends back to the model |
| `toolCard` | `collapsed` | Tool card starts as `collapsed`, `preview` or `open` |
| `chatWindow` | `false` | Open the chat in its own floating window |

## Notifications

| Key | Default | Purpose |
| --- | --- | --- |
| `questionNotification` | `true` | Show a VS Code notification with an **Open Chat** action when a question waits for an answer and the chat panel is closed; the question stays pending either way |

## Policy and workspace

| Key | Default | Purpose |
| --- | --- | --- |
| `mode` | `sw` | Work mode: `chat`, `ro`, `sw`, `aw` or `plan`. The mode is a hard ceiling: the effective capability set can only narrow it |
| `approval` | `manual` | Tool approval policy: `manual`, `whitelist_accept`, `blacklist_reject`, `universal_accept`, `universal_reject` |
| `approvalResponse` | `ask` | Approval response policy: `ask` sends the request to a surface and fails closed; `never` denies without asking |
| `network` | `false` | Network access policy: network tools and network inside the shell sandbox; loopback stays available |
| `sandboxMode` | `workspace-write` | Sandbox mode: `workspace-read`, `read-only`, `workspace-write`, `danger-full-access` |
| `workingDirectory` | workspace root | Working directory for file and shell tools |
| `planDirectory` | `.comonad/plans` | Workspace-relative folder for plan files |
| `allowFullAccess` | `true` | Offer the unrestricted preset |
| `commandTimeout` | `60` | Fallback shell timeout in seconds |
| `commandTimeoutOverride` | `false` | Always use that value and ignore the model's timeout |
| `budget` | `{turns:0, tools:0, tokens:0, milliseconds:0}` | Four independent hard budgets for the main agent; `0` means no limit |
| `subagentBudget` | `{turns:24, tools:100, tokens:0, milliseconds:0}` | Child budget under `subagentBudgetMode: custom`; a role or task can only tighten each dimension |
| `subagentBudgetMode` | `inherit` | `inherit` copies the main agent's four limits; `custom` spends `subagentBudget` |
| `filterSensitiveEnv` | `true` | Strip keys, tokens and passwords from command environments |
| `permissions` | `{allow:[], ask:[], deny:[]}` | User rules; see [Safety](/guide/safety#_3-user-rules) |
| `subagents` | `{}` | Per-role subagent grants: `files` (tracked file tools) and `test` (`run_shell_test`). Defaults come from the role table: `coder`, `tester`, `data-analyst` and `scientist` get both; `technical-writer` gets files; `math-researcher` gets test; every other built-in is read-only. |

## Graph

| Key | Default | Purpose |
| --- | --- | --- |
| `graph` | shipped `agent` loop | Mermaid source for the Graph plugin's named graphs; empty uses the shipped graph. Set it in the User or Workspace settings file. |

Only the default graph runs a turn; named graphs remain available to plugins through
`ctx.graphs.get(id)`. See [Graphs](/guide/graphs).

## Orchestrator and subagents

`subagents` overrides the default grant of a role. The role table supplies the default, so a grant
and the role can never disagree:

```json
{
  "subagents": {
    "coder": { "files": true, "test": true },
    "tester": { "files": true, "test": true },
    "technical-writer": { "files": true },
    "my-writer": { "files": true }
  }
}
```

Read-only tools are always available. `files` and `test` are the only grants; `run_shell`,
`start_shell`, `run_task` and plan writes are never granted to a child. The plan readers
(`list_plans`, `read_plan`) use `ro_plan` and are available only when the parent's effective
capabilities include it. A custom definition without a `tools` list is read-only; a custom role that
reuses a built-in id does not inherit the built-in default. The parent's effective capabilities still
have to include the capability.

A delegation inherits the parent's effective policy and only narrows it. It inherits the parent's
tool approval policy, and its approval response is fixed `never`: any call it would ask about is
denied. A write task therefore needs the parent to run writes without asking (`universal_accept`,
`blacklist_reject`, or an allow rule); otherwise write it in the main thread. The child session
stores the full effective policy, its revision and its parent. See
[Safety](/guide/safety#orchestrator-and-subagents) and [Orchestration](/guide/orchestration).

Budgets: every run has four independent native limits — `turns` (model round trips), `tools`
(tool calls), `tokens` (provider input + output) and `milliseconds` (wall clock). `0` means no
limit. `subagentBudgetMode` defaults to `inherit`: a child copies the main agent's current four
limits (not its remaining budget) and ignores `subagentBudget` and the role budget, while a task or
resume budget can still tighten. Under `custom`, the child takes the tightest non-zero value per
dimension across `subagentBudget`, the role's own budget and the task's `budget`. A run that reaches
a limit stops at a message boundary, keeps a partial transcript and, for a child, pauses the task.
`resume` continues the same child session with a new segment budget; it does not count as a new
attempt. Because the root default is all zeros, `inherit` with the default root settings leaves a
child unlimited; set a finite root budget if you want a cap.

## Checkpoints

| Key | Default | Purpose |
| --- | --- | --- |
| `checkpoints` | `true` | Journal every file the agent writes |

The journal is a row of the plugin tree; turning it off removes the review commands with it. See
[Checkpoints](/guide/checkpoints).

## Content layer

| Key | Default | Purpose |
| --- | --- | --- |
| `tavernEnabled` | `true` | Compose every turn with the ST collection once the plugin is loaded |
| `tokenizerDir` | empty | A SillyTavern checkout for its tokenizer files |
| `wiAutomation` | `false` | Run an activated entry's Automation ID command |
| `wiVectorEnabled` | `false` | Find vectorized entries by meaning |
| `wiVectorProfile` | chat profile | Endpoint used for embeddings |
| `wiVectorModel` | `text-embedding-3-small` | Embedding model |
| `wiVectorThreshold` | `0.25` | Minimum cosine similarity |
| `wiVectorMaxEntries` | `5` | Vectorized entries one book may contribute |
| `wiVectorQuery` | `2` | Newest messages that form the query |

See [Content layer](/guide/content).

## Next

- [Commands](/reference/commands)
- [Tools](/reference/tools)
- [Development](/development)
