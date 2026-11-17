# Git 状态 Chip 工具栏响应式自适应

## 目标与边界

Git chip（`.zu-git`）随 ZCode 输入框工具行前导区的真实可用宽度渐进降级：宽屏保留完整状态，窄屏收起分支名，更窄留摘要，极窄留图标与风险标记，空间仍不足时优先保宿主原生控件并摘除 chip，恢复宽度后自动重现。

- 仅改渲染层展示形态；不改 Git 数据链（`gitTick`/`git-refresh`/`__zusageGitState` 推送、10s 周期、5s 节流）、多仓聚合口径、Tooltip 内容、点击刷新、aria 播报、`zusage3.barOrder`/`barPriority`（不参与工具栏）。
- 套餐额度 chip、原生上下文按钮（含压缩入口）、速度 chip、系统状态 chip、增强按钮、宿主原生控件各自独立，本规格只调整 Git chip 自身的宽度占用，不劫持/覆盖/隐藏它们，不新增全局 Observer 或 scroll/resize 监听。
- 数据语义、计数缩写（v128 `gitNum` <1万原值规则）、颜色语义（+绿/-红/?黄/冲突红/过期警示黄）、`zu-gbusy` 刷新忙态全部沿用既有契约（[overlay-ui.md](../.zcode/rules/overlay-ui.md) §6）。

## 根因（已由当前源码与真实 ZCode CDP 取证，2026-11-17）

1. Git chip 无多级响应逻辑：`gitChipHtml()` 固定全量渲染，`gitChipCompact()` 只有两态——宿主 `data-composer-compact="true"` 强制紧凑（CSS 隐分支名+↑↓），加 32px 恢复迟滞探测；插件自身永不主动收缩，也没有低于「紧凑」的形态（`src/overlay/11-instance-toolbar-chips.js` git 区段）。
2. chip 自身 `flex:0 0 auto; white-space:nowrap`（`src/overlay/06-instance-dom-and-styles.js` `.zu-git` 规则），永不收缩。
3. **宿主前导区结构（真实 CDP，1875px 窗口）**：工具行 `[class*="group/toolbar"]`（1048px）= `[data-composer-leading-actions]`（`flex min-w-0 flex-1 items-center`，**600.1px**，随窗口伸缩）+ gap 12 + `[data-composer-trailing-actions]`（shrink-0，435.9px）。实测恒等式 `leadA.width (600.1) = row.width (1048) − trail.width (435.9) − gap (12)` **精确成立**——前导预算纯窗口驱动，与 chip 内容无关（`ZCode/packages/ui/src/prompt-editor/ChatPromptEditor.tsx:458-478`）。Git chip 在 `[data-composer-leading-content]`（`flex shrink-0`，355.6px，含 CUA 90px + chip 113.6px）内。
4. chip 增宽直接吃掉前导预算：前导内容超预算触发宿主 `fitComposerToolbar` 逐档折叠原生控件（`data-composer-collapse-priority` 0–3，`useComposerToolbarFit.ts`）；注入 chip 无该属性、不参与折叠链。宿主全部折叠后若仍溢出，旧机制只能停在「紧凑」态——chip 溢出量原样挤压/重叠相邻元素，没有任何更低形态可用。
5. 实测可用宽度公式：`avail = leadA.width − (leadC.width − chipW)`（chip 在 leadC 内时减去自身当前宽）= 600.1 − (355.6 − 113.6) = **358.1px**，与几何直测（leadA 右缘 − chip 右缘 + chipW）一致。

## 数据契约（复用，不新造）

