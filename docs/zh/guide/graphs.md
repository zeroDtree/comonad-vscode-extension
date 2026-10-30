# 图

回合的内层循环是一张编译后的 Mermaid 图：模型调用、策略闸门、审批挂起、工具步骤以及它们之间的
路由。**Settings → Graph** 是 Graph 插件的面板。一个源文件可以包含多个命名图：

```mermaid
%% default: agent

%% graph: agent
flowchart TD
  %% start: llm
  llm["llm.complete"] -->|route: agent.after-llm| calls["agent.calls"]
  llm -->|route: agent.after-llm| End
  calls --> gate["agent.gate"]
  gate -->|route: agent.gate| tools["agent.tools"]
  gate -->|route: agent.gate| approval["agent.approval"]
  gate -->|route: agent.gate| reject["agent.reject"]
  approval --> gate
  tools --> llm
  reject --> llm
```

`%% graph: id` 命名一个图，`%% default: id` 指定回合默认使用的图，`%% soft node: instruct` 让模型
选择目标。每个回合只运行默认图；其它命名图仍可供插件通过 `ctx.graphs.get(id)` 使用。

## Graph、Policy 与 Executor

- **Graph** 驱动回合。`agent.calls` 开始一个工具批次，`agent.gate` 把策略结果映射成路由；
  `End` 只能从模型节点到达，因此回合总以模型回合收尾。
- **Policy** 是纯决策：对一个批次返回 `allow`、`confirm` 或 `reject`，并为每条调用给出 trace；
  它不认识节点或路由。
- **Executor**（`agent.tools` 与 `ctx.tools.invoke`）在任何工具体运行前核验 GATE 签发的单次
  `ToolAuthorization`。`agent.tools` 只有一个前驱 `agent.gate`；绕过闸门的自定义图会让调用不带
  授权地到达 Executor，从而被拒绝。
- `agent.approval` 挂起回合，恢复后回到 `agent.gate` 重新决策：策略拒绝或用户拒绝优先，审批通过
  则把 `confirm` 解析为 `allow`。

## 编辑

面板一次编辑一个图：

- 选择器提供 **Set default**、**Duplicate**、**Delete** 和 **+ New**。
- **Whole source** 在同一个缓冲区中编辑整个源文件，而不是选中的图。
- **Validate** 在 **Save** 写入 `comonad.graph` 前检查源文件；**Use shipped default** 清空设置，
  回到内置的 `agent` 图。
- 预览实时渲染选中的图，并列出插件注册的 node 实现和 route。Agent 标签页的 **Max steps** 限制
  整个回合的步数（`0` 表示无限制）。

## 插件

Graph 是 `cordis.yml` 里的一个 row。关掉 **graph** 会让 agent 失去执行引擎，Plugins 标签页会显示
这条依赖。
