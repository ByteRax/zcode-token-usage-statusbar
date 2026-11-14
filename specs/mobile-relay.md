# 手机远控中继（mobile relay）

## 产品规则

- 目标行为：宿主「Web 远程控制」会话活跃时，向远控浏览器推送目标专属数值快照，由接收脚本调用桌面同一份 `overlay.js` 渲染。本地、WSL、SSH 使用同一状态条、tooltip、设置与挂载代码，不再渲染独立 chips 回退条；完整契约见 [统一桌面状态条](mobile-unified-overlay.md)。
- 数据通道复用宿主官方中继（`wss://zcode.z.ai/api/v1/remote/ws2`，rpc-frame 信封）。本项目不新增自有服务器、不自建 WebSocket：发送必须经 `webRemoteControlManager` 桥接运行时的 `relayProtocol.protocol.send()`（AcknowledgedRelayProtocol 的唯一合法入口，seq/messageSeq/ack/降级语义全部归宿主协议栈），绝不直接写 relay socket——绕过 acknowledged 协议的裸帧会破坏手机端 ack 水位与 `rpc-frame-gap` 检测，可能触发 `bridge-degraded` 打挂用户远控会话。
- wire 载荷形态：RPC `EventFire` 帧（ResponseType 204），id 恒为魔数 `2147483647`（2^31−1；官方 ChannelClient 的 id 从 0 递增，不会碰撞；即使碰撞，载荷带 `zm` 标记由消费端校验）。官方页面 `ChannelClient.onResponse` 对未知 id 静默丢弃（`handlers.get(id)?.(response)`），对宿主页面零干扰——这是选 EventFire 而非自定义 zcode_type 的依据。
- 下行包含目标专属数值投影 `snap` 与随机匿名 `binding`，本地和远端格式一致；不携带真实工作区身份/路径/标题/正文。远端今日统计只取该目标的 `remote_today`。快照超限先裁可选明细，仍超限发目标不可用帧，不改变 scopeKind 或切换渲染器。宿主物理分片按连接、bridgeSessionId、seq 重组，过期残片清除。
- 展示口径、单位、档色、格顺序和 tooltip 均由桌面 overlay 源码负责；主进程不维护第二套格式化函数。真实零值与缺字段分开，缺数据在同一桌面 UI 显示等待或不可用状态。
- 接收端构建时内嵌与桌面分片构建逐字节相同的 overlay，不再从 CDN main 异步加载另一代代码。
- **目标会话身份（唯一来源）**：主进程经可信唯一桌面窗口的 preload `getWebRemoteControlStatus()` 读取 mobileConnected/mobileTaskView，并与唯一官方 ready live 桥的 path、identity、remoteSessionId 及对象代次联合验证。宿主已验证的动态远控项目无需出现在桌面打开标签名单中；任务证据明确矛盾时仍拒绝。目标撤销后不发新查询；页面切换时桌面移动上下文不得将旧统计套给新 SID。
  - `mobileViewState.activeTaskId` 只是导航位置（可能停留在上次会话），**不得**作为当前会话兜底；URL 的 `sid=d_…` 是 `deviceSid`，`remoteSessionId` 是 bridge/source 路由键，两者都不是聊天会话 ID。
  - 主进程按 taskId 与 workspaceIdentity 精确查询和匹配。不能按目录、标题或最近活跃猜目标；发送前重新读取宿主状态并验证桥/relay/protocol对象及路由。真实身份仅用于进程内验证，wire 以随机 binding 隔离同 SID 不同身份。
  - 查询在途发生目标、身份、桥代次变化或撤销时丢弃旧结果；新目标失败发送其专属 unavailable 帧，清除旧显示。能力公告仅更新握手，不能更改数据新鲜度或恢复旧快照。
  - 远端数据库变化不能触发本地文件监听，远端目标单独周期查询；间隔尊重远端 `poll_ms` 与本地限频，不与 1.5 秒目标发现轮询耦合。能力公告只在已确认持久上行钩子或运行时包裹成功时发送。
  - `__zusageMobileChips` 是桌面旧采集兼容字段；当前手机目标发现直接读取宿主状态，不以 DOM chips 或桌面当前焦点作为目标来源。
