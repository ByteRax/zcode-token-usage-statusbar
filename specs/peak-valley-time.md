# 峰谷时段纯函数（DeepSeek 计价时段 + GLM Coding Plan 额度系数）

来源：DeepSeek 口径从 zcode-fox-widget 的 `lib/pricing.mjs`（`isPeakTime`/`nextPeakChange`/`PEAK_HOURS`）移植，落在本仓库 `token_pricing.py`；GLM Coding Plan 口径按官方说明（2026-11-26 维护者提供）补充。参考实现只作行为证据，代码按本仓风格独立编写。

## 时段规则（按 mode 分窗口，北京时间 UTC+8）

| mode | 高峰窗口 | 周末特例 |
| --- | --- | --- |
| `deepseek` | 工作日 9:00–12:00 与 14:00–18:00 | 周末全天谷自北京 2026-08-23 00:00 起（官方规则变更）；分界前历史时刻周末仍按旧规则有峰——保留生效分界，将来按时刻计价时历史桶不被新规则重算错 |
| `glm-plan` | 周一至周五 14:00–18:00（GLM Coding Plan 官方口径） | 无特例：高峰定义只含周一至五，周末自然非高峰 |

- `token_pricing.PEAK_HOURS` = `{mode: 窗口}` 字典；两套口径共用同一判定引擎。
- 谷段单价 = 峰段单价 × 0.5（DeepSeek，fox-widget 内置 2026-10-10 官方牌价各档恰为 2 倍关系；models.dev 平价即峰段价）。本仓库当前不消费这条折扣，仅记录口径。

## GLM Coding Plan 额度消耗系数（`GLM_PLAN_PEAK_FACTOR`）

系数**乘在套餐额度扣减上**，不是现金单价；高峰窗口同 `glm-plan` 口径：

| 模型 | 非高峰 | 高峰 |
| --- | --- | --- |
| glm-5.4 | 0.67× | 2× |
| glm-5.3 | 1× | 3× |
| glm-5.3-flash | 0.4× | 1.2× |
| glm-5.3-flashx（体验版，按 flash×2.5） | 1.0× | 3.0× |

- glm-5.3-flash 官方另有 **0.2×/0.6× 限时系数**，未提供生效区间——暂按常规 0.4/1.2 实现，拿到日期后在此补自动切换逻辑。
- glm-5.3-flashx 为体验版本，按 flash 系数的 **2.5 倍**（0.4/1.2 ×2.5 = 1.0/3.0，维护者 2026-11-26 提供）。
- `glm_plan_peak_factor(model, time_sec)`：按 `is_peak_time(…, 'glm-plan')` 选档返回系数；模型未收录或名字为空返回 1.0（无系数调整）；匹配 = 名字（去空白小写化）与系数表键**精确等值**——不用子串，防 `glm-5.3-flashx` 误命中 `glm-5.3-flash`（徽标场景「未收录模型不显示」依赖此语义，2026-11-26 收紧）。

## 函数契约（token_pricing.py）

- `is_peak_time(time_sec, mode='deepseek')`：epoch 秒 → 是否高峰。按北京时间判定（`time.gmtime(sec + 8*3600)` 后按 UTC 字段读取），与机器时区无关。非法输入（`None`/非数/NaN/inf）返回 `False`（按谷，fail-closed），不抛错；未知 mode 属调用方错误，让其照常 `KeyError`。
- `next_peak_change(time_sec, mode='deepseek')`：epoch 秒 → 下一个峰/谷切换点（epoch 秒）。从北京当日 0 点起最多扫 12 天的小时边界，取第一个与当前状态相反的时刻；边界集合 `_PEAK_EDGES[mode]` 从 `PEAK_HOURS` 自动展开（各段起点、终点，外加 0 点跨日边界），**不手写第二份边界清单**——改窗口只动 `PEAK_HOURS` 一处，切换点推算与判定不漂移。扫不到（理论不可达）兜底 `+1 天`，避免倒计时卡 00:00:00。非法输入返回 `None`。

口径单一原则：任何消费方（快照、展示、计价、额度系数）一律调这几个函数，不在别处重写时段规则。

## 消费边界（当前状态）

- **首个消费者（2026-11-26）**：模型选择器峰谷倍率徽标（[model-peak-factor-badge.md](model-peak-factor-badge.md)）——桌面快照 `peak.glm_plan` 段（`is_peak`+`next_change_at`+factors，经 `peak_snapshot_segment()` 生产，门控与 `speed_history` 同旗），overlay 11 分片消费；GLM Coding Plan 口径。
- 其余方向仍为规划：
  - 展示层（状态条/轮播条目）：门控**仅对应供应商相关时显示**（DeepSeek 用量或 GLM Coding Plan 套餐，维护者已拍板，2026-11-26）；倒计时前端只用 `next_change_at − now` 逐秒减，**JS 侧不重写时段规则**（避免 fox-widget 因前端不引 ESM 被迫维护第二份副本的坑）。
  - 计价层：需先给费用聚合链（`merge_model_costs`/SQL 分组）加请求时刻维度，另立项。
  - GLM Coding Plan 额度显示乘系数：系数只影响「额度消耗速度」的展示口径，不改本地 token 统计与套餐余额查询两条链的原始数值；落点在展示换算层，动手前先明确「剩余额度按当前时刻系数折算还是按各请求自身时刻累计折算」的产品口径。

## 验收

`tests/test_token_pricing.py` 的 `PeakValleyTests`：

- deepseek：工作日边界（8:59:59/9:00:00、11:59:59/12:00、13:59/14:00、17:59/18:00）、周末全天谷（含与工作日同时刻对照）、周末生效分界两侧、非法输入、切换点基础场景与跨周末场景（周五晚 → 周一 9:00）、对 14 天逐小时样本的「切换点两侧状态必相反」性质断言。
- glm-plan：周四 10:00 与 deepseek 同刻对照（前者谷、后者峰）、14–18 四组边界秒、周末自然非高峰、切换点（周四 10:00 → 14:00；周五 18:30 → 周一 14:00）、`glm_plan_peak_factor` 各模型双档（含 flashx=flash×2.5）+ 精确等值（`glm-5.3-flashx` 命中自身键、`glm-5.3-flash` 不串档）+ 未收录/空名 1.0。
