# 上下文容量弹层分项构成增强（Token 数与悬停说明）

在宿主引擎「上下文容量」悬停弹层（`ContextContent`）的分项构成（breakdown）行中，补充展示每项对应的估算 Token 数（`24.3万 · 74.7%` 格式），并在鼠标悬停该行时显示该类别的大白话构成说明与减负建议。

## 1. 产品规则与展示口径

- **设置开关**：
  - 位置：`⚙ 设置 → 通用`，位于「上下文按钮增强」与「压缩上下文按钮」之间。
  - 标签：`上下文构成明细增强` / `Context breakdown details`
  - 说明：在「上下文容量」弹层的各构成项右侧补充估算 Token 数（如 `24.3万 · 74.7%`），悬停某一行时显示该项的大白话说明与减负建议；关闭即还原原生仅百分比展示。默认开启。
  - 状态与持久化：`state.ctxBkd`（缺省 `1`，仅 `localStorage.getItem("zusage3.ctxBkd") === "0"` 时为 `0`），纯渲染端展示偏好，不写 `config.json`、不涉及主进程。
- **Token 数计算与展示（建议 1）**：
  - 数据源：从就近的上下文触发按钮（`nearestByRect(body, '[data-testid="chat-context-usage-trigger"]')`）读取 `aria-label`（复用 `parseNativeCtxLabel` 解析 `{ used, total }`）。
  - 计算公式：读取宿主分项行右侧百分比文本（如 `74.7%` -> `pct = 74.7`），计算 `tokens = Math.round(nat.used * pct / 100)`，经实例 `fmt(tokens)` 格式化（自动遵循「中文单位（万/亿）」与「强制 K/M/B 单位」设置）。
  - 排版形态：在宿主百分比节点（`span.ml-auto`）**之前**插入 `<span class="zu-ctx-bkd-tok">24.3万 · </span>`，并将原百分比节点的 `ml-auto` 由左侧外边距接管（`.zu-ctx-bkd-tok{margin-left:auto}` + 相邻百分比 span `margin-left:0!important`），使右侧整体呈现 `24.3万 · 74.7%`：Token 数与中点使用弱化前景色（`var(--color-foreground-subtle,#8791a3)`）+ 等宽数字（`font-variant-numeric:tabular-nums`），百分比保持宿主原生高亮前景，零改动宿主文本节点，React 重渲染零冲突。
  - 降级：若 `nat.used` 无法解析（`<= 0`）或百分比无法解析，不插入 `.zu-ctx-bkd-tok`（若已有则摘除），保持原生仅百分比展示；悬停说明仍照常工作。
