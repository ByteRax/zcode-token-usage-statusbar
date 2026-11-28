# 移动端远程控制的用量统计中继（mobile relay）

## 产品规则

- 目标行为：插件推送已开启且宿主的「移动端远程控制」会话活跃时，向远控页面推送目标专属数值快照，由油猴脚本调用同一份桌面 `overlay.js` 渲染。本地、WSL、SSH 使用同一状态条、tooltip、设置与挂载代码，不再渲染独立 chips 回退条；完整契约见 [远控页面复用桌面状态栏](mobile-unified-overlay.md)。
- 数据通道复用宿主官方中继（`wss://zcode.z.ai/api/v1/remote/ws2`，rpc-frame 信封）。本项目不新增自有服务器、不自建 WebSocket：发送必须经 `webRemoteControlManager` 桥接运行时的 `relayProtocol.protocol.send()`（AcknowledgedRelayProtocol 的唯一合法入口，seq/messageSeq/ack/降级语义全部归宿主协议栈），绝不直接写 relay socket——绕过 acknowledged 协议的裸帧会破坏远控页面的 ack 水位与 `rpc-frame-gap` 检测，可能触发 `bridge-degraded` 打挂用户远控会话。
- wire 载荷形态：RPC `EventFire` 帧（ResponseType 204），id 恒为魔数 `2147483647`（2^31−1；官方 ChannelClient 的 id 从 0 递增，不会碰撞；即使碰撞，载荷带 `zm` 标记由消费端校验）。官方页面 `ChannelClient.onResponse` 对未知 id 静默丢弃（`handlers.get(id)?.(response)`），对宿主页面零干扰——这是选 EventFire 而非自定义 zcode_type 的依据。
- 下行包含目标专属数值投影 `snap` 与随机匿名 `binding`，本地和远端格式一致；不携带真实工作区身份/路径/标题/正文。远端今日统计只取该目标的 `remote_today`。快照超限先裁可选明细，仍超限发目标不可用帧，不改变 scopeKind 或切换渲染器。宿主物理分片按连接、bridgeSessionId、seq 重组，过期残片清除。
- 展示口径、单位、档色、格顺序和 tooltip 均由桌面 overlay 源码负责；主进程不维护第二套格式化函数。真实零值与缺字段分开，缺数据在同一桌面 UI 显示等待或不可用状态。
- 接收端构建时内嵌与桌面分片构建逐字节相同的 overlay，不再从 CDN main 异步加载另一代代码。
- **目标会话身份（唯一来源）**：主进程经可信唯一桌面窗口的 preload `getWebRemoteControlStatus()` 读取 mobileConnected/mobileTaskView，并与唯一官方 ready live 桥的 path、identity、remoteSessionId 及对象代次联合验证。宿主已验证的动态远控项目无需出现在桌面打开标签名单中；任务证据明确矛盾时仍拒绝。目标撤销后不发新查询；页面切换时桌面移动上下文不得将旧统计套给新 SID。
  - 唯一窗口判定只统计通过 `trustedSender` 的可信宿主窗口：未销毁、类型为 `window`，且页面为宿主 resources 内的 `file:` URL。`data:` 辅助窗（如 CUA「ZCode正在操作电脑」提示）、外部网页及 resources 外的 `file:` 页面均排除，不读取其远控状态；枚举顺序不影响选择。无可信宿主窗口或存在多个可信宿主窗口时保持 fail-closed，不选择首窗。目标发现返回后及发送复验返回后均按当前可信窗口集合重新校验；在途新增辅助窗不撤销有效目标，新增第二个可信宿主窗则拒绝旧结果。
  - `mobileViewState.activeTaskId` 只是导航位置（可能停留在上次会话），**不得**作为当前会话兜底；URL 的 `sid=d_…` 是 `deviceSid`，`remoteSessionId` 是 bridge/source 路由键，两者都不是聊天会话 ID。
  - 主进程按 taskId 与 workspaceIdentity 精确查询和匹配。不能按目录、标题或最近活跃猜目标；发送前重新读取宿主状态并验证桥/relay/protocol对象及路由。真实身份仅用于进程内验证，wire 以随机 binding 隔离同 SID 不同身份。
  - 查询在途发生目标、身份、桥代次变化或撤销时丢弃旧结果；新目标失败发送其专属 unavailable 帧，清除旧显示。能力公告仅更新握手，不能更改数据新鲜度或恢复旧快照。
  - 远端数据库变化不能触发本地文件监听，远端目标单独周期查询；周期查询按远端 `poll_ms` 调度，各触发源共用查询限频，不与 1.5 秒目标发现轮询耦合。能力公告只在已确认持久上行钩子或运行时包裹成功时发送。
