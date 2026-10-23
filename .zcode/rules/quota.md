# 套餐额度链规则

适用路径：`quota-client.cjs`（及 `plugins/zcode-token-usage-statusbar/quota-client.cjs` 副本）、`overlay.js` 的额度 chip 与 ⚙ 额度源面板段、`inject-main.cjs` 的额度推送段、`zusage.py` 的 SCNet 估算段、`tests/quota-*.test.cjs`、`tests/overlay-quota-chip.test.cjs`、`docs/quota-support-audit.md`。

改动上述路径或涉及套餐额度/账户余额展示前先读本文件。全局不变量（账号级口径、凭据契约、fail-closed、只进桌面链）在根 [AGENTS.md](../../AGENTS.md) §5，本文件是其细则；具体支持范围以 [docs/quota-support-audit.md](../../docs/quota-support-audit.md) 为准。

## 1. 内置套餐（BigModel / Z.ai）解析

- 数据来自解密宿主 OAuth 凭据（`enc:v1` AES-256-GCM 重写实现）直查 `bigmodel.cn|api.z.ai /api/monitor/usage/quota/limit`。bigmodel family 用**裸 `authorization` 头**，zai family 加 `Bearer`；解密出的 access_token 可直接查 monitor，无需 PAT 换证链。monitor 与 subscription 都是无文档逆向接口，字段形状变化按契约丢弃并留痕，不猜。
- `enc:v1:iv.tag.ct` 解构时三段位置不能错位（前导逗号占位会把 ct 当 tag，报 "Invalid authentication tag length"，凭据本身没坏）。
- 窗口分类按 `unit` 显式优先：`3`=5 小时、`6`=周；`unit` 缺失的条目按 `nextResetTime` 升序依次补 fiveHour、weekly 空槽；未知 unit 记入 `unknownUnits` 不展示。绝不按 reset 时间排序代替 unit 分类——周期末尾周窗可能比 5 小时窗更早重置。reset 秒/毫秒自适应（`< 1e12` 视为秒）。`TOKENS_LIMIT` 与 `CREDIT_LIMIT` 等价（bigmodel 用前者、zai team 用后者）；`TIME_LIMIT` 是工具期窗。`usageDetails` 分项是内置工具（search-prime、web-reader 等），不是模型。
- monitor `percentage` 是整数已用%（48/4000 显示为 1，精度粗）；能自算时用 currentValue/usage。宿主 UI 把它反转成"剩余"展示，插件直接展示已用；chip 档位色按原始值判定，不按显示取整值。
- BigModel 并行拉 `/api/biz/subscription/list` 取订阅元数据：只采信 `status==="VALID" && inCurrentPeriod===true` 的**唯一**一条（0 条或多条均置 null）；白名单字段 version/productName/valid/续费时间，其余（含订单号等敏感字段）不进日志、诊断、快照；订阅拉取失败或结构变化静默降级，不拖累额度状态机。
- 套餐 version（v1/v2/v3）与档位（lite/pro/max）正交，宿主零版本差异化逻辑（version 字段客户端不解析），禁止按版本写计费差异或特判。
- 有效期语义与宿主 `pickCurrentSubscriptionExpireTime` 同源且更严：非自动续费 `nextRenewTime`=当前权益结束日；自动续费=下次扣费日（renewAt，不声称最终到期）。`nextRenewTime`/`currentRenewTime` 接受纯日期与宿主同款日期时间（空格/T、可选秒、Z 或 ±hh:mm，偏移须带冒号且 ≤ ±14:00，无偏移按 UTC+8）。valid 区间可能超前一个计费周期，只有包含当前时刻的区间才作权益边界：端点带时刻按精确时刻比较（续费日 10:00 前未来区间不生效），仅日期端点按服务端日历日左闭右开；未来/过期/反转/非法日历或非法时刻（25:99）整段拒绝。仅日期的续费边界覆盖整个服务端日（续费日当天上午不清除）；带时刻边界已过=陈旧行，非自动续费回退已生效 valid、自动续费隐藏日期。绝不按 billingCycle 手工减年。

## 2. 多源调度器与适配器

