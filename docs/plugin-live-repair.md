# 本机插件修复记录（1.2.3）

日期：2026-10-13。平台：本机 macOS。以下记录本次已完成的部署检查；本次文档收尾不再操作已安装 cache、runtime 或 `app.asar`。

## 已确认的部署证据

- 已通过 ZCode 官方 `plugins update` 将已安装插件从 **1.0.0 升级到 1.2.3**，不是仅修改仓库源码。
- 已手动执行已安装插件的 SessionStart，退出码 **0**。运行时最近诊断文件 `plugin-session-start.json` 的 `source=manual-repair-check`，明确属于手动验证。
- runtime 全部托管文件的 hash 与已安装 cache 一致，`preserved=[]`；运行时重启标记 `.plugin-restart-required` 存在。
- `app.asar` 内只有一条与 stable 运行目录精确匹配的注入行；检查后 mtime 仍为 **2026-10-13 18:44:24.096778**，未重复注入或改写 asar。
- 当前主进程启动于 **2026-10-13 18:44:03**，早于上述注入写入时间，不能据此认定该进程已加载修复后的 loader。
- 自动安装/恢复开关已开启：`plugin_auto_install_overlay=true`（auto_install=true）。`plugin_auto_update` 字段缺失，按默认值保持**关闭**；此次官方手动更新不代表已开启自动更新。

1.2.1 引入客户端升级后的恢复，1.2.2 首次引入重新注入后的重启提醒；**1.2.3** 补充运行时 loader（`inject-main.cjs`）或 updater（`plugin-updater.cjs`）更新时的提醒：即使 stable 注入行已有效、无需再次注入，也生成重启标记。`plugin-session-start.json` 记录最近一次执行，其 `source` 可区分手动验证来源；手动执行退出 0 不能证明自然 SessionStart 已触发。

## 最终验证结果

以下为本次验收提供的已完成验证结果，不代表宿主自然触发或新进程加载已验证：

- **22 项 Node + 88 项 Python + 12 项逐问速率测试全部通过**；Python 包含 3 项新增 SessionStart 诊断测试。
- Node 语法检查与 `sync_plugin.py --check` 均通过。
- 对已安装 **1.2.3** 执行官方 `plugins validate`，结果为 `ok=true`、`diagnostics=[]`。
- 隔离 CLI smoke 退出码 **0**；使用的临时目录已删除。

## 尚未验证与边界

- **必须再完全退出 ZCode（所有窗口）并重新启动**，才能确认修复后的 loader 加载；仅刷新页面或重开会话无效。重启后需检查 loader 诊断及重启标记清除，不能把当前磁盘注入状态等同于进程加载成功。
- 重启后还需自然新建/恢复会话，检查新的 `plugin-session-start.json` 及其 `source`，确认宿主自然触发 SessionStart。当前只验证了手动执行，**不能声称自然 SessionStart 已成功触发**。
- 本次修复链路**未在 Windows 实机验证**，不将本机结果外推为 Windows 已验证。
- 不自动重启客户端；不启用 `plugin_auto_update`，也不把自动安装开关视为自动更新授权。
