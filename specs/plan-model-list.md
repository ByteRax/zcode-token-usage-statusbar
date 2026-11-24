# 套餐模型列表与探测（BigModel / Z.ai Coding Plan）

状态：已实现（本规格随实现提交）。依据：2026-11-24 本机实测（macOS，宿主 4.0.0，BigModel 个人档；凭据为本机真实账号的 OAuth 登录令牌与 GLr 项目令牌，只在内存）。套餐 models / messages 端点均为无文档逆向接口，形状变化按契约丢弃并留痕，不猜。

## 背景

套餐源「拉取模型」自 v134 起固定打 Anthropic 形态列表端点 `open.bigmodel.cn/api/anthropic/v1/models`，凭据是宿主 `credentials.json` 的 OAuth access_token（`planTokenOf`）；确认流的连通性探测（v309）同样拿 OAuth 打 `/api/anthropic/v1/messages`。增强链在 3.19.x 宿主上已改走 GLr 项目令牌（[plan-glr-credential.md](plan-glr-credential.md)），列表与探测两条入口仍是 OAuth 直连——这是当时留下的口子。

2026-11-24 实测，服务端已把 Anthropic 兼容网关收紧为**只认项目域凭据**（GLr 换发 token / 项目 key），同一把 OAuth 登录令牌在 OpenAI 形态端点仍正常：

| 端点（open.bigmodel.cn） | OAuth 登录令牌 | GLr 项目令牌 |
|---|---|---|
| `GET /api/anthropic/v1/models` | HTTP **200** + `{"code":401,"msg":"登录状态已过期","success":false}` | 200，`{data:[{id,display_name,type,created_at}],firstId,hasMore,lastId}` |
| `GET /api/coding/paas/v4/models` | 200，`{object:"list",data:[{id,object,created,owned_by}]}` | 200，同形 |
| `GET /api/paas/v4/models` | 200，同形 | 未测 |
| `POST /api/anthropic/v1/messages` | HTTP 401 `{"error":{"message":"登录状态已过期","type":"401"}}` | 200 |

两种形态返回的模型集合一致（当日 13 个）。用户侧症状是弹窗只显示「no models in response」：列表端点对鉴权失败回的是 HTTP 200，旧实现只看 `res.ok`，把错误信封当成了空列表。

## 产品规则

1. **列表按候选端点链取**，凭据不变（Bearer OAuth access_token）。每个套餐源带 `listUrls`，按序尝试：OpenAI 形态 Coding Plan 列表 `{域}/api/coding/paas/v4/models` 在前，Anthropic 形态 `{域}/api/anthropic/v1/models` 在后（bigmodel 家族域 `open.bigmodel.cn`，zai 家族域 `api.z.ai`）。
2. **候选之间不短路**：两候选是同域的不同网关家族，同一凭据可能被其一拒而被另一认。任一候选的非 2xx、HTTP 200 错误信封、无列表或空列表，都记录原因并换下一候选；全部失败才返回失败，错误取**最后一个**候选的原因（仅这一点与自定义供应商候选循环同形——后者对 401/403/5xx 立即返回，套餐候选间不短路）。两候选各 10 秒超时，最坏 20 秒，仍在渲染端 25 秒回执兜底之内。
3. **HTTP 200 错误信封按失败处理**：响应是对象且 `success === false` 即信封（信封里没有列表数组），绝不当作空列表。错误串只带分类：`code` 是 100–599 的整数（或纯数字串，200–299 除外）时回 `HTTP <code>`，与真实 HTTP 状态同形，渲染端既有展示零改动；其余回 `upstream error <code>`（无合法 code 时 `upstream error`）。`msg` 不回渲染端——失败文案不引用原始响应体（千问适配器同纪律）。
4. **解析口径不变**：顶层数组或 `data` / `models` / `result` 数组，条目取字符串或 `id`（次选 `slug`），去重、上限 512，按宿主规范大小写归一后排序。
5. **规范大小写表**：`OFFICIAL_GLM_MODEL_IDS` = 宿主 `official-glm-model-id.ts` 的 canonicalIds，加端点实际出现而宿主表没有的条目（`GLM-5.3-FlashX`、`GLM-5.4`、`GLM-5.3-FlashX-Legal`）。宿主自身只对官方名单与单向迁移入口做归一、不比较 Registry——表外的 id 以小写写入 `personalModelIds` 会与宿主内置的规范写法（runtime `builtinModelIds` 的 `GLM-5.4`）形成两套写法，所以端点出现新模型时同步补表；补表拼写以厂商 `display_name` 为准。
6. **探测凭据序与增强链一致、兜底不同**（`probeModel` 的套餐分支；增强链没有 OAuth 兜底）：bigmodel 家族先取宿主运行时同款凭据——团队源走团队 PAT 三步换发（`planTeamPatOf`），其余取 v2 条目明文 key（`planEntryKeyOf`，3.18 宿主）再 GLr 换发 token（`planGLrTokenOf`）；都拿不到才回 OAuth 诚实尝试。**团队源没有 OAuth 兜底**：账号级 OAuth 令牌属个人池，PAT 拿不到（未切团队/换发失败）即按无凭据处理，探测回 `auth` 且零请求——与增强链「团队源绝不用个人凭据」（[plan-glr-credential.md](plan-glr-credential.md)）同门。zai 家族端点未实测，维持 OAuth（即使 v2 条目 key 在也不用）。探测目标端点不变（表值 `baseUrl` 的 Anthropic messages）。
7. 列表门控（`planListable` / `isPullable` / `providerSource` 指纹）不变，仍以 OAuth access_token 是否可解为准：列表本身就用 OAuth 取，门控与数据同源。探测异步取 GLr 不进同步门。
8. **换发在途共享**：`planGLrTokenOf` / `planTeamPatOf` 的 memo 只在成功后写入，而确认流对多模型并发探测（渲染端并发 4），所以同一凭据文件内容下的并发调用共享同一次换发（键含凭据文件原文，凭据变化即不共享；共享请求不带外部 signal）。**带外部 signal 的调用（增强链）不参与共享**、各自换发：共享会让跟随者继承首调用方的取消，未取消的一方误报凭据不可用。

