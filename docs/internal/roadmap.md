# Comonad 路线图（内部）

> **内部文档。** 不是用户文档，不随文档站发布。已发布的行为以 [CHANGELOG](../../CHANGELOG.md) 和代码为准；
> 本文只记录尚未完成的方向，状态标记可能滞后，不作为功能承诺。

## 定位

把 Comonad 的 Agent 内核（图编排 + 能力门控 + 审批 + 沙箱 + 检查点）做成 VS Code 原生扩展，
入口、上下文、工具与 UI 全部使用 VS Code 的形态，同时对齐 Claude Code / Codex 已验证的扩展性与
安全能力。

设计原则：

1. **本地优先**：密钥进 `SecretStorage`；默认不外发遥测；代码不出本机。
2. **默认安全**：只读起步；写/执行显式升级；完全访问必须显式开启。
3. **一切可审计**：工具调用、审批、diff、checkpoint 全程留痕。
4. **单一管线**：UI 与 headless 共用 `ctx.agent.runTurn`，入口不组装 prompt。
5. **可编程优先**：图、Hooks、自定义命令、MCP、插件都是一等公民。

## 当前状态

已交付的能力见文档站 `docs/` 与 [CHANGELOG](../../CHANGELOG.md)。下面只列后续工作。

## 后续路线

### 运行时

- [ ] Parallel tool calls：同轮工具并发执行，带写冲突与依赖保护。
- [ ] 运行中纠偏（steering）：任务执行中插入消息，不打断运行中的工具。
- [ ] Goals / 自动续跑：持久化目标，结束条件未满足时继续。
- [ ] Agent Teams：多代理协作、消息传递、任务分配。

### 工具

- [ ] Notebook / 调试器（DAP）/ 浏览器（Playwright）工具。
- [ ] 工具容器化执行环境。
- [ ] MCP Resources / Prompts：`@` 引用资源、slash 调用 MCP prompt、Elicitation 表单。
- [ ] 对外 MCP Server 模式：把本代理能力暴露给其他 agent。
- [ ] 第三方工具 Provider API（版本化）。

### 策略与安全

- [ ] 沙箱升级：因沙箱受限失败时，经用户批准后以更高权限重试，绝不自动升级。
- [ ] Prompt Injection 防护：外部内容与子代理输出的指令形态扫描与标记。
- [ ] Auto-review：低风险操作自动批准，高风险仍询问。
- [ ] 企业托管策略：managed settings、锁定模式/沙箱/模型白名单。
- [ ] 数据策略：禁读模板、出网域名白名单、敏感信息脱敏。

### 检查点与审查

- [ ] Checkpoint 时间线视图：每轮变更统计、diff 预览、恢复到任意点。
- [ ] 变更集提交：选中 hunks 生成 commit（可编辑的 conventional commit 信息）。
- [ ] 忽略规则与容量：忽略 `node_modules`/`dist`/大文件；影子仓库 GC。
- [ ] Worktree 隔离：子代理/并行任务在独立 worktree 运行，合并或丢弃。
- [ ] 多根工作区/远程环境的原子回滚。

### 上下文与记忆

- [ ] 渐进式加载：Skills/规则按需进入上下文，控制常驻 token。
- [ ] 记忆作用域：user / project / local；子代理独立记忆。
- [ ] 引用溯源：回答标注使用了哪些上下文元素。
- [ ] 团队共享知识库。

### 扩展与平台

- [ ] Plugins / Marketplace：打包分发 skills / commands / subagents / hooks / MCP 配置。
- [ ] Headless / SDK：`comonad exec`（非交互、JSON / stream-json 输出）、CI 集成、事件流 API。
- [ ] 计划任务：定时/事件触发提示。
- [ ] GitHub：PR 审查/创建、issue 上下文。
- [ ] Windows 原生：PowerShell 工具、Windows 沙箱。
- [ ] 会话跨端接力：VS Code ↔ CLI ↔ Remote。
- [ ] 更多编辑器入口（JetBrains 等）。

### 可观测性

- [ ] Trace 回放：JSONL 完整记录（含流式 delta）。
- [ ] Eval 框架：场景集 → 通过率/成本/时长指标，可进 CI。
- [ ] 一键导出脱敏诊断包。
- [ ] opt-in 遥测（本地优先，遵循 VS Code telemetry 设置）。

## 明确不做

- 云端托管的多租户 agent 平台。
- 浏览器/移动端入口。
- 训练/微调模型。
- 默认启用完全放行模式；`universal_accept + 无沙箱` 只能显式开启并持续提示。
- 替换 VS Code 内置 Chat 的通用能力；定位是“可配置、可审计、图编排的本地 coding agent”。

## 参考

- Claude Code：<https://code.claude.com/docs>
- Codex：<https://learn.chatgpt.com>
- SillyTavern：<https://github.com/SillyTavern/SillyTavern>
