# 渲染桥、窗口分栏归属与远端路由规则

适用路径：`renderer_bridge.py`、`inject-main.cjs` 的窗口/工作区 IPC、查询泵、scope 上报与远端恢复段、`overlay.js` 的 `sessionFor`/scope 选择段、`tests/overlay-remote-scope.test.cjs`、`tests/inject-remote-recovery.test.cjs`、`tests/test_remote_targets.py`、`tests/test_renderer_bridge.py`、`renderer_live_check.cjs`。

改归属/身份/远端逻辑前先读本文件；fail-closed 总原则在根 [AGENTS.md](../../AGENTS.md) §5「窗口、分栏与远端」。

## 1. 桥（renderer_bridge.py）

- 桥按**已登记版本、原始资产 SHA256、唯一 JSX 锚点**向 React 管理的 SessionPane 节点写 `data-zusage-scope-version=1`、workspacePath、workspaceIdentity、remoteSessionId、paneId，与原 `data-session-id` 同节点同步更新。共享 last-session、pane-layout、workbench-groups 与 conversation registry 保活历史**不构成**当前归属证据。
- 客户端版本登记表是 `HOST_TARGETS`（以源码为准，不在文档写版本清单）：表内版本资产哈希漂移仍拒绝；表外版本先走 `derive_target` 严格推导（唯一锚点、registry/key/topic 绑定、store 形状与 import 目标——引擎 bundle 里 `new Map` 前的 registry 名、`workspaceIdentity?.trim()` 的 KEY 函数、跨 chunk 的 topic 绑定、全文件唯一的 ``"data-session-id":t??`draft`,`` 锚点，draft 是反引号模板字面量不是字符串），校验不过拒绝补丁并降级 DB 轮询。`python3 renderer_bridge.py derive <asar>` 直接打印可粘贴的登记条目；新客户端版本升级=HOST_TARGETS 加一行。登记时 `tests/test_renderer_bridge.py` 三处随动：props 夹具补新锚点包装/testid 别名桩（漏补则 VM 测试 ReferenceError）；sourcemap 夹具 map 名写 `bridge.ASSET + '.map'` 跟随、不写死资产名（写死则 NEWEST 切换后拒绝逻辑不再触发、假失败）；SessionPane 参数映射随版本轮换（先例：3.17.x 起 c/l/u/e→l/u/d/e），期望值用实现同款 `bridge.pane_attributes(target)` 推导，不硬编码属性串与形参签名。
- 宿主契约锚点（引擎侧，混淆名随版本轮换）：连接 key 无 sessionId 维度（同 workspace 新老会话共用 layer）；draft 预热=pane 挂载即后台 createSession，`data-session-id` 可为字面量 `"draft"`，store 在首发消息前已 cold 创建。引擎 bundle grep 必须 `LC_ALL=C grep -a`（NUL 被当 binary 会静默丢结果）；kebab-case 字段要同时搜 camelCase。
- asar 原子替换后 `os.chmod(stage, S_IMODE(...))` 保留权限位；`_output_path` 对 `is_symlink()`/`resolve()` 须捕获 `OSError`（防受限沙箱或 `/Applications/ZCode.app` 权限拦截抛 `PermissionError`）。手工部署桥前先 `cp` 一份 `app.asar.backup-pre-bridge-<ver>-<ts>`（`ensure_deployed` 代码不备份）。表外版本的 `remove_deployed` 按 BEGIN/END 标记字节还原。
- `ensure_deployed` 发布被系统拒绝（Windows 客户端运行中持有 asar 不带 FILE_SHARE_DELETE、目标目录 ACL 只读）时返回 `replace-failed` 并移交**完整 stage**，不得静默吞成 skipped：调用方转 `patch_install.publish_external_pending`（TMP + sidecar + monitor 收尾链）或删除 stage，不能留原地；`PermissionError` 单独标 `permission`（Windows `os.access` 看不见 ACL，不能靠 `target_writable` 判权限）；入口清扫超时残留的崩溃孤儿 stage（新 stage 处在移交窗口内绝不能删）；用户 remove 待收尾时让位，锁内拒绝以 install 覆盖 pending remove。
- 对本机 asar 的整文件哈希断言先检测并剥离本项目 BRIDGE 标记再校验（已部署机器必失配）。`tests/test_renderer_bridge.py` 用最新登记项的 names 推导夹具，不写死混淆名。
- 旧 conversation-only 补丁须升级安装并完全重启，不启用共享记录回退。
- **运行时动态桥兜底（v258）**：静态桥缺席（表外客户端版本、桥未部署、Windows replace-failed）时由渲染端自愈，`app.asar` 不再因此重打包。两层：①`overlay.js` 的 `readFiberPaneScope`——宿主自写 `data-session-id` 节点沿 React fiber 上溯（限深 24、撞外层会话/分栏根止步、多候选歧义拒绝）取 SessionPane 组件帧的 `paneId/workspacePath/workspaceIdentity/remoteSessionId`（JSX 属性名不被压缩，AUTO_PANE_PARAM 同源证据；侧聊按 `tabId` 全串匹配），校验与静态属性分支逐字同规；`detOwnerOf`/`sidePaneKeyOf` 有 fiber 侧聊识别的同文副本（分属两个不相交的切片 eval 区间，两处须同步改）。②`turn-stats.js` 运行时合成 BRIDGE_TEMPLATE v2 同契约三访问器——registry 靠一次性 `Map.prototype` 探针按条目形状（layer.entries/acquire + stale/refCount）捕获后立即还原本体方法，另有 `installRuntimeBridge(map)` 注入口；key/topic 公式按 AUTO_NAMES 钉死形状，宿主改公式则静默失配降级 DB（不崩溃）。fail-closed 语义不变：fiber/合成桥只补「桥缺席」，静态属性校验失败（version="1" 但属性非法）不回落；远端身份白名单、跨 pane 隔离、歧义拒绝全部沿用。`overlay_install.py` 的 hook 自动链（quiet_hook）对 skipped-unknown/skipped-error（含受保护目录权限）静默放行交由兜底接手，显式 CLI 安装保留提权提示。

