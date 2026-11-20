# 统计 Tooltip 响应式布局

适用：本轮、会话累计、今日合计、项目累计四类统计卡（`src/overlay/07-instance-render-and-tips.js` 的 `statCompactStyle`/`statModelsTable`/`buildProjectTipHTML`、`06-instance-dom-and-styles.js` 共享统计卡规则、`08-instance-bridge-and-subrate.js` 的 `positionTip`）。工具调用卡共用 `statCompactStyle` 骨架但**不在本规格范围内**：宽度与排版保持现状（450px 跟随视口收缩），共享模式规则的作用域选择器必须把它排除。大字号/长文本防护契约见 [stat-tooltip-large-text.md](stat-tooltip-large-text.md)（继续生效，本规格不放宽任何一条）。

## 1. 宽度体系

- 每卡理想宽度（CSS 像素，与 PRD 建议一致）：本轮 540、会话累计 600、今日合计 600、项目累计 760。
- 实际宽度恒为 `min(理想宽, calc(100vw - 16px))`，即 `width/max-width: min(var(--zu-tip-w), calc(100vw - 16px))`，`--zu-tip-w` 由各卡内联 style 注入（每卡一份 `statCompactStyle` 串，机制不变）。窗口再窄时跟随视口收缩，绝不撑出窗口；不要求四卡同宽。
- 理想宽度是内容排版基准，不是硬性固定值；四卡互不一致是有意设计。

## 2. 布局模式

- 四档模式按**卡片实际内容宽**（`.zu-stat-tip` 根元素 rect 宽）相对**每卡理想宽**（卡根 `data-zu-w` 属性，单一事实源=07 分片 `STAT_TIP_W`）判定：
  - full：卡宽 ≥ 理想宽 − 24（完整布局：三列 KPI + 完整模型表）；
  - compact：≥440 且未达 full（已偏离理想宽，但三列 KPI 与五列表仍完整可读，无专属降级规则——实测 440–599 区间默认排版即「优化三列」形态，不强行再降）；
  - narrow：360–439（降列 + 副行）；
  - tiny：<360（表格卡片化）。
- 模式载体=统计卡根元素上的 `data-zu-mode` 属性，由 `positionTip` 在量出宽度后顺手写入（仅变化时写 DOM）。**不新增 scroll/resize 监听器、不引入 ResizeObserver**（overlay-ui §4 监听预算红线）：`positionTip` 本就持有测量结果，打开/重建/重定位时模式随之刷新；tooltip 打开中窗口骤缩的模式陈旧由 §6 的 `@media` 兜底承接，不为此加监听。
- `@media` 兜底的数学依据：卡宽=min(理想宽, vw−16)，当 vw < 理想宽+16 时卡宽恒=vw−16，视口断点与卡宽断点一一对应；窗口宽裕区间卡宽恒=理想宽，`@media` 天然不触发。因此少量 `@media` 块可以精确表达「卡进入某模式」的安全规则，且老 Chromium 全支持。
- 模式规则的作用域选择器统一为 `:is(.zu-stat-tip--turn,.zu-stat-tip--session,.zu-stat-tip--today,.zu-stat-tip--project)[data-zu-mode="…"]`（或逐卡展开），**绝不允许裸 `[data-zu-mode]`**——工具卡与速度 V3 卡不得被波及。
- 已知宿主边界：窗口窄到统计格被既有 v352 折叠链收进「···」菜单后，格不可悬停、tooltip 自然不出现——narrow/tiny 档的实际触发面是「启用格较少/格仍可见」的窄窗形态，与折叠链互不冲突。

## 3. 高度

- 高度恒由内容驱动（`height:auto`，无定高），不因单模型留多模型空白，不为模式切换保留占位。
- 视口约束：根 `max-height:calc(100vh - 24px)` 钳制保持；超出时根 `.tbody` 允许纵向滚动，且**滚动条必须可见**（`scrollbar-width:thin` + `::-webkit-scrollbar` 窄条）——「隐藏滚动条的内滚区」是本规格明确废除的形态。
- 模型明细滚动区（`.zu-turn-models`，turn/session/today 卡）保留：标题行固定、表体区内滚、时间行钉底是 v299 既定契约；本项目规格只统一滚动条可见性，不消除该双层结构（避免「footer 被挤出」回退）。
- 高度变化后的定位沿用既有链：数据刷新 `drawTip→positionTip(keepTop)`；项目卡 Tab/展开走 `projTipRebuildNow`/`projTipApply*` 的底边固定向上生长（grow-up）。本规格不新增定位机制。

## 4. KPI 统计卡响应

- 模式规则（`:is` 四卡作用域）：
  - compact（440–599）：维持三列网格；主数值沿用 `turnVBkt` 长度分桶缩字号，不新增缩字档。
  - narrow（360–439）：行一（总用量/输入/输出）改「总用量整行 + 输入/输出双列」；行二（请求次数/轮数/会话）与行三（耗时）维持三列（数值短）；行四（速度/费用）维持双列。次级说明（缓存命中率/含思考）保持数字下方副行形态。
  - tiny（<360）：所有 KPI 行退为两列网格，总用量恒整行（`grid-column:1/-1`）；单格行（`--duo` only-child、`--trio`）继续占满整行不留空档。
