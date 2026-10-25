# 安全

三层机制按顺序决定一次工具调用是否运行，拒绝永远优先。

```mermaid
flowchart LR
  Call["工具调用"] --> Mode{"模式<br/>能力"}
  Mode -->|否| Reject["拒绝"]
  Mode -->|是| Rule{"规则<br/>allow / ask / deny"}
  Rule -->|allow| Run["运行"]
  Rule -->|deny| Reject
  Rule -->|ask| Approval{"审批<br/>策略"}
  Approval -->|ask| Prompt["询问用户"]
  Approval -->|run| Run
  Approval -->|reject| Reject
  Prompt -->|允许| Run
  Prompt -->|拒绝| Reject
```

## 1. 模式

模式决定哪些能力存在。

| 模式 | 能力 |
| --- | --- |
| Chat Only（`chat`） | 没有工具；纯对话 |
| Read-Only（`ro`） | 读文件、只读 shell |
| Semi-Write（`sw`） | + 写文件，+ 测试 shell（工作区只读、仅 scratch 可写） |
| Full Access（`aw`） | + 工作区内完整 shell |
| Plan（`pl`） | 读文件、只读 shell，仅写计划文件 |

模式按聊天记忆；新聊天从 `comonad.mode` 开始。

## 2. 规则

规则是 `comonad.permissions.allow`、`ask`、`deny` 中的模式：

```text
run_shell(npm run test:*)
read_file(./.env)
fetch_url(domain:example.com)
```

在 **Comonad: Open Settings → Agent → Tool rules** 中编辑，一行一条。deny 规则永远优先；allow 规则永远不询问。
没有匹配规则时，由审批策略决定。

## 3. 审批策略

| 策略 | 行为 |
| --- | --- |
| `manual` | 每次调用都询问 |
| `whitelist_accept` | 运行只读默认项和 allow 规则；其余询问 |
| `blacklist_reject` | 拒绝可写默认项和 deny 规则；其余运行 |
| `universal_accept` | 运行模式允许的一切 |
| `universal_reject` | 什么都不运行 |

审批会暂停回合。**Always allow** 会添加一条 allow 规则。**Stop** 会真正取消回合：前台 shell 命令会连同
进程树一起杀掉，待审批会被撤回并拒绝。`start_shell` 启动的后台任务不受影响，仍会继续运行；可在 Tasks
视图或 `stop_shell` 中停止它们。

## 沙箱

shell 命令运行在：

- **macOS：** `sandbox-exec`
- **Linux：** `bwrap`
- **没有 OS 沙箱：** Windows，或未安装工具的宿主机 —— 每次 shell 调用都会请求确认，即使审批策略是 accept

`comonad.allowUnsandboxedShell` 可以跳过这个额外确认。名为 `*_unsandboxed` 的工具始终询问。

### 工作区边界

- `comonad.confineWrite`（默认开启）把写入限制在工作目录内。
- `comonad.confineRead`（默认关闭）对读取做同样限制。
- 两者同时作用于文件工具和 shell 沙箱；符号链接在检查前解析。
- 写受限的完整 shell 会得到 `<working directory>/.comonad/tmp` 作为临时目录，`TMPDIR` 指向它。
- 测试 shell 改用扩展存储中的独立私有目录，见下文。
- `.env` 读写都被拒绝；文件工具永远不能写 `.git`。
- 除非关闭 `comonad.filterSensitiveEnv`，密钥、token、密码会从命令环境中移除。

关闭网络时，沙箱内仍可使用回环 TCP/UDP，因此本地测试服务器可用；只有离开本机的流量被阻断。

### 测试 shell

`run_shell_test`（能力 `shell_test`，在 `sw` 与 `aw` 中可用）保持工作区只读，只打开一个私有 scratch
目录：

- **macOS：** `sandbox-exec` 先拒绝所有写入，再放行 scratch 路径。
- **Linux：** `bwrap` 以只读方式挂载工作区，以读写方式挂载 scratch，并给命令一个私有的 `/tmp`
  （永远不是宿主机的 `/tmp`）。
