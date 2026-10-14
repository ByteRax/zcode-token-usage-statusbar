# 插件自动更新验收记录

日期：2026-10-13。范围：plugin 安装方式的自动更新，以及浮层设置面板中的自动/手动更新检测。未提交或推送代码，未升级用户真实安装、未更改真实 `app.asar`、未替换市场来源。

## 需求到产物的验收清单

| 明确需求 | 实现 | 实际证据 |
|---|---|---|
| plugin 自动更新 | `plugin-updater.cjs` 调用 ZCode bundled CLI；只刷新 `zusage-marketplace`、只更新目标 full ID；默认关，开启立即检查并安装，运行时每 24 小时检查 | Node 自动开关/安装/限频/跨重启测试；真实 CLI 隔离集成 `phase=updated`；GUI 开启后当前版本由 1.0.0 变 1.1.0，`/evidence` 含官方安装动作 |
| 设置面板自动更新 | `overlay.js` 新增独立 checkbox，主进程读取固定动作；配置写 `plugin_auto_update` | GUI 已勾选截图和临时 config 持久化；显示项 checkbox 不受影响；Node 缺失/损坏配置测试 |
| 手动检测及更新 | 检查更新仅检测，立即更新仅新版可用；手动安装前再检查 | GUI 显示当前/市场版本、按钮状态；GUI 点击立即更新成功；Node 检测不安装、旧版不安装测试 |
| 检测结果/反馈 | 检测/更新中、最新版、有新版、失败、版本、检测时间、重启提示、热修列表 | 中英截图和 DOM 状态；网络失败时可重试按钮恢复可用；同步失败跨重启重试测试 |
| plugin 分发可用 | 根 runtime 副本同步至 plugin；原子同步、版本及 hash 防回滚；两清单及市场一致 | Python 包测试及运行时测试；`sync_plugin.py --check`；当前 1.2.0 包官方 `plugins validate` 返回 `ok=true, diagnostics=[]` |

## 自动验证结果

- `node --test tests/*.test.cjs`：19 项通过，包含 loader 固定动作、本地窗口限制、状态推送与自动定时调度。
- `python3 -B -m unittest discover -s tests -p 'test_*.py'`：33 项通过（31 运行时策略 + 2 分发包校验）。
- `node --check overlay.js`、`node --check inject-main.cjs`、`node --check plugin-updater.cjs`：通过。
- `python3 sync_plugin.py --check`：插件副本与根文件一致。
- `git diff --check`：通过。
- `tests/plugin-cli-smoke.py`：真实 Electron bundled CLI 在临时 HOME/cwd 中添加、安装、刷新、检测、升级，版本从 1.0.0 升到 1.1.0；安装记录、版本缓存和再次查询均确认。真正 `createUpdater` 不改写 CLI JSON，完成检测及安装。
- 官方 manifest 校验：将当前 plugin 包复制到临时目录，在同一沙箱中运行 `plugins validate <临时插件路径> --json`，返回 `ok=true, diagnostics=[]`。

真实 CLI 测试禁止联网、临时目录外写入，以及读取真实 HOME、仓库和 asar；隔离探针确认权限拒绝，临时目录自动删除。更新后的同步在真实 CLI 测试中使用 JSON-only 子进程，真正 Python 同步器另以临时目录回归覆盖。未声称真机端到端升级已完成。

## 界面测试与截图

环境：`tests/plugin-update-demo.cjs` 加载真实 overlay 与 updater，市场响应、安装记录和 config 使用临时数据。测试 UI 调用真实更新器逻辑，CLI/同步由测试响应替代。不操作用户库存。DOM 状态与截图共同核验。

### 1. 默认状态与手动检测：通过

自动更新未勾选，立即更新不可用。点击检查更新后显示 1.0.0/1.1.0，未安装；立即更新变为可用。