- 推送节奏与去重：本地 DB 事件与 10 秒数据心跳驱动统计查询，远端按 `poll_ms` 周期查询，另有 30 秒桥维护兜底，长于 30 秒的 `poll_ms` 不阻止该独立触发源。`activity_min_ms` 限制查询频率。相同内容在上次成功发送后的 15 秒内去重，比较时忽略 `ts`。接收端以载荷时间与接收时刻的较早者计时，超过 30 秒进入不可用状态，能力公告不续期。无活跃桥时不查询或推送。
- 目标发现节奏：inject-main 独立 1.5s 泵读取宿主当前远控状态，不查数据库；同目标不重复查询，DB事件/远端周期/兜底心跳驱动统计刷新。inject-main 是冷文件，更新后须完全重启生效。
- 查询走常驻 `zusage.py serve` 的 JSON 行协议，空闲 60 秒回收。拉起失败或早退累计三次后，冷却 60 秒并回退到一次性 `zusage.py json`，到期再试常驻。单次成功回包不清零失败计数。两种请求都用 `lean: true` 跳过 `speed_history`、`all_projects`、`speed_days`、`worktrees`、`compactions` 和 `peak`，保留 `ZUSAGE_REMOTE_CHILD` 的独立作用。用量库只在请求完成时写入统计，因此远控页面不显示逐字更新的生成中速率。
- 多窗口/多桥：只向能可靠归属当前远控目标的桥发送；归属歧义时停止数据推送，不将同一快照广播给其他连接。
- **隐私契约**：启用本功能时统计数据经宿主官方中继转发，rpc-frame 层无端到端加密，服务器可见载荷。下行包含实际目标会话 ID、随机 `binding`、目标统计投影，以及所属主机的今日、项目等聚合（可能包含其他会话贡献）。模型、工具与子代理标识以泛化标签代替，载荷排除真实工作区身份、路径、其他会话明细、标题、正文和凭据。上行仅携带显示偏好和代际计数。仅 `mobile_relay.enabled === true` 开启，缺字段、false、非布尔值或非对象配置均关闭；关闭期间不发能力公告、不发统计快照、不启动插件中继统计查询，已在途查询结果丢弃。只控制插件扩展，不启停或拦截宿主官方远控的普通问询、消息与会话内容；不新增远控页面的能力撤销信号，远控页面仍可能在既有能力有效期内尝试上行偏好，桌面消费并忽略，不应用、不回执；用户无需另行关闭远控页面上行。
- **门控与配置**：仅收到同一桥带真值 `zuUp`（当前版本 2）的显示偏好配置后才查询；下行 `zuUpCap/cfgGen` 完成能力握手与回执，未确认的连接零上行字节。显示偏好由桌面 overlay 的 zusage3.* 键与设置面板消费，主进程只发送受限统计投影。
- 油猴脚本的下行契约：①下行数据仍走宿主协议栈借道（`relayProtocol.protocol.send`，seq/ack 全归宿主）；②**永不发送无标记的 rpc 帧**——旁听者无法合法取得远控页面到桌面的方向的发送 seq，裸帧会撞 acceptPayload 严格连续校验（`messageGap` terminal）打挂会话；③上行**仅限**带 `zuUp` 版本标记的帧（配置同步），且仅当宿主下行帧携带 `zuUpCap` 能力确认（补丁钩子在严格校验前消费，官方 ack/水位零接触），未确认能力时零上行字节。远控页面的协议栈不因脚本存在而改变行为（接收侧仍是纯旁听）。
- **上行代际兼容与公告门控**：持久上行钩子有两代——v2 推 `{frame,b,relay}` 外壳（dispatcher/队列），v1 直接推带 `zuUp`/`zuCfg` 的裸帧。消费端识别 v1 裸帧后置 `legacyUplinkSeen`、`lastError="legacy uplink frame ignored"` 并丢弃，**不**把裸帧绑定当前桥、`clientReady` 保持 false；`legacyUplinkSeen` 为真时停发能力公告（`status()`/diag 暴露该标记便于诊断），`disable()`/重开时重置以重新检测。能力公告的上行判据 = 运行时包装成功（`relay.__zusageUplinkDispatcherV2 === relay.acceptPayload`）**或** 持久 v2 注入标记 `globalThis.__zusageRelayUplinkGeneration === 2`（由补丁链注入，本模块只消费）；`acceptPayload` 只读、运行时无法包裹时仅后者可用，两者都没有时不发公告。
- **唯一 UI**：图标、CSS、设置面板、tooltip 和默认/药丸/精简样式直接使用桌面 overlay。油猴脚本仅保留传输适配及可选调试面板，不再复制格样式或设置控件。
- **挂载**：完全沿用桌面输入卡定位、自愈和窄窗规则。移动空态仍用同一条显示等待/不可用并保留设置入口，恢复后遵循已有样式偏好。

