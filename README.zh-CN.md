<div align="center">

# ZCode Token 用量状态栏

**用了多少 token，模型有多快，上下文还剩多少——一眼看清。**

给 [ZCode](https://zcode.z.ai) 对话窗口加一条实时用量状态栏。

[English](README.md) · 简体中文

Windows / macOS · Python 3.8+ · [MIT](LICENSE)

![状态条整体效果](docs/tour/shots/hero.png)

</div>

## 能做什么

- **看消耗**：本轮、当前会话和今日总用量，不用来回切设置页。
- **看速度**：生成速度、首字等待时间，模型快不快一眼可读。
- **防超限**：显示上下文占比，接近上限时变色提醒。
- **查明细**：悬停看缓存与思考 token，点击查看子智能体消耗，工具出错也有提示。
- **按需显示**：点 ⚙ 调整显示项、语言和插件更新设置。
- **对话内查询**：输入 `/usage` 查看报表；插件还支持在符合条件的回答末尾显示速率。

[查看功能截图与说明 →](docs/features.md)

## 快速开始

**用桌面客户端？** 选下面任意一种安装方式，不用两种都装。
**用自托管网页？** 请直接看 [Web 版安装](web/README.zh-CN.md)。

### 一键安装

先安装 [Python](https://www.python.org/downloads/) 和 [Git](https://git-scm.com/downloads)，在终端执行：

```bash
git clone https://github.com/xhwxt/zcode-token-usage-statusbar.git
cd zcode-token-usage-statusbar
python install.py
```

macOS 上若找不到 `python`，改用 `python3 install.py`。

**安装成功后，完全退出 ZCode，再重新打开。** 状态条会出现在对话窗口底部。

### 通过 ZCode 插件安装（本地目录）

适合希望在 ZCode 内管理安装、启停和更新的用户。插件提供**用量查询、回答速率和插件更新**；需要窗口底部的状态条时，再执行插件内置的安装命令，不必另跑 `python install.py`。

准备好包含 `marketplace.json` 的本项目源码，然后：

1. 打开 **设置 → 插件 → 添加插件市场**。
2. 点 **选择目录**，选择仓库根目录（不是 `plugins/` 子目录），添加市场。
3. 找到 **ZCode Token Usage Statusbar**，点击安装并保持启用。
4. 新建或重新打开会话，输入：

   ```text
   /zcode-token-usage-statusbar:install-overlay
   ```

5. 安装成功后，**完全退出并重新打开 ZCode**。

<details>
<summary>安装截图与命令方式</summary>

![添加插件市场：点击「选择目录」，选中仓库根目录](docs/plugin-marketplace-add.png)

也可以在 **ZCode 对话输入框**执行（将路径换成实际仓库目录）：

```text
/plugin marketplace add /绝对路径/到/zcode-token-usage-statusbar
/plugin install zcode-token-usage-statusbar@zusage-marketplace
```

`marketplace add` 只添加市场，第二条命令才安装插件；之后仍按第 4、5 步安装状态条。

</details>

**装插件不等于装状态条。** 只需要用量查询和回答速率的用户，可以跳过第 4、5 步。状态条安装会修改客户端文件，执行前请确认信任此项目。

**以后如何更新？**

1. 先更新本地源码，再在 ZCode 输入 `/plugin marketplace update zusage-marketplace` 刷新市场。
2. 在 **设置 → 插件 → 已安装** 更新本插件；有状态条时，也可在 **⚙ → 插件更新** 中检查并更新。
3. 更新后新建或重新打开会话；若提示主进程文件变化，完全退出并重开 ZCode。

ZCode 使用的是已安装副本，**修改仓库不等于更新插件**；本地目录市场也不会自动执行 `git pull`。
目前公开仓库的默认分支尚未包含插件入口，需使用包含 `marketplace.json` 的源码版本。
[更多安装、更新与排查说明 →](docs/user-guide.md#插件安装)

## 日常使用

- **悬停**：查看某项的详细数据。
- **点击子智能体**：展开各个任务的用量。
- **点击 ⚙**：隐藏不关心的项目、切换语言，或检查插件更新。
- **输入 `/usage today`**：查看今天的用量；`/usage week` 查看近一周。

插件命令的完整名称是 `/zcode-token-usage-statusbar:usage`。

## 安全与注意事项

- **用量数据不上传**：本地查询不联网；配置远程会话后会通过指定通道读取远端数据库。插件更新会联网下载代码。
- **状态条会修改客户端文件**：它不是 ZCode 原生功能。卸载时只移除本项目的注入，不回滚客户端版本。
- **ZCode 升级后可能需要重装状态条**：可以重新运行安装命令；插件可配置自动修复，修复后仍需重启。
- **只卸载插件，状态条可能还在**：请按下方步骤一并清理。

## 常见问题

**安装了插件，为什么没有状态条？**

插件默认不自动安装状态条。请运行 `install-overlay` 命令，确认成功后完全退出并重开 ZCode。

**数字怎么没有一直变化？**

主要在一次模型请求完成后刷新，不是逐字计数。新会话还没有请求时，显示零值是正常的。

**回答末尾为什么有时没有速率行？**

纯问答或当前提问尚无已入库数据时不会显示，避免误用上一轮数据。可在 ⚙ 中关闭「逐问速率行」。

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
2. 运行 `/zcode-token-usage-statusbar:uninstall-overlay`，确认成功。
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
