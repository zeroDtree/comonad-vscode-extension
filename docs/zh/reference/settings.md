# 设置

设置保存在 Comonad 自己的文件中，而不是 VS Code 配置里：

| 作用域 | 文件 | 含义 |
| --- | --- | --- |
| **User** | `~/.comonad/settings.json` | 所有工作区的默认值 |
| **Workspace** | `<workspace>/.comonad/settings.json` | 仅当前工作区；这里的键覆盖用户层的同名键 |

Settings 面板顶部的 Scope 选择器决定保存写入哪个文件；打开面板时，若有已打开且受信任的工作区文件夹，
默认选中 **Workspace**，否则选中 **User**。面板始终显示合并后的生效值，选择器只改变写入目标。
键在文件中不带前缀（用 `model`，而不是 `comonad.model`）。

聊天输入区里的选择——**Model**、**Reasoning**、**Context window**，以及 **Mode**、**Tool approval**、
**Sandbox** 三个策略胶囊（包括计划卡片的 **Build**）——遵循同一条规则：有受信任的工作区时写入当前
工作区的文件，否则写入用户文件。因此不同项目的两个窗口各自保留自己的选择。多根工作区使用第一个文件夹。

工作区文件只在受信任的工作区中读取、导入和写入。已有的 VS Code `comonad.*` 值会在激活时一次性导入，之后
不再读取；请直接编辑这些文件。Model、显示与策略标签页的控件即时保存；运行中的回合保持它开始时的策略，
所以改动从下一条消息开始生效。

本页列出你最可能修改的键。Settings 面板为每个控件提供说明；JSON 文件使用相同的键名。

## 模型

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `model` | `auto` | `auto` 取第一个 profile；profile id 取其默认模型；或 `profile:model` |
| `profiles` | 内置 DeepSeek/Gemini profile | OpenAI 兼容端点；见[聊天](/zh/guide/chat) |
| `reasoningEffort` | `auto` | 思考强度：`auto`、`none`（Off）、`low`、`medium`、`high`、`max`；受 profile 的 `topEffort` 封顶 |
| `contextWindow` | `0` | 覆盖模型输入窗口；`0` 使用 profile |

## 聊天显示

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `displayForm` | `rendered` | 整个转录的 `rendered`、`token` 或 `raw` |
| `contextForm` | `rendered` | 聊天回传给模型的内容 |
| `toolCard` | `collapsed` | 工具卡初始为 `collapsed`、`preview` 或 `open` |
| `chatWindow` | `false` | 在独立浮动窗口中打开聊天 |

## 通知

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `questionNotification` | `true` | 提问等待回答且聊天面板关闭时，弹一条带 **Open Chat** 按钮的 VS Code 通知；无论是否通知，提问都会保持等待 |

