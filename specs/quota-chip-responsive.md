# 套餐额度 Chip 工具栏响应式自适应

## 目标与边界

套餐额度 chip（`.zu-quota`）随 ZCode 输入框工具栏的实际可用宽度渐进降级：宽屏保留全窗口、窄屏压缩文案、更窄留主窗口摘要、极窄留图标，空间仍不足时优先保宿主原生控件并隐藏 chip，恢复宽度后自动重新出现。

- 仅改渲染层展示形态；不改额度客户端抓取/归一化/TTL/退避/凭据，不改本地 token 统计、CLI/MCP 输出、底部状态栏排序/优先级/折叠（`zusage3.barOrder`/`barPriority` 不参与工具栏）。
- Git chip、原生上下文按钮（含压缩入口）、速度 chip、重置卡、增强按钮、宿主原生控件各自独立，本规格只调整额度 chip 自身的宽度占用，不劫持/覆盖/隐藏它们。
- 数据语义、档位色、`quotaRemain` 口径、点击 `quota-refresh`、Tooltip 完整明细全部沿用既有契约（[quota.md](../.zcode/rules/quota.md) §1/§5）。

## 根因（已由当前源码与真实 ZCode CDP 取证）

1. 额度 chip 无响应式逻辑：`quotaSegs()` 固定顺序全量渲染所有有效窗口，`enhanceQuotaChip()` 只做"挂载 + 幂等重写内容"，宽度不参与任何决策（`src/overlay/11-instance-toolbar-chips.js:462-585`）。
2. chip 自身 `flex:0 0 auto` + `.zu-qseg{white-space:nowrap}`（`src/overlay/06-instance-dom-and-styles.js:637,643`），永不收缩；其 wrapper 是宿主 `<span class="inline-flex shrink-0">`（`ZCode/packages/ui/src/chat-input-toolbar/contextUsage.tsx:966`），不可压缩。
3. Git chip 同样 `flex:0 0 auto;white-space:nowrap`（`06:599-600`），永不收缩。
4. **真实 CDP 祖先链（2026-11-17，1358px 窗口）**：`.zu-quota` → `span.inline-flex.shrink-0`（157.4px）→ `span.flex.min-w-0.shrink.items-center.gap-1.overflow-hidden`（316.6px，**overflow:hidden 裁剪行**）→ `div.flex.min-w-0.items-center.gap-1` → `div.ml-auto.flex.shrink-0.justify-end`（`data-composer-trailing-actions`，380.6px）→ 工具栏行。即额度 chip 实际位于 **trailing 区**的 `overflow:hidden` 行内（不是 leading 区），窄窗时该行裁剪右侧原生控件；Git chip 在独立的 leading 区。二者 DOM 不同父，视觉相邻挤出。宿主 `fitComposerToolbar` 只折叠带 `data-composer-collapse-priority` 的原生控件（cua-entry 等），注入 chip 无该属性、不参与宿主折叠链（`ZCode/packages/ui/src/prompt-editor/useComposerToolbarFit.ts:26-60`）。
5. 实测数值：宽 1358px 窗口下 `.zu-quota` 宽 87.6px、wrapper 157.4px、`overflow-hidden` 行 316.6px、leading 区 426.4px、overflow 0；窄窗时该行 clientWidth 收窄裁剪。无负 margin/transform/绝对定位造成的文字重叠（`transform:translateY(-1px)` 仅纵向 1px）。测量目标是 chip 所在的 `overflow:hidden` 行 `clientWidth`，其随窗口收窄而变化，是响应式算法的正确锚点。

## 数据契约（复用，不新造）

- 有效窗口来自 `quotaSegs(q)`：`{label, pct}` 按 `daily→fiveHour→weekly→monthly→plan` 固定顺序，仅 `typeof pct==="number" && isFinite(pct)` 通过者入选；余额 `q.balance.amount`（金额，非百分比）、Key 剩余 `q.quotaSummary.remaining`、info（未配置/暂不支持/团队）、error/status 等形态保持原样，不进入"窗口"抽象。
- 档位：`QUOTA_BANDS`（`src/overlay/07-instance-render-and-tips.js:58-69`）按原始已用 pct 判定，`quotaBandOf=bandOf`，三档色映射 `<50 绿 / 50–89 黄 / ≥90 红 / ≥100 exc` 不变。
- 显示口径：`zusage3.quotaRemain`（`state.quotaRemain===1`）只翻转显示数字为 `100−已用`，档位色恒按已用判定；主窗口选择与风险判定一律用原始已用值。
- Tooltip：`chip.__zuQ` 保留完整 `{q,all,srcLabels,provider,model,mode}`，各级显示都不裁剪；`quotaTipHTML` 展示全部真实字段。

## 四级显示形态（显示形态，不是固定宽度阈值）

