# Comonad for VS Code — Agent 插件 Features 列表

> 调研对象：`pkgs/Comonad`（图式 Agent 内核）、Claude Code（code.claude.com 官方文档）、Codex（learn.chatgpt.com / openai/codex 官方文档）。
> 调研时间：2026-10。本文是功能范围清单，供设计文档与里程碑拆解使用。
> 优先级：**P0** = MVP 必需；**P1** = 首个正式版；**P2** = 后续演进。

## 1. 定位与设计原则

把 Comonad 的 Agent 内核（单一 tool-loop 管线 + 图编排 + 能力门控 + 审批 + 沙箱 + 影子 Git 检查点）移植为 VS Code 原生扩展，入口、上下文、工具与 UI 全部换成 VS Code 形态，同时对齐 Claude Code / Codex 已被验证的扩展性与安全能力。

- 入口：`@comonad` Chat participant + 独立侧边栏面板 + 内联/Code Action
- 模型：DeepSeek 默认（`DEEPSEEK_API_KEY` 环境变量）+ 任意 OpenAI 兼容端点（`comonad.profiles`）
- 工具：Comonad 现有工具（fs/shell/plan/math）+ VS Code 原生工具（编辑/诊断/终端/任务/Git）+ MCP
- 安全：工作模式 × 审批策略 × 沙箱 三层模型，默认只读
- 变更：按文件写入日志（影子 Git）+ VS Code 内联/原生 diff 审查（Keep/Undo）+ 编辑提示词重发（可选文件回退）
- 扩展：Graph 编排、Hooks、Skills、Subagents、Slash Commands、MCP —— 对齐 Claude Code / Codex

设计原则：

1. **本地优先**：密钥进 `SecretStorage`，默认不外发遥测，代码不出本机（除用户显式启用网络工具）。
2. **默认安全**：只读起步；写/执行显式升级；「完全访问」必须显式开启且每次提醒。
3. **一切可审计**：工具调用、审批决定、diff、checkpoint 全程留痕，可回放。
4. **单一管线**：UI 与 Headless 共用同一条 turn 管线（沿用 Comonad `adapters.test.ts` 的约束：入口不组装 prompt、只调用 `agent.runTurn`）。
5. **可编程优先**：图、Hooks、自定义命令、MCP、扩展 API 都是一等公民。

```mermaid
flowchart LR
  subgraph surfaces [VS Code 入口]
    chat["@comonad Chat<br/>侧边栏 · 内联"]
    review["Diff 审查<br/>Keep / Undo / Revert"]
    status["聊天控件<br/>模式 · 审批 · Context · 模型"]
  end
  subgraph core [Comonad 内核]
    agent["Agent Service<br/>turn 状态机 · suspend/resume"]
    graph["Graph 运行时<br/>nodes / routes / soft / subgraph"]
    policy["策略引擎<br/>capability · gate · approval"]
    tools["Tools Service<br/>builtin / MCP / extension"]
    llm["LLM Service<br/>streaming · tool-delta"]
    sessions["Sessions<br/>transcript · cursor"]
    sandbox["Sandbox<br/>sandbox-exec / bwrap"]
    git["影子 Git<br/>checkpoint / keep / undo"]
  end
  chat --> agent
  agent --> graph --> llm
  graph --> policy --> tools --> sandbox
  agent --> sessions
  agent --> git --> review
  status --- agent
```

## 2. 功能清单

### A. 交互入口与会话（Surfaces & Sessions）

**P0**
- [ ] `@comonad` Chat Participant：进入 VS Code Chat 视图，逐 token 流式输出，支持 slash command、follow-up、多轮
- [ ] 独立 Agent 面板（Webview）：模式/审批/模型切换、tool call 卡片、思考折叠、Plan/Todo 进度、审批按钮、停止
- [ ] 编辑器上下文：当前文件、选区、`#problems` 诊断、Git 状态与未提交 diff 自动注入
- [ ] `@` 提及：文件、目录、符号、诊断、Git diff
- [ ] 聊天输入区控件：工作模式 · 审批 · Context · 网络 · 模型 · 待审变更 pill，一键切换（对齐 Comonad send-bar 的 pill 设计，参考 Cursor）
- [ ] 审批 Suspension/Resume：工具调用暂停 → 弹层/内联按钮「允许一次 / 总是允许 / 拒绝」，跨重启可恢复（Comonad cursor）
- [ ] 会话持久化与恢复：每次会话落盘（复用 Comonad sessions），重启恢复、continue 上一会话
- [ ] 会话列表视图（TreeView）：标题、时间、模式、搜索、重命名、删除、导出
- [ ] 流式渲染：Markdown、KaTeX 数学、代码块、Diff 块；reasoning 默认折叠；tool call 可展开查看入参/输出

**P1**
- [ ] 内联入口：编辑器右键 / Code Action「Ask Comonad」「Fix with Comonad」、Inline Chat 集成
- [x] Display / Context 双形态（Comonad）：每轮回复与历史回传都可选 `Rendered`（渲染体）/ `Token`（仅 assistant 文本）/ `Raw`（完整记录）——回复 tab 切换显示，输入区 Context pill 控制回传
- [x] 多模态输入：粘贴/拖拽截图与图片（输入框最多 6 张、单张 4 MiB、合计 12 MiB；`read_file` 同样可读 PNG/JPEG/WebP/GIF）
- [ ] 分支会话：从某条消息 Fork/Branch，与 checkpoint 对齐
- [ ] 后台任务面板：并行会话/子代理的进度、日志、终止
- [ ] 桌面通知：完成、需审批、后台命令结束（可配置）

**P2**
- [ ] 跨端接力：VS Code ↔ CLI ↔ Remote 继续同一会话
- [ ] 会话导出为可复现 Trace（含工具调用与审批记录，可脱敏）

### B. Agent 运行时（Runtime）

**P0**
- [ ] 流式 tool-loop：`llm.complete → tool calls → results → llm.complete …`，事件流 `llm/token`、`llm/reasoning`、`llm/tool-delta`、`agent/tool-start/result`（复用 Comonad llm/graphs/agent）
- [ ] Graph 编排内核：Mermaid 源定义节点与路由；内置节点 `llm.complete` / `agent.confirm` / `agent.reject` / `agent.tools`；路由 `agent.after-llm` / `agent.after-confirm`；`suspend` / `resume`；`maxSteps` / `maxDepth`（Comonad runtime 移植）
- [ ] Soft route：模型在候选节点中以 JSON Schema 约束选择下一节点（Comonad `llm.choose`），用于「提问 or 执行」等分支
- [ ] 中止/停止：流式中止与工具执行中止（AbortSignal 贯穿）
- [ ] Turn 状态机：transcript（完整记录）与 model messages（实际回传）分离；`turnIndex`；错误分类与重试
- [ ] 并发保护：同一 session 单 turn；不同 session 可并行

**P1**
- [ ] 默认 Graph 集：`chat`（纯对话）、`code`（读写 + 验证循环）、`plan`（只读 + 产出计划）、`review`（只读 + 代码审查）、`research`（只读 + 检索）
- [ ] Graph 可视化编辑器：图源编辑 + Mermaid 实时预览 + 编译错误提示 + 节点/路由符号补全（复用 `graphs.replace` 的校验与回滚）
- [ ] 自定义 Graph / Recipe：保存、命名、按命令或快捷键启动
- [ ] Parallel tool calls：同轮工具并发执行（带写冲突与依赖保护）
- [ ] 子代理执行：独立上下文窗口、结果摘要回传、深度/并发上限、可后台运行
- [ ] Fork 执行：继承完整上下文的一次性分支任务（Claude Code fork 思路）
- [ ] Prompt 组装管线：系统提示 + 指令文件 + 上下文元素 + 历史 + 工具定义；稳定前缀利于 prompt cache；上下文预算控制
- [ ] 每节点/每代理模型路由：轻量模型做摘要/探索，强模型做编码/规划；模型降级链
- [ ] 运行中纠偏：用户可在任务执行中插入消息（steering），不影响运行中工具

