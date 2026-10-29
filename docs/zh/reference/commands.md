# 命令

在输入区输入 slash 命令，或从命令面板运行对应命令。`/help` 会列出当前注册的命令，包括插件命令。

## 核心命令

| 命令 | 用途 |
| --- | --- |
| `/help` | 列出命令 |
| `/plan [task]` | 只读研究，然后写计划 |
| `/review [focus]` | 只读审查待处理变更 |
| `/summarize [notes] [--rebuild]` | 扩展模型上下文摘要；`--rebuild` 从完整聊天重写（`/compress`、`/compact`） |
| `/clear`、`/new` | 新建会话 |
| `/fork` | Fork 当前会话并继续探索 |
| `/context` | 窗口、预算拆分与上次请求用量 |
| `/status` | Work mode、审批策略、Sandbox mode、模型、工作区与用量 |
| `/cost` | 今天与会话的 token 用量 |
| `/permissions` | 能力与完整策略：用户规则、审批策略和 Sandbox mode |
| `/model` | 切换当前模型 |
| `/continue` | 续写最后一条消息 |
| `/impersonate` | 替你写下一句话 |
| `/swipe` | 为最后一条回复生成另一版 |
| `/regenerate` | 重新生成最后一条回复 |
| `/quiet [text]` | 生成回复但不写入转录 |
| `/init` | 创建 `COMONAD.md` 项目指令文件 |
| `/export` | 把会话导出为 Markdown |
| `/resume` | 恢复挂起（等待审批）的回合 |

## 内容层命令

安装 SillyTavern 内容层后可用：

| 命令 | 用途 |
| --- | --- |
| `/char [name]` | 选择本聊天扮演的角色 |
| `/persona [name]` | 选择你在本聊天中是谁 |
| `/lore [names]` | 选择本聊天扫描的世界书（`/lore none` 清除） |
| `/preset [name]` | 选择提示词与采样器预设 |
| `/note [text]` | 设置或清除本聊天的常驻作者注记 |

见[内容层](/zh/guide/content)。

## 自定义命令

自定义命令是 `.comonad/commands/*.md` 下的 Markdown 文件。可选 frontmatter：

```markdown
---
description: Explain a file
argument-hint: <path>
allowed-tools: read_file
model: deepseek-flash
---

Read `$ARGUMENTS` and explain what it does.
```

- `$ARGUMENTS` 替换为命令参数。
- `` !`shell` `` 运行 shell 命令并插入输出。
- `@` 引用使用与输入区相同的解析器（文件、文件夹、符号和行范围）。
- `allowed-tools` 限制本轮工具；`description` 与 `argument-hint` 显示在 `/help`。

## 下一步

- [聊天](/zh/guide/chat) —— 输入区与生成菜单
- [安全](/zh/guide/safety) —— 命令所在回合能做什么
