# ZCode Token Usage Statusbar

在 ZCode 对话里查看 token 用量、生成速度和上下文容量。

本插件提供用量查询与回答速率；安装/修复悬浮状态条会修改客户端 `app.asar`，成功后需完全退出并重开。用量数据不上传，插件更新会从已配置的来源下载代码。

> **当前正式版：** `#plugin-releases` 正式渠道默认自动安装/修复状态条；配置文件不存在或缺少字段时开启，已有显式 `false` 会保留，详见下文。

## 安装

### 远程正式渠道

打开 **设置 → 插件 → 发现 → +（添加插件市场）**，输入 `https://github.com/ByteRax/zcode-token-usage-statusbar#plugin-releases`，添加后安装并启用 **ZCode Token Usage Statusbar**。

此渠道使用正式 Release 包；已从本地目录或默认分支添加过同名市场时，通过市场管理确认并切换来源，确认市场的 `ref` 为 `plugin-releases`；不支持同名来源替换时，先移除旧市场注册再添加正式地址，无需卸载插件或浮层。插件不会自行迁移你的市场注册。

### 本地目录

使用包含 `marketplace.json` 的源码版本，打开 **设置 → 插件 → 添加插件市场**，点击 **选择目录**，选择仓库根目录，安装并启用 **ZCode Token Usage Statusbar**。

### 安装状态条

安装插件后，保持插件启用，新建或恢复会话，插件默认自动安装/修复状态条。**这会修改客户端的 `app.asar`，请确认信任此项目。成功后必须完全退出并重开 ZCode**，只关闭窗口不算退出。

自动安装失败时，再手动执行以下兜底命令，按实际输出排查；成功后仍需完全退出并重开：

```text
/install-overlay
```

只需要查询工具和回答速率时，在 `~/.zcode/zcode-token-usage-statusbar/config.json` 中合并 `"plugin_auto_install_overlay": false`（保留其它设置），或运行 `/uninstall-overlay` 移除状态条并保留卸载豁免，阻止自动重注入与安装提醒。

配置文件不存在或缺少该字段时默认开启；已有的显式 `false` 会保留。环境变量 `ZUSAGE_PLUGIN_AUTO_INSTALL=1` / `0` 优先于配置，但不能绕过卸载豁免。未设置环境变量时，损坏配置或非布尔字段不会启用自动安装。

提醒会标注「zcode-token-usage-statusbar 插件提醒」，使用加粗文字和红色圆点。状态条已加载时，提醒正文会显示为红色；首次尚未加载时，客户端会过滤 HTML 颜色样式，正文只能加粗，红色圆点仍保留。

## 使用

插件命令的实际注册名是 `/usage`、`/install-overlay`、`/uninstall-overlay`，不加插件名前缀；插件启用后可在输入框的 `/` 命令菜单找到它们。`disable-noninteractive: true` 会从桌面协议命令列表隐藏命令，不是执行安全门，因此安装/卸载命令不设置该字段。

- `/usage today`：查看今天的用量。
- `/usage week`：查看近一周。
- `/usage days:14`：按天查看近 14 天；`sessions:5` 查看最近 5 个会话，`models:14` 按模型查看近 14 天。
- 悬停状态条看明细，点击子智能体看各任务，点 ⚙ 调整显示项与语言。
- 回答速率只在当前提问有已入库数据时显示，纯问答可能没有；⚙ 中关闭「逐问速率行」后，下一问生效。

## 更新

在 ⚙ 点击「检查更新」或「立即更新」。自动更新默认开，每 24 小时检查一次；明确关闭的设置会保留。

本地市场不会自动 `git pull`。先自行更新源码，然后打开 **设置 → 插件**，在市场管理中刷新 `zusage-marketplace`，再到 **已安装** 更新本插件；修改仓库不会自动修改安装缓存。GitHub 更新只使用正式 Release，包与市场清单必须一致。

更新后重开会话；主进程文件变化时按提示完全重启客户端。ZCode 升级可能移除状态条，插件默认自动修复，失败时再运行安装命令兜底。

## 卸载

1. 关闭自动更新，等待正在进行的更新结束。
2. 运行 `/uninstall-overlay`，确认成功。
3. **设置 → 插件 → 已安装 → ZCode Token Usage Statusbar → ⋯ → 卸载**。
4. 完全退出并重开 ZCode，确认状态条消失。

**只卸插件不会移除状态条。** 卸浮层命令保留防重注入标记，不删除个人配置；插件移除且旧进程退出后，才可检查并删除运行目录、插件缓存、市场注册与速率状态文件。完整清理步骤见源码中的 `docs/user-guide.md`。

## 需要自定义时

默认运行配置在 `~/.zcode/zcode-token-usage-statusbar/config.json`。保留原有设置，只修改需要的字段：

- `answer_rate_line: false`：关闭回答速率行。
- `plugin_auto_update: false`：关闭插件自动更新。
- `plugin_auto_install_overlay: false`：关闭新建/恢复会话时自动安装/修复状态条；默认开，成功后仍需完全退出并重开。

Windows 若没有 `python3`，需要把 `.mcp.json` 和 `hooks/hooks.json` 中的 Python 命令改成可用的名称，再刷新安装；逐问速率动态沿用 hook 解释器，经系统 `powershell.exe -NoProfile -NonInteractive` 的 `EncodedCommand` 调用，兼容 CMD/Git Bash，系统禁用 PowerShell 时本轮速率可能省略，不要改配置绕过限制。

开发者：本包的部分文件是根源码的副本，改根文件后运行 `python3 sync_plugin.py`；在仓库查看 `docs/maintaining.md` 与 `tests/README.md` 了解开发、发布和隔离测试。
