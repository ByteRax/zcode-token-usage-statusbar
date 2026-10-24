<div align="center">

# ZCode Token 速度状态栏

**让 ZCode 的对话窗口底部多一条小状态栏：模型有多快、token 花了多少、上下文还剩多少，一眼看到。**

给 [ZCode](https://zcode.z.ai) 桌面版用的第三方插件（不是官方功能），市场里的名字叫 **ZCode Token Usage Statusbar**。顺带送你一个命令行工具和一个 MCP 工具，随时能翻历史用量——不知道 MCP 是什么也没关系，不用它照样好用。

A ZCode plugin for token usage monitoring, generation speed and context window tracking.

简体中文 · [English](README.en.md)

Windows / macOS · Python 3.8+ · [MIT](LICENSE)

![ZCode Token 速度状态栏宣传图](docs/promo/promo.png)

</div>

**三步装上：**把下面这句话发给 ZCode：

```text
安装或者更新 zcode 插件 https://github.com/ByteRax/zcode-token-usage-statusbar#plugin-releases，执行完毕后，运行命令 /install-overlay
```

它会装好插件并执行 `/install-overlay` 装上状态条——要是它没自己跑，你就在对话框里手动敲一次。然后**完全退出 ZCode 再重新打开**（关窗口不算），底部就多出那条小状态栏了。句尾的 `#plugin-releases` 表示装的是正式发布的稳定版本，⚙ 里能自动更新，别把它删掉。

国内访问 GitHub 受限？上面那句可能连不上，换成这句再发给 ZCode（结尾的 `.git` 不能省，本机要装有 [Git](https://git-scm.com/downloads)）：

```text
安装或者更新 zcode 插件 https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode，执行完毕后，运行命令 /install-overlay
```

[快速开始](#快速开始) · [常见问题](#常见问题) · [功能截图](docs/features.md)

---

## 装好之后长什么样

对话窗口底部会多出一条窄窄的横条，大概是这样：

```text
⚡ 86 t/s │ 6.25万 90% 7次 Σ18.4s ⏱1.4s │ 144.85万 86% 23轮 187次 │ 142 🔴2 │ 342.18万 │ 23.64万 🟢 │ ⚙
  生成速度       本轮（这次提问）            会话累计（这次对话）       工具调用     今日合计    子智能体    设置
```

每一格说的是：

| 那一格 | 大白话解释 |
|---|---|
| ⚡ **86 t/s** | 模型刚才写字有多快（每秒吐多少 token）。完成一轮后按快慢上色：≥70 绿、40–70 黄、<40 红 |
| **6.25万 90% 7次 Σ18.4s ⏱1.4s** | 这一次提问：花了 6.25 万 token、缓存命中 90%（重复的内容不用重算，越高越省钱）、发了 7 次请求、最近一次跑了 18.4 秒、首字等了 1.4 秒 |
| **144.85万 86% 23轮 187次** | 这次对话从头到尾：共 144.85 万 token、聊了 23 轮、发了 187 次请求 |
| **142 🔴2** | 工具被调了 142 次，其中 2 次报错（红色小标记） |
| **342.18万** | 今天所有对话加起来花了 342.18 万 token |
| **23.64万 🟢** | 模型自己派的子任务（子智能体）花了 23.64 万 token，🟢 表示有子任务正在跑 |
| **⚙** | 点这里：想看哪几项、界面语言、token 用万/亿显示、检查更新 |

上下文用了多少不在状态条上：看输入框工具栏的**上下文按钮**（环形图标加百分比）。快满了会变色；内容多到被拒绝时，会弹窗告诉你该怎么办。点开它，里面还有一个**一键压缩**按钮。

**鼠标停在任意一格上，会弹出更细的数字。** 更多真实截图见[功能截图](docs/features.md)。

## 你想问的，怎么看

| 你想问的 | 去哪儿找 |
|---|---|
| 模型现在快不快？ | 最左边那格 **t/s**，颜色直接告诉你快慢 |
| 按回车之后等了多久才出字？ | **本轮**里的 ⏱ 那个数（首字延迟） |
| 这次提问 / 这次对话 / 今天一共用了多少 token？ | **本轮** / **会话累计** / **今日合计** 三格 |
| 会不会聊着聊着就写不下了？ | **上下文按钮**，快满了变色，点开有一键压缩 |
| 缓存省了多少？模型先「想一想」花了多少？ | 悬停 **本轮**，看输入、输出、缓存、思考的明细 |
| 模型派的子任务烧了多少？跑多快？ | **子智能体**格，运行中直接给「运行中 ×N · 估 X t/s」 |
| 套餐额度 / 余额还剩多少？ | 上下文按钮左侧的**额度 chip** |
| 工具是不是报错了？ | **工具调用**格，出错亮红点 |
| 翻历史用量 | `/usage`、终端 `zusage.py` 或 MCP 工具 `token_usage` |

> 状态条上的一切都是 **token 用量**，不是账单；额度 chip 显示的是账号级套餐池/余额，不是单模型独享。

## 功能一览

- **桌面状态条** — 跟着**你正在看的那个窗口的会话**走，每一格都能在 ⚙ 里单独关掉。
- **回答末尾的速率行** — 每个回答末尾追加一行小统计（速度、首字延迟、输出、耗时）。它和状态条不是同一个数：一轮中间调工具会拆成好几段请求，速率行把这轮已完成的几段合起来算总平均；数据还没记下来时干脆不显示。
- **Git 状态 chip** — 输入框工具栏的 `⎇ 分支 ↑↓ +N -N` 一眼看清仓库状态；工作目录本身不是仓库时，会自动汇总子目录里的多个仓库（`▣ 24仓 · 6改`）。只读本机 git，不联网、不改任何东西。
- **套餐额度 chip** — 上下文按钮左侧，显示套餐池各时间窗的已用比例与重置时间，或账户余额。除 BigModel / Z.ai 内置套餐外，⚙ 的额度面板里**选模板、只填 Key** 就能加别的厂商或自定义中转站；SCNet 没凭据也能按官方换算标准估算。凭据只在内存里用、只发对应厂商的官方域。支持程度见[额度支持矩阵](docs/quota-support-audit.md)，团队套餐暂不支持。
- **一键压缩上下文** — 上下文按钮点开后有个**压缩上下文**按钮，确认后向当前会话发送 `/compact`，不动输入框草稿。压缩通常要 2–4 分钟且没有进度反馈，期间发新消息会打断它，想压缩就等它跑完。
- **查询入口** — 同一份本地数据，三个入口：

```text
/usage today            # 对话框里查今天
python zusage.py week   # 终端里查近一周
token_usage(scope)      # MCP 工具
```

- **SSH / WSL 远端会话** — ZCode 跑在 SSH 服务器或 WSL 发行版里时，状态栏也能显示远端的用量数据：远端自动发现、各服务器独立统计、断了线会自动重试；远端机器上要自己装好查询脚本。详见[远程会话指南](docs/user-guide.md#远程会话)。

## 快速开始

### 你需要准备什么

- **ZCode 桌面客户端**（Windows / macOS 主力；Linux 部分路径要管理员权限，自行验证）。
- **Python 3.8+**，自带标准库就够，不用装任何第三方包。
- 不用装 Node.js 或 npm——状态栏跑在 ZCode 自带的 Node 环境里。

### 装法

推荐**插件**方式，在 ZCode 对话框依次执行：

```text
/plugin marketplace add ByteRax/zcode-token-usage-statusbar#plugin-releases
/plugin install zcode-token-usage-statusbar@zusage-marketplace
```

> **敲完先确认插件真的装上了**：看 **设置 → 插件 → 已安装** 里有没有出现 **ZCode Token Usage Statusbar**。第一条命令要联网克隆仓库，失败后可能一点痕迹都不留。国内直连 GitHub 超时的机器，把第一条换成 GitCode 渠道（结尾 `.git` 不能省）：
>
> ```text
> /plugin marketplace add https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode
> ```

开头那句自然语言指令，走的就是上面两条命令。其它装法：想自己改代码，用「**设置 → 插件 → 添加插件市场 → 选择目录**」指向仓库根目录；不想装插件，终端里 `git clone` 后跑 `python install.py` 一键安装；自托管 ZCode 服务器另有 [Web 版](web/README.zh-CN.md)。四种装法**选一个就行，别叠着来**，逐步说明见[安装指南](docs/user-guide.md#插件安装)。

### 装完之后，别忘了这三步

1. **插件装上并启用了** — 插件页里能看到它。
2. **状态条装进客户端** — 新建或恢复会话时会自动安装；自动失败就用 `/install-overlay` 手动来一次。这一步会**改动 ZCode 的程序文件（`app.asar`）**，你得自己确认信得过这个项目。
3. **完全退出 ZCode 再重新打开** — 关掉窗口不算，重开会话也不算。

**以后怎么更新？** 插件在 ⚙ 里点「检查更新」即可（自动更新默认开）；一键安装器进克隆目录 `git pull` 再重跑 `python install.py`。[更新与升级细节 →](docs/user-guide.md#更新与客户端升级)

### 我只想查用量，不想让它动我的客户端

在 `~/.zcode/zcode-token-usage-statusbar/config.json` 里**只加**这一项（别覆盖已有设置）：

```json
{
  "plugin_auto_install_overlay": false
}
```

这样 `/usage`、MCP 工具和速率行照常可用，插件不再碰客户端文件。状态条已经装过的，先跑一次 `/uninstall-overlay` 把它拆掉。

## 这些数字是怎么来的

数据从 ZCode 本地的 SQLite 数据库读出来（只读，不写入），不是模型自己报的，也不是账单估算；除生成速度外，各项都随「一次请求写进数据库」刷新一次，不会逐字跳动。正在生成时显示的 t/s 是按已输出字符估算的，这一轮完成后换成真实值。每个数的具体算法、容易搞混的口径（状态条速度 ≠ 速率行、上下文占比 ≠ 会话累计）见[数据口径](docs/user-guide.md#数据如何计算)。

## 心里有底的几件事

- **这不是 ZCode 官方功能**，是社区插件；状态条靠修改 ZCode 的程序文件（`app.asar`）实现，卸载时只删自己加的那部分。
- **本地数据库只读**，用量数据不上传；但插件更新要联网下载代码（⚙ 里可关自动更新）。
- **凭据边界**：ZCode 里存的 SSH 密码、私钥口令不会被插件解密使用；额度查询的凭据只在内存里用、只发对应厂商官方域，⚙ 里可整体关掉。
- **token 用量 ≠ 账单**：额度 chip 显示的是套餐接口的已用比例，不含现金余额与计费明细。

## 常见问题

**我装了插件，状态条呢？**

按[装完三步](#装完之后别忘了这三步)核对：插件在列表里 → 新建或恢复一个会话让它自动装上，失败就 `/install-overlay` 手动来一次 → **完全退出并重开 ZCode**。光重启救不了一个还没装进去的状态条。

**更新 ZCode 之后，状态条怎么没了？**

ZCode 更新时会把状态条改过的程序文件覆盖回原样。保持插件启用，新建或恢复会话触发自动修复，确认成功后再**完全退出重开一次**——哪怕更新时已经自动重启过。[详细步骤 →](docs/user-guide.md#zcode-升级后状态条消失)

**数字怎么不一直跳？**

数据是每次请求完成后刷新一次的，不是逐字滚动；刚开的新会话还没发过请求，显示 0 是正常的。

**能显示花了多少钱吗？**

现金账单不能，这里没有计费数据。套餐额度与余额可以——见上面的**套餐额度 chip**。

[更多排查 →](docs/user-guide.md#排查)

## 卸载

**一键安装的**：仓库目录里跑 `python install.py --remove`（macOS 用 `python3`），然后完全退出重开 ZCode。

**插件装的**：① ⚙ 里关掉自动更新 → ② 跑 `/uninstall-overlay` 确认成功 → ③ **设置 → 插件 → 已安装 → ZCode Token Usage Statusbar → ⋯ → 卸载** → ④ 完全退出重开 ZCode，确认状态条没了。别只删插件把状态条留在那儿。要把设置、缓存、插件市场一起清掉，见[彻底清理步骤](docs/user-guide.md#彻底卸载)。

## 更多文档

- [功能截图](docs/features.md) · [安装、配置与排查](docs/user-guide.md) · [额度支持矩阵](docs/quota-support-audit.md)
- [Web 版（自托管）](web/README.zh-CN.md) · [实现原理与数据口径](docs/design-notes.md)
- [开发与发布](docs/maintaining.md) · [测试说明](tests/README.md)

[MIT License](LICENSE)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ByteRax/zcode-token-usage-statusbar&type=Date)](https://www.star-history.com/#ByteRax/zcode-token-usage-statusbar&Date)
