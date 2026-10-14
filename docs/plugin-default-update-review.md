# 插件默认自动更新与代码审查（2026-10-14）

## 交付状态

- 原始要求：插件自动更新默认开启，并 review 本轮更新/设置/升级恢复改动，分析优化空间。
- 默认行为源码版本为 **1.2.4**：缺失配置文件或缺失 `plugin_auto_update` 时开启；显式布尔 `false` 保持关闭；配置损坏、非对象或显式非布尔值时不自动执行。
- 主进程 Node 更新器与 Python SessionStart bootstrap 采用相同规则；不覆盖用户配置来强制迁移默认值。
- 自动重注入仍默认关闭，默认自动更新不授予修改 `app.asar` 的权限。
- 示例配置、三份 README、中英文设置面板文案、两份插件 manifest 和原 marketplace 均同步；运行时分发副本一致。
- 本机运行时已设 `plugin_auto_update=true`，GUI 实测自动更新已勾选；Python 路径、自动恢复及其它原配置保持。**本机安装仍是 1.2.3，源码 1.2.4 不等于已安装版**。本轮未人工安装新版本、修改缓存或重启客户端。
- 首次检查后按 24 小时限频。本机已有今日检查记录，开启不会绕过限频；本地目录市场不执行 git pull。

## 验证

- 新增默认行为测试先运行失败，再修改生产实现并重跑通过；发现 `config.json=null` 会使旧 Node updater 初始化崩溃，已随本轮安全配置读取修复。
- Node 全量 **25 项**通过；Python 插件全量 **90 项**通过；逐问速率 **12 项**通过。
- `node --check`、`sync_plugin.py --check`、`git diff --check` 通过。
- 官方源码插件校验 `ok=true, diagnostics=[]`。
- macOS 隔离官方 CLI smoke 通过，包括未填写自动更新配置时独立 `--auto` 真正升级临时插件、再次执行受 24 小时限频约束；隔离临时目录已删除。
- 本机设置面板显示自动更新已勾选，当前/市场版本 1.2.3；未将此当作 1.2.4 已部署证据。
- 收尾时发现另一会话新增逐问速率行开关造成 overlay 分发漂移；保留其代码并重新同步，最终 25/90/12 回归及分发检查再次通过。该并行功能不属于本报告默认值修改的交付范围，也未被本次审查验收为完整功能。

## 审查范围与结论

审查覆盖 updater、主进程桥接、设置面板、插件安装与运行时同步、SessionStart、重启提示、quiet finalizer、分发清单及相关测试。以下发现由只读审查和额外隔离夹具复现，不操作真实库存/asar。**这份文档保留当时未修复的审查结果；2026-10-14 后续已按用户要求批量修复，当前结果见 [1.3.1 批量修复验收](plugin-batch-fixes.md)。**

### 1. [P1] SessionStart 直接同步不受互斥保护，可回滚新版

位置：`plugins/zcode-token-usage-statusbar/overlay_install.py:198-244`、`:306`。

旧 1.2 同步读取 1.1 基线并暂停，新 2.0 同步完成后，旧任务继续写文件和版本记录。复现最终 `recordVersion=1.2.0`，loader 为旧内容。Node 的更新锁不覆盖 hook 的直接 `sync_runtime()`，串行防降级测试不能防这个交错。

建议：运行时同步用独立的跨进程事务锁，锁覆盖读取基线、替换文件、提交记录；补旧/新同步交错回归。避免与 Node 更新锁跨语言互相等待形成死锁。

### 2. [P1] 陈旧更新锁回收竞争会破坏互斥

位置：`plugin-updater.cjs:65-80`。

A 读到死进程锁后暂停；B 回收并建立新锁；A 按路径删除 B 的锁后又持锁进入。释放函数也无条件删除当前路径。复现两个 updater 同时 `busy=true`，其中一个释放后另一个仍在更新但锁已消失。

建议：采用有可靠所有权保证的进程间锁机制，回收和释放都验证持有者；不能仅补一次 PID 检查后继续按路径删除。补多进程争抢陈旧锁和非持有者释放测试。

### 3. [P1] 升级时保留的热修可能在下一同版 hook 被覆盖

位置：`plugins/zcode-token-usage-statusbar/overlay_install.py:221-244`。

hash 保护只在 `upgrade=true` 生效。较旧 mtime 的手改文件在 1.0→1.1 首次同步被保留，但记录版本升为 1.1；下一同版同步转回 mtime 分支并覆盖。复现 `firstPreserved=['overlay.js']`，随后 `nextChanged=['overlay.js']`，手改丢失。

建议：有可信 hash 基线时持续使用 hash 保护，同版也不可覆盖手改；无基线迁移才用 mtime。补连续同版同步保持热修测试，调整目前允许同版 mtime 覆盖的预期。

### 4. [P2] 安装已提交但 CLI 报错时，运行时同步永久遗漏

位置：`plugin-updater.cjs:164-172`。

待同步标记只在 CLI 返回、诊断与 `ok` 检查都成功后保存。模拟 CLI 先更新安装记录再超时报错，得到已安装 1.1、`pendingSync=false`；新 updater 检查为 current，sync 调用 0 次。父进程在相同窗口退出也存在同类问题。

建议：安装前持久化待协调状态，重启/失败后比较官方安装事实与运行时版本，完成协调，而不是只信 CLI 成功返回。补提交后超时/父进程退出测试。

