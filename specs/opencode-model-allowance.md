# OpenCode Go 额度口径：账号共享额度池，不按模型换算（v442，issue #453）

## 背景

v385（issue #382）把 opencode.ai/go 的 "allowances vary by model" 与各模型月度额度表读成「官方按模型给独立额度」，把 `/console/api/go/status` 的 `access.meters` 当作「账户基线池」，在渲染端按当前模型放大窗口总额并重算 percent。这是误读。issue #453 实报后果：Go 档（10 美元/月）账户的 5 小时/周/月窗口总额被显示成 20/50/100 美元（当前模型 deepseek-v4.1-flash），真实额度是 12/30/60。

官方口径（opencode.ai/docs/go「Usage limits」，2026-11-23 核对）：

- 付费模型共用一个额度："The paid models you use on Go share one allowance."；5 小时窗是月额度的 20%，周窗是 50%。
- 各模型的「月度额度」只表示整月只用该模型时套餐覆盖多少（标价）用量："Each model's monthly limit shows how much usage your plan covers if you use only that model over the month."
- 请求按模型折算计入同一池："$1.50 of usage on a model with a $15 limit uses 10% of your monthly allowance. So does $6 on a model with a $60 limit."

参考实现 magpie（`internal/provider/planquota.go`）对 OpenCode Go 同样只读 `zen/go/v1/usage` 的三窗百分比，不做模型换算。

## 契约

- **meters 即账号额度池本身**：`limitMicroCents`/`usedMicroCents` 是额度口径金额（Go 档 12/30/60 美元），不是可被换算的「基线」。渲染端原样展示窗口的 `total`/`used`/`remaining`/`percent`，不按当前模型换算（`quotaChipMode` 与 `chip.__zuQ.q` 直接用源数据）。
- **percent 不得按模型重算**：`used / limit` 就是官方的「额度已用比例」，与 `zen/go/v1/usage` 的 percent 同源。v385 的重算会把比例改坏——meters 已用 24.20/60（40.33%）被显示成 24.2%；月度额度 15 美元的模型反向放大 4 倍（已用约 30% 显示成 100%）。
- **披露**：tooltip 页脚维持「套餐池为账号级」固定文案，没有模型口径分支；`modelBasis` 不是协议字段，渲染端不读。
- **不变的部分**：额度链、协议、调度器零改动——模型不入状态键，模型切换不触发重查；兜底链（`zen/go/v1/usage`，只有整数已用百分比、无金额）与其它源行为不变。
- **金额语义**：meters 金额是额度口径，混用多个模型时不等于标价花费，只用于展示「已用 / 总额」。

## 与「账号级口径」合同的关系

AGENTS.md §5「额度是账号级套餐池口径，chip/tooltip 不得出现模型独享额度语义」对 OpenCode Go 同样成立，没有例外：官方各模型「月度额度」是「单模型整月的用量覆盖」，不是独立池。

## 维护责任

官方调价、上新或调整窗口占比时，meters 跟活接口走，渲染端无需同步任何表（v385 的 28 款模型快照表已删除）。不要按 opencode.ai/go 的各模型月度额度重建换算。

## 回归

`tests/overlay-quota-opencode-model.test.cjs`：已知模型（deepseek-v4.1-flash）与 issue #453 实报数据原样展示（chip 分段、tooltip 金额、账号级页脚）、模型切换数字不变且源数据零变异、Plus 档金额原样、裸 opencode 源与非 opencode 源、快照透传的未知 `modelBasis` 不渲染。
