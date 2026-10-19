# ZCode Token Usage Statusbar

在 ZCode 对话里查看生成速度、token 用量和上下文容量。

本插件提供用量查询与回答速率；安装/修复悬浮状态条会修改客户端 `app.asar`，成功后需完全退出并重开。用量数据不上传，插件更新会从已配置的来源下载代码。

> **适用范围：** 本文关于状态条默认自动安装/修复的说明仅适用于当前 `main` / 本地新版源码，尚未发布到正式渠道。`#plugin-releases` 的正式版 `v1.4.1` 仍默认关闭自动安装；请执行 `/install-overlay`，或在下述配置文件中合并 `"plugin_auto_install_overlay": true` 后新建或恢复会话。

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

安装当前 `main` 的本地新版源码插件后，保持插件启用，新建或重新打开会话，插件默认自动安装/修复状态条。**这会修改客户端的 `app.asar`，请确认信任此项目。成功后必须完全退出并重开 ZCode**，只关闭窗口不算退出。

自动安装失败时，再手动执行以下兜底命令，按实际输出排查；成功后仍需完全退出并重开：

```text
/install-overlay
```

只需要查询工具和回答速率时，在 `~/.zcode/zcode-token-usage-statusbar/config.json` 中合并 `"plugin_auto_install_overlay": false`（保留其它设置），或运行 `/uninstall-overlay` 移除状态条并保留卸载豁免，阻止自动重注入与安装提醒。

配置文件不存在或缺少该字段时默认开启；已有的显式 `false` 会保留。环境变量 `ZUSAGE_PLUGIN_AUTO_INSTALL=1` / `0` 优先于配置，但不能绕过卸载豁免。未设置环境变量时，损坏配置或非布尔字段不会启用自动安装。

提醒会标注「zcode-token-usage-statusbar 插件提醒」，使用加粗文字和红色圆点。状态条已加载时，提醒正文会显示为红色；首次尚未加载时，客户端会过滤 HTML 颜色样式，正文只能加粗，红色圆点仍保留。

## 使用

- `/zcode-token-usage-statusbar:usage today`：查看今天的用量。
- `/zcode-token-usage-statusbar:usage week`：查看近一周。
- 悬停状态条看明细，点击子智能体看各任务，点 ⚙ 调整显示项与语言。
- 回答速率只在当前提问有已入库数据时显示，纯问答可能没有；⚙ 中关闭「逐问速率行」后，下一问生效。

## SSH 远端支持（当前 main，未发 Release）

此功能属于当前 `main` / 本地新版源码，尚未发布到正式 Release。需先更新本机插件安装副本与运行文件、完成注入安装/修复，并**完全退出后重启 ZCode**；只改源码或只关窗口不能使主进程加载新版。

- 自动适配客户端保存的 SSH 连接，并结合宿主当前会话的 `workspaceIdentity` 路由；自动模式只查询已确认远端 scope，不把本地未知会话 ID 发往历史服务器探测。
- 支持多个服务器/工作区，手动 `targets` 应带与客户端匹配的 `identity`；今日用量与错误按目标独立，避免错误跨机合并。
- 查询失败或暂未找到会话时持续退避重试；恢复历史会话、切换工作区和 SSH 重连后，取得可靠身份才继续远端查询。身份未知时不猜服务器，一台失败不应阻断其它来源。
- **每台 SSH 远端需手工部署同版本 `zusage.py`**，默认 `~/.zcode/zcode-token-usage-statusbar/zusage.py`，并准备 Python 3.8+ 与数据库读取权限。自动适配不是自动安装，不能承诺完全零配置。
- 查询通道必须免交互可用；插件不能解密复用宿主保存的密码、加密私钥或口令，也不会自动登录。请自行配置 SSH key/agent。远端查询有递归防护，不需要在那里安装桌面状态条或再次启用远端转发。
- **仅桌面状态条 JSON 链支持跨机取数**；MCP、`/usage` 与回答速率不自动跨机，纯 CLI 无状态条 UI。自动化夹具不等同于各种 SSH/多服务器环境的实机验收。

**主面板归属**：主标签页（`workspace-main`）与各分栏按本窗口实际会话节点的 SID 和工作区身份路由，不从共享的 last-session、pane-layout 或工作台分组历史推断归属，因此其它窗口切换会话或清除记录不会改变本窗绑定。身份由版本、资产 SHA256 和唯一节点锚点校验的 renderer 补丁随宿主渲染更新；本窗可信 workspace IPC 与任务列表继续校验身份。节点身份缺失、协议不匹配或 SID 不一致时不借其它分栏或历史远端数据，显示零值。当前身份补丁支持已登记的客户端 3.15.3、3.16.1；升级安装后需完全退出并重启客户端，旧补丁或未知构建不会启用共享记录回退。本说明对应当前源码修复，不代表已发布到正式渠道。

`remote.auto` 缺省 `true`，独立于旧开关；`remote.enabled: false` 关闭旧单通道/无身份 fallback，不关闭自动身份路由。手动目标以身份覆盖自动目标；关闭自动发现后需显式 `enabled: true` 才使用手动目标，未设置的 `script`、`python`、`timeout_s` 继承 `remote` 顶层。示例仅合并字段，身份需换成客户端实际值：

```json
{
  "remote": {
    "auto": true,
    "enabled": false,
    "targets": [
      {
        "identity": "remote:ssh:build.example.com:22:alice:/srv/build",
        "ssh": "ssh alice@build.example.com",
        "host_label": "build"
      }
    ]
  }
}
```

仅旧 CLI `python3 zusage.py json <SID>`（SID/逗号列表协议）在 `enabled: true` 时可使用默认单通道 fallback；桌面始终使用 JSON，`scopes: []` 禁止 fallback，未知 main 不会借通道查远端或猜历史身份。

彻底停用需 `auto: false`、`enabled: false`，可保留 `targets` 而不执行。失败时保留最近成功的工作区缓存并标过期/错误，首次无缓存显示零值，不借本地今日量；null/error 不清空最近成功显示。默认远端轮询 3 秒（最少 1 秒），失败/未知退避重试；重新开启及配置/连接设置变更由默认 30 秒（最少 10 秒）心跳检测。自恢复不替宿主自动重连 SSH；无可信身份或归属歧义（如同 SID 多归属）时默认不猜测。

完整开关、带身份的配置和恢复排查见源码 [远程会话指南](../../docs/user-guide.md#远程会话)；保留个人设置，仅合并需要的字段。

## 更新

在 ⚙ 点击「检查更新」或「立即更新」。自动更新默认开，每 24 小时检查一次；明确关闭的设置会保留。

本地市场不会自动 `git pull`。先自行更新源码，然后刷新 `zusage-marketplace` 并在插件页更新本插件；修改仓库不会自动修改安装缓存。GitHub 更新只使用正式 Release，包与市场清单必须一致。

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

Windows 若没有 `python3`，需要把 `.mcp.json` 和 `hooks/hooks.json` 中的 Python 命令改成可用的名称，再刷新安装。

开发者：本包的部分文件是根源码的副本，改根文件后运行 `python3 sync_plugin.py`；在仓库查看 `docs/maintaining.md` 与 `tests/README.md` 了解开发、发布和隔离测试。