![手动检测新版](file:///Users/smzdm/.zcode/cli/artifacts/sess_2bce9e0f-a8d5-4f1e-9120-d20cd0441908/call_8W5ZlmJN2qiZcVxjdPPgYAoZ-tool-result-bd342eec-cd63-4cbe-b2d1-118a3ac320d6.png)

### 2. 手动安装：通过

立即更新后显示当前 1.1.0，主进程重启提示和未覆盖的热修文件。

![手动更新成功](file:///Users/smzdm/.zcode/cli/artifacts/sess_2bce9e0f-a8d5-4f1e-9120-d20cd0441908/call_lbQXviHkiYpiaa3FP5ZeMLIJ-tool-result-2c87545e-be1e-4752-b61e-95cee87ee928.png)

### 3. 自动检测和安装：通过

重新建立 1.0.0 测试安装，开启自动更新后，无需点立即更新即完成 1.1.0 安装；临时 config 的 `plugin_auto_update=true`，动作日志仅刷新指定市场、查询和安装目标插件。

![自动更新成功](file:///Users/smzdm/.zcode/cli/artifacts/sess_2bce9e0f-a8d5-4f1e-9120-d20cd0441908/call_5gnef0Xa34tFxmbdjc5pMlgX-tool-result-3b94d97f-53d4-4593-b4c0-a10f0576317d.png)

### 4. 语言切换：通过

切换 English 后更新控件、版本和重启提示为英文，自动开关保持已开启。

![英文更新设置](file:///Users/smzdm/.zcode/cli/artifacts/sess_2bce9e0f-a8d5-4f1e-9120-d20cd0441908/call_qbiiNbDct53iiqZ6BwSdsAQs-tool-result-809e1a3a-a60b-44a5-b584-ef7f77a6ff53.png)

### 5. 检测失败提示：通过；恢复网络后的 GUI 重试：受测试工具阻塞

点击测试网络失败后检查更新，显示错误原因，检查按钮恢复可用，不显示错误的“已最新”。恢复测试网络按钮的浏览器操作超时，未强制点击或注入绕过，因此 GUI 恢复重试不列通过。Node 网络恢复后的手动重试和同步失败重试均通过。

![检测失败提示](file:///Users/smzdm/.zcode/cli/artifacts/sess_2bce9e0f-a8d5-4f1e-9120-d20cd0441908/call_zTOLzuSXXPO3JR4VsurF8b27-tool-result-7620e530-3248-4e42-b192-a422f9dab5f9.png)

测试过程中有多次 browser locator/cua 超时，均重新观察现场，未当作成功。设置更新状态新增去重，修正重复刷新；后续手动安装通过。较高的 1280×1400 测试窗口用于免滚动验证，其余截图为 1280×720；没有修改产品布局。浏览器能力没有暴露 console listener，本轮没有收集 console 日志。测试 fixture 未提供缓存命中率字段，条面出现 NaN% 属 fixture 数据不完整，不属于本次更新逻辑验收。

## 分发状态与边界

- 当前源码包版本 **1.2.0**。自动更新功能从 1.1.0 引入；另一个并行任务把清单同步升级至 1.2.0 并新增逐问速率功能，本任务保留其改动，不回退。
- 源码目录：`plugins/zcode-token-usage-statusbar/`；市场根：仓库根；清单：`marketplace.json`；full ID：`zcode-token-usage-statusbar@zusage-marketplace`。
- 用户真实安装最初观察到 1.0.0；本任务没有更新/重装或发布它。初次升级由用户在“设置 → 插件管理”刷新本市场、更新插件，重开会话同步文件，再重启客户端一次。
- 自动更新使用已有市場：GitHub/Git 来源检查远端；本地目录仅检查本地文件，不会 git pull。当前用户市场是本地目录，未自动改绑远端。
- Windows 运行时实测未完成，跨平台逻辑沿用 bundled CLI 和 Python；macOS 真实 CLI、文件同步及设置 UI 已有上述证据。
