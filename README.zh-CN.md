<div align="center">

# ZCode Token Usage Statusbar · Token 用量与速度状态栏

**模型有多快、用了多少 token、上下文还剩多少——一眼看清。**

[ZCode](https://zcode.z.ai) 插件：在对话窗口常驻显示模型生成速度（tok/s）、首 Token 延迟（TTFT）、Token 用量与上下文占比。支持用量报表、子智能体明细和 MCP 查询。

A ZCode plugin for token usage monitoring, generation speed and context window tracking.

简体中文 · [English](README.en.md)

Windows / macOS / Linux · Python 3.8+ · [MIT](LICENSE)

![ZCode Token 速度状态栏宣传图](docs/promo/promo.png)

</div>

[快速安装](#快速开始) · [指标与统计口径](#指标与统计口径) · [常见问题](#常见问题) · [功能截图](docs/features.md)

> 非官方开源项目，与 ZCode 官方团队无关联。本地统计只读 ZCode SQLite 数据库，不上传用量；安装桌面状态条会修改客户端 `app.asar`，插件更新会联网。

## 能做什么

- **看速度**：生成速度、首字等待时间，模型快不快一眼可读。
- **看消耗**：本轮、当前会话和今日总用量，不用来回切设置页。
- **防超限**：显示上下文占比，接近上限时变色提醒。
- **查明细**：悬停看缓存与思考 token，点击查看子智能体消耗，工具出错也有提示。
- **按需显示**：点 ⚙ 调整显示项、语言和插件更新设置。
- **对话内查询**：输入 `/usage` 查看报表；插件还支持在符合条件的回答末尾显示速率。
- **看远端会话**：自动适配已连接的 SSH 工作区，按 `workspaceIdentity` 路由到不同服务器；各服务器的今日用量与错误独立，失败或暂未找到的会话持续重试，恢复会话与重连后继续查询。详见下方远端章节。

[查看功能截图与说明 →](docs/features.md)

## 指标与统计口径

| 指标 | 显示什么 | 如何理解 |
|---|---|---|
| 生成速度（tok/s，Token/s） | 最近有效请求的输出 Token ÷ 对应生成耗时 | 主要在请求完成入库后刷新，不是逐字流式测速 |
| 首 Token 延迟（TTFT） | 请求开始到首 Token 的等待时间 | 与输出速度分开看，可区分等待较久和生成较慢 |
| 本轮 / 会话 / 今日用量 | 不同范围的输入、输出与总 Token | 总量 = 输入 + 输出；缓存读取已含在输入中，思考已含在输出中，不重复相加 |
| 缓存命中率 | 缓存读取 Token ÷ 输入 Token | 悬停查看缓存与思考明细 |
| 上下文占比 | 最近完成请求的输入 Token ÷ 上下文窗口 | 不是会话累计；上下文压缩后占比可以下降 |
| 子智能体用量 | 与主会话关联的子任务消耗 | 展开查看各任务，便于分析多智能体工作流 |

**速度为什么可能与其他插件不同？** 普通请求的生成窗口为首 Token 到请求完成；上报思考 Token 的请求或 Claude 请求使用请求开始到完成的窗口。回答末尾速率行则按本问已完成有效段的“总输出 ÷ 总生成耗时”加权，不包含段间工具等待及尚未入库的收尾正文。端到端吞吐与上述生成速度的时间窗口不同，不宜直接横比。

状态条会向前查找最近有效速度样本；它不一定与最新一条请求对应。逐问统计有当前提问校验，但时间容差内连续提问仍有识别边界。详见[实现原理与数据口径](docs/design-notes.md)、[用户指南](docs/user-guide.md#数据如何计算)。

## 选择安装方式

| 你的场景 | 推荐入口 | 需要注意 |
|---|---|---|
| ZCode 桌面端，使用正式版 | 下方插件市场安装 | 正式版 `v1.5.2` 默认自动安装/修复；失败时用 `/install-overlay`，成功后完全退出并重启 |
| 本地开发或体验当前 main | 本地目录插件 / 独立安装器 | 本地源码需要自行更新；正式渠道不会自动跟随 main |
| 只查用量，不显示状态条 | 插件查询 / CLI / MCP | 纯 CLI 没有状态条 UI；插件用户按下方说明关闭自动安装 |
| 自托管 ZCode Web | [Web 部署指南](web/README.zh-CN.md) | 单独部署，不适用于在官方托管网页上直接安装 |

Python 3.8+，查询脚本使用 Python 标准库，无需额外 Python 包。桌面脚本使用客户端自带的运行环境；克隆源码安装才需要 Git。Windows / macOS 为主要桌面环境，Linux 已有路径与权限适配，仍需按发行版验证。

## 快速开始

> ⚠️ **首次安装悬浮状态条后不会立即显示，必须完全退出 ZCode 并重新启动，状态条才会加载。只关闭窗口不算退出。**
>
> **更新 ZCode 后，若状态条消失，需要先让插件重新注入，再额外重启一次 ZCode 才能恢复。** 更新时的自动重启不能替代注入成功后的这次重启，具体操作见[常见问题](#常见问题)。

**用桌面客户端？** 推荐通过插件安装，也可以选择下方的一键安装，无需重复安装。
**用自托管网页？** 请直接看 [Web 版安装](web/README.zh-CN.md)。

### 通过 ZCode 插件安装

插件提供**用量查询、回答速率和插件更新**。先安装 [Python 3.8+](https://www.python.org/downloads/)，然后任选一种方式添加插件。

#### 方式一：远程安装（无需下载源码）

在 **ZCode 对话输入框**依次执行：

```text
/plugin marketplace add ByteRax/zcode-token-usage-statusbar#plugin-releases
/plugin install zcode-token-usage-statusbar@zusage-marketplace
```

**安装后保持插件启用，新建或恢复会话以触发状态条安装。确认成功后，完全退出并重新打开 ZCode。** 若未自动安装，再执行 `/install-overlay`。插件安装完成不等于状态条已经加载。

也可以打开 **设置 → 插件 → 添加插件市场**，输入 `https://github.com/ByteRax/zcode-token-usage-statusbar#plugin-releases`，添加后找到 **ZCode Token Usage Statusbar** 并安装。此渠道安装经过校验的正式 Release，不跟随开发分支。

#### 方式二：本地目录安装

下载或克隆本仓库后：

1. 打开 **设置 → 插件 → 添加插件市场**，点击 **选择目录**。
2. 选择包含 `marketplace.json` 的仓库根目录（不是 `plugins/` 子目录），添加市场。
3. 找到 **ZCode Token Usage Statusbar**，点击安装。

也可在 ZCode 中执行，路径替换为实际仓库目录：

```text
/plugin marketplace add /绝对路径/到/zcode-token-usage-statusbar
/plugin install zcode-token-usage-statusbar@zusage-marketplace
```

<details>
<summary>查看添加插件市场截图</summary>

![添加插件市场：远程方式填写 GitHub 地址，本地方式点击「选择目录」](docs/plugin-marketplace-add.png)

</details>

#### 安装窗口底部的状态条

> **版本说明（2026-10-20）：** `#plugin-releases` 当前正式版为 [v1.5.2](https://github.com/ByteRax/zcode-token-usage-statusbar/releases/tag/v1.5.2)，已包含默认自动安装/修复与下方 SSH 支持。旧版 `v1.4.1` 默认关闭自动安装；仍使用旧版时可执行 `/install-overlay`，或先按下方步骤升级。

安装正式版 `v1.5.2` 或当前 main 插件后，保持插件启用，新建或重新打开会话，插件默认自动安装/修复状态条。**这会修改客户端的 `app.asar`，请确认信任此项目。安装成功后，必须完全退出并重新打开 ZCode**，只关闭窗口不算退出。

自动安装失败时，再手动执行以下兜底命令，按实际输出排查；成功后仍需完全退出并重开：

```text
/install-overlay
```

**只需要查询和回答速率？** 在 `~/.zcode/zcode-token-usage-statusbar/config.json` 中合并 `"plugin_auto_install_overlay": false`（保留其它设置），或运行 `/uninstall-overlay` 移除状态条并保留卸载豁免，阻止自动重注入与安装提醒。

配置文件不存在或缺少该字段时默认开启；已有的显式 `false` 会保留。环境变量 `ZUSAGE_PLUGIN_AUTO_INSTALL=1` / `0` 优先于配置，但不能绕过卸载豁免。未设置环境变量时，损坏配置或非布尔字段不会启用自动安装。

**以后如何更新？**

- **远程安装**：在 ZCode 输入 `/plugin marketplace update zusage-marketplace`，再到 **设置 → 插件 → 已安装** 更新本插件。
- **本地安装**：先自行更新本地源码，再执行同样的刷新和更新步骤；本地市场不会替你 `git pull`。
- 更新后新建或重新打开会话；若提示主进程文件变化，完全退出并重开 ZCode。

远程推荐使用 `#plugin-releases` 正式渠道，配套清单与发布包的地址、版本和 SHA256 一致。已从默认分支或本地目录添加市场的用户，来源不会自动切换；迁移步骤见 [用户指南](docs/user-guide.md#切换已有市场到正式渠道)。
[更多安装、更新与排查说明 →](docs/user-guide.md#插件安装)

### 一键安装（不通过插件）

先安装 [Python](https://www.python.org/downloads/) 和 [Git](https://git-scm.com/downloads)，在终端执行：

```bash
git clone https://github.com/ByteRax/zcode-token-usage-statusbar.git
cd zcode-token-usage-statusbar
python install.py
```

macOS 上若找不到 `python`，改用 `python3 install.py`。

**安装成功后，完全退出 ZCode，再重新打开。** 状态条会出现在对话窗口底部。

## 日常使用

- **悬停**：查看某项的详细数据。
- **点击子智能体**：展开各个任务的用量。
- **点击 ⚙**：隐藏不关心的项目、切换语言、切换 token 数量的万/亿单位（中文界面，默认开启），或检查插件更新。
- **输入 `/usage today`**：查看今天的用量；`/usage week` 查看近一周。

插件命令的完整名称是 `/zcode-token-usage-statusbar:usage`。

## SSH 远端支持（v1.5.2）

> 本节功能已包含在正式版 **v1.5.2**。旧版用户需更新插件安装副本/运行文件、完成安装或修复后，**完全退出并重启 ZCode**；仅更新仓库或刷新市场不会更新正在运行的注入文件。

### 功能与数据来源

- **自动连接适配**：从客户端保存的 SSH 工作区连接设置生成可用查询通道，并结合宿主提供的当前会话工作区身份识别远端。自动模式只查询已确认的远端 scope，不向历史服务器试探本地未知会话 ID。
- **多服务器精准路由**：会话 ID 与 `workspaceIdentity` 一起确定所属服务器；手动目标需配置对应的 `identity`，不能只写主机标签。不同工作区、窗口和服务器的数据不会仅因 ID 相同而混在一起。
- **独立今日用量与错误**：各目标保留自己的 `today` 和错误状态，不把某台远端的总量当成本地或另一台服务器的今日用量；一台失败不应阻断其它来源。
- **持续恢复**：查询失败或暂未找到会话时继续按退避规则重试，不永久放弃；恢复历史会话、切换工作区或 SSH 重连后，若重新取得可靠身份则继续远端查询。无法确认身份时不猜测服务器。

**主面板归属**：主标签页（`workspace-main`）与各分栏按本窗口实际会话节点的 SID 和工作区身份路由，不从共享的 last-session、pane-layout 或工作台分组历史推断归属，因此其它窗口切换会话或清除记录不会改变本窗绑定。身份由版本、资产 SHA256 和唯一节点锚点校验的 renderer 补丁随宿主渲染更新；本窗可信 workspace IPC 与任务列表继续校验身份。节点身份缺失、协议不匹配或 SID 不一致时不借其它分栏或历史远端数据：无桥且本窗没有任何远端证据时按同 SID 的本地记录显示，否则显示零值。当前身份补丁已登记的客户端为 3.15.3、3.16.1、3.16.2；表外版本先经严格结构校验（唯一锚点、混淆名绑定与 store 形状）自动推导后补丁，校验不过则跳过并降级为数据库轮询。升级安装后需完全退出并重启客户端，旧补丁或未知构建不会启用共享记录回退。本说明对应 v1.5.2 与当前 main；客户端兼容性仍受上述版本与结构校验限制。

### 使用前提与限制

1. **SSH 远端需手工部署同版本 `zusage.py`**，默认位置为 `~/.zcode/zcode-token-usage-statusbar/zusage.py`；远端需有 Python 3.8+，查询进程可读取该用户的 ZCode 数据库。自动适配连接不等于自动安装远端脚本，不能承诺完全零配置。
2. 本机必须能免交互执行查询通道。客户端保存的密码、加密私钥或口令**不能由插件解密并复用**；请自行配置 SSH key/agent 等认证。插件不会自动登录，也不会替你处理认证提示。
3. 远端查询带递归防护；远端只运行查询脚本，不需要在那里安装桌面状态条或再次启用远端转发。
4. 此支持仅覆盖**桌面状态条的 JSON 查询链**；MCP、`/usage` 和回答末尾速率不自动跨机取数。纯 CLI 没有状态条 UI；自托管 Web 按其独立部署文档处理。
5. 自动化夹具用于验证路由与恢复逻辑，不等同于每种桌面版本、SSH 认证方式或多服务器环境的实机验收。

### 配置开关与手动目标

`remote.auto` 默认 `true`，独立于旧单通道开关；`remote.enabled: false` 保留手动关闭旧 `ssh`/无身份 fallback，不关闭自动身份路由。手动 `targets` 以 `identity`/`identities` 覆盖同身份自动目标；关闭自动发现后需显式 `enabled: true` 才使用手动目标。示例仅合并需要的字段，身份值应替换为客户端实际 `workspaceIdentity`：

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

目标未设置的 `script`、`python`、`timeout_s` 继承 `remote` 顶层（单目标超时限制 1–6 秒）。彻底停用远端查询应同时设置 `auto: false`、`enabled: false`，可保留 `targets` 配置而不执行；`enabled: true` 允许旧 CLI `python3 zusage.py json <SID>`（SID/逗号列表协议）使用默认单通道 fallback。桌面始终发送 JSON 请求，`scopes: []` 禁止该 fallback；未知 main 不会借单通道查询远端，也不会猜历史身份。

失败时保留最近成功的工作区快照并提示过期/错误，首次无缓存才显示零值，不借用本地今日量；null/error 不清空最近成功显示。远端默认每 3 秒轮询（最少 1 秒），失败/未知持续退避重试；关闭后重开查询、配置与连接设置变更由心跳检测（默认 30 秒，最少 10 秒）。

**恢复边界**：插件不会替宿主自动重连 SSH；自恢复指统计链持续重试以及宿主恢复连接后的续查。缺少可信身份或归属歧义（如同 SID 多归属）时不会猜测。

配置开关、带身份的多服务器示例和恢复排查见 [远程会话指南](docs/user-guide.md#远程会话)。只合并需要的字段，保留个人设置。

## 安全与注意事项

- **用量数据不上传**：本地查询不联网；启用远端查询后经指定通道读取远端数据库，前提与限制见 [SSH 远端支持](#ssh-远端支持v152)。插件更新会联网下载代码。
- **状态条会修改客户端文件**：它不是 ZCode 原生功能。卸载时只移除本项目的注入，不回滚客户端版本。
- **更新 ZCode 后状态条消失？** 客户端更新可能覆盖原有注入；重新注入成功后，需要额外完全退出并重启一次 ZCode。具体步骤见下方常见问题。
- **只卸载插件，状态条可能还在**：请按下方步骤一并清理。

## 常见问题

**这是 ZCode 插件，还是通用的 LLM Token 监控工具？**

本项目依赖 ZCode 的会话与用量数据，面向 ZCode 用户。CLI 和 MCP 是查询入口，不表示可直接统计其他 AI 编程客户端的数据。

**能直接在浏览器或 SSH 服务器上安装桌面状态条吗？**

桌面状态条安装在本机 ZCode 客户端。自托管 Web 需要[单独部署](web/README.zh-CN.md)；SSH 远端只部署匹配的查询脚本与 Python，不安装桌面浮层。远端自动路由仍需免交互认证，且不覆盖 MCP、`/usage` 与回答末尾速率行。


**安装了插件，为什么没有状态条？**

正式版 `v1.5.2` 与当前 main 默认会在新建或恢复会话时尝试自动安装/修复；旧版 `v1.4.1` 或自动安装关闭时请执行 `/install-overlay`。确认安装成功后，完全退出并重开 ZCode。若失败，请按命令输出检查权限、配置与卸载豁免。仅重启不会修复尚未成功安装的状态条。

**更新 ZCode 后，为什么状态条不见了？**

ZCode 更新可能覆盖插件注入的客户端文件。更新后第一次打开 ZCode，是让插件重新注入；**注入成功后，还需要额外完全退出并重启一次 ZCode，新的注入才会加载。即使更新时已经自动重启过，也不能省略这一步。**

1. 保持插件启用，新建或重新打开会话，触发自动修复。
2. 若未开启自动安装或修复失败，在 ZCode 对话输入框执行 `/install-overlay`，按输出提示完成安装或排查。
3. 确认安装或修复成功后，**完全退出 ZCode，再重新打开**。只关闭窗口或重开会话不算重启。

通过一键安装而非插件安装的用户，请在仓库目录重新运行 `python install.py`（macOS 可用 `python3 install.py`），成功后同样需要完全退出并重启。

**数字怎么没有一直变化？**

主要在一次模型请求完成后刷新，不是逐字计数。新会话还没有请求时，显示零值是正常的。

**回答末尾为什么有时没有速率行？**

纯问答或当前提问尚无已入库数据时不会显示，避免误用上一轮数据。可在 ⚙ 中关闭「逐问速率行」。完全重启后，宿主恢复的历史轮可能缺少有效输出统计；没有保留的统计行或当前浮层的完整文本缓存时，这些轮不补造统计，也不因此显示「本轮统计不可用」。写在消息正文中的旧统计行不受影响。

**能显示套餐费用或剩余额度吗？**

这里显示 token 用量，不是账单。套餐费用与额度仍以 ZCode 官方页面为准。

[更多排查、自动更新和远程配置 →](docs/user-guide.md)

## 卸载

**一键安装的用户**，在仓库目录执行，然后完全退出并重开 ZCode：

```bash
python install.py --remove
```

**插件用户**，按顺序操作，避免只删插件却留下状态条：

1. 在 ⚙ 中关闭自动更新；若更新正在进行，等它结束。
2. 运行 `/uninstall-overlay`，确认成功。
3. 打开 **设置 → 插件 → 已安装 → ZCode Token Usage Statusbar → ⋯ → 卸载**。
4. 完全退出并重开 ZCode，确认状态条消失。

<details>
<summary>查看卸载截图</summary>

![插件卡片右侧三个点菜单中的「卸载」](docs/plugin-uninstall.png)

</details>

需要删除设置、缓存和插件市场？请看 [彻底清理步骤](docs/user-guide.md#彻底卸载)。

## 更多文档

- [功能截图](docs/features.md) · [安装、配置与排查](docs/user-guide.md)
- [Web 版](web/README.zh-CN.md) · [实现原理与数据口径](docs/design-notes.md)
- [开发与发布](docs/maintaining.md) · [测试说明](tests/README.md)

[MIT License](LICENSE)
