# 安装、配置与排查

[返回首页](../README.zh-CN.md) · [功能截图](features.md) · [开发与发布](maintaining.md)

这份文档面向需要自定义安装、远程查询或彻底清理的用户。日常使用通常不需要改配置文件。

## 选择安装方式

- **桌面客户端**：一键安装器直接安装状态条和查询工具；插件方式由 ZCode 管理查询、回答速率与插件更新，再单独安装状态条。两者使用同一个运行目录和同一行注入，不要重复安装查询组件。
- **自托管网页**：按 [Web 版文档](../web/README.zh-CN.md) 部署，不能用桌面安装器给浏览器页面添加状态条。
- **官方云端网页**：本仓库的 Web 方案需要你控制服务器与 nginx，不适用于官方托管页面。

桌面版需要 Python 3.8+，不需要额外 Python 包。支持 Windows、macOS；Linux 系统级路径可能需要管理员权限，界面与发行版兼容性需自行验证。

## 一键安装

```bash
git clone https://github.com/ByteRax/zcode-token-usage-statusbar.git
cd zcode-token-usage-statusbar
python install.py
```

macOS 可改用 `python3`。成功后完全退出并重开 ZCode；只关闭窗口不一定退出主进程。

安装器会定位客户端、复制运行文件、保留或生成设置、安装状态条、注册查询工具和 `/usage`。安装监控会提示重启并确认是否加载；Windows 文件被占用时，可能要退出后才完成替换。

### 找不到安装位置

推荐指定安装目录：

```bash
# Windows 示例
python install.py --root "D:\Apps\ZCode"

# macOS 示例
python3 install.py --root /Applications/ZCode.app
```

也可传 `--asar <app.asar 完整路径>` 或设置环境变量 `ZCODE_ASAR`。自动探测只采用确认属于 ZCode 的目标，首次安装后会保存位置。

### 其它选项

| 选项 | 用途 |
|---|---|
| `--lang en` | 安装器、CLI 和查询报表使用英文 |
| `--no-mcp` | 只安装状态条，不再注册查询工具和 `/usage`；适合查询已由插件提供的情况 |
| `--dry-run` | 预览安装动作，不实际安装 |
| `--dev` | 开发模式，直接引用仓库文件；此时不能删除或移动仓库 |
| `--remove` | 移除注入、独立注册的查询工具、`/usage` 和运行目录；不等于卸载 ZCode 插件 |

## 插件安装

### 本地目录

