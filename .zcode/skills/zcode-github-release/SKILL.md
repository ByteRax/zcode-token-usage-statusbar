---
name: zcode-github-release
description: "仅为当前 zcode-token-usage-statusbar 项目发版：检查、打包、校验并发布 GitHub 正式 Release，发布验收后更新 plugin-releases / GitCode 渠道清单、创建并合并源码 PR，或补充/修订已发布 Release 的更新说明。用户说「发版」「发布新版本」「创建 GitHub Release」「发布预演」「更新渠道清单」「补合并发布 PR」「改 Release 说明」时使用。默认只做只读检查与本地打包；提交、打 tag、发布、渠道推送须明确授权，完整发版包含同一目标仓库的源码 PR 合并。"
---

# 当前项目的 GitHub 正式 Release

## 确认项目、仓库与授权

- 本技能仅供所在仓库使用。以本技能目录向上三级得到项目根目录，验证该目录与 `git rev-parse --show-toplevel` 一致，且有 `marketplace.json`、`sync_plugin.py`、`release_tool.py`、`release_unpack.py` 和 `plugins/zcode-token-usage-statusbar/`。不要在其它项目或已安装插件缓存执行发布。
- 阅读 `AGENTS.md` §3（同步与冷文件）、§8（发布与外部操作边界）和 [开发与发布](../../../docs/maintaining.md#发布插件)。检查 `git status`、当前分支与 `git remote -v`，保留未提交及其它会话改动。
- 发布目标 `owner/repo` 由用户在授权中点明。本项目历次发布目标都是 `fork` 远程指向的 ByteRax 仓库；`origin`（xhwxt 上游）只读，不默认选它，也不因另一仓库有权限就切换。用 `gh repo view OWNER/REPO --json viewerPermission,defaultBranchRef` 核验权限与默认分支；目标只读则报告阻塞。
- 仅正式三段版本 `X.Y.Z`、tag `vX.Y.Z`，不将截图托管 Release 或开发分支提交当作正式版本。涨哪一位由用户决定，只在用户要求时修改版本，不顺手修其它代码。合同细节见 [发布包合同](references/release-contract.md)。

## 授权梯度与执行顺序

| 阶段 | 动作 | 授权 |
|---|---|---|
| A | 在发布 worktree 里改版本号（不提交）、同步/语法/测试检查、`build`、`verify`、升级链验证、起草更新说明 | 默认可做，只写独立 worktree 与临时目录 |
| B | 提交版本改动、打 tag、推送分支与 tag | 须明确授权 |
| C | `publish --dry-run` | 须先完成 B：preflight 要求相关文件已提交，且本地与远端 tag 都指向 HEAD |
| D | `publish --publish --confirm OWNER/REPO/vX.Y.Z` | 须明确授权，授权语点明仓库与版本；要同时镜像 GitCode Release 时还须点名 `--gitcode-repo` 与 GitCode 仓库（该写入在同一命令内、GitHub 验收后自动执行，无法拆到 D 之后） |
| E | `plugin-releases` / `plugin-releases-gitcode` 两个渠道分支的清单推送 | 须另行点名授权，且在 D 验收通过之后 |
| F | 源码 PR 创建与合并、GitCode 镜像 base 同步 | 用户明确授权完整发版时已包含 |

- 「授权完整发版」= B + D + F，其中 D 默认只含 GitHub；GitCode Release 镜像只在授权语点名 `--gitcode-repo` 时执行；E 不在其内，须另行点名。「仅发 Release」= B + D。创建/迁移技能本身不是发布授权。
- 新发布按以下顺序：确认目标提交与 PR 合并目标 → 在干净 worktree 检查/打包/升级链验证 → 起草说明 → 提交并过推 tag 闸门后推送（B）→ 带说明预演（C）→ 授权发布（D）→ 验收正文与资产 → 完成已授权的渠道更新并做更新端验证（E）→ 创建并合并源码 PR → 验收合并结果 → 同步 GitCode 镜像（F）。仅修订已有说明时跳到「修订已发布说明」，不重新发布或合并 PR。
- 用户只要求预演而 tag 尚未就绪：停在 A，报告「预演未执行；预期阻塞项：版本改动未提交、缺本地/远端 tag」，附 build/verify/升级链结果和待授权的 B 动作清单（要提交的文件、tag 名、推送目标）；不要为跑通预演自行打 tag 或推送。
- 完整正式发版默认包含发布后源码 PR 的创建与合并。确认本次发布授权时一并说明：合并到同一发布仓库的默认分支（通过 `gh repo view OWNER/REPO --json defaultBranchRef` 核实），仅包含已审查的本次发布提交；用户指定其它 base 时以其要求为准。用户明确授权完整发版后，不在发布成功后再次询问这项收尾；仅预演、仅 Release、仅修改说明或用户明确禁止合并时不执行，也不延伸到上游仓库。
- 未经用户针对**该具体动作**的明确授权，禁止 force push、移动或删除已推送的 tag、覆盖或删除已有 Release；「授权发版」不蕴含这些。

## 隔离：在干净 worktree 里发版

`release_tool.py` 的 preflight 要求发布相关文件无未提交/未跟踪改动，`--root` 必须是 git 顶层目录，ZIP 取工作区字节且须与 HEAD 逐字节一致。主工作区常有并行会话的未提交改动，在那里既通不过 preflight，build/测试还会撞到写文件瞬态而假失败。因此在项目根执行下面**二选一**，阶段 A–D 的命令都在该 worktree 内执行，`--root` 写它的绝对路径（下文记作 `/abs/.worktrees/release-vX.Y.Z`）；阶段 E、F 的 worktree 操作与最后的清理回到项目根（相对路径 `.worktrees/…` 在发布 worktree 里会嵌套建在它里面）：

```bash
git fetch fork
git worktree add -b release/vX.Y.Z .worktrees/release-vX.Y.Z fork/main     # 常规：需要新建版本提交
git worktree add --detach .worktrees/release-vX.Y.Z <目标提交>              # 仅当目标提交已在默认分支上且已含正确版本号
```

- 常规路径在 worktree 里改两份 `plugin.json`（内容须一致）与 `marketplace.json` 的版本号，改动留到阶段 B 才提交。分离路径没有本地分支，推送时只推 tag，源码 PR 阶段验收后跳过（目标提交本来就在默认分支上）。
- 遇到 `line endings differ from HEAD`：不要照 `docs/maintaining.md` 旧段落执行 `git rm --cached -r -q . && git reset --hard`（`AGENTS.md` §8 明令不要），换一个全新 worktree 检出后重做。

## 检查与打包（阶段 A）

- 核对两份插件 manifest 与市场条目版本/name 一致。
- `overlay.js` 的 `VERSION` 代际台账、升级链验证、重启要求判定，命令都在 [发布前检查](references/pre-publish-checks.md)；并行工作各自递增会出现同号不同义或乱序（实证：两处 v92 各指不同功能；热修 `v99.1` 被插到台账最前面），发现就按时间线重排。
- 在发布 worktree 根运行，测试失败先修复或报告阻塞，不能继续发布：

```bash
python3 -B sync_plugin.py --check
node --check overlay.js && node --check inject-main.cjs
node --test tests/*.test.cjs
python3 -B -m unittest discover -s tests -p 'test_*.py'
```

  漂移时先检查源文件，只同步项目自己的副本。红灯要先区分「环境基线」与「本次改动」：依赖本机已安装客户端的用例（如 `test_renderer_bridge` 读取真实 `app.asar` 的两个）会随客户端版本漂移变红，在未改动的目标提交上同样复现。基线红也要如实报告并等用户决定，不自行跳过。
- 直接使用仓库根 `release_tool.py` 与同目录可信 `release_unpack.py`，本技能不保存脚本副本。`build` 只读工作区文件，版本改动不必先提交：

```bash
python3 -B release_tool.py build --root /abs/.worktrees/release-vX.Y.Z --repo OWNER/REPO --out /new/artifact-directory
python3 -B release_tool.py verify --zip /new/artifact-directory/zcode-token-usage-statusbar-vX.Y.Z.zip --manifest /new/artifact-directory/release-manifest.json --repo OWNER/REPO
```

- 不覆盖已有未知资产目录。检查 JSON 输出、ZIP、SHA256、版本/tag/repository。发布包仅包含市场、许可证与插件运行所需白名单文件；不包含本项目发布技能、发布工具、用量数据、用户配置、凭据、缓存、锁或截图。`build` 另输出 `marketplace-release.json`，是渠道清单，不是第三个 Release 资产；根目录本地 `marketplace.json` 保持不变。
- **升级链验证**：build 之后、发布之前，用历史 tag 里的 `release_unpack.py` 校验新 ZIP，任何一版拒绝或取不到都不得发布。

## 生成更新说明

按 [更新说明规范](references/release-notes.md) 核实范围、撰写面向用户的 Markdown（含重启要求等必写项）。未发布的渠道、未安装的客户端、仅夹具验证的平台必须如实区分。使用 Write 保存为新的 UTF-8 `release-notes.md`，放在独立资产目录或临时目录，不混入 ZIP 或修改用户现有文件；拒绝空正文和仅项目名/版本的一行占位，发布工具不会自动编造说明。

## 提交与 tag（阶段 B，须授权）

1. 提交本次发布需要的**全部**改动，仅暂存这些文件，不使用 `git add .`：三个 manifest 的版本号；若阶段 A 重排了 `VERSION` 台账，还有根 `overlay.js`、插件副本和断言该代际号的测试（这类改动先向用户确认）。提交信息沿用 `release: vX.Y.Z`。默认分支上需提交时先创建分支（常规路径已在 `release/vX.Y.Z`）。
2. **推 tag 之前的闸门**。已推送的 tag 不能移动，而 preflight 的多数检查要等 tag 推送后才第一次运行，所以先在本地把它们跑出来：

   ```bash
   git status --porcelain --untracked-files=all          # 必须为空
   python3 -B release_tool.py build --root /abs/.worktrees/release-vX.Y.Z --repo OWNER/REPO --out "$(mktemp -d)/recheck"
   cmp /new/artifact-directory/zcode-token-usage-statusbar-vX.Y.Z.zip <recheck 目录里的同名 ZIP>    # build 是确定性的，应逐字节一致
   git tag vX.Y.Z                                        # 只打本地 tag，尚未推送
   python3 -B release_tool.py publish --root /abs/.worktrees/release-vX.Y.Z --zip /new/artifact-directory/zcode-token-usage-statusbar-vX.Y.Z.zip --manifest /new/artifact-directory/release-manifest.json --repo OWNER/REPO --notes-file /absolute/release-notes.md --dry-run
   ```

   预期这次 `--dry-run` **恰好**在查远端 tag 处失败（`gh api repos/OWNER/REPO/git/ref/tags/vX.Y.Z … Not Found (HTTP 404)`），这说明此前的检查（相关文件已提交且与 HEAD 逐字节一致、ZIP 等于当前源码、GitHub 远程匹配、本地 tag 指向 HEAD、gh 登录与推送权限）都通过了。更早失败（`dirty or untracked`、`ZIP is not the current repository source`、权限等）就修好、重新 build，必要时 `git tag -f vX.Y.Z`（只限尚未推送的本地 tag）再来一遍。再确认远端没有同名 Release 或 draft：`gh api 'repos/OWNER/REPO/releases?per_page=100' --paginate --jq '[.[] | select(.tag_name=="vX.Y.Z")] | length'` 应为 0。
3. 获准后推送：常规路径 `git push fork release/vX.Y.Z vX.Y.Z`，分离路径只推 `git push fork vX.Y.Z`。工具不会创建或推送 tag，缺 tag 时 preflight 直接失败，不让 GitHub 从默认分支默默创建。`fork` 的双 push URL 会同时推到 GitCode 镜像，GitCode 段失败如实报告，不阻断 GitHub 侧。
4. 万一推送后才发现要改提交，见 [发布失败与回退](references/publish-failures.md#tag-或提交需要变更)。

## 预演与正式发布（阶段 C、D）

- 先对已推送的 tag 执行带 `--notes-file` 的默认预演（命令同上一节第 2 步的最后一条）。预演仍联网只读 GitHub，不授予发布权限。这次应当完整通过：检查 JSON 的 `notesFile`、`notes` 和创建命令的 `--notes-file`；说明修改后必须重新预演。报告将发布的仓库、版本、目标 commit、tag、资产、更新说明及实际预演结果；源码未提交或 tag 未就绪时报告阻塞，不把 build 成功称为已发布。
- 仅在用户明确授权本次仓库与版本后，以同一说明再使用 `--publish --confirm OWNER/REPO/vX.Y.Z`。工具读取说明快照、建 draft、上传双资产、下载逐字节核验、检查 draft 正文并重查远端 commit，再转正式并核验正文/状态。授权语点名 `--gitcode-repo` 时同一命令会在 GitHub 验收后镜像 GitCode Release（需环境变量 `GITCODE_TOKEN`，缺失时 `--publish` 在创建 draft 之前就整体失败，见 [发布后收尾](references/post-release.md#gitcode-渠道)）。
- 失败保留现场，不盲删重建、不自行转正：draft 残留、已公开但核验不符等情形的处置见 [发布失败与回退](references/publish-failures.md)。
- 发布后通过 `gh release view vX.Y.Z --repo OWNER/REPO --json url,body,isDraft,isPrerelease,tagName,assets` 确认正式状态与两个资产；将 `body` 与说明比较（仅允许 CRLF 与末尾空白差异），报告真实 URL。正文缺失或不一致不是验收成功。
- 用户要求替换已发布版本时，按 [发布失败与回退](references/publish-failures.md#要求替换已发布版本) 存快照后停止，逐步取得授权。

## 修订已发布说明

用户明确要求补充/修订指定 Release 的说明即授权该正文编辑，不代表允许修改版本、tag、资产、渠道或其它 Release。流程（快照 → 按已发布 tag 的提交撰写 → `gh release edit --notes-file` → 回读比较）见 [更新说明规范](references/release-notes.md#修订已发布说明)；不要调用 `release_tool.py publish`，不要删除、重建或重传资产。

## 发布更新渠道清单（阶段 E）

- 正式 Release 验收通过后，获得独立渠道提交/推送授权，再将生成清单作为 `marketplace.json` 发布到同一仓库明确 ref，推荐 `plugin-releases`；预演只展示动作。GitCode 版清单发布到 `plugin-releases-gitcode`。
- 在项目根用独立 worktree 操作，不切换或清理脏开发工作区；已有分支从远端 tip 派生，新分支从已验证 tag 派生；仅提交清单。正常推送，禁止强推；推送前先核对清单 sha256 等于 Release 资产的 digest，推送后从远端读取并核对版本、完整 ZIP URL/hash/path 与本次资产。渠道未成功时不能声称远端更新可用。
- 新用户注册 `OWNER/REPO#plugin-releases`；已有注册不会自动切换，不修改用户市场注册。完整命令（detached worktree 的推送写法、GitCode 渠道、更新端验证）见 [发布后收尾](references/post-release.md)。

## 发布后合并源码 PR

- 阶段 F。正式 Release 正文与资产验收通过后，必须完成本次源码 PR 合并，不能把「Release 已发布、源码仅在发布分支」当作完整发版完成。渠道分支仅存市场清单，不作为源码 PR 的 head 或 base；补合并已发布版本时不重新打包或移动 tag。
- 用 `gh pr list --repo OWNER/REPO --state all --head HEAD_BRANCH --base BASE_BRANCH` 查找本次 PR；已有 open PR 则复用，已合并则验收后跳过，关闭未合并或不明确对应关系时先核对原因，不创建重复 PR。没有 PR 时用 `gh pr create --repo OWNER/REPO --head HEAD_BRANCH --base BASE_BRANCH --title ... --body-file ...` 创建，正文包含版本、Release 链接、修复范围和实际验证结果。
- 合并前读取 PR 的 `headRefOid`、`baseRefName`、`files`、`mergeable` 和 `statusCheckRollup`，核对 head 包含已验收 tag 的提交（`git merge-base --is-ancestor vX.Y.Z <headRefOid>`）且 diff 仅为本次已审查改动。检查失败、冲突、待运行检查或分支内容变化时停止并修复/重新验证，不使用 `--admin` 绕过规则。无检查时按真实状态记录，仍须具备已执行的本地测试证据。
- 优先使用 merge commit 保留已发布提交历史：`gh pr merge NUMBER --repo OWNER/REPO --merge --match-head-commit VERIFIED_HEAD`。仓库不允许该方式时，依据仓库策略选择可用方式并核对主分支的实际文件；不要强推，不移动已发布 tag，不因合并重传资产，也不自动删除分支（`release/vX.Y.Z` 发布分支按惯例保留）。
- 合并后用 `gh pr view NUMBER --repo OWNER/REPO --json state,mergedAt,mergeCommit,url` 确认 `MERGED`；重新读取远端 base tip，验证包含 merge commit，以及已发布提交的祖先关系（merge 方式）或等价文件内容。报告 PR URL、合并 commit 和 base。合并被阻止时明确标记「Release 已发布，PR 合并未完成」，不得宣称完整发版完成。
- 镜像同步：`gh pr merge` 只作用于 GitHub，GitCode 镜像的 base 分支不会自动跟进。合并验收后 `git fetch fork`，再执行 `git push fork refs/remotes/fork/BASE_BRANCH:refs/heads/BASE_BRANCH`，把刚取到的远端 tip 同时推给两个镜像主机；不要用 `git push fork BASE_BRANCH`：本地 base 分支常落后于远端而被拒，而且用本地分支推送失败后，本地的 `fork/BASE_BRANCH` 引用可能被改写成镜像的旧位置，之后按上面的写法推送会被 GitHub 判成非快进。所以推送前后都先 `git fetch fork`。回读 `git ls-remote gitcode BASE_BRANCH` 的 SHA 应等于合并后的 `fork/BASE_BRANCH`。镜像滞后不算发版失败，但收尾必须报告同步状态。
- 保留本地其它会话改动，远端合并不要求切换或清理脏工作区。若发布后增加技能/文档等必要收尾提交，应单独测试并明确它们位于 tag 之后，只进入 PR，不写成已发布包中的功能。

## 收尾

- 分别报告打包、升级链验证、提交/tag/推送、Release、渠道、更新端验证、源码 PR 合并及 GitCode 镜像 base 同步状态。未执行就明确写未执行；完整发版须给出已合并 PR 的 URL 与验证结果。
- GitCode 段推送失败时补配凭据重推即可，不据此重发或回滚 GitHub Release；要求 GitCode 渠道时报告 `--gitcode-repo` 的发布/上传/清单结果与 `plugin-releases-gitcode` 分支状态。全新 clone 没有双 push 配置，渠道推送只到 GitHub，需要镜像时显式加入推送目标（[双远程同步](../../../docs/maintaining.md#双远程同步)）。
- 回到项目根清理本次临时 worktree：`git worktree remove .worktrees/release-vX.Y.Z`（以及渠道 worktree）；删前确认发布提交已在远端或 tag 上，有未跟踪文件会被拒绝，先看是什么，不要直接 `--force`。保留 `release/vX.Y.Z` 分支。
- 不安装或覆盖用户缓存，不自动重启客户端。发布成功不等于用户已安装。
