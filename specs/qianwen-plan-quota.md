# 千问 AI 平台 Token Plan 额度源（qianwen，issue #399）

状态：已实现，`unverified`（端点形状转写自 magpie `qianwen_plan.go`/`alibaba_usage.go`（MIT）与官方 `@qianwenai/qianwen-cli` 1.11.0 常量表；真实账号窗口字段未实测）。

## 背景

千问 AI 平台（platform.qianwenai.com）的 Token Plan 推理网关（`token-plan.maas.qianwenaiapi.com`，
key 前缀 `sk-sp-`）是纯推理入口：任意非推理路径统一 400 `InvalidParameter`，用推理 key 查额度
得到 `BailianGateway.Login.NotLogined`。用量百分比只对平台登录态开放。issue 报告的
`qwen-token-plan-team-cn` 供应商由此显示「暂不支持」。

## 链路（转写自 magpie，即千问 CLI 官方客户端流程）

1. **设备码申请** `POST https://t.qianwenai.com/cli/device/code?client_id&code_challenge&code_challenge_method=S256`
   （PKCE S256；client_id 为随机 UUID）→ `{Success, Data:{Token, VerificationUrl, ExpiresIn, Interval}}`。
   渲染端拿 `VerificationUrl` 走 openExternal 桥在系统浏览器打开授权页。授权地址只收 `https:` 且
   主机为 `*.qianwenai.com`（拒 userinfo）；交出的是 `URL` 解析归一后的 `href`，非 https/异域直接落
   `failed` 不起流；流到终态后地址清空，不再对外提供。
2. **授权轮询** `POST https://t.qianwenai.com/cli/device/token?client_id&token&code_verifier`
   每 `min(Interval, 2s)` 一次；`slow_down` 把间隔翻倍并沿用（封顶 30s，RFC 8628 节流语义），`http_error` 按当前间隔原样重试：`Data.Status`（或小写 `status`，缺省
   `authorization_pending`）∈ `authorization_pending | complete | expired_token | access_denied`。
   complete 时从 `Data.Credentials.AccessToken`（或小写 `credentials.access_token` 形状）取
   access token，`ExpireTime`（或 `expire_time`）为过期时刻（秒/毫秒/日期串自适应），`User{Id,Email}`
   为账号展示名。**无 refresh token**：过期/失效即整链重登。失败文案绝不引用原始响应体
   （响应可能含 token，magpie 有真实泄露事故）。
3. **持久化** 登录完成由主进程把 `{token, tokenExpiresAt, account}` 写入 quota-secrets.json 的
   `sources.qianwen`（0600 原子写，经注入侧 `writeQuotaSecrets`，写入即触发
   credentialsChanged → 解冻 → tick）。手动通道：⚙ 面板 token 字段手填（高级路径），
   env `ZCODE_QIANWEN_ACCESS_TOKEN` 优先。手填或清空 token 一并作废 `tokenExpiresAt` 与 `account`
   （设备码登录留下的派生字段不得跟随手填值）。关额度开关（`quota_enabled=false`）即取消在途
   登录流；关闭期间 `start` 被拒（`quota disabled`），`state`/`cancel` 仍应答。
4. **换控制台令牌** `POST https://cli.qianwenai.com/data/v2/api.json`，JSON 体
   `{product:"ModelStudioRegional", action:"GenerateCLIAccessToken", region:"cn-beijing",
   params:{}, version:"2026-02-10"}`，`Authorization: Bearer <access>`，UA `qianwen-cli/1.11.0`。
   `code==="200" && successResponse && data.cliAccessToken` 为成功；按 access 指纹缓存 20 分钟
   （magpie aliTokenTTL）；网关回 `ConsoleNeedLogin` 族 code 或 HTTP 401/403 →
   `auth_failed` 冻结（解冻=凭据指纹变化，即重新登录/改 token）。缓存令牌被拒时重换一次，
   新令牌仍被拒即 auth_failed（不是循环）。
5. **查用量** `POST https://cs-data.qianwenai.com/cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=<urlencode("zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage")>`
   ，form 体 `params={"Api":<同上>,"V":"1.0","Data":{"cornerstoneParam":{protocol:"V2",
   console:"ONE_CONSOLE",productCode:"p_efm",switchUserType:3,consoleSite:"QIANWENAI"}}}&region=cn-beijing`
   ，`Authorization: Bearer <cliAccessToken>`，同 UA。
