# Release 更新与发布（1.4.0）

## 更新端如何选择来源

“远端用户”按官方已注册的 `zusage-marketplace` 来源判断，不按电脑位置、SSH 或工作区远程状态判断。

- `directory`：沿用本地市场刷新与官方更新，本项目不执行 `git pull`。
- `github`，或 GitHub 的 `git` URL：检测该仓库的正式 Release。
- 其它远端或损坏/缺失的来源：明确失败，不默默改为本地来源或开发分支。

官方插件存储路径统一解析用户 `~/.zcode/cli/config.json` 的 `storage.dir`、CLI cwd（home）对应的项目配置及 `ZCODE_STORAGE_DIR`。三个入口——市场注册、安装记录、市场缓存——使用同一 root；子 CLI 通过环境变量固定该 root。配置损坏或更新期间 root 变化会停止，不读错默认库存。

## 检测和安装顺序

1. 枚举 GitHub Release 列表，按数字三段版本选择最高的 `vX.Y.Z`。排除 draft、prerelease、截图 tag，以及缺少正式双资产的记录；不使用 `/releases/latest`。
2. “检查更新”只检测，不下载安装。没有符合合同的正式发布时显示错误，不声称已最新。
3. 更新时下载 `release-manifest.json` 与 `zcode-token-usage-statusbar-vX.Y.Z.zip`。校验同仓库/tag/版本/插件身份、资产 URL、大小和 SHA256。
4. 使用本机可信 `release_unpack.py` 检查完整白名单、ZIP 路径/类型、真实压缩流、CRC、大小、JSON、组件和 hook/MCP 引用，再解包到私有临时目录。不会执行包中的代码。
5. 刷新原注册市场，读取官方缓存清单，确认版本和 ZIP URL/hash/path 与选定 Release 相同；市场事务未结束则停止。开发用相对 source 不满足远端 Release 合同。
6. 重读来源/ref、版本、自动开关及插件启用状态，然后调用官方 `install <原插件ID> --scope user`。采用 install 是为了避免 update 再次刷新市场；不手写官方缓存或安装记录。
7. 安装记录必须提交选定版本和同一完整 source，才同步稳定运行目录。持久意图保存 Release/manifest/注册来源；安装超时或父进程退出后仍按此合同恢复，错误提交不能在下一次启动绕过校验。
8. 清理自己创建的临时下载目录；本地热修仍按可信基线保留，主进程模块变化仍提示完全退出再启动客户端。

自动更新缺省开启、显式 false 保持关闭、24 小时限频、检查期间可关闭，均沿用既有行为。已开始的官方安装会完成，关闭只阻止尚未启动及之后的安装。不会自动启用禁用插件或修改自动重注入授权。

## 官方接口限制与信任边界

官方安装器支持带 SHA256 的 URL ZIP source，但没有“按原插件 ID 导入预下载目录”或 expected-version/SHA 的原子安装参数。所以更新器先验证一份下载，再由官方安装器按清单下载一次。外部官方操作不遵守本项目锁，仍存在清单读写的时间窗口；安装后和恢复时的精确身份校验用于阻止不符版本的运行时同步，不保证其它进程从不改变官方缓存。

SHA256 来自同仓库 Release 的 manifest，只能校验完整性，不是独立签名。信任前提是用户注册的仓库与 GitHub HTTPS；不能防止仓库或发布账号同时被攻破。当前仅支持公开仓库，无认证下载，不读取 gh token、不继承 URL 凭据或自定义下载 headers。网络请求有超时、重定向和大小边界。

固定白名单意味着未来新增插件组件时，维护者必须同时更新发布工具与安全解包合同，并发布新版校验器；不会对未知文件自动放宽。

## 发布端与新 skill

- 项目级 skill：[`zcode-github-release`](../.zcode/skills/zcode-github-release/SKILL.md)，仅位于本项目 `.zcode/skills/zcode-github-release/`。
- 不全局安装，不随插件分发。技能直接调用本仓库根 `release_tool.py` 与可信 `release_unpack.py`，不维护额外脚本副本。
- ZCode 在当前工作区及仓库根扫描 `.zcode/skills/`；当前会话的技能列表不保证立即刷新，项目文件存在与客户端已加载应分别描述。

用自然语言“使用 GitHub 发布技能做发布预演”触发；新版技能被客户端加载后，也可按客户端提供的技能名称调用。默认只做检查、测试、构建和发布预演，创建 skill 不是正式发布授权。

