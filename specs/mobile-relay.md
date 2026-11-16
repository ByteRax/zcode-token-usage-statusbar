# 手机远控中继（mobile relay）

## 产品规则

- 目标行为：宿主「Web 远程控制」会话活跃时，向远控浏览器推送目标专属数值快照，由接收脚本调用桌面同一份 `overlay.js` 渲染。本地、WSL、SSH 使用同一状态条、tooltip、设置与挂载代码，不再渲染独立 chips 回退条；完整契约见 [统一桌面状态条](mobile-unified-overlay.md)。
- 数据通道复用宿主官方中继（`wss://zcode.z.ai/api/v1/remote/ws2`，rpc-frame 信封）。本项目不新增自有服务器、不自建 WebSocket：发送必须经 `webRemoteControlManager` 桥接运行时的 `relayProtocol.protocol.send()`（AcknowledgedRelayProtocol 的唯一合法入口，seq/messageSeq/ack/降级语义全部归宿主协议栈），绝不直接写 relay socket——绕过 acknowledged 协议的裸帧会破坏手机端 ack 水位与 `rpc-frame-gap` 检测，可能触发 `bridge-degraded` 打挂用户远控会话。
- wire 载荷形态：RPC `EventFire` 帧（ResponseType 204），id 恒为魔数 `2147483647`（2^31−1；官方 ChannelClient 的 id 从 0 递增，不会碰撞；即使碰撞，载荷带 `zm` 标记由消费端校验）。官方页面 `ChannelClient.onResponse` 对未知 id 静默丢弃（`handlers.get(id)?.(response)`），对宿主页面零干扰——这是选 EventFire 而非自定义 zcode_type 的依据。
- 下行包含目标专属数值投影 `snap` 与随机匿名 `binding`，本地和远端格式一致；不携带真实工作区身份/路径/标题/正文。远端今日统计只取该目标的 `remote_today`。快照超限先裁可选明细，仍超限发目标不可用帧，不改变 scopeKind 或切换渲染器。宿主物理分片按连接、bridgeSessionId、seq 重组，过期残片清除。
- 展示口径、单位、档色、格顺序和 tooltip 均由桌面 overlay 源码负责；主进程不维护第二套格式化函数。真实零值与缺字段分开，缺数据在同一桌面 UI 显示等待或不可用状态。
- 接收端构建时内嵌与桌面分片构建逐字节相同的 overlay，不再从 CDN main 异步加载另一代代码。
- **目标会话身份（唯一来源）**：主进程经可信唯一桌面窗口的 preload `getWebRemoteControlStatus()` 读取 mobileConnected/mobileTaskView，并与唯一官方 ready live 桥的 path、identity、remoteSessionId 及对象代次联合验证。宿主已验证的动态远控项目无需出现在桌面打开标签名单中；任务证据明确矛盾时仍拒绝。目标撤销后不发新查询；页面切换时桌面移动上下文不得将旧统计套给新 SID。
  - 唯一窗口判定只统计通过 `trustedSender` 的可信宿主窗口：未销毁、类型为 `window`，且页面为宿主 resources 内的 `file:` URL。`data:` 辅助窗（如 CUA「ZCode正在操作电脑」提示）、外部网页及 resources 外的 `file:` 页面均排除，不读取其远控状态；枚举顺序不影响选择。无可信宿主窗口或存在多个可信宿主窗口时保持 fail-closed，不选择首窗。目标发现返回后及发送复验返回后均按当前可信窗口集合重新校验；在途新增辅助窗不撤销有效目标，新增第二个可信宿主窗则拒绝旧结果。
  - `mobileViewState.activeTaskId` 只是导航位置（可能停留在上次会话），**不得**作为当前会话兜底；URL 的 `sid=d_…` 是 `deviceSid`，`remoteSessionId` 是 bridge/source 路由键，两者都不是聊天会话 ID。
  - 主进程按 taskId 与 workspaceIdentity 精确查询和匹配。不能按目录、标题或最近活跃猜目标；发送前重新读取宿主状态并验证桥/relay/protocol对象及路由。真实身份仅用于进程内验证，wire 以随机 binding 隔离同 SID 不同身份。
  - 查询在途发生目标、身份、桥代次变化或撤销时丢弃旧结果；新目标失败发送其专属 unavailable 帧，清除旧显示。能力公告仅更新握手，不能更改数据新鲜度或恢复旧快照。
  - 远端数据库变化不能触发本地文件监听，远端目标单独周期查询；间隔尊重远端 `poll_ms` 与本地限频，不与 1.5 秒目标发现轮询耦合。能力公告只在已确认持久上行钩子或运行时包裹成功时发送。
  - 桌面渲染端不再采集 DOM chips（v376 移除 13-mobile-chips 分片；原 v350 因与主线撞号顺延，`window.__zusageMobileChips` 已无生产者与消费者）；当前手机目标发现直接读取宿主状态，不以 DOM chips 或桌面当前焦点作为目标来源。
