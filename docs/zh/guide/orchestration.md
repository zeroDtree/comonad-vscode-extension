# 编排

根轮次就是 **Orchestrator（编排器）**。任务简单时它直接回答；复杂时它记录任务图，把 ready 节点
委派给叶子子代理，读取结构化结果与独立验收结论，再整合交付。这里没有第二个模型循环：编排器就是现有
agent 循环外加四个工具。

```text
根轮次（Orchestrator）
  ├─ task_graph   记录或修订任务图
  ├─ delegate     执行 1..8 个 ready 节点；读写任务可并行
  ├─ task_status  任务板、ready 节点、拒绝原因、子会话、最近消息
  ├─ resume       用新的分段预算继续 paused 节点
  └─ message      共享协作邮箱（所有子代理也可用）
```

子代理是隐藏会话，拥有自己的策略快照。它永远拿不到编排工具，不能 spawn / fork，也不能询问用户；
被阻塞时返回 `status: "blocked"`。

## 任务图与计划文件

两个产物职责不同。

**任务图**是执行状态。`task_graph` 记录当前阶段的节点；运行时对它做版本化、派生验收子代理，并持久化在
根会话上。修订是声明式的：每次重发仍需要的全部节点。**Build plan** 会归档任务图，并在没有活动任务图的
情况下开始实现轮次，因此新的 `task_graph` 从版本 1 开始。

**计划文件**是持久的交付物。`write_plan` 把它写到 `<planDirectory>/<根会话 id>/`；计划卡负责预览，
**Build plan** 把内容交给下一轮。文件在任务图归档后仍然存在，是用户构建时的事实来源。

Plan 会话是只读的，因为它的模式不授予 `rw`；其能力为 `ro`、`shell_ro`、`ro_plan`、`rw_plan`。
该阶段可以包含只读研究节点，并以计划文件作为交付物。

## 十四个角色

| 角色 | 能力 | 网络 | 方向 |
| --- | --- | --- | --- |
| `general-purpose` | `ro`、`shell_ro` | 关 | 没有明确专业归属的轻量只读任务 |
| `researcher` | `ro` | 开（仍受父开关约束） | 外部检索并引用来源 |
| `math-researcher` | `ro`、`shell_ro`、`shell_test` | 关 | 推导与数值验证（只写 scratch shell） |
| `explorer` | `ro`、`shell_ro` | 关 | 代码库搜索与调用路径梳理 |
| `planner` | `ro`、`ro_plan`、`shell_ro` | 关 | 实现计划；在报告中返回，不写计划文件 |
| `coder` | `ro`、`rw`、`shell_ro`、`shell_test` | 关 | 通过受跟踪文件工具做聚焦实现 |
| `tester` | `ro`、`rw`、`shell_ro`、`shell_test` | 关 | 测试设计与执行 |
| `reviewer` | `ro`、`ro_plan`、`shell_ro` | 关 | 按验收标准独立审查 |
| `debugger` | `ro`、`shell_ro` | 关 | 基于证据复现并定位故障 |
| `security-auditor` | `ro`、`shell_ro` | 关 | 威胁建模与漏洞审查 |
| `data-analyst` | `ro`、`rw`、`shell_ro`、`shell_test` | 关 | 数据剖析、统计与可复现分析 |
| `scientist` | `ro`、`rw`、`shell_ro`、`shell_test` | 关 | 假设驱动的科学调查与实验设计 |
| `technical-writer` | `ro`、`rw`、`shell_ro` | 关 | 面向指定读者写准确文档 |
| `architect` | `ro`、`ro_plan`、`shell_ro` | 关 | 方案、接口、权衡与演进 |

