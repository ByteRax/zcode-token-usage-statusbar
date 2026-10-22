# 额度支持审计矩阵

审计日期：2026-10-22。范围：本仓库 main 开发线及本轮修复，不代表已发布、已安装或全部厂商已真账号验收。

## 结论与证据等级

- **v1.5.2 正式版 ≠ main 开发版**；开发源码、仓库插件副本、安装缓存、稳定运行文件须分别核对，不能以源码存在推断正式版可用。
- 原“自动支持”承诺已收窄：只对已知协议、明确凭据与可证明的账号归属适配；不是任意供应商、任意中转自动查账。
- **BigModel、当前 BX-GPT 的 sub2api `/v1/usage` 已本机真实账号实测**。其余源码转写适配按夹具验证理解，**不是真实账号验证**；即使未标 `unverified`，也不因此升级证据等级。
- **sub2api 已接入自定义中转适配路径**，同源 `/v1/usage` 命中即停止 legacy 探测；尚未发布。
- 未新增任意域管理接口探测；自定义中转仅在配置地址同源内查询已知用量协议，不猜测管理凭据或跨域发送 key。

## 实装、凭据与验证矩阵

“实装”指开发源码具有适配逻辑，不等于账号可访问、自动激活正确或桌面展示已实测。

| 对象 | 实装与缺失 | 自动凭据取得 / 额外权限 | 实测程度与解析、展示边界 |
|---|---|---|---|
| BigModel 个人 Coding 套餐 | monitor 额度 + 订阅元数据 | 可解密宿主 OAuth；支持专用 env 覆盖，不需额外索取管理 key | **本机实测**；账号级套餐池；团队套餐仍不支持 |
| Z.ai Coding | 已有 Coding monitor 适配 | 宿主 Z.ai OAuth；与 BigModel 凭据族区分 | 源码/夹具证据，不是真账号验收；不能外推到 Start Plan |
| Z.ai Start Plan | **未实装专用协议** | 没有已验证的自动取得和查询链 | 宿主按钮存在或 Coding 可查，不代表 Start Plan 受支持 |
| MiniMax Coding | 已有 remains 适配 | env / 本机 secrets / 已知官方域供应商配置 | 源码转写、夹具验证；剩余比例转已用比例；`weekly_status == 3` 不展示周窗 |
| Kimi Coding / Moonshot PAYG | Coding 额度；401 回落 PAYG 余额 | env / secrets / 已知官方域供应商配置 | 源码转写、夹具验证；remaining 口径与分转元须分别处理，不能假设所有 Coding key 有 PAYG 权限 |
| CommandCode | 已有订阅与用量适配 | 专用 key，env / secrets；非通用推理 key 自动发现保证 | 源码转写、夹具验证；需匹配订阅、组织和统计周期 |
| Cline Pass | 已有用量窗口适配 | 专用 key，env / secrets | 源码转写、夹具验证；配置型源，凭据可读不等于一定激活 |
| Anthropic Pro / Max | OAuth 用量适配；不是普通 API 计费余额 | **必须显式 opt-in**；env / secrets，或**另读 `~/.claude/.credentials.json` 的 Claude OAuth**，属跨应用读取 | 源码转写、夹具验证；不是自动复用宿主推理 key；仅支持选定主窗口，不冒充子配额完整覆盖 |
| DeepSeek | 官方余额适配 | env / secrets / 官方域供应商 key | 夹具验证，非真账号；有效零余额处理列入本轮修复 |
| SiliconFlow | 官方用户余额适配 | env / secrets / 官方域供应商 key；国内外域须保持对应 | 夹具验证，非真账号；分域及 `totalBalance` 选择列入本轮修复，不能以赠额等单项冒充总余额 |
| OpenRouter | `/api/v1/credits` 账户余额适配 | **需 management key，不是普通推理 key**；使用 `OPENROUTER_MANAGEMENT_KEY` 或设置中的 Management Key，不自动将推理 key 发往 `/credits` | 夹具验证，非真账号；缺 `total_usage` 不得当 0；本轮修复严格检查响应完整性 |
| 小米 MiMo | 控制台套餐/余额协议适配 | **控制台 Cookie**，需 `userId` + `serviceToken`；env / secrets；**不是自动读取推理 API key** | 源码转写、夹具验证；Cookie 有效性、控制台协议与展示待真账号校准 |
| 火山 | 签名查询，双用量接口探测 | **AK/SK**，env / secrets，须具备对应查询权限；**不是自动读取推理 API key** | 源码转写、夹具验证；签名和 HTTP 200 错误信封均需校验；尚无真账号保证 |
| SCNet | 本地账本估算 / 外部快照输入 | 不要求在线凭据；需套餐 Credits、周期、模型映射等估算配置 | **不是官方在线额度接口**；抵扣表及本地记录覆盖影响准确性，展示必须标识估算 |
| sub2api | **本轮新增**：同源 `/v1/usage`，识别 key 用量/余额及订阅窗口 | 配置中转地址及其推理 key；不索取后台管理 key | 当前 BX-GPT 真站查询及最终运行文件的 createQuotaClient 全链均返回 status=ok、kind=plan、日/周/月 USD 窗口；remaining 不作为钱包余额 |
| CLIProxyAPI | **无专用管理适配** | 管理 API 需要独立 **management key**，不能把推理 key 当管理权限 | 通用 OpenAI legacy 路径不等于支持其管理 API；不新增管理端探测 |
| new-api | **无专用适配** | 用户/管理访问令牌等不能由普通推理 key 默认推定 | 部分部署兼容 legacy 不能构成 new-api 全面支持承诺 |
| 其他自定义中转 | 已有同源 OpenAI legacy 查询尝试；非万能识别器 | 仅配置地址及其 key；不猜测额外管理凭据 | 协议或字段不匹配按 unsupported / parse_error，不用 0 伪装成功 |