6. **解析窗口** 信封 `data.{success,errorCode,errorMsg,DataV2}`：`success===false` 且 errorCode 含
   `NotLogined` → auth_failed；其他 errorCode → network_error（错误摘要只带 code，不带服务端 errorMsg——那是给浏览器控制台看的原文）。窗口已用值为负的条目
   丢弃（全负 → parse_error），不渲染成 0%。
   业务数据在 `DataV2.data.data`（双层 `{data:…}` 剥壳，缺层容忍）。键 `per<N>(Hour|Day|Week|Month)(Percentage|ResetTime)`
   按对解析：值域 0–1 → 已用 `clampPct(v*100)` 保留 1 位；窗口映射
   `per5Hour→fiveHour、per1Day→daily、per1Week→weekly、per1Month→monthly`，未知窗丢弃；
   ResetTime 毫秒/秒自适应（resetOf）。个人 Token Plan 只有周/月两窗。全部窗缺失 →
   `parse_error`（可能是团队 seat 账号或未购个人套餐，不显示 0%）。

## 适配器与调度

- `id: "qianwen"`、`kind: "plan"`、`defaultOn: true`、`unverified: true`、
  envKeys `["ZCODE_QIANWEN_ACCESS_TOKEN"]`。
- detect：baseUrl host 精确 `token-plan.maas.qianwenaiapi.com`（含任意路径），或
  qianwenaiapi.com 域内 + apiKey 前缀 `sk-sp-`；不按 provider 名判定（模板名与实际套餐常
  不一致，issue 明示）。**不认领**
  `token-plan.<region>.maas.aliyuncs.com`（阿里云百炼）——该域凭据是 AccessKey ID/Secret +
  ACS3-HMAC-SHA256 签名链（magpie 另一套实现），本版未实现，落 custom 中转探测保持现状。
- 复合源 `qianwen:<providerId>` 与 volcano 同形（rememberProvider 自动派生）；secrets 显式
  token/env 亦可激活裸 `qianwen` 源（activeSet hasConfigured 分支天然覆盖 `token` 字段）。
- resolveCred：env → `sec.token`；`sec.tokenExpiresAt` 已过 → null（not_configured 引导重登）；
  指纹 `sec:sha16(token)`。推理 key（`sk-sp-`）绝不作为额度凭据外发。

## UI（⚙ 面板）

- qianwen 源行加「登录」按钮：点击 → `quota-qianwen-signin` 桥动作 → 主进程起设备码流并返回
  `VerificationUrl` → 渲染端 openExternal 打开 → 每 2s 轮询 `quota-qianwen-signin-state`；
  `done` 显示「已登录 <account>」、`failed` 显示错误、`idle`（流已被取消或主进程刚重启）显示
  中性「登录已取消」并停止。重复点击=重开新流（主进程取消旧流）。渲染端轮询以代际号为准：
  新一轮点击、实例销毁都让旧回调自弃，轮询不绑定按钮节点（源列表会整表重建）。当前没有
  「取消登录」的 UI 出口——`quota-qianwen-signin-cancel` 只保留给外部调用方与清理。
- 旧主进程（inject-main 冷文件未重启）回 `unknown action`：按钮反馈「重启 ZCode 后可用」，
  不报红。
- 手动 token 字段（credentialFields `["token"]`）保留；清空字段=退出登录。
- keyUrl：`https://platform.qianwenai.com`。

## 边界（明确不做）

- 阿里云百炼（bailian-cs.console.aliyun.com 网关 + AccessKey 签名）不认领不实现。
- 团队 seat 版（`fiveHourCredits`/`weeklyCredits` 绝对值字段）不解析；个人窗缺失即 parse_error。
- 订阅实例绝对 Credits（DescribeFrInstances，TemplateName/InitCapacity）不查；只出百分比窗。
- 凭据不出 qianwen 官方三域（t.qianwenai.com / cli.qianwenai.com / cs-data.qianwenai.com）。

## 测试矩阵（tests/quota-client.test.cjs）

detect 认领/不认领域名矩阵、sk-sp- key 认领、mint→usage 双跳断言（URL/UA/form 参数/双层
Bearer）、NotLogined 分层（usage 层 auth_failed、mint 层 auth_failed、缓存令牌重换一次）、
无窗 parse_error、设备码流完成/拒绝/过期/取消、complete 回复双信封形状宽容解析、错误文案
不含 token、tokenExpiresAt 过期归未配置、授权页 URL 域白名单、slow_down 沿用与 30s 封顶、
http_error 沿用当前间隔、取消后迟到 complete 不落盘、单拍 kill 定时器必清、负值窗口
parse_error、errorMsg 不进错误文案、两个 fetch 入口恒 `redirect:"manual"`（结构锁）。面板
（tests/overlay-quota-chip.test.cjs）：qianwen 行渲染登录按钮、点击发 quota-qianwen-signin、
轮询跨源行重建存活、旧代回执（起流与状态）按代际丢弃、idle 显「登录已取消」。主进程侧
（tests/plugin-loader.test.cjs）：手填/清空 token 清派生字段、关额度触发取消、关闭期间
start 拒而 state/cancel 应答。
