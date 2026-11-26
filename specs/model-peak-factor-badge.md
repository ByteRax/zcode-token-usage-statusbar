# 模型选择器峰谷倍率徽标（GLM Coding Plan）

在宿主引擎「模型选择器弹层」的模型行上追加峰谷额度倍率展示。时段与系数的口径单一来源是 `token_pricing.py`（见 [peak-valley-time.md](peak-valley-time.md)），本特性只消费、不重写规则；JS 侧零时段判定。

## 产品规则

- **显示条件（三者同时成立）**：① 本行供应商属 GLM 编码计划族（`account:bigmodel-*` / `account:zai-*` 且含 `-coding-plan`；start-plan 无官方系数，暂排除）；② 快照带 `peak.glm_plan` 段（旧 Python/非桌面链无此段→整体静默）；③ 模型名（小写化）与 `factors` 键**精确等值**命中（不用子串——`glm-5.3-flashx` 与 `glm-5.3-flash` 各命中自身键不串档；未收录模型如 Highspeed **不显示**，宁缺勿错）。
- **显示内容**：按当前时段单值（快照生成时 Python 判定的 `is_peak`，**恒两位小数**如 `2.00×`/`0.67×`/`1.00×`——尾零裁剪会让各行宽窄不一、左缘参差，v484 真机反馈修正）；悬停 title 带双档全貌：`高峰 X× · 非高峰 Y×（额度消耗倍率，高峰：周一至五 14:00–18:00）`，双档同用两位小数格式化。弹层打开中跨 18:00 不实时变（维护者已拍板，2026-11-26）；快照泵刷新后由 heavy 对账更新。
- **UI**（参考维护者提供的截图，v484 定稿）：行右缘成列对齐（`margin-left:auto` + 恒两位小数 + `font-variant-numeric:tabular-nums`）、字号**随行文本**（不缩小）、`var(--color-foreground-subtle)` 弱化灰、`padding-right:6px` 与选中 ✓（引擎为 `absolute right-2`，位于 `pr-8` padding 区）留呼吸空隙且零重叠；文档流内追加在行内徽标容器末尾。
- **非对称多实例语义**：门控不过的实例对徽标**整体 no-op（绝不摘除）**——多个分栏多实例并发扫描同一弹层 DOM，防止非 GLM 窗格实例扯掉 GLM 窗格实例刚挂的徽标；摘除/更新只由门控通过的实例按数据失配驱动。

## 数据契约

- 快照新增顶层 `peak` 段：`{"glm_plan": {"is_peak": bool, "next_change_at": int, "factors": [["glm-5.4",0.67,2.0],["glm-5.3",1.0,3.0],["glm-5.3-flash",0.4,1.2],["glm-5.3-flashx",1.0,3.0]]}}`。生产端 `token_pricing.peak_snapshot_segment()`（唯一事实源），经 `zusage.snapshot(include_peak=…)` 注入，`_peak_segment_safe` 宽捕获、异常省略字段不拖垮快照。
- 门控边界与 `speed_history` 完全同旗：serve 路径 `include_peak=not lean`、桌面 JSON 路径 `include_peak=desktop`；CLI 报表/MCP 不走 `snapshot()`（另链查询，零影响）；手机中继 lean 链不带该段（`mobile-relay.cjs` lean 语义已证）。远端子查询投影无 `peak` 键（契约测试锁定）。
- 兼容性：旧 Python + 新 overlay → 段缺失静默；新 Python + 旧 overlay → 未知键被忽略。段内无凭据、无身份信息。

## DOM 锚点（引擎取证，ZCode 4.0.0 app.asar；引擎升级若改版则本特性静默失效，按此排查）

- 模型行：`[data-testid^="chat-model-select-item-"]`——**不带元素限定**（providerMenu 模式为原生 `button[role=option]`，普通下拉模式由 Radix 渲染可为 div）。testid value 编码 `<providerId>/<模型名>`。
- 行级供应商：最近祖先 `[data-model-provider-key]`，值=`registry-provider:<providerId>`，剥前缀即 quota 链 id。祖先缺失时回退：行 testid value 的首个 `/` 前段 → 本 pane 身份（`quotaSelection.providerId`/`effectiveQuotaProvider`）。
- 模型名：行 testid value 首个 `/` 后段（registry 模型 name=modelId），缺失时回退行内首个带 `title` 的 span（跳过倍率徽标自身，防其 title 被当模型名造成挂摘振荡），再回退整行文本。
- 挂点：行内徽标容器 `span.flex.min-w-0.flex-1`（无则行末尾）末尾追加；带 `data-zusage-peak` 标记幂等。
- 接线：复用 12 分片 hcObserver rAF 回调 + `heavy()` 对账，**不新增监听器**；弹层关闭徽标随宿主 DOM 销毁，dispose 零新增。
- 文案同步：徽标 title 内嵌「高峰：周一至五 14:00–18:00」展示文案，官方窗口变更时（只改 Python `PEAK_HOURS`）须同步 11 分片该字符串。

## 验收

- Node：`tests/overlay-model-peak-badge.test.cjs`——行级门控三段回退、命中/未收录、幂等重挂、React 复用行原位更新、数据失配摘除、门控不过 no-op（不摘他人徽标）、两位小数格式化、快照缺段静默、div/button 双容器。
- Python：`peak_snapshot_segment` 形状与异常安全；快照门控（桌面/serve 带、lean 不带）与远端投影无 `peak` 键。
- 实机：BigModel 个人窗格开选择器，GLM-5.4/5.3/5.3-Flash/5.3-FlashX 四行右缘现当前时段倍率（FlashX 显体验版 1.00×/3.00×）、Highspeed 无；工作日 14–18 高峰实做、18:00 后重开验证非高峰值；providerMenu 浏览、普通下拉、非 GLM 窗格不串。
