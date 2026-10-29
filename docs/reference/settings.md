# Settings

Settings live in VS Code's Settings UI (`comonad.*`), in the **Settings** panel's tabs, and in
`settings.json`. Comonad writes a key to the scope that already holds it. A key no project declares
goes to the user settings, so one configuration follows every window and a repository gains no
`.vscode/settings.json` entry just because the panel was opened. A key a project already declares is
updated there: a user value would be shadowed by the project's, so the change would appear to be
undone on the next read. To move such a key to the user settings, delete its project entry once. The
agent tab saves each control as it changes; a running turn keeps the policy it started with, so a
change applies from the next message.

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
| `comonad.mode` | `sw` | Work mode: `chat`, `ro`, `sw`, `aw` or `pl` |
| `comonad.approval` | `manual` | Tool approval policy: `manual`, `whitelist_accept`, `blacklist_reject`, `universal_accept`, `universal_reject` |
| `comonad.approvalResponse` | `ask` | Approval response policy: `ask` sends the request to a surface and fails closed; `never` denies without asking |
| `comonad.network` | `false` | Network access policy: network tools and network inside the shell sandbox; loopback stays available |
| `comonad.sandboxMode` | `workspace-write` | Sandbox mode: `workspace-read`, `read-only`, `workspace-write`, `danger-full-access` |
| `comonad.workingDirectory` | workspace root | Working directory for file and shell tools |
| `comonad.planDirectory` | `.comonad/plans` | Workspace-relative folder for plan files |
| `comonad.allowFullAccess` | `true` | Offer the unrestricted preset |
| `comonad.commandTimeout` | `60` | Fallback shell timeout in seconds |
| `comonad.commandTimeoutOverride` | `false` | Always use that value and ignore the model's timeout |
| `comonad.maxSteps` | `0` (no limit) | Maximum graph steps per turn |
| `comonad.subagentStepsMode` | `custom` | `inherit` shares the turn's `maxSteps`; `custom` spends `comonad.subagentSteps` |
| `comonad.subagentSteps` | `40` | Subagent step budget under `custom`; `0` means no limit. A definition's `maxTurns` can only tighten it |
| `comonad.filterSensitiveEnv` | `true` | Strip keys, tokens and passwords from command environments |
| `comonad.permissions` | `{allow:[], ask:[], deny:[]}` | User rules; see [Safety](/guide/safety#_3-user-rules) |
| `comonad.subagents` | `{}` | Per-agent subagent grants: `files` (tracked file tools) and `test` (`run_shell_test`). Built-in `implement` defaults to both; every other agent is read-only until granted. |

## Graph

| Key | Default | Purpose |
| --- | --- | --- |
| `comonad.graph` | shipped `agent` loop | Mermaid source for the Graph plugin's named graphs; empty uses the shipped graph. Edit it in **Settings → Graph**. |

Only the default graph runs a turn; named graphs remain available to plugins through
`ctx.graphs.get(id)`. See [Graphs](/guide/graphs).

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