| 级 | 名称 | 形态示例 | 规则 |
|---|---|---|---|
| L0 | 完整 | `今日 26% \| 5时 92% \| 7天 12% \| 月 8% \| 套餐 2%` | 所有有效窗口，沿用现有分段与 `\|` 分隔、现有档位色；v382 起全档短标签 |
| L1 | 紧凑 | 中文 `5时 26% · 7天 12% · 月 8%`（英文 `5h 26% · 7d 12% · 1mo 8%`） | 所有有效窗口；短标签（中/英按 `state.lang`）、`·` 分隔、gap 收紧；字号不缩小到难读 |
| L2 | 摘要 | `7天 92% +2` | 仅主展示窗口 + `+N`（N=被隐藏的有效窗口数，不含无数据/不适用）；`+N` 是 chip 内非交互文本，不建嵌套 button |
| L3 | 最小 | `额度图标 5时 3%` → `额度图标` | 图标+主窗口短标签+数值；再不足退为纯图标；任何形态保留 aria-label 与 Tooltip；图标色取主窗口档位色 |

- 极限降级：连 L3 都放不下时隐藏 chip（不渲染空白占位、不遮挡原生控件），恢复宽度自动重现；不增加浮动遮挡。
- 非窗口形态（余额/info/team/error/quotaSummary）始终单行单段，不参与 L0/L1/L2 的多窗口压缩；仅做图标/文本的最小化（L3 保留数值则留数值，否则仅图标）。
- 短标签表（2026-11-17 用户规格：`5小时`→`5时`、`本月`→`月`，**全档统一**——L0 完整档也用短标签，aria 同步；tooltip 窗口行保留「5小时窗口/本月窗口」全称，完整明细语义只在 tooltip 收窄）：中文 `今日/5时/7天/月/套餐`，英文 `1d/5h/7d/1mo/plan`。
- 图标：SVG，`currentColor`，path 与 `ico()` 模板一致（24 viewBox），语义为"套餐额度"（层级/堆叠层形状），避免 Emoji 与裸百分比。

## 主展示窗口选择（纯函数，可单测）

`pickQuotaPrimary(segs)`：只处理展示选择，不改数据。

1. 输入：`segs`（来自 `quotaSegs` 的 `{label,key,pct}[]`），按 `daily→fiveHour→weekly→monthly→plan` 固定顺序。
2. 默认（全部正常）：按既有 `daily→fiveHour→weekly→monthly→plan` 顺序取第一个**有明确短周期**的窗口；无短周期时取第一个有效窗口。顺序稳定，不随无关刷新重排。
3. 告警优先：若存在 `band` 为 `crit` 或 `exc`（原始已用 ≥90）的窗口，在告警集合内取"最严重（exc>crit）"，同级按原顺序第一个；越过默认短周期窗口。例：`5时 3% / 7天 92% / 月 2%` → 选 `7天 92%`。
4. 严重度稳定：按原始已用 pct 的档位（非显示补数），`quotaRemain` 切换不影响选择；数值轻微抖动不跨档时不换主窗口。
5. `+N = 有效窗口总数 − 1`，仅 L2 渲染；单窗口不显 `+N`。

## 测量与选级算法

- 纯函数（在 `src/overlay/11-instance-toolbar-chips.js`，经 `window.__zusageQuotaFns.all()` 供 VM 单测；`.all()` 延迟求值避免 var 提升时序陷阱）：
  - `quotaShortLabel(seg, lang)`：短标签映射。
  - `quotaCandidates(mode, lang, remain, bands, bandOfFn)`：生成 L0/L1/L2/L3/L3I 的 `{html,aria}` 候选；非窗口形态（余额/info/team/error）原样返回单段，不裁剪语义。
  - `pickQuotaDisplayLevel(order, avail, measure, current, hyst)`：`order` 为等级数组、`avail` 为可用宽度、`measure(key)` 返回候选自然宽、`current` 为持久等级（可为 `hidden`）、`hyst` 为展开迟滞；返回能容纳的最完整等级，连最简都放不下返回 `hidden`。
  - `quotaMeasureAvail(btn, chip, leadingRight?)`：DOM 适配，返回额度 chip 的真实可用宽度。**不变式**：trailing 组右对齐（ml-auto），chip 增宽 Δ 时 chip 左缘左移 Δ、压缩与 leading 内容的空隙，故 `avail = refW + (ref.left − leadingRight) − SAFETY`（chip 在显 ref=chip、refW=chipW；chip 已摘除 ref=btn、refW=0）。该值与 chip 当前宽度无关（自指相消），不会因收缩/隐藏而坍缩为 0。`leadingRight` 取宿主 `[data-composer-leading-content]` 右缘（shrink-0 内容定宽），回退本插件 Git chip 右缘；找不到返回 null 走 fail-safe L0。注意**不能用** chip 所在 trailing 行自身的 `clientWidth` 作分母——该行右对齐贴内容，行宽≈内容宽，用它相减恒得 ≈0（自指测量，曾致 chip 摘除后永久隐藏）。带几何签名缓存避免热路径反复强制 layout；`clientWidth` 缺席（VM/脱离布局）或行结构未标定（非 `overflow-hidden`+`min-w-0`）返回 null 走 fail-safe L0。
  - `pickQuotaPrimary(segs)`：告警优先主窗口选择，见上节。
