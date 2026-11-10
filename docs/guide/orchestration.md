# Orchestration

The root turn is the **Orchestrator**. It answers directly when the work is trivial; otherwise it
records a task DAG, delegates ready nodes to leaf subagents, reads their structured results and the
independent verdicts, and delivers the integrated answer. There is no second model loop: the
Orchestrator is the existing agent loop with three extra tools.

```text
root turn (Orchestrator)
  ├─ task_plan    record or revise the DAG
  ├─ delegate     run 1..8 ready nodes; write and read tasks may run together
  ├─ task_status  board, ready nodes, rejections, sessions, recent notes
  └─ message      shared coordination mailbox (also available to every child)
```

A child is a hidden session with its own policy. It never receives the Orchestrator tools, cannot
spawn or fork, and cannot ask the user. If it is blocked it returns `status: "blocked"`.

## The fourteen roles

| Role | Mode | Network | Direction |
| --- | --- | --- | --- |
| `general-purpose` | `ro` | off | Lightweight read-only tasks without a clear specialist |
| `researcher` | `ro` | on (parent switch still applies) | External research with cited sources |
| `math-researcher` | `sw` | off | Derivation and numerical verification (scratch shell only) |
| `explorer` | `ro` | off | Codebase search and code-path mapping |
| `planner` | `pl` | off | Implementation plan; returns it in the report (no plan writes) |
| `coder` | `sw` | off | Focused implementation through tracked file tools |
| `tester` | `sw` | off | Test design and execution |
| `reviewer` | `ro` | off | Independent review against acceptance criteria |
| `debugger` | `ro` | off | Reproduce and diagnose from evidence |
| `security-auditor` | `ro` | off | Threat modeling and vulnerability review |
| `data-analyst` | `sw` | off | Data profiling, statistics and reproducible analysis |
| `scientist` | `sw` | off | Hypothesis-driven investigation and experiment design |
| `technical-writer` | `sw` | off | Accurate documentation for a named audience |
| `architect` | `pl` | off | Options, interfaces, trade-offs and evolution |

The displayed mode is a ceiling. The role's own capability set, the task's capability filter and the
parent policy all narrow it. `shell_test` writes only the test scratch tree; an effective `rw` is what
makes a task a **write task**. See the role defaults in [Settings](/reference/settings#orchestrator-and-subagents).

## Planning

`task_plan` takes the goal and the complete desired node set. Each node carries:

- `id`, `title`, `role`;
- `objective`, optional `inputs`/`outputs`;
- `writes` (workspace-relative paths or globs, used for coordination and overlap warnings);
- optional `capabilities` (a subset of the role) and `network: false`;
- `dependsOn` (acyclic), `acceptance`, `maxAttempts` and `budget`.

The plan is declarative: on every revision send all nodes you still want. A running or verifying
node blocks a revision. An accepted node may be kept unchanged; changing its definition is refused.
A changed rejected node resets to pending and keeps its attempt count. The graph has at most 32
nodes, six replans and two attempts per node by default.

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
is also a JSON envelope. Its self-declared `verdict` is advisory: acceptance is recomputed from the
per-criterion `met` values, and a command criterion also needs matching `exitCode: 0` evidence.

A write task must have at least one `review` or `command` criterion. The model has no tool that can
mark a task accepted. A rejected node carries a code and reason; revise the plan within the attempt
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

## Approval and limits

A child inherits the parent's approval policy and its approval response is fixed `never`. A write
task therefore runs only when the parent already runs writes without asking (`universal_accept`,
`blacklist_reject`, or an allow rule). Under `manual` or `whitelist_accept`, do the write in the main
thread where the user can approve it, and delegate read-only work plus independent review.

Other limits: 32 nodes, 8 tasks per delegate batch, 4 concurrent children, 6 replans, and 2 attempts
per node by default. Stop aborts the root and its children; an interrupted running node is marked
`interrupted` at the next root turn.

## A small plan

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

`task_plan` then `delegate(["explore"])`, then `delegate(["code"])`. The second batch derives the
reviewer and tester from the two criteria; `task_status` shows the board before the final answer.

Custom roles are Markdown files; see [Extending](/guide/extend#subagent-roles).
