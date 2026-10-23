# 安装、注入、更新与发布链规则

适用路径：`install.py`、`patch_install.py`、`install_monitor.py`、`plugin-updater.cjs`、`plugin-release.cjs`、`plugin-storage.cjs`、`runtime_lock.py`、`release_unpack.py`、`release_tool.py`、`sync_plugin.py`、`plugins/zcode-token-usage-statusbar/` 下的 `overlay_install.py`、`plugin_auto_update.py`、`restart_notice.py`、`hooks/`、两份 manifest、`marketplace.json`，以及对稳定运行目录 `~/.zcode/zcode-token-usage-statusbar/` 的任何部署操作。

发布流程本身以 [docs/maintaining.md](../../docs/maintaining.md#发布插件) 与 [发布技能](../skills/zcode-github-release/SKILL.md) 为准；本文件记录链路契约与陷阱，根 [AGENTS.md](../../AGENTS.md) §3、§8 是其摘要。

## 1. 分发文件登记（新增/改名文件必查）

一个文件进入分发链要同步**全部**登记处，漏任一处都会在不同阶段报错或断升级：
- `sync_plugin.py` 的 `FILES`（根→插件副本同步）与 `release_tool.py` 的同步清单；
- `release_unpack.py` 的 `PLUGIN_FILES`（安全解包文件集）；
- `overlay_install.py` 的 `cold_files`（决定哪些变更要求完全重启）；
- `restart_notice.py` 的 hashes 名白名单（漏改报"提醒记录 hashes 无效"）；
- 两份 manifest（`.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json`）的 `packageLayout.files`——在野旧版解包器要求文件集精确声明，漏声明会让旧版无法升级到新版（曾两次事故），`release_tool.py build` 的 `require_layout` 会拦；
- 相关契约测试（`tests/test_plugin_package.py`、`test_plugin_runtime.py`、`test_release*.py`）。

## 2. 注入与运行目录

- 插件缓存按版本号换目录，而 asar 注入行是绝对 `file://` URI——所以 loader 必须先复制到稳定运行目录再对该目录注入，此后升级只需同步文件即可热更。注入/安装时把 `sys.executable` 绝对路径写回配置 `python_path`，每次 SessionStart 刷新。
- asar 原子替换（mkstemp → `os.replace`）后必须 `os.chmod(stage, S_IMODE(原 asar mode))` 保留权限位，否则降成 0600（lifecycle 测试断言 0644）。
- 参与 INJECT_LINE 字节比对/自检的 `--runtime` 路径禁止 `Path.resolve()`（macOS `/var`↔`/private/var` 符号链接会破坏字面比对），只用 expanduser/expandvars/abspath；`--asar` 可完整 resolve；standalone `install --finalize` 在自定义安装路径需同时给 `--asar` 与 `--runtime`，`install_monitor.py` 的"手动执行"提示内嵌真实路径。
- `patch_install.client_running()` 用 `pgrep -x ZCode`，本机进程名可能是 `zcode-cli` 而漏检；它只决定走安全路径，无害，但**测试时不要靠它判断客户端是否在跑**。asar 被占用的收尾必须由宿主以外的监控进程执行，不能依赖 ZCode 自己的定时任务。
- 热/冷清单：`overlay.js`、`turn-stats.js` 热重载（主桥 2s mtime 监听）；`zusage.py` 常驻进程由 loader 按 mtime 自动重启；`inject-main.cjs`、`quota-client.cjs`、`plugin-updater/release/storage.cjs` 是冷文件，首次注入、路径变化或这些文件变更需完全退出并重启客户端。可热更新文件也须确认实际加载路径。
- 插件→运行目录同步有 hash 基线/mtime 热修保护（`preserved`）；根 `install.py` 的运行文件复制是直接覆盖，不能承诺同等保护。向运行目录覆盖任何文件前先 diff 运行目录与来源基（运行时可能领先所有工作树，直接 cp 曾静默降级）；并行会话活跃时 `sync_plugin.py` 会把他人未提交的根文件改动扫进副本与运行目录——浮层/更新器异常先排查这条路径。
- 热修纪律：叠加部署不整体覆盖；先备份 `.pre-<原因>-<时间戳>`；原子替换（tmp 同名过 `node --check` 再 mv）；判断运行目录实际版本用 diff 根文件 + stat mtime + 备份名，**不信 diag**（diag 约每 15 次拉取才落盘，滞后数分钟；`diag-0.json` 是非活跃窗口不能当泵健康探针）。运行目录分叉早于 main 时一步三方合并会回退已合入的改动，须两步（先演进到 main 再叠修复）。

## 3. 配置与开关

- 配置只合并需要的键，不整体覆盖 `config.json`；保留未知键、用户显式关闭与个人路径。插件配置事务在锁内重读、合并，再同目录原子替换；损坏或非对象配置不能被默默重建。`config.example.json` 是模板，不可原样执行占位路径。
- 缺字段默认值、非布尔异常值与显式 `false` 不能混为一谈。自动安装：缺文件/缺字段默认开启，显式 `false` 保留；`ZUSAGE_PLUGIN_AUTO_INSTALL=1/0` 优先配置但不能越过 `.plugin-overlay-optout`，无环境覆盖时异常配置不开启。`plugin_auto_update` 与自动安装独立；损坏或非布尔更新配置不启动自动更新。
- 主桥 `readCfg()` 的 `python_path` 缺省与空值归一为平台默认（win32=`python`，其它=`python3`），三个 spawn 点直接读它。

## 4. hooks 契约

- `hooks.json` 是 command+shell 回退链 `python3 → python → py -3`（POSIX sh 与 Windows `%ComSpec%` 都支持 `||`，宿主丢弃成功 hook 的 stderr）；`.mcp.json` 固定 `python3`（stdio MCP 按 `shell:false` 直接 spawn 无回退，macOS CLT 只有 `python3`）。python.org 安装器从不建 `python3.exe`；Store 桩是 PATH 真实文件、存在性检查全过，只有执行能区分（退出码 49、广告走 stderr）。
- SessionStart `matcher` 必须 `startup|resume`（引擎只派发这两种；桌面重启=恢复原会话 `source=resume`）。`timeoutMs=60000` 不得收紧：asar 重打包是磁盘密集操作，中断可经 pending 标记恢复。
- SessionStart 输出：`systemMessage`/`suppressOutput` 引擎无消费者，用户可见提醒必须走 `additionalContext`（`restart_notice.py` 双键同写是有意设计）。hook 在远端会话（SSH/WSL 时在远端主机执行、无 asar）必须静默 no-op；拿不到交互 sudo 只能报告不硬试。
- 自然触发证据：`__pycache__/*.pyc` 是安装期编译产物不算执行证据；可靠证据=运行目录被创建/更新 + `plugin-session-start.json` 的 source/pluginRoot/result。手动执行 hook 不等于自然事件验收。
- 引擎已核实事实：命令名=文件名、无 `/插件名:` 前缀；`allowed-tools`/`model` 字段只解析展示无运行时效果；`${user_config.*}` 仅注入 MCP 声明；MCP 工具全名 `mcp__plugin_<插件名>_<服务键>__<工具名>`；插件体系无 Uninstall hook（注入孤儿靠 `/uninstall-overlay` 兜底）。Python→Node 全量迁移已评估并否决（hooks 无 env 字段、锁无 Node 等价物、远端链必须留 Python），勿重启整轮调研。

## 5. sudo 与卸载

- sudo 提示必须保留目标用户 HOME/PATH 与用户产物归属：node 候选顺序 PATH → `SUDO_USER` 的 `~/.nvm/versions/node/*/bin/node` 按版本降序 → 系统位置；装完归还运行目录归属。remove 目标只读时先只读判定，确无注入则写豁免标记免 root 放行；提示按部署形态与操作区分。
- 卸载只移除本项目注入，不用旧 asar 备份回滚客户端版本；未注入时移除可成功，但读不到目标不能假装已卸载。GUI 卸载只清组件注销 + 缓存副本 + installed_plugins 条目，**不碰** asar 注入行/运行目录/市场注册（known_marketplaces + marketplaces 克隆）；彻底卸载顺序=`/uninstall-overlay` + 重启 → GUI 卸载 → 移除市场与克隆 → 删运行目录。`.plugin-overlay-optout` 阻止自动重注入与安装提醒，但不关闭运行文件同步/插件更新。
- 自动安装/修复可能受权限、事件触发、宿主结构影响，成功后仍需重启；不替用户重启，不用强制提权掩盖失败。

## 6. 更新器与渠道

- 更新渠道由 `readChannel` 按注册来源**和市场缓存清单**共同判定：清单为 zip 源的 GitHub/GitCode 来源是 Release 渠道（ZIP、manifest、版本一致，安装后 `verifyCommittedRelease` 复核宿主安装记录）；清单为源码路径的仓库来源判为 `market` 渠道，与本地目录来源同链，由宿主插件管理器按清单直接更新。源码清单的 `source` 是**相对路径字符串**（`"./plugins/..."`）不是对象，判定必须识别字符串形态；`readChannel` 读的是市场缓存清单而非注册来源，刚切源缓存未刷新会暂判旧渠道。安装前校验门 `validateCatalog` 已按维护者决定移除，不要加回。不静默切换用户市场来源，不启用被禁用插件。
- `PLUGIN_ID` 写死 `zcode-token-usage-statusbar@zusage-marketplace`，同名市场恰好一条记录（注册两个同名来源直接报错）。无 alpha/预发布通道：STABLE 正则 + prerelease 硬拒（`release_tool` 断言 prerelease 为 false），`compareVersions` 支持 pre 段但候选过滤不放行。
- 手动检查在 `busy=true` 后、取锁前立即 publish `checking`；撞锁抛"另一个更新进程仍在运行"；auto/定时 tick 路径保持静默不闪 checking。立即更新卡有 downloading 阶段与下载/安装双进度条，缺 progress 的旧主进程自动隐藏。
- 发版后 raw.githubusercontent 按分支名有约 5 分钟 CDN 缓存：Release 渠道清单滞后=下载 zip → 按旧清单装 → 版本未前进 → 报"插件管理器未提交新版安装记录"并按短间隔重试重下；market 渠道切源缓存未刷新=一次"更新期间市场来源已变化"后自愈。诊断更新失败先对时间窗。
- GitCode 双渠道校验（`plugin-release.cjs` 的 flavor 分支、`sameAssetUrl` 主机模式、`fetchBytes` 白名单）必须一起改并有测试锁定；gitcode flavor 的 `validateManifest` 放松 `manifest.repository`（上游而非镜像）；清单不一致 gitcode 直接报错。模拟渠道链路的测试不能用插件 `fetchBytes` 拉 raw.githubusercontent（白名单不含，真实链路由宿主 CLI 拉）。
- 配置/更新/安装锁跨 Python 与 Node；OS advisory 锁文件永久保留，不通过删锁文件解锁。更新租约/所有者与旧锁恢复是另一层协议，不把冲突当成功，也不删运行目录绕过并发或热修保护。

## 7. 打包与发布

- 本地同步 ≠ 打包 ≠ 校验 ≠ 发布预演 ≠ 提交/tag/Release/渠道推送；源码改版、正式渠道发布、用户安装副本升级是不同步骤。
- 两份 `plugin.json` 与根 `marketplace.json` 的插件身份/版本须一致；正式渠道清单是生成的 `marketplace-release.json`，不要覆盖源码市场入口。`release_tool.py build` 的输出目录须尚不存在，包只含枚举分发文件；`verify` 校验身份、文件集、SHA256 与安全解包。
- `publish --dry-run` 不是离线检查：仍有 GitHub 只读 preflight，要求已提交源码、本地/远端 tag 与目标提交一致、Release 不存在及非空 UTF-8 更新说明；预演不授予发布权限。`publish --gitcode-repo`（需 `GITCODE_TOKEN`）在 GitHub 发布验收后生成 `plugin-releases-gitcode` 清单与同 tag 资产，镜像上须先有同一个 tag 且指向发布提交（创建 Release 的请求不带 `target_commitish`，见发布技能的 GitCode tag 闸门）；GitCode 段认证未配置时该段失败属预期，不代表 GitHub 段失败。
- 覆盖/删除已有 Release 需用户明确指令，删除前 `gh release view --json body,assets` 存快照。`--publish`/`--confirm` 是工具安全门不是授权替代；提交、推送、tag、Release、渠道写入按当前明确授权执行。
- 配置、数据库、诊断、本地热修不是发布素材；可信同步保护用户改动，解包保留路径穿越、链接、重复项与文件集限制。本地统计只读数据库不上传；远端查询用配置/宿主连接通道、插件更新联网下载代码，不能笼统宣称"不联网"。