- 选级依据 = **真实工具栏布局宽度**，不用 `window.innerWidth`、不用字符数估算、不用固定媒体查询。额度 chip 挂在原生上下文按钮 wrapper 内、处于宿主 trailing 区（`overflow:hidden` 行），实测该行而非 leading 区。
- 候选宽度用离屏测量节点（`position:absolute;visibility:hidden;width:max-content`）实测并按候选串缓存，不隐藏在显 chip 再量；离屏节点 dispose 时清理。
- 防震荡：合并到实例已有的 render/heavy 双 reapply 点；变宽展开加 20px 迟滞（`hidden`/各等级统一 rank 表），变窄立即收缩；迟滞不得造成不可恢复折叠；几何签名变化即重测。不新增全局 scroll/resize 监听，未引入 ResizeObserver（VM 夹具无布局时自然降级）。
- 幂等：显示等级写入 `data-zusage-qlevel`（React 不动 data-*），内容签名 `__zuSig` 包含 level；等级变化不改变 `chip.__zuQ` 原始数据、不重建 Tooltip、不重复绑事件。

## 交互与无障碍（保持不变）

- 点击 chip 仍仅发 `pluginRequest("quota-refresh", {sourceId})`；`+N` 不嵌套 button、不新增 click 目标。
- hover/focus 仍弹 `showQuotaTip` 完整明细；`+N` 窗口、被隐藏窗口在 Tooltip 中照常列全；窄屏 Tooltip 沿用现有 `max-width:520px` + 上下翻转 + 左右钳边（`01:415-433`），不新增浮层系统。
- aria-label 在各级都保留完整所有窗口真实数据（L1/L2/L3 不裁剪）；仅图标态 aria 含"套餐额度"字样。
- `role=button`/`tabIndex=0`/Enter·Space 刷新/焦点轮廓沿用现有实现（`11:521-577`）。
- 浅色主题沿用 `data-zusage-light` 派生；exc/busy/stale 视觉沿用现有类。
- `prefers-reduced-motion` 下新增动画（若有）必须禁用；现有 exc/busy 动画不在本规格内改动。

## 状态矩阵（必须兼容）

多窗正常/单窗/任一窗≥90%/100%+ exc/剩余口径/余额/零余额/未配置/暂不支持/团队/显式关闭/status 错误/stale/busy/限流/空或非有限值/换供应商/provider_fallback/多分栏/旧快照缺字段——各级均不伪造 0% 或假窗口，形态与既有语义对齐。

## 测试与验收

- 纯函数与 DOM 行为（`tests/overlay-quota-responsive.test.cjs`，14 例）：主窗口优先级（默认/告警/同级稳定/口径解耦）、`+N` 计数、短标签（全档统一表逐键断言）、五级候选、`pickQuotaDisplayLevel` 迟滞/恢复/hidden 边界、`quotaMeasureAvail` 真实算术（含变异测试锁 `row.clientWidth` 防 `clientW` 回归）、`quotaLeadingRight` 解析链（祖先命中/坏 rect 跳过/双缺失 null→fail-safe）与 `QUOTA_HYST` 16–24px 接线、余额/info 非窗口形态图标化、CSS 档位色。
- DOM 行为：仍挂上下文按钮左侧、React 重排重挂幂等、等级切换不改 `__zuQ`、hover/focus aria 完整、关闭/dispose 清理、多 pane 不串。
- 真实几何（`tests/overlay-quota-geometry.test.cjs`）：连本机真实 ZCode CDP 9229，量额度 chip 所在宿主行 `overflow:hidden` + `min-width:0` + 各宽度 `clientWidth` 可测 + 原生上下文按钮命中宽；无工具栏时显式 skip 而非假绿。早前 1358px 窗口实测：测量行 `clientWidth` 随 CSS 视口 900→480 从 316.6→141，chip 宽 87.6px、与按钮重叠 0，证实该行是随窗口收窄的真实裁剪行（不是 shrink-0 leading 区）。VM 测试只覆盖选级/算术，不冒充几何。
- 未知容器 fail-safe：`quotaMeasureAvail` 只在实测过的宿主行（`overflow-hidden` + `min-w-0` 两类名）上启用收缩；其它宿主版本/测试夹具的未标定行直接保持 L0，避免在未知结构上误判隐藏。
- 实机：真实 ZCode（CDP 9229）截图矩阵见任务 §14；本会话被 CDP 注入的 `new-provider` 自定义模型导致额度 chip 按既有门控隐藏，完整实机截图矩阵受此环境限制未能全量取得，已在最终报告列明。
- 回归：原 `overlay-quota-chip.test.cjs` 55 例、`overlay-font-fit`、`overlay-pill-theme`、`overlay-port-patches` 与额度链测试保持绿；`node --check`/`build_overlay.py --check`/`sync_plugin.py --check` 通过。