- **悬停结构化明细气泡（建议 3 升级版）**：
  - 识别方式：按行内类别标签文本（`span.truncate` 的 `textContent.trim()`）匹配宿主 7 类标准中英文名称，映射为内部键 `messages` / `meta_user_context` / `system_tool_schemas` / `mcp_tool_schemas` / `skills` / `system_prompt` / `tool_prompt`。未知类别不挂载。
  - **底层明细数据源**：沿上下文触发按钮的 `__reactFiber$` 向上读取 `memoizedProps.taskUsage`（降级：无 fiber 时仅使用 `aria-label` 的 `used/size`），获取各分类真实原始字符数 `breakdown[].chars` 与缓存明细 `cache`。
  - 悬停浮层：复用 `01-git-and-doc-tooltips.js` 文档级单例浮层 `.zusage-ctx-bkd-tip`（挂 `document.body`，`z-index: 2147483647` 压过 Radix 弹层，`.tip.zusage-quota-tip` 同款外观、深浅主题 `.zu-light` 自适应、签名幂等、`-webkit-app-region: no-drag` 命中 `.tip` 联合规则，最大宽度 `340px`）。
  - 气泡结构（4 块内容）：
    1. **标题**：类别名称（中英双语）+ 占已用比例。
    2. **核心数据三联**：估算 Token 用量（`fmt(tokens)`，≥1 万时附精确千分位整数）、双口径占比（`占已用 X%` + `占总窗口 Y%`）、原始文本量（`chars` / `totalChars` 字符，仅 `taskUsage.breakdown` 可用时渲染）。
    3. **包含内容清单**：分点列出该类别包含的具体内容来源、名称与本地路径（所有路径均可点击打开所在文件夹）：
       - **技能 (`skills`)**：从当前会话 `snapshot.rows.window` 扫描本会话实际调用过的 `Skill`（名称 + `Base directory` 目录路径），并列出全局（`<home>/.zcode/skills`）与项目级（`<workspacePath>/.zcode/skills`）技能目录。
       - **其他 (`meta_user_context`)**：列出「指令规则」路径（全局 `AGENTS.md`、项目 `AGENTS.md` / `.zcode/AGENTS.md`）、「记忆索引」位置（`<home>/.zcode/projects/` 与 `MEMORY.md` 说明）、「系统提醒」具体动态项（OS/Shell/日期/Git 状态/Todo 待办/子代理列表/ToolSearch 公告）。
       - **系统提示词 (`system_prompt`)**：列出 ZCode 内置系统提示词核心段名称（`core` 核心身份、`guidelines` 编码与执行规范、`safety` 安全与权限边界、`output_style` 回复风格与语言）及实际引擎路径（从 `location.href` 解析，如 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`）。
    4. **减负建议**：针对该类别的可操作优化提示（如检查 `AGENTS.md` 体积、关闭不常用 MCP、点击「压缩上下文」等）。
  - **气泡交互与路径打开**：`.zusage-ctx-bkd-tip` 启用 `pointer-events: auto` 与 180ms 悬停保活桥（移入气泡不收起，移出延迟收起），贴近分项行 `2px` 定位；点击气泡内任意 `.cb-path` 路径链接调用 `openProjFolder(path)`（`window.zcode.openInFileManager`）打开对应文件夹。
  - **平均缓存命中率行悬停明细**：识别弹层内的「平均缓存命中率 / Average cache hit rate」行（打 `data-zusage-bkd-cache="1"`），当 `taskUsage.cache` 可用时悬停展示：最近一次请求命中率（`cacheReadTokens / inputTokens`）、本会话累计命中率与累计命中/输入 Token 数、参与统计的主轮请求次数（`hitRateRequestCount`）及大白话说明。
  - 定位：优先锚定在当前行上方或下方（视空间而定）或弹层侧方，水平限制在视口 `[8, vw - tw - 8]` 内；为避免遮挡上下相邻分项行，优先贴在当前分项行上方 6px（`r.top - th - 6`，放不下则 `r.bottom + 6`）。
  - 交互与清理：鼠标移入分项行（`mouseenter`）立即显示说明气泡，移出（`mouseleave`）隐藏；当弹层被 Radix 卸载（`!ctxBkdTipFor.isConnected`）或开关关闭时，由 `scanRateLines` 500ms 健康检查与开关 `change` 分支立即收起；`cleanupRateTip` 随代际销毁移除 DOM。
  - 七类说明文案（中英双语，遵循宿主 `classifyContextComposition` 真实归类口径）：
    1. **消息 (`messages` / `Messages`)**：对话记录、工具执行返回结果（读文件、跑命令等输出）及历史压缩摘要。占比过高时可点下方「压缩上下文」释放空间。
    2. **其他 (`meta_user_context` / `Meta context`)**：项目与全局规则（AGENTS.md）、记忆索引，以及环境、Git 状态、待办列表等系统提醒。
    3. **系统工具 (`system_tool_schemas` / `System tools`)**：ZCode 内置工具与页面工具（读写文件、终端命令、浏览器操作等）的参数定义。
    4. **MCP 工具 (`mcp_tool_schemas` / `MCP tools`)**：已启用的第三方 MCP 插件工具定义。占比过高时可在设置中关闭不常用的 MCP 服务。
    5. **技能 (`skills` / `Skills`)**：当前已加载的技能（Skills）目录与触发说明。
    6. **系统提示词 (`system_prompt` / `System prompt`)**：ZCode 内置的底层指令与行为规范。
    7. **工具提示词 (`tool_prompt` / `Tool prompt`)**：指导模型如何正确调用工具的专项提示词。

## 2. DOM 锚点与对账生命周期

- **容器识别**：在 `syncCompactBtn()` 遍历的 `[data-slot="hover-card-content"].!w-80`（带 `[data-slot="progress"]` 指纹）的 `div.space-y-3`（`ContextContentBody`）内，定位分项行：`body.querySelectorAll("div.grid.gap-1\\.5 > div.flex")`（或遍历 `body` 子树中带 `aria-label="上下文来源"` / `"Context sources"` 容器下的直接行）。
- **双触发对账**：随 `syncCompactBtn()` 在 `hcObserver`（body `MutationObserver` rAF 去抖，弹层打开即时生效）、`heavy()`（600ms 兜底）以及单位/语言/开关切换（`render` / `change`）时执行。
- **幂等与还原**：
  - 开关开启时：对每行写入 `data-zusage-bkd="<key>"`，绑定一次 hover 委托（挂在 `body` 容器 `__zuBkdDelegated` 上，`mouseover`/`mouseout` 按 `closest("[data-zusage-bkd]")` 分发，零逐行监听器泄漏），按当前 `nat.used` 与行百分比计算并原地更新 `.zu-ctx-bkd-tok` 的 `textContent`。
  - 开关关闭时：移除弹层内全部 `.zu-ctx-bkd-tok` 节点与 `data-zusage-bkd` 属性，并立即调用 `hideCtxBkdTip()`。

## 3. 验收场景

1. **Token 数计算与格式**：`used = 325000`，分项 `74.7%` -> 中文默认显示 `24.28万 · `（`325000 * 0.747 = 242775` -> `fmt(242775) = "24.28万"`），关闭中文单位或开启强制 KMB 显示 `242.8K · `，英文界面显示 `242.8K · `。
2. **七类标签识别与悬停气泡**：中文（「消息」「其他」「系统工具」「MCP 工具」「技能」「系统提示词」「工具提示词」）与英文（"Messages"、"Meta context"、"System tools"、"MCP tools"、"Skills"、"System prompt"、"Tool prompt"）均能识别并弹出对应双语大白话气泡；移出或弹层卸载即收起。
3. **开关控制与幂等**：`zusage3.ctxBkd="0"` 时不注入 Token 节点、不弹气泡；运行中在 ⚙ 通用关闭开关立即摘除已注入的 `.zu-ctx-bkd-tok` 并收起气泡，重开立即恢复；多次 `tick()` 节点不重复创建。
