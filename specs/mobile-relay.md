# 手机远控中继（mobile relay）

## 产品规则

- 目标行为：宿主「Web 远程控制」会话活跃时，把与桌面状态条同源的用量 chips 推送到远控页面所在浏览器，由油猴脚本（`docs/zusage-mobile.user.js`——**编译产物**：手机特有逻辑在 `src/mobile/` 分片，「照抄桌面」内容构建期从桌面分片锚点提取，见 specs/mobile-userscript-build.md）解码并渲染悬浮条——手机/桌面浏览器打开 `zcode.z.ai/remote/*` 均可显示。
- 数据通道复用宿主官方中继（`wss://zcode.z.ai/api/v1/remote/ws2`，rpc-frame 信封）。本项目不新增自有服务器、不自建 WebSocket：发送必须经 `webRemoteControlManager` 桥接运行时的 `relayProtocol.protocol.send()`（AcknowledgedRelayProtocol 的唯一合法入口，seq/messageSeq/ack/降级语义全部归宿主协议栈），绝不直接写 relay socket——绕过 acknowledged 协议的裸帧会破坏手机端 ack 水位与 `rpc-frame-gap` 检测，可能触发 `bridge-degraded` 打挂用户远控会话。
- wire 载荷形态：RPC `EventFire` 帧（ResponseType 204），id 恒为魔数 `2147483647`（2^31−1；官方 ChannelClient 的 id 从 0 递增，不会碰撞；即使碰撞，载荷带 `zm` 标记由消费端校验）。官方页面 `ChannelClient.onResponse` 对未知 id 静默丢弃（`handlers.get(id)?.(response)`），对宿主页面零干扰——这是选 EventFire 而非自定义 zcode_type 的依据。
- 载荷是**与桌面状态条同口径的 chips**：桌面恰好打开目标会话时直接用渲染端 DOM 采集的 chips（`overlay.js` 13 分片，逐字一致，含 ⚙ 显隐配置、进位、色阶）；桌面没打开该会话时由 `mobile-relay.cjs` 按 `zusage.py json` 的会话记录做**同口径**格式化（万/亿进位、TPS_BANDS 档位、同序 chip）。载荷单消息超 `maxPhysicalFrameBytes`（≈256KB）时由宿主 AcknowledgedRelayProtocol 拆多分片，油猴脚本按 `bridgeSessionId+seq` 重组（0.4.1 起；`fragmentCount===1` 直通），集齐前不渲染，>60s 残片丢弃防泄漏。
- **速度主数字口径（与桌面 v298 逐字对齐）**：chip 主数字 = **最后一轮真实速度**（会话记录 `last.tps`，缺失/为 0 时回退 `avg_tps`），档色按 `TPS_BANDS`；**会话加权平均 `avg_tps` 只进 tooltip detail**（`最近一段 X t/s · 会话均 Y t/s · Σ输出÷Σ生成窗口`）。桌面 `11-instance-toolbar-chips.js:423` 的 compact chip 与 `02-store-bridge-and-speed-v2.js:600` 的 v298 注释是同一条契约；曾把 `avg_tps` 当主数字推送，实机对照桌面 355t/s vs 手机 157.2t/s 不一致，由 `tests/mobile-relay-chips.test.cjs` 锁定。
- chip 顺序与桌面一致：速度、本轮（`last_turn.total`+次）、会话（`total`+轮+次）、今日（`today`+轮+次）、项目（`project.total`+会话+次）、工具（`tool_calls`）；无数据项不渲染，不伪造 0。
- **目标会话身份（v2，唯一来源）**：远控页面正在查看的会话由宿主报告，渲染端通过 preload 只读接口 `window.zcode.getWebRemoteControlStatus()` 读取 `mobileConnected` 与 `mobileTaskView`。`mobileTaskView` 是宿主校验过连接代次、bridge、工作区归属后的**当前可见任务**，其 `taskId` 在本地工作区即聊天 `sessionId`（宿主 adapter 恢复任务时 `sessionId: taskId`）。页面隐藏、回首页、聊天被遮盖、切换工作区时宿主会撤销该字段（null），此时**不推送新数据、不清空手机端上次显示**，也不回退到桌面会话或其它会话。
  - `mobileViewState.activeTaskId` 只是导航位置（可能停留在上次会话），**不得**作为当前会话兜底；URL 的 `sid=d_…` 是 `deviceSid`，`remoteSessionId` 是 bridge/source 路由键，两者都不是聊天会话 ID。
  - 渲染端把 `target = {taskId, workspacePath, workspaceIdentity}` 随 chips 一起写 `window.__zusageMobileChips`；若桌面恰好打开同一会话（`bySession[taskId]` 有值），主进程直接推送该 DOM chips（与桌面逐字一致）；否则主进程按**精确 taskId** 调 `zusage.py json <sid>`，从返回的 `recent` 中取该 sid 的记录格式化推送。**禁止**按目录、标题、最近活跃等启发式猜会话（本条是 v2 对 v1 的破坏性修正）。
  - **DOM 快路径的采集规范化（v346 实机回归）**：桌面 `.it` 的 `textContent` 不能直推——①子代理格（`.zu-sub`）是裸数字无标签，且查询路径不产出该格，采集时跳过；②工具格是 `<span class=v>717</span><span class=eb>15</span>`，直拼成 `71715`，采集只取 `.v` 作数值、错误数写进 detail；③速度档位从后代类名（`zu-teal`/`zu-azure`…）映射为 `band`，`.it` 无 ok/warn 类时**不带 tone**（旧实现兜底 `mute` 会把整条状态条渲染成灰色）。消费端颜色优先级：`band` > `tone` > 默认前景色。
