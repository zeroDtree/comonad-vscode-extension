# Settings

Settings live in VS Code's Settings UI (`comonad.*`), in the **Settings** panel's tabs, and in the
`settings.json` of the workspace or user. The agent tab saves each control as it changes; a running
turn keeps the policy it started with, so a change applies from the next message.

This page lists the keys you are likely to change. Every key is also documented in VS Code's Settings
UI.

## Model

| Key | Default | Purpose |
| --- | --- | --- |
| `comonad.model` | `auto` | `auto` for the first profile, a profile id for its default model, or `profile:model` |
| `comonad.profiles` | shipped DeepSeek/Gemini profiles | OpenAI-compatible endpoints; see [Chat](/guide/chat) |
| `comonad.reasoningEffort` | `auto` | Thinking effort: `auto`, `none` (Off), `low`, `medium`, `high` or `max`; a profile's `topEffort` caps it |
| `comonad.contextWindow` | `0` | Override the model's input window; `0` uses the profile |

## Chat display

| Key | Default | Purpose |
| --- | --- | --- |
| `comonad.displayForm` | `rendered` | `rendered`, `token` or `raw` for the whole transcript |
| `comonad.contextForm` | `rendered` | What a chat sends back to the model |
| `comonad.toolCard` | `collapsed` | Tool card starts as `collapsed`, `preview` or `open` |
| `comonad.chatWindow` | `false` | Open the chat in its own floating window |

## Policy and workspace

| Key | Default | Purpose |
| --- | --- | --- |
| `comonad.mode` | `sw` | `chat`, `ro`, `sw`, `aw` or `pl` |
| `comonad.approval` | `manual` | `manual`, `whitelist_accept`, `blacklist_reject`, `universal_accept`, `universal_reject` |
| `comonad.network` | `false` | Network tools and network inside the shell sandbox; loopback stays available |
| `comonad.workingDirectory` | workspace root | Working directory for file and shell tools |
| `comonad.planDirectory` | `.comonad/plans` | Workspace-relative folder for plan files |
| `comonad.confineRead` | `false` | Restrict reads to the workspace |
| `comonad.confineWrite` | `true` | Restrict writes to the workspace |
| `comonad.allowUnsandboxedShell` | `false` | Skip the extra prompt when no OS sandbox exists |
| `comonad.allowFullAccess` | `true` | Offer the unrestricted preset |
| `comonad.commandTimeout` | `60` | Fallback shell timeout in seconds |
| `comonad.commandTimeoutOverride` | `false` | Always use that value and ignore the model's timeout |
| `comonad.maxSteps` | `0` (no limit) | Maximum graph steps per turn; a workflow stage's own budget is bounded by this |
| `comonad.subagentStepsMode` | `custom` | `inherit` shares the turn's `maxSteps`; `custom` spends `comonad.subagentSteps` |
| `comonad.subagentSteps` | `40` | Subagent step budget under `custom`; `0` means no limit. A definition's `maxTurns` can only tighten it |
| `comonad.filterSensitiveEnv` | `true` | Strip keys, tokens and passwords from command environments |
| `comonad.permissions` | `{allow:[], ask:[], deny:[]}` | Rule lists; see [Safety](/guide/safety#_2-rules) |
| `comonad.subagents` | `{}` | Per-agent subagent grants: `files` (tracked file tools) and `test` (`run_shell_test`). Built-in `implement` defaults to both; every other agent is read-only until granted. |

## Graph and workflows

| Key | Default | Purpose |
| --- | --- | --- |
| `comonad.graph` | shipped `agent` loop | Mermaid source for the Graph plugin's named graphs; empty uses the shipped graph. Edit it in **Settings → Graph**. |
| `comonad.workflows` | shipped **Standard coding task** | The workflow library: named workflows, their stages and host checks. Edit it in **Settings → Workflow**. |

A workflow stage runs one of the graphs by id. The shipped preset is Research → Plan (approval) →
Implement → Verify → Review; duplicate it in the Workflow tab to make a variant. `/workflow [id] [task]`
runs one for a single turn. See [Workflows](/guide/workflows).

## Subagents

`comonad.subagents` maps an agent name to its grants:

```json
{
  "comonad.subagents": {
    "implement": { "files": true, "test": true },
    "review": { "test": true },
    "my-writer": { "files": true }
  }
}
```

Read-only tools are always available. `files` and `test` are the only grants; `run_shell`,
`start_shell` and plan writes are never granted to a subagent. The agent definition must also list a
tool using the capability; a definition without a `tools` list is read-only. The parent mode still
has to allow the capability. Built-in `implement` defaults to both grants; every other built-in and
every custom agent is read-only until configured. See [Safety](/guide/safety#subagents).

Steps: `comonad.subagentStepsMode` defaults to `custom`, where each subagent spends
`comonad.subagentSteps` (40) graph steps; `inherit` gives it the turn's `maxSteps` instead. A
definition's `maxTurns` counts turns and can lower either budget (two steps per turn, four at the
minimum), but never raise it.

## Checkpoints

| Key | Default | Purpose |
| --- | --- | --- |
| `comonad.checkpoints` | `true` | Journal every file the agent writes |
| `comonad.inlineDiff` | `true` | Draw changes inline with Keep/Undo above each block |

The journal is a row of the plugin tree; turning it off removes the review commands with it. See
[Checkpoints](/guide/checkpoints).

## Content layer

| Key | Default | Purpose |
| --- | --- | --- |
| `comonad.tavernEnabled` | `true` | Compose every turn with the ST collection once the plugin is loaded |
| `comonad.tokenizerDir` | empty | A SillyTavern checkout for its tokenizer files |
| `comonad.wiAutomation` | `false` | Run an activated entry's Automation ID command |
| `comonad.wiVectorEnabled` | `false` | Find vectorized entries by meaning |
| `comonad.wiVectorProfile` | chat profile | Endpoint used for embeddings |
| `comonad.wiVectorModel` | `text-embedding-3-small` | Embedding model |
| `comonad.wiVectorThreshold` | `0.25` | Minimum cosine similarity |
| `comonad.wiVectorMaxEntries` | `5` | Vectorized entries one book may contribute |
| `comonad.wiVectorQuery` | `2` | Newest messages that form the query |

See [Content layer](/guide/content).

## Next

- [Commands](/reference/commands)
- [Tools](/reference/tools)
- [Development](/development)
