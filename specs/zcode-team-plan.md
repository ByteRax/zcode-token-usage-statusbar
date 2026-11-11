# 团队套餐（GLM Coding Plan team）支持

## 产品规则

- 团队套餐是组织在 Z.ai / BigModel（智谱）购买的 GLM Coding Plan，按席位发给成员；成员在 ZCode 里切到该套餐后，模型归属的 provider 形如 `account:bigmodel-team-coding-plan` / `account:zai-team-coding-plan`。
- 团队套餐与个人套餐**同端点服务**（api.z.ai/api/anthropic、open.bigmodel.cn/api/anthropic），但凭据与配额口径不同：
  - 鉴权用**业务登录 token**（credentials.json 的 `oauth:{fam}:access_token`，解密后）；BigModel 裸 `Authorization`，Z.ai 走 `Bearer`。
  - 请求必须带团队头：`Bigmodel-Organization: <organizationId>`、`Bigmodel-Project: <projectId>`。
  - 团队配额走 `/api/monitor/usage/quota/limit?type=2`：`CREDIT_LIMIT` unit 3 = 5 小时窗、unit 6 = 周窗；团队 5 小时窗可无 `number`（缺省按 5 小时）；`TIME_LIMIT`（unit 5）是当月 MCP 工具调用数，不阻断模型（tools 窗）。
  - 团队成员可用的重置卡由 `/api/biz/customer-package-reset/list?targetType=TEAM` 列出（个人 `targetType=PERSONAL` 与 `reset/status` 不适用团队）；同样只读，核销在供应商自己的页面。
- 团队选择与身份来源（ZCode 3.14.3+ 同款，读取失败一律 fail-closed 按未配置）：
  - 选择在 `<home>/.zcode/v2/setting.json`（恒在 HOME，不随 dataBaseDir 迁移）：`providerFamilyConnectionSelections[fam] = {kind: "team-coding-plan", organizationId, projectId}`；legacy `modelProviderFamilySelectedKeys[fam] = "team-plan:builtin:{fam}-coding-plan:{org}:{project}"`（org/project 各段 URL 编码）。
  - 业务 token 为 credentials.json 的 `oauth:{fam}:access_token`；BigModel 家族里它与 `zcodejwttoken` 解密结果相同视为陈旧令牌，跳过（ZCode 也不会用它）。
  - 未切团队（无选择）或 provider 的家族与选择不符：该 provider 按未配置降级，绝不猜。
- 解不开（含未知 `enc:*` 代际）与既有契约一致：按未配置降级、零请求、绝不外发密文。

## 状态所有者与接口

- 源 id：`bigmodel-team` / `zai-team`（每家族独立，窗口/状态/指纹互不混用）；`resolvePrimary` 与 `resolveWanted` 对团队 provider id 映射到同名源并携带 `{family, team: true}`。
- 适配器（`src/quota/03-adapters-plan.cjs`）：
  - `resolveCred`：读 setting.json 选择 + 解密业务 token；指纹含 org/project 与密文（切换团队/换号即换指纹，状态自然重建）。无选择、家族不符、token 缺失/解不开 → null / decryptFailed。
  - `fetchOne`：`GET {bizRoot}/api/monitor/usage/quota/limit?type=2`，`bizRoot` bigmodel.cn / api.z.ai；窗口归一化复用 `normalizeQuotaBody`（CREDIT_LIMIT/TIME_LIMIT 既有分类，团队 5 小时无 number 无需特判）。
- 重置链（`src/quota/05-scheduler-and-exports.cjs`）：家族处于团队模式（选择存在）时——
  - 凭据 = 业务 token + org/project（不要求 `zcodejwttoken`）；指纹随选择与密文变化。
  - 只打 list 端点 `targetType=TEAM`（带团队头），不打个人 `reset/status`；列表归一化复用 `normalizeResetList`。
  - 个人模式行为逐字节不变；个人/团队切换凭指纹变化自然重建状态。
- 视图：团队源窗口/档位/工具窗按通用渲染；plan 名取响应 `level`。

## 验收场景

1. setting.json 有团队选择 + credentials.json 有业务 token：团队 provider 查得 5 小时/周窗与 MCP 工具窗，请求头含业务 token 与两个团队头。
2. 无选择、家族不符、token 与 zcodejwttoken 相同（BigModel 陈旧令牌）：未配置，零请求。
3. 团队重置卡：`targetType=TEAM` 列表，计数与到期照常；个人模式重置链行为不变。
4. legacy 选择键（URL 编码 org/project）与现役选择键等价生效。

## 未验证

- 团队套餐真实响应（type=2 的 level 取值、TIME_LIMIT 是否携带 currentValue/usage）未真账号实测，形状以 magpie 转写与既有个人端点形状为准。
