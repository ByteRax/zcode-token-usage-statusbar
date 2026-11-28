# 插件体检命令 /zusage-doctor

## 目标与边界

状态条、chip 或回答末尾的速率行不显示时，把开放式的多轮排查收敛成一次命令。命令只做诊断，输出每项检查的事实、等级和对应的修法；修复动作仍由用户或其后的 `/install-overlay` 等既有入口执行。

- 入口是插件命令 `commands/zusage-doctor.md`，它调用 `overlay_install.py doctor`。不新增运行目录文件，`doctor` 逻辑只在插件目录的 `overlay_install.py` 里。
- 状态所有者不变：注入、待替换与可写性判定归 `patch_install.py`，渲染桥归 `renderer_bridge.py`，运行目录同步记录归 `overlay_install.py`，插件安装与市场登记归宿主。体检只读取这些既有判定，不另写一套判据。
- 体检不修改客户端、运行目录、配置或插件登记。两处例外沿用安装器已有的做法：`target_writable()` 在归档同目录做一次「建后即删」的写入探针；监控存活探测用 `monitor_instance_lock()` 试取那把常驻的去重锁。
- 不读取也不输出任何凭据文件。`config.json` 只报告能否解析和少数非敏感开关，不回显内容。

## 输出契约

- stdout 只有体检文本：标题、按组的检查行、汇总行 `体检结果: OK n / WARN n / FAIL n`、以及「建议动作」编号列表；没有需要处理的问题时写「未发现需要处理的问题」。
- 每条检查行形如 `[级别] 项目: 事实`。`OK` 表示正常，`WARN` 表示需要注意但不挡主功能，`FAIL` 表示状态条或速率行当前无法工作。
- 退出码：体检跑完恒为 0，有无问题都一样，结论只看文本；体检脚本自身出错时非 0，并以「体检未能完成」开头。
- 某一项检查抛异常只把这一组记成 `FAIL`，其余各组照常执行。
- 建议动作按优先级排列并去重；涉及修改客户端文件、提权、重启或卸载的动作只写进文本，由命令说明要求执行者先征得用户同意。

## 检查项

| 组 | 检查 | 数据来源 | 判定 |
|---|---|---|---|
| 运行环境 | Python 版本与平台 | `sys.version_info` | 恒 `OK` |
| 插件登记 | 当前插件副本版本 | `PLUGIN_ROOT` 下的 manifest | 恒 `OK` |
| 插件登记 | 安装记录 | 宿主插件存储的 `installed_plugins.json` | 无记录 `FAIL`；记录的安装目录不存在 `FAIL`；与当前副本版本不同 `WARN` |
| 插件登记 | 启用状态 | 宿主 CLI 配置的 `plugins.enabled` 与 `plugins.enabledPlugins` | 总开关关闭或本插件被禁用 `FAIL`；未显式设置按默认启用 `OK` |
| 插件登记 | 市场登记 | 宿主插件存储的 `known_marketplaces.json` | `#plugin-releases` / `.git#plugin-releases-gitcode` 为正式渠道 `OK`；裸 GitHub 地址为「仓库源码」`WARN`；带刷新失败记录 `WARN` |
| 客户端 | 归档位置、客户端版本、是否在运行 | `patch_install` 的目标探测、`read_asar_package`、`client_running` | 找不到归档 `FAIL`；其余如实报告（进程名探测可能漏检，输出里注明） |
| 注入 | 状态条注入行 | 归档快照中的主入口与注入行比对 | 未注入或归档读不出 `FAIL`；指向别的目录 `WARN` |
| 注入 | 远控中继补丁 | 与状态条注入检查共用归档快照，由 `patch_install.py` 返回判定及文案 | 钩子齐全时任何语言均为 `OK`，其余 `WARN` |
| 注入 | 逐问速率行补丁（渲染桥） | `renderer_bridge._inspect_deploy` | `present` `OK`；缺桥或无法验证 `WARN` |
| 注入 | 客户端版本适配 | `_host_registered` | 未登记 `WARN` |
| 待替换 | 待替换包与收尾监控 | `pending_operation`、`pending_tmp`、`monitor_instance_lock` | 安装待替换 `FAIL`（客户端退出后才生效）；卸载待替换 `WARN`；输出注明监控是否在运行 |
| 待替换 | 待重启改动 | 运行目录的 `.plugin-restart-required` | 存在 `WARN` |
| 运行目录 | 同步记录、运行文件与插件来源是否一致、配置可解析、卸载豁免、最近一次会话启动记录 | `plugin-runtime.json`、`RUNTIME_FILES` 逐文件比对、`load_runtime_config`、`.plugin-overlay-optout`、`plugin-session-start.json` | 配置损坏 `FAIL`；文件缺失或不一致 `WARN`；存在卸载豁免 `WARN`；启动记录带故障提示 `WARN` |
| 更新 | 自动更新开关与最近一次更新结果 | `config.json` 的 `plugin_auto_update`、`plugin-update.json` | 关闭 `WARN`；最近检查或安装失败 `WARN` |

宿主插件存储根的解析与宿主一致取三处：环境变量 `ZCODE_STORAGE_DIR`，其次宿主 CLI 配置的 `storage.dir`，都没有则用 `~/.zcode`；再拼到 `cli/plugins`。项目级配置（`zcode.json`、`.zcode/config.json`）不参与，保证体检在任何工作目录下结果一致。

## 建议动作

每条 `FAIL` 与多数 `WARN` 带一条对应动作，按固定优先级排列：先解决「没装上、被禁用、归档找不到」，再解决「未注入、目录不可写」，然后是「待替换待退出、无监控收尾、待重启」，最后是「桥缺失、版本未适配、运行目录不一致、渠道与更新」。安装已排定、在等客户端退出时，注入行只报事实、不再建议运行 `/install-overlay`（重跑只会复用同一个待替换包），该做的事由待替换包那一行给出。重启一律写成「完全退出 ZCode（从托盘退出，只关窗口不算）再重新打开」，不替用户重启。

## 验收

| 场景 | 可观察结果 |
|---|---|
| 全部正常 | 没有 `FAIL`，没有建议动作 |
| 归档未注入且客户端未运行 | 注入行 `FAIL`，建议动作含 `/install-overlay` |
| 安装已排定、客户端在运行 | 待替换 `FAIL`；注入行只报事实。建议动作只有「完全退出」这一条，监控未运行时换成补拉收尾的办法，都不含 `/install-overlay` |
| 插件被禁用 / 没有安装记录 / 安装目录不存在 | 对应行 `FAIL` 并给出修法 |
| 市场登记是裸 GitHub 地址 | `WARN` 并写明「仓库源码」 |
| 运行目录文件缺失或与来源不一致、配置损坏、存在卸载豁免、启动记录带故障提示 | 对应行 `WARN` 或 `FAIL` |
| 某一项检查抛异常 | 该组记 `FAIL`，后续各组照常输出，退出码仍为 0 |
| 运行目录里放一个带哨兵串的 `quota-secrets.json` | 输出不含该串 |
| 状态条与远控中继补丁均可检查 | 两项共用一次主入口读取，语言设置不影响等级 |
| 主入口读不出且客户端版本可读 | 仍报告客户端版本，注入检查报告读档失败 |
| 体检前后 | 运行目录、归档、宿主插件存储的文件清单与字节不变 |
| 归档找不到 | 仍输出完整报告与 `FAIL`，退出码 0 |

自动化验收使用 `tests/test_zusage_doctor.py`、`tests/test_command_frontmatter.py` 与分发清单检查；真实故障机上各修法是否对症需实机验收。