### 5. [P2] 后台冷更新需要重启，但提醒只保存在子进程内存

位置：`plugin-updater.cjs:175-185`、`plugins/zcode-token-usage-statusbar/overlay_install.py:306-322,375-388`。

独立后台 updater 的 `restartRequired` 不写持久状态或重启标记；stdout 被 bootstrap 丢弃。下一 SessionStart 文件已同步、`changed=[]`，也不会补提醒。复现后台实例需重启，已有 loader 看到新版但仍 `restartRequired=false`、无 marker。已有注入时显式 install 丢弃同步 changed 也存在同类问题。

建议：冷文件同步统一记录“已部署但未加载”，由真实新 loader 加载后清除，并让正在运行的 loader 读取；不要仅靠执行更新的实例内存。补后台 sync→旧 loader→SessionStart→prompt 的串联测试。

### 6. [P2] 检查过程中关闭自动更新，后台仍可能继续安装

位置：`plugin-updater.cjs:125-158,187-199`。

阻塞后台市场检查，通过另一 updater 写入 `false` 后继续，安装判断仍读缓存 `state.auto=true`。复现磁盘关闭但仍调用官方 update。

建议：自动安装副作用开始前重新读取配置；允许阻止尚未开始的安装，对已经进入官方安装阶段说明不能取消。补跨实例异步关闭测试。默认开启后用户首次关闭更容易撞到这个窗口。

### 7. [P2] Windows quiet 收尾存在来源时间窗，临时替换失败不重试

位置：`install_monitor.py:108-122`（插件副本相同）。

来源基线取 monitor 启动时的 ASAR mtime；若旧 TMP 生成后、monitor 读取基线前发生官方升级，新包会被视为基线。真实微型 ASAR 夹具复现新版 2.0 被旧 TMP 1.0 替换。另 `finalize_tmp=false` 后直接退出，短暂占用只尝试一次。

建议：生成 TMP 时记录来源 ASAR 与 TMP 的身份，收尾前核验；在截止期限内重试短暂替换失败。此为条件性时间窗，**不是声称 Windows 普遍必现，也没有 Windows 实机验收**。

### 8. [P2] 相同 mtime 的不同内容升级可能不热生效

位置：`plugins/zcode-token-usage-statusbar/overlay_install.py:169-178`、`inject-main.cjs:60-68,364-371`。

同步保留源 metadata，hash 判定可覆盖内容不同但 mtime 相同的升级；loader 与常驻 Python 重启检测只看 mtime。复现磁盘 overlay 已新内容，但 VM 缓存仍旧内容。

建议：内容变化时确保可观察变更戳，或用内容指纹检测；补同步+加载联测。这是既有热更新机制与新增同步契约的交互，不是新默认值导致的回归。

### 其它收紧与简化空间

- `overlay_install.py:283` 的 autoInstall 使用 `bool()`，字符串 `"false"` 被当作授权。建议同 autoUpdate 一样严格接受布尔值，补非布尔测试；正常 JSON `false` 不受影响。
- 对 P1 并发与热修保护优先写可重复交错测试，再改锁/同步实现；不要先做大重构或增加新配置。
- 统一持久的运行时版本/待加载状态，可以同时解决提交后失败、后台更新通知和跨实例状态缺失，避免各路径独立补提示。
- 未发现可确认的命令注入问题：固定 argv、`execFile`、完整插件 ID、安装路径来自官方用户安装记录，页面不提供脚本执行路径。默认更新不联动安装授权。

## 优先级建议

建议优先处理 **同步事务与可靠锁、持续 hash 热修保护**，随后处理 **安装事实协调和重启需求持久化**。其它项目再分批处理。本轮审查不作“所有链路已无问题”的通过结论；既有绿测试不能替代上述缺失场景。

## 要求到证据映射

| 要求 | 实际证据 |
|---|---|
| 自动更新默认开启 | Node/Python 缺配置及缺字段测试通过；隔离真实 CLI 在缺字段时安装成功 |
| 本机设置开启 | runtime `config.json=true`；原生设置面板 checkbox=1 |
| 不覆盖显式关闭 | Node 跨重启测试、Python False 测试；不自动回写默认配置 |
| 安装授权保持独立 | 示例 autoInstall=false；隔离 bootstrap 不改 asar/optout；本机原有 true 保持 |
| 版本和说明一致 | 两份 manifest 与 marketplace=1.2.4；中英文面板和 README 默认开；副本一致性检查 |
| Review 与优化分析 | 上述 P1/P2 发现、复现结果、位置、建议及覆盖缺口；未擅自修独立问题 |
| 验证不污染真实库存 | 全量单测临时夹具、CLI smoke 沙箱；本轮真实修改仅用户授权的 autoUpdate 配置 |

1.2.4 的安装仍由现有插件管理流程或已开启的周期更新执行，未承诺立即绕过 24 小时限频。需要手动安装此源码版本时，在设置→插件/市场源刷新 `zusage-marketplace`，再更新本插件；loader/updater 新代码需要完全退出重启加载。市场根目录仍为 `/Users/smzdm/Projects/AI/zcode-token-usage-statusbar`，插件 ID 不变：`zcode-token-usage-statusbar@zusage-marketplace`。本轮没有提交、推送或发布。