- `TMPDIR`、`TMP`、`TEMP`、`HOME`、`XDG_CACHE_HOME`、`PYTHONPYCACHEPREFIX` 和
  `COMONAD_SCRATCH` 都指向该目录，测试框架和构建工具因此不会写进仓库。
- 没有 OS 沙箱时工具直接拒绝；`comonad.allowUnsandboxedShell` 和 allow 规则都不能覆盖这一点 ——
  没有沙箱就无法兑现这个能力的承诺。

## 子 Agent

子 Agent 的有效工具是四层交集：

1. 父会话模式的能力；
2. `comonad.subagents` 中的 per-agent 授权（**Settings → Subagents**）；
3. Agent 定义中的 `tools` 列表；
4. 子 Agent 的硬上限。

硬上限保证子 Agent **永远**拿不到 `shell_rw` 和 `rw_plan`：

- `files` 只授予可跟踪的文件工具（`write_file`、`apply_patch`、`apply_edits`）。
- `test` 授予 `run_shell_test`。
- 只读工具始终可用。
- 没有 `tools` 列表的定义视为只读。
- 内置 `implement` 默认获得 **files + test**；其它内置和所有自定义 Agent 默认只读，需显式授权。
- 项目里同名覆盖内置 Agent 的文件不会继承该默认授权。
- 子 Agent 的文件写入记在**主会话**的 journal 中，因此会出现在主会话的 review、inline diff 和
  Git Changes 里。
- 可写子 Agent 只在前台运行，且同一时间只允许一个。后台子 Agent 只读。
- `ask` 规则会升级，而子 Agent 无法代替用户回答，因此该调用被拒绝，而不是被自动批准。
- 在 `manual` 下，批准 `agent` 这次调用就等于批准该子 Agent 列出的工具。要拦住子 Agent 内部的某次
  具体调用，请使用 `deny`（或 `ask`）规则。

## 命令超时

前台 shell 调用可带模型选择的 `timeout`（秒），限制在 1–300。`comonad.commandTimeout` 是回退值；
**Always use the command timeout**（`comonad.commandTimeoutOverride`）会用固定值替换模型的选择。
`start_shell` 任务没有超时。

## 危险命令

`sudo`、`curl | sh`、`git push --force` 等形态的命令始终会询问，即使策略是 accept。`rm` 是例外：
清理 agent 自己的工作不会询问，递归删除也一样。目标属于本会话的条件是：它是本会话写过的文件；
它位于本会话创建的目录下（整棵子树都算，因此之后构建工具写进去的产物也算）；或它位于只有本会话
可写的临时树里（test shell 的 scratch 和 `<工作区>/.comonad/tmp`）。`*`/`?` glob 只要求固定前缀是
已拥有的目录，不会逐个列出匹配文件。

扫描器无法归入已拥有根目录的命令仍会询问：未知变量、命令替换、工作区外的路径、会话未创建过的
目录里的 glob，以及解析到允许范围外的符号链接父目录。

test shell（`run_shell_test`）里的 `rm` 从不询问：它的 OS 沙箱把所有写入限制在自己的 scratch 和
私有临时目录里，删除不可能碰到用户文件。上面其他形态的危险命令仍会询问。

## 预设

三层可以组合成预设：**Ask**、**Plan**、**Auto**、**Read only** 和 **Full access**。`comonad.allowFullAccess:
false` 会隐藏 unrestricted 预设；**Full access** 是唯一放弃工作区边界的预设。

## Workspace Trust

在不受信任的工作区中，项目插件、Hooks 和指令文件不会被加载。工具调用仍遵循配置的审批策略和 OS 沙箱。

## 下一步

- [检查点与审查](/zh/guide/checkpoints) —— agent 写过的文件如何处理
- [设置](/zh/reference/settings) —— 所有安全相关设置
- [架构](/zh/development) —— 策略门控与事件接缝