**P2**
- [ ] Goals / 自动续跑：持久化目标，结束条件未满足时自动继续（Codex goals）
- [ ] Verify 循环：完成后自动跑测试/构建，失败自动修复（图节点化）
- [ ] Agent Teams：多代理协作、消息传递、任务分配（Claude Code agent teams）
- [ ] Workflows：多阶段编排（研究 → 计划 → 执行 → 验证 → 审查）与阶段间产物

### C. 工具系统（Tools）

**P0**
- [ ] 移植 Comonad 工具：`list_dir`、`read_file`、`grep_files`、`write_file`、`apply_patch`、`list_plans` / `read_plan` / `write_plan`、`evaluate` / `describe` / `percentile` / `convert`
- [ ] `run_shell_readonly`（沙箱只读）/ `run_shell`（沙箱可写），复用 Comonad shell 插件
- [ ] 工具元数据：`capability`、`needsNetwork`、`needsWorkspace`、JSON Schema、来源（builtin / mcp / extension）
- [ ] 工具可见性：按模式 + 网络 + 工作区三重过滤（Comonad `tools.visible`）
- [ ] MCP 客户端：stdio / Streamable HTTP / SSE；服务器配置 UI；每服务器默认 capability 与逐工具覆盖；增删/启停/重连；工具名前缀 `server__tool`（Comonad mcp 插件）
- [ ] 工具目录视图：搜索、过滤、查看描述与策略、单测调用

**P1**
- [ ] VS Code 原生工具：`WorkspaceEdit` 多文件编辑、创建/删除/重命名文件、读诊断、符号搜索、跳转定义/引用
- [ ] 终端/任务工具：用户终端（Shell Integration）或沙箱隐藏运行；读取输出；运行 VS Code Task / Tests 并解析 Problem Matcher
- [ ] Git 工具：status / diff / stage / commit / branch / PR（`gh`）
- [ ] 后台命令：长任务后台化，输出轮询、完成通知、任务面板可见（Claude Code `Ctrl+B` / Codex unified exec）
- [ ] Web 工具：URL 抓取（大小/超时限制）、Web 搜索（off / cached / live 安全模式，对齐 Codex）、文档检索
- [ ] Ask-User-Question 工具：结构化多选题并渲染为 Chat 选项
- [ ] Todo 工具：任务列表创建/更新/完成，UI 进度展示
- [ ] Agent 工具：派生子代理（类型、后台、模型覆写），结果回传
- [ ] 工具输出整形：截断与分页、大文件提示、diff 内嵌、错误规范化（图片已内嵌：工具读到的图片随结果发给模型，卡片显示缩略图）
- [ ] 自定义工具 API：其他扩展注册工具（schema + handler + 能力标注），纳入同一门控

**P2**
- [ ] Notebook 工具：编辑 Jupyter cell
- [ ] 调试工具：启动/附加调试（DAP）、断点与调用栈
- [ ] MCP Resources / Prompts：`@` 引用资源、slash 调用 MCP prompt、MCP Elicitation 表单
- [ ] 浏览器工具：Playwright/内置浏览器控制（UI 测试、截图）
- [ ] 工具容器化执行环境

### D. 策略与安全（Policy & Security）

**P0**
- [ ] 工作模式（Comonad）：`ro` / `sw` / `aw` / `pl` → capability 集合（`ro` / `shell_ro` / `rw` / `shell_rw` / `rw_plan`）
- [ ] 审批策略（Comonad）：`manual` / `whitelist_accept` / `blacklist_reject` / `universal_accept` / `universal_reject`；非交互会话 confirm 自动降级为 reject
- [ ] 门控管线：模式/网络过滤 → 审批策略 → 沙箱执行；拒绝原因写回模型（Comonad `gateTools`）
- [ ] 沙箱：macOS `sandbox-exec`（SBPL）/ Linux `bwrap`；工作区只读/可写；`denyReadPaths`（如 `.env`）；网络开关；命令超时；输出截断
- [ ] 路径安全：`resolveInside` 防越界、计划文件 basename 限制
- [ ] Workspace Trust 集成：不受信任工作区自动只读，忽略项目 hooks/指令
- [ ] 危险操作确认：删除、强推、批量改写、越界写入二次确认
- [ ] 审批记忆：「总是允许」写入作用域（会话 / 工作区 / 用户），可见可撤销

**P1**
- [ ] 权限规则引擎（Claude Code 风格）：`allow` / `ask` / `deny`，语法如 `Bash(npm run test:*)`、`Read(./.env)`、`Edit(src/**)`、`WebFetch(domain:...)`；多作用域规则合并
- [ ] 统一模式预设：Ask（默认）/ Plan（只读+计划）/ Auto（自动批准读写，网络关闭）/ ReadOnly / FullAccess（默认隐藏，显式开启）
- [ ] 沙箱升级：工具因沙箱受限失败时，用户批准后以更高权限重试（Codex 风格），绝不自动升级
- [ ] 受保护路径：`.git`、`.comonad` 等禁写（Codex protected paths）
- [ ] Prompt Injection 防护：外部内容（网页/工具输出）指令形态扫描与标记；子代理输出回传前扫描（Claude Code subagent output scanning）
- [ ] 环境变量过滤：子进程转发白名单，含 `KEY`/`SECRET`/`TOKEN` 的变量剔除（Codex shell_environment_policy）
- [ ] 审计日志：工具调用 + 策略判定 + 审批人 + 时间，可导出

**P2**
- [ ] Auto-review：安全分类器自动批准低风险操作，高风险仍询问（Claude Code auto mode / Codex auto-review）
- [ ] 企业托管策略：managed settings、锁定关键项（模式/沙箱/模型白名单/禁用完全访问）
- [ ] 数据策略：禁读模板、出网域名白名单、敏感信息脱敏

### E. 变更管理与检查点（Checkpoints & Review）

**P0**
- [ ] 影子 Git（Comonad 原样）：每 session × workspace 一个影子仓库，`GIT_DIR=~/.comonad/...`，绝不触碰用户 `.git`
- [x] 按文件的编辑日志（替代每轮整库快照）：agent 的每次写入经 `ToolContext.edit` 记录改前/改后内容；无写入的轮次零开销；不设上限。shell 写入不跟踪（同 Claude Code / Cursor）
- [x] 文件回退：编辑某轮提示词并重发时，可选把该轮起被 agent 写过的文件恢复到该轮之前（复用 restore point；不做 `clean -fd`）；外部修改逐文件或一次全部确认；未保存的编辑器文档拒绝覆盖
- [ ] Pending 变更面板：未接受文件列表 + 数量，Keep All / Undo All
- [ ] Diff 审查（VS Code 原生 diff 编辑器）：单文件/单 hunk Keep / Undo，hunk 导航

