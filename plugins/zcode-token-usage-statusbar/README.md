# ZCode Token Usage Statusbar

在 ZCode 对话里查看 token 用量、生成速度和上下文容量。

本插件提供用量查询与回答速率；悬浮状态条需要单独安装。用量数据不上传，插件更新会从已配置的来源下载代码。

## 安装

### 远程正式渠道

在 ZCode 对话输入框执行：

```text
/plugin marketplace add ByteRax/zcode-token-usage-statusbar#plugin-releases
/plugin install zcode-token-usage-statusbar@zusage-marketplace
```

此渠道使用正式 Release 包；已从本地目录或默认分支添加过同名市场时，可重新执行添加命令切换来源，之后确认市场的 `ref` 为 `plugin-releases`。插件不会自行迁移你的市场注册。

### 本地目录

使用包含 `marketplace.json` 的源码版本，打开 **设置 → 插件 → 添加插件市场**，点击 **选择目录**，选择仓库根目录，安装并启用 **ZCode Token Usage Statusbar**。

### 安装状态条

两种方式装好插件后，新建或重新打开会话，输入：

```text
/zcode-token-usage-statusbar:install-overlay
```

安装成功后，完全退出并重开 ZCode。只需要查询工具和回答速率时可以跳过状态条安装；它会修改客户端文件，请确认信任后再执行。

## 使用

- `/zcode-token-usage-statusbar:usage today`：查看今天的用量。
- `/zcode-token-usage-statusbar:usage week`：查看近一周。
- 悬停状态条看明细，点击子智能体看各任务，点 ⚙ 调整显示项与语言。
- 回答速率只在当前提问有已入库数据时显示，纯问答可能没有；⚙ 中关闭「逐问速率行」后，下一问生效。

## 更新

在 ⚙ 点击「检查更新」或「立即更新」。自动更新默认开，每 24 小时检查一次；明确关闭的设置会保留。

本地市场不会自动 `git pull`。先自行更新源码，然后刷新 `zusage-marketplace` 并在插件页更新本插件；修改仓库不会自动修改安装缓存。GitHub 更新只使用正式 Release，包与市场清单必须一致。

更新后重开会话；主进程文件变化时按提示完全重启客户端。ZCode 升级可能移除状态条，重新运行安装命令即可恢复。

## 卸载

1. 关闭自动更新，等待正在进行的更新结束。
2. 运行 `/zcode-token-usage-statusbar:uninstall-overlay`，确认成功。
3. **设置 → 插件 → 已安装 → ZCode Token Usage Statusbar → ⋯ → 卸载**。
4. 完全退出并重开 ZCode，确认状态条消失。

**只卸插件不会移除状态条。** 卸浮层命令保留防重注入标记，不删除个人配置；插件移除且旧进程退出后，才可检查并删除运行目录、插件缓存、市场注册与速率状态文件。完整清理步骤见源码中的 `docs/user-guide.md`。

## 需要自定义时

默认运行配置在 `~/.zcode/zcode-token-usage-statusbar/config.json`。保留原有设置，只修改需要的字段：

- `answer_rate_line: false`：关闭回答速率行。
- `plugin_auto_update: false`：关闭插件自动更新。
- `plugin_auto_install_overlay: true`：新建/恢复会话时自动修复状态条注入；默认关，修复后仍需重启。

Windows 若没有 `python3`，需要把 `.mcp.json` 和 `hooks/hooks.json` 中的 Python 命令改成可用的名称，再刷新安装。

开发者：本包的部分文件是根源码的副本，改根文件后运行 `python3 sync_plugin.py`；在仓库查看 `docs/maintaining.md` 与 `tests/README.md` 了解开发、发布和隔离测试。
