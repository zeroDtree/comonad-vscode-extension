# Safety

Six layers decide whether a tool call runs, in order. The first layer to stop a call ends it; a
call that reaches the end runs inside the configured sandbox.

```mermaid
flowchart LR
  Call["Tool call"] --> Cap{"Capability<br/>+ network"}
  Cap -->|no| Reject["Reject"]
  Cap -->|yes| Rule{"User rules<br/>deny / ask / allow"}
  Rule -->|deny| Reject
  Rule -->|ask| Response{"Approval<br/>response policy"}
  Rule -->|allow| Sandbox["Sandbox mode"]
  Rule -->|no match| Approval{"Tool approval<br/>policy"}
  Approval -->|reject| Reject
  Approval -->|ask| Response
  Approval -->|run| Sandbox
  Response -->|deny| Reject
  Response -->|allow| Sandbox
```

| Layer | Setting | Values |
| --- | --- | --- |
| Work mode | `comonad.mode` | `chat`, `ro`, `sw`, `aw`, `pl` |
| Network access policy | `comonad.network` | `on`, `off` |
| User rules | `comonad.permissions` | `deny`, `ask`, `allow` lists |
| Tool approval policy | `comonad.approval` | `manual`, `whitelist_accept`, `blacklist_reject`, `universal_accept`, `universal_reject` |
| Approval response policy | `comonad.approvalResponse` | `ask`, `never` |
| Sandbox mode | `comonad.sandboxMode` | `workspace-read`, `read-only`, `workspace-write`, `danger-full-access` |

## 1. Work mode

The mode decides which capabilities exist at all.

| Mode | Capabilities |
| --- | --- |
| Chat Only (`chat`) | No tools; plain conversation |
| Read-Only (`ro`) | Read files, read-only shell |
| Semi-Write (`sw`) | + write files, + test shell (workspace read-only, scratch writable) |
| Full Access (`aw`) | + full shell |
| Plan (`pl`) | Read files, read-only shell, writes plan files only |

The mode is remembered per chat; new chats start from `comonad.mode`.

## 2. Network access policy

`on` lets tools that declare a network need run, and lets commands reach the network inside the
sandbox. `off` refuses both. Loopback stays available inside the OS sandbox, so local test servers
and IPC clients still work.

## 3. User rules

Rules are patterns in `comonad.permissions.allow`, `ask` and `deny`:

```text
run_shell(npm run test:*)
read_file(./.env)
fetch_url(domain:example.com)
```

Edit them in **Comonad: Open Settings → Agent → User rules**, one rule per line. The lists are
checked in this order:

1. **deny** — the call is rejected;
2. **ask** — the call is confirmed;
3. **allow** — the call runs.

A rule that matches decides the call; the tool approval policy is consulted only when none of the
three lists matched. This means an allow rule runs even under `universal_reject`.

## 4. Tool approval policy

| Policy | Runs | Asks | Rejects |
| --- | --- | --- | --- |
| `manual` | – | every call | – |
| `whitelist_accept` | `ro`, `shell_ro`, `rw_plan` | everything else | – |
| `blacklist_reject` | everything else | dangerous commands | `rw`, `shell_test`, `shell_rw`, `rw_plan` |
| `universal_accept` | everything | dangerous commands | – |
| `universal_reject` | – | – | every call |

The whitelist and blacklist are fixed capability sets; use the user rules to name individual tools
or arguments.

## 5. Approval response policy

- `ask` sends each confirmation to a responder — the chat panel, the chat participant, or the
  fallback dialog. A responder answers only requests for its own chat. If no responder answers, the
  request is denied; it never falls open.
- `never` denies every confirmation without showing it.

Approvals pause the turn. **Always allow** adds an allow rule. **Stop** cancels the turn for real:
a foreground shell command is killed with its process tree, and a pending approval is withdrawn and
denied. Background tasks started with `start_shell` keep running; stop them from the Tasks view or
with `stop_shell`.

## 6. Sandbox mode

The sandbox mode is the file range every approved call runs under. The executor resolves it per
call, and the file tools plus the OS sandbox (`sandbox-exec` on macOS, `bwrap` on Linux) enforce it.

| Mode | Reads | Writes |
| --- | --- | --- |
| `workspace-read` | workspace + system runtime | none |
| `read-only` | anywhere | none |
| `workspace-write` | anywhere | workspace only |
| `danger-full-access` | anywhere | anywhere |

A call can narrow the mode but never widen it: the read-only shell writes nothing, the test shell
writes only its scratch tree, and `run_task` runs the editor's own process, so it is available only
under `danger-full-access`.