- 数值完整性：`.zu-stat-v` 保留 nowrap+ellipsis 防压列，但 statKpi 值节点补 `title`（完整值），任何模式下完整值悬停可达；「费用、Token、时间必须可查看完整值」由分桶缩字+降列加宽+title 三层承接，**不得出现静默截断且无兜底的形态**。
- 字号标尺不动：全部沿用 `calc(var(--ui-font-size,14px) ± N)` 与既有分桶，不因窄屏整体缩小字体（PRD 禁止项）。

## 5. 模型明细三模式（`statModelsTable` 家族 + 项目卡模型表）

- 同一 DOM、CSS 变形，构建器产出结构恒定（避免双份 HTML 与 JS 模式判断）：
  - **full/compact**：五列完整表（模型/Token 用量↓/请求次数/平均速度/预估费用，费用列随 `state.cost` 门控），现状排版。
  - **narrow**：速度、费用两列隐藏；每行首列单元格内预置的副行（`平均速度 X t/s · ¥Y`，构建时常驻 HTML、默认 `display:none`）显示，数据不丢失。表头同步隐藏对应列（`colspan` 不引入）。
  - **tiny**：表格 `display:block` 卡片化——每模型一张小卡（名称行；Token/请求行；速度/费用副行），字段名由 `td` 的 `data-l` 属性经 `::before` 呈现；卡片间以低对比分隔线区分，不新增边框底色层。
- 模型名截断链不变：首列帽 + ellipsis + `fitModelNames` 缩字（≥10px）+ `title` 全名。
- 排序行为不退化：恒按 Token 用量降序（上游已排序 + 渲染端对副本防御性重排），表头「Token 用量 ↓」标注持续承载排序语义；本规格不新增交互排序（现状无此功能，不臆造）。
- 展开/收起（项目卡 `projTipApplyModels`、前 6 默认）与空态（整块不渲染）契约不变；局部更新路径在模式类存在时行为不变（只替换 tbody innerHTML，模式在下一帧 `positionTip` 刷新）。
- 单模型场景：明细仅一行时表格自然矮、无「查看全部」按钮、无多余空白（现状行为，模式规则不得引入最小高度）。

## 6. Header 与页脚

- 标题行契约沿用 v370/v372：标题文字恒单行、名称在剩余宽度内省略（360px 上限）、范围胶囊/Tab 不压缩不换行、垂直居中。
- 项目卡项目名（`.zu-pj-pname`）：narrow 起允许换行到标题第二行独占整行（`flex-wrap` + `flex-basis:100%`），Tab 保持在第一行右侧不被挤出；full/compact 维持同行。
- 时间范围页脚（`.zu-stat-time`）：`flex-wrap` 已有；narrow 起「时间范围」标签与起止区间分两行（区间 `flex:0 0 100%`）；tiny 下起止区间再允许内部断行为两行（起一行止一行），日期信息不丢失、不用固定高度截断。

## 7. 明确不变项

- 统计口径零改动：总用量=输入+输出（含缓存/思考不再相加）、命中率分子分母、`请求会话=所属项目累计会话数`（v302 用户规格，大于当前会话范围是有意聚合）。
- 视觉零重构：实色深灰背景、`--color-*` 语义变量、绿色 `#4ade80` 强调、圆角/阴影/边框、TPS 档色全部沿用；不引入玻璃拟态、渐变背景、Emoji。
- DPI：全程 CSS 像素（rect + innerWidth/innerHeight），不引入 devicePixelRatio 换算；`zoom` 仍限速度卡路径。
- 定位：居中锚定 + 8px 边界钳制 + keepTop + 项目卡 grow-up 全部保持；靠近右缘时既有 clamp 已等效「向左收」，不另造翻转逻辑。
- 交互：pointerdown 先行（Tab/展开）、Escape 分层、fxTip 保活、伪 mouseleave 甄别、悬停中不重画（速度卡除外）全部不动。

## 8. 验收

- 自动化：模式属性写入（宽度→模式映射、不变不写）、`:is` 作用域不含 tools/速度卡、宽度串逐卡断言、narrow/tiny 的 CSS 规则存在性、副行 HTML 常驻且默认隐藏语义（类名存在）、卡片化 `data-l` 齐备、statKpi title 兜底、`.tbody` 滚动条可见化后既有「禁 display 注入」等卫生断言保持。
- 实机（CDP 设备度量模拟 + 真实悬停）：宽度 320/360/390/430/450/540/600/760/900/1280、高度 600/720/900/1080 下四卡打开不越界、模式切换正确、tiny 卡片化可读、项目卡 Tab/展开后 grow-up 正常；深浅主题、14/17/20px 字号抽查。Headless 模拟不替代 Windows 实机高 DPI 截图（交付时如实标注未验项）。