- 推送节奏与去重：查询走**常驻** `zusage.py serve`（JSON 行协议，单次 5~20ms，空闲 60s 回收；早退 3 次回退一次性 spawn）。内容去重键不含 ts（未变即跳过），内容不变仍以 `HEARTBEAT_MS`（15s）放行心跳——消费端以「载荷 `ts` 超 30s」标灰。无活跃桥（stash 空）时零查询零流量；桥的活跃判定为 `!bridge.degraded && bridge.relayProtocol` 仍指向 stash 里的实例，失效即剪枝。
- 目标发现节奏：`inject-main.cjs` 另有 **1.5s 手机专属泵**（只读 `window.__zusageMobileChips`，不查库、不碰主泵状态）；主泵自身只在桌面请求/DB 水位变化或 30s 兜底心跳时运行，远控页在手机上切换会话通常不产生 DB 写入，缺独立泵时目标变更最坏要等 30s（冷文件，需完全重启生效）。
- 数据时效边界：用量库只在**请求完成**时落行，生成中手机端 chip 不会逐字跳动（桌面端生成中的 t/s 估算来自渲染桥实时数据，不属于本链路）；这是数据源口径，不是推送延迟。
- 多窗口/多桥：逐桥独立推送（同载荷）；按 `workspaceIdentity` 过滤是后续增强，首版全量。
- **隐私契约（破坏性变更，v2 起；v346 增补上行）**：启用本功能时用量 chips 经宿主官方中继转发，中继链路 rpc-frame 层无加密（已核实 `web-remote-control-rpc-transport.ts` 及主 bundle 无加密符号），服务器可见载荷内容。README/用户指南必须披露；载荷默认不含路径、会话正文、凭据，仅含格式化后的用量/额度/速度/占比字符串与时间戳。v346 起上行（手机→桌面配置同步）载荷仅含 prefs 布尔值与 gen 计数，经同一中继、同受服务器可见性约束。`mobile_relay.enabled: false` 显式关闭（缺省视为 true）。
- 【v346 触发模型与门控，与桌面一致】①**频率同桌面**：桌面 `fs.watch` 监听 DB（300ms 去抖）→ 主泵查询推送 + 30s 兜底心跳；手机侧改同款——`inject-main` 的同一 DB watcher 去抖回调调 `mobileRelay.pump()`，`FALLBACK_HEARTBEAT_MS`(30s) 兜底，查询/推送限频 = `config.activity_min_ms`（与桌面**同一配置项**，缺省 1500ms、下限 300ms；由 inject-main 创建 mobile-relay 时注入，改一处两端一致），未满足补一拍；**取消 mobile-relay 自身的 1.5s 轮回**。②**消费门控**：只有手机端通过上行配置（`zuUp` 帧）报到后才开始查库推送（`clientReady`）；单纯建立远控通道不推，避免无消费者盲推。③**配置生效**：手机端在 overlay ⚙ 面板的显示偏好（`zusage3.show` 等）经上行同步，桌面按 `show` 裁剪 chips（`speed`/`quota` 恒保留，缺键全开，配置损坏 fail-open 不裁）。上行帧形态 `{zcode_type:"rpc-frame",zuUp:2,zuCfg:{gen,prefs}}`，桌面下行帧带 `zuUpCap`/`cfgGen` 完成握手与回执；宿主钩子（asar 持久层 + mobile-relay 热修层双保险）在严格 seq 校验前消费该帧。③**不新增设置项**：手机端完全复用桌面 overlay 的 ⚙ 设置面板（同一份 overlay.js），不再额外注入任何开关块。
- 油猴脚本的下行契约：①下行数据仍走宿主协议栈借道（`relayProtocol.protocol.send`，seq/ack 全归宿主）；②**永不发送无标记的 rpc 帧**——旁听者无法合法取得手机→桌面方向的发送 seq，裸帧会撞 acceptPayload 严格连续校验（`messageGap` terminal）打挂会话；③上行**仅限**带 `zuUp` 版本标记的帧（配置同步），且仅当宿主下行帧携带 `zuUpCap` 能力确认（补丁钩子在严格校验前消费，官方 ack/水位零接触），未确认能力时零上行字节。手机页协议栈不因脚本存在而改变行为（接收侧仍是纯旁听）。
- **样式复用桌面（0.2.4）**：手机端不再自造样式——chips 按桌面 DOM 拆 `{v 主值, dim 后缀, err}` 下发（DOM 采集与查询路径同构），渲染用桌面同一套类名（`.it/.k/.v/.dim/.sep/.eb/.zu-gear`），CSS 逐条照抄 `06-instance-dom-and-styles.js` 的规则（仅选择器限定 `.zm-root` 下）；浅色跟随宿主 CSS 变量，档位色按页面底色亮度挂 `.zm-light` 切桌面亮色主题深色值。「状态栏显示」勾选存 `prefs.show`（缺省全开）。
- **挂载形态（镜像桌面 in-card）**：优先把状态条插进**输入卡内部**——从 `[data-testid="chat-input"]`/`textarea` 向上找「有圆角（≥8px）+ 有表面（背景或边框）+ 内含按钮」的最近祖先作为输入卡（远控页没有稳定卡类名），追加为其最后一个子节点，等价桌面 `mountInCard()` 的「工具行之后」；样式按桌面计算值对齐（14px 系统无衬线、格内 2px 7px + 5px 间距、space-between、1px×15px 分隔线、标签 dim/数值 600、速度取 TPS_BANDS 档色）。找不到卡退回 `[data-v4-composer-dock-content]`（卡片下方），再退回 body 级 fixed 悬浮。React 重渲染会摘掉注入节点，脚本每 2s 重挂。