```bash
python3 -B sync_plugin.py --check
node --test tests/*.test.cjs
python3 -B -m unittest discover -s tests -p 'test_*.py'
python3 -B release_tool.py build --root /absolute/project --repo OWNER/REPO --out /new/artifact-directory
python3 -B release_tool.py verify --zip /new/artifact-directory/zcode-token-usage-statusbar-vX.Y.Z.zip --manifest /new/artifact-directory/release-manifest.json --repo OWNER/REPO
python3 -B release_tool.py publish --root /absolute/project --zip /new/artifact-directory/zcode-token-usage-statusbar-vX.Y.Z.zip --manifest /new/artifact-directory/release-manifest.json --repo OWNER/REPO --dry-run
```

构建输出：

- ZIP：确定性排序/时间/权限，只打包市场、MIT LICENSE 和完整插件源码，不含用户配置、usage、凭据、缓存、日志、锁或截图。
- `release-manifest.json`：仓库、版本、tag、插件 ID、ZIP name/size/hash。
- `marketplace-release.json`：第三个本地渠道清单，不进 ZIP，也不是第三个 Release 资产；复制市场元信息，唯一插件 source 改为官方 URL ZIP + SHA256。

ZIP 内市场仍指向相对插件目录，避免 ZIP hash 自引用。源码根本地 `marketplace.json` 保持本地 source。

发布预演要求源码与已提交 HEAD 逐字节一致、相关文件干净、显式目标是配置的 GitHub remote、本地/远端 tag 指向同一 HEAD、有写权限且同 tag Release（包括 draft）尚不存在。未提交源码或缺少 tag 会安全阻塞，不能把该结果当工具失效。工具不会创建或推送 tag。

真实发布须用户明确授权该仓库/版本及动作，再传 `--publish --confirm OWNER/REPO/vX.Y.Z`。工具建 draft、上传双资产、下载逐字节确认、重查 tag commit，最后转正式并验证状态。失败保留 draft，不 force、不覆盖、不自动删除重建。

## 渠道清单发布闭环

仅发布 GitHub Release 不足以让官方市场按 ZIP 安装。完成正式资产验收后，按 skill 的独立授权步骤，把生成清单作为 `marketplace.json` 正常提交/推送到明确的同仓库 ref，推荐 `plugin-releases`：

- 使用独立临时 clone/worktree，不切换、reset 或清理用户正在开发的脏工作区。
- 先读取原渠道清单，版本不可倒退，不改不相干插件或内容；已有 ref 从远端 tip 派生，新 ref 从已验证正式 tag 派生。
- 仅暂存/提交清单，正常推送，不强推；之后从远端读取并核对 source 与双资产。
- 新远端用户注册 `OWNER/REPO#plugin-releases`。已有默认分支注册不自动迁移；维护者需在原 ref 提供一致清单，或由用户明确选择迁移。

Release 和渠道清单分别报告成功。渠道缺失/不符时检测可发现版本，但安装会安全停止。

## 验收范围

自动测试使用临时 HOME、库存、源码包及 gh/网络夹具，覆盖实际 build → verify → download → unpack、更新分流、错误恢复和发布顺序。官方 CLI smoke 在 macOS 沙箱中运行，拒绝真实 HOME/仓库/asar 读取、临时目录外写入和网络。URL ZIP catalog 的官方校验会提示远端文件检查延后至安装；清单格式验证不等于真实公网安装验证。

项目作用域迁移后验收：**151 项 Node、222 项 Python 全部通过（Python 中包含 17 项速率回归）**。Release 更新器 72 项、检测下载 12 项、存储解析 11 项，以及发布工具 30 项、安全解包 34 项、真实源码集成 9 项均包含在总数内。项目 skill 的格式校验通过，全局目录及全局 `.skill` 包已移除，插件分发不包含发布技能或发布工具；技能直接调用仓库根脚本。源码发布包构建与校验通过，项目技能已单独放行 Git 忽略规则，可随仓库纳入版本控制。此前完整源码经官方 `plugins validate` 校验无诊断，URL ZIP 渠道格式校验成功；远端源验证被官方延后到安装。发布预演因相关文件未提交而安全阻止，未执行实际发布。

本机只读核查仍为 **1.2.3 用户级安装、本地 directory 市场、自动更新开启**；本轮没有替换此库存。

本轮不提交、不创建/推送 tag、不创建真实 Release、不改本机市场注册或官方缓存、不修改真实 app.asar、不重启客户端。源码 1.4.0 不等于本机安装版本或 GitHub 已发布版本；未有正式资产时不能宣称已完成公网升级验收。
