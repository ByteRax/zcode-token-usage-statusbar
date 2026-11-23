# Ollama Cloud 额度接入（issue #410）

状态：开发线实现；2026-11-20 端点与两代响应形状转写自 magpie（MIT，其仓 issue #1888 同款端点）与官方 docs（docs.ollama.com/cloud/usage、/api/balance），夹具验证；**未真账号实测（unverified）**。本文描述当前源码契约，不代表已发布版本。

## 1. 范围

- 自定义供应商 `baseUrl` 为 `https:` 且 host 精确等于 `ollama.com` 时，额度源 `ollama` 零配置认领，不再落入 generic 中转探测（Ollama 不提供 sub2api `/v1/usage` 或 OpenAI legacy billing）。
- 路径不参与判定：`https://ollama.com/v1` 等宿主 baseUrl 变体同域命中；`http://`（含本地 `localhost:11434` 的本地 Ollama）与伪装域（`ollama.com.evil.example`）不命中；`account:` 内置账号不认领。
- 只读查询账号余额；不调用任何写入端点。

## 2. 接口与凭据

| 端点 | 用途 | 关键字段 |
|---|---|---|
| `GET https://ollama.com/api/balance` | 账号套餐与充值余额 | `included.{balance_usd,allowance_usd,period,session,weekly}`、`purchased.balance_usd` |

- 鉴权：`Authorization: Bearer <Ollama API key>`。key 取钥优先级 env `OLLAMA_API_KEY` → secrets `sources.ollama.apiKey` → 自定义供应商 `access.apiKey`（同 kimi/opencode 三级链）；`defaultOn: true`，env-only（无 provider_config 条目）也激活。
- key 只发 `ollama.com` 官方域；查询地址写死，不跟随用户 baseUrl 路径，不接受 secrets 中任意 baseUrl 覆盖。
- 限流 10 请求/分钟/用户（issue 报告者转述，未实测），429 由调度器按 `Retry-After` 退避；401/403 归 `auth_failed` 冻结到凭据指纹变化（401 形状：`{"error":"invalid credentials"}`，bad key 实测形状转述自 magpie 测试）。
- ⚙ 面板 keyUrl `https://ollama.com/settings/keys`。

## 3. 归一化契约（normalizeOllama）

两代套餐形状同端点返回，逐字段独立解析、可并存：

- **新套餐（月度额度池）**：`included.allowance_usd > 0` 且 `included.balance_usd` 为数字时输出金额窗（`used = allowance − balance`，`percent = used/allowance×100`，双向钳 [0, allowance]——超支后由充值余额垫付时钳满格）。`period.until` 为**可解析日期**（或 ≥ 1e11 的毫秒值：数字 / 全数字字符串）才带 `resetsAt` 并入 `windows.monthly`（chip「月」标签）；`period` 缺失、形状漂移或 until 非日期（如 `"TBD"`）落 `windows.plan`（「套餐」标签，不带 resetsAt），不冒充月窗。`resetOf` 对非空字符串透传是全仓基线，ollama 侧以 `Date.parse` 门内敛加固。
- **旧套餐（百分比窗）**：`included.session` / `included.weekly` 的 `remaining_percent` 是剩余制（75 = 还剩 75%），翻转为已用 `100 − x` 并钳 [0, 100]，映射 `windows.fiveHour` / `windows.weekly`，`resetsAt` 取各窗 `resets_at`。session 窗映射 5 小时窗是**近似**：响应无时长字段，官方未声明 session 周期长度。字段缺失（非数字）不猜 0%，该窗缺席。
- **充值余额**：`purchased.balance_usd` 是套餐外充值。有窗口时**不进顶层 `balance`**——渲染端 chip 对 `balance` 字段形态优先，会把窗口段挤掉；仅无任何窗口时退化为 `{kind:"balance", balance:{amount, currency:"USD"}}`。负值视为无充值。
- **防除零**：`allowance_usd <= 0`（含 0 档）无月窗。
- **fail-closed**：体非对象/数组/字符串、`included` 与 `purchased` 全缺或均不可解析 → `parse_error`（30 分钟确定性退避），绝不显示 0% 或伪造窗口。
- **纯 PAYG 账号**：`included` 在但无任何可解析窗口且无有效充值 → ok 空窗（chip 隐藏）。不判 `no_plan` 冻结——balance 端点对有效 key 恒回其账号数据，无「无订阅」信封可辨。

## 4. 与既有链的边界

- 数字宽容沿用共享 `num()`（字符串十进制可解析，NaN/Infinity/脏类型拒绝）；`clampPct`/`resetOf` 与各适配器同源。
- 限流预算沿用每源 TTL（套餐 10 分钟）单请求，不额外轮询。
- 本地 token 统计与套餐额度是两条链，互不推导。

## 5. 验证边界

- 夹具：`tests/quota-ollama.test.cjs`（两代形状/钳制/字符串与脏数字/垃圾 until/负充值/401 auth_failed/凭据三级优先与 env-only 激活/detect 六种拒绝、presets 登记）。
- 未验证：真实账号（新/旧套餐任意一档）HTTP 200 全链、429 Retry-After 实际行为、限流数值本身。升级为 verified 需真实 Ollama Cloud 订阅实测。
