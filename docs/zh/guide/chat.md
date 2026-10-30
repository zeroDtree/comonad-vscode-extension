# 聊天

Comonad 自带聊天。用 **Comonad: Open Chat**（`Cmd+Alt+C` / `Ctrl+Alt+C`）打开，它位于右侧的
Secondary Side Bar。同样的会话也可以在 VS Code 内置聊天视图里通过 `@comonad` 使用。

## 会话

标题栏有三个控件：**Recent Chats**、**Settings** 和 **New Session**。

- 聊天在发送第一条消息后才进入历史。
- **Recent chats** 会搜索标题和消息正文，并在标题下显示匹配行。
- 列表默认只显示本工作区的聊天；搜索栏右侧的 **This workspace** 按钮可切到
  **All workspaces**，避免其它文件夹的历史混进来。
- `Cmd+N`（聊天外为 `Ctrl+Alt+N`）新建干净会话，并把焦点放进输入框。
- 在 Activity Bar 的 **Comonad** 视图里右键会话，可重命名、删除或 fork。
- Fork 的标题带编号（`Title (fork 1)`…），并使用新的检查点身份。

## 输入区

输入提示词、slash 命令，或输入 `@` 引用代码。在提示词开头输入 `/` 会打开命令选择器——与 `@`
选择器共用同一套列表、按键和过滤，并显示每条命令的说明与参数提示。`Enter` 发送，`Shift+Enter` 换行。粘贴或拖入图片可附加
（每条消息最多 6 张，单张 4 MiB，合计 12 MiB）。粘贴 20,000 字符以上的文本会变成输入框上方的
**Pasted text** 标签，并作为文本附件发送（单次粘贴最多保留 200,000 字符），输入框保持轻量、打字不卡；
删除标签即丢弃该段文本。

模型药丸打开一个菜单，包含三个控件：

| 控件 | 作用 |
| --- | --- |
| **Reasoning** | 思考强度：Auto、Off、Low、Medium、High、Max |
| **Context window** | Auto 使用模型 profile；固定档位覆盖它 |
| **Model** | 新一轮使用的模型；列表从各端点读取 |

**Max** 会用到端点支持的最深层级；profile 的 `topEffort` 会封顶——Gemini 最高只到 **High**，
此时菜单会显示成 `Max → high`。

输入框下方：

| 控件 | 作用 |
| --- | --- |
| **Mode** | agent 能做什么 —— 见[安全](/zh/guide/safety) |
| **Tool approval** | 没有规则匹配时如何处理调用 |
| **Sandbox** | OS 强制的读写范围（Sandbox mode） |
| **Tool cards** | 工具卡初始状态：collapsed（默认）、preview、open |

这里的每个选择都会写回对应的 `comonad.*` 设置，所以新建聊天会沿用同样的策略。

**Context**、**Display** 和 **Network** 在设置中配置：Context 在 **Agent**，Display 在 **UI**，
Network 在 **Policies**（或使用 **Comonad: Toggle Network** 命令）。修改 Context 会作用于当前
聊天，并作为新聊天的默认值。

**Tool cards** 就是 `comonad.toolCard` 设置，三档：

| 模式 | 卡片初始状态 |
| --- | --- |
| `collapsed` | 只显示标题栏（默认） |
| `preview` | 收起，显示前 5 行输出 |
| `open` | 展开，显示命令与完整输出 |

切换模式会重绘转录并重置单卡的手动展开状态；单击仍可单独切换一张卡。

## 转录

一个 **turn** 是一条提示词加上 agent 为它做的所有步骤：思考、文本和工具调用，按顺序排列。流式
回合和重载后的同一回合使用同一个渲染器，所以刷新不会改变它的形状。

- **Thinking** 折叠为一行 *Thought*；模型仍在推理时显示 *Thinking…*，结束后显示耗时。
- **工具卡** 以模型写的一句话描述为标题，后面是命令使用的工具（`ls, echo, find, sort`）、耗时，
  以及输出预览或完整命令与输出。悬停 `…` 菜单可复制命令/参数或输出。失败调用使用错误色描边。
