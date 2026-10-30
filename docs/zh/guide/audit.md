# 决策轨迹

每个进入运行时策略管线的工具调用都会留下一条授权记录。它不会复制一份策略：每层只写一个不可变的
决策节点，终态事件引用结束本次调用的节点。审计时从终态的 `trace_head_id` 出发，沿 `parent_id`
一路回溯到根节点。

## 记录结构

一个节点就是某一层的决定：

```json
{
  "kind": "node",
  "node_id": "9e0e…",
  "parent_id": null,
  "call_id": "6e0c…",
  "layer": "capability",
  "decision": "allow",
  "matched_rule": "ro",
  "policy_revision": "8f3c1a2b7d4e5f60",
  "reason": "mode sw grants ro",
  "at": 1760000000000
}
```

| 字段 | 含义 |
| --- | --- |
| `node_id` | 节点唯一标识 |
| `parent_id` | 前一个节点；根节点为 `null` |
| `call_id` | 审计用调用 id（UUID，不是供应商的 call id） |
| `layer` | `capability`、`network`、`rules`、`approval`、`response`、`sandbox`、`hook` 或 `plugin` |
| `decision` | `allow`、`ask`、`deny` 或 `no_match` |
| `matched_rule` | 命中的用户规则或策略项；没有则为 `""` |
| `policy_revision` | 本次决定所使用的有效策略版本 |
| `reason` | 简短的人类可读说明 |

只有实际到达的层才会出现。deny 规则在 `rules` 结束；能力不足在 `capability` 结束；allow 规则不会
产生 `approval` 节点。

## 终态事件

每个调用恰好一个终态事件：

```json
{
  "kind": "event",
  "event_id": "e0a1…",
  "call_id": "6e0c…",
  "trace_head_id": "b71f…",
  "event": "dispatch_started",
  "timestamp": 1760000000123,
  "session_id": "…",
  "turn": 3,
  "provider_call_id": "call_0",
  "tool_name": "read_file"
}
```

- `denied` —— 调用没有执行。具体原因在 `reason`（`deny rule`、`approval denied`、`hook`、
  `plugin`、`batch rejected`、`stopped before dispatch` 等）。
- `dispatch_started` —— 调用进入执行；`trace_head_id` 指向 sandbox 节点。

终态事件不复制策略事实。用 `/audit <call_id>` 或 **Comonad: Show Decision Trace** 重建路径。

## 存储位置

```text
<storage>/audit/decisions/YYYY-MM-DD.jsonl
```

每行一个 JSON 对象，三种记录共用一个文件：

- `policy` —— `policy_revision` 对应的完整 `PolicySnapshot`，每个进程内每个 revision 写一次
  （进程重启后可能写一份相同副本；重建时使用任意一份）；
- `node` —— 一个决策节点；
- `event` —— 一个终态事件。

一个调用的所有节点写入它开始当天的文件，即使终态跨过午夜。原有
`audit/YYYY-MM-DD.jsonl` 仍记录用户消息、工具参数/结果和回合结束；其中的工具记录带 `trace_id`
（即同一个 `call_id`），两套日志可以关联。决策文件是按天追加的日志；请按自己的保留策略归档或删除
旧日期。

## 策略版本

revision 是有效策略的短 SHA-256：

- Work mode、有效能力集合和委派工具白名单；
- Network access、Tool approval、Approval response 和 Sandbox mode；
- 三个用户规则列表，按实际生效顺序；
- deny-read 路径，排序后。

任何一项变化都会改变 revision。规则文件只改空白不会改变 revision，因为 revision 基于解析后的规则。
快照记录让审计在设置变更后仍能说明 revision 当时代表什么。

## 重建一个调用

在聊天中运行：

```text
/audit                 # 最近 20 条终态事件
/audit <call_id>       # 一个调用的完整路径
```

或在命令面板运行 **Comonad: Show Decision Trace**，选择最近终态，以 Markdown 文档打开完整路径。
文档按顺序列出每个节点、终态、供应商 call id、会话/回合和策略快照。

因审批挂起的调用在回答或停止之前没有终态；`/audit` 会显示已写入的节点并注明 **no terminal**。

## 不记录什么

- 工具参数和输出。它们仍在原有审计日志中，通过 `trace_id` 关联。
- 提示词、模型回复和密钥。
- 插件内部状态。`tools/pre-execute` 的拒绝记为 `plugin` 节点；`PreToolUse` 拦截记为 `hook` 节点。

## 失败行为

写入轨迹是尽力而为：存储目录不可写时只记一条日志，绝不让回合失败。损坏的 JSONL 行会被跳过，
文件其余部分仍可读取。

## 下一步

- [安全](/zh/guide/safety) —— 轨迹所记录的层
- [设置](/zh/reference/settings) —— revision 所命名的策略值
