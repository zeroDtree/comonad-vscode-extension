# 检查点与审查

Comonad 在项目之外的影子存储里按文件记录 agent 的每次写入，一条写入一条记录。你自己的 `.git` 永远
不会被触碰。不是每轮都做快照：没有写文件的回合零开销，审查也只看日志点名的文件。

```mermaid
flowchart LR
  Write["write_file · apply_patch<br/>apply_edits"] --> Journal["变更日志<br/>改前 + 改后"]
  Journal --> Pending["待处理列表<br/>输入框上方"]
  Pending --> Keep["Keep<br/>写入影子索引"]
  Pending --> Undo["Undo<br/>恢复内容"]
  Pending --> Review["Review<br/>内联 diff"]
  Prompt["编辑提示词 · Regenerate"] --> Restore["Restore files too"]
  Restore --> Journal
```

## 待处理变更

输入框上方的列表显示每个文件及其 `+N −M` 行数。**Undo** 和 **Keep** 作用于全部文件；点击一行会在普通
编辑器里打开该文件，并带内联审查。全部审查完后，列表会保留为 **reviewed** 列表，按最近决定排序；
一旦有新的待处理变更，就切回只显示待处理文件。

- **Keep** 接受一个文件或 hunk。
- **Undo** 恢复 agent 写入之前的内容。
- **Review** 打开 diff 编辑器，按文件或 hunk 决定。

如果你在 agent 上次写入后又编辑过文件，或文件有未保存内容，它永远不会被静默覆盖：审查会询问，或直到
你保存前拒绝。

子 Agent 的文件工具写入记在**主会话**的日志里，而不是它自己的会话。它们与主 Agent 的写入出现在同一个
待处理列表、同一份 diff 和同一组恢复点中。

## 恢复一个回合

用铅笔编辑提示词并重新发送时，如果 agent 在该回合或之后写过文件，会提供 **Restore files too**。
**Regenerate** 会对最后一个回合问同样的问题。两者使用相同的恢复点、脏编辑器和外部修改检查。

因为 fork 与恢复点都在回合边界上，fork 出的聊天永远不会只有工具调用而没有对应的结果。

## 限制

- **`run_shell` 等 shell 命令的改动不会被跟踪。** 这些请用 git 审查。shell 可以改任何文件，而日志只
  知道 agent 自己的写入工具写了什么。`run_shell_test` 在另一个方向上是例外：它只能写 scratch 目录，
  从一开始就不会改动项目文件。
- 旧快照设计留下的影子存储会在日志挂载时删除。它们的会话保留转录，但无法恢复到更早的文件状态。

## 命令

| 命令 | 用途 |
| --- | --- |
| **Comonad: Review Pending Changes** | 打开 diff，按文件/hunk Keep/Undo，或全部处理 |
| `Cmd+Alt+D` / `Ctrl+Alt+D` | 同上 |
| `/review [focus]` | 让 agent 只读审查待处理变更 |

日志是出厂插件树里的一行。关掉 `checkpoints` 会连同服务、审查命令和快捷键一起移除；此后写入就只是
写入，没有撤销故事。

## 下一步

- [上下文](/zh/guide/context) —— 压缩与恢复点
- [安全](/zh/guide/safety) —— agent 能写什么