- 单仓字段：`branch/detached/noCommits/upstream/ahead/behind/ins/del/untracked/staged/unstaged/conflicts/op`；`ins`/`del` 是相对 HEAD 的工作区改动行数（非文件数、非净差异），`untracked` 是未跟踪条目数（目录折叠计 1），`staged`/`unstaged` 是 porcelain 条目数（只在 Tooltip，不上 chip）。`gitViewFor` 返回 `{st, stale}`；失败保留 `gitLastGood` 并以文字「过期」标注（不用透明度）。
- 多仓（`kind:"multi"`）：`gitMultiAgg` 产出 `total/known/changed/conflict/op/failed/staleAny`；「N改」是有改动仓库数、`!K冲突` 是确认冲突仓库数（stale 仓的冲突不计入已确认）、「F失败」是查询失败仓数——三者不混算、不套用单仓行数模板。
- 计数缩写沿用 `gitNum`（≥1万 中文万/亿、英文 k/M，<1万原值；aria 不缩写）。
- Tooltip：`chip.__zuGit` 保留完整 `{path, st, stale}`，各级显示都不裁剪；`gitTipHTML`/`gitMultiTipHTML` 展示全部真实字段；窄屏约束已由共享 `.tip` 基类满足（`max-width:min(560px,calc(100vw - 24px))` + 内滚 + `showGitTip` 左右钳制/上下翻转），本规格不改 Tooltip。

## 显示级别（显示形态，不是固定屏幕宽度阈值）

| 级 | 名称 | 单仓形态 | 多仓形态 |
|---|---|---|---|
| L0 | 完整 | `⎇ main ↑2 ↓1 (+764 -164 · ?4) !2冲突 变基中 过期`（现有 `gitChipHtml` 逐字不变） | `▣ 15仓 · 3改 · !1冲突 · 2失败 · 过期`（现有） |
| L1 | 紧凑 | 同 L0 串 + `zu-compact` 类（CSS 隐分支名与 ↑↓，既有机制） | 同 L0 串 + `zu-compact`（CSS 隐 N仓 段，既有） |
| L2 | 摘要 | `⎇ !2 +764 -164 变基中 过期 ⋯`；无改动时 `⎇ main`；只有未跟踪时 `⎇ ?4` | `▣ 15仓 !1冲突 2失败 过期 ⋯`（N仓 保留、M改 折叠） |
| L3 | 最小 | `⎇ ● !2 过期`（图标+状态点+风险短标） | `▣ ● !1 2失败 过期` |
| L3I | 纯图标 | `⎇ ●`（状态点承载风险色） | `▣ ●` |
| hidden | 摘除 | 连 L3I 都放不下时移除节点（保留数据与持久等级，恢复宽度即重现） | 同左 |

### L2/L3 细则（数据优先级）

- 风险段永不隐藏：`conflicts>0` → 短标 `!N`（红色，L2/L3 均显；L0 的「!N冲突」全称只在 L0/L1）；`op` → L2 保留操作词（`gitOpLabel`），L3 起 由状态点与 Tooltip 承载；`stale` → 「过期」文字徽章，各级保留（L3I 归入状态点中性色）。
- 工作段自适应：`ins/del>0` → `+N -N`（非零方向，语义色）；否则 `untracked>0` → `?N`；否则无改动显示分支名（`main`；detached 显 `HEAD`、无提交显「初始」）；都没有则无工作段。**不生成空括号、无意义分隔符或假汇总数字**——绝不用 `ins+del` 或 `ins−del` 伪造「变更总数」（设计参考图 Level 3 的 `Git 928` 语义错误，不采纳）。
- `⋯`（`zu-git-more`，非交互文本）：当且仅当有**工作区/同步信息被折叠**——`?N` 被行数段并入、或 ↑↓ 被收起。分支名收纳是 L2 的预期行为，不触发 `⋯`（任务书 `⎇ ?4`、`⎇ main` 示例）。没有折叠信息就不出现。
- 状态点（`zu-git-dot`，6px 圆点，复用现有语义色）：红=冲突（多仓含失败仓）、黄=有变更**或操作中**（rebase/merge 中不得显绿——review M1 定案，L3 丢弃操作词后点色是唯一视觉语义）、绿=已知干净、中性=未知/过期。L3I 下风险语义由点色保留，aria 恒全量。
- 多仓 L2 保留「N仓」计数与失败仓提示（摘要不得让用户误以为全部仓库查询成功）；「M改」折叠并计入 `⋯`。