## 插件推送开关与油猴脚本入口

- 桌面 ⚙「维护」组新增独立 `mobile` 分区「移动端远程控制」，开关「推送状态栏数据到远控页」与正式版油猴脚本链接均放在此；链接从「关于数据」移除，URL 为 `https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/zusage-mobile.user.js`。共享 overlay 拥有链接展示：沿用现有字段样式，以带中英文标签的只读、可聚焦和选择复制的 URL 输入框呈现，不禁用字段，不新增复制按钮；不自动安装、不打开外链，也不为此发送配置或主进程请求。用户自行复制到远控浏览器的脚本管理器安装。关于数据的「联网边界」说明官方中继、服务端可见载荷、当前会话标识与统计范围、正文/路径/凭据排除项及对宿主远控无影响。
- 开关唯一真值来自运行目录 `config.json`，主进程状态下发 `mobileRelayEnabled`（严格布尔）和 `mobileRelaySupported: true`；旧主进程缺能力字段时控件禁用并提示需完全重启/更新桌面插件，不能显示已保存。前端固定动作 `mobile-relay` 只接受布尔开关值，按现有本地页面与窗口校验；锁内重读，仅合并 `mobile_relay.enabled`，保留其余嵌套/顶层未知键，损坏配置不重建；写后回读必须存在与请求一致的显式布尔值，旧事务助手忽略合并字段时返回失败。写成功后清配置缓存、关闭时撤销目标/递增代际丢弃在途响应并回收中继常驻查询，广播实际状态并回执；写失败回滚控件并提示。快速切换期间控件禁用直到回执，多窗口由状态广播收敛。新行为涉及冷文件 `inject-main.cjs`：旧 loader 必须先安全部署匹配的安装副本与实际加载运行文件，再完全退出并重启 ZCode，才能加载新增动作及模块装配；仅更新浮层或仅重启均不能替代部署。
- 缺字段用户（含旧版缺省开启者）升级后关闭；已有显式 `true` 保持开启、显式 `false` 保持关闭。不开启时仍可访问脚本链接，安装脚本不自动授权推送。共享 overlay 在 `mobileMode` 下保留 `mobile` 导航项与分区 HTML（与桌面一致），但页面上的 `mobileRelayEnabled`/`mobileRelaySupported` 恒为 false：推送开关显示为未勾选且禁用，状态文案提示到桌面「设置 → 维护 → 移动端远程控制」修改，页面不显示桌面当前值；页面上的 change 事件早退，无配置请求或桌面配置写入。
- 远控页面沿用统一桌面 overlay 的设置与移动模式，图标、CSS、控件和空态由共享分片拥有。桌面配置动作仅由可信本地窗口处理，远控页面的显示偏好继续走既有 `zuCfg.prefs`，不新增通用远端配置 RPC。状态轮播沿用共享 overlay 的 `zusage3.rotator2` 偏好，缺省关闭，已有启用状态与配置保留。
- **新旧 loader 混载**：旧冷文件的 `isEnabled` 可能仍使用缺省开启语义，新 `mobile-relay.cjs` 不得仅凭该回调放行。`initMobileRelay()` 创建 relay 时传给 `createMobileRelay(options)` 的 `options.strictOptIn === true` 且 `isEnabled` 确认配置显式开启时才可启用；能力标志缺失或非法时，即使旧回调返回 true 也保持关闭。部署到完全重启前不发能力公告、统计快照或中继查询；先安全部署匹配的新冷文件与热模块，再完全重启，重启后仍只有配置显式 `true` 才启用。

## 上行队列与补丁代际

