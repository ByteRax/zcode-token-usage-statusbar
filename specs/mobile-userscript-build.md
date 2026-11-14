# 手机端油猴脚本构建链

本规格服从 [远控统一桌面状态条](mobile-unified-overlay.md)。手机页面只运行桌面 overlay 的完整代码，不再维护 chips 条、独立设置、图标或 CSS 子集。`src/mobile/` 仅负责传输、校验、偏好握手与诊断。

## 文件与构建

| 文件 | 职责 |
|---|---|
| `src/mobile/00-meta.js` | UserScript 元数据 |
| `src/mobile/10-relay.js` | 代际清理、旧偏好迁移、RPC 解码、统计 |
| `src/mobile/20-overlay-loader.js` | socket 隔离的分片/顺序/握手、受限快照校验、嵌入 overlay 激活与接口适配 |
| `src/mobile/30-ws-hook.js` | 透明 WebSocket 包装、已有 `__zmWSList` 补挂、连接诊断脱敏 |
| `src/mobile/40-fallback-ui.js` | 仅调试面板、启动和 dispose；文件名保留，已无 fallback UI |
| `scripts/build_mobile_userscript.py` | 拼接手机分片，将 `build_overlay.assemble_bytes` 的完整输出编码为 JS 字符串嵌入，生成正式/调试两份产物 |
| `docs/zusage-mobile.user.js` / `docs/zusage-mobile.debug.user.js` | 正式/调试构建产物，不进插件分发清单 |

构建必须直接使用桌面构建函数（包含 VERSION 台账折叠），不能读可能滞后的根 `overlay.js`，也不能在运行时 fetch CDN。嵌入字符串经 JSON 解码还原后必须与桌面输出逐字节一致。原桌面 `zm-*` CSS/图标/设置锚点不再是手机构建依赖；此改动不要求删除桌面锚点。

手机分片按 `[0-9][0-9]-*.js` 字典序拼接。杂名、空分片、非法 UTF-8、嵌入/调试占位符缺失或重复必须报错。先完成两变体组装再写产物；`--check` 只读核对两份产物。正式版不创建调试 DOM/CSS 或调试按钮；调试版默认显示面板，`@name`、`@description` 与正式版区分。

## 接收端契约

- 激活嵌入代码前设置 `window.__zusageMobileMode = true`。没有数据也激活桌面 overlay，调用空 `session`/`recent` 与 `mobile.state="waiting"`；不建立另一条状态栏。
- 有效帧必须满足 `zm=1`、`scopeKind ∈ {local,remote}`、`target.taskId=mine`、受限非空 `binding`。`snap.session.sid` 与 `snap.recent` 的唯一目标行 SID 必须同时等于目标。快照里的 `mine` 如有也须相等。
- 递归拒绝非空 `workspace_identity`/`workspaceIdentity` 与 `remote_target`/`remoteTarget`。远端数值快照允许 `remote=true`，远端目标行必须标记 `remote=true`。`today` 直接使用生产者给出的目标所属数据，不从浏览器或其它帧补算。
- 每个有效快照调用 `__zusageUpdate({...snap,mine:taskId,mobile:{taskId,binding,scopeKind,state:body.state||"ready"}})`，不修改原快照对象。
- `unavailable` 帧须有同样的目标绑定且无 `snap`/`chips`/`bySession`，向桌面接口发送空 `session`/`recent` 与 unavailable 状态，及时丢弃旧目标数字。
- 旧 chips-only 或 bySession 帧不转成假统计，只向同一接口发送空数据和 `state="upgrade"`。能力公告不替换数据、不刷新有效数据时间、不推进数据序号。
- URL 的 `sid` 是设备 SID，不参与聊天目标选择。

## 顺序、握手与生命周期

- 分片按 socket、bridge、seq 隔离；旧序号、重复帧、切换后才完成的旧分片不能恢复旧数据。残片超过 60 秒清理，关闭连接立即清理。
- 配置只在同一 socket 收到有效 `zuUpCap>=2` 后发送；能力 45 秒过期。gen/ack、30 秒重试与偏好变化均按连接独立维护，断开或重新注入不能继承能力。
- 旧 `zusageMobilePrefs` 的 show/theme/just 只在对应 `zusage3.*` 键缺失时迁移。读取/上行桌面同名偏好，UI 只由桌面设置写入。
- 重新注入先调用前代 `__zmDispose`；移除本代 DOM、计时器、DOM/socket 监听与自有构造器包装，不关闭宿主 socket。保留并复用已有 `__zmWSList` 中仍存活的连接，重新握手。
- pagehide 释放本代消费者；bfcache pageshow 重新启动本代消费者，不重复包装或监听。显式 dispose 后不恢复。
- 绝不自动刷新页面。捕获不到连接时明确提示用户手动刷新。调试 URL 仅保留协议、host 和 pathname，去除 userinfo/query/fragment，解析失败不回显原文。

## 验收

| 场景 | 期望与验证 |
|---|---|
| 桌面源码变化、根产物滞后 | Python 构建测试逐字节核对嵌入内容取自 assemble_bytes |
| 不带任何数据启动 | VM 行为测试确认 overlay 已激活、先启 mobile mode、收到 waiting，无手机独立 DOM |
| 本地→远端→不可用→恢复 | 始终复用同一 overlay 实例；接口只收到该目标专属快照或空态 |
| 目标不符、混入真实身份、缺绑定 | 不调用统计更新；有效零值照常透传 |
| 旧 chips-only、能力公告 | chips 只触发 upgrade；公告只更新同 socket 握手 |
| 乱序、迟到分片、跨 socket | 不回退目标，分片不混合，能力不共享 |
| 重复注入、dispose、pagehide | 消费者/计时器清理；新代补挂已有连接且不复用能力 |
| 正式/调试、连接 URL | 正式无调试 DOM/CSS，调试 URL 无敏感尾部，无 location.reload |
| 临时构建及产物漂移 | build 与 --check 通过；手改临时产物后 --check 必须失败 |

自动化运行 `node --test tests/mobile-userscript*.test.cjs` 和 `python3 -B -m unittest tests/test_mobile_userscript_build.py`。UI 挂载、设置、tooltip 的真实 Chrome 验收由集成任务负责，VM 不代替实机视觉证据。