- 推送节奏与去重：查询走**常驻** `zusage.py serve`（JSON 行协议，单次 5~20ms，空闲 60s 回收；早退/拉起异常累计 3 次后进入 60s 冷却，冷却期内走一次性 `zusage.py json` 回退，到期清零重试常驻；单次成功回包不清零，避免「回包后立刻崩溃」被误判为已稳定）。请求体带 `lean: true`：`serve`/`json` 在请求内显式 lean 时关闭 `speed_history` 与 `all_projects` 两个桌面增强字段（手机 projection 不消费，避免每次查询多算/多传）；**不能**改用 `ZUSAGE_REMOTE_CHILD=1` 实现 lean——该环境变量承担远端 scope 子查询语义。内容去重键不含 ts（未变即跳过），内容不变仍以 `HEARTBEAT_MS`（15s）放行心跳——消费端以载荷 ts 与接收时刻中更早者起算，超过 30s 切为同一桌面条的不可用空态；能力公告不能续期。本地目标另有独立 10s 数据心跳（`bridgeTimer` 30s 兼作桥维护与兜底心跳，通常被内容去重）：10s tick 与 15s 去重阈值配合，最坏间隔 <25s（< 手机 30s TTL），不会因 tick 被去重跳过形成 >30s 间隔；该 tick **只驱动本地目标**（`workspaceIdentity` 为空），远端目标由 `remoteTimer` 按 `poll_ms` 刷新，且不被 10s tick 拉快（30s `bridgeTimer` 兜底仍可能早于大于 30s 的 `poll_ms`，即实际取二者更早者）；tick 只在 enabled、唯一 live 桥、本地当前目标且 `clientReady` 时 pump，dispose 时清理并 unref。无活跃桥（stash 空）时零查询零流量；桥的活跃判定为 `!bridge.degraded && bridge.relayProtocol` 仍指向 stash 里的实例，失效即剪枝。
- 目标发现节奏：inject-main 独立 1.5s 泵读取宿主当前远控状态，不查数据库；同目标不重复查询，DB事件/远端周期/兜底心跳驱动统计刷新。inject-main 是冷文件，更新后须完全重启生效。
- 数据时效边界：用量库只在**请求完成**时落行，生成中手机端状态格不会逐字跳动（桌面端生成中的 t/s 估算来自渲染桥实时数据，不属于本链路）；这是数据源口径，不是推送延迟。
- 多窗口/多桥：只向能可靠归属当前手机目标的桥发送；归属歧义时停止数据推送，不将同一快照广播给其他连接。
- **隐私契约**：启用本功能时统计数据经宿主官方中继转发，rpc-frame 层无端到端加密，服务器可见载荷。下行仅保留目标会话渲染所需的统计与身份绑定，以及该会话所属主机的今日、项目等聚合（可能包含其他会话贡献），不携带工作区路径、其他会话明细、正文或凭据；上行仅携带显示偏好和代际计数。仅 `mobile_relay.enabled === true` 开启，缺字段、false、非布尔值或非对象配置均关闭；关闭期间不发能力公告、不发统计快照、不启动插件中继统计查询，已在途查询结果丢弃。只控制插件扩展，不启停或拦截宿主官方远控的普通问询、消息与会话内容；不新增手机能力撤销信号，手机仍可能在既有能力有效期内尝试上行偏好，桌面消费并忽略，不应用、不回执；用户无需另行关闭手机上行。
- **门控与配置**：仅收到同一桥带真值 `zuUp`（当前版本 2）的显示偏好配置后才查询；下行 `zuUpCap/cfgGen` 完成能力握手与回执，未确认的连接零上行字节。显示偏好由桌面 overlay 的 zusage3.* 键与设置面板消费，主进程只发送受限统计投影。DB watcher、activity_min_ms 限频及 30s 兜底心跳（`bridgeTimer`，通常被内容去重）保持；本地目标另有 10s 数据心跳；远端无本地写入时按 `poll_ms` 与 30s `bridgeTimer` 兜底中更早者刷新（`poll_ms` 小于 30s 时仍以 `poll_ms` 为准）。
- 油猴脚本的下行契约：①下行数据仍走宿主协议栈借道（`relayProtocol.protocol.send`，seq/ack 全归宿主）；②**永不发送无标记的 rpc 帧**——旁听者无法合法取得手机→桌面方向的发送 seq，裸帧会撞 acceptPayload 严格连续校验（`messageGap` terminal）打挂会话；③上行**仅限**带 `zuUp` 版本标记的帧（配置同步），且仅当宿主下行帧携带 `zuUpCap` 能力确认（补丁钩子在严格校验前消费，官方 ack/水位零接触），未确认能力时零上行字节。手机页协议栈不因脚本存在而改变行为（接收侧仍是纯旁听）。
- **上行代际兼容与公告门控**：持久上行钩子有两代——v2 推 `{frame,b,relay}` 外壳（dispatcher/队列），v1 直接推带 `zuUp`/`zuCfg` 的裸帧。消费端识别 v1 裸帧后置 `legacyUplinkSeen`、`lastError="legacy uplink frame ignored"` 并丢弃，**不**把裸帧绑定当前桥、`clientReady` 保持 false；`legacyUplinkSeen` 为真时停发能力公告（`status()`/diag 暴露该标记便于诊断），`disable()`/重开时重置以重新检测。能力公告的上行判据 = 运行时包装成功（`relay.__zusageUplinkWrappedV2 === relay.acceptPayload`）**或** 持久 v2 注入标记 `globalThis.__zusageRelayUplinkGeneration === 2`（由补丁链注入，本模块只消费）；`acceptPayload` 只读、运行时无法包裹时仅后者可用，两者都没有时不发公告。
- **唯一 UI**：图标、CSS、设置面板、tooltip 和默认/药丸/精简样式直接使用桌面 overlay。手机仅保留传输适配及可选调试面板，不再复制格样式或设置控件。
- **挂载**：完全沿用桌面输入卡定位、自愈和窄窗规则。移动空态仍用同一条显示等待/不可用并保留设置入口，恢复后遵循已有样式偏好。

