# 套餐 GLr 凭据换发（model-puller 增强链）

状态：已实现（本规格随实现提交）。逆向依据：宿主 3.19.1 引擎 bundle（`zcode.cjs`）`ProjectAccessTokenClient` 类与 3.19.1 runtime builtin 配置，2026-11-21 本机（Windows，宿主 3.19.1）实机复核。

## 背景

宿主 3.19.x 把内置套餐 provider 的 `access.type` 改为 `zhipu-account` 并**运行时内存换发凭据**：3.18 时代写进 `~/.zcode/v2/config.json` 的 `provider.{builtin:*}.options.apiKey`（GLr 项目 key 明文）不再存在（issue #429 后续实机确认：切换模型选择即可用套餐，全程无 config.json 落盘）。插件增强链 `planKeyOf` 的「v2 条目 key → OAuth 兜底」两条路在 3.19.1 上全部失效（OAuth 直连 messages 被网关 500 code 1234 拒，v344 实测；#430 已把 start-plan 收口为 plan_auth，但 individual/team 仍走必败 OAuth 兜底）。

## 宿主协议（逆向定案）

- **凭据换发**：`POST {origin}/api/biz/v1/organization/{organizationId}/projects/{projectId}/api_keys/{apiKeyId}/access_tokens`，头 `Authorization: Bearer <OAuth access_token>` + `Content-Type: application/json`，体 `{clientType:"zcode", clientVersion:<宿主 appVersion>}`；响应 `{code:200|0|"200"|"0", msg, data:{enabled:boolean, accessToken:string}}`——wire 凭据字段是 **accessToken**（2026-11-21 真实端点实测；#431 曾误按宿主缓存内层的 token 字段名解析，真机恒 parse 失败，#432 修正并兼容 token 别名）。`enabled:false`、code 非 200|0、凭据非非空字符串（trim 后）均按无凭据处理；HTTP 404 = location 失效（宿主会删除 location 重新发现）；429/5xx/网络类宿主带退避重试。
- **定位（location）**：credentials.json 键 `project-key-location:v1:` + `encodeURIComponent(JSON.stringify([origin, family, accountId, team, 1, "non-team"]))`（本机实测：`[ "https://bigmodel.cn", "bigmodel", "<accountId>", null, 1, "non-team" ]`）；值=`{organizationId, projectId, apiKeyId}` 的 JSON 经 credentials.json 同款信封加密（`enc:v1/v2`）。accountId 直接取自键名，**不需要**解析 `oauth:bigmodel:user_info`。
- **发现链**（location 缺失时宿主走 getCustomerInfo → 选 org/project → 列/建 `zcode-api-key`）：**插件不实现**——location 缺失说明宿主从未给该账号发放过 coding key，增强无凭据可用，fail-closed 报 plan_auth 与现状一致。
- **路由**（权威来源=`<v2>/runtime/provider/<platform>/<hostVersion>/endpoint-*/zcode-builtin.json` 的 `account:*` 条目 `api.baseUrl`，3.19.1 实测）：`account:bigmodel-start-plan → https://zcode.z.ai/api/v1/zcode-plan/anthropic`、`account:bigmodel-individual-coding-plan`/`team → https://open.bigmodel.cn/api/anthropic`。start-plan 在 open.bigmodel.cn 用项目 key 虽曾 200（v344，raw key），但换发 token 的权威端点以 runtime 配置为准。

## 插件实现契约（model-puller）