- 适配器注册表以 `quota-client.cjs` 源码为准，不在文档里维护厂商清单；新增适配器必须同步发 key 域白名单与 `docs/quota-support-audit.md`。
- 适配器契约三段：`detect(j, providerId)`（纯函数、按 baseUrl 域名命中官方域，返回 null=不命中）→ `resolveCred` → `fetchOne`（内部调用 normalize* 工具函数归一化响应）。识别结果缓存，baseUrl 变化才重探；全部不命中才落 generic custom。
- apiKey 模式（宿主 apiKey 连接）：provider_id 形如 `bigmodel-api[-N]` / `zai-api[-N]`（非 `account:*`），按家族映射到 bigmodel/zai 适配器的复合源（`bigmodel:<providerId>`）；凭据优先级 env → quota-secrets → provider_config 同家族 key（`access.type` 以 `coding-plan-api-key` 结尾者优先，其次当前 provider，其次首个非空；显式 baseUrl 不在 bigmodel.cn / z.ai 域则不采用，绝不外发）→ 宿主 OAuth；key 只在内存与请求头流转。`provider_fallback` 仍只取 `account:%`，apiKey 用户在会话首个 main_turn 完成前无回退 chip。
- **不做**用户自定义 request/extractor 模板或用户 JS 解析器（主进程执行用户脚本的攻击面 + 与 key 域白名单冲突）；新协议只走加适配器（dsh / cc-switch 等 MIT 源码转写）。标 `unverified` 的适配器未经真实账号实测，不在文档中宣称已验证。
- enabled 源全量低频刷新（供 tooltip 分家列全），chip 主显跟随本 pane 会话模型归属（primary 源）。每源独立 TTL（套餐 `TTL_MS` 10 分钟 / 余额 `TTL_BALANCE_MS` 15 分钟）、epoch、退避与凭据指纹；源状态按源 id 分桶（家族 id 或 `family:<providerId>` 复合源 id），key 指纹是状态内字段（用于退避复位与冻结解冻），模型不入键。
- 推送协议 `{active, byProvider, sources: {id: entry}}`，`byProvider` 解决多窗串显；本版对 active 源字段做顶层镜像兼容（下版移除）。渲染端对任何新增字段判空不渲染或整块隐藏——热文件 `overlay.js` 可能先于冷文件 `quota-client.cjs` 部署。
- 复合源 `custom:<providerId>`：禁用/撤销/唤醒/解密检查一律经 `adapterOf(id)`，`ADAPTER_BY_ID.get(id)` 裸查会漏复合源；凭据变化须经 `rememberProvider` 写 `byProvider`，裸写会把厂商内复合源坍缩成裸家族源（丢账户隔离）。复合源在集时跳过同厂商裸源激活（同凭据去重）；随 pane 离开保留 TTL 缓存，但禁用或凭据失效即时撤销。
- 各家陷阱（改对应 `fetchOne`/`normalize` 时必查）：MiniMax 返回剩余%须翻转为已用%，`current_weekly_status === 3` 表示无周限额（remaining 恒 100）必须跳过周窗；Kimi 是 remaining 制、订阅端点强制 UA `KimiCLI/1.6`、401 回落 moonshot PAYG 余额（分→元）；Anthropic 只取 five_hour/seven_day 主窗、`seven_day_sonnet` 等子配额窗整体丢弃、`defaultOn: false` 且 `enabled !== true` 不激活（读他产品凭据 `~/.claude/.credentials.json`，披露单列）；火山为 SigV4 火山变体（scope 尾 `request`、SK 无前缀）+ `GetAFPUsage`→`GetCodingPlanUsage` 双探测，HTTP 200 也可能带错误信封；MiMo 凭据为控制台 Cookie（`userId` + `serviceToken` 必需）；SiliconFlow 按 `.cn/.com` 保持域币种、优先 totalBalance、410 判 `endpoint_retired`；OpenRouter `/credits` 要管理密钥（`OPENROUTER_MANAGEMENT_KEY` / 设置 Management Key），不自动复用推理 key；DeepSeek 合法零余额可显示，`balance_infos[]` 仅 granted≠0 才拆赠送/充值。

## 3. 自定义中转

- 先同源查询 `/v1/usage`（sub2api），baseURL 已带 `/v1` 时不重复追加；拒绝重定向；HTTP 401/429 保持分类不继续穷举；仅 `parse_error`/404/405 才回退 OpenAI legacy billing（`/dashboard/billing/subscription` + `/usage`），usage 缺失不得补 0。
- 订阅按 `daily/weekly/monthly_limit_usd` 与 usage 展示窗口，remaining 可能只是日窗剩余，绝不标账户总余额；reset 只取显式字段，expiry 不当 reset。sub2api `unit` 仅接受 USD/CNY/credits。
- legacy `hard_limit >= 1e8` 是按量后付无固定池的哨兵，归 unsupported 隐藏（数据事实不是 bug）；窗口数值过 `Number.isFinite` 防 `"1e309"` 假窗口。识别不了的中转 unsupported 长退避，key/baseUrl 指纹变化解冻。

## 4. 凭据与安全

- 发现优先级 env → `~/.zcode/zcode-token-usage-statusbar/quota-secrets.json`（运行目录；⚙ 面板写入路径强制 0600——tmp 以 0600 写入 + rename 后 chmodSync，Windows/权限失败忽略；外部手编文件的权限不会被收紧）→ 自动发现（宿主 `provider_config.json` 自定义供应商 key；Anthropic 另读 `~/.claude/.credentials.json`）。`ZCODE_BIGMODEL_USAGE_API_KEY` 优先于宿主凭据。
- 凭据只在内存；⚙ 面板 write-only 写入，下发状态 `apiKey` 恒空只回 keyConfigured/keySource；绝不进 `config.json`、日志、诊断、diag。
- 发 key 域白名单=各适配器官方域 + 用户自定义中转的本域；绝不发第三方。
- 路径契约：额度初始化统一 `resolveQuotaPaths()`，显式参数优先、采用宿主 PERSONAL/BUILTIN 路径变量及 DATA_BASE_DIR（基目录追加 `.zcode/v2`）；凭据解密派生仍是 OS homedir，不能改成数据目录。builtin→personal 按 providerId、access/api 局部字段继承，显式空 key 保留；key-only MiniMax 只对内置精确 ID 才可默认官方域。缓存失效、监听目录/文件名须与实际读取一致（Windows 与根目录亦然）。