- **步骤计时** 运行时实时增长，结束后落在扩展测量的时长上。
- **回合页脚** 显示 *Worked for 12s · 3 tools* 或 *Working…* / *Stopped*，以及复制、fork 和重新生成操作。
- **子 Agent 的调用可以打开它的会话。** 子 Agent 一创建，`agent` 工具卡上就会出现 **Open session**；
  点开后是只读覆盖层，显示子 Agent 的提示词、步骤和工具结果，并随执行过程更新；**← Back** 回到原聊天，
  原聊天不受影响。
- **Display**（设置 → UI）切换整个转录：**Rendered** 折叠思考并绘制工具卡，**Token** 只显示 assistant 文本和调用数，
  **Raw** 以纯文本显示完整记录。

### 编辑与重新生成

用户提示词带有 **铅笔**。点击后气泡变成编辑器；发送会替换该提示词及其之后的所有回合。如果 agent 在该回合
或之后写过文件，编辑器会提供 **Restore files too**。最新回合的 **Regenerate** 对回复做同样的询问。

### 生成类型

**Send** 旁的 ▾ 提供六种 SillyTavern 风格生成：

| 类型 | 效果 |
| --- | --- |
| Normal | 回答输入框 |
| Continue | 把最后一条消息续写成同一条消息 |
| Impersonate | 替你写下一句话，写入输入框 |
| Swipe | 为最后一条回复增加一个版本 |
| Regenerate | 重新运行最后一条提示词 |
| Quiet | 生成但不写入转录 |

有多个版本的回复会在页脚显示 `‹ n/m ›`。

## 引用

在输入区输入 `@` 打开选择器：**Files**、**Folders**、**Symbols** 或 **Current selection**。选中的项
会变成 token：

```text
@src/auth.ts              整个文件
@src/auth.ts:9-13         第 9–13 行
@src/lib/                 文件夹概览
@symbol:src/auth.ts:AuthService
```

在编辑器中选中代码后按 `Cmd+L`（`Ctrl+L`）可把选区 token 追加到聊天。引用在回合运行时解析，带行号，
并受读取隔离和 deny 规则约束。缺失或被拒绝的引用会变成错误提示，不会让回合失败。

解析后的引用是**该轮用户消息的一部分**：它随转录持久化，重载后仍在，swipe/重新生成/编辑都会复用。
它是快照——后续回合不会重新读取文件；需要最新内容时让 Agent 调用 `read_file`。

文件 token 也可以指向图片或 PDF。图片成为图像内容；安装可选的 **PDF documents** 插件后，PDF 成为带页码
的文本（见[图片与 PDF](#图片与-pdf)）。

## 摘要与完整历史

聊天被压缩后，转录顶部会出现摘要卡。原始 turns 仍在聊天记录里，默认折叠在 **Show original
messages** 下；**Load older messages** 可以继续向前分页查看权威转录。**Rebuild** 或
`/summarize --rebuild` 会从完整历史重写摘要。压缩不会删除聊天消息，也不会移动恢复点。

## 图片与 PDF

`read_file` 可读取 PNG、JPEG、WebP 和 GIF（单张最多 4 MiB）并作为图像内容发给模型。提示词和工具结果
会在转录中显示缩略图。图片字节存在内容寻址存储里，会话只保留引用。拒绝图片的模型会按聊天记住，之后以
文本重试。

输入区支持通过 `@`、拖拽或粘贴附加 PDF。`comonad-plugin-pdf` 逐页抽取文本，`@file.pdf:1-5` 读取页范围。
扫描件没有可抽取文本，会明确说明；插件不做 OCR。从 **Settings → Plugins → Install… → PDF documents**
安装。未安装时，PDF 引用会得到安装提示，而不是被当成文本解码。
纯文本重试。

## 下一步

- [安全](/zh/guide/safety) —— 模式、审批、规则与沙箱
- [检查点与审查](/zh/guide/checkpoints) —— 回合写过的文件如何处理
- [命令](/zh/reference/commands) —— 全部 slash 命令