从 [ByteRax 仓库](https://github.com/ByteRax/zcode-token-usage-statusbar) 下载或克隆源码，确认根目录包含 `marketplace.json`。添加市场时选这一层目录，不是 `plugins/` 子目录。

1. 在 ZCode 打开 **设置 → 插件 → 添加插件市场**；某些版本入口在「发现」页的 **+**。
2. 点击 **选择目录**，选择包含 `marketplace.json` 的仓库根目录，添加市场。
3. 找到 **ZCode Token Usage Statusbar**，安装到用户范围并启用。
4. 按宿主提示加载插件，新建或重新打开会话；已有会话不会补触发启动钩子。
5. 如果需要状态条，执行下面命令，成功后完全退出并重开 ZCode：

```text
/zcode-token-usage-statusbar:install-overlay
```

![添加插件市场对话框：选择本地仓库根目录](plugin-marketplace-add.png)

也可以在 **ZCode 对话输入框**中添加市场并安装（不是系统终端）：

```text
/plugin marketplace add /绝对路径/到/zcode-token-usage-statusbar
/plugin install zcode-token-usage-statusbar@zusage-marketplace
```

路径含空格时用引号包住。Windows 若找不到 `python3`，需在插件的 `.mcp.json` 与 `hooks/hooks.json` 中改用可用的 Python 命令，再刷新安装；只改仓库不会改变已安装副本。

### 远端市场

只有仓库发布了插件市场清单与可安装包，才可使用 `owner/repo` 形式。
GitHub 正式更新渠道使用 `OWNER/REPO#plugin-releases`，须以维护者实际发布的地址为准，不能复制占位符安装。

远端更新只采用正式 Release，不回退开发分支；Release 包与市场清单必须一致。私有仓库认证下载和非 GitHub 远端自动更新目前不支持。发布操作见 [维护文档](maintaining.md#发布插件)。

## 更新与客户端升级

### 插件更新

状态条 **⚙ → 插件更新** 提供「检查更新」「立即更新」和「自动更新」。

- **检查更新**不会安装；发现新版后可点「立即更新」。
- **自动更新默认开启**，首次运行检查，之后按 24 小时间隔检测与安装；你显式关闭的设置会保留。
- 更新代码会访问已注册来源，不上传用量数据；来源错误或网络失败会显示原因。
- 只支持本插件的用户级安装；不会替你启用已禁用的插件。
- 本地目录市场只刷新本地文件，**不会执行 `git pull`**。先自行更新源码，再刷新市场并更新插件。

手动刷新市场：

```text
/plugin marketplace update zusage-marketplace
```

之后在插件页更新本插件，新建或重新打开会话；若提示主进程文件变化，再完全退出并重开 ZCode。已安装插件是源码的独立副本，修改仓库不等于完成更新。

### ZCode 升级后状态条消失

客户端升级可能覆盖 `app.asar`。最直接的恢复方式是重跑 `install-overlay` 或 `python install.py`，成功后重启。

若希望插件在新建或恢复会话时自动修复，在已有运行配置中设置：

```json
{
  "plugin_auto_install_overlay": true
}
```

只合并这一项，不要覆盖其它设置。它**默认关闭**，与默认开启的 `plugin_auto_update` 是两个独立开关：更新插件不代表授权修改客户端。

自动修复不会直接调用斜杠命令，而是在启动钩子中执行同一个安装器；`SessionStart` 覆盖新建、清空和恢复会话（`startup|clear|resume`）。

自动修复后仍需完全退出并再次启动 ZCode。插件会请求助手给出重启提醒，不会自行重启。插件未启用、启动钩子没触发、无写入权限或客户端结构不兼容时，自动修复不能保证成功。

卸载产生的 `.plugin-overlay-optout` 会阻止重注入；删除它表示恢复参与自动安装/提示，而不是立即执行安装。

### 源码安装的更新

```bash
git pull
python install.py
```

状态条脚本和查询库通常可热更新；主进程文件、首次注入或安装目录改变时需重启。已安装文件的本地手改会受到插件同步保护，未覆盖内容会提示，不应为了升级直接删除个人配置。

## 配置

优先用状态条的 **⚙** 调整。需要直接编辑时，默认位置是：

```text
~/.zcode/zcode-token-usage-statusbar/config.json
```

Windows 对应用户目录下的 `.zcode\zcode-token-usage-statusbar\config.json`。下面是常用设置示例，**只修改需要的字段，保留现有配置**：

```json
{
  "lang": "zh",
  "hot_reload": true,
  "answer_rate_line": true,
  "plugin_auto_update": true,
  "plugin_auto_install_overlay": false,
  "context_window": 1000000
}
```

| 字段 | 说明 |
|---|---|
| `lang` | `zh` / `en`，查询报表语言 |
| `python_path` | Python 可执行文件；安装器会设置，无法启动 Python 时检查 |
| `hot_reload` | 状态条脚本是否热更新 |
| `answer_rate_line` | 插件回答末尾的速率行，默认开，下一问生效 |
| `plugin_auto_update` | 插件自动更新，默认开；损坏或非布尔配置不会启动更新 |
| `plugin_auto_install_overlay` | 自动修复客户端注入，默认关 |
| `context_window` | 自动识别失败时的上下文窗口大小兜底 |
| `resident` | 使用常驻 Python 查询进程，默认开 |
| `activity_min_ms` | 活跃期最小查询间隔，默认 1500ms |
| `heartbeat_ms` | 文件事件丢失时的兜底检查间隔，默认 30000ms |

配置是 JSON，不能直接粘贴带注释的示例。

## 远程会话

桌面客户端连接 SSH 远端 ZCode 时，数据在远端，本地查询不会自动拥有这些数据。将 `remote` 合并到运行配置：

```json
{
  "remote": {
    "enabled": true,
    "ssh": "ssh user@server",
    "script": "~/.zcode/zcode-token-usage-statusbar/zusage.py",
    "python": "python3",
    "timeout_s": 6,
    "poll_ms": 3000,
    "host_label": "我的服务器"
  }
}
```

远端部署同一份 `zusage.py`，且远端配置**不要再启用 remote**，避免递归。本地需能够通过该通道免交互执行命令。

`ssh` 也可以用参数数组指定其它通道：

- Docker：`["docker", "exec", "-i", "容器名"]`
- WSL：`["wsl", "-d", "发行版"]`
- Kubernetes：`["kubectl", "exec", "-i", "pod名", "--"]`

配置后远端会话出现 ☁ 标记。远端按 `poll_ms` 刷新，本地仍以数据库写入事件触发；不要把远端间隔设得低于 1000ms。

## 查询与数据口径

### 对话内查询

一键安装使用 `/usage`；插件的完整名称是 `/zcode-token-usage-statusbar:usage`：

```text
/usage
/usage today
/usage week
/usage sessions
/usage workspace:项目目录关键词
```

MCP 工具 `token_usage(scope)` 还支持 `days:N`、`sessions:N`、`models:days` 和 `session:会话ID前缀`。

### 终端查询

在仓库根目录运行：

```bash
python zusage.py today
python zusage.py days 7
python zusage.py sessions 10
python zusage.py models 7
python zusage.py workspace 项目目录关键词
python zusage.py session 会话ID前缀
python zusage.py watch
```

`json` 子命令供自动化工具使用。

### 数据如何计算

- 数据来自 ZCode 本地 SQLite，主要随请求完成入库刷新，不是逐字速度或账单。
- 总用量为输入 + 输出；缓存读取已在输入内，不再重复相加。思考明细取决于供应商是否上报。
- 当前实现将思考视为已包含在输出中；有思考的请求从请求开始计算生成耗时，其它请求从首字开始计算，段间工具等待不计入。
- 状态条速度看最近一段请求；回答速率行看当前提问已入库请求的加权速度，尚未入库的最终正文不在此次采样内。
- 上下文占比是最近请求输入量 ÷ 窗口容量，不是会话累计量 ÷ 容量；压缩后可能回落。
- 子智能体单独展示；工作区查询按父子关系合并，避免重复计算。会话移动到另一个工作区后，历史消耗归属可能随之变化。
- 状态条跟随各窗口的焦点会话；CLI/MCP 的 `current` 是查询库识别的近期活跃会话，不保证等同屏幕上当前窗口。

更深入的数据库和性能说明见 [设计笔记](design-notes.md)。

## 排查

| 现象 | 先做什么 |
|---|---|
| 装插件后没有状态条 | 新建或恢复会话，执行 `install-overlay`，确认成功后完全退出并重开 |
| ZCode 升级后消失 | 重新安装注入，再重启；检查自动修复是否开启 |
| 新会话都是零 | 完成一次模型请求后再查看 |
| 远端会话没有数据 | 确认远程配置、远端脚本和非交互通道可用 |
| Python 启动失败 | 检查 Python 命令与 `python_path`；Windows 的命令可能叫 `python` |
| 说已更新但没有变化 | 确认安装的是缓存副本而非仅改了仓库；按提示重开会话或重启 |
| 卸载后又有目录 | 确认插件、自动更新和旧主进程已停止，再删除目录 |

在仓库目录可运行状态检查（不修改注入；已注入时可能生成临时语法检查文件并调用客户端可执行文件）：

```bash
python3 plugins/zcode-token-usage-statusbar/overlay_install.py check
python3 patch_install.py check
```

运行目录中的 `plugin-session-start.json` 是启动钩子诊断，`plugin-update.json` 是更新状态，`diag-*.json` 是窗口诊断。没有自然启动事件记录时，手动脚本成功不能证明钩子自动执行过；空闲时窗口诊断不持续更新并不等于故障。

## 彻底卸载

**先停用，再清理文件。不要只删除运行目录。** 自动更新或仍在运行的主进程可能重建文件。

1. 如果使用插件，在 ⚙ 关闭自动更新；没有状态条时在现有配置中设置 `plugin_auto_update: false`。等待已经开始的更新结束。
2. 在插件仍启用时执行 `/zcode-token-usage-statusbar:uninstall-overlay`，确认成功。这会移除注入并留下阻止重注入的标记。
3. 在 **设置 → 插件 → 已安装 → ZCode Token Usage Statusbar → ⋯ → 卸载**。这是卸载插件组件，不负责移除外部状态条与个人配置。
4. 完全退出并重开 ZCode，确认状态条消失。若此前也用一键安装器注册过 `/usage`，在插件卸载后运行 `python install.py --remove` 清理独立注册与运行目录，再重启确认。
5. 不再需要插件市场时，在设置里移除 `zusage-marketplace`。保留供其它插件使用的市场和目录，不要删除整个 `.zcode`。
6. 备份想保留的 `config.json`，检查并删除本项目残留。

![卸载插件：已安装卡片的三个点菜单](plugin-uninstall.png)

插件已卸载才想起移除状态条？从仍保留的仓库执行：

```bash
python3 plugins/zcode-token-usage-statusbar/overlay_install.py remove
```

仅一键安装的用户直接执行 `python install.py --remove`，无需操作插件页。

### 需要检查哪些残留

以下为**默认位置**。ZCode 支持自定义 `storage.dir` / `ZCODE_STORAGE_DIR`，不要把默认路径当作全部安装的固定位置；按自己的设置查找。

- 客户端 `app.asar`：用 `patch_install.py check` 确认未注入，而不是删除该文件。
- 运行目录 `~/.zcode/zcode-token-usage-statusbar/`：脚本、个人设置、诊断与卸载标记。
- 插件缓存 `~/.zcode/cli/plugins/cache/zusage-marketplace/zcode-token-usage-statusbar/`：GUI 操作后检查是否残留，不要假定所有宿主版本都会清理同样的目录层级。
- 市场缓存 `~/.zcode/cli/plugins/marketplaces/zusage-marketplace/`：与市场注册分开检查，本地目录市场可能保留源码副本。
- 插件数据目录：按宿主显示的 `dataPath` 检查，不猜测固定子路径。
- 回答速率状态 `~/.zcode/zusage-rate.last-session.json` 及其 `.lock`：不在运行目录中，若保留过其它安装或多个会话，先确认没有继续使用它。
- 一键安装器的配置备份 `~/.zcode/cli/config.json.zusage.bak`：可能含完整客户端设置。只处理备份，**不要删除原 `config.json`**。
- `app.asar` 同目录的 `app.asar.zusage.tmp`、`.tmp.json`、`.lock` 和异常遗留的暂存文件：注入移除、所有相关进程退出后检查。成功卸载会清掉历史 `.bak`，但未知 TMP 可能保留用于排查；**不要手动把 TMP 覆盖回 app.asar**。
- 自行创建的卸载备份：保留与否由你决定。

文件清理请通过文件管理器逐项检查后删除。删除个人配置前先备份；运行目录只能在注入已移除、插件已卸载、旧进程已退出后删除。`installed_plugins.json`、`known_marketplaces.json` 是多插件共享库存，不应整文件删除。

### 卸载后确认

在仍保留的仓库运行：

```bash
python3 patch_install.py check
```

应显示未注入；然后确认：

- 插件页没有本插件的已安装条目。
- 状态条在完全重启后不再出现。
- 插件缓存和运行目录没有本项目残留（其它插件的市场父目录可能正常保留）。
- 不再使用该市场时，市场页已移除它，对应缓存也已清理。

不必为了卸载删除 `db.sqlite`；它是 ZCode 自己的用量与会话数据。
