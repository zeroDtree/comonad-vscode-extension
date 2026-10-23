# 设置

设置位于 VS Code 设置界面（`comonad.*`）、**Settings** 面板的标签页，以及工作区或用户的
`settings.json`。Agent 标签页每个控件即时保存；运行中的回合保持它开始时的策略，所以改动从下一条消息
开始生效。

本页列出你最可能修改的键。每个键在 VS Code 设置界面里也有说明。

## 模型

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `comonad.model` | `auto` | `auto` 取第一个 profile；profile id 取其默认模型；或 `profile:model` |
| `comonad.profiles` | 内置 DeepSeek/Gemini profile | OpenAI 兼容端点；见[聊天](/zh/guide/chat) |
| `comonad.reasoningEffort` | `auto` | 思考强度：`auto`、`none`（Off）、`low`、`medium`、`high`、`max`；受 profile 的 `topEffort` 封顶 |
| `comonad.contextWindow` | `0` | 覆盖模型输入窗口；`0` 使用 profile |

## 聊天显示

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `comonad.displayForm` | `rendered` | 整个转录的 `rendered`、`token` 或 `raw` |
| `comonad.contextForm` | `rendered` | 聊天回传给模型的内容 |
| `comonad.toolCard` | `collapsed` | 工具卡初始为 `collapsed`、`preview` 或 `open` |
| `comonad.chatWindow` | `false` | 在独立浮动窗口中打开聊天 |

## 策略与工作区

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `comonad.mode` | `sw` | `chat`、`ro`、`sw`、`aw` 或 `pl` |
| `comonad.approval` | `manual` | `manual`、`whitelist_accept`、`blacklist_reject`、`universal_accept`、`universal_reject` |
| `comonad.network` | `false` | 网络工具与 shell 内网络；回环仍可用 |
| `comonad.workingDirectory` | 工作区根目录 | 文件与 shell 工具的工作目录 |
| `comonad.planDirectory` | `.comonad/plans` | 计划文件的工作区相对目录 |
| `comonad.confineRead` | `false` | 把读取限制在工作区 |
| `comonad.confineWrite` | `true` | 把写入限制在工作区 |
| `comonad.allowUnsandboxedShell` | `false` | 无 OS 沙箱时跳过额外确认 |
| `comonad.allowFullAccess` | `true` | 提供 unrestricted 预设 |
| `comonad.commandTimeout` | `60` | shell 超时回退值（秒） |
| `comonad.commandTimeoutOverride` | `false` | 始终使用该值，忽略模型选择的超时 |
| `comonad.maxSteps` | `0`（无限制） | 每回合最大图步数 |
| `comonad.subagentStepsMode` | `custom` | `inherit` 共享该回合的 `maxSteps`；`custom` 使用 `comonad.subagentSteps` |
| `comonad.subagentSteps` | `40` | `custom` 下子 Agent 的步数预算；`0` 表示无限制。定义的 `maxTurns` 只能收紧它 |
| `comonad.filterSensitiveEnv` | `true` | 从命令环境中移除 key、token 与密码 |
| `comonad.permissions` | `{allow:[], ask:[], deny:[]}` | 规则列表；见[安全](/zh/guide/safety#_2-规则) |
| `comonad.subagents` | `{}` | 子 Agent 的逐 Agent 授权：`files`（可跟踪文件工具）与 `test`（`run_shell_test`）。内置 `implement` 默认两者都有；其它 Agent 默认只读。 |

## 子 Agent

`comonad.subagents` 把 Agent 名称映射到它的授权：

```json
{
  "comonad.subagents": {
    "implement": { "files": true, "test": true },
    "review": { "test": true },
    "my-writer": { "files": true }
  }
}
```

只读工具始终可用。只有 `files` 和 `test` 两种授权；`run_shell`、`start_shell` 和计划写入永远不会授予
子 Agent。Agent 定义还必须列出使用该能力的工具；没有 `tools` 列表的定义视为只读。父模式仍需允许该
能力。内置 `implement` 默认获得两种授权；其它内置和所有自定义 Agent 默认只读，需显式配置。见
[安全](/zh/guide/safety#子-agent)。

步数：`comonad.subagentStepsMode` 默认 `custom`，每个子 Agent 花费 `comonad.subagentSteps`（40）个图步；
设为 `inherit` 时改用该回合的 `maxSteps`。定义里的 `maxTurns` 按回合计数，只会收紧预算（每回合两图步，
最少四步），不会放宽。

## 检查点

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `comonad.checkpoints` | `true` | 记录 agent 写过的每个文件 |
| `comonad.inlineDiff` | `true` | 在编辑器内绘制改动，并在块上方提供 Keep/Undo |

日志是插件树里的一行；关掉它会连同审查命令一起移除。见[检查点](/zh/guide/checkpoints)。

## 内容层

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `comonad.tavernEnabled` | `true` | 插件加载后，每个回合都由 ST 集合组装 |
| `comonad.tokenizerDir` | 空 | SillyTavern 检出目录，用于其 tokenizer 文件 |
| `comonad.wiAutomation` | `false` | 运行激活条目的 Automation ID 命令 |
| `comonad.wiVectorEnabled` | `false` | 按语义查找 vectorized 条目 |
| `comonad.wiVectorProfile` | 聊天 profile | 用于 embeddings 的端点 |
| `comonad.wiVectorModel` | `text-embedding-3-small` | 嵌入模型 |
| `comonad.wiVectorThreshold` | `0.25` | 最低余弦相似度 |
| `comonad.wiVectorMaxEntries` | `5` | 一本书最多贡献的 vectorized 条目数 |
| `comonad.wiVectorQuery` | `2` | 构成查询的最新消息数 |

见[内容层](/zh/guide/content)。

## 下一步

- [命令](/zh/reference/commands)
- [工具](/zh/reference/tools)
- [开发](/zh/development)
