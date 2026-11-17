# OpenCode Go 模型口径额度换算（v385，issue #382）

## 背景

OpenCode Go 官方按模型给月度额度（opencode.ai/go "allowances vary by model"，changelog 曾专门上调 DeepSeek V4.1 Flash），而 `/console/api/go/status` 的 `access.meters` 是**账户基线池**（Go 档实测 $60/月、5h 窗 20%、周窗 50%），端点不提供模型级数据（issue #382 实测 `?model=`、请求头、`/console/api/go/*` 各端点均无效）。用 DeepSeek V4.1 Flash（$100/月）时按基线显示会少 40%。

## 契约

换算只发生在**渲染端**（`src/overlay/11-instance-toolbar-chips.js` 的 `quotaOpencodeModelView`），额度链、协议、调度器零改动（「模型不入键」取舍不变，模型切换不触发重查——meters 数据本身模型无关）：

- **门槛**（任一不满足原样返回，绝不伪造）：
  1. 当前源 id 为 `opencode` 或复合源 `opencode:<providerId>`；
  2. 当前 pane 模型（小写）精确命中模型表（2026-11-17 抓取自 opencode.ai/go 的 28 款快照）；
  3. 月窗 `total` 恰等于 Go 档账户基线 `60`（档位锚定）。Plus 档基线官方页面未明示，**不验证不换算**；官方调基线后表过期同样回落基线显示。
- **公式**：窗口总额 = 模型月度额度 ×（该窗基线总额 / 月窗基线总额）——窗占比跟活接口走，不硬编码 20%/50%；`used` 是账户窗口内实际花费、模型无关，**保留原值**；`percent = used/新总额` 重算并钳 [0,100]（账户花费超过小额度模型上限时语义即「已到顶」）；`remaining` 重算；原对象不变异（浅拷贝 + 窗口逐个替换）。
- **披露**：换算生效时 `q.modelBasis` 置模型 id，tooltip 页脚换模型口径说明（opencode.ai/go 快照 + 官方调价以官网为准 + 已用为账号实际花费）；未换算维持「套餐池为账号级」固定页脚。
- **消费点**：chip 分段（`quotaChipMode`）与 `chip.__zuQ.q`（tooltip）同吃换算视图，两处口径恒一致。
- **不换算的链路**（有意保持原始基线）：兜底链（public usage 端点窗口只有基线 percent、无金额锚点）、⚙ 面板源列表与其他源摘要行（无模型上下文）、重置卡（只消费重置时间）。

## 与「账号级口径」合同的关系

AGENTS.md §5「额度是账号级套餐池口径，chip/tooltip 不得出现模型独享额度语义」针对的是把共享池误标成模型独享（BigModel/Z.ai 语义上是错的）。OpenCode Go 是官方明示的按模型口径，属有依据的例外：tooltip 明示换算依据与快照日期，未命中/锚不上时 fail-open 回真实基线，绝不虚构数字。

## 维护责任

模型表是快照数据：官方调价/上新时需重新抓取 opencode.ai/go 同步（表内注释带抓取日期）。表过期不会显示错误数字——锚定与门槛不满足时一律显示活接口基线。

## 回归

`tests/overlay-quota-opencode-model.test.cjs`（8 用例）：已知模型换算（1/2/4 vs 基线 2/3/7）、tooltip 金额与披露、未知模型回落、非 opencode 源不换算、基线锚定（Plus 档不换算）、窗占比跟活接口（非硬编码 20%/50%）、超上限钳 100%（exc 档）、模型切换零重取且源数据零变异。
