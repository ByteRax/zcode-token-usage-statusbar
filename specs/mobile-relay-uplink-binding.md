# 手机中继上行与目标绑定

## 目标与边界

`mobile_relay_patch.py` 持久 asar hook 在宿主严格序列校验前消费带真值 `zuUp` 的上行帧，同时记录产生该帧的桥身份；未标记帧原样进入宿主回调。持久补丁负责上行来源绑定，`inject-main.cjs` 负责将手机当前目标绑定到同一官方 live 桥；不改变普通桌面 pane 的身份白名单、手机脚本或能力公告。统一 UI 的产品规则见 [mobile-unified-overlay.md](mobile-unified-overlay.md)。

ZCode 3.18.1 的 `onRawTransportPayload` 闭包调用 `Fg(ye, ve)`；`Fg` 从 `ye.currentBridge` 取桥，并在桥存在且未降级时调用其 `relayProtocol.acceptPayload(ve)`。桥创建时同一对象及其 relay 被 stash 捕获。该路径按登记版本的原始 bundle SHA 校验；表外推导必须同时唯一匹配此原始回调和对应的桥路由函数形态，不能仅凭回调参数猜测运行时结构。无法验证、歧义或漂移时拒绝打补丁。

## 队列契约

- `globalThis.__zusageRelayUplinkQueue` 的新项目是普通 JS 对象 `{frame, b, relay}`，三个字段均为引用而非复制或序列化：`frame` 是原始载荷，`b` 是处理该帧时捕获一次的 `runtime.currentBridge`，`relay` 是该桥当时的 `relayProtocol`。桥缺失时 `b` 为原值（通常是 `undefined`），`relay` 为 `undefined`；relay 缺失也不阻止消费。它们不是桥 ID、不是 `relay.protocol`。
- `zuUp` 为真时只入队一次并返回 `true`，绝不调用原回调；未标记、假值或空载荷继续调用原回调并原样返回结果。持久 hook 无权限宣布绑定有效：消费者须对比当前存活 stash 的 `b` 与 `b.relayProtocol` 两个对象身份，并在消费时拒绝缺失、过期、已降级或不匹配的绑定。
- 旧代队列项目是裸 `frame`，与新对象不兼容；旧热包裹也可能产生裸帧。消费者升级必须明确识别两种形态并安全处理无绑定旧帧，不能将裸帧按当前唯一桥盲目归属。先升级支持新协议的消费者，再部署新持久补丁并完全重启宿主；存量队列可能混合两代。补丁文件、asar 和运行中的进程是不同状态，单纯更新 Python 文件不等于补丁生效。
- 持久 v2 在 `onRawTransportPayload` 的属性值（原包装调用）外包一层逗号表达式写入 `globalThis.__zusageRelayUplinkGeneration = 2`，在 transport options 构造时求值——早于 `announce` 与任何帧，消费者不必等第一帧即可确认持久钩子代际。该 marker 只由持久 asar 补丁写入，不替代桥/relay 的对象身份校验。
- 已安装的无 marker 旧 v2 仍按 `uplink_generation=2` 识别并可剥离；`check` 增加 `marked` 布尔字段区分新旧两代（`status`/`stash`/`uplink`/`uplink_generation` 字段语义不变），旧 v2 仍报告 `patched`。下一次 apply 从剥离后的原始前缀重建，因此会把旧 v2 原地升级为 marked v2；重复 apply 幂等。
- 混代、重复 uplink、未知或重复代际 marker 一律拒绝，不得当成可剥离的补丁。`remove` 对 v1、旧 v2 与 marked v2 都能逐字节还原原始资产与安装器注入尾缀；重复 `remove` 幂等。

## 手机当前目标的信任契约