- 推送节奏与去重：查询走**常驻** `zusage.py serve`（JSON 行协议，单次 5~20ms，空闲 60s 回收；早退 3 次回退一次性 spawn）。内容去重键不含 ts（未变即跳过），内容不变仍以 `HEARTBEAT_MS`（15s）放行心跳——消费端以载荷 ts 与接收时刻中更早者起算，超过 30s 切为同一桌面条的不可用空态；能力公告不能续期。无活跃桥（stash 空）时零查询零流量；桥的活跃判定为 `!bridge.degraded && bridge.relayProtocol` 仍指向 stash 里的实例，失效即剪枝。
- 目标发现节奏：inject-main 独立 1.5s 泵读取宿主当前远控状态，不查数据库；同目标不重复查询，DB事件/远端周期/兜底心跳驱动统计刷新。inject-main 是冷文件，更新后须完全重启生效。
- 数据时效边界：用量库只在**请求完成**时落行，生成中手机端 chip 不会逐字跳动（桌面端生成中的 t/s 估算来自渲染桥实时数据，不属于本链路）；这是数据源口径，不是推送延迟。
- 多窗口/多桥：只向能可靠归属当前手机目标的桥发送；归属歧义时停止数据推送，不将同一快照广播给其他连接。
- **隐私契约**：启用本功能时统计数据经宿主官方中继转发，rpc-frame 层无端到端加密，服务器可见载荷。下行仅保留目标会话渲染所需的统计与身份绑定，不携带工作区路径、其他会话、正文或凭据；上行仅携带显示偏好和代际计数。`mobile_relay.enabled: false` 显式关闭（缺省视为 true），关闭期间不发公告或快照，已在途查询结果丢弃。
- **门控与配置**：仅收到同一桥的 `zuUp:2` 显示偏好配置后才查询；下行 `zuUpCap/cfgGen` 完成能力握手与回执，未确认的连接零上行字节。显示偏好由桌面 overlay 的 zusage3.* 键与设置面板消费，主进程只发送受限统计投影。DB watcher、activity_min_ms 限频及30s兜底心跳保持；远端无本地写入时按其poll_ms刷新。
- 油猴脚本的下行契约：①下行数据仍走宿主协议栈借道（`relayProtocol.protocol.send`，seq/ack 全归宿主）；②**永不发送无标记的 rpc 帧**——旁听者无法合法取得手机→桌面方向的发送 seq，裸帧会撞 acceptPayload 严格连续校验（`messageGap` terminal）打挂会话；③上行**仅限**带 `zuUp` 版本标记的帧（配置同步），且仅当宿主下行帧携带 `zuUpCap` 能力确认（补丁钩子在严格校验前消费，官方 ack/水位零接触），未确认能力时零上行字节。手机页协议栈不因脚本存在而改变行为（接收侧仍是纯旁听）。
- **唯一 UI**：图标、CSS、设置面板、tooltip 和默认/药丸/精简样式直接使用桌面 overlay。手机仅保留传输适配及可选调试面板，不再复制格样式或设置控件。
- **挂载**：完全沿用桌面输入卡定位、自愈和窄窗规则。移动空态仍用同一条显示等待/不可用并保留设置入口，恢复后遵循已有样式偏好。

## 状态所有者与接口

