# 待收尾 asar 的应用内重启交接（issue #372）

## 背景

Windows 上运行中的 ZCode 持有 `app.asar`（无 `FILE_SHARE_DELETE`），插件更新/补桥只能生成 `app.asar.zusage.tmp` + sidecar，由监控进程等客户端完全退出后 `os.replace` 收尾。

应用内「重启 ZCode」走 Electron `app.relaunch()`。Windows 上它先拉起一个 `ZCode.exe --type=relauncher` 助手：助手等旧主进程退出、启动新实例，自己最后才退出。`install_monitor.py` 的 `quiet_finalize()` 只有在 `zcode_pids() == set()` 时才 `finalize_tmp()`，而 relauncher 助手/新实例让这个判据在应用内重启期间**永不成立**：

1. TMP 不替换 → `publishedAt` 不写；
2. 新实例 loader 的 `ack_restart()` 因 `pending-install` 缺 `publishedAt` 拒绝清 marker；
3. ⚙ 红点/「已更新成功，点击重启」常驻，用户看到「点击重启无效」。

issue #372 有完整时间线；主进程退出快路径也仍可能输给「旧子进程未释放 + relauncher 同秒拉起新实例」的竞速，不能作为唯一方案。

## 产品规则

1. **有合法待收尾 install 包时，应用内重启改为 quit-only + monitor 拉起**：`inject-main.cjs` 的 `relaunch` 动作检测 `app.asar.zusage.tmp` 与 sidecar（`operation === "install"` 且 `validated === true`）都存在，写 `relaunch-request.json`（`version` / `asar` / `argv` / `cwd` / `pid` / `createdAt`，POSIX 0600），然后只调用 `app.quit()`，**不再 `app.relaunch()`**。该路径不隐藏窗口，保证宿主「确认退出 Z Code?」弹窗可见。
2. **无待收尾包时不改变行为**：没有 TMP/sidecar、或请求写入失败时，保持原有 `app.relaunch() + app.quit()`（含 hide/800ms 兜底/15s 哨兵）。
3. **monitor 只在收尾后拉起一次**：`quiet_finalize()` 成功 finalize（仅 `operation == "install"`）后、`_run()` 可见监控的同门控分支、或循环退出时 TMP 已被其它进程收尾，读取请求；`asar` 必须与当前目标一致、`createdAt` 在 15 分钟内（且不早于当前时间 1 分钟以上——未来时间戳不得延长有效期）、`zcode_pids()` 为空（探测不可用同样不拉起）、提权监控一律不拉起（不以管理员令牌拉起宿主，也封死提权链参数注入面）。**拉起一律裸启动 `patch_install.zcode_exe_for(asar)` 推导出的客户端 exe**（推导失败或文件不存在：删除请求不拉起，不做 basename 同名回退）；请求里的 `argv` 尾部仅作 v1 形状记录、不消费——提权监控进程里任意启动参数（`--inspect-brk`、`--gpu-launcher` 等）可构成提权代码执行面。任一校验不过：删除请求并记日志。
4. **先删请求再拉起**：monitor 读取/校验后先 unlink 请求，再 `Popen([exe], cwd=...)`；Windows 用 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`，POSIX `start_new_session=True`。拉起失败只记日志，用户可手动重开。
5. **请求只在退出真被取消时撤回**：quit-only 分支用 `app.once("before-quit")` 捕获宿主会话保护的 `preventDefault`——只有该正证据（或 quit 同步抛错）才清请求；15s 哨兵只恢复窗口可见性、**不**清请求（退出链可超过 15s、弹窗阻塞会冻结定时器使逾期哨兵立即触发，把慢退出误判为取消会让 monitor 收尾后无人拉起）。loader 启动时无条件清掉残留请求，防止用户手动重开后 monitor 再拉起第二个实例。
6. **可诊断**：monitor 把 `relaunch ok` / `relaunch failed` / `relaunch dropped: <原因>` 与无请求的收尾留痕追加到运行时目录 `install-monitor.log`。

## 状态所有者与接口

- `inject-main.cjs`
  - 常量 `RELAUNCH_REQUEST`（运行时目录 `relaunch-request.json`）。
  - `pendingAsarPath()`：读 `config.json` 的 `asar_path`（缺省 `process.resourcesPath/app.asar`），校验 TMP+sidecar 后返回 asar 路径，否则空串。
  - `writeRelaunchRequest(asar)`：原子写入请求（`.tmp` → rename，0600），返回 `createdAt`；失败返回 0。
  - `clearRelaunchRequest(createdAt?)`：带 `createdAt` 时只清除同一代请求；不传时无条件清理（loader 启动用）。
  - `relaunch` 分支：有请求 → quit-only（注册 `before-quit` once 监听捕获取消）；否则原路径。quit 同步抛错、哨兵确认「退出被取消」时清本次请求。
- `install_monitor.py`
  - `RELAUNCH_REQUEST` / `RELAUNCH_MAX_AGE_MS`；`_maybe_relaunch()` 做规则 3/4 的校验与拉起；`_monitor_log()` 写日志。
  - `quiet_finalize()` 成功 finalize（install）后调用；`_run()` 可见监控的 `finished`（operation=install）分支调用；循环退出时 TMP 已不存在也会消费。
- `patch_install.py`：复用既有 `zcode_exe_for()`；不改 TMP/sidecar/marker 协议。

## 验收场景

1. **Node 分支**：注入 pending 夹具 → 回执 `{ok:true}`、`app.quit` 1 次、`app.relaunch` 0 次、不隐藏窗口、请求写入参数为 asar 路径；无 pending → 原 `relaunch=1` + `hide=1`；请求写失败 → 回退原路径；quit 同步抛错 → 清请求；`before-quit` 带 `preventDefault`（取消）→ 哨兵清请求；取消前哨兵（无 preventDefault 的慢退出）→ 不清请求。
2. **Node 助手**：`pendingAsarPath` 对 install/remove/未 validated/缺 sidecar 的判定；`writeRelaunchRequest` 的 request 形状（version/asar/argv/cwd/pid/createdAt）与原子落盘（0600）；`clearRelaunchRequest(createdAt)` 不误删新请求，无参时无条件删除。
3. **Python monitor**：finalize 成功后按推导 exe 裸启动 `Popen` 并删除请求；asar 不匹配 / 过期或未来时间戳 / `zcode_pids()` 非空或探测不可用 / 提权监控 / exe 推导失败 → 不拉起且删除；无请求 → 不调用 `Popen`；remove 收尾不消费请求。
4. 既有 `node --test tests/*.test.cjs`、`python3 -B -m unittest discover -s tests -p 'test_*.py'`、`node --check inject-main.cjs`、`python3 sync_plugin.py --check` 全绿。

## 限制

- `inject-main.cjs` 是唯一冷文件：本修复经插件更新到达用户后，**运行中进程内存里仍是旧 relaunch 实现**，合入后第一次应用内重启仍复现 issue #372 症状一次；任意一次完全退出后新 loader 生效，之后的「重启 ZCode」才走 quit-only 收敛。已知边界：用户点重启又取消退出后，15 分钟内手动完全退出且收尾成功时，会被残留请求拉起（视为补兑现的重启请求）。
- 只覆盖 install 收尾：待收尾包为 remove（`/uninstall-overlay` 落下的 remove 包）时，`pendingAsarPath()` 判空回退 `app.relaunch()`，remove 包仍要等一次完全退出才收尾（同类既有问题，本修复未扩）。
- 宿主 `before-quit` 确认弹窗、真实 Windows 退出窗口与 Job 回收只能在实机验收；仓库测试用临时夹具与 mock，不代表 Windows 实机通过。
