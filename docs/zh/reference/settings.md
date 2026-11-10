# 设置

设置保存在 Comonad 自己的文件中，而不是 VS Code 配置里：

| 作用域 | 文件 | 含义 |
| --- | --- | --- |
| **User** | `~/.comonad/settings.json` | 所有工作区的默认值 |
| **Workspace** | `<workspace>/.comonad/settings.json` | 仅当前工作区；这里的键覆盖用户层的同名键 |

Settings 面板顶部的 Scope 选择器决定保存写入哪个文件。面板始终显示合并后的生效值，选择器只改变写入目标。
键在文件中不带前缀（用 `model`，而不是 `comonad.model`）。

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

## 策略与工作区

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `mode` | `sw` | Work mode：`chat`、`ro`、`sw`、`aw` 或 `pl` |
| `approval` | `manual` | Tool approval policy：`manual`、`whitelist_accept`、`blacklist_reject`、`universal_accept`、`universal_reject` |
| `approvalResponse` | `ask` | Approval response policy：`ask` 交给应答方并失败关闭；`never` 直接拒绝 |
| `network` | `false` | Network access policy：网络工具与 shell 内网络；回环仍可用 |
| `sandboxMode` | `workspace-write` | Sandbox mode：`workspace-read`、`read-only`、`workspace-write`、`danger-full-access` |
| `workingDirectory` | 工作区根目录 | 文件与 shell 工具的工作目录 |
| `planDirectory` | `.comonad/plans` | 计划文件的工作区相对目录 |
| `allowFullAccess` | `true` | 提供 unrestricted 预设 |
| `commandTimeout` | `60` | shell 超时回退值（秒） |
| `commandTimeoutOverride` | `false` | 始终使用该值，忽略模型选择的超时 |
| `maxSteps` | `0`（无限制） | 每回合最大图步数 |
| `subagentStepsMode` | `custom` | `inherit` 共享该回合的 `maxSteps`；`custom` 使用 `subagentSteps` |
| `subagentSteps` | `40` | `custom` 下子 Agent 的步数预算；`0` 表示无限制。定义的 `maxTurns` 只能收紧它 |
| `filterSensitiveEnv` | `true` | 从命令环境中移除 key、token 与密码 |
| `permissions` | `{allow:[], ask:[], deny:[]}` | 用户规则；见[安全](/zh/guide/safety#_3-user-rule) |
| `subagents` | `{}` | 子 Agent 的逐 Agent 授权：`files`（可跟踪文件工具）与 `test`（`run_shell_test`）。内置 `implement` 默认两者都有；其它 Agent 默认只读。 |

## 图

| 键 | 默认 | 用途 |
| --- | --- | --- |
| `graph` | 内置 `agent` 图 | Graph 插件的多图 Mermaid 源；空值使用内置图。在 User 或 Workspace 设置文件中设置。 |

每个回合只运行默认图；命名图仍可供插件通过 `ctx.graphs.get(id)` 使用。详见[图](/zh/guide/graphs)。

## 子 Agent

`subagents` 把 Agent 名称映射到它的授权：

```json
{
  "subagents": {
    "implement": { "files": true, "test": true },
    "review": { "test": true },
    "my-writer": { "files": true }
  }
}
```

只读工具始终可用。只有 `files` 和 `test` 两种授权；`run_shell`、`start_shell` 和计划写入永远不会授予
子 Agent。计划读工具（`list_plans`、`read_plan`）使用 `ro_plan`，仅在父级处于 Plan 模式时可用。Agent
定义还必须列出使用该能力的工具；没有 `tools` 列表的定义视为只读。父模式仍需允许该能力。内置
`implement` 默认获得两种授权；其它内置和所有自定义 Agent 默认只读，需显式配置。

委派继承父级有效策略，只能收紧。子级的工具审批策略是独立的（默认 `whitelist_accept`），审批应答固定
为 `never`：任何需要询问的调用都会被拒绝。因此可写 Agent 需要继承的 allow 规则，或在 `agent` 调用上
传 `approval: "universal_accept"`。子会话保存完整有效策略、revision 和父会话。见
[安全](/zh/guide/safety#子-agent)。

步数：`subagentStepsMode` 默认 `custom`，每个子 Agent 花费 `subagentSteps`（40）个图步；
设为 `inherit` 时改用该回合的 `maxSteps`。定义里的 `maxTurns` 按回合计数，只会收紧预算（每回合两图步，
最少四步），不会放宽。

## 检查点

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `checkpoints` | `true` | 记录 agent 写过的每个文件 |
| `inlineDiff` | `true` | 在编辑器内绘制改动，并在块上方提供 Keep/Undo |

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