- `mobile_relay_patch.py`（共享分发文件）：拥有 app.asar 主 bundle（`out/main/index.js`）的 stash 注入。登记表 `MOBILE_RELAY_TARGETS` 钉死（版本, 原始 sha256, 锚点, 注入表达式）；锚点为 `relayProtocol=<sym>,<bridgeSym>.disposeBridge=`（3.18.1 实测唯一），在赋值后插入逗号表达式把 `{p: <relay>.protocol, b: <bridge>}` push 进 `globalThis.__zusageRelayStash`。机制镜像 `renderer_bridge.py`：剥 patch_install 注入尾缀后按原始前缀 SHA256 校验、表外版本走正则推导（derive）并严格唯一性校验、asar 重写重算 integrity、锁内临时文件原子替换、restore 反向还原。自检/状态输出与 renderer_bridge 同构，供安装链与诊断消费。
- `mobile-relay.cjs`（主进程热换子模块，第 7 个）：拥有 stash 消费、RPC 序列化（EventFire 最小编码器：`[4(Array) 2 204 <VQL id>] + [5(Object) <VQL len> <JSON>]`）、节流与逐桥推送。暴露 `push(payloadObj)`、`status()`、`dispose()`；`dispose` 只停定时器与清引用，不动 stash（stash 属宿主 bundle）。
- 插件安装同步由 `overlay_install.py` 记录待重启 marker：`hot_reload` 显式为 `false` 时，已同步变更的 `mobile-relay.cjs` 必须写入 marker 的 `hashes`，由既有提醒和 loader 确认机制消费；同步被保护而未更新的文件不记录。热重载缺省或开启时，单独更新该模块不因本规则创建 marker，仍由 loader 热换；其他文件的 marker 规则不变。
- inject-main.cjs（冷）：拥有手机目标发现和信任验证，将验证后的目标及实时复验器传给 mobile-relay；热换列表含 mobile-relay。
- overlay.js（src/overlay 分片）：唯一渲染方，显式移动模式只接受受限 mobile 上下文，按目标/绑定隔离缓存与空态；普通桌面身份校验不变。
- 配置：`config.json` 新增 `mobile_relay: {"enabled": true}`（三态：缺省/true 开，显式 false 关，非布尔异常值按缺省开并诊断计数——沿用 `quota_enabled` 方向）。

## 验收场景

- AC1 已打补丁的 3.18.1：`python3 -B -m unittest tests.test_mobile_relay_patch` 以夹具 asar 验证 apply/check/remove 往返、原始前缀 SHA 漂移拒绝、锚点缺失/重复拒绝、注入尾缀两种形态兼容。
- AC2 热换与重启提示：热重载缺省或开启时，`mobile-relay.cjs` 更新由 loader 热换，单独更新不产生 marker；显式 `hot_reload:false` 时，单独更新必须产生含实际文件 hash 的 marker，同步完成后提醒重启，重启确认前不得误销账。受保护未同步的更新不产生该文件的 marker。
- AC3 端到端（实机）：桌面开启远控会话，浏览器（桌面或手机）带油猴脚本打开远控页，状态条出现且随快照更新；关闭远控后脚本显示「无活跃桥」并停止渲染新数据；宿主页面无新增报错。
- AC4 无干扰：对照无脚本/有脚本两种情况，远控会话功能（消息收发、ack、重连）行为一致；官方页面对 EventFire 魔数帧静默丢弃（控制台无 RPC 错误）。
- AC5 显式 `mobile_relay.enabled:false`：主进程不注册 stash 消费（或收到 chips 不发送），中继零本项目帧。
- AC6 WSL/SSH 查询携带当前目标的远端身份；同 SID 的本地及其他远端记录不得匹配，远端今日量与快照来自同一目标；无法确认身份或目标失败时不展示本地替身。
- AC7 查询在途期间切换 SID、切换身份、撤销目标或关闭功能，旧响应不得发送；常驻及一次性回退均遵循同一身份协议。
- AC8 相同目标的发现轮询不重复触发查询；DB 事件、目标变化与兜底心跳继续驱动更新。多桥身份不确定时不广播私有快照。
- AC9 检查真实编码帧：无其它会话、工作区路径、正文及凭据；能力公告不改当前数据。另验本地→WSL→本地只存在桌面状态条，以及旧帧/同SID换身份/不可用时不继承旧today或速度历史。
- 待实机验证项：油猴脚本在远控页的 WebSocket 是否创建于页面主线程（若在 Worker 内则 v0 抓不到帧，需扩展 Worker 劫持——调试面板帧计数为 0 即为该信号）；iOS 端脚本管理器兼容性。
