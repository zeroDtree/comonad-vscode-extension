# 内容层

agent 可以“扮演”一个角色。内容层**不是内置功能**：它作为可选插件发布，安装前什么都不做。它读写
SillyTavern 的文件格式，因此角色卡、世界书、人格和预设可以在两个工具之间直接迁移。

**安装：** **Settings → Plugins → Install… → SillyTavern content (ST)**。行加载后，打开 **ST**
标签页（`Comonad: Manage Content`）。

内容位于项目的 `.comonad/` 和用户的 `~/.comonad/`：

```text
.comonad/
  characters/    角色卡（PNG 或 JSON）
  lorebooks/     世界书
  personas/      人格与图片
  presets/       聊天补全预设
  tags.json      标签注册表
  prompt-library.json
```

## 角色卡

角色卡按 PNG（`chara` / `ccv3` 块）或 JSON 读取，支持三个版本，并按原形状写回。编辑器覆盖描述、性格、
场景、开场白与替代开场、示例消息、系统提示、历史后指令、作者注记、标签、深度提示和
`extensions.world`。

- **Choose picture…** 会把卡写成 PNG，因为上游就是这样存储角色卡的。
- 列表支持搜索、排序（A-Z/Z-A、最新、最早）、收藏过滤、网格视图和分页。
- **More…** 包含 *Import Card Lore*、*Convert to Persona*、*Rename*、*Link to Source*、
  *Import cards…*、*Export JSON…* 和 *Export PNG…*。
- 绑定到聊天时，角色卡的开场白（或替代开场）会作为第一个回合插入。

## 世界书

**World books** 页面照 SillyTavern 的面板：全局 Active World(s)、全局激活设置、创建/导入/导出/
重命名/复制/删除，以及带搜索、排序、分页和 *custom* 排序拖拽的条目列表。

每个条目展开后是完整编辑器：主键与次键、逻辑、可选过滤器、outlet 名、扫描深度、大小写/整词覆盖、
递归层级、带 token 数与 uid 的内容、inclusion group、priority、sticky/cooldown/delay、状态
（**🟢 Normal / 🔵 Constant / 🔗 Vectorized**）、automation ID、生成触发器、角色/标签过滤以及
additional matching sources。

编辑即写回，没有 Save 按钮。文件保持 SillyTavern 的 camelCase 键名，并带 `extensions` 镜像。

### 激活

- 每回合按条目的键、扫描深度和过滤器扫描。
- **Vectorized** 条目通过 OpenAI 兼容的 `/embeddings` 端点按语义检索；向量按书和模型缓存。
- 条目的 **Automation ID** 在激活时运行 `WorldInfoActivated` hook 和同名 slash 命令；每回合一次，需
  开启 `comonad.wiAutomation`。
- 预算阻止扫描时，*Alert On Overflow* 会在每个聊天提示一次。

`lore_lookup` 让模型按需搜索世界书。它是只读的，不会改变下一回合注入什么。

## 人格

**Personas** 页面照 SillyTavern 的 *Persona Management*：左侧头像格，右侧打开的人格。名称、标题、
图片、描述（实时 token 数）、位置、深度与角色、三个锁（*Default*、*Character*、*Chat*）、连接和
persona lorebook。

- 描述逐字自动保存。
- 连接使用上游的 `{type, id}` 形状，所以在任一工具里做的 Backup 都能在另一个里恢复。
- **Duplicate** 连图片一起复制；**Convert a character…** 从角色卡创建人格；删除人格会连带删除图片。

## 预设

预设就是 SillyTavern 的全部 OpenAI 设置。**Presets** 标签页编辑提示词列表、采样器、格式和 nudge。

- **Prompt library：** 一个带选择器的框；在 **Built-in**（共享）和 **Custom**（本预设）之间切换。
  *Insert* 把所选条目插到列表开头（Comonad 前导块之后）；*+ New* 保存新条目并就地打开编辑器。
- Comonad 的九个块 —— **Identity、Tools、Instructions、Memory、Todos、Skills、Sub-agents、Lore
  index、Context** —— 是同一列表中的行。文本由程序生成且只读；开关和位置是普通预设状态。唯一的
  **Tools** 行控制请求是否提供工具。
- 提示词列表支持开关、移动、复制、删除和逐条编辑：名称、角色、生成触发器、relative/in-chat 位置、
  深度、顺序、文本和 *Forbid Overrides*。
- 采样器、格式、nudge、`seed`、`logit_bias`、`stream_openai`、`max_context_unlocked` 和
  `use_sysprompt` 只在预设设置时发送。
- **Import…** / **Export…** 读写 SillyTavern 预设。内置五个模板：*Default*、*Balanced*、
  *Creative*、*Precise*、*Long-form*。

## 标签

标签注册表在 `.comonad/tags.json`（项目覆盖用户），采用 SillyTavern 的形状：
`{tags: [...], tag_map: {<character id>: [tag id]}}`。标签一律用 **id** 引用，所以重命名标签不会
破坏过滤器。在 Characters 标签页管理：创建、重命名、配色、文件夹类型、hide-on-card、删除或合并、
Prune unused，以及导入角色卡标签。

## 生成

**Send** 旁的 ▾ 提供 SillyTavern 的六种生成：**Normal**、**Continue**、**Impersonate**、
**Swipe**、**Regenerate**、**Quiet**。它们也是命令：`/continue`、`/impersonate`、`/swipe`、
`/regenerate`、`/quiet [text]`。

限定生成触发器的条目只在这些类型下触发。回复保留版本：`‹ n/m ›` 切换；regenerate 覆盖第一个版本，
之后追加。

## 宏与正则

以下宏会在每个块中替换：

```text
{{char}}  {{charIfNotGroup}}  {{user}}  {{persona}}  {{scenario}}
{{lastChatMessage}}  {{time}}  {{random}}  {{pick}}  {{roll}}  {{outlet::Name}}
```

来自 `comonad.tavern.regex` 或角色卡的正则脚本按 SillyTavern 的位置与深度规则作用于提示词和回复。

## 许可证

内容层重新实现了 SillyTavern 的文件格式与提示词组装。少量工具函数改编自 SillyTavern（AGPL-3.0）；
见 [NOTICE](https://github.com/zeroDtree/comonad-vscode-extension/blob/main/NOTICE)。SillyTavern
本身没有被打包，其默认内容也从未被复制。

## 下一步

- [设置](/zh/reference/settings) —— `comonad.tavern*` 键
- [聊天](/zh/guide/chat) —— 生成类型与 swipes
