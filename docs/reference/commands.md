# Commands

Type a slash command in the composer, or run the matching command from the palette. `/help` lists the
commands currently registered, including plugin commands.

Typing `/` at the start of a prompt opens a picker with every command, its description and its
argument hint (for custom commands, the frontmatter's `argument-hint`). Keep typing to filter;
`↑`/`↓` move, `Tab` completes the name, and `Enter` runs an exact name or completes a partial one. A
space closes the picker and begins the command's arguments. Only a `/` at the start of the prompt is
a command — elsewhere it is ordinary text.

## Core commands

| Command | Purpose |
| --- | --- |
| `/help` | List commands |
| `/plan [task]` | Research read-only, then write a plan |
| `/review [focus]` | Review pending changes without editing |
| `/summarize [notes] [--rebuild]` | Extend the model-context summary; `--rebuild` rewrites it from the full chat (`/compress`, `/compact`) |
| `/clear`, `/new` | Start a fresh session |
| `/fork` | Fork this session and keep exploring |
| `/context` | Window, budget breakdown and the last request's usage |
| `/status` | Mode, model, workspace, sandbox and usage |
| `/cost` | Token usage for today and the session |
| `/permissions` | Mode capabilities and permission rules |
| `/model` | Switch the active model |
| `/continue` | Carry the last message on |
| `/impersonate` | Write your next message for you |
| `/swipe` | Generate another version of the last reply |
| `/regenerate` | Generate the last reply again |
| `/quiet [text]` | Generate a reply without adding it to the transcript |
| `/init` | Create a `COMONAD.md` project instruction file |
| `/export` | Export the session as Markdown |
| `/resume` | Resume a suspended (waiting for approval) turn |

## Content layer commands

Available when the SillyTavern content layer is installed:

| Command | Purpose |
| --- | --- |
| `/char [name]` | Pick the character this chat speaks as |
| `/persona [name]` | Pick who you are in this chat |
| `/lore [names]` | Pick the world books this chat scans (`/lore none` clears) |
| `/preset [name]` | Pick the prompt and sampler preset |
| `/note [text]` | Set or clear the chat's standing author's note |

See [Content layer](/guide/content).

## Custom commands

A custom command is a Markdown file under `.comonad/commands/*.md`. Optional frontmatter:

```markdown
---
description: Explain a file
argument-hint: <path>
allowed-tools: read_file
model: deepseek-flash
---

Read `$ARGUMENTS` and explain what it does.
```

- `$ARGUMENTS` is replaced with the command's arguments.
- `` !`shell` `` runs a shell command and inserts its output.
- `@` references use the same resolver as the composer (files, folders, symbols and line ranges).
- `allowed-tools` restricts the turn; `description` and `argument-hint` appear in `/help`.

## Next

- [Chat](/guide/chat) — the composer and generation menu
- [Safety](/guide/safety) — what a command's turn may do