- 持久中继钩子由统一归档入口 `patch_install.py` 维护，旧的独立补丁脚本 `mobile_relay_patch.py` 已退役。钩子位于宿主 `@zcode/desktop` ESM 主入口 `out/main/index.js`，通过已登记版本指纹或表外唯一结构推导验证 stash 锚点、原始上行回调与 `currentBridge` 路由；未知、重复、混代标记或无法验证的布局不得改写。旧代升级、完整卸载还原及归档文件集、待替换交易细节见 [app.asar 安装规格](asar-install.md)。
- `globalThis.__zusageRelayUplinkQueue` 的新项目是普通 JS 对象 `{frame, b, relay}`，三个字段均为引用而非复制或序列化：`frame` 是原始载荷，`b` 是处理该帧时捕获一次的 `runtime.currentBridge`，`relay` 是该桥当时的 `relayProtocol`。桥缺失时 `b` 为原值（通常是 `undefined`），`relay` 为 `undefined`；relay 缺失也不阻止消费。它们不是桥 ID，也不是 `relay.protocol`。
- `zuUp` 为真时只入队一次并返回 `true`，绝不调用原回调；未标记、假值或空载荷继续调用原回调并原样返回结果。持久 hook 无权限宣布绑定有效：消费者须比较当前存活 stash 的 `b` 与 `b.relayProtocol` 两个对象身份，并拒绝缺失、过期、已降级或不匹配的绑定。
- 旧代队列项目是裸 `frame`，与新对象不兼容；旧热包裹也可能产生裸帧。消费者必须明确识别并安全处理无绑定旧帧，不能将裸帧按当前唯一桥盲目归属。升级顺序是先部署支持新旧队列形态的消费者，再部署持久钩子并完全退出、重启宿主；补丁文件、归档和运行中的进程是不同状态，单纯更新 Python 文件不等于持久钩子生效。
- 持久 v2 在原包装调用外写入 `globalThis.__zusageRelayUplinkGeneration = 2`，早于 `announce` 与任何帧；消费者不必等第一帧即可确认持久钩子代际。该 marker 不替代桥/relay 对象身份校验。已安装的无 marker 旧 v2 仍可识别并移除；`check` 将未标记旧 v2 和可识别的半注入报告为「可升级或补齐」。布局通过校验后，`install` 从原始前缀重建为 marked v2。重复安装幂等；混代、重复 uplink、未知或重复代际 marker 拒绝；remove 对 v1、旧 v2 与 marked v2 均逐字节还原原始资产及安装器尾缀。
- stash 注入机制：`patch_install.py` 的 `MOBILE_RELAY_TARGETS` 登记表（版本、剥去本项目注入后的原始 bundle SHA256、锚点）钉死已验证宿主；锚点形如 `relayProtocol=<relay>,<bridge>.disposeBridge`，在 `relayProtocol=<relay>,` 之后插入逗号表达式，把 `{p: <relay>.protocol, b: <bridge>}` push 进 `globalThis.__zusageRelayStash`，宿主 bundle 其余字节不动，`mobile-relay.cjs` 只消费。ZCode 3.18.1 的 `onRawTransportPayload` 闭包调用 `Fg(ye, ve)`；`Fg` 从 `ye.currentBridge` 取桥，并在桥存在且未降级时调用其 `relayProtocol.acceptPayload(ve)`，桥创建时同一对象及其 relay 被 stash 捕获。表外版本走正则推导（derive）并要求唯一性：必须同时唯一匹配此原始回调及其读取 `currentBridge` 的桥路由函数，不能仅凭回调参数猜测运行时结构；无法验证、歧义或漂移时拒绝打补丁。

## 当前远控目标的信任契约