## 状态所有者与接口

- `mobile_relay_patch.py`（共享分发文件）：拥有 app.asar 主 bundle（`out/main/index.js`）的 stash 注入。登记表 `MOBILE_RELAY_TARGETS` 钉死（版本, 原始 sha256, 锚点, 注入表达式）；锚点为 `relayProtocol=<sym>,<bridgeSym>.disposeBridge=`（3.18.1 实测唯一），在赋值后插入逗号表达式把 `{p: <relay>.protocol, b: <bridge>}` push 进 `globalThis.__zusageRelayStash`。机制镜像 `renderer_bridge.py`：剥 patch_install 注入尾缀后按原始前缀 SHA256 校验、表外版本走正则推导（derive）并严格唯一性校验、asar 重写重算 integrity、锁内临时文件原子替换、restore 反向还原。自检/状态输出与 renderer_bridge 同构，供安装链与诊断消费。
- `mobile-relay.cjs`（主进程热换子模块，第 7 个）：拥有 stash 消费、RPC 序列化（EventFire 最小编码器：`[4(Array) 2 204 <VQL id>] + [5(Object) <VQL len> <JSON>]`）、节流与逐桥推送。暴露 `push(payloadObj)`、`status()`、`dispose()`；`dispose` 只停定时器与清引用，不动 stash（stash 属宿主 bundle）。
- `inject-main.cjs`（冷）：`ipcMain.on("zusage:mobile-chips")`（校验 sender 为已知 window webContents、载荷 ≤ 512KB、结构白名单后转 `mobileRelay.push`）+ 热换循环名单新增 `mobile-relay.cjs`。
- `overlay.js`（渲染端，分片 `src/overlay/`）：快照更新回调里新增 chips 格式化与上报（复用既有格式化函数；`mobile_relay.enabled === false` 时不上报）。
- 配置：`config.json` 新增 `mobile_relay: {"enabled": true}`（三态：缺省/true 开，显式 false 关，非布尔异常值按缺省开并诊断计数——沿用 `quota_enabled` 方向）。

## 验收场景

- AC1 已打补丁的 3.18.1：`python3 -B -m unittest tests.test_mobile_relay_patch` 以夹具 asar 验证 apply/check/remove 往返、原始前缀 SHA 漂移拒绝、锚点缺失/重复拒绝、注入尾缀两种形态兼容。
- AC2 热换：`mobile-relay.cjs` 部署后一个热 tick 内热换生效（marker 销账），无需重启。
- AC3 端到端（实机）：桌面开启远控会话，浏览器（桌面或手机）带油猴脚本打开远控页，状态条出现且随快照更新；关闭远控后脚本显示「无活跃桥」并停止渲染新数据；宿主页面无新增报错。
- AC4 无干扰：对照无脚本/有脚本两种情况，远控会话功能（消息收发、ack、重连）行为一致；官方页面对 EventFire 魔数帧静默丢弃（控制台无 RPC 错误）。
- AC5 显式 `mobile_relay.enabled:false`：主进程不注册 stash 消费（或收到 chips 不发送），中继零本项目帧。
- 待实机验证项：油猴脚本在远控页的 WebSocket 是否创建于页面主线程（若在 Worker 内则 v0 抓不到帧，需扩展 Worker 劫持——调试面板帧计数为 0 即为该信号）；iOS 端脚本管理器兼容性。
