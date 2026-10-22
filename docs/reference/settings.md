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
| `comonad.reasoningEffort` | `auto` | Thinking effort for models that support `reasoning_effort` |
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
| `comonad.maxSteps` | `128` | Maximum graph steps per turn |
| `comonad.filterSensitiveEnv` | `true` | Strip keys, tokens and passwords from command environments |
| `comonad.permissions` | `{allow:[], ask:[], deny:[]}` | Rule lists; see [Safety](/guide/safety#_2-rules) |

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
