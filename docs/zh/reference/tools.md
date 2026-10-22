# 工具

每个工具都声明 **capability**、是否使用**网络**、是否需要**工作区**。注册表在模型看到它之前按这三项
过滤。

## 目录

| 分组 | 工具 |
| --- | --- |
| 文件 | `list_dir`、`read_file`、`grep_files`、`write_file`、`apply_patch` |
| Shell | `run_shell_readonly`、`run_shell_test`、`run_shell`、`start_shell`、`shell_output`、`stop_shell` |
| 计划 | `list_plans`、`read_plan`、`write_plan` |
| 待办 | `todo_write` |
| 数学 | `calculate`、`describe_numbers`、`percentile`、`convert_units` |
| Web | `fetch_url`、`web_search` |
| VS Code | `find_files`、`find_symbols`、`get_diagnostics`、`apply_edits`、`git_diff`、`run_task` |
| Agent | `ask_user`、`agent`（子代理）、`skill`、`memory` |
| MCP | 每个服务器暴露的 `server__tool` |

`read_file` 还可以读取 PNG、JPEG、WebP 和 GIF（单张最多 4 MiB），并作为图像内容交给模型。

## Shell 工具

- `run_shell_readonly` 在只读沙箱中运行；`run_shell` 可在工作区内写入。
- `run_shell_test` 保持工作区只读，只写私有 scratch 目录（`COMONAD_SCRATCH`，且 `TMPDIR`、`HOME`、
  `XDG_CACHE_HOME` 都指向其中）。它需要 OS 沙箱，没有沙箱时直接拒绝。
- `start_shell` 启动长时间运行的命令；用 `shell_output` 读取，用 `stop_shell` 停止。
- 前台调用可带 `timeout`（秒），限制在 1–300。
- 有 OS 沙箱时，每个 shell 都在沙箱中运行。见[安全](/zh/guide/safety)。

## 后台任务

`start_shell` 任务没有超时。**Tasks** 视图列出它们，带输出预览和停止操作。停止回合不会停止后台任务。

## MCP

MCP 服务器在 `comonad.mcpServers` 中配置。每个服务器可设置 `capability`、`writeTools`、`exclude` 和
逐工具 `overrides`。工具以 `server__tool` 出现，并经过与内置工具相同的策略门控。见[扩展](/zh/guide/extend#mcp)。

## 下一步

- [命令](/zh/reference/commands)
- [设置](/zh/reference/settings)
- [扩展](/zh/guide/extend)
