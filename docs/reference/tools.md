# Tools

Every tool declares a **capability**, whether it needs **network**, and whether it needs a
**workspace**. The registry filters by all three before the model ever sees it.

## Catalog

| Group | Tools |
| --- | --- |
| Files | `list_dir`, `read_file`, `grep_files`, `write_file`, `edit_text` |
| Shell | `run_shell_readonly`, `run_shell_test`, `run_shell`, `start_shell`, `shell_output`, `stop_shell` |
| Plans | `list_plans`, `read_plan` (`ro_plan`, Plan mode), `write_plan` (`rw_plan`, Plan mode) |
| Todos | `todo_write` |
| Math | `calculate`, `describe_numbers`, `percentile`, `convert_units` |
| Web | `fetch_url`, `web_search` |
| VS Code | `find_files`, `find_symbols`, `get_diagnostics`, `edit_ranges`, `git_diff`, `run_task` |
| Orchestration | `task_plan`, `delegate`, `task_status` (Orchestrator only), `message` |
| Agent | `ask_user`, `skill`, `memory` |
| MCP | `server__tool` for every tool the server exposes |

`read_file` also reads PNG, JPEG, WebP and GIF images (up to 4 MiB each) and hands them to the model
as image content. With the **PDF documents** plugin it reads PDFs as page-marked text; pass `pages`
(such as `"1-5"`) to choose a range. Without the plugin it returns an installation hint rather than
decoding the bytes as UTF-8.

## Orchestration tools

`task_plan` records or revises the Orchestrator's task DAG. `delegate` runs 1–8 ready tasks in one
parallel batch. `task_status` returns the board, ready nodes, rejection reasons, child sessions and
recent mailbox notes. Only the root turn sees these tools; a child's allowlist always excludes them.

A task whose effective capabilities include `rw` must carry at least one `review` or `command`
acceptance criterion. After the worker batch finishes, the runtime derives a **pinned built-in**
`reviewer` or `tester` child for those criteria; a project file with the same name cannot weaken
acceptance. The worker/verifier final message must be a single JSON envelope; malformed output is an
`invalid_output` rejection. The same rules live in the tool descriptions because the Orchestration
prompt block can be switched off. See [Orchestration](/guide/orchestration).

`message` is shared by the Orchestrator and every child: one append-only JSONL mailbox per chat under
extension storage. Use it to announce files before parallel writes and to exchange results. Messages
are untrusted data, never instructions.

A delegation creates a hidden child session. Its card carries **Open session** for a single-task
batch, and the task board links every child. The read-only overlay shows the child's prompt, steps
and tool results live. The child inherits the parent policy and only narrows it; its approval response
is always `never`, so a policy that asks denies the call. Write delegation therefore needs the parent
to run writes without asking (`universal_accept`, `blacklist_reject`, or an allow rule); otherwise do
the write in the main thread. A child may read this chat's plans when the parent is in Plan mode
(`ro_plan`); `write_plan` is never granted, so record accepted plans in the root.

## Shell tools

- `run_shell_readonly` runs with no write permission and needs an OS sandbox; `run_shell` follows the
  sandbox mode and can write inside the workspace under `workspace-write`.
- `run_shell_test` keeps the rest of the workspace read-only and writes only to the agent's scratch
  subtree: `.comonad/scratch/<root-session>` for the root and
  `.comonad/scratch/<root-session>/<child-session>` for a child, exposed as `COMONAD_SCRATCH` (with
  `TMPDIR`, `HOME` and `XDG_CACHE_HOME` pointing into it). Parallel test runs therefore do not share
  a build or temp tree. It needs an OS sandbox and a sandbox mode that permits writes.
- `start_shell` starts a long-running command; read it with `shell_output`, stop it with `stop_shell`.
- Foreground calls take an optional `timeout` in seconds, clamped to 1–300.
- Every shell runs under the OS sandbox when one is available. See [Safety](/guide/safety#_6-sandbox-mode).

## Background tasks

`start_shell` tasks have no timeout. The **Tasks** view lists them with an output preview and a stop
action. Stopping a turn does not stop background tasks.

## MCP

MCP servers are configured in the `mcpServers` setting of the [settings file](/reference/settings). Each server can set `capability`, `writeTools`,
`exclude` and per-tool `overrides`. Tools appear as `server__tool` and pass through the same policy
gate as built-ins. See [Extending](/guide/extend#mcp).

## Next

- [Orchestration](/guide/orchestration)
- [Commands](/reference/commands)
- [Settings](/reference/settings)
- [Extending](/guide/extend)