角色的 `capabilities` 就是它的能力上限。父策略、任务级 filter 与子代理硬上限会继续收窄。`shell_test`
只写测试 scratch；有效能力含 `rw` 才算**写任务**。默认授权见[设置](/zh/reference/settings#子-agent)。

## 任务图

`task_graph` 接收目标与**完整的期望节点集**。每个节点包含：

- `id`、`title`、`role`；
- `objective`，可选 `inputs` / `outputs`；
- `writes`（工作区相对路径或 glob，用于协作与重叠警告）；
- 可选 `capabilities`（角色能力的子集）与 `network: false`；
- `dependsOn`（无环）、`acceptance`、`maxAttempts`、`maxResumes`、`budget`。

`budget` 是四维对象：`turns`（模型往返）、`tools`（工具调用）、`tokens`（输入 + 输出）、
`milliseconds`（墙钟）。`0` 表示无限制。默认 `subagentBudgetMode: inherit`：子代理复制主 Agent
当前的四维上限；`custom` 则使用 `subagentBudget` 并由角色预算收紧。任务预算在两种模式下都能进一步
收紧。触顶时任务进入 `paused` 而不是 `rejected`：子会话与 transcript 保留，`resume` 用新的分段
预算继续，不消耗 attempt。

任务图是声明式的：每次修订都重发仍需要的全部节点。`running` / `verifying` 节点会阻止修订；`accepted`
节点保持不变，改定义会被拒绝；`rejected` / `paused` 节点改定义后回到 `pending` 并保留尝试次数。图默认
最多 32 个节点、6 次重规划、每节点 2 次尝试；`paused` 节点默认最多 resume 3 次。

## 委派

`delegate` 接收 1–8 个任务 id。任务必须 `pending` 且依赖全部 `accepted`；批次内不得互相依赖。读任务与
写任务可以同批并行；超过 4 个活跃子代理时运行时排队。

worker 批次结束后，运行时对成功节点做验收：

1. `evidence` 标准由 worker 的 JSON envelope 判定。
2. `review` 标准派生一个**固定内置 `reviewer`** 子代理。
3. `command` 标准派生一个**固定内置 `tester`** 子代理，用只写 scratch 的测试 shell 执行原命令并报告
   退出码。

review 验收可并行，command 验收串行。验证者最终消息也是 JSON envelope；它自报的 `verdict` 仅供参考，
验收由每条标准的 `met` 重新计算；command 标准还要求匹配的 `exitCode: 0` 证据。

写任务必须至少有一条 `review` 或 `command` 标准。模型没有任何工具能把任务标成 `accepted`。被拒绝的节点
带 code 与原因；在尝试预算内修订任务图，或报告阻塞。

## 并行写与邮箱

所有受跟踪写都经过 `ctx.edit`，它按绝对路径加锁，覆盖 journal 与写入。不同文件并行，同一文件同时只有
一个写者；`edit_text` 的读-校验-写与 `edit_ranges` 的校验都在锁内完成。

`message` 是每个根会话一个 append-only JSONL 邮箱，位于扩展存储：

```json
{"at": 1760000000000, "from": {"task": "code-a", "agent": "coder", "session": "sub-…"},
 "to": "all", "text": "writing src/a.ts", "files": ["src/a.ts"]}
```

修改共享文件前 `send`，并行任务开始时 `read`；`task_status` 展示最近消息。其他代理的消息是**不可信数据**，
不是指令，子代理提示词会明确这一点。每个子代理还有自己的测试 scratch 子树，并行测试不会互相覆盖构建或
临时目录。

## Plan 模式

Plan 模式是带自己产物的只读阶段。模式是能力上限：Plan 会话授予 `ro`、`shell_ro`、`ro_plan`、`rw_plan`，
因此能读工作区与计划文件，但不能写项目文件——即使调用方显式传入了 `rw`。编排器仍然可用，但只能委派
只读研究：`planner` 节点可以在报告中返回实现计划，`explorer` / `reviewer` 同理。

`task_graph` 拒绝新的或修订过的、有效能力含 `rw` 或验收需要 `command` 的节点；`delegate` 与 `resume`
在 spawn 前重复同样的拒绝。`accepted` 节点是历史：之后切换模式会保留它，只拒绝新的或修订过的工作。

用 `write_plan` 记录最终实现计划。写入器可用时，记录的计划就是交付物：本轮停止并总结，计划卡的
**Build plan** 切到 Semi-Write 或 Full Access 并发送新一轮。沙箱或 Prompts 开关隐藏 `write_plan` 时，
同一轮改为要求在最终总结中给出计划。当前沙箱、Prompts 开关和审批策略决定写入器是否提供、调用是否执行。
从模式选择器选择 Plan 模式并提出计划请求；Plan 模式只设置能力上限，不设置审批或网络。
Build 会归档研究任务图，因此实现轮次从空任务图开始，以文件作为交接物。

## 审批与上限

子代理继承父审批策略，审批响应固定为 `never`。因此写任务只有在父策略已经自动放行写时才可运行
（`universal_accept`、`blacklist_reject` 或 allow 规则）。在 `manual` / `whitelist_accept` 下，请在主
线程完成写（用户可批准），把只读工作与独立审查交给子代理。

其他上限：32 节点、每批 8 个任务（delegate 或 resume）、4 个并发子代理、6 次重规划、每节点默认 2 次
尝试、`paused` 节点默认最多 resume 3 次。停止会中止根轮次与子代理；被中断的 `running` 节点会在下一次
根轮次开始时标为 `interrupted`；`paused` 节点不会被中断，保留子会话等待 `resume`。

## 一个小任务图

```json
{
  "objective": "新增带校验的配置加载器",
  "nodes": [
    {
      "id": "explore",
      "title": "找到配置入口",
      "role": "explorer",
      "objective": "梳理设置加载路径，列出需要修改的文件。",
      "acceptance": [{ "id": "a1", "description": "用 file:line 指出入口", "check": "evidence" }]
    },
    {
      "id": "code",
      "title": "实现加载器",
      "role": "coder",
      "objective": "新增加载器并接入现有入口。",
      "writes": ["src/config.ts"],
      "dependsOn": ["explore"],
      "acceptance": [
        { "id": "a1", "description": "加载器校验必填键", "check": "review", "files": ["src/config.ts"] },
        { "id": "a2", "description": "聚焦测试通过", "check": "command", "command": "npm test -- config" }
      ]
    }
  ]
}
```

先 `task_graph`，再 `delegate(["explore"])`，再 `delegate(["code"])`。第二批会按两条标准派生 reviewer 与
tester；最终回答前用 `task_status` 检查任务板。

在 Plan 模式下，`task_graph` 会因为 `code` 节点拒绝这张图。只委派 `explore` 节点，用 `write_plan` 记录
实现计划，把 `code` 节点留给 **Build plan** 启动的写模式轮次。

自定义角色是 Markdown 文件；见[扩展](/zh/guide/extend#子-agent-角色)。