- 状态所有者是宿主 `mobileTaskView` 与创建该视图的官方 live 桥。主进程发现目标及发送前复验均通过受信任主窗口的 preload `getWebRemoteControlStatus()` 读取状态，要求 `mobileConnected === true`；不再借用渲染端缓存的 DOM 目标。多窗口、外部页面、关闭/导航、禁用、读取失败或目标撤销时拒绝，迟到读取不得恢复已撤销目标。
- `resolveMobileTarget` 要求 stash 中恰有一个官方 live 桥：`readyAnnounced === true`、未 `degraded`/`closed`/`destroyed`，且 `b.relayProtocol.protocol === stash.p`。目标的 `workspacePath` 必须逐字匹配桥；远端 identity 必须是受支持前缀并逐字匹配，缺失身份只允许由明确的本地桥确认。本地桥的 `workspaceIdentity` 可以为 `undefined` 或空串；宿主本地视图可以省略该字段，显式 `null` 或非法类型不通过。
- `remoteSessionId` 是桥路由身份，不是聊天 SID。桥或视图任一方提供它时，双方都必须提供相同的非空字符串。解析结果保留桥对象、relay 对象、protocol 与 `remoteSessionId` 的原始绑定，发现去重、同步 validator 和跨 `await` 后的发送复验均核对它们；发现时在读取宿主状态前先捕获桥绑定，等待期间桥/path/identity/路由变化则丢弃该次状态。同路径同 identity 的新桥、relay/protocol 替换或 `remoteSessionId` 变更也使旧目标失效。
- 宿主 `buildWorkspaceBridge` 创建包含 `kind`/`workspacePath`/`workspaceIdentity`/`remoteSessionId` 的桥；`applyMobileTaskViewUpdate` 已按 epoch、seq、bridgeSessionId、bridgeGeneration、ready 和 workspace 核验视图。renderer 的 `syncWebRemoteControlWorkspaces` 只同步桌面 tabs，而 main 的 `prepareProjectWorkspace` 可创建未出现在 tabs 的动态项目。因此手机目标不再要求存在于 `windowWorkspaces`；本窗 `windowTasks` 对该 task 有明确身份记录且不包含目标身份时仍拒绝。普通桌面 pane 的工作区白名单与 scope 路由保持原规则。
- 接口仍向 relay 传入 `{zm:1,target}`、同步 `validate` 和异步 `verifyTarget`。`verifyTarget` 在读取前后均检查当前目标、唯一受信窗口及 live 桥；`mobileConnected`/task/path/identity/`remoteSessionId` 任一变化都不能发送旧结果。路径、identity 和桥引用只在主进程内使用，不进入下行 wire。

## 补丁生命周期与验收

- 保留旧代 `push(frame)` 指纹；新代为捕获一次桥并 `push({frame,b,relay})` 的完整独立指纹。识别后剥离得到逐字节原始资产，再校验登记 SHA/唯一锚点；旧代 apply 升级成新代，半注入 apply 补齐，完整新代重复 apply 不变。未知或重复补丁标记、旧新并存、锚点歧义不得被当成成功。
- `check` 仅在 stash 与新代上行均存在时报告 `patched`；旧代或仅一段报告 `partial`，并通过字段区分上行代际与是否带代际 marker。`remove` 能删除旧代、旧 v2、marked v2 和 stash，原始代码及安装器注入尾缀逐字节还原；重复 remove 幂等。
- 隔离测试覆盖 JS 实际执行（两桥/桥切换/缺桥、非标记、引用身份及只消费一次）、双注入中间态、旧代升级、重复或混代拒绝、登记 SHA 和表外严格推导、asar 重写与 apply/check/remove 往返、尾缀保留。实机桌面生效仍需消费端适配及冷启动后另行验收。
- `tests/inject-mobile-bridge.test.cjs` 按真实桥 schema 覆盖：不在桌面 tabs 名单中的动态 WSL 项目被接受；错 path/identity、未 ready 或失效桥、多个 live 桥、桥对象/relay/protocol 替换、`remoteSessionId` 缺失/不匹配/变化均拒绝旧目标；发送前 status 变化、在途 task 矛盾或目标撤销不能恢复旧结果。测试同时验证普通桌面 scope 仍受 tabs 工作区名单限制。