## 手机设置能力与脚本入口

- 桌面 ⚙「维护」组新增独立 `mobile` 分区「移动端远程控制」，开关「推送状态栏数据到远控页」与正式版油猴脚本链接均放在此；链接从「关于数据」移除，URL 为 `https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/zusage-mobile.user.js`。共享 overlay 拥有链接展示：沿用现有字段样式，以带中英文标签的只读、可聚焦和选择复制的 URL 输入框呈现，不禁用字段，不新增复制按钮；不自动安装、不打开外链，也不为此发送配置或主进程请求。用户自行复制到远控浏览器的脚本管理器安装。关于数据的「联网边界」说明官方中继、服务端可见载荷、当前会话标识与统计范围、正文/路径/凭据排除项及对宿主远控无影响。
- 开关唯一真值来自运行目录 `config.json`，主进程状态下发 `mobileRelayEnabled`（严格布尔）和 `mobileRelaySupported: true`；旧主进程缺能力字段时控件禁用并提示需完全重启/更新桌面插件，不能显示已保存。前端固定动作 `mobile-relay` 只接受布尔开关值，按现有本地页面与窗口校验；锁内重读，仅合并 `mobile_relay.enabled`，保留其余嵌套/顶层未知键，损坏配置不重建；写后回读必须存在与请求一致的显式布尔值，旧事务助手忽略合并字段时返回失败。写成功后清配置缓存、关闭时撤销目标/递增代际丢弃在途响应并回收中继常驻查询，广播实际状态并回执；写失败回滚控件并提示。快速切换期间控件禁用直到回执，多窗口由状态广播收敛。新行为涉及冷文件 `inject-main.cjs`：旧 loader 必须先安全部署匹配的安装副本与实际加载运行文件，再完全退出并重启 ZCode，才能加载新增动作及模块装配；仅更新浮层或仅重启均不能替代部署。
- 缺字段用户（含旧版缺省开启者）升级后关闭；已有显式 `true` 保持开启、显式 `false` 保持关闭。不开启时仍可访问脚本链接，安装脚本不自动授权推送。共享 overlay 在 `mobileMode` 下保留 `mobile` 导航项与分区 HTML（与桌面一致），但手机状态 `mobileRelayEnabled`/`mobileRelaySupported` 恒为 false：推送开关显示为未勾选且禁用，状态文案提示到桌面「设置 → 维护 → 移动端远程控制」修改、手机不显示桌面当前值；手机 change 事件早退，不产生 desktop 配置请求，手机不写桌面配置。
- 手机界面沿用统一桌面 overlay 的设置与移动模式，图标、CSS、控件和空态由共享分片拥有。桌面配置动作仅由可信本地窗口处理，手机显示偏好继续走既有 `zuCfg.prefs`，不新增通用远端配置 RPC。状态轮播沿用共享 overlay 的 `zusage3.rotator2` 偏好，缺省关闭，已有启用状态与配置保留。
- **新旧 loader 混载**：旧冷文件的 `isEnabled` 可能仍使用缺省开启语义，新 `mobile-relay.cjs` 不得仅凭该回调放行。`initMobileRelay()` 创建 relay 时传给 `createMobileRelay(options)` 的 `options.strictOptIn === true` 且 `isEnabled` 确认配置显式开启时才可启用；能力标志缺失或非法时，即使旧回调返回 true 也保持关闭。部署到完全重启前不发能力公告、统计快照或中继查询；先安全部署匹配的新冷文件与热模块，再完全重启，重启后仍只有配置显式 `true` 才启用。