1. **作用面**：仅 `fam==="bigmodel"` 的 PLAN_SOURCES 源（individual/team/start-plan）。zai 家族端点未实测，维持现状（OAuth 诚实尝试）。
2. **凭据解析序**（enhanceText 内，bigmodel 源）：v2 条目明文 key（`planEntryKeyOf`，兼容 3.18 宿主/报告者机器）→ GLr 换发 token（新）→ 均失败回 `plan_auth`（零网络 fail-fast 语义不变）。**OAuth 直连兜底从 bigmodel 源移除**（v344 起实测必败，#429 报告者机器的 1234 即此路径）。
3. **location 读取**：扫 credentials.json 键名（前缀 `project-key-location:v1:`），URL-decode 取 JSON 数组，匹配 `family==="bigmodel" && team==null && usageScene===1` 的首条；值过 `decryptValue` 解密（`enc:` 前缀结果一律作废，同 planTokenOf 纪律），`{organizationId, projectId, apiKeyId}` 三键非空字符串才可用。
4. **换发请求**：origin 取 location 键名还原值（校验限定 `bigmodel.cn` 及其子域）；`clientVersion` 取宿主 appVersion（本文件运行于 Electron 主进程，`require("electron").app.getVersion()` 直取，异常/测试环境省略该字段）；UA `ZCode`（同 enhance 既有头）；15s 超时、跟随 enhance 的外部 signal；**不重试**（enhance 自身已有二次尝试，换发失败直接 plan_auth，避免叠退避）。
5. **响应处理**：`code` 为 200/0（数字或字符串）且 `data.token` 非空字符串才采信；`enabled===false`、404、401/403、其它形状一律按换发失败 → plan_auth（401/403 不细分为 auth：OAuth token 失效时用户重登后 location/token 都会换新，plan_auth + 重试语义已覆盖）。
6. **路由读取**：glob `<v2>/runtime/provider/<platformDir>/*/*/endpoint-*/zcode-builtin.json`（platformDir 以 `process.platform` 前缀匹配：win32→windows、darwin→darwin、linux→linux），版本段取可解析的最高 semver；解析 `config.providerConfigRules.providerRules` 中 `providerId===目标源` 条目的 `config.api.baseUrl`（stat stamp 缓存含 ino/dev，同 readTemplateRules 纪律）。baseUrl 收编家族官方域白名单（`bigmodel.cn`/`zcode.z.ai`/`z.ai` 及子域，https+后缀判定）——runtime 配置是同权限进程可写的宿主托管状态，白名单外一律拒绝回退表值（review D-1 纵深防御）。读不到（旧宿主/结构变化/白名单外）回退 PLAN_SOURCES.baseUrl 硬编码并照常尝试。
7. **内存纪律**：换发 token 只在内存；实例闭包 memo `{fingerprint, token, at}` TTL 10 分钟（fingerprint=OAuth token 摘要 + location 键名 + 信封串——键名或值任一变化即失效；实例级使热换重建天然换新 memo，无跨实例泄漏），enhance 的两次 attempt 复用同一 token；不落盘、不进日志/诊断/渲染端（渲染端只见最终 ok/kind）。resolveEnhanceHost 保持同步：仅当 memo 内有活 token 时对 GLr-only 源（无 v2 条目 key）返回 host——列表首次使用前不列，默认模式增强（主路径）不受影响，文档如实注明。
8. **fail-closed 矩阵**：无 location/解密失败/形状不符/家族外 location/契约外 team 形状 → plan_auth；换发网络失败/超时/非 2xx/`enabled:false`/响应 code 非 200|0 → plan_auth（静默无 log——GLr 失败路径零诊断输出，凭据零泄漏面）；v2 key 与 GLr 都不可用 → plan_auth。GLr 成功后真实 messages 调用的上游错误（含 1113→balance）走 #430 既有分类。
9. **兼容性**：3.18 宿主（v2 config.json 在）走 v2 key，零换发行为不变；3.19.x（config.json 无）走 GLr，恢复与宿主对等；纯 start-plan 账号在 zcode.z.ai + 换发 token 的真实可用性未实测（无纯 start-plan 测试账号），失败按上游错误/plan_auth 诚实呈现——这正是 #429 报告者场景的唯一可能修复路径（其主对话同链路可用）。

## 测试矩阵（tests/model-puller-enhance.test.cjs）

- location 键扫描/URL-decode/家族与 team/usageScene 过滤（含干扰键负例）/解密信封/形状校验（各自独立红绿）。
- 恶意 origin 矩阵（evil.com 及伪装形）零网络拒绝；runtime baseUrl 白名单外回退表值；异平台目录不生效；memo TTL 过期后同步门失效。
- 换发 200 → token 进 Authorization 打 runtime 权威端点（start-plan→zcode.z.ai 断言）。
- 换发 404/401/enabled:false/形状坏 → plan_auth 零后续请求。
- v2 条目 key 存在时不发换发请求（3.18 兼容）。
- memo：同 fingerprint 10 分钟内第二次 enhance 不再换发；fingerprint 变化即重换。
- runtime 配置缺失/损坏 → 回退 PLAN_SOURCES.baseUrl。
- OAuth 不再作为 bigmodel 兜底（无 location 且无 v2 key → 零网络 plan_auth）。
