# ZCode 升级后的插件恢复验收（1.2.1）

日期：2026-10-13。需求：分析升级 ZCode 后插件自动更新及自动 install-overlay 是否继续有效，存在失效时修复。

## 结论及失效原因

旧实现并非完全有效：插件自动更新只有 `inject-main.cjs` 启动的定时器；升级覆盖 asar 后新进程没有 loader，该定时器也消失。独立 SessionStart 可以安装浮层，但仅按默认 asar 定位、宽松匹配历史注入路径，且 hook 禁用了 Windows 待替换收尾进程。

当前本机的只读现场：已安装插件为 **1.0.0**，插件已启用；运行时配置 `plugin_auto_install_overlay=true`，未配置 `plugin_auto_update`（等于关闭）。缓存和运行时未部署新版 updater。本次只修改源码及分发清单，不对该真实安装执行更新、重启或注入。

## 需求到产物审计

| 要求/修复点 | 产物 | 验证证据 |
|---|---|---|
| loader 消失后仍可自动更新 | `plugin_auto_update.py:start_auto_update`；SessionStart 同步后独立调用；`plugin-updater.cjs --auto` 单次后台入口 | Python 20 项启动测试；真实 ZCode CLI 独立子进程在临时 HOME 自动从 1.0.0 升为 1.1.0，完全不执行 Electron loader |
| 客户端升级后自动 install-overlay | `overlay_install.py` 按环境/保存路径/平台候选定位并验证包身份；精确验证当前注入路径 | 微型 asar 先安装、再以新版官方入口覆写，关闭 optin 不变、开启后真实重打包并恢复当前路径；再次 hook 不重打包 |
| 不误注入、不回退客户端 | 生产候选验证 package name；旧/重复路径修复；保留新版入口和其它资源 | 升级测试确认官方 package.version=2.0.0 和资源原样保留；其它 Electron 包拒绝、无目标缓存清空测试 |
| Windows 占用后的自动收尾 | scoped quiet monitor 环境，无窗口启动；等待退出后替换，目标 mtime 改变则取消旧 TMP | 6 项 quiet monitor 测试：进程退出、校验失败、再次升级取消、正常安装无常驻进程、环境禁用行为 |
| 独立授权与配置保持 | 自动更新/自动安装开关互不联动；optout 保留；只补缺失 python_path 和实际 asar_path，atomic写入 | 配置损坏不覆盖、optin/optout矩阵、旧路径/非默认路径测试 |
| 避免多个会话重复更新 | runtime 跨进程锁、持久检测时间，待同步先本地恢复 | Node 锁/限频/跨实例测试；pendingSync离线测试不运行任何市场命令 |
| 修复版可分发 | 两份 manifest 与市场版本均 1.2.1；根 runtime 副本同步 | package测试、`sync_plugin.py --check`；真实官方 `plugins validate` 返回 ok=true、diagnostics=[] |

## 执行结果

- `node --test tests/*.test.cjs`：**22 项通过**。
- `python3 -B -m unittest discover -s tests -p 'test_*.py'`：**80 项通过**。
- `python3 -B tests/token_rate.test.py`：原有并行速率功能 **12 项通过**。
- `python3 -B tests/plugin-cli-smoke.py`：原有官方 CLI / createUpdater 链路通过，并新增 **standaloneAuto** 真实进程入口。
  自动更新结束为 `phase=updated,currentVersion=1.1.0,error='',pendingSync=false,busy=false`；第二次启动保留24小时限频，更新锁释放。
- `node --check plugin-updater.cjs`、`node --check inject-main.cjs`、`python3 sync_plugin.py --check`、`git diff --check`：通过。
- 1.2.1 完整源码包复制到临时目录，官方 manifest 校验：`ok=true,diagnostics=[]`。

CLI 集成采用临时 HOME/cwd 与系统沙箱，网络、临时目录外写入、读取真实 HOME/仓库/asar均被拒绝；测试 only-JSON 同步夹具没有真实注入行为。微型 asar 测试只写临时文件，真实 repack/install 被调用，syntax_check、真实进程探测与监控启动以 mock 隔离。Windows真实文件锁未在 macOS实机执行，其分支与收尾行为为隔离测试，不声称已实机验证客户端升级。

## 修复后的行为边界

1. 将已安装插件通过“设置 → 插件管理”更新至 **1.2.1**，恢复/新建会话注册新 hook；旧 1.0.0 不会因仓库源码改变自动获得新版。
2. `plugin_auto_update=true`：SessionStart 能独立执行一次检测；浮层 loader 运行时继续每24小时检查。不开浮层自动安装也能检查代码更新，不因此改 asar。
3. `plugin_auto_install_overlay=true` 且无 optout：SessionStart 重新注入。**完成后必须完全退出并再次启动 ZCode一次**；修改磁盘入口不会让正在运行的主进程自动加载它，修复不自行重启客户端。
4. 插件禁用、没有新建/恢复会话、asar权限不足、Python/宿主CLI不可用、SDK入口变化或asar完整性校验收紧时，不能保证自恢复。未额外注册系统计划任务或修改用户全局 hooks。
5. 本地目录市场只检查本地代码，GitHub/Git市场才检查远端；本次未改绑市场来源。

当前状态：源码修复与隔离验证完成，版本1.2.1；真实用户库存的升级与客户端重启仍由用户执行。未提交、推送或发布。
