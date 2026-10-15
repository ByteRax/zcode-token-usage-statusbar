# 开发与发布

[返回首页](../README.zh-CN.md) · [用户指南](user-guide.md) · [测试说明](../tests/README.md)

首页只介绍安装与使用。本页保留文件结构、实现约束和发布流程，供维护者参考。

## 文件说明

| 文件或目录 | 用途 |
|---|---|
| `install.py` | 桌面一键安装与卸载，管理运行目录、独立 MCP 和 `/usage` 注册 |
| `patch_install.py` | 在客户端入口增删本项目注入行，自检后原子替换；不靠备份回滚客户端 |
| `install_monitor.py` | 提醒重启、确认加载，以及受校验的待替换文件收尾 |
| `overlay.js` | 桌面状态条、明细面板和 tooltip |
| `inject-main.cjs` | 主进程加载器，跟踪窗口会话，监听数据库变化并推送快照 |
| `zusage.py` / `usage_mcp.py` | 查询库、CLI、快照接口和 stdio MCP 工具 |
| `plugin-updater.cjs` / `plugin-release.cjs` | 插件更新调度与正式 GitHub Release 检测 |
| `plugin-storage.cjs` | 跟随宿主插件存储位置，不假设固定 HOME 路径 |
| `runtime_lock.py` / `release_unpack.py` | 跨进程锁、可信同步与受限安全解包 |
| `marketplace.json` | 本地源码市场入口 |
| `plugins/zcode-token-usage-statusbar/` | 可独立分发的插件包、命令、技能、钩子与运行文件副本 |
| `sync_plugin.py` | 从根运行文件同步插件副本，`--check` 检查漂移 |
| `release_tool.py` | 确定性打包、校验和需授权的 GitHub 发布 |
| `config.example.json` | 运行设置模板；真实 `config.json` 不入库 |
| `tests/` | 隔离回归、真实宿主 CLI 沙箱测试和交互演示 |
| `web/` | 自托管网页版本，和桌面版独立部署 |

插件专有入口位于包内：`overlay_install.py` 管理浮层安装；`token_rate.py` 查询逐问速率；`hooks/session-start.py` 处理会话启动；`hooks/prompt-submit.py` 记录提问与注入统计指令。

## 为什么插件仍需要客户端注入

当前插件体系提供命令、技能、子智能体、MCP 和钩子，但没有本项目所需的原生状态栏挂载接口。插件**可以作为安装渠道**：由命令或启动钩子运行安装器，给客户端 `app.asar` 主入口写入加载器引用。安装渠道与渲染方式是两回事，不是“能注入就不能做成插件”。

加载器运行于 Electron 主进程，向每个窗口注入状态条并跟踪其焦点会话。查询使用本地数据库，窗口间不靠全局最近会话猜测。Web 版没有 asar，改用 nginx 注入与只读旁挂服务。

入口引用使用绝对 `file://` 地址与动态 import，指向稳定运行目录，而不是带版本号的插件缓存。这样插件升级换缓存路径不会让客户端引用失效。

客户端打包结构或完整性策略改变时，这条非原生路线可能不再兼容；不得把自动修复描述为无条件保证。

## 运行目录与开发模式

标准安装的运行目录为 `~/.zcode/zcode-token-usage-statusbar/`，包含脚本、个人配置和诊断。标准安装不直接依赖 clone 目录，但**本地插件市场后续更新仍需要其配置的来源目录**，不能一概建议删除源码。

开发时可直接引用仓库：

```bash
python install.py --dev
```

此时不要删除或移动仓库。重跑不带 `--dev` 的安装器可切回稳定目录。

代码修改后先检查并同步插件副本：

```bash
python3 sync_plugin.py
python3 sync_plugin.py --check
node --check overlay.js
node --check inject-main.cjs
```

不要通过直接删运行目录来更新文件；同步器用可信 hash 基线保护本地热修、协调并发更新。overlay 与查询库可热更新，主进程文件仍需完全重启。

## 测试

在仓库根目录运行，不操作真实插件库存或客户端配置：