## 策略与工作区

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `mode` | `sw` | Work mode：`chat`、`ro`、`sw`、`aw` 或 `plan`。模式是硬上限：有效能力集只能收窄它 |
| `approval` | `manual` | Tool approval policy：`manual`、`whitelist_accept`、`blacklist_reject`、`universal_accept`、`universal_reject` |
| `approvalResponse` | `ask` | Approval response policy：`ask` 交给应答方并失败关闭；`never` 直接拒绝 |
| `network` | `false` | Network access policy：网络工具与 shell 内网络；回环仍可用 |
| `sandboxMode` | `workspace-write` | Sandbox mode：`workspace-read`、`read-only`、`workspace-write`、`danger-full-access` |
| `workingDirectory` | 工作区根目录 | 文件与 shell 工具的工作目录 |
| `planDirectory` | `.comonad/plans` | 计划文件的工作区相对目录 |
| `allowFullAccess` | `true` | 提供 unrestricted 预设 |
| `commandTimeout` | `60` | shell 超时回退值（秒） |
| `commandTimeoutOverride` | `false` | 始终使用该值，忽略模型选择的超时 |
| `budget` | `{turns:0, tools:0, tokens:0, milliseconds:0}` | 主 Agent 的四维原生硬预算；`0` 表示无限制 |
| `subagentBudget` | `{turns:24, tools:100, tokens:0, milliseconds:0}` | `subagentBudgetMode: custom` 下的子 Agent 预算；角色或任务只能收紧各维度 |
| `subagentBudgetMode` | `inherit` | `inherit` 复制主 Agent 的四维上限；`custom` 使用 `subagentBudget` |
| `filterSensitiveEnv` | `true` | 从命令环境中移除 key、token 与密码 |
| `permissions` | `{allow:[], ask:[], deny:[]}` | 用户规则；见[安全](/zh/guide/safety#_3-user-rule) |
| `subagents` | `{}` | 子角色的逐角色授权：`files`（可跟踪文件工具）与 `test`（`run_shell_test`）。默认值来自角色表：`coder`、`tester`、`data-analyst`、`scientist` 两者都有；`technical-writer` 只有 files；`math-researcher` 只有 test；其它内置角色默认只读。 |

## 图

| 键 | 默认 | 用途 |
| --- | --- | --- |
| `graph` | 内置 `agent` 图 | Graph 插件的多图 Mermaid 源；空值使用内置图。在 User 或 Workspace 设置文件中设置。 |

每个回合只运行默认图；命名图仍可供插件通过 `ctx.graphs.get(id)` 使用。详见[图](/zh/guide/graphs)。

## 子 Agent

`subagents` 覆盖角色的默认授权；默认值来自角色表，授权与角色不会互相矛盾：

```json
{
  "subagents": {
    "coder": { "files": true, "test": true },
    "tester": { "files": true, "test": true },
    "technical-writer": { "files": true },
    "my-writer": { "files": true }
  }
}
```

只读工具始终可用。只有 `files` 和 `test` 两种授权；`run_shell`、`start_shell`、`run_task` 和计划写入永远
不会授予子级。计划读工具（`list_plans`、`read_plan`）使用 `ro_plan`，仅在父级有效能力含它时可用。没有
`tools` 列表的自定义角色视为只读；复用内置 id 的自定义角色不继承内置默认授权。父级有效能力仍需包含该
能力。

委派继承父级有效策略并只能收紧，也继承父级的工具审批策略；审批应答固定为 `never`，任何需要询问的调用
都会被拒绝。因此写任务需要父策略自动放行写（`universal_accept`、`blacklist_reject` 或 allow 规则）；
否则请在主线程完成写。子会话保存完整有效策略、revision 和父会话。见
[安全](/zh/guide/safety#编排器与子-agent)与[编排](/zh/guide/orchestration)。

预算：每次运行有四个独立原生上限——`turns`（模型往返次数）、`tools`（工具调用次数）、`tokens`
（输入 + 输出 token）、`milliseconds`（墙钟毫秒）。`0` 表示无限制。`subagentBudgetMode` 默认
`inherit`：子代理复制主 Agent 当前的四维上限（不是剩余预算），忽略 `subagentBudget` 与角色预算；
任务预算仍可收紧。`custom` 下则按维度取 `subagentBudget`、角色预算、任务 `budget` 中最小的非零值。
任务预算只是上限：实质性工作应省略它，而不是抄角色默认值。任一维触顶后，运行停在消息边界，保留
partial transcript；子任务进入 `paused`。`resume` 用新的分段预算继续同一子会话，不消耗 attempt，且
新分段不能小于上一段（更小的维度会被抬高并报告）。因为 root 默认全 0，默认 `inherit` 下子代理也不限；
需要上限时给 root 设置有限值。见[设置](/zh/reference/settings#编排器与子-agent)。

## 检查点

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `checkpoints` | `true` | 记录 agent 写过的每个文件 |

日志是插件树里的一行；关掉它会连同审查命令一起移除。见[检查点](/zh/guide/checkpoints)。

## 内容层

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `tavernEnabled` | `true` | 插件加载后，每个回合都由 ST 集合组装 |
| `tokenizerDir` | 空 | SillyTavern 检出目录，用于其 tokenizer 文件 |
| `wiAutomation` | `false` | 运行激活条目的 Automation ID 命令 |
| `wiVectorEnabled` | `false` | 按语义查找 vectorized 条目 |
| `wiVectorProfile` | 聊天 profile | 用于 embeddings 的端点 |
| `wiVectorModel` | `text-embedding-3-small` | 嵌入模型 |
| `wiVectorThreshold` | `0.25` | 最低余弦相似度 |
| `wiVectorMaxEntries` | `5` | 一本书最多贡献的 vectorized 条目数 |
| `wiVectorQuery` | `2` | 构成查询的最新消息数 |

见[内容层](/zh/guide/content)。

## 下一步

- [命令](/zh/reference/commands)
- [工具](/zh/reference/tools)
- [开发](/zh/development)