## 解析、激活与展示问题

| 类别 | 审计事实 / 本轮状态 | 验收要求 |
|---|---|---|
| 本轮解析修复 | DeepSeek 有效 0 值、SiliconFlow 分域与 `totalBalance`、OpenRouter 缺 usage；由主智能体本轮修复，不列为最终遗留未修项 | 以最终 diff 和对应回归结果确认，不将“在修”写成“已发布” |
| 本轮新增接入 | sub2api 由主智能体接入，旧实现不足以表达其余额及订阅响应 | 检查同源 URL、余额/订阅夹具和 chip 展示；真实站点另验 |
| env 激活缺口 | `resolveCred()` 能读 env 不代表调度器能激活；`activeSet()` 对多数源未用 env 建立上下文，配置型源还受 enabled 门控 | 本轮已修并测试：env-only 默认源、enabled+env 的 Cline、无 primary 均可取数；Anthropic 继续要求显式开启 |
| 源开关失效 | 默认源使用 `defaultOn || enabled`，显式 false 不能覆盖默认 true；primary 分支也未统一受源开关约束 | 本轮已修：primary 与后台源均尊重显式 false，关闭态不带旧额度；夹具验证无网络请求及勾选态回显 |
| 权限提示 | 自动发现 OpenRouter 推理 key 可能随后认证失败；管理权限要求与“发现凭据”是两件事 | 文案明确 management key，不承诺零配置成功 |
| 字段完整性 | 缺额度、usage、余额或窗口字段不是数值 0；合法零值也不能按缺失丢弃 | **响应字段不完整不补零**；解析失败 fail-closed；旧成功值如保留须标 stale |
| 展示归属 | chip 主显跟随当前 pane 的 provider；tooltip 可列多源，均为账号池/余额，不是单模型独享 | 源激活成功不等于 chip 必然主显；未完成请求的 fallback、切源、关闭后残留需桌面验收 |
| 验证边界 | VM / HTTP 夹具能检验解析与状态机，不能证明真实凭据、厂商权限或客户端挂载 | 除 BigModel 与已验证的 BX-GPT/sub2api 接口外不得把夹具通过表述成真账号实测；本文件不新增该类实测声明 |

## 核对入口

- `quota-client.cjs`：适配器、凭据发现、`resolvePrimary()`、`activeSet()`、`tickSource()` 与源列表。
- `overlay.js`：源开关、凭据字段、chip/tooltip 的状态与归属展示。
- `inject-main.cjs`：额度快照、配置写入与刷新桥接；`zusage.py`：SCNet 本地估算输入。
- `tests/quota-client.test.cjs`、`tests/overlay-quota-chip.test.cjs`：隔离夹具；不是实际厂商账号凭据测试。
- OpenRouter 官方文档：[Get remaining credits](https://openrouter.ai/docs/api/api-reference/credits/get-credits)（management key 要求及 `total_credits` / `total_usage` 字段）。

本矩阵描述开发版修复；真账号范围仅限上述接口，部署、重启与正式发布另行记录。

## 尚未承诺全自动的边界

- Z.ai Start Plan、CLIProxyAPI 管理协议、new-api 专用协议未在本轮新增，不能继续列入“已支持零配置”。
- 配置型源（Anthropic/Cline/MiMo/火山/SCNet）的后台查询与“当前自定义 provider 自动映射到此源”是两回事；缺 detect/显式绑定者不能承诺随模型主显，详见矩阵。
- 供应商 key/baseURL 在 provider 不变时的即时失效/冻结恢复仍需完善；本轮不把一次成功查询外推成所有账号切换都已实机验证。
- Kimi PAYG 仍继承参考项目按金额猜分/元的启发式，低余额有单位误判风险，待明确厂商响应协议后修正；MiniMax weekly status=2 的参考实现存在分歧，不能无真实样本硬改。
- OpenRouter 改用管理密钥是权限正确性修复，不是新增零配置支持；SiliconFlow 410 为明确不可用提示，不是已恢复端点。

本轮验证：Node 498/498、Python 517 项（516 通过、1 环境跳过），两轮只读复审问题已修；合并现有模型选择/有效期/Git 热修后的部署件定向 65/65。quota-client 为冷文件，需完全退出重开客户端。源码在独立 worktree，未提交、未推送、未发版。

## Issue #56：非默认数据目录与 key-only 规则

- 路径优先级：显式调用参数 → 宿主 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` / `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` → `ZCODE_DATA_BASE_DIR/.zcode/v2` → 历史 desktopHome / OS HOME。凭据与监听目录采用同一解析结果，不再读迁移前 HOME 的陈旧副本。AES 密钥派生仍用 OS HOME，不因数据目录迁移而改变。
- builtin 与 personal 供应商配置按 providerId 合并，access/api 字段逐层继承，个人显式空 key 不复活内置 key；key-only 规则保留。只有精确内置 `minimax` ID 可使用国内默认域，国际 builtin 域优先，不能按供应商名称或模型名猜域。
- 配置缓存包含两文件路径、mtime 和 size；删除/无法 stat 时撤销缓存。配置变更重新判断全部已登记 provider 的归属、撤销旧凭据及迟到响应，非焦点窗格也不能继续展示旧额度。
- 读配置和监听位置已用 Windows 中文、空格、根目录、迁移 HOME 陈旧副本、同时间戳文件重建夹具验证；不等价于在反馈者 Windows 设备上实测。
- sub2api 同时支持真实 subscription 日/周/月额度、`quota_limited` Key 总额度和 5h/1d/7d 支出窗口，以及具有明确 balance 字段的钱包；Key 额度不标钱包，缺省 remaining 不补零。