**P1**
- [x] 编辑已有提示词并重发：用户消息悬停出现铅笔图标，气泡原地变成 textarea（Enter 重发 / Shift+Enter 换行 / Esc 取消）；该轮旧回复及之后所有轮次被丢弃；若该轮或之后写过文件，编辑器提供 **Restore files too**（脏编辑器拒绝、外部修改确认）；**Regenerate** 同样询问是否连同文件恢复
- [x] 代码块语法高亮：`resources/highlight.js`（highlight.js common 语言包，构建时生成）在 `chat.js` 之前加载；回复/命令中的围栏代码块按语言高亮（Python、JS/TS、JSON、shell、C/C++、Java、Go、Rust、SQL、Markdown 等），未知语言自动检测，`text/plaintext` 保持纯文本；shell 工具卡片命令同样高亮；Copy 仍复制源码
- [x] 输入框上方变更列表（Cursor 式）：待审查文件 + `+N −M` 行数、Undo / Keep / Review；点击文件打开正常编辑器（带 inline diff 块与 Keep/Undo），列表可折叠；全部审核完后列表保留为 **Reviewed**（按审核时间倒序、无操作按钮），一旦有新变更则只显示待审查文件
- [x] `@` 显式引用（Cursor 式）：输入 `@` 打开 Files / Folders / Symbols / Current selection 选择器（键盘导航）；插入 `@path`、`@path:9-13`、`@path/`、`@symbol:path:Name` 等文本 token；在编辑器中选中代码后按 **Cmd+L**（`Ctrl+L`）直接把该选区 token 追加到聊天输入框（编辑器右键菜单同项）；发送/重发/Regenerate/编辑重发时按会话策略解析为带行号、受预算与 deny/隔离规则约束的上下文；转录中 token 显示为 chip；缺失/被拒绝的引用变成错误块而不阻断回合
- [ ] Checkpoint 时间线视图：每轮变更统计、diff 预览、恢复到任意点
- [ ] 变更集提交：选中 hunks 生成 commit（AI 信息、conventional commits、可编辑）
- [ ] 忽略规则与容量：`node_modules`/`dist`/大文件忽略；影子仓库 GC
- [ ] 与用户 Git 协作：不自动 stage 用户改动；仓库异常时降级提示

**P2**
- [ ] Worktree 隔离：子代理/并行任务在独立 git worktree 运行，合并或丢弃（Claude Code `isolation: worktree`）
- [ ] 多根工作区/远程环境的原子回滚
- [ ] 快照加密或脱敏（可选）

### F. 上下文与记忆（Context & Memory）

**P1**
- [ ] 指令文件体系：项目 `COMONAD.md`（兼容读取 `AGENTS.md`）、用户级、企业级；`@path` 导入；排除规则
- [ ] 路径作用域规则：`.comonad/rules/*.md` + `paths:` frontmatter，按需加载（Claude Code rules）
- [ ] 自动记忆：模型维护 `MEMORY.md` 索引 + 主题文件；启动加载上限（200 行 / 25KB）；可审计可编辑（Claude Code auto memory）
- [ ] 上下文装配：`@` 提及、当前文件/选区、诊断、Git 快照、diff、终端输出 → 结构化注入并显示来源
- [x] 上下文视图：`/context` 分解窗口、输出预留、系统提示与工具定义开销、转录 token、指令文件与摘要覆盖范围；composer 状态行显示 `context 43% · 55K/128K`（取自 provider 报告的真实 prompt 大小）
- [x] 窗口与压缩：窗口取自模型 profile（`contextWindow`），Auto 自动解析、手动档覆盖；超出窗口时**摘要并继续**（不丢弃整轮）——最新请求逐字保留、增量复用旧摘要、摘要失败不动历史；轮内先省略旧工具输出再摘要；端点以「too long」拒绝时压缩后重试一次；压缩后 restore point 同步重定位（落在折叠区内的丢弃）；`/summarize`（`/compress`、`/compact` 别名）；`/context` 报告窗口、预算拆分与上一次请求的真实占用
- [ ] 渐进式加载：Skills/规则按需进入上下文，控制常驻 token

**P2**
- [ ] 记忆作用域：user / project / local；子代理独立记忆
- [ ] 团队共享知识库
- [ ] 引用溯源：回答标注使用了哪些上下文元素

### G. 扩展与自动化（Extensibility & Automation）

**P1**
- [ ] Skills：`SKILL.md`（name / description / allowed-tools）发现与调用；用户/项目作用域；可选择在子代理上下文执行
- [ ] Slash Command：内置（`/init` `/plan` `/review` `/compact` `/clear` `/cost` `/status` `/permissions` `/model` `/help`）+ 自定义命令（Markdown frontmatter：description、argument-hint、allowed-tools、model；`$ARGUMENTS`；`!` 执行 shell；`@` 引用文件）
- [ ] Hooks 生命周期：SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、Stop、SubagentStop、PreCompact、PostCompact、FileChanged、ConfigChange；handler 支持 command / HTTP / MCP-tool / prompt；matcher 与 `if` 条件（权限规则语法）；决策输出（allow / deny / ask、附加上下文、改写入参）；异步 hook；hooks 浏览 UI；全局禁用；项目 hooks 绑定 Workspace Trust（对齐 Claude Code）
- [ ] Subagents（定义式）：YAML frontmatter（name / description / tools / disallowedTools / model / permissionMode / maxTurns / skills / mcpServers / hooks / memory / background / isolation）；作用域 managed / 项目 / 用户 / 插件；内置 Explore / Plan / Review；@ 提及调用；前后台；并发/深度限制；独立 transcript
- [ ] MCP 配置发现：`.mcp.json` / 设置文件 / 项目级配置