## 2. 窗口与分栏归属（inject-main + overlay）

- 查询请求为 `{sids, scopes: [{sid, workspaceIdentity}]}`，响应 `recent` 携带 `workspace_identity`；桌面 JSON 请求 `scopes: []` 禁止旧单通道 fallback；旧 CLI SID/逗号列表兼容行为不能扩大为桌面身份推断。
- 身份读取须校验协议、字段、SID、paneId 与节点存活；明确本地 identity 为空可查本地；无桥/读不到身份且本窗**无任何**远端证据（`remote_evidence === false`）时按本地记录显示；有远端证据或泵绑定为远端时 fail-closed，不借同 SID 本地快照或其它 pane 远端数据。未收集过证据按保守处理；任务证据只按 pane 自身 sid 统计；workspace 证据是窗口级（窗口任一远端连接 → 无桥本地 pane 保持零值，该取舍勿移除）。
- 身份不在本窗可信 workspace IPC 或与 tasks 矛盾时不放行远端；当前节点改变或撤销后迟到载荷丢弃。改身份/归属逻辑必须同时核对 overlay `sessionFor` 守卫与泵 `scope_bindings` 两侧语义一致。
- 子代理按父子关系关联，不按派发时间最近邻猜任务名。主标签页（`workspace-main`）及各分栏的归属只取本窗口实际 SessionPane 节点。
- 远端身份白名单 `REMOTE_IDENTITY_RE = /^remote:(?:ssh|wsl|docker|server):/`（`inject-main.cjs`）；宿主 v3.16 起所有传输连接握手后统一升级为 `remote:server:<serverId>:<path>`，`remote:wsl:` 等只留作 legacy。`web/overlay.js` 另有独立的 `remote:ssh:` 白名单（Web 链）。

## 3. 远端目标（remote.* 配置）

- `remote.auto` 与 `remote.enabled` 独立；彻底关闭需两者为 false。手动目标通过 `identity`/`identities` 绑定并覆盖同身份自动目标，标签不作身份。远端 scope 必须有可靠当前身份：明确绑定身份的分栏与当前节点主绑定可路由；归属未知或歧义时 fail-closed，不猜服务器。
- 各目标分别维护 today、错误、缓存与恢复；失败不借本地/其它目标总量，保留同身份最近成功快照并标记过期；null/error 不等于成功，也不应清空最近成功显示。保留持续退避重试、超时/并发预算、配置与连接变化心跳；统计链恢复不等于插件替宿主重连 SSH。
- 远端只需手工部署匹配的 `zusage.py`、Python 和数据库读取权限，通道必须免交互；不能解密复用宿主密码/私钥口令，不自动部署或登录；递归防护不可去除。远端支持限桌面 JSON 查询链；MCP、`/usage`、逐问速率不自动跨机。
- 远端路由可本机 sshd + localhost 远端工作区实机验收，验收后清理免密通道（密钥/authorized_keys/known_hosts/手动 target 全删）。

## 4. 验证

- 回归：`tests/test_remote_targets.py`、`tests/inject-remote-recovery.test.cjs`、`tests/overlay-remote-scope.test.cjs`、`tests/test_renderer_bridge.py`。远端夹具须按真实宿主 schema 构造（真实 `panes:{}` 形状），贯通采集→IPC→JSON 请求→推送→选数全链；用错 schema 的全绿不算验收。实机身份/重连与认证另验。
- 客户端升级体检六项见根 AGENTS.md §6；"桥不生效"先查客户端是否刚升级、渲染进程是否换新（asar 是 rename 替换，运行中进程不重载）。