- 状态所有者是宿主 `mobileTaskView` 与创建该视图的官方 live 桥。主进程发现目标及发送前复验均通过受信任主窗口的 preload `getWebRemoteControlStatus()` 读取状态，要求 `mobileConnected === true`；不再借用渲染端缓存的 DOM 目标。多窗口、外部页面、关闭/导航、禁用、读取失败或目标撤销时拒绝，迟到读取不得恢复已撤销目标。
- `resolveMobileTarget` 要求 stash 中恰有一个官方 live 桥：`readyAnnounced === true`、未 `degraded`/`closed`/`destroyed`，且 `b.relayProtocol.protocol === stash.p`。目标的 `workspacePath` 必须逐字匹配桥；远端 identity 必须是受支持前缀并逐字匹配，缺失身份只允许由明确的本地桥确认。本地桥的 `workspaceIdentity` 可以为 `undefined` 或空串；宿主本地视图可以省略该字段，显式 `null` 或非法类型不通过。
- `remoteSessionId` 是桥路由身份，不是聊天 SID。桥或视图任一方提供它时，双方都必须提供相同的非空字符串。解析结果保留桥对象、relay 对象、protocol 与 `remoteSessionId` 的原始绑定，发现去重、同步 validator 和跨 `await` 后的发送复验均核对它们；发现时在读取宿主状态前先捕获桥绑定，等待期间桥/path/identity/路由变化则丢弃该次状态。同路径同 identity 的新桥、relay/protocol 替换或 `remoteSessionId` 变更也使旧目标失效。
- 宿主 `buildWorkspaceBridge` 创建包含 `kind`/`workspacePath`/`workspaceIdentity`/`remoteSessionId` 的桥；`applyMobileTaskViewUpdate` 已按 epoch、seq、bridgeSessionId、bridgeGeneration、ready 和 workspace 核验视图。renderer 的 `syncWebRemoteControlWorkspaces` 只同步桌面 tabs，而 main 的 `prepareProjectWorkspace` 可创建未出现在 tabs 的动态项目。因此远控目标不再要求存在于 `windowWorkspaces`；本窗 `windowTasks` 对该 task 有明确身份记录且不包含目标身份时仍拒绝。普通桌面 pane 的工作区白名单与 scope 路由保持原规则。
- 接口仍向 relay 传入 `{zm:1,target}`、同步 `validate` 和异步 `verifyTarget`。`verifyTarget` 在读取前后均检查当前目标、唯一受信窗口及 live 桥；`mobileConnected`/task/path/identity/`remoteSessionId` 任一变化都不能发送旧结果。路径、identity 和桥引用只在主进程内使用，不进入下行 wire。
- 回归 `tests/inject-mobile-bridge.test.cjs` 按真实桥 schema 覆盖：不在桌面 tabs 名单中的动态 WSL 项目被接受；错 path/identity、未 ready 或失效桥、多个 live 桥、桥对象/relay/protocol 替换、`remoteSessionId` 缺失/不匹配/变化均拒绝旧目标；发送前 status 变化、在途 task 矛盾或目标撤销不能恢复旧结果。测试同时验证普通桌面 scope 仍受 tabs 工作区名单限制。

## 安装与会话提示

