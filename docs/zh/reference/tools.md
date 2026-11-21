# 工具

每个工具都声明 **capability**、是否使用**网络**、是否需要**工作区**。注册表在模型看到它之前按这三项
过滤。

## 目录

| 分组 | 工具 |
| --- | --- |
| 文件 | `list_dir`、`read_file`、`grep_files`、`write_file`、`edit_text` |
| Shell | `run_shell_readonly`、`run_shell_test`、`run_shell`、`start_shell`、`shell_output`、`stop_shell` |
| 计划 | `list_plans`、`read_plan`（`ro_plan`，仅 Plan 模式）、`write_plan`、`edit_plan`（`rw_plan`，仅 Plan 模式） |
| 待办 | `todo_write` |
| 数学 | `calculate`、`describe_numbers`、`percentile`、`convert_units` |
| Web | `fetch_url`、`web_search` |
| VS Code | `find_files`、`find_symbols`、`get_diagnostics`、`edit_ranges`、`git_diff`、`run_task` |
| 编排 | `task_graph`、`delegate`、`task_status`、`resume`（仅编排器）、`message` |
| Agent | `ask_user`、`skill`、`memory` |
| MCP | 每个服务器暴露的 `server__tool` |

`ask_user` 在 Comonad 面板内渲染内嵌问答卡：选项以按钮（单选）或复选框（多选）展示，卡片下方
始终提供文本框，用户可以直接输入答案代替选择，多选时也可以把输入的文字与勾选的选项一起提交。
`@comonad` 参与者和没有面板 surface 的回合改用 VS Code 的 quick pick 或输入框。面板 surface 的提问在没有已连接面板时会保持等待（turn 阻塞），重新打开面板后
重放卡片；除非关闭 `questionNotification`，否则会弹一条带 **Open Chat** 按钮的 VS Code 通知。

`read_file` 还可以读取 PNG、JPEG、WebP 和 GIF（单张最多 4 MiB），并作为图像内容交给模型。安装
**PDF documents** 插件后，它可以把 PDF 读成带页码的文本；用 `pages`（如 `"1-5"`）选择页范围。未安装
插件时返回安装提示，不会把字节当成 UTF-8 文本。

## 编排工具

`task_graph` 记录或修订编排器的任务图；`delegate` 并行执行 1–8 个 ready 任务；`task_status` 返回任务板、
ready 节点、拒绝原因、子会话和最近邮箱消息；`resume` 用新的分段预算继续 paused 任务，分段预算不能小于
上一段（更小的维度会被抬高并报告），用完最后一次 resume 的 pause 会提示改定义或换新节点 id。只有根轮次
能看到这些工具，子级白名单永远排除它们。

只读会话只运行只读任务：`task_graph`、`delegate`、`resume` 拒绝新的或修订过的、有效能力含 `rw` 或验收
需要 `command` 的任务；`accepted` 节点是历史，会保留。Plan 模式下用 `write_plan` 创建或整体替换实现计划，用 `edit_plan` 增量修订已记录的计划，然后停止本轮；
**Build plan** 切到 Semi-Write 或 Full Access 后才恢复写委派。Build 会归档研究任务图，因此构建轮次从空
任务图开始，以计划文件作为交接物。

有效能力含 `rw` 的任务必须至少有一条 `review` 或 `command` 验收标准。worker 批次结束后，运行时派生
**固定内置**的 `reviewer` 或 `tester` 子代理；项目里的同名文件不能削弱验收。worker/验证者的最终消息必须
是单个 JSON envelope，格式错误即 `invalid_output`。每条 acceptance 必须使用任务的精确标准 id，一条标准
一个条目；数量相等且 id 全不相同的列表会按位置映射并记录映射，覆盖不全则是 `invalid_output`。
`command` 标准在只读工作区中运行，测试 shell 只写 scratch；若精确命令必须写工作区，tester 可以在
`$COMONAD_SCRATCH` 下的逐字节副本中运行，并报告精确命令、真实退出码和 `mirror: <path>` note。
结构性规则在工具 schema 与校验里；当前阶段的规则在动态 Tools 与 Orchestration 提示块里。详见
[编排](/zh/guide/orchestration)。

`message` 由编排器和所有子代理共享：每个聊天一个 append-only JSONL 邮箱，位于扩展存储。并行写之前用它
声明文件，任务之间用它交换结果。其他代理的消息是不可信数据，不是指令。

一次委派创建一个隐藏子会话。单任务批次的工具卡带 **Open session**；任务板链接每个子会话。只读覆盖层
显示子提示词、步骤和工具结果。子级继承父策略并只能收紧；审批应答固定 `never`，因此需要询问的调用会被
拒绝。写委派要求父策略自动放行写（`universal_accept`、`blacklist_reject` 或 allow 规则），否则请在主线程
完成写。父级的有效能力含 `ro_plan` 时，子级可读本聊天计划，但永远拿不到 `write_plan` 与 `edit_plan`；
计划只能在根会话中记录或修订。详见
[安全](/zh/guide/safety#编排器与子-agent)。

## Shell 工具

- `run_shell_readonly` 没有任何写权限，且需要 OS 沙箱；`run_shell` 遵循 Sandbox mode，在
  `workspace-write` 下可在工作区内写入。
- `run_shell_test` 保持工作区其余部分只读，只写 `.comonad/scratch/<root-session>`（子级为 `<root-session>/<child-session>`）（`COMONAD_SCRATCH`，且
  `TMPDIR`、`HOME`、`XDG_CACHE_HOME` 都指向其中）。它需要 OS 沙箱和允许写入的 Sandbox mode。
- `start_shell` 启动长时间运行的命令；用 `shell_output` 读取，用 `stop_shell` 停止。
- 前台调用可带 `timeout`（秒），限制在 1–300。
- 有 OS 沙箱时，每个 shell 都在沙箱中运行。见[安全](/zh/guide/safety)。

## 后台任务

`start_shell` 任务没有超时。**Tasks** 视图列出它们，带输出预览和停止操作。停止回合不会停止后台任务。

## MCP

MCP 服务器在[设置文件](/zh/reference/settings)的 `mcpServers` 设置中配置。每个服务器可设置 `capability`、`writeTools`、`exclude` 和
逐工具 `overrides`。工具以 `server__tool` 出现，并经过与内置工具相同的策略门控。见[扩展](/zh/guide/extend#mcp)。

## 下一步

- [命令](/zh/reference/commands)
- [设置](/zh/reference/settings)
- [扩展](/zh/guide/extend)
