# 编排

根轮次就是 **Orchestrator（编排器）**。任务简单时它直接回答；复杂时它记录任务 DAG，把 ready 节点
委派给叶子子代理，读取结构化结果与独立验收结论，再整合交付。这里没有第二个模型循环：编排器就是现有
agent 循环外加三个工具。

```text
根轮次（Orchestrator）
  ├─ task_plan    记录或修订 DAG
  ├─ delegate     执行 1..8 个 ready 节点；读写任务可并行
  ├─ task_status  任务板、ready 节点、拒绝原因、子会话、最近消息
  └─ message      共享协作邮箱（所有子代理也可用）
```

子代理是隐藏会话，拥有自己的策略快照。它永远拿不到编排工具，不能 spawn / fork，也不能询问用户；
被阻塞时返回 `status: "blocked"`。

## 十四个角色

| 角色 | 模式 | 网络 | 方向 |
| --- | --- | --- | --- |
| `general-purpose` | `ro` | 关 | 没有明确专业归属的轻量只读任务 |
| `researcher` | `ro` | 开（仍受父开关约束） | 外部检索并引用来源 |
| `math-researcher` | `sw` | 关 | 推导与数值验证（只写 scratch shell） |
| `explorer` | `ro` | 关 | 代码库搜索与调用路径梳理 |
| `planner` | `pl` | 关 | 实现计划；在报告中返回，不写 plan 文件 |
| `coder` | `sw` | 关 | 通过受跟踪文件工具做聚焦实现 |
| `tester` | `sw` | 关 | 测试设计与执行 |
| `reviewer` | `ro` | 关 | 按验收标准独立审查 |
| `debugger` | `ro` | 关 | 基于证据复现并定位故障 |
| `security-auditor` | `ro` | 关 | 威胁建模与漏洞审查 |
| `data-analyst` | `sw` | 关 | 数据剖析、统计与可复现分析 |
| `scientist` | `sw` | 关 | 假设驱动的科学调查与实验设计 |
| `technical-writer` | `sw` | 关 | 面向指定读者写准确文档 |
| `architect` | `pl` | 关 | 方案、接口、权衡与演进 |

展示的 mode 是能力上限。角色自身的能力集、任务级 filter 与父策略都会继续收窄。`shell_test` 只写测试
scratch；有效能力含 `rw` 才算**写任务**。默认授权见[设置](/zh/reference/settings#子-agent)。

## 规划

`task_plan` 接收目标与**完整的期望节点集**。每个节点包含：

- `id`、`title`、`role`；
- `objective`，可选 `inputs` / `outputs`；
- `writes`（工作区相对路径或 glob，用于协作与重叠警告）；
- 可选 `capabilities`（角色能力的子集）与 `network: false`；
- `dependsOn`（无环）、`acceptance`、`maxAttempts`、`budget`。

计划是声明式的：每次修订都重发仍需要的全部节点。`running` / `verifying` 节点会阻止修订；`accepted`
节点保持不变，改定义会被拒绝；`rejected` 节点改定义后回到 `pending` 并保留尝试次数。图默认最多 32 个
节点、6 次重规划、每节点 2 次尝试。

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
带 code 与原因；在尝试预算内修订计划，或报告阻塞。

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

## 审批与上限

子代理继承父审批策略，审批响应固定为 `never`。因此写任务只有在父策略已经自动放行写时才可运行
（`universal_accept`、`blacklist_reject` 或 allow 规则）。在 `manual` / `whitelist_accept` 下，请在主
线程完成写（用户可批准），把只读工作与独立审查交给子代理。

其他上限：32 节点、每批 8 个任务、4 个并发子代理、6 次重规划、每节点默认 2 次尝试。停止会中止根轮次与
子代理；被中断的 `running` 节点会在下一次根轮次开始时标为 `interrupted`。

## 一个小计划

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

先 `task_plan`，再 `delegate(["explore"])`，再 `delegate(["code"])`。第二批会按两条标准派生 reviewer 与
tester；最终回答前用 `task_status` 检查任务板。

自定义角色是 Markdown 文件；见[扩展](/zh/guide/extend#子-agent-角色)。