**P0（已落地）**
- [x] **插件系统（Cordis 行 + `cordis.yml`）**：整个扩展是一棵按 `{ id, name, disabled, config }` 写下的行组成的 Cordis 树；项目 `<ws>/.comonad/cordis.yml` 与用户 `~/.comonad/cordis.yml` 可以关掉任一行、给它单独配置，或挂载自己的插件（`./mine.js` 或已安装的包）。插件 = `export const name` + 可选 `inject`（必须声明，cordis 拒绝未声明的属性）+ `apply(ctx, config)`；`apply` 里注册的一切都是该插件的 effect，行被卸载时随之消失；导出 `Config`（schemastery）的行在 `apply` 前校验配置。行为异常的行会被单独报告（`pending: waiting for …` 或抛出的错误），其余树照常加载。行不能 `inject` 宿主自身的 `ctx.plugins`，只能 `ctx.get('plugins')`（宿主正是挂载它的东西）。
- [x] **ST 内容层是一个「装上去才有」的插件，不是内置功能**：代码整体搬到独立包 `packages/comonad-plugin-tavern`，独立打包（`npm run build:plugins`，包含在 `npm run compile` 里），由插件宿主在运行时加载 —— 出厂行表里没有任何一行提到它，所以 `dist/extension.js` 里根本没有内容层代码：没有内容库、没有 `lore_lookup`、没有 `/char` `/persona` `/lore` `/preset`、也没有 **ST** 标签页，直到那一行存在为止。**Settings → Plugins → Install…** 会按名字提供它（也接受任意插件文件夹）：把文件夹复制到 `~/.comonad/plugins/<id>`、往你的 `cordis.yml` 写一行，然后重新应用列表；行上点 **Uninstall** 即完整卸载（确认后删行 + 删文件夹，插件随之 dispose；手动删其一也可以）。装上之后内容库、`/char` 等命令与 ST 面板如常出现；提示词的行为见下一条。
- [x] **ST 启用即接管提示词**：插件已加载且 `tavernEnabled=true` 时，**每个用户回合都由 ST 集合组装**（Comonad 块 + 角色/人设/世界书 + 预设 + 对话）；没有选择预设时使用内置 **Default**（`promptCollection(undefined)`），`Start from Default` 才写出可编辑副本，加载插件本身不写文件。Comonad 的 9 个块（Identity/Tools/Instructions/Memory/Todos/Skills/Sub-agents/Lore index/Context）是普通预设条目：可排序、可启停，文本只读，并在预设编辑器与顶层 **Prompts** tab 中显示当前值。恰好一个 **Tools** 条目控制 API 工具开关；工具定义仍走 `tools` 参数，关闭后请求不带工具，执行前拒绝调用。只有插件缺席、`tavernEnabled=false` 或 compose 抛错时才回退 `[system, …history]`；子 agent、摘要与 chooser 不属于聊天回合，不受接管。
- [x] **顶层 Prompts tab**：Inspect 里的 Prompts 子 tab 移出为独立页面，只列 Comonad 的 9 个块与工具定义，不再显示 ST collection。块可编辑**静态前缀**、排序、启停；动态正文每轮生成、只读预览。工具定义（name/description/schema/capability）只读，可排序、单独启停；关闭的工具不进入 API tools，执行前也会被拒绝。ST 接管时，块顺序/开关只读镜像当前 ST 预设（按钮跳到 ST → Presets），前缀覆盖仍进入 composed 请求；内核顺序/开关只在 ST 关闭时用于 fallback。持久化为 `comonad.prompts`（`{id,enabled,prefix}` 数组）与 `comonad.toolPrompts`（`{name,enabled}` 数组）。
- [x] **Markdown 数学是一个可安装的 KaTeX 插件**：`packages/comonad-plugin-math` 通过新的 `chatWebview` 资产贡献服务把自己的浏览器 bundle、KaTeX 样式与字体注入聊天 webview（加载在 `chat.js` 之前）；核心在 `inline()`/`md()` 里识别 `$...$`、`$$...$$`、`\(...\)`、`\[...\]` 并调用 `window.__comonadMath`，没有插件时保持字面文本；代码块不渲染。插件 webview 脚本还安装选区复制处理器：选中聊天内容后复制得到原始 Markdown，公式回写为 `$...$` / `$$...$$`，代码为围栏，其余按标题/列表/强调/链接重建；消息自带的 Copy 按钮仍复制精确原文。Settings → Plugins → Install… 安装，卸载即回到字面文本。
- [x] **影子 git 日志是出厂行表里的内置行，ST 内容层才是可安装插件包**（只有 `packages/comonad-plugin-tavern` 被点名为插件）：journal 在 kernel 组默认装载——不可逆的写入是比影子仓库更糟的默认——`cordis.yml` 一行关掉它；tavern 装法为 Settings → Plugins → Install…（名称来自 `comonad.plugin` 清单块）。journal 行关掉时写文件就只是写文件（不记录、工具不受影响），review 命令与 `cmd+alt+d` 随行消失；agent 通过 `ctx.get('checkpoints')` / `ctx.get('tavern')` 读取二者，而不是作为注入项 —— 没有装 tavern（或 `tavernEnabled=false`）时一轮对话才退化为 `[system, …history]`。
- [x] **内核与内容层的边界按"缺席是否仍是完整产品"划**：① **设置随插件走**——tavern/WI 的 37 个键、默认值与类型全在插件自己的 `lib/settings.ts`（`TAVERN_SETTING_KEYS`），内核 `Config`/`CONFIG_KEYS` 一无所知，写入仍走 `ctx.settings.update`（泛型字符串键），`Host.config()` 报告 manifest 声明的全部键（内核的与插件的一视同仁）；parity 测试改为 manifest = `CONFIG_KEYS` ∪ `TAVERN_SETTING_KEYS` ∪ deprecated。② **词汇模块收窄为纯类型**——`src/lib/tavern/types.ts` 只剩类型（ST 磁盘格式的镜像），值各自归位：WI 常量/`worldEntry` 在包的 `lib/lore.ts`、regex/persona/preset/library/tags 的常量在各自模块；生成类型（`GenerationTrigger` 一族）是内核自己的词汇（`/continue` 等是内置命令），移入 `src/lib/generations.ts`，包经 `@comonad/lib/generations` 引用。③ **vectors 归 tavern**——`vectors` 服务与 `lib/vectors.ts` 迁入包内、由 `Tavern` 挂载（唯一顾客是 vectorized 词条），`compose` 变 async 自己做语义检索（`external` 参数删除）；`ComposeResult` 携带 `overflowAlert` 与 `automations`，agent 不再读任何 `wi*`/`tavern*` 设置。④ **分词器三明治**——内核只留 tiktoken + 字节估算 + `ctx.tokenizers.use(provider)` 插座；SillyTavern 的 tokenizer 文件链（upstream 下载表、`tokenizerDir` 检出、`@agnai/web-tokenizers`）成为 tavern 装入的 provider（`lib/tokenizers.ts`）。⑤ 检查点收回内置树（`src/services/checkpoints.ts` + `src/lib/diff.ts` + `src/ui/review.ts`，一行 `checkpoints` 连服务带 review），`packages/` 只剩 tavern 一个包。
- [x] **设置面板按「pane」绘制，而不是写死标签页**：`panes` 服务收集插件贡献的 pane（标签、markup、样式表、脚本、可选编辑器，以及它自己拥有的配置键）。面板在每次状态推送时把每个 pane 自己的那一片喂给它，保存时逐个询问它负责的键 —— 所以宿主配置表里没有角色/世界书这些键。ST 标签页、它的客户端文件（`worldinfo.js`/`persona.js`/`content.js`/`st.js`）与编辑器全部来自 tavern 包自己的目录；行关掉时文档里连标签都不存在。面板之前挂载的 `host`/`log`/`settings` 三个服务照旧不是行。
- [x] **安装的插件会「借到」平台模块**：从 `~/.comonad/plugins` 加载的插件无法从自己目录解析平台模块，Comonad 就在它旁边生成 `~/.comonad/plugins/node_modules/{cordis,schemastery,vscode}` —— 指向当前进程的桥（与 harness 垫片同一套办法），于是插件里的 `Service` 子类与树共用同一个 cordis，`vscode` 就是扩展宿主自己的模块；CJS 与 ESM 都可以，`require('cordis')` 与 `import { Service } from 'cordis'` 都可用。
- [x] **DeepSeek Harness 插件兼容**：`harness` 行重定向全部 `@deepseek-ai/*` 导入 —— `@deepseek-ai/cordis` 就是本树的 cordis（插件自己的 `Service` 子类能被树看见）、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-tools` 的 `defineTool`、`@deepseek-ai/dsh-llm` 的 `createUserMessage`（生成的垫片放在 `~/.comonad/shims` 可读）；harness 的工具与策略半边可用：`ctx.tools.register()` 同时接受 Comonad spec 与 harness `ToolDefinition`，四个瀑布 `tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/result` 沿用 harness 的载荷与决策（`{kind:'deny',reason}`、`{kind:'accept',content}`、`{kind:'block',feedback}`，`ask` 走审批面板）。未实现的 agent/session 内部（`ctx.agents`、`session/event`、PTC 运行时）解析为空模块并在日志点名。

- [x] **插件面板（Settings → Plugins）**：按加载顺序列出每一行的来源（扩展自带 / 本工作区 `cordis.yml` / 用户 `~/.comonad/cordis.yml`）、解析目标与状态（`loaded` / `off` / `not loaded` + 悬停显示原因，例如 `pending: waiting for tools`）；`Disable`/`Enable` 在受信任的工作区写入工作区列表、否则写入用户列表，随后**只重新应用这一行**（不等价于整棵树重载 —— 面板自己就是这棵树的一行，整树重载会在点击过程中把它拆掉，表现成「点了没反应」）；被它 inject 的行会随之失活并在悬停里说明在等谁（`pending: waiting for tavern`），它回来时这些行也跟着回来；表里的状态直接从 live fiber 读取而不是装载时的快照。手工保存 `cordis.yml` 会立即整表应用（宿主能分辨哪些改动是自己写的）。`Apply the list again` 手动整表重载。关掉 `tavern` 行后 ST 标签消失，从这个面板重新 Enable 即可恢复。

- [x] **依赖表（Settings → Inspect → Plugins）**：逐行列出 provides / needs（含提供者；Comonad 在树之前挂载的 `host`/`log`/`settings` 标 `(built in)` —— 它们不是行、无法关闭；无人提供的写 `?name`）/ needed by / layer / state（`loaded`/`off`/`waiting`/`failed`，原因在悬停里）；点任意一行输出该行的**依赖树**（它站在什么上、关掉它会连带停掉哪一整条链）。数据直接读 live fiber（含经插件内部嵌套提供的服务），行在 `app.ts` 里声明所属层。**（图已按需求去掉，只留表格。）**

**P2**
- [ ] Plugins / Marketplace：打包分发 skills / commands / subagents / hooks / MCP 配置
- [ ] Headless / SDK：`comonad exec`（非交互，JSON / stream-json 输出）、CI 集成、事件流 API（对齐 `codex exec`、Claude Code headless/SDK）
- [ ] 计划任务：定时/事件触发提示（本机睡眠/关闭限制需注明）
- [ ] 对外 MCP Server 模式：把本代理能力暴露给其他 agent
- [ ] 第三方扩展 API：工具 Provider、上下文 Provider、审批 Provider、渲染器、事件总线（版本化）

### H. 模型与提供商（Models & Providers）

**P0**
- [x] 模型接入：OpenAI 兼容流式端点（内置 DeepSeek profile，key 取 `DEEPSEEK_API_KEY` 或钥匙串）；按能力降级（无工具 → 纯聊天并提示）
- [ ] 自带端点：OpenAI 兼容 base URL + key + model；复用 Comonad 连接解析（多家 provider 预设、反向代理、自定义 URL、endpoint 区域选项）
- [ ] 凭证：`SecretStorage` 存取 key、UI 脱敏（keyHint）、环境变量覆盖
- [x] 会话级模型绑定与切换（聊天面板：模型菜单含 Reasoning 思考强度与 Context 预算）
- [ ] 采样参数透传：temperature / top_p / max_tokens / stop；reasoning 参数映射
- [ ] 工具调用协议适配：OpenAI tools、streaming tool-delta 组装（Comonad `ToolSlots`）、`reasoning_content` 流

**P1**
- [ ] Provider / Profile：命名配置（模型、端点、参数、代理）与快速切换；模型能力元数据（tools / vision / context window）
- [ ] 子任务模型路由：每个 Graph / Subagent 可指定模型
- [ ] 降级链与重试：超载/限流指数退避；模型不可用自动降级
- [ ] JSON Schema 结构化输出（soft route / 计划 / 表单），不支持时降级解析
- [ ] 本地模型：Ollama / LM Studio 等 OpenAI 兼容端点

**P2**
- [ ] 配额暂停与自动恢复
- [ ] Fast mode / service tier 支持
- [ ] 成本预算与告警（会话/项目/周期）

### I. 设置与配置（Settings）

**P0**
- [ ] `contributes.configuration`（VS Code 原生设置）+ Webview 设置面板（Comonad 风格 Tab：Agent / Modes / Models / Tools / MCP / Graph / 关于）
- [ ] 新会话默认值：模式、审批、网络、工作目录、超时、显示/上下文形态（Comonad settings defaults）
- [ ] 工作目录选择器：文件夹浏览 + 过滤搜索（Comonad browse 接口移植）
- [ ] API key 管理（SecretStorage）与连接测试

**P1**
- [ ] 项目配置 `.comonad/config.toml`（仅受信任工作区加载；层级：CLI/会话 > 项目 > Profile > 用户 > 默认，对齐 Codex）
- [ ] Profiles：命名配置组合（如「只读审阅」「全自动本地」）
- [ ] JSON Schema 与校验：配置补全/校验/错误提示；Graph 编译校验
- [ ] 导入/迁移：从 Comonad `settings.json` 迁移；`AGENTS.md` / `CLAUDE.md` 习惯兼容（`/import`）
- [ ] Feature Flags：实验特性显式开关（对齐 Codex `[features]`）
- [ ] 国际化：zh / en（Comonad locale）

**P2**
- [ ] 企业托管配置与锁定项
- [ ] 设置同步与团队模板

### J. 可观测性（Observability）

**P1**
- [ ] `/status`：模式、审批、模型/Provider、沙箱状态、上下文占用、已加载指令文件、MCP 状态、hooks 数量
- [ ] Output Channel + 调试日志文件；Graph 编译 / MCP 连接 / 沙箱调用诊断
- [ ] 每轮统计：耗时、token（输入/输出/缓存）、工具调用数与失败率
- [ ] 成本视图：`/cost`，按会话/日/模型汇总
- [ ] Trace 回放：JSONL 完整记录（含流式 delta），用于调试与评测

**P2**
- [ ] Eval 框架：场景集 → 通过率/成本/时长指标，可进 CI
- [ ] 遥测（opt-in、本地优先、遵循 VS Code telemetry 设置）
- [ ] 一键导出脱敏诊断包

### K. 平台集成（Platform）

**P0**
- [ ] 多根工作区：选择根文件夹作为工作目录，每根独立 checkpoint
- [ ] macOS / Linux 优先；Windows 降级（无 sandbox-exec/bwrap → 需确认模式）
- [ ] Remote / WSL / Containers：作为 workspace extension 运行；检测沙箱可用性并提示降级

**P1**
- [ ] Windows 原生：PowerShell 工具、Windows 沙箱（Codex elevated 思路）
- [ ] 快捷键：停止、切换模式、新会话、聚焦输入、批准/拒绝、（可选）Vim 模式
- [ ] GitHub：PR 审查/创建、issue 上下文（`gh` 或 GitHub MCP）

**P2**
- [ ] 任务与 CI：GitHub Actions 无头运行、PR 自动审查
- [ ] 云端委托：任务委托到远程执行环境（自托管 runner 或对接云服务）
- [ ] 其他编辑器入口（JetBrains 等）

### L. 非目标（本阶段暂缓）

- [ ] 不做云端托管的多租户 agent 平台
- [ ] 不做浏览器/移动端入口
- [ ] 不训练/微调模型
- [ ] 不默认启用完全放行模式；`universal_accept + 无沙箱` 只能显式开启并持续提示
- [ ] 不替换 VS Code 内置 Chat 的通用能力，定位是「可配置、可审计、图编排的本地 coding agent」

## 3. 与三个参考来源的对照

| 功能域 | Comonad（现有内核） | Claude Code | Codex | 本插件取舍 |
| --- | --- | --- | --- | --- |
| Turn 管线 / 流式 | ✅ agent/graphs/llm | ✅ | ✅ | P0 复用 |
| 图编排 / soft route | ✅ 独有 | 固定流程（plan mode 等） | goals 等特性 | P0/P1 强化 + 可视化 |
| 工作模式 / 能力集 | ✅ ro/sw/aw/pl | ✅ permission modes | ✅ sandbox modes | P0 统一为「模式 × 审批 × 沙箱」 |
| 审批策略 | ✅ 5 档 | ✅ allow/ask/deny 规则 | ✅ on-request/never + profiles | P0 + P1 合并两者 |
| 沙箱 | ✅ sbpl / bwrap | ✅ sandboxing | ✅ seatbelt 等 | P0 复用 Comonad |
| 影子 Git 检查点 | ✅ 完整 | ✅ checkpoint / restore | git 建议式 | P0 复用 + VS Code UI |
| Diff 审查 Keep/Undo | ✅（ST UI） | ✅ IDE diff | ✅ review | P0 做 VS Code diff |
| 会话持久化/恢复 | ✅ | ✅ resume / fork | ✅ resume | P0 |
| MCP | ✅ 客户端 | ✅ 客户端 / resources / prompts | ✅ 客户端 + server | P0 客户端，P2 server |
| Hooks | 仅内部事件 | ✅ 生命周期 + 多 handler | ✅ hooks.json | P1 对齐 Claude Code |
| Subagents | ❌ | ✅ 定义式 / 并行 / 后台 | ✅ multi_agent | P1 |
| Skills / Commands | CLI 命令 | ✅ skills / commands | ✅ skills / plugins | P1 |
| 记忆 / 指令 | ❌（prompt 由外部组装） | ✅ CLAUDE.md + auto memory | ✅ AGENTS.md + memories | P1 |
| 上下文管理 | 部分（display/context 形态） | ✅ compact / context | ✅ | P1 |
| Headless / CI | ✅ CLI REPL | ✅ -p / SDK / Actions | ✅ exec | P2（扩展 CLI） |
| 成本可观测 | ❌ | ✅ /cost | ✅ | P1 |
| 企业托管 | ❌ | ✅ managed settings | ✅ requirements.toml | P2 |

## 4. 里程碑建议

- **M0（可用）**：P0 —— Chat 入口、turn 管线、fs/shell 工具、模式+审批+沙箱、影子 Git + diff Keep/Undo、会话持久化、BYO 模型（默认 DeepSeek）、基础设置面板
- **M1（好用）**：Plan 模式、`/review`、MCP、后台任务、Todo、上下文压缩与 `/context`、Graph 可视化编辑、前台 Subagents
- **M2（可扩展）**：Hooks、Skills、自定义命令、记忆体系、后台/并行 Subagents、成本统计、Headless CLI
- **M3（平台化）**：Agent Teams、Worktree 隔离、企业策略、GitHub/CI/定时任务、插件市场

## 5. 风险与开放问题（待设计文档回答）

1. **Chat 渲染边界**：tool call 卡片、审批按钮、diff 交互如何在 Chat participant 与 Webview 之间分工？
2. **模型能力差异**：各家 OpenAI 兼容端点的 tool calling / 采样限制；降级与提示策略。
3. **沙箱可用性**：Remote / WSL / Windows 下 sbpl/bwrap 缺失时的替代（降级为需确认模式）；频繁 spawn 的性能与长驻沙箱方案。
4. **影子 Git 性能**：大仓库全量快照的代价；ignore 与增量策略；影子仓库容量与 GC。
5. **Hooks 安全模型**：项目级 hooks 必须绑定 Workspace Trust + 首次运行确认，避免仓库即执行。
6. **Graph 复杂度平衡**：默认图必须开箱即用，图编辑面向高级用户；配置错误需可定位、可回滚（复用 `graphs.replace` 的事务式校验）。
7. **多会话并发**：同一工作区两个 session 同时写与 checkpoint 冲突的仲裁。
8. **与用户 Git 共存**：Keep 只影响影子仓库 index，明确边界，绝不改写用户 index/history。
9. **外部内容防护**：web fetch / MCP 输出进入 prompt 的注入防护与审计。

## 6. 实现进度（本次会话）

代码位于仓库根 `src/`（扩展本体）。扩展已按 **Cordis**（`cordis@4`）完全重写：`src/app.ts` 是唯一的插件树组装点，`src/main.ts` 在 `activate` 中创建根 `Context` 并挂载应用，`deactivate` 时 dispose 根 fiber，所有注册（工具、MCP 子插件、UI 资源、webview）随所属插件自动撤销。`src/lib/` 为不依赖 vscode/cordis 的纯逻辑；`src/services/`、`src/ui|tools|llm/` 是服务与插件——`inject` 声明依赖、`ctx.effect()` 表达可逆副作用、跨模块信号一律走类型化事件（`agent/*`、`sessions/changed`、`approval/request` waterfall 等）；`src/test/harness.ts` 以假 Host 挂载真实服务，直接做无头集成测试。

**已实现（可构建、可运行、经单元测试）**

| 域 | 实现内容 | 关键文件 |
| --- | --- | --- |
| A 入口与会话 | **独立 Chat 面板**（流式消息、工具卡片、reasoning 折叠、内联审批按钮、会话切换/Fork、待办与运行状态；可一键弹出为独立窗口）、共享命令层、`@comonad` Chat participant、编辑器/`#`引用注入、会话持久化与树视图（重命名/删除/fork 右键菜单）、会话导出、选区 Code Action 与编辑器菜单（解释/修复） | `ui/chat-panel.ts`, `resources/chat.js`, `resources/chat.css`, `ui/palette.ts`, `ui/slash.ts`, `ui/participant.ts`, `ui/sessions-view.ts`, `ui/inline.ts`, `services/sessions.ts` |
| B 运行时 | Mermaid 图运行时（节点/路由/suspend/resume/soft route）、默认图、每节点模型路由、子代理（前后台、深度/并发限制、`fork` 继承对话）、只读工具并行批次执行、/compact 压缩与超长自动压缩 | `lib/graph.ts`, `lib/mermaid.ts`, `services/agent.ts`, `ui/chat-panel.ts` |
| C 工具 | fs（写保护 `.git`、所有路径经工作区守卫，符号链接逃逸被拒）、shell（沙箱 + 后台任务 + 敏感环境变量过滤）、plan、todo、math、web（fetch/search）、VS Code（诊断/符号/编辑/任务/git）、ask、agent、skill、memory、MCP 客户端（stdio + HTTP，逐服务器挂载/卸载） | `tools/*.ts`, `services/tools.ts`, `services/mcp.ts` |
| D 策略与安全 | 四模式 × 五审批、能力过滤、allow/ask/deny 规则引擎、“总是允许”规则生成、危险命令（rm -rf/sudo/curl\|sh/force push…）强制确认、`*_unsandboxed` 升级必确认、sbpl/bwrap 沙箱（Windows 走 PowerShell 直执需审批）、工作区边界双开关（`confineRead` / `confineWrite`，同时作用于文件工具与 shell 沙箱）、`.env` 与 `.git` 保护、Workspace Trust、审计 JSONL（user/assistant/tool/turn-end 全轨迹） | `lib/policy.ts`, `lib/sandbox.ts`, `services/agent.ts`, `services/audit.ts` |
| E 检查点（内置行） | 每文件写入日志（影子 git，不提交、不碰用户 `.git`）、Keep/Undo（文件或 hunk）、编辑提示词重发/Regenerate（可选文件回退）、输入框上方变更文件列表（待审查 + Reviewed 历史、Undo/Keep/Review、点击打开 inline diff 文件）、diff 编辑器打开、装载时清理旧快照仓库；一行 `checkpoints` 连服务带 review 一起开关，其余代码经 `ctx.get('checkpoints')` 可选读取 | `src/services/checkpoints.ts`, `src/lib/diff.ts`, `src/ui/review.ts`, `src/ui/chat-panel.ts`, `resources/chat.js` |
| F 上下文与记忆 | COMONAD.md/AGENTS.md/rules 层级加载（记录来源文件）、自动记忆（读写工具 + 注入）、context/display 三形态（rendered/token/raw）、token 估算与 `/context` 预算报告、`/cost` 与预算告警 | `lib/instructions.ts`, `lib/prompt.ts`, `services/catalog.ts`, `services/agent.ts` |
| G 扩展 | Skills、自定义命令（`$ARGUMENTS`/`` !`cmd` ``/`@` 引用）、Hooks（command/http/mcp_tool/prompt + matcher + if + 决策 JSON + async）、定义式 Subagents、MCP 配置、内置 slash 命令（`ui/slash.ts`） | `services/hooks.ts`, `services/catalog.ts`, `services/commands.ts`, `ui/slash.ts`, `lib/references.ts`, `ui/references.ts` |
| H 模型 | OpenAI 兼容流式（tool-delta 组装、reasoning、usage）、Profile 管理（`keyEnv`/SecretStorage、`pricingIn/pricingOut` 成本估算）、降级重试、JSON 结构化选择、适配器可插拔（`ctx.llm.use()`） | `services/llm.ts`, `llm/openai.ts` |
| I 设置 | `contributes.configuration` 全量设置、Webview 设置面板（Graph/Agent/ST/Rules/**Prompts**/**Inspect**/MCP/Tools：Graph 校验 + Mermaid 实时预览、MCP 与 Tools 目录；**Prompts** 是 Comonad 块与工具定义的布局页——拖拽/↑↓ 排序、开关、编辑块的静态前缀，工具定义只读；ST 接管时块顺序/开关只读镜像预设，前缀仍可改；**Inspect** 为只读页，内含两个子 tab——**Tool Policy Flow (TPF)**（原 Flow 更名，工具调用闸门的 Mermaid 图，仅在该子 tab 可见时才渲染）与 **Plugins**（依赖表））、工作目录选择器、`allowFullAccess` 可移除 unrestricted preset、`chatWindow` 可直接以独立窗口打开聊天 | `ui/settings-panel.ts`, `ui/status.ts`, `host.ts`, `package.json` |
| J 可观测 | Output Channel + 调试日志、审计 JSONL、每轮 usage 与会话累计成本、`/status` `/cost` `/context`、后台任务面板（查看输出/停止）、沙箱与 MCP 状态 | `services/log.ts`, `services/audit.ts`, `services/usage.ts`, `ui/tasks-view.ts` |
| K 平台 | 多根工作区（取首个文件夹）、macOS/Linux 沙箱、Remote/WSL 作为 workspace extension、Windows 经 PowerShell 的直接执行（仍受审批）、Host 契约（配置/密钥/存储/问答）可替换 | `host.ts`, `lib/sandbox.ts`, `services/host.ts` |
| 测试 | 229 项测试（策略门控/规则/图编译与挂起恢复/frontmatter/路径防护/diff/危险命令/环境过滤/`.git` 保护/上下文形态/清单设置与代码一致 + Cordis 内核：工具 effect 撤销、可见性过滤、会话服务、完整 agent 回合与审批 waterfall + 内容层：Comonad 生成块、单一 Tools 开关、预设顺序与持久化等）+ 真实 VS Code 宿主激活测试（全部通过）；测试经 esbuild 打包后在 VS Code 宿主中运行真实服务（假 Host） | `src/test/extension.test.ts`, `src/test/harness.ts`, `src/test/activation.test.ts` |
| L 内容层（自建库 + ST 兼容格式） | **自有数据目录** `.comonad/{characters,lorebooks,presets,personas}`（项目 + `~/.comonad`），文件格式与 SillyTavern 完全互操作（可直接互拷）：角色卡（PNG `chara`/`ccv3` + JSON，V1/V2/V3，含 alternate_greetings / mes_example / depth_prompt / `extensions.world` 绑定世界书 / 内嵌 character_book / regex_scripts）、世界书（键/次要键与逻辑、内容、注入位置与深度与 role、order、概率、常量、分组与权重、sticky/cooldown/delay、递归、triggers、逐条 scanDepth/caseSensitive/wholeWords、角色/标签过滤——**过滤真正参与激活判定**；写出时顶层 camelCase + `extensions` 双写镜像，未知字段保留）、用户面具（名称/标题/描述/注入位置深度 role/绑定世界书/`connections` 角色绑定）、OpenAI 预设（prompts + prompt_order + 全部 samplers + formats）。**内容管理器**：新建/复制/编辑/保存/删除四类内容、本轮会话采用、设为默认、打开目录、角色卡导出 PNG）；**World books 子页照 ST 的 Worlds/Lorebooks 面板重写**：Active World(s) 多选 + 全局激活设置抽屉（含 Alert On Overflow）、书级工具栏（Create/选择/Import/Export/Rename/Duplicate/Delete）、条目列表（加权搜索、8 种排序 + Apply sorting as Order、分页、Open/Close all、Fill empty titles、Custom 排序下拖拽换序）、每行**行内展开**完整编辑器（关键字 chips + ✨/⌨️ 纯文本切换、Optional Filter、Outlet Name、逐条 Scan Depth、三个三态覆盖、Recursion Level、Content 带 Token/UID、四个递归与预算开关、Inclusion Group/Prioritize、Group Weight/Sticky/Cooldown/Delay、角色与标签过滤、Selective/Use Probability/Add Memo、Additional Matching Sources 抽屉），**改完即写、无 Save 按钮**；`{{outlet::Name}}` 让 outlet 位置真正可用，预算溢出按设置提示一次。**人格面具与预设也已按 ST 的面板与字段补齐**（Persona Management 页 + 头像/备份/转换，预设的 nudge/seed/logit bias/按角色 order + 管理器与模板，见 N 行）；**预设条目库**（一个条目框 + 左侧小按钮在 **System entry**（所有预设共用）与 **Custom entry**（仅本预设）之间切换；框内 = 下拉选择 + **+ New** + **Insert**；只有 Insert 会把所选条目插到列表开头 = Comonad 前导块之后，+ New 存入库并在框旁就地展开编辑器、状态栏说明去向；**选中条目后其编辑器出现在框的正下方**（Name/Role/正文 + Delete，改名即 Name 字段），不再另列清单）：**系统库** `.comonad/prompt-library.json`（以 8 个内置块种子化）为所有预设共用；**预设自有库**存于预设文件的 `comonad_prompt_library` 键（ST 忽略、随文件走、与 ST 字段互不干扰）；插入时标识符自动去重，同一块可插多次。**（附带修正：内容库在激活时真正读取 —— `plugins/reactions.ts` 之前只有 watcher 没有 initial load）** | `lib/tavern/{types,card,authoring,preset,prompts,library,lore,assemble,regex,macro,search,personas}.ts`, `lib/tavern/templates/*.ts`, `services/tavern.ts`, `ui/{tavern-content,tavern,settings-panel}.ts`, `tools/tavern.ts`, `resources/{content,worldinfo,persona}.{js,css}` |