- `patch_install.py` 既有 `install`、`remove`、`check` 是唯一归档维护入口，不新增子命令。完整安装将 loader 和中继钩子合成同一个归档入口，共用一次重打包和替换。SessionStart 发现已有当前 loader 时，仅在中继钩子缺失或可升级时补装。大包构建在共享目标锁外进行，短提交锁内复查 pending 并重验源与 stage，冲突让位、源变化有限重试。普通锁竞争的 hook 最多退避重试一次。`check` 追加只读中继补丁状态，不改变既有 loader 检查与退出语义。
- **锁窗口纪律**：SessionStart 补装的读档、变换、重打包与整包校验全程在共享目标锁外完成；目标锁只包「既有 pending 复查 + 发布前身份复验 + `os.replace`」的短提交。锁序为构建锁 → 目标锁 → marker 锁，三者对补装链都是零等待获取；锁竞争在 hook 链退避重试一次（间隔 1.5 秒；首轮已耗时达到 15 秒不再重试，防顶破 SessionStart 60 秒预算），仍竞争按 `deferred` 上报；显式安装链为单次尝试。构建期间源归档被并发改写（另一进程收尾 pending、宿主重写 asar）时丢弃 stage 并按新源重建一次，二次仍变按 `deferred` 上报。动机：多窗口并发 SessionStart 抢同一把锁、锁内重写 200MB+ asar 长达十几秒，实测（2026-11-21）每轮排定全部空转、提示退化为命令行指引。renderer 桥补装（`renderer_bridge.ensure_deployed`）同款锁窗口模式；受保护目录的 `permission` 标记语义不变。
- 已有 loader 的 SessionStart 由通用归档补装收集渲染桥资产和中继入口的改写。两处都需补齐时共用同一个 stage 和一次归档替换或待替换发布。已有 pending 或 sidecar 时先让位，过期空 journal 仍按既有规则回收。补装保留当前绝对 `file://` loader 路径。
- `mobile_relay.enabled` 只控制插件中继运行及 SessionStart 中继补装提示，不门控安装、升级、卸载、让位或 restart marker。SessionStart 的 `_mobile_pending_notice` 先过门控：提示仅在配置对象内显式布尔 `true` 时允许；缺省、false、非法配置静默，不写 `systemMessage`/`hookSpecificOutput`，不读写 `.mobile-deferred-notice.json`；已有 `systemMessage`/`hookSpecificOutput` 时保留原输出。`pending` 提示已排定并需完全退出收尾；已有待替换操作（含 renderer bridge pending）提示先检查现有操作，仅有记录时不承诺退出即可完成，即使目标锁正被占用，不发出改变其它 loader 或绕过待替换的操作指引；其它 `deferred` 提示运行 `/install-overlay` 后按安装输出收尾，必要时通过 ⚙「重启 ZCode」或从托盘完全退出。`pending` 与等待文案不限频；「尚未就绪」共用一条 24 小时限频记录（运行目录 `.mobile-deferred-notice.json` 记 `lastShownAt`）：读不出按未提醒过处理，宁可重复提醒；写入失败静默。`skipped-error/unknown` 静默，宿主兼容性提示优先。门控不改变显式安装 CLI 输出。
- 门控解析口径同主桥 `mobileEnabled()`（`readCfg()` 的 utf-8 解码 + `JSON.parse`）：别处的非法 UTF-8 字节按替换字符解码、配置仍有效；`NaN`/`Infinity` 字面量或 UTF-8 BOM 使整份配置按损坏处理（视为未开启）。已知差异只影响会话提示，不改补丁安装、让位与标记（清单不承诺穷尽）：Python 侧 `json.loads` 受解释器的整数位数上限与递归深度上限保护，超长整数或超深嵌套会抛错、判未开启，主桥 `JSON.parse` 接受、判开启，阈值随解释器版本与设置变化；顶层 `__proto__` 键的原型链怪癖不对齐；主桥按文件 mtime 缓存配置、到下次读取才生效，门控每次直读，两者可能短暂不一致。
- 边界：中继钩子布局未识别时保留宿主原有中继代码，状态条安装照常完成；hook 的 stdout 保持协议 JSON，安装链的输出一律转到 stderr；本机无可定位客户端（远程会话等）、存在卸载豁免标记或独立安装 `--dry-run` 时不执行补装。
- 分轮收尾：渲染桥补丁与归档安装（loader + 中继钩子）各自排待替换包时，一次完全退出只收尾当轮积压；重启后 SessionStart 再排的新一轮要再完全退出一次才收尾。用户报「已完全退出仍提示补丁未就绪」先按分轮收尾解释并引导再退一次，不误判为收尾失败或安装损坏。「重启 ZCode」按钮的收尾与拉起见 [relaunch-after-pending-asar.md](relaunch-after-pending-asar.md)。
- 重启标记：中继补丁与主归档一同提交时使用含最终 `installation.asar/entryHash` 的 `pending-install` 意图，先写意图再替换，只有实际替换归档（直替成功，或监控完成交换）才写 `publishedAt`；下一次真正启动（`loadedAt` 晚于 `publishedAt`）由 loader ack 销账，与根状态条安装使用同一确认契约，合并进来的 pending-sync hashes 全部热加载也不得提前清除。合并已有 marker 时保留其他字段（如待同步 `hashes`）。历史形态 `installed` + `asarPatch:true`（旧版就地写入留下）只随完全重启销账：`ack_restart` 的热销账路径遇到 `asarPatch:true` 仍强制不销账。已替换归档但 `publishedAt` 写入失败（或进程在两者之间被杀）时保留未确认意图，该标记不会被 ack 销账——与根状态条安装相同的既有窗口。独立链不写插件 marker。`hot_reload:false` 时 `mobile-relay.cjs` 更新仍写 restart hashes。
- 持久钩子在归档写入后不会改变运行中进程已加载的 bundle，需完全退出并重启后生效。未识别中继钩子布局时保留宿主原有中继代码并允许 loader 安装；发现项目标记但无法安全验证还原时，卸载失败并保留归档。

### 中继模块状态所有者

