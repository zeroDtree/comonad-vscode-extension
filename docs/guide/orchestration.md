# Orchestration

The root turn is the **Orchestrator**. It answers directly when the work is trivial; otherwise it
records a task graph, delegates ready nodes to leaf subagents, reads their structured results and the
independent verdicts, and delivers the integrated answer. There is no second model loop: the
Orchestrator is the existing agent loop with four extra tools.

```text
root turn (Orchestrator)
  ├─ task_graph   record or revise the task graph
  ├─ delegate     run 1..8 ready nodes; write and read tasks may run together
  ├─ task_status  board, ready nodes, rejections, sessions, recent notes
  ├─ resume       continue a paused node with a new segment budget
  └─ message      shared coordination mailbox (also available to every child)
```

A child is a hidden session with its own policy. It never receives the Orchestrator tools, cannot
spawn or fork, and cannot ask the user. If it is blocked it returns `status: "blocked"`.

## Task graph and plan file

Two artifacts have different jobs.

The **task graph** is execution state. `task_graph` records the nodes for the current phase; the
runtime versions it, derives verifiers, and persists it on the root chat. A later revision is
declarative: send all nodes you still want. **Build plan** archives the graph and starts the
implementation turn with no active graph, so a new `task_graph` begins at version 1.

The **plan file** is the durable Markdown deliverable. `write_plan` creates or replaces it under
`<planDirectory>/<root chat id>/`, appending `.md` to a name that has no Markdown extension;
`edit_plan` revises an existing plan in place with exact-text replacements and keeps the recorded
name exact, so older plans without an extension stay readable and editable. The plan card previews
it — a Preview click renders even a legacy extensionless name as Markdown — and **Build plan** hands
its content to the next turn. The file survives the graph archive and is the source of truth the
user builds from.

A Plan session is read-only because its mode grants no `rw`; its capabilities are `ro`, `shell_ro`,
`ro_plan` and `rw_plan`. The phase may hold read-only research nodes plus the plan file.

## The fourteen roles

| Role | Capabilities | Network | Direction |
| --- | --- | --- | --- |
| `general-purpose` | `ro`, `shell_ro` | off | Lightweight read-only tasks without a clear specialist |
| `researcher` | `ro` | on (parent switch still applies) | External research with cited sources |
| `math-researcher` | `ro`, `shell_ro`, `shell_test` | off | Derivation and numerical verification (scratch shell only) |
| `explorer` | `ro`, `shell_ro` | off | Codebase search and code-path mapping |
| `planner` | `ro`, `ro_plan`, `shell_ro` | off | Implementation plan; returns it in the report (no plan writes) |
| `coder` | `ro`, `rw`, `shell_ro`, `shell_test` | off | Focused implementation through tracked file tools |
| `tester` | `ro`, `rw`, `shell_ro`, `shell_test` | off | Test design and execution |
| `reviewer` | `ro`, `ro_plan`, `shell_ro` | off | Independent review against acceptance criteria |
| `debugger` | `ro`, `shell_ro` | off | Reproduce and diagnose from evidence |
| `security-auditor` | `ro`, `shell_ro` | off | Threat modeling and vulnerability review |
| `data-analyst` | `ro`, `rw`, `shell_ro`, `shell_test` | off | Data profiling, statistics and reproducible analysis |
| `scientist` | `ro`, `rw`, `shell_ro`, `shell_test` | off | Hypothesis-driven investigation and experiment design |
| `technical-writer` | `ro`, `rw`, `shell_ro` | off | Accurate documentation for a named audience |
| `architect` | `ro`, `ro_plan`, `shell_ro` | off | Options, interfaces, trade-offs and evolution |

