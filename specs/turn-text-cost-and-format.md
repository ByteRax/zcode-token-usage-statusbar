# 回答末尾统计行：生成耗时时分秒、模型 id、本轮预估费用

回答末尾统计行由 `token_rate.py:format_turn_line()`（`--turn --current`，带 `(本轮)` 标记）经 turn-text 通道生成/`textContent` 落 DOM；`format_line()`（上轮行 / hook 背景）是独立契约，本次不改。

## 产品规则

1. **生成耗时分级中文单位**：`输出 … token / 生成 <duration>` 的 `<duration>`：`genMs<60000` 维持 `_sec()` 一位小数 `3.2s`；≥60s 且 <3600s 用 `M分S.s秒`；≥3600s 用 `H时M分S.s秒`（小时取整、分钟/秒整数部分不补零、秒保留一位小数）。例：`464800ms→7分44.8秒`、`3724800ms→1时2分4.8秒`、`3200ms→3.2s`。遵循 overlay-ui.md §67「中文自然单位词、数字与单位紧邻、小时用『时』」。仅改本轮行；`format_line` 的「生成 …s」与上轮行采样时刻均不变。
2. **模型 id 前置**：`⚡ <ids> <speed> token/s(本轮)`——取本轮全部 `model_id`，按本轮首次出现顺序去重、以 `/` 连接（空 id 跳过）。单模型如 `⚡ GLM-5.3-FlashX 256.9 token/s(本轮) …`；多模型如 `⚡ GLM-5.3-FlashX/claude-sonnet-5-5 256.9 token/s(本轮) …`。无模型 id（旧库/全部空）时不拼该段，退回 `⚡ 256.9 token/s(本轮)`。模型 id 来自 `usage_stats.request_stats` 产出的 `item["model"]`；`query_turn()` 把本轮 items 的模型列表写入 `turn["models"]`，`format_turn_line` 消费。
3. **本轮预估费用**：紧跟 `累计 <token> token` 之后拼 ` · 预估费用 <金额>`，金额口径=本轮 `model_usage` 行按 `(model_id, provider_id)` 经 `token_pricing.merge_model_costs()` 求和，层内先得 USD，再按 `fx_view().rate` 折 ¥（无汇率降 `$`，`<0.01` 显 `<¥0.01`/`<$0.01`，与 `_wb_money`/`fmtMoney` 同口径）。价表模块缺失/查询失败/费用非有限数时不拼该段（不显假 0）。费用只覆盖本轮，不混入历史。
4. **费用开关门控**：`state.cost`（localStorage `zusage3.cost`，缺省开）经 turn-text 请求透传：`{action:"turn-text", ..., cost: state.cost ? 1 : 0}` → `inject-main.cjs` 在 `cost === 0` 时给 `token_rate.py` 加 `--no-cost` → `format_turn_line(..., cost=False)` 不拼费用段。旧渲染端不带 cost 字段/旧主进程不透传时按缺省开启（产品默认），保持双向兼容。开关变更 bump `richTextUnitEpoch` + 清 attempts，使在途旧费用态回执被 epoch 守卫拒绝、新轮按新开关态取文本。**已缓存行按既有契约不重算**（与 cn/forceKmb/lang 同款）：不能清 `richTextCache`——它覆盖本窗口所有轮，而 turn-text 只能重取当前活跃轮（`isCurrentTurn` 门），全清会让历史轮永久降级为简化占位、丢掉本特性全部格式。
5. **通道与格式约束**：三项只作用 `format_turn_line` 文本；`--json` 结构的 `turn` 对象可新增字段（`models` 列表、`cost_usd`），不改既有数值字段；CLI/MCP/hook stdout 契约不变（`format_line` 不动）。`token_rate.py` 单独部署时 `token_pricing.py` 可选（缺失则无费用段），import 失败按无价表降级，不拖垮统计行。
6. **单测与实机**：Python 测 `format_turn_line` 三段输出与 `--no-cost`、费用失败降级、多模型去重；Node 测 turn-text 请求带 cost → `--no-cost` 透传；真机以 CDP 悬停触发完成轮，核对回答末尾行文本、费用开关即时重取。

## 验收场景

1. 单模型本轮 `genMs=464800` → `生成 7分44.8秒`；`genMs=3200` → `生成 3.2s` 不变。
2. 本轮两段不同模型（含重复段）→ `⚡ A/B 256.9 token/s(本轮)`，顺序按首次出现、去重；无模型 id 时无前置段。
3. 本轮计价得 `cost_usd=12.34`、fx.rate=7.1 → 行含 `累计 12.92万 token · 预估费用 ¥87.61`；关费用开关（`--no-cost`）后该段消失，其余不变。
4. 价表模块缺失/汇率不可得 → 费用段降级为 `$…` 或整段省略，不显 `0`/`NaN`。
5. 切换 ⚙ 预估费用开关后，在途的旧费用态 turn-text 回执被 epoch 守卫拒绝，新轮统计行按新开关态生成；已完成且已缓存的行按既有契约保留原文本（不重算、不降级为占位），与 cn/forceKmb/lang 开关行为一致。
