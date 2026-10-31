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
| `renderer_bridge.py` | 渲染端会话节点身份桥：按版本指纹补丁，表外版本严格推导后自动补丁与回滚 |
| `zusage.py` / `usage_mcp.py` | 查询库、CLI、快照接口和 stdio MCP 工具 |
| `plugin-updater.cjs` / `plugin-release.cjs` | 插件更新调度、正式 GitHub Release 检测与更新日志拉取/缓存（`plugin-notes-cache.json`，非发布素材） |
| `plugin-storage.cjs` | 跟随宿主插件存储位置，不假设固定 HOME 路径 |
| `runtime_lock.py` / `release_unpack.py` | 跨进程锁、可信同步与受限安全解包 |
| `marketplace.json` | 本地源码市场入口 |
| `plugins/zcode-token-usage-statusbar/` | 可独立分发的插件包、命令、技能、钩子与运行文件副本 |
| `sync_plugin.py` | 从根运行文件同步插件副本，`--check` 检查漂移 |
| `release_tool.py` | 确定性打包、校验和需授权的 GitHub 发布 |
| `config.example.json` | 运行设置模板；真实 `config.json` 不入库 |
| `tests/` | 隔离回归、真实宿主 CLI 沙箱测试和交互演示 |
| `web/` | 自托管网页版本，和桌面版独立部署 |

插件专有入口位于包内：`overlay_install.py` 管理浮层安装；`token_rate.py` 查询逐问速率；`hooks/session-start.py` 处理会话启动；`hooks/prompt-submit.py` 记录提问并注入上一轮速率背景行。

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

## 渲染端桥与客户端升级

客户端官方升级会整体替换 `app.asar`，主进程加载器与渲染端桥都会被抹掉。`SessionStart` 钩子会自动重打加载器，并对渲染端桥调用 `ensure_deployed`（已注入时也幂等补一次）。

- 已登记版本按 `HOST_TARGETS` 的资产 SHA256 与混淆名精确补丁；版本已登记但资产哈希不符（宿主 build 漂移）仍 fail-closed 拒绝。
- 表外版本先走 `derive_target` 的严格推导：唯一 `styles-*.js`、唯一 SessionPane 锚点、注册表/key/topic 绑定、组件参数与 store 形状、topic import 目标全部核验通过才补丁；任何一项缺失或重复即跳过并降级为数据库轮询，状态条其它指标不受影响。
- 自动补丁带固定标记：表内版本按指纹还原，表外版本按标记剥离（字节还原），卸载链同样支持。
- 维护者登记新客户端版本时，可对原始 asar 直接推导出可粘贴条目：

```bash
python3 renderer_bridge.py derive /Applications/ZCode.app/Contents/Resources/app.asar
```

补丁后需完全退出并重启客户端才生效；桥只负责分栏/主标签页身份路由，缺失时降级为数据库轮询，不借用其它窗口或历史来源。

## 测试

在仓库根目录运行，不操作真实插件库存或客户端配置：

```bash
node --test tests/*.test.cjs
python3 -B -m unittest discover -s tests -p 'test_*.py'
python3 sync_plugin.py --check
```

真实 CLI 沙箱测试、交互演示与覆盖边界见 [tests/README.md](../tests/README.md)。Windows 收尾的隔离测试不等于 Windows 实机验收；手动执行钩子成功也不等于自然 SessionStart 已触发。

## 双远程同步

主仓库是 GitHub 的 ByteRax fork；GitCode（`tanranran/zcode-token-usage-statusbar`）是国内镜像。`fork` 远程配置了两条 push URL，`git push fork` 的任意 refspec（分支、tag、渠道分支）都会依次推送 GitHub 与 GitCode；`git fetch fork` 仍只读 GitHub。