**有意留到后续（P2 或受平台限制）**：worktree 子代理隔离、Agent Teams、会话跨端接力、Headless CLI/CI、企业托管策略、Auto-review 分类器、定时任务、Eval 框架、遥测。hunk 级操作在 QuickPick 中完成（未做逐行 diff 内嵌按钮）。

| M ST 完全对齐（上一轮） | ① **分词器**：计数改为模型真实分词器——GPT 家族用 tiktoken（o200k/cl100k/r50k），Claude/Gemini/Llama/Mistral 等用 ST 自己的 tokenizer 文件（从 upstream 仓库下载，或读 `comonad.tokenizerDir` 指向的 ST 目录），再叠加 upstream 的 `+6` 消息框架；未知模型回退字节估算。② **搜索**：世界书搜索改用 Fuse.js，key 权重与 `ignoreLocation`/扩展语法（`'exact`、`!not`）与 ST 一致。③ **标签注册表**：`.comonad/tags.json`（`tags` + `tag_map`，引用一律用 **id**），角色页标签 chips + Manage tags…（增/改名/配色/文件夹/hide-on-card/删除或合并、Prune unused）+ Import card tags（跳过 `ROOT`/`TAVERN`、上限 50、`comonad.tagImportSetting` 决定询问/全部/仅已有/不做），条目的角色/标签过滤改存 **tag id**。④ **生成触发器**：ST 六种类型（Normal/Continue/Impersonate/Swipe/Regenerate/Quiet）都成为真实生成——Send 旁 ▾ 菜单与 `/continue` `/impersonate` `/swipe` `/regenerate` `/quiet`；回复带多版本（`‹ n/m ›` 切换，regenerate 只覆盖第一版、之后追加），continue 续写同一消息、impersonate 不写入聊天而是把生成结果流式写进**输入框**（与 upstream 的按钮一致，由你编辑后发送）、quiet 完全不写入；条目按 triggers 限定。⑤ **Automation ID**：条目激活时触发 `WorldInfoActivated` hook 并执行同名 slash 命令（每回合一次，需 `comonad.wiAutomation`）。⑥ **Vectorized**：`comonad.wiVectorEnabled` 下按语义检索条目（`/embeddings` 嵌入最近 `wiVectorQuery` 条消息，余弦相似度，`wiVectorThreshold`/`wiVectorMaxEntries` 过滤），向量按书+模型缓存于扩展存储、以内容哈希为键。⑦ 条目状态三态选择 🟢/🔵/🔗 与 `character_filter` 写入 ST 自己的键名 | `lib/tokens.ts`, `services/tokenizers.ts`, `packages/comonad-plugin-tavern/src/lib/{vectors,tokenizers,search,tags}.ts`, `services/{agent,sessions,settings,tavern}.ts`, `resources/{chat,worldinfo,content}.{js,css}`, `src/ui/{chat-panel,slash,tavern-content,settings-panel}.ts` |
| N 角色卡 / 人格面具 / 预设完全对齐（本轮） | ① **人格面具**：模型补 `PERSONA_POSITION.none = 9`、默认 depth 2、`PersonaConnection{type,id}`（同时读旧文件里的裸名字、去重、`Kestrel.png` 与 `Kestrel` 视为同一角色）、`Persona.avatar`；**ST 形状的文件写入**（我们写的 connections 不再被 ST 丢掉，ST 备份的 connections 也不再被我们丢掉）；头像 = 与 JSON 同目录、以 id 命名的图片，`localResourceRoots` 扩到库目录后用 `asWebviewUri` 显示；**Backup/Restore** 用 ST 自己的备份文档（已存在则跳过并列出跳过了什么），**Convert a character…** 按 ST 规则（含 `{{char}}`/`{{user}}` 互换确认），Duplicate 连图一起复制，删除连带删图。**Persona Management 面板**：左侧头像格 + Create/搜索/A-Z·Z-A·Search/分页/网格/+ 上传格，右侧 名字/标题/图片/描述（实时 token 数）/位置（None (disabled) 排第一）/深度/角色/Default·Character·Chat 三锁 + 连接列表/Persona Lorebook/三个全局设置（`personaAutoLock`、`personaAllowMultiConnections`、`personaShowNotifications`），逐字编辑 600ms 自动保存、切换人格或切页面前先落盘。② **角色卡**：补 `favourite`（V1 根 `fav` + `extensions.fav` 双写）、`talkativeness`（默认 0.5）、`create_date`、`extensions.source_url`；头像按 ST 的模型——**卡片就是那张图**，给 JSON 卡选图会把它改写为 PNG 卡；**More… 菜单**：Import Card Lore（卡内嵌书 → 库世界书并绑定，已导入的内嵌书不再重复扫描）、Convert to Persona、Rename（文件、标签 key、人格连接、默认角色、所有打开的聊天一起跟）、Link to Source、Import cards…、Export JSON…；列表加 搜索/排序（名字、最新、最早）/★ 只看收藏/网格/分页/头像。③ **预设**：补 6 个 nudge prompts（`new_chat_prompt` 置于历史块开头、`send_if_empty` 以用户身份补空轮、`continue_nudge_prompt` 带 `{{lastChatMessage}}` 以 depth 0 注入，agent 自带提示自动让位）、`seed`、`logit_bias` + 所选集名、`stream_openai`、`max_context_unlocked`、`use_sysprompt`、**按角色的 prompt_order**（映射不到的 ST 数字块原样保留并写回原位）；`presetSamplers` 现在真正发出 `frequency_penalty`/`presence_penalty`/`seed`/所选 `logit_bias`，且**预设没设的字段不发**；宏补 `{{charIfNotGroup}}`（内置 main 用 ST 原文）与 `{{lastChatMessage}}`；Preset 管理器加 Import…/Export…（库内文件按字节导出）/Start from…/Restore template/Restore prompts + Add prompt…（8 个自写 prompt 块）；**5 个模板**（Default + Balanced/Creative/Precise/Long-form）选中即复制进库；Default 就是未选预设时的内置集合，不带 sampler/nudge，加载插件本身不写文件。④ **预设条目可编辑**（照 ST 的 *Edit* 弹窗，在该条目下方就地展开）：列表行 = 开关 + 名字（📌 marker / ★ forbid overrides / ⧉ extension / 角色图标，In-chat 时后缀 `@ depth`）+ 该行 token 数 + ↑↓/✎/⧉/✕，工具条 Add prompt…/Restore prompts/右侧 Total Tokens；Edit 面板逐字照 ST——Name、Role、Triggers（多选，空 = 全部生成类型）、Position（Relative / In-chat）、Depth、Order、Prompt 文本域 + 右侧 Forbid Overrides，提示文字与 ST 相同；marker 块文本域禁用并显示 ST 原话；Reset 把该块还原为内置版本（自己加的块则清空）。Comonad 的 9 个生成块与单一 **Tools** 条目也在同一张列表里：◆ 标记、内容只读并显示当前生成值，但开关、拖拽与 ↑↓ 和普通条目相同；Tools 关闭后请求不提供任何 API 工具，模型仍强行调用会在执行前被拒绝。预设文件里只保存这些条目的位置与开关（`prompt_order`），生成文本不落盘。模型侧补 `PromptItem.injection_trigger`（读写、非法值丢弃、空数组保留）与 `triggersGeneration`，限定类型的块在其它生成里真的不出现；**In-chat 的条目内容现在真的进入请求**——按 ST `populationInjectionPrompts` 的次序（depth 深的在上、同 depth 按 order 低者先、同 order 按 assistant→user→system）插入历史，空内容不发。⑤ **ST tab 视觉统一**：四个内容页 + 世界书页 + 人格页共用 `settings.css` 里的一套 token（26px 控件高、6/4px 圆角、11.5px 标签、统一的 focus ring、颜色一律 theme 变量带回退），子标签改成带计数徽章的 tab strip，工具栏按组换行、卡片操作分「本聊天用」与「文件级」两组，列表搜索独占一行，所有图标按钮统一 22px 方块 + hover；提示词列表按 ST 的读法重画（每块一张卡片：开关 + 名字与标记 + 行内控制 + 右侧 tabular token 数，表头与该 grid 共用列宽）；世界书表头改为同一 grid 的一行（列真正对齐），关闭的条目整行变暗（悬停恢复）而不是给标题打删除线，状态列只留 🟢/🔵/🔗；人格页改成行式列表（图片 + 名字 + 标题 + 👑/🔒 徽章，网格视图一键切换）、位置/深度/角色并作一行三字段、连接改 chip。⑥ **明确不做**：ST 的上下文模板 / instruct / sysprompt（ST 在 chat completion 下整块隐藏且从不发送，见 `toggle-dependent.css:558`、`script.js:4726`/`5366`），其键仍随 `raw` 原样往返；`top_k`/`top_a`/`min_p`/`repetition_penalty` 与 `stream_openai:false` 只在 UI 提示中说明不发送，不静默丢弃 | `lib/tavern/{types,authoring,card,preset,prompts,macro,assemble,personas}.ts`, `lib/tavern/templates/{presets,blocks}.ts`, `services/{tavern,settings,agent}.ts`, `lib/openai.ts`, `ui/{tavern-content,settings-panel}.ts`, `resources/{content,persona,settings}.{js,css}`, `package.json` |
