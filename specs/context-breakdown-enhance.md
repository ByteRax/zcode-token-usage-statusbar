# 上下文容量弹层分项构成增强（Token 数与悬停说明）

在宿主「上下文容量」悬停弹层（`ContextContent`）的分项构成（breakdown）行中，补充展示每项对应的估算 Token 数（如 `24.28万 · 74.7%`），并在鼠标悬停该行时显示该类别的大白话构成说明与减负建议。说明气泡只看不点：原因见下文「气泡交互」。

## 1. 产品规则与展示口径

- **设置开关**：
  - 位置：`⚙ 设置 → 通用`，位于「上下文按钮增强」与「压缩上下文按钮」之间。
  - 标签：`上下文构成明细增强` / `Context breakdown details`
  - 说明：在「上下文容量」弹层的各构成项右侧补充估算 Token 数（如 `24.28万 · 74.7%`），悬停某一行时显示该项的大白话说明与减负建议；关闭即还原原生仅百分比展示。默认开启。
  - 状态与持久化：`state.ctxBkd`（缺省 `1`，仅 `localStorage.getItem("zusage3.ctxBkd") === "0"` 时为 `0`），纯渲染端展示偏好，不写 `config.json`、不涉及主进程。
- **Token 数计算与展示**：
  - 数据源：从就近的上下文触发按钮（`nearestByRect(body, '[data-testid="chat-context-usage-trigger"]')`）读取 `aria-label`（复用 `parseNativeCtxLabel` 解析 `{ used, total }`）；触发器没有 `aria-label` 时退用 `taskUsage.used / size`。
  - 计算公式：读取宿主分项行右侧百分比文本，按数值解析（小数点与小数逗号都认，如 `74.7%`、`74,7 %`），计算 `tokens = Math.round(used * pct / 100)`，经实例 `fmt(tokens)` 格式化（自动遵循「中文单位（万/亿）」与「强制 K/M/B 单位」设置）。宿主分项百分比是「占已用」口径（各项之和为 100%），所以按已用量折算。
  - 排版形态：在宿主百分比节点（`span.ml-auto`）**之前**插入 `<span class="zu-ctx-bkd-tok">24.28万 · </span>`，并让左侧外边距由它接管（`.zu-ctx-bkd-tok{margin-left:auto}` + 相邻百分比 span `margin-left:0!important`），右侧整体呈现 `24.28万 · 74.7%`：Token 数与中点用弱化前景色（`var(--color-foreground-subtle,#8791a3)`）+ 等宽数字，百分比保持宿主原生高亮前景，不改宿主文本节点。
  - 降级：`used` 取不到（`<= 0`）或百分比无法解析时，不插入 `.zu-ctx-bkd-tok`（若已有则摘除），保持原生仅百分比展示；悬停说明照常工作。