## 测量与选级算法

- 纯函数（`src/overlay/11-instance-toolbar-chips.js` git 区段，经 `window.__zusageGitFns.all()` 供 VM 单测；`.all()` 延迟求值避免 var 提升时序陷阱）：
  - `gitCandidates(view, lang)`：生成 L0/L1/L2/L3/L3I 的 `{html}`（aria 全级共用 `gitChipAria` 全量，不裁剪）；L0/L1 复用 `gitChipHtml` 同串。
  - `pickQuotaDisplayLevel(order, avail, measure, current, hyst)`：**直接复用**额度 chip 的泛型选级函数（order 从最完整到最简、展开迟滞、`hidden` 兜底、`rank.hidden` 置最紧凑侧防临界抖动）。
  - `gitMeasureAvail(mount, chip)`：DOM 适配，返回 chip 可用宽度；返回 null = 无法可靠测量（VM stub / 宿主结构未标定 / 内容自撑行）→ fail-safe 保持 L0（宿主 compact 时 L1），绝不猜测收窄。
- **可用宽度公式（标定结构）**：`avail = leadA.width − (leadC.width − chipW_in_leadC)`，`chipW` 仅在 chip 已挂入 leadC 时取自身当前宽。反自指不变式：chip 变级/摘除时 `leadC.width − chipW` 恒定（自身宽度自消），`leadA.width` 由 flex-1 窗口驱动——avail 与 chip 当前形态无关，不会因收缩/隐藏坍缩为 0（额度 chip v382「自指黑洞」同款防线）。legacy 回退挂载（无 leading-content，chip 直接挂工具行）沿用旧 `gitChipCompact` 的行内求和口径：`avail = row.clientWidth − Σ(非 chip 子节点宽) − (n−1)×gap`，与旧展开边界数学等价（旧式 `used_总 + (full−current) + 32 > room` ⇔ 新式 `avail ≥ full + hyst`）。
- 标定守卫与两级行为（v146 夹具实证定案）：`leadA.width ≤ 1`、rect 异常、或结构缺 `leading-actions`/`leading-content` 对（含 inline 单行输入、旧宿主版本、纯合成夹具）= **未标定 → fail-safe 保持旧两态机制**（`gitChipCompactLegacy`：宿主 compact 强制 L1 + 32px 恢复迟滞探测，绝不猜测收窄或隐藏）。理由：无 `leading-actions` 的工具行里子元素可伸缩（flex shrink/拉伸），「行宽 − 子元素求和」会得到 ≈0 的伪读数（pill 夹具实测 leadW 69.2 + 兄弟段 352.8 ≈ 行宽 422 → avail≈0），多级收缩在未标定结构上会把 chip 误判成 hidden——这与额度 chip「只认 `overflow-hidden min-w-0` 行」同哲学：只在本项目实测过的宿主结构上启用收缩。
- 候选宽度用离屏探针实测（克隆 chip 节点，`position:fixed;visibility:hidden;width:max-content`，`aria-hidden+inert`，测量后立即移除——沿用旧探测模式），宽度按 `level|html|lang|fontSize` 缓存：数据/语言/字号不变时不重复克隆（render+heavy 双对账点高频）。
- avail 读数带几何签名缓存（`round(leadA)|round(leadC)|round(chipW)`），render+heavy 同几何零强制 layout。
- 防震荡：`GIT_HYST = 20`（展开迟滞；与额度 chip `QUOTA_HYST` 同带 16–24）；收缩无迟滞立即降级；hidden 回展同门控。等级持久在实例级变量（chip 摘除重建不丢迟滞态），并写 `data-zusage-glevel`（React 不动 data-*）。等级切换不触发 Git 数据重查、不重建 Tooltip、不重复绑事件。
- 宿主 compact 协同（明确状态所有者）：宿主负责原生工具栏折叠决策（`data-composer-compact`）；`true` 时本 chip 的候选序封顶为 `[L1, L2, L3, L3I, hidden]`（不再展开全名），否则 `[L0, L1, L2, L3, L3I, hidden]`。插件只选自身等级，不越权控制宿主原生按钮；不存在「宿主 compact → 插件展开 → 再 compact」循环（chip 降级只减小前导占用，宿主 unfold 后 avail 只增不减，展开另需 +20 迟滞）。