## 5. 状态机与显示门控

- 退避阶梯 `BACKOFF_MS` = 30s → 2min → 10min 封顶；429 按 `retry-after`（钳 30s–10min）；`parse_error` 30 分钟；`not_configured` 60 秒低频探测；JWT exp 临期（`EXP_SOON_MS`）不发请求。唤醒只在 Infinity/not_configured/host 变化时置 nextAt=0，ok 态保持 TTL；点击 chip/立即刷新绕过一切间隔与冻结。
- 401/403 与无套餐冻结到凭据指纹变化：主进程 fs.watch `credentials.json` + `quota-secrets.json`/`provider_config.json` mtime 缓存失效即解冻。no-plan 判定=业务信封 `success===false` + 文案含 codingplan 不存在/未开通关键词族，不是 401；401/403 单独归 auth 并附结构化 httpStatus 供适配器分流，不靠正则匹配文案。错误分类 bytes-then-parse：读体失败=瞬时、解析失败=确定性。
- 失败保留最近成功值并标 stale（超 TTL 未刷新成功半透明标"已过期"）；解密失败/no_plan/parse_error 一律 fail-closed，绝不显示 0%。
- 全局 `quota_enabled` 缺省开（v111 起真值 `!== false`，answer_rate_line 同款方向；显式 `false` 才关）——主进程据此决定是否解密联网。源状态三态=已关闭（开关关，主进程对显式关闭源统一报 `disabled`）/待查询（开着未到 TTL）/未配置凭据（开着没 key），inFlight 独立字段无 busy 态；主进程下发状态须按 enabled 归一，与渲染端 entryView 同口径；关闭源的刷新按钮禁用。chip 对 `not_configured`/`unsupported` 显示中性灰提示（「额度 未配置/暂不支持」），仅 `disabled`（源被 ⚙ 显式关闭）隐藏。
- 源预设模板 `SOURCE_PRESETS`（主进程静态表，随 sourcesConfig 推送 presets/keyUrl/baseUrl，apiKey 照旧不回显）：⚙ 面板"选模板只填 Key"，官方域变体 chip 一键写入 secrets 的 baseUrl；siliconflow 币种随域（`.cn` CNY / `.com` USD，响应自带 currency 仍优先）；控制台取 Key 链接走 `openExternal` 桥。key-only（无 baseUrl）源也应激活。
- 显示门控：会话首个完成的 `main_turn`（快照 `last.provider_id`，已滤辅助请求污染）出现前，chip 跟随快照顶层 `provider_fallback`（全局最近 account:* 请求）；会话最新请求是自定义 provider 时显示对应自定义源。团队套餐显示"暂不支持"。SSH 远端分栏直接显示本地额度（宿主 provisioning 同账号事实）。
- chip 挂原生上下文按钮（`data-testid="chat-context-usage-trigger"`）左侧，与原生按钮增强同款 render + heavy 双 reapply/还原契约（见 [overlay-ui.md](overlay-ui.md)）；⚙ 面板每源独立开关/凭据/立即刷新，状态中性提示（无凭据/无订阅不报红）；chip/tooltip 不得出现"模型独享额度"语义；时间统一 `yyyy-MM-dd HH:mm`。

## 6. SCNet 账本估算（无凭据）

- 外部快照 `scnet_official.json`（运行目录，≤16KB/24h/周期校验）优先；缺失时按官方 Credits 抵扣表（`zusage.py` 的 `SCNET_CREDIT_RATES`，转写自 dsh，发版前按官方核对）× `sources.scnet.modelPatterns`（model_id → 抵扣表键）在 zusage 侧聚合 main_turn 的 input/cacheRead/output 估算，随快照顶层 `scnet_estimate` 注入。

## 7. 边界与测试

- 额度与本地 token 统计是两条链，互不推导。额度只进桌面快照链；MCP、CLI、`/usage` stdout 契约不加字段；Web 端不做（sidecar 无凭据）。
- 回归：`tests/quota-*.test.cjs`（client 解密/归一化/状态机/竞态/各家适配器形状、paths、provider-revoke、source-lifecycle）、`tests/overlay-quota-chip.test.cjs`（挂载/门控/还原/多源协议/源列表 UI）、`tests/test_statusbar_rate.py`（provider_fallback / scnet 估算）。用例数随改动变化，不在文档里写死；真实厂商响应、凭据刷新解冻与 chip 实机挂载需桌面验收，unverified 适配器待真实账号校准。
- `quota-client.cjs` 是主进程冷文件：改动后必须完全退出并重启客户端才生效，热重载 overlay 验证不覆盖它。