```bash
node --test tests/*.test.cjs
python3 -B -m unittest discover -s tests -p 'test_*.py'
python3 sync_plugin.py --check
```

真实 CLI 沙箱测试、交互演示与覆盖边界见 [tests/README.md](../tests/README.md)。Windows 收尾的隔离测试不等于 Windows 实机验收；手动执行钩子成功也不等于自然 SessionStart 已触发。

## 发布插件

普通用户无需运行发布工具。

### 本地打包与校验

同步源码，保持两个插件 manifest 与市场版本一致。在仓库根目录执行，输出目录必须尚不存在：

```bash
python3 sync_plugin.py
python3 release_tool.py build --repo OWNER/REPO --out /tmp/zusage-release-build
```

`OWNER/REPO` 要换成明确的目标仓库。构建生成：

- `zcode-token-usage-statusbar-v版本号.zip`
- `release-manifest.json`
- `marketplace-release.json`

再次校验，把 ZIP 路径换成构建输出的实际路径：

```bash
python3 release_tool.py verify --repo OWNER/REPO \
  --zip /tmp/zusage-release-build/zcode-token-usage-statusbar-v版本号.zip \
  --manifest /tmp/zusage-release-build/release-manifest.json
```

打包只包含枚举的分发源码，不收集本地配置、数据库、诊断或个人备份；校验器检查身份、文件集、SHA256 和安全解包。

### 发布预演与正式渠道

`release_tool.py publish --dry-run` 使用同样的 `--repo`、`--zip` 和 `--manifest` 参数，并必须提供 `--notes-file /绝对路径/release-notes.md`。先核对上一正式 tag 到目标提交的实际变化，生成包含修复、升级注意和验证结果的非空 UTF-8 更新说明；不要只填版本号。预演会展示完整正文，说明变化后应重新预演。预演仍要求相关源码已提交、目标仓库权限可用、本地与远端 tag 指向该提交且 Release 尚不存在；它不是绕过这些前置条件的离线检查。

发布包取工作区字节，必须与 HEAD 逐字节一致。`.gitattributes` 固定 `eol=lf`，Windows 新检出也是 LF；在此之前检出的 Windows 工作区可能仍是 CRLF，预演会报 `line endings differ from HEAD`。先提交或暂存改动，再执行 `git rm --cached -r -q . && git reset --hard` 重新检出。

正式发布还需明确 `--publish` 与 `--confirm OWNER/REPO/v版本号`，先上传草稿并核验下载字节，再发布。提交、tag 推送、Release 和渠道清单推送分别需要授权；默认不替用户执行。

GitHub 自动更新要求已注册市场的 `marketplace.json` 指向同一个 Release ZIP/hash。维护者应将生成的 `marketplace-release.json` 作为渠道分支上的 `marketplace.json` 发布。[ByteRax 的 `plugin-releases` 渠道](https://github.com/ByteRax/zcode-token-usage-statusbar/tree/plugin-releases) 已发布 `v1.4.0` 一致清单，新用户注册 `ByteRax/zcode-token-usage-statusbar#plugin-releases`。未来发版须同步更新该清单，不能只上传 Release；不要擅自切换用户已有来源。

项目内的 [发布技能](../.zcode/skills/zcode-github-release/SKILL.md) 提供检查与预演流程，不全局安装，也不随插件分发。源码 manifest 提升版本不等于远端渠道或用户缓存已完成升级。

## 数据与性能

- 数字主要在模型请求完成入库后刷新，不把“查询实时”说成“流式逐字速率”。
- 本地以数据库写入事件触发查询，保留丢失事件的兜底心跳；常驻 Python 占用内存，不能笼统称“空闲零进程”。
- 远程查询有明确轮询周期，自动更新也有独立网络行为。
- 速度按 output（已含思考）计算；思考段使用请求开始至结束的时长，避免漏计首字之前的生成。

更多挂载约束、统计口径与诊断字段见 [设计笔记](design-notes.md) 和 [用户指南](user-guide.md#数据如何计算)。旧笔记中的测量值是特定版本的记录，不作为当前平台的性能保证。
