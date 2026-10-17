<div align="center">

# ZCode Token 实时速度状态栏

**模型有多快、用了多少 token、上下文还剩多少——一眼看清。**

给 [ZCode](https://zcode.z.ai) 对话窗口加一条实时速度状态栏。

简体中文 · [English](README.en.md)

Windows / macOS / Linux · Python 3.8+ · [MIT](LICENSE)

![ZCode Token 速度状态栏宣传图](docs/promo/promo.png)

</div>

## 能做什么

- **看速度**：生成速度、首字等待时间，模型快不快一眼可读。
- **看消耗**：本轮、当前会话和今日总用量，不用来回切设置页。
- **防超限**：显示上下文占比，接近上限时变色提醒。
- **查明细**：悬停看缓存与思考 token，点击查看子智能体消耗，工具出错也有提示。
- **按需显示**：点 ⚙ 调整显示项、语言和插件更新设置。
- **对话内查询**：输入 `/usage` 查看报表；插件还支持在符合条件的回答末尾显示速率。
- **看远端会话**：自动适配已连接的 SSH 工作区，按 `workspaceIdentity` 路由到不同服务器；各服务器的今日用量与错误独立，失败或暂未找到的会话持续重试，恢复会话与重连后继续查询。详见下方远端章节。

[查看功能截图与说明 →](docs/features.md)

## 快速开始

> ⚠️ **首次安装悬浮状态条后不会立即显示，必须完全退出 ZCode 并重新启动，状态条才会加载。只关闭窗口不算退出。**

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

> **适用范围：** 本文关于状态条默认自动安装/修复的说明仅适用于当前 `main` / 本地新版源码，尚未发布到正式渠道。`#plugin-releases` 的正式版 `v1.4.1` 仍默认关闭自动安装；请执行 `/install-overlay`，或在下述配置文件中合并 `"plugin_auto_install_overlay": true` 后新建或恢复会话。

安装当前 `main` 的本地新版源码插件后，保持插件启用，新建或重新打开会话，插件默认自动安装/修复状态条。**这会修改客户端的 `app.asar`，请确认信任此项目。安装成功后，必须完全退出并重新打开 ZCode**，只关闭窗口不算退出。

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

## SSH 远端支持（当前 main）

> 本节功能属于当前 `main` / 本地新版源码，**尚未发布到正式 Release**。只修改仓库不会更新正在运行的插件或注入文件；本机需更新插件安装副本/运行文件、完成安装或修复后，**完全退出并重启 ZCode**。现有正式渠道安装不代表已获得这些功能。

### 功能与数据来源

- **自动连接适配**：从客户端保存的 SSH 工作区连接设置生成可用查询通道，并结合宿主提供的当前会话工作区身份识别远端。自动模式只查询已确认的远端 scope，不向历史服务器试探本地未知会话 ID。
- **多服务器精准路由**：会话 ID 与 `workspaceIdentity` 一起确定所属服务器；手动目标需配置对应的 `identity`，不能只写主机标签。不同工作区、窗口和服务器的数据不会仅因 ID 相同而混在一起。
- **独立今日用量与错误**：各目标保留自己的 `today` 和错误状态，不把某台远端的总量当成本地或另一台服务器的今日用量；一台失败不应阻断其它来源。
- **持续恢复**：查询失败或暂未找到会话时继续按退避规则重试，不永久放弃；恢复历史会话、切换工作区或 SSH 重连后，若重新取得可靠身份则继续远端查询。无法确认身份时不猜测服务器。

**主面板归属**：主标签页（`workspace-main`）从宿主工作台分组持久化的主绑定读取「当前会话 → 工作区身份」配对——当前主会话恰好只被一个分组绑为主会话且该工作区是远端时自动路由；同 SID 出现任何第二个不同归属（含本地主叶分组：多窗口共享同一 localStorage，无法区分窗口）、身份不可信或与任务列表矛盾时按歧义处理，维持仅本地查询。partial 远端 IPC、历史候选或手动单通道兼容查询仍不构成主 pane 归属证据；归属未知时只上报本地 `sids`，不共享其它分栏同 SID 的远端数据，未知 main 显示本地匹配或 0。明确绑定远端工作区的右侧分栏（right）仍自动路由，可使用该分栏查看远端统计。

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

- **用量数据不上传**：本地查询不联网；启用远端查询后经指定通道读取远端数据库，前提与限制见 [SSH 远端支持](#ssh-远端支持当前-main)。插件更新会联网下载代码。
- **状态条会修改客户端文件**：它不是 ZCode 原生功能。卸载时只移除本项目的注入，不回滚客户端版本。
- **ZCode 升级后可能需要重装状态条**：插件默认自动修复，修复后仍需完全退出并重开；失败时再运行安装命令兜底。
- **只卸载插件，状态条可能还在**：请按下方步骤一并清理。

## 常见问题

**安装了插件，为什么没有状态条？**

保持插件启用，新建或重新打开会话以触发默认自动安装/修复；成功后完全退出并重开 ZCode。若自动安装失败，再运行 `install-overlay` 命令兜底，并检查权限、配置与卸载豁免。仅重启不会修复尚未成功安装的状态条。

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
