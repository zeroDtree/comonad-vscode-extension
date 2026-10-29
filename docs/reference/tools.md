# Tools

Every tool declares a **capability**, whether it needs **network**, and whether it needs a
**workspace**. The registry filters by all three before the model ever sees it.

## Catalog

| Group | Tools |
| --- | --- |
| Files | `list_dir`, `read_file`, `grep_files`, `write_file`, `apply_patch` |
| Shell | `run_shell_readonly`, `run_shell_test`, `run_shell`, `start_shell`, `shell_output`, `stop_shell` |
| Plans | `list_plans`, `read_plan`, `write_plan` |
| Todos | `todo_write` |
| Math | `calculate`, `describe_numbers`, `percentile`, `convert_units` |
| Web | `fetch_url`, `web_search` |
| VS Code | `find_files`, `find_symbols`, `get_diagnostics`, `apply_edits`, `git_diff`, `run_task` |
| Agent | `ask_user`, `agent` (subagents), `skill`, `memory` |
| MCP | `server__tool` for every tool the server exposes |

`read_file` also reads PNG, JPEG, WebP and GIF images (up to 4 MiB each) and hands them to the model
as image content. With the **PDF documents** plugin it reads PDFs as page-marked text; pass `pages`
(such as `"1-5"`) to choose a range. Without the plugin it returns an installation hint rather than
decoding the bytes as UTF-8.

An `agent` call creates a hidden child session. Its card carries **Open session** while it runs; the
read-only overlay shows the subagent's prompt, steps and tool results and follows the run live.

## Shell tools

- `run_shell_readonly` runs with no write permission and needs an OS sandbox; `run_shell` follows the
  sandbox mode and can write inside the workspace under `workspace-write`.
- `run_shell_test` keeps the rest of the workspace read-only and writes only to
  `.comonad/scratch/<session>`, exposed as `COMONAD_SCRATCH` (with `TMPDIR`, `HOME` and
  `XDG_CACHE_HOME` pointing into it). It needs an OS sandbox and a sandbox mode that permits writes.
- `start_shell` starts a long-running command; read it with `shell_output`, stop it with `stop_shell`.
- Foreground calls take an optional `timeout` in seconds, clamped to 1–300.
- Every shell runs under the OS sandbox when one is available. See [Safety](/guide/safety#_6-sandbox-mode).

## Background tasks

`start_shell` tasks have no timeout. The **Tasks** view lists them with an output preview and a stop
action. Stopping a turn does not stop background tasks.

## MCP

MCP servers are configured in `comonad.mcpServers`. Each server can set `capability`, `writeTools`,
`exclude` and per-tool `overrides`. Tools appear as `server__tool` and pass through the same policy
gate as built-ins. See [Extending](/guide/extend#mcp).

## Next

- [Commands](/reference/commands)
- [Settings](/reference/settings)
- [Extending](/guide/extend)