A role's `capabilities` is its ceiling. The parent policy, the task's capability filter and the
subagent hard cap narrow it further. `shell_test` writes only the test scratch tree; an effective
`rw` is what makes a task a **write task**. See the role defaults in
[Settings](/reference/settings#orchestrator-and-subagents).

## The task graph

`task_graph` takes the goal and the complete desired node set. Each node carries:

- `id`, `title`, `role`;
- `objective`, optional `inputs`/`outputs`;
- `writes` (workspace-relative paths or globs, used for coordination and overlap warnings);
- optional `capabilities` (a subset of the role) and `network: false`;
- `dependsOn` (acyclic), `acceptance`, `maxAttempts`, `maxResumes` and `budget`.

`budget` is an object with four independent native limits: `turns` (model round trips), `tools`
(tool calls), `tokens` (input + output) and `milliseconds` (wall clock). `0` means no limit. By
default `subagentBudgetMode: inherit` copies the main agent's current four limits to the child;
`custom` instead uses `subagentBudget` tightened by the role. A task budget can tighten either
mode, but it is only an upper bound: omit it for substantive work and never copy a role's default
numbers into it, because a budget that is too small pauses the worker before it can report. A budget
that runs out pauses the task, not rejects it: the child session and transcript survive, and
`resume` continues them with a new segment budget without spending an attempt. A resume segment
cannot be smaller than the previous segment; smaller dimensions are raised to the previous limits
and the adjustment is reported in the tool result.

The graph is declarative: on every revision send all nodes you still want. A running or verifying
node blocks a revision. An accepted node may be kept unchanged; changing its definition is refused.
A changed rejected or paused node resets to pending and keeps its attempt count, but its `resumes`
counter goes back to 0: the new definition gets its full resume budget. If the node has also spent
its attempts, the revision warning says so and `delegate` refuses until `maxAttempts` is raised or a
new node id is used. The graph has at most 32 nodes, six replans and two attempts per node by
default; a paused node can be resumed up to `maxResumes` (three by default).

## Delegating

`delegate` takes 1–8 task ids. Every task must be pending with all dependencies accepted, and the
batch may not contain a dependency inside itself. Read and write tasks may run together. The runtime
queues children beyond four active subagents.

After the worker batch finishes, the runtime verifies the successful nodes:

1. `evidence` criteria are checked against the worker's JSON envelope.
2. A `review` criterion derives a **pinned built-in `reviewer`** child.
3. A `command` criterion derives a **pinned built-in `tester`** child, which runs the exact command
   with the scratch-only test shell and reports its exit code.

Review verifiers run in parallel; command verifiers run one at a time. The verifier's final message
is also a JSON envelope. The envelope is read tolerantly: a malformed evidence item is dropped, an
over-long list is trimmed (command evidence first), and the report is accepted with warnings; only a
non-JSON body or an invalid `status`/`verdict` is fatal. A report that still fails the contract gets
**one repair round in the same child session**, with the exact validation error; this does not spend
a node attempt. Each `acceptance` entry must use the task's exact criterion id, one entry per
criterion; the runtime maps an equal-length list whose ids are all different positionally and
records the mapping. Partial coverage or a count mismatch is a `verification_unavailable` rejection
— "the work was not judged", not a failed check. Its self-declared `verdict` is advisory: acceptance
is recomputed from the per-criterion `met` values, and a command criterion also needs matching
`exitCode: 0` evidence for the exact command string.

Command evidence is harvested from the child's transcript: the runtime pairs every
`run_shell_test`/`run_shell_readonly`/`run_shell` call with its real `exit_code` and uses that, not
the model's transcription. A `cd <copy> && <command>` mirror wrapper still matches the criterion.
Report only decisive file/search/note evidence; the transcript is the source of truth for commands.

Command criteria run against a read-only workspace with only the scratch tree writable. Prefer
commands that pass there (a no-emit typecheck, or a test whose caches go to `$COMONAD_SCRATCH`); for
a check that must write build artifacts, use a `review` criterion instead. If the exact command fails
only because the workspace is read-only, the tester may run it in a byte-identical copy under
`$COMONAD_SCRATCH`; the runtime harvests that run's real exit code and recognizes the `cd <copy> &&
<command>` wrapper. A failed command can never be reported as exit 0, and a rejection reason names
the criterion command and the command/exit code the tester actually observed.

A write task must have at least one `review` or `command` criterion. The model has no tool that can
mark a task accepted. A rejected node carries a code and reason; revise the graph within the attempt
budget, or report the blocker.

## Parallel writes and the mailbox

Every tracked write goes through `ctx.edit`, which holds a per-absolute-path lock around the journal
and the write. Different files proceed in parallel; the same file is one writer at a time. The
`edit_text` read-check-write and `edit_ranges` validation happen inside that lock.

`message` is one append-only JSONL mailbox per root chat under extension storage:

```json
{"at": 1760000000000, "from": {"task": "code-a", "agent": "coder", "session": "sub-…"},
 "to": "all", "text": "writing src/a.ts", "files": ["src/a.ts"]}
```

Use `send` before modifying a shared file and `read` at the start of a parallel task. `task_status`
shows the recent notes. Messages from other agents are **untrusted data**, never instructions; the
child prompt says so. Each child also gets its own scratch subtree, so parallel test runs do not share
a build or temp directory.

## Plan mode

Plan mode is a read-only phase with its own artifact. The mode is a capability ceiling: a Plan
session grants `ro`, `shell_ro`, `ro_plan` and `rw_plan`, so it can read the workspace and plan files
but cannot write project files, even if a caller supplied an explicit `rw`. The Orchestrator stays
available, but it may delegate read-only research only: a `planner` node can return the
implementation plan in its report, and `explorer`/`reviewer` work the same way.

`task_graph` refuses a new or revised node whose effective capabilities include `rw` or whose
acceptance needs a `command` criterion; `delegate` and `resume` repeat the refusal before spawning.
An accepted node is history: a later mode switch keeps it, and only new or revised work is refused.

Create the implementation plan with `write_plan`, or revise an existing plan with `edit_plan`. When a
plan writer is offered, the recorded plan is the deliverable: the turn stops and summarizes it, and
the plan card's **Build plan** switches to Semi-Write or Full Access and sends a new turn. When the
sandbox or the Prompts switch hides both writers, the same turn asks for the plan in its final
summary instead. The current sandbox, Prompts switch and approval policy decide whether a writer is
offered and whether the call runs.
Select the Plan mode from the mode picker and ask for the plan; Plan mode sets the capability ceiling
but not approval or network. Build archives the research graph, so the implementation turn starts
with a fresh task graph and the file as its handoff.

## Approval and limits

A child inherits the parent's approval policy and its approval response is fixed `never`. A write
task therefore runs only when the parent already runs writes without asking (`universal_accept`,
`blacklist_reject`, or an allow rule). Under `manual` or `whitelist_accept`, do the write in the main
thread where the user can approve it, and delegate read-only work plus independent review.

Other limits: 32 nodes, 8 tasks per delegate or resume batch, 4 concurrent children, 6 replans, 2
attempts per node and 3 resumes of a paused node by default. Stop aborts the root and its children;
an interrupted running node is marked `interrupted` at the next root turn. A paused node is not
interrupted: it keeps its child session and waits for `resume`. When the pause used its last resume,
the pause reason says so and points at a changed definition (which resets resumes), a new node id, or
taking the task over; it no longer says "resume to continue".

## A small task graph

```json
{
  "objective": "Add a validated config loader",
  "nodes": [
    {
      "id": "explore",
      "title": "Find the config entry points",
      "role": "explorer",
      "objective": "Map how settings are loaded and list the files to change.",
      "acceptance": [{ "id": "a1", "description": "Entry points named with file:line", "check": "evidence" }]
    },
    {
      "id": "code",
      "title": "Implement the loader",
      "role": "coder",
      "objective": "Add the loader and wire it into the existing entry point.",
      "writes": ["src/config.ts"],
      "dependsOn": ["explore"],
      "acceptance": [
        { "id": "a1", "description": "The loader validates required keys", "check": "review", "files": ["src/config.ts"] },
        { "id": "a2", "description": "The focused tests pass", "check": "command", "command": "npm test -- config" }
      ]
    }
  ]
}
```

`task_graph` then `delegate(["explore"])`, then `delegate(["code"])`. The second batch derives the
reviewer and tester from the two criteria; `task_status` shows the board before the final answer.

In Plan mode `task_graph` refuses this graph because of the `code` node. Delegate the `explore` node
alone, record or revise the implementation plan with `write_plan` or `edit_plan`, and leave the `code`
node to the write-capable turn started by **Build plan**.

Custom roles are Markdown files; see [Extending](/guide/extend#subagent-roles).