- `mobile-relay.cjs`（主进程热换子模块）：拥有 stash 消费、RPC 序列化（EventFire 最小编码器：`[4(Array) 2 204 <VQL id>] + [5(Object) <VQL len> <JSON>]`）、节流与逐桥推送。暴露 `push(payload, validator, verifier)`、`pump()`、`disable()`、`status()`、`dispose()`；`disable` 撤销查询代际、远控页面的握手与偏好，取消补拍并回收常驻/一次性查询，不发送撤销帧，保留可重新启用的宿主钩子；`dispose` 在此基础上停定时器与清引用，不动 stash（stash 属宿主 bundle）。生产默认不写诊断文件：仅显式注入 `options.diagPath` 时落盘。
- 插件安装同步由 `overlay_install.py` 记录待重启 marker：`hot_reload:false` 时，已同步变更的 `mobile-relay.cjs` 记入 `hashes`；缺省或开启时仍由 loader 热换。同步受保护而未更新的文件不记录。
- `inject-main.cjs`（冷）：拥有远控目标发现和信任验证，将验证后的目标及实时复验器传给 mobile-relay；传入严格 opt-in 能力 `strictOptIn: true`、固定配置动作 `mobile-relay` 与实际状态广播。
- `overlay.js`（src/overlay 分片）是唯一渲染方；显式移动模式只接受受限 mobile 上下文，按目标/绑定隔离缓存与空态，普通桌面身份校验不变。
- 配置：`config.json` 的 `mobile_relay: {"enabled": false}`；仅对象内显式布尔 true 开启。缺省及非法值关闭，不因安装脚本或页面连接自动写 true。

## 验收场景

