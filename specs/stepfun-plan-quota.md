# StepFun Step Plan 额度接入（PR #428）

状态：开发线实现；2026-11-21 端点与响应形状转写自官方文档《查询套餐用量》（platform.stepfun.com/docs/zh/step-plan/usage），贡献者以真实账号实测 Pro/Max 两档快照、401 与桌面 chip 挂载（外部贡献，维护者未独立复验真账号）。本文描述当前源码契约，不代表已发布版本。

## 1. 范围

- 自定义供应商 `baseUrl` 为 `https:` 且 host 精确等于 `api.stepfun.com` 时，额度源 `stepfun` 零配置认领；路径与端口不参与判定（与 ollama/r4 同族取舍）。`http://`、伪装域（`api.stepfun.com.evil.example`）、官网主域（`www.stepfun.com`）、`account:` 内置账号不认领。
- 只读查询套餐用量；不调用任何写入端点。StepFun 无 sub2api `/v1/usage` 或 OpenAI legacy billing 路径，不落 generic 中转探测。

## 2. 接口与凭据

| 端点 | 用途 | 关键字段 |
|---|---|---|
| `GET https://api.stepfun.com/step_plan/v1/usage` | 账号级套餐额度快照 | `plan.name`、`plan.subscription.expires_at_ms`、`quota.credit_buckets[]`（`type/total/remaining/used_percent/resets_at_ms`） |

- 鉴权：`Authorization: Bearer <StepFun 开放平台 API key>`。取钥优先级 env `STEPFUN_API_KEY` → secrets `sources.stepfun.apiKey` → 自定义供应商 `access.apiKey`（三级链同 kimi/ollama）；`defaultOn: true`，env-only（无 provider_config 条目）也激活。
- key 只发 `api.stepfun.com` 官方域；查询地址写死，不跟随用户 baseUrl 路径。401/403 归 `auth_failed` 冻结到凭据指纹变化。
- ⚙ 面板 keyUrl `https://platform.stepfun.com/account-overview`。

## 3. 归一化契约（normalizeStepfun）

- **额度桶**：`credit_buckets[]` 过滤 `total > 0` 且 `remaining >= 0`（整数字符串经共享 `num()` 解析；官方以整数字符串防 JS 精度损失，档位 ≤ 2e10 Credit < 2^53 按 Number 解析安全）；`type:"subscription"` 是套餐月池，无 subscription 桶时取首个有效桶兜底展示（加油包桶同构，未实测校准）。
- **月窗**：`percent` 优先取服务端 `used_percent`（已用% 口径，`clampPct` 钳 [0,100]，0 是合法值直取），缺失按 `(total−remaining)/total` 自算（过滤保证 total > 0，无除零）；`resetsAt` 只取 `resets_at_ms`（月度 Credit 发放重置）——数字毫秒直传；全数字字符串转 Number 恢复（低于 1e11 视为非毫秒垃圾串丢弃）；其余非空字符串过 `Date.parse` 门（ollama 同款单适配器内敛门），缺失/null（实测 Max 快照不带该字段）落 null，**绝不拿订阅到期冒充重置时间**。
- **订阅到期**：`plan.subscription.expires_at_ms` 单独落 `plan.validEnd`（本地时区日历日 `yyyy-MM-dd`）；`plan.name` 截 40 字进 `productName`。
- **fail-closed**（形状检查只作用于产出月窗的被选中桶，其余无效桶由过滤剔除）：体/plan/quota 非对象 → `parse_error`；无有效桶（含 `credit_buckets` 缺失/空数组、`total` 为 null/空串、负 remaining 的透支形状——官方文档未载）→ `{noPlan:true}` 冻结；被选中桶 `remaining > total` 或其 `remaining` 为 null/undefined/空串（JS `null >= 0` 为 true 不被过滤）→ `parse_error`——对在订账号按 30 分钟退避自愈，优于误冻结 noPlan。
- Credit 按订阅月发放、当期剩余到期清零不结转；分时扣减（高峰 2 倍）是服务端结算规则，不影响快照读数。

## 4. 与既有链的边界

- `num()`/`clampPct()`/`resetOf()`/`zcodeStartStamp()`/`sha16()` 与各适配器同源共享；限流沿用每源 TTL 单请求，不额外轮询。
- 本地 token 统计与套餐额度是两条链，互不推导。

## 5. 验证边界

- 测试 `tests/quota-stepfun.test.cjs`：官方文档示例形状全链（Token-Plus，`resets_at_ms:null`）、真值 resetsAt 与 validEnd、used_percent 直取/自算/钳制/零值、垃圾串 resets 门、加油包兜底、noPlan 冻结经调度器、401 auth_failed、凭据三级优先、detect 负例与预设注册。
- 真账号证据（Pro used_percent 37.148092（≈37.1%）/ Max 快照无 `resets_at_ms` / 401 / 桌面 chip「月 98%」剩余口径）来自贡献者（外部），维护者未独立复验；官方文档示例快照（Token-Plus，used_percent 38.5625、`resets_at_ms:null`）另有测试夹具锁定；加油包桶与团队/组织账号未覆盖。