## 状态所有者与接口

- `mobile_relay_patch.py`（共享分发文件）：拥有 app.asar 主 bundle（`out/main/index.js`）的 stash 注入。登记表 `MOBILE_RELAY_TARGETS` 钉死（版本, 原始 sha256, 锚点, 注入表达式）；锚点为 `relayProtocol=<sym>,<bridgeSym>.disposeBridge=`（3.18.1 实测唯一），在赋值后插入逗号表达式把 `{p: <relay>.protocol, b: <bridge>}` push 进 `globalThis.__zusageRelayStash`。机制镜像 `renderer_bridge.py`：剥 patch_install 注入尾缀后按原始前缀 SHA256 校验、表外版本走正则推导（derive）并严格唯一性校验、asar 重写重算 integrity、锁内临时文件原子替换、restore 反向还原。自检/状态输出与 renderer_bridge 同构，供安装链与诊断消费。
- `mobile-relay.cjs`（主进程热换子模块）：拥有 stash 消费、RPC 序列化（EventFire 最小编码器：`[4(Array) 2 204 <VQL id>] + [5(Object) <VQL len> <JSON>]`）、节流与逐桥推送。暴露 `push(payloadObj)`、`pump()`、`disable()`、`status()`、`dispose()`；`disable` 撤销查询代际、手机握手与偏好，取消补拍并回收常驻/一次性查询，不发送撤销帧，保留可重新启用的宿主钩子；`dispose` 在此基础上停定时器与清引用，不动 stash（stash 属宿主 bundle）。**生产默认不写诊断文件**：`diag()` 仅在显式注入 `options.diagPath`（测试接缝/定向排查）时落盘，不再默认写 `__dirname/mobile-relay-diag.json`；`diagThrottled` 同样受此门控。
- 插件安装同步由 `overlay_install.py` 记录待重启 marker：`hot_reload` 显式为 `false` 时，已同步变更的 `mobile-relay.cjs` 必须写入 marker 的 `hashes`，由既有提醒和 loader 确认机制消费；同步被保护而未更新的文件不记录。热重载缺省或开启时，单独更新该模块不因本规则创建 marker，仍由 loader 热换；其他文件的 marker 规则不变。
- `inject-main.cjs`（冷）：拥有手机目标发现和信任验证，将验证后的目标及实时复验器传给 mobile-relay；热换列表含 mobile-relay。负责传入严格 opt-in 能力 `strictOptIn: true`、固定配置动作 `mobile-relay` 与实际状态广播。
- overlay.js（src/overlay 分片）：唯一渲染方，显式移动模式只接受受限 mobile 上下文，按目标/绑定隔离缓存与空态；普通桌面身份校验不变。
- 配置：`config.json` 的 `mobile_relay: {"enabled": false}`；仅对象内显式布尔 true 开启。缺省及非法值关闭，不因安装脚本或页面连接自动写 true。