## 交互与无障碍（保持不变）

- 点击仍仅发 `git-refresh`（busy/请求回执/scope 迁移保护全保留）；`⋯`、状态点不新增 click 目标。
- hover/focus 仍弹 `showGitTip` 完整明细；Enter/Space 刷新、Escape 关闭、`aria-live` 播报、`aria-busy` 沿用。
- aria-label 在各级都保留完整真实状态（L1/L2/L3/L3I 不裁剪）；hidden 摘除期间 aria-live 清空 Git 段（与额度 chip hidden 同款）。
- 刷新在途（`zu-gbusy`）遇宽度变化降级时 busy 类随内容签名保留在重建的 chip 上；hidden 摘除后回执到达走现有 `gitChipCache` 判空路径；hidden 期间完成刷新、恢复宽度重建的新 chip 不带 `zu-gbusy`（回执已消费，完成播报已发）——已知无害边界，不作缺陷。
- hidden 期间每拍「重建空 chip→量测→再摘除」的节点抖动与额度 chip hidden 先例逐行同构（插拔同拍完成、无可见闪烁、avail 算术不受空 chip 影响），接受不改。

## 状态矩阵（必须兼容）

单仓无变更/只有新增/只有删除/只有未跟踪/增删并存/长分支名（沿用 16 字截断+esc）/领先/落后/无上游（不显假比较）/冲突（窄屏优先保留，短标 `!N` + 红点）/rebase·merge 中/detached HEAD/尚无首次提交（「初始」）/数据过期（「过期」文字+中性点，不降透明度）/查询失败（保留 lastGood+过期标）/非仓库·无 git·远端 pane（不挂载）/多仓全干净/多仓冲突/多仓部分失败（失败提示不丢）/多仓超上限/全 0/超大计数（万/亿缩写）/英文界面/中文单位关/多窗口不同仓库/快速切换工作区/数据更新与布局切换同时发生——各级不伪造干净状态、不混算行数与条目数。

## 测试与验收

- 纯函数与 DOM 行为（`tests/overlay-git-responsive.test.cjs`）：候选生成（单仓四态自适应、风险优先、`⋯` 仅在有隐藏信息时、多仓独立摘要、不出现假汇总）、`gitMeasureAvail` 真实算术（标定分支/legacy 分支/反自指/未标定 null）、选级迟滞与 hidden 回展、宿主 compact 封顶、busy 保留、aria 不裁剪。
- 既有回归（`tests/overlay-git-chip.test.cjs`、`overlay-git-multi.test.cjs`）保持绿；旧 `gitChipCompact` 探测语义由新机制承接处，仅允许按新语义**更新**断言，不得删除覆盖面。
- 真实几何（`tests/overlay-git-geometry.test.cjs`）：连本机真实 ZCode CDP 9229，量 `leadA = row − trail − gap` 恒等式、avail 公式与几何直测一致、各 CSS 视口宽度下 leadA 随窗口伸缩、原生控件不被 chip 覆盖；无工具行时显式 skip 而非假绿。
- 实机：真实 ZCode 截图矩阵（多宽度×多状态）与窄屏 Tooltip 走查见交付报告；VM 测试只覆盖选级/算术，不冒充几何。
- 回归：额度 chip 响应式（`overlay-quota-responsive.test.cjs` 等）、字体、主题、port-patches 与 git 链测试保持绿；`node --check`/`build_overlay.py --check`/`sync_plugin.py --check` 通过。
