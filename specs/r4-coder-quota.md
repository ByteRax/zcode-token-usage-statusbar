# R4 Coder（r4.codes）额度与模型价格接入

状态：开发线实现；2026-11-17 本机真实账号只读实测通过（`/v1/cli/key`、`/v1/cli/meta`、`/v1/models` 均 HTTP 200）。本文描述当前源码契约，不代表已发布版本。

## 1. 范围

- 自定义供应商 `baseUrl` 指向 `https://api.r4.codes`（或 `r4.codes` / `www.r4.codes`）时，额度源 `r4` 零配置认领，不再落入 generic 中转探测（r4 不提供 sub2api `/v1/usage` 或 OpenAI legacy billing）。
- 只读查询调用 Key 的套餐/限额；不调用任何管理、兑换或写入端点。
- r4 `/v1/models` 公布的模型单价补入内置价表，修复 `deepseek-v4.1-flash` 等 slug 落 `DEFAULT_RATES` 导致的高估。
- 团队/组织账号、`pricing_effective`/`pricing_schedule` 分时价格、`queued` 待生效礼包不在本期范围。

## 2. 接口与凭据

| 端点 | 用途 | 关键字段 |
|---|---|---|
| `GET /v1/cli/key` | 调用 Key 的 reserve-gate 口径 | `limit_usd`、`spent_usd`、`held_usd`、`remaining_usd`、`today`、`series` |
| `GET /v1/cli/meta` | 套餐、钱包与到期 | `plan.package_name`、`plan.total_usd`、`plan.remaining_usd`、`plan.expires_at`、`plan.limit_windows[]`、`wallet.balance_usd` |
| `GET /v1/models` | 模型单价（维护/同步用） | `pricing.input_per_m_tokens`、`output_per_m_tokens`、`cache_read_per_m_tokens`、`cache_creation_per_m_tokens` |

- 鉴权：`Authorization: Bearer coder_...`（与 `x-api-key` 等价）。使用普通标准用途推理 key，不索取 management key。
- 端点共享 60 请求/分钟/Key 的桶；额度链每源每 TTL（套餐 10 分钟）并发 2 个请求，不额外轮询。
- `monitoring` 用途 key 返回 HTTP 403 `STANDARD_KEY_REQUIRED`，按 `auth_failed` 处理（与 401 同冻结语义），不重试穷举。

## 3. 凭据发现与安全

优先级：`R4_API_KEY` / `R4_CODER_API_KEY` / `R4CODES_API_KEY` → secrets `sources.r4.apiKey` → 当前自定义 provider 的 `apiKey`。

- key 只发 `api.r4.codes`（或用户显式配置的 `r4.codes` / `www.r4.codes` 同域）；域名精确匹配，`api.r4.codes.evil.example` 等伪装域不认领。
- 查询地址固定 `/v1/cli/key`、`/v1/cli/meta`，不跟随重定向；不接受 secrets 中任意 baseUrl 覆盖官方域。
- key 只在内存与请求头流转；`account.email` 等响应字段不进入快照/日志/诊断。

## 4. 归一化契约

`normalizeR4(keyBody, metaBody)`：

- **套餐池**：`plan.total_usd > 0` 且 `plan.remaining_usd >= 0` 时输出 `windows.plan = {percent(已用), used, total, remaining, currency:"USD", resetsAt: plan.expires_at, expires:true}`；已用 = total − remaining（6 位小数收敛浮点尾差）。
- **速率窗**：`plan.limit_windows[]` 按 `duration_seconds` 映射：`≤6h → fiveHour`、`≤36h → daily`、`≤8d → weekly`、`≤32d → monthly`，其余长度或缺失时长的窗丢弃（不冒充套餐池）。`ceiling_usd` 为 null 表示不限速，跳过而不是渲染 0%；`consumed_usd` 缺失/负数视为坏窗跳过。同标签多窗取已用比例更高者。
- **Key 总额度**：`limit_usd >= 0` 时输出 `quotaSummary = {limit, used: spent+held, remaining, currency:"USD"}`（0 值是合法零额度，保留展示）；`limit_usd` 为 null 时绝不造 Key 总额度（文档语义为无限额）。
- **钱包**：仅当没有套餐池、没有 Key 限额、也没有有效速率窗时，回退 `balance = {amount: wallet.balance_usd, currency:"USD"}`，避免钱包小额盖掉套餐主额度（chip 对 `balance` 优先）。
- **套餐元数据**：`plan.productName = plan.package_name`、`plan.validEnd = plan.expires_at` 的日期部分；tooltip 标题显示「套餐名 · 有效期至」。
- 两个响应都合法但无任何可展示数据（无套餐、无限额、钱包为 0/null）时返回 `noPlan`；任一请求失败且无可展示数据时报真实错误（network/auth/parse），绝不用 `no_plan` 冻结到用户换 Key。
- 部分失败：`key` 成功而 `meta` 失败时保留 Key 限额；`meta` 成功而 `key` 失败时保留套餐/钱包。两者都失败才向上抛错。

## 5. 模型价格

r4 的 `/v1/models` 返回 USD/百万 token 四价（`input_per_m_tokens`、`output_per_m_tokens`、`cache_read_per_m_tokens`、`cache_creation_per_m_tokens`）。当前目录中不在 models.dev 官方渠道的三档写入内置价表（键前缀 `r4/`，同时登记 `scripts/sync_token_pricing.py` 的 `OVERRIDES` 防同步丢失）：

| slug | input | output | cache_read | cache_write |
|---|---:|---:|---:|---:|
| `deepseek-v4.1-flash` | 0.15 | 0.60 | 0.003 | 0 |
| `deepseek-v4.1-flash-fast` | 1.20 | 6.00 | 0.06 | 0 |
| `deepseek-v4.1-flash-ultrafast` | 3.60 | 14.40 | 0.072 | 0 |

`glm-5.3`、`glm-5.3-flash`、`kimi-k3.1-pro` 已在 models.dev 官方渠道条目中且与 r4 牌价一致，不重复造条目。费用口径沿用 `token_pricing`：`input_tokens` 已含 cache_read/cache_creation，output 已含 reasoning。

## 6. 验收

- `tests/quota-r4.test.cjs`：套餐池 + 5 小时窗、Key 限额、钱包回退、ceiling=null、meta 失败不冻结、403 冻结、伪装域与 env-only 激活。
- `tests/test_token_pricing.py::test_r4_relay_catalog_is_priced_instead_of_default_fallback`：三档精确命中且成本不再落兜底均价。
- 真机只读：`createQuotaClient` + 真实 provider_config 的 `R4Coder` key 返回 `status=ok`、`kind=plan`、`plan.productName=Code Lite +1`、`windows.plan` 与 `plan.validEnd`。
- 2026-11-17 实测备注：`limit_windows` 可能为空数组（当前速率窗不活跃），代码按空数组降级，仅显示套餐池。

## 7. 未覆盖

- 团队/组织套餐：r4 meta 的 `account` 只有邮箱，没有组织/项目维度；不冒充团队支持。
- `pricing_effective` / `pricing_schedule` 分时价格：当前账号返回 null；只落基础 `pricing` 牌价，分时策略需另立规格。
- `queued[]` 待生效礼包、`grants[]` 逐笔拆分、`today`/`series` 服务端账本：当前 chip 不展示；本地 token 统计仍走 SQLite，两条链互不推导。
- `r4/` 价格是 2026-11-17 快照；r4 调整牌价或新增 slug 需更新 `OVERRIDES` 后重跑同步脚本。