## 验收场景

- AC1 已打补丁的 3.18.1：`python3 -B -m unittest tests.test_mobile_relay_patch` 以夹具 asar 验证 apply/check/remove 往返、原始前缀 SHA 漂移拒绝、锚点缺失/重复拒绝、注入尾缀两种形态兼容。
- AC2 热换与重启提示：热重载缺省或开启时，`mobile-relay.cjs` 更新由 loader 热换，单独更新不产生 marker；显式 `hot_reload:false` 时，单独更新必须产生含实际文件 hash 的 marker，同步完成后提醒重启，重启确认前不得误销账。受保护未同步的更新不产生该文件的 marker。
- AC3 端到端（实机）：桌面显式开启插件推送并开启远控会话，浏览器（桌面或手机）带油猴脚本打开远控页，状态条出现且随快照更新；关闭远控后停止渲染新数据，旧快照到期后切为同一桌面条的不可用空态；宿主页面无新增报错。
- AC4 无干扰：对照无脚本/有脚本两种情况，远控会话功能（消息收发、ack、重连）行为一致；官方页面对 EventFire 魔数帧静默丢弃（控制台无 RPC 错误）。
- AC5 未显式启用（含 `mobile_relay.enabled:false`）：无本项目公告、快照或统计查询；安全上行钩子仍消费插件标记帧并忽略，不改变未标记宿主帧。
- AC6 WSL/SSH 查询携带当前目标的远端身份；同 SID 的本地及其他远端记录不得匹配，远端今日量与快照来自同一目标；无法确认身份或目标失败时不展示本地替身。
- AC7 查询在途期间切换 SID、切换身份、撤销目标或关闭功能，旧响应不得发送；常驻及一次性回退均遵循同一身份协议。
- AC8 相同目标的发现轮询不重复触发查询；DB 事件、目标变化与兜底心跳继续驱动更新。多桥身份不确定时不广播私有快照。
- AC9 检查真实编码帧：无其他会话明细、工作区路径、标题、正文及凭据；允许目标所属主机今日、项目聚合中的其他会话贡献，真实工作区身份仅保留在进程内。能力公告不改当前数据。另验本地→WSL→本地只存在桌面状态条，以及旧帧/同 SID 换身份/不可用时不继承旧 today 或速度历史。
- AC10 手机加载内嵌的同一桌面 overlay，状态条、tooltip、设置、样式和空态均来自桌面分片；不得复活独立 chips 回退 UI。显示偏好只影响浏览器及既有配置上行，不能通过手机请求修改桌面配置；轮播默认关闭并保留已有偏好。
- AC11 桌面 ⚙「维护 → 移动端远程控制」中英文均有正式脚本 URL 输入框，带本地化 aria-label、readonly 且不 disabled，开关关闭或主进程不支持开关时仍可聚焦选择复制；无安装/复制按钮，点击字段不调用 preload、window.open、剪贴板或主进程请求。关于数据不再有此字段，联网边界包含中继披露；正式/调试产物与元数据地址由构建回归校验。
- AC12 缺配置、缺 enabled、false、null、字符串、数字、数组均不发公告/快照且无中继查询；显式 true 才公告，收到可信手机偏好并确认目标后查询。关闭时在途响应丢弃；快速关开不能复活旧查询，关闭期间由持久 asar 钩子排入的偏好也必须在新启用代丢弃，重新握手后才能推送；同一宿主 bridge 跨模块 dispose/create 热换后，新实例接管已有安全上行钩子，不能被旧实例的关闭状态永久吞掉，重复热换不累计包装层。无新增手机撤销帧，未标记宿主帧照常交还宿主。
- AC13 本地面板通过固定动作保存布尔开关，锁内保留最新顶层及 mobile_relay 未知字段，失败保留原文件/回滚勾选；主进程广播使多窗口一致。缺能力字段的旧主进程上控件禁用提示重启/升级，手机端不能修改桌面开关，伪造远端配置动作不能通过本地窗口校验。
- AC14 新 relay 与旧冷 loader 混载：`strictOptIn` 缺失、false 或非布尔值时，即使 `isEnabled` 返回 true，也无能力公告、快照与中继统计查询；匹配新 loader 的 `strictOptIn: true` 加显式配置 true 才能握手。手机 `mobileMode` 保留 mobile 导航与分区 HTML；enabled/supported 均为 false，开关未勾选且禁用，状态文案为手机只读提示而非「重启/升级桌面插件」，change 不产生配置请求。
- AC15 整桥隔离回归 `tests/inject-mobile-bridge.test.cjs`：一个可信 app.asar 主窗与 `data:`、外部网页或 resources 外 `file:` 辅助窗共存时，不论枚举顺序，目标发现、实时 validate 与发送复验均成功且不执行辅助窗脚本；仅辅助窗时不发现目标。在途发现与发送复验期间新增辅助窗仍接受当前目标，新增第二个可信主窗则拒绝；既有多可信主窗拒绝测试继续通过。
- AC16 本地目标空闲（无 DB 事件）时由 10s 数据心跳驱动 pump，配合 15s 内容去重，连续成功帧间隔始终 <30s（最坏 25s）；DB 事件紧邻 tick 的相位也不产生 >30s 间隔；dataTimer 只驱动本地目标（`workspaceIdentity` 为空），远端目标仍按 `poll_ms` 由 remoteTimer 刷新；`bridgeTimer` 30s 兼作桥维护与兜底心跳（通常被内容去重）。回归 `tests/mobile-relay-remote.test.cjs`。
- AC17 中继请求带 `lean: true`：默认 serve/桌面 json 仍带 `speed_history` 与 `all_projects`，lean 请求两者都不带（仅显式布尔 true 生效）；`ZUSAGE_REMOTE_CHILD=1` 远端子查询契约不变。回归 `tests/mobile-relay-projection.test.cjs`、`tests/test_speed_history.py`、`tests/test_all_projects_usage.py`。
- AC18 v1 裸上行帧（无 `{frame,b,relay}` 外壳、直接带 `zuUp`/`zuCfg`）：不发能力公告、`clientReady` 保持 false、`status().legacyUplinkSeen` 与 `lastError` 可诊断；`acceptPayload` 只读但 `globalThis.__zusageRelayUplinkGeneration === 2` 时公告恢复发送；只读且无标记时不发公告。
- AC19 诊断默认零写盘（未注入 `diagPath` 时 `fs.writeFileSync` 不被调用），显式 `diagPath` 仍写；常驻查询连续 3 次 <30s 失败后进入 60s 冷却走一次性 `json`，冷却到期重新 spawn `serve`，单次成功回包不清零失败计数。
- 待实机验证项：油猴脚本在远控页的 WebSocket 是否创建于页面主线程（若在 Worker 内则 v0 抓不到帧，需扩展 Worker 劫持——调试面板帧计数为 0 即为该信号）；iOS 端脚本管理器兼容性。