- **悬停说明气泡**：
  - 识别方式：按行内类别标签文本（`span.truncate` 的 `textContent.trim()`）匹配宿主 7 类标准中英文名称，映射为内部键 `messages` / `meta_user_context` / `system_tool_schemas` / `mcp_tool_schemas` / `skills` / `system_prompt` / `tool_prompt`。未知类别不出气泡。
  - 底层明细数据源：沿上下文触发按钮的 `__reactFiber$` 向上（最多 65 层）读取 `memoizedProps.taskUsage`（各分类原始字符数 `breakdown[].chars` 与缓存明细 `cache`）、`workspacePath` 与会话快照 `snapshot`。
  - 气泡本体：`01-git-and-doc-tooltips.js` 的文档级单例 `.zusage-ctx-bkd-tip`（挂 `document.body`，`z-index: 2147483647` 压过 Radix 弹层，`.tip.zusage-quota-tip` 同款外观、深浅主题 `.zu-light` 自适应、内容签名幂等、`-webkit-app-region: no-drag` 命中 `.tip` 联合规则，宽 280~380px）。
  - 气泡结构（4 块内容）：
    1. 标题：类别名称（中英双语）+ 占已用比例。
    2. 核心数据：估算 Token 用量（`fmt(tokens)`，≥1 万时附精确千分位整数）、双口径占比（`占已用 X%` + `占总窗口 Y%`）、原始文本量（`chars` / `totalChars` 字符，仅 `taskUsage.breakdown` 可用时渲染）。
    3. 包含内容清单：分点列出该类别包含的内容来源与本地路径。路径只作文本展示。
       - 技能（`skills`）：「近期已用技能」取自会话快照的尾部窗口（fiber 的 `snapshot.rows.window`，取不到时退 `bridge.handle.snap`）里 `toolName === "Skill"` 的工具行，名称取 `input.skill`，目录取其输出里的 `Base directory for this skill:`；同名去重。尾部窗口不等于整个会话，所以标题写「近期」。技能目录来自技能工具输出（模型可见的不可信数据），只有落在 home 或工作区之下才展示，其余只列名称。另列全局（`<home>/.zcode/skills`）与项目级（`<workspacePath>/.zcode/skills`）技能目录。
       - 其他（`meta_user_context`）：「指令规则」位置（全局 `AGENTS.md`、项目 `AGENTS.md` / `.zcode/AGENTS.md`）、「记忆索引」位置（`<home>/.zcode/cli/memories/projects/<工作区标识>/memory/MEMORY.md`，宿主 `memoryService` 的真实布局，目录名是工作区标识、与项目名不同）、动态「系统提醒」各项。
       - 系统提示词（`system_prompt`）：内置系统提示词核心段名称（`core`、`guidelines`、`safety`、`output_style`）及内置引擎路径（从 `location.href` 解析，如 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`）。
    4. 减负建议：针对该类别的可操作提示。
  - 气泡交互（只看不点）：气泡 `pointer-events: none`，不挂指针与键盘监听，路径不可点击。原因：气泡挂在 `document.body`，不在宿主 hover-card 的 DOM 子树里。只要它拦截鼠标，指针一进入气泡，宿主（Radix hover-card）就判定指针已离开弹层并立即关闭，气泡随即失去锚点收起；气泡又贴在行上方，往上挪一行会撞进它。ZCode 4.0.0 真机实证：气泡可拦截鼠标时，悬停第 2 行后上移到第 1 行，宿主弹层消失；改成指针穿透后，上移、下移弹层都保持打开，气泡跟随切换。宿主弹层还带 `overflow-hidden`，把气泡挂进弹层内部会被裁剪。要打开目录请用状态条「项目」格或项目菜单的「在 Finder 中打开」。
  - 移出分项行 180ms 后收起（跨行间隙不闪）；弹层被 Radix 卸载（`!ctxBkdTipFor.isConnected`）时由 `scanRateLines` 的 500ms 健康检查收起；开关关闭时对账分支与设置面板 `change` 分支立即收起；气泡 DOM 随代际 dispose 移除。
  - 定位：优先贴在当前行上方 2px（`r.top - th - 2`），上方放不下（小于 8px）时翻到行下方（`r.bottom + 2`，且不超出视口底 8px）；左缘钳在 `[8, vw - tw - 8]`；每拍对账跟随行位置重新锚定。气泡会盖住被悬停行上方的各行；指针穿透，这些行仍可悬停。
  - 平均缓存命中率行悬停明细：识别弹层内的「平均缓存命中率 / Average cache hit rate」行（打 `data-zusage-bkd-cache="1"`），`taskUsage.cache` 可用时悬停展示：最近一次请求命中率（`cacheReadTokens / inputTokens`）、本会话累计命中率与累计命中/输入 Token 数、参与统计的主轮请求次数（`hitRateRequestCount`）及说明。
  - 七类说明文案（中英双语，遵循宿主 `classifyContextComposition` 归类口径）：
    1. 消息（`messages` / `Messages`）：对话记录、工具执行返回结果（读文件、跑命令等输出）及历史压缩摘要。占比过高时可点下方「压缩上下文」释放空间。
    2. 其他（`meta_user_context` / `Meta context`）：项目与全局规则（AGENTS.md）、记忆索引，以及环境、Git 状态、待办列表等系统提醒。
    3. 系统工具（`system_tool_schemas` / `System tools`）：ZCode 内置工具与页面工具（读写文件、终端命令、浏览器操作等）的参数定义。
    4. MCP 工具（`mcp_tool_schemas` / `MCP tools`）：已启用的第三方 MCP 插件工具定义。占比过高时可在设置中关闭不常用的 MCP 服务。
    5. 技能（`skills` / `Skills`）：当前已加载的技能目录与触发说明。
    6. 系统提示词（`system_prompt` / `System prompt`）：ZCode 内置的底层指令与行为规范。
    7. 工具提示词（`tool_prompt` / `Tool prompt`）：指导模型如何正确调用工具的专项提示词。
  - 其它界面语言：宿主还有 ja/ko/ru 等 locale。标签不匹配时只是不出气泡；百分比的小数逗号写法已兼容。

## 2. DOM 锚点与对账生命周期

- 容器识别：在 `syncCompactBtn()` 遍历的 `[data-slot="hover-card-content"].!w-80`（带 `[data-slot="progress"]` 指纹）的 `div.space-y-3`（`ContextContentBody`）内，取 `aria-label="上下文来源"` / `"Context sources"` 容器的首个子节点（grid），其直接子节点是分项行（色点、`truncate` 标签、`ml-auto … tabular-nums` 百分比三个子节点）；没有该 `aria-label` 时退而认 `space-y-1.5` 下唯一的 grid。
- 对账时机：随 `syncCompactBtn()` 在 `hcObserver`（body `MutationObserver` rAF 去抖，弹层打开即时生效）与 `heavy()`（600ms 兜底）执行；`render()` 尾部与精简主题短路处各有一处调用（单位/语言切换时同拍刷新，需实例已收到过数据推送才进入，进不去时由 600ms 兜底拍刷新）；设置面板开关 `change` 分支直调。
- 幂等与还原：
  - 开关开启时：对每行写入 `data-zusage-bkd="<key>"`，在 `body` 容器上挂一次 `mouseover`/`mouseout` 委托（标记 `__zuBkdDelegated` 记代际号：热重载后同一个 body 上旧代的委托只会隐藏，新代要再挂一份），按当前 `used` 与行百分比计算并原地更新 `.zu-ctx-bkd-tok` 的 `textContent`。
  - 开关关闭时：移除弹层内全部 `.zu-ctx-bkd-tok` 节点与 `data-zusage-bkd` / `data-zusage-bkd-cache` 属性，并调用 `hideCtxBkdTip()`。

## 3. 验收场景

1. Token 数计算与格式：`used = 325000`，分项 `74.7%` → 中文默认显示 `24.28万 · `（`325000 * 0.747 = 242775` → `fmt(242775) = "24.28万"`），开启强制 K/M/B 显示 `242.8K · `，英文界面显示 `242.8K · `。四舍五入：`used = 101`、`50.0%` → `51`。小数逗号：`50,5 %` 按 50.5 解析。
2. 七类标签识别与悬停气泡：中文与英文的 7 类标签均能识别并弹出对应的双语说明气泡；移出或弹层卸载即收起；隐藏后的下一拍对账不会把气泡重新拉起。
3. 开关控制与幂等：`zusage3.ctxBkd="0"` 时不注入 Token 节点、不弹气泡；运行中关闭开关立即摘除已注入的 `.zu-ctx-bkd-tok` 并收起气泡，重开立即恢复；多次 `tick()` 节点不重复创建。
4. 气泡不拦截鼠标：`pointer-events: none`，路径不是可聚焦控件，`pointerdown` / `click` / `Enter` 都不调用 `openInFileManager`；真机上悬停第 2 行后上移到第 1 行，宿主弹层保持打开、气泡切换。
5. 路径：记忆索引位置写 `~/.zcode/cli/memories/projects/<工作区标识>/memory/MEMORY.md`，不出现 `~/.zcode/projects`；Windows 路径按反斜杠拼接；同名技能只列一次并补全目录；home 与工作区之外的技能目录、以及字面落在其下但用 `..` 穿出去的目录，都只列名称。
6. 热重载：弹层没关时重新注入，新一代仍能弹出气泡。

## 4. 验证证据（2026-11-26，本机 macOS、ZCode 4.0.0）

- 宿主事实（调试协议只读探测真实页面，未部署候选时取得）：
  - 分项百分比是「占已用」：实测 消息 77.9% + 其他 12.3% + 系统工具 7.1% + 技能 1.6% + 系统提示词 1.1% = 100%。宿主源码 `packages/ui/src/chat-input-toolbar/contextUsage.tsx` 按各分类字符数占比计算。
  - `taskUsage` 在触发器 fiber 第 45 层祖先的 `memoizedProps` 上，形状 `{used, size, cache, breakdown}`，`cache` 的 8 个字段名与本实现一致；`workspacePath` 在第 46 层；会话快照 `snapshot` 在第 56 层，其 `rows.window` 含 `toolCall` 行（Skill 行带 `input.skill` 与 `output.text`，输出末尾有 `Base directory for this skill:`）。
  - 分项行结构：`aria-label="上下文来源"` 容器 → grid → 每行三个子节点（色点、`truncate` 标签、`ml-auto min-w-10 … tabular-nums` 百分比）；缓存行首个子节点文本「平均缓存命中率」。
  - 记忆索引真实布局：本机存在 `~/.zcode/cli/memories/projects`，不存在 `~/.zcode/projects`。
- 部署后实测（运行目录 `overlay.js` 与候选逐字节一致，同一页面 `__zusageGen` 递增后）：
  - 分项行显示 `28.84万 · 84.3%`、`3.04万 · 8.9%`、`1.68万 · 4.9%`、`3763 · 1.1%`、`2737 · 0.8%`，与「上下文已用 342,116」按占比折算一致；Token 数为弱化灰、字号与百分比相同。
  - 悬停「其他」行气泡弹出，内容含估算用量、双口径占比、原始文本、包含内容与减负建议。
  - 气泡与宿主弹层的指针关系（同一页面、同一构建，用注入样式只切换气泡是否拦截鼠标的受控对照，6 轮几何均未漂移）：拦截鼠标时，悬停第 2 行后上移到第 1 行，3 轮里 2 轮宿主弹层关闭；指针穿透时，同样动作 3 轮全部保持打开，气泡标题切到「消息」。探测时窗口处于隐藏（节流）状态，事件时序有抖动，所以拦截组不是每轮都关。
- 自动化：`tests/overlay-compact.test.cjs` 末尾的 v487 用例与 `tests/overlay-settings.test.cjs` 的开关用例覆盖上面 6 个场景，另有开关持久化与「整张弹层卸载后健康检查收起」两例。
- 变异：最初候选上批跑过 40 条预置变异，25 条被杀、16 条存活。存活的 16 条里，11 条（英文标签、启动读偏好、写偏好、对账收起、英文缓存行、健康检查、已用量兜底与降级、左缘钳边、上下翻转）已由补上的用例覆盖，并用有效变异复验杀死；其余 6 条未单测：复用节点不在百分比前时重新归位（防御分支）、`render()` 两处重算调用、子节点不足 3 个的行跳过（防御分支）、气泡内容签名幂等（只影响重写次数）、启动清扫选择器里的 `.zu-ctx-bkd-tok`（弹层重开时由对账分支兜住）。针对修复点的 14 条有效变异（四舍五入、小数逗号、记忆路径、代际委托、目录可信限制、主题类、翻转分支、技能去重、气泡拦截鼠标、移出即收起、跨行切换等）也全部被杀死。
- 尚未覆盖：浅色主题、窄窗与英文界面下的真机观感；Windows 真机；`render()` 两处重算调用没有单测（夹具不推数据推送）。