## 状态所有者与接口

- `src/puller/00-constants-and-catalog.cjs`：`BIGMODEL_PLAN_LIST_URLS` / `ZAI_PLAN_LIST_URLS` 候选表（`PLAN_SOURCES[*].listUrls` 引用）、`OFFICIAL_GLM_MODEL_IDS`。
- `src/puller/03-prompt-enhance-and-exports.cjs`：模块级纯函数 `planEnvelopeError(body)`（导出）。
- `src/puller/02-puller-core-and-probe.cjs`：`fetchModels` 套餐分支的候选循环；`planProbeKeyOf(providerId)`（闭包内异步）供 `probeModel` 调用。
- 回渲染端的成功结果多了 `via`（命中候选的 URL，此前恒为固定端点）；失败结果的 `error` 既有取值不变（`HTTP <code>` / `timeout` / `request failed` / `no models in response`），新增 `upstream error <code>`、无合法 code 时的 `upstream error`，以及 2xx 的 `upstream error <code>`。渲染端对 `error` 只做原样展示，无需改动。
- 换发 token、PAT、OAuth 令牌都只在内存与请求头出现，不落盘、不进日志、不回渲染端。

## 验收场景

1. 首选候选返回 OpenAI 形态列表：只发一次请求即成功，次候选零触达，`via` 为首选 URL。
2. 首选候选非 2xx / 错误信封 / 空列表 / 超时：换次候选；次候选出列表即成功，`via` 为次候选 URL，请求顺序固定。
3. 次候选回 HTTP 200 + `{"code":401,"success":false}`：结果为失败 `HTTP 401`，不是 `no models in response`（用户报告的原症状）。
4. 信封 `code` 非 HTTP 语义（如 z.ai 的 1001）：`upstream error 1001`；`code` 缺失或非数字：`upstream error`。
5. 所有候选都是空列表：`no models in response`，且每个候选都试过。
6. 每个候选请求都带 `redirect: "error"` 与 Bearer 套餐 token。
7. 小写端点 id 归一：`glm-5.4` → `GLM-5.4`，`glm-5.3-flashx-legal` → `GLM-5.3-FlashX-Legal`；表外 id 原样保留。
8. 探测：有 location 时换发一次 GLr token，messages 请求带 GLr token，OAuth 不进 messages 请求；v2 条目 key 在时不换发；并发 4 个探测只换发一次；团队源未切团队时零请求并回 `auth`；团队源在团队选择下走 PAT、不碰个人 location；zai 源有 v2 条目 key 时仍走 OAuth；无 location 的旧宿主/夹具仍走 OAuth（原行为不变）。
9. 列表：首选回空列表后，次候选的错误信封/非 2xx/读体抛错/超时必须按次候选的原因报错（`HTTP 401` 等），不得被残留的空列表盖成 `no models in response`；实例 dispose 后不再发下一候选；非 2xx 候选的响应体被显式取消；仅大小写不同的 id 归一后只留一条。
10. 既有契约不回归解不出 token 零请求、密文不外发、新旧键优先级、`planListable` 家族去重。

## 已知取舍

- 确认流探测在探测请求前可能多一次最长 15 秒的换发，单模型最坏约 30 秒，超过渲染端探测请求的默认 25 秒回执兜底（`mpAsk` 缺省值）：渲染端先显示失败时主进程那次探测仍在跑，结果丢弃。换发成功后有 10 分钟 memo，通常每次会话只发生一次。
- 团队源未切团队时探测回 `kind:"auth"`、零请求，渲染端按既有文案显示「鉴权失败：API Key 无效或无权限（HTTP ?）」——实际原因是未切换团队。改成专用文案需要动渲染端，本批未做。
- 候选循环对 `disposed` 只在候选之间检查；`planProbeKeyOf` 的换发/三步换发在途时最多再跑 15 秒（只发官方域），dispose 后其结果一律按 `provider changed` 丢弃。

## 未验证

- zai 家族两个候选端点与探测端点都没有真实 Z.ai 账号实测；只确认了 `api.z.ai` 上两条路由存在（无凭据时分别回 HTTP 401 与 HTTP 200 信封 code 1001）。
- 团队套餐的探测在真实团队账号上未实测（PAT 三步换发本身由增强链用例覆盖）。
- BigModel Start Plan 源的列表仍是账号级口径（与个人档同一把 OAuth 令牌、同一组端点），不是「该卡实际包含的模型」；纯 Start Plan 账号在 Coding Plan 列表端点上是否有返回未测。
- 服务端为何收紧、OAuth 在 OpenAI 形态端点还能用多久均无官方说明；若 OpenAI 形态端点也拒 OAuth，两个候选会一起失效，届时需给 Anthropic 候选改配 GLr 凭据（本次实测该组合可用，未实现）。