- AC1 归档补丁：统一 `install`、`check`、`remove` 的行为和回归见 [app.asar 安装验收](asar-install.md#验收)。
- AC2 热换与重启提示：热重载缺省或开启时，`mobile-relay.cjs` 更新由 loader 热换，单独更新不产生 marker；显式 `hot_reload:false` 时，单独更新必须产生含实际文件 hash 的 marker，同步完成后提醒重启，重启确认前不得误销账。受保护未同步的更新不产生该文件的 marker。
- AC3 端到端（实机）：桌面显式开启插件推送并开启远控会话，用装有油猴脚本的浏览器（桌面或手机）打开远控页面，状态条出现且随快照更新；关闭远控后停止渲染新数据，旧快照到期后切为同一桌面条的不可用空态；宿主页面无新增报错。
- AC4 无干扰：对照无脚本/有脚本两种情况，远控会话功能（消息收发、ack、重连）行为一致；官方页面对 EventFire 魔数帧静默丢弃（控制台无 RPC 错误）。
- AC5 未显式启用（含 `mobile_relay.enabled:false`）：无本项目公告、快照或统计查询；安全上行钩子仍消费插件标记帧并忽略，不改变未标记宿主帧。
- AC6 WSL/SSH 查询携带当前目标的远端身份；同 SID 的本地及其他远端记录不得匹配，远端今日量与快照来自同一目标；无法确认身份或目标失败时不展示本地替身。
- AC7 查询在途期间切换 SID、切换身份、撤销目标或关闭功能，旧响应不得发送；常驻及一次性回退均遵循同一身份协议。
- AC8 相同目标的发现轮询不重复触发查询；DB 事件、目标变化与兜底心跳继续驱动更新。多桥身份不确定时不广播私有快照。
- AC9 检查真实编码帧：无其他会话明细、工作区路径、标题、正文及凭据；允许目标所属主机今日、项目聚合中的其他会话贡献，真实工作区身份仅保留在进程内。能力公告不改当前数据。另验本地→WSL→本地只存在桌面状态条，以及旧帧/同 SID 换身份/不可用时不继承旧 today 或速度历史。
- AC10 远控页面加载内嵌的同一桌面 overlay，状态条、tooltip、设置、样式和空态均来自桌面分片；不得复活独立 chips 回退 UI。显示偏好只影响浏览器及既有配置上行，不能通过远控页面请求修改桌面配置；轮播默认关闭并保留已有偏好。
- AC11 桌面 ⚙「维护 → 移动端远程控制」中英文均有正式脚本 URL 输入框，带本地化 aria-label、readonly 且不 disabled，开关关闭或主进程不支持开关时仍可聚焦选择复制；无安装/复制按钮，点击字段不调用 preload、window.open、剪贴板或主进程请求。关于数据不再有此字段，联网边界包含中继披露；正式/调试产物与元数据地址由构建回归校验。
- AC12 缺配置、缺 enabled、false、null、字符串、数字、数组均不发公告/快照且无中继查询；显式 true 才公告，收到可信的页面偏好并确认目标后查询。关闭时在途响应丢弃；快速关开不能复活旧查询，关闭期间由持久 asar 钩子排入的偏好也必须在新启用代丢弃，重新握手后才能推送；同一宿主 bridge 跨模块 dispose/create 热换后，新实例接管已有安全上行钩子，不能被旧实例的关闭状态永久吞掉，重复热换不累计包装层。无新增发给远控页面的撤销帧，未标记宿主帧照常交还宿主。
- AC13 本地面板通过固定动作保存布尔开关，锁内保留最新顶层及 mobile_relay 未知字段，失败保留原文件/回滚勾选；主进程广播使多窗口一致。缺能力字段的旧主进程上控件禁用提示重启/升级，远控页面不能修改桌面开关，伪造远端配置动作不能通过本地窗口校验。
- AC14 新 relay 与旧冷 loader 混载：`strictOptIn` 缺失、false 或非布尔值时，即使 `isEnabled` 返回 true，也无能力公告、快照与中继统计查询；匹配新 loader 的 `strictOptIn: true` 加显式配置 true 才能握手。远控页面的 `mobileMode` 保留 mobile 导航与分区 HTML；enabled/supported 均为 false，开关未勾选且禁用，状态文案为页面只读提示而非「重启/升级桌面插件」，change 不产生配置请求。
- AC15 整桥隔离回归 `tests/inject-mobile-bridge.test.cjs`：一个可信 app.asar 主窗与 `data:`、外部网页或 resources 外 `file:` 辅助窗共存时，不论枚举顺序，目标发现、实时 validate 与发送复验均成功且不执行辅助窗脚本；仅辅助窗时不发现目标。在途发现与发送复验期间新增辅助窗仍接受当前目标，新增第二个可信主窗则拒绝；既有多可信主窗拒绝测试继续通过。
- AC16 本地目标空闲（无 DB 事件）时由 10s 数据心跳驱动 pump，配合 15s 内容去重，连续成功帧间隔始终 <30s（最坏 25s）；DB 事件紧邻 tick 的相位也不产生 >30s 间隔；dataTimer 只驱动本地目标（`workspaceIdentity` 为空），remoteTimer 按 `poll_ms` 处理远端周期刷新；`bridgeTimer` 的 30s 桥维护独立触发兜底查询，即使远端 `poll_ms=60000` 且尚未到期也能触发。两者都经过查询节流。回归 `tests/mobile-relay-remote.test.cjs`。
- AC17 中继请求带 `lean: true`：默认 serve/桌面 json 仍带 `speed_history`、`all_projects`、`speed_days`、`worktrees`、`compactions` 和 `peak`，lean 请求省略这六个字段（仅显式布尔 true 生效）；`ZUSAGE_REMOTE_CHILD=1` 远端子查询契约不变。回归 `tests/mobile-relay-projection.test.cjs`、`tests/test_speed_history.py`、`tests/test_all_projects_usage.py`。
- AC18 v1 裸上行帧（无 `{frame,b,relay}` 外壳、直接带 `zuUp`/`zuCfg`）：不发能力公告、`clientReady` 保持 false、`status().legacyUplinkSeen` 与 `lastError` 可诊断；`acceptPayload` 只读但 `globalThis.__zusageRelayUplinkGeneration === 2` 时公告恢复发送；只读且无标记时不发公告。
- AC19 诊断默认零写盘（未注入 `diagPath` 时 `fs.writeFileSync` 不被调用），显式 `diagPath` 仍写；常驻查询连续 3 次 <30s 失败后进入 60s 冷却走一次性 `json`，冷却到期重新 spawn `serve`，单次成功回包不清零失败计数。
- AC20 已有 loader 的 SessionStart 同时缺桥和中继时只重打包一次，产物同时含两项改写。遇到已有待替换操作时让位，归档变更时重新验证。见 `tests/test_mobile_relay_install.py`。
- AC21 提示门控与行为分离：配置缺省、false、非布尔或损坏时 SessionStart 中继补装提示静默且不读写限频文件；显式 true 时按 pending / 已有操作 / 其它 deferred 分流。两种状态下归档补丁、让位及 restart marker 行为相同，显式 CLI 不受门控。对应 `test_mobile_relay_install.py` 的提示门控测试与 hook 提示回归。
- AC22 `globalThis.__zusageRelayUplinkQueue` 的新对象携带捕获的 bridge/relay 引用，旧裸帧不得猜绑当前 bridge；旧 v1、旧 v2、marked v2 升级与逐字节移除兼容，重复/混代/未知 marker fail-closed。以 `tests/test_mobile_relay_patch.py` 夹具执行测试验证，持久钩子真实生效仍需完全重启后的实机验收。
- 待实机验证：油猴脚本能否捕获页面 WebSocket，iOS 上脚本管理器是否兼容。调试版可辅助观察 Worker 创建，零接收帧无法判定连接来源。