- `origin` 指向上游 xhwxt，只读；`gitcode` 远程用于单独核对镜像或在主推送被拒时恢复，日常推送不需要单独调用。
- GitCode HTTPS 推送需要个人访问令牌：首次 `git push fork` 时按提示输入 GitCode 用户名与令牌（令牌作为密码），macOS 钥匙串随后缓存。令牌未配置的机器上 GitCode 段失败，但 GitHub 段可能已推送成功；两段都幂等，补配令牌后重推即可。改用 SSH 须先在 GitCode 登记公钥。
- GitCode 仓库由平台导入功能初始化，分支、tag 与渠道分支和 fork 一致；不要在 GitCode 单独提交，镜像分叉会让后续推送被拒。
- GitCode 承担两类角色：代码镜像，以及插件更新的国内渠道。更新渠道由 `plugin-releases-gitcode` 分支上的 GitCode 版渠道清单与 GitCode Release 资产构成；`release_tool.py publish --gitcode-repo …` 会在 GitHub 发布验收后自动创建/复用同 tag Release、上传 ZIP 与 manifest 并生成该清单（需 `GITCODE_TOKEN` 环境变量，令牌走 query 参数，不落盘、不进日志）。发布流程见[发布插件](#发布插件)。
- 从本仓库 `git worktree` 建立的临时工作区共享远程配置，渠道推送同样双发；全新 clone 没有该配置，只会推 GitHub，需要镜像时把 GitCode 显式加入推送目标。

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

### GitCode 更新渠道

国内用户可将市场注册到 `https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode`（宿主按通用 git 来源拉取清单，ZIP 从 GitCode Release 资产下载并核对 SHA256）。发布时在 `publish` 追加 `--gitcode-repo tanranran/zcode-token-usage-statusbar`：

1. 前提：GitCode 镜像上已有同一个 tag 且指向发布提交。创建 Release 的请求（`tag_name`、`name`、`body`）不带 `target_commitish`，GitCode 官方 API 文档写的是不传则取默认分支的最新提交，缺 tag 时可能据此建出指向错误提交的 tag（未实测）；发布前核对镜像上的 tag（附注 tag 要看 `^{}` 行）：`git ls-remote gitcode 'refs/tags/vX.Y.Z' 'refs/tags/vX.Y.Z^{}' | tail -n 1 | cut -f1` 须等于 `git rev-parse 'vX.Y.Z^{commit}'`，细节见发布技能的「GitCode tag 闸门」。GitHub Release 验收通过后，工具自动在 GitCode 创建（或复用）同 tag Release，正文与 GitHub 一致，上传同一字节的 ZIP 与 `release-manifest.json`，回读逐字节核对，再按真实 `browser_download_url` 生成 `marketplace-release-gitcode.json` 到资产目录。
2. 将该清单作为 `plugin-releases-gitcode` 分支根目录的 `marketplace.json` 提交并推送（与其它分支一样经双 push URL 同步两台主机；该分支内容刻意与 `plugin-releases` 不同，指向 GitCode 资产 URL）。
3. 回读两个渠道分支，核对版本、ZIP URL 与 hash。任一渠道未就绪都不得宣称该渠道可更新。

GitCode 渠道的清单 URL 形状、下载主机白名单（`gitcode.com`/`file-cdn.gitcode.com`）与更新器校验（`plugin-release.cjs` 的 gitcode 分支）必须一起变更，并有对应测试锁定；首次接入渠道时以真实上传回读的 URL 为准。

项目内的 [发布技能](../.zcode/skills/zcode-github-release/SKILL.md) 提供检查与预演流程，不全局安装，也不随插件分发。源码 manifest 提升版本不等于远端渠道或用户缓存已完成升级。

## 数据与性能

- 数字主要在模型请求完成入库后刷新，不把“查询实时”说成“流式逐字速率”。
- 本地以数据库写入事件触发查询，保留丢失事件的兜底心跳；常驻 Python 占用内存，不能笼统称“空闲零进程”。
- 远程查询有明确轮询周期，自动更新也有独立网络行为。
- 速度按 output（已含思考）计算；思考段（含 Claude 这类不单独上报思考的模型）使用请求开始至结束的时长，避免漏计首字之前的生成。

更多挂载约束、统计口径与诊断字段见 [设计笔记](design-notes.md) 和 [用户指南](user-guide.md#数据如何计算)。旧笔记中的测量值是特定版本的记录，不作为当前平台的性能保证。