### No OS sandbox

On Windows, or a host without `sandbox-exec`/`bwrap`, a writable shell can only run under
`danger-full-access` with the network access policy **on**; every other combination refuses it,
because the file and network limits could not be enforced. The read-only shell and the test shell
always need an OS sandbox, because their promises cannot be kept without one. The chat footer and
`/status` say when the host has no OS sandbox.

### Workspace boundary details

- A workspace-write shell gets a temp directory at `<working directory>/.comonad/tmp` with
  `TMPDIR` pointing at it.
- The test shell uses its own tree, `<working directory>/.comonad/scratch/<session>`, exposed as
  `$COMONAD_SCRATCH`; `TMPDIR`, `TMP`, `TEMP`, `HOME`, `XDG_CACHE_HOME` and `PYTHONPYCACHEPREFIX`
  point into it. The rest of the workspace stays read-only.
- `.env` files are denied to reading and writing; `.git` is never writable by file tools.
- Symlinks are resolved before the containment check.
- Secrets (keys, tokens, passwords) are stripped from the environment unless
  `comonad.filterSensitiveEnv` is off.

## Subagents

A subagent's effective tools are the intersection of four things:

1. the parent mode's capabilities;
2. the per-agent grant in `comonad.subagents` (**Settings → Subagents**);
3. the agent definition's `tools` list;
4. the hard subagent cap.

The hard cap means a subagent **never** gets `shell_rw` or `rw_plan`:

- `files` grants only tracked file tools (`write_file`, `apply_patch`, `apply_edits`).
- `test` grants `run_shell_test`.
- Read-only tools are always available.
- A definition with no `tools` list is read-only.
- Built-in `implement` defaults to **files + test**; every other built-in and every custom agent
  defaults to read-only until granted.
- A project file that shadows a built-in name does not inherit that built-in's default grant.
- A subagent's file writes are journaled under the **parent chat**, so they appear in its review,
  inline diff and Git Changes.
- Write-capable subagents run in the foreground, one at a time. A background subagent is read-only.
- An `ask` rule is escalated, and a subagent cannot answer it, so the call is refused rather than
  auto-approved.
- Under `manual`, approving the `agent` call is the approval for that subagent's listed tools. Use
  `deny` (or `ask`) rules to stop a specific call inside a subagent.

## Command timeout

Foreground shell calls take an optional model-chosen `timeout` in seconds, clamped to 1–300.
`comonad.commandTimeout` is the fallback, and **Always use the command timeout**
(`comonad.commandTimeoutOverride`) replaces the model's choice with that fixed value. `start_shell`
tasks have no timeout.

## Dangerous commands

Commands shaped like `sudo`, `curl | sh`, `git push --force` and similar still prompt when the
approval policy would otherwise run them (`universal_accept`, or `blacklist_reject` for a
non-blacklisted capability). `manual` asks every call anyway. `whitelist_accept` runs a dangerous
call when its capability is whitelisted — the OS-enforced read-only range is what the whitelist
trusts; use a `deny` or `ask` rule to stop a specific shape. A user `allow` rule is consent. `rm` is
the exception the agent may answer for itself: deleting its own work never asks, recursively or
otherwise.

A target is the session's own when it is a file the session wrote, lies under a directory the
session created (the whole subtree), or lies under a tree only the session can write — the test
shell's scratch and the workspace `.comonad/tmp`. A `*`/`?` glob needs only an owned directory as
its fixed prefix. Everything the scanner cannot place under an owned root still prompts.

## Presets

The layers can be combined into presets: **Ask**, **Plan**, **Auto**, **Read only** and
**Full access**. Presets live in the mode and approval controls.
`comonad.allowFullAccess: false` hides the unrestricted preset.

| Preset | Work mode | Tool approval | Network | Sandbox mode |
| --- | --- | --- | --- | --- |
| Ask | `sw` | `manual` | off | `workspace-write` |
| Plan | `pl` | `whitelist_accept` | off | `workspace-write` |
| Auto | `aw` | `universal_accept` | off | `workspace-write` |
| Read only | `ro` | `whitelist_accept` | off | `read-only` |
| Full access | `aw` | `universal_accept` | on | `danger-full-access` |

## Workspace Trust

Project plugins, hooks and instruction files are not loaded in untrusted workspaces. Tool calls still
follow the configured approval policy and OS sandbox.

## Next

- [Checkpoints and review](/guide/checkpoints) — what happens to files the agent writes
- [Settings](/reference/settings) — every safety-related setting
- [Architecture](/development) — the policy gate and event seams
