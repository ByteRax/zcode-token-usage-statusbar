---
name: zcode-github-release
description: "仅为当前 zcode-token-usage-statusbar 项目准备、校验并发布 GitHub 正式 Release，发布验收后创建并合并源码 PR，或根据提交补充/修订已有 Release 更新说明。发布新版、创建 GitHub Release、发布预演、补合并发布 PR 或修改发布说明时使用；默认只做检查、打包和预演，正式发布须明确授权，完整发版包含同一目标仓库的源码 PR 合并，渠道发布须独立授权。"
---

# 当前项目的 GitHub 正式 Release

## 确认项目与仓库

- 本技能仅供所在仓库使用。以本技能目录向上三级得到项目根目录，验证该目录与 `git rev-parse --show-toplevel` 一致，且有 `marketplace.json`、`sync_plugin.py`、`release_tool.py`、`release_unpack.py` 和 `plugins/zcode-token-usage-statusbar/`。不要在其它项目或已安装插件缓存执行发布。
- 阅读项目指令，检查 `git status`、当前分支与 `git remote -v`，保留未提交及其它会话改动。用户只要求预演时不提交、不打 tag、不推送、不发布。
- 要求明确发布目标 `owner/repo`；核对本项目配置的 `fork` / `origin`，不默认选 origin，也不因另一仓库有权限就切换。使用 `gh repo view OWNER/REPO --json viewerPermission` 核验权限；目标只读则报告阻塞。
- 完整正式发版默认包含发布后源码 PR 的创建与合并。确认本次发布授权时一并说明：合并到同一发布仓库的默认分支（通过 `gh repo view OWNER/REPO --json defaultBranchRef` 核实），仅包含已审查的本次发布提交；用户指定其它 base 时以其要求为准。用户明确授权完整发版后，不在发布成功后再次询问这项收尾；仅预演、仅 Release、仅修改说明或用户明确禁止合并时不执行，也不延伸到上游仓库。
- 阅读 [发布包合同](references/release-contract.md)。仅正式三段版本 `X.Y.Z`、tag `vX.Y.Z`，不将截图托管 Release 或开发分支提交当作正式版本。

## 生成更新说明

- 新发布按以下顺序执行：确认目标提交与 PR 合并目标 → 生成说明 → 检查/打包 → 带说明预演 → 授权发布 → 验收正文与资产 → 完成已授权的渠道更新 → 创建并合并源码 PR → 验收合并结果。仅修订已有说明时跳到「修订已发布说明」，不重新发布或合并 PR。
- 阅读目标仓库的正式 Release 与 tag。仅选已发布、非 draft、非 prerelease 的 `vX.Y.Z`，并确认上一版本是目标提交的祖先；排除 `screenshots-*` 和其它素材 tag。查看 `git log --no-merges PREVIOUS_TAG..TARGET --oneline`，再用相关 diff、已提交文档和测试核实实际行为，不只改写提交标题。
- 没有上一正式版时说明「首个正式 Release」，选可核实的近期集成基线并注明 commit/比较链接；不要虚构上一版本或将全部仓库历史都说成本版新增。合并提交、重复补丁、纯格式调整不逐条罗列。
- 按 [更新说明规范](references/release-notes.md) 撰写面向用户的 Markdown，涵盖实际新增、修复、升级注意、验证与提交范围。未发布的渠道、未安装的客户端、仅夹具验证的平台必须如实区分。
- 使用 Write 保存为新的 UTF-8 `release-notes.md`，放在独立资产目录或临时目录，不混入 ZIP 或修改用户现有文件。拒绝空正文和仅项目名/版本的一行占位；发布工具不会自动编造说明。

## 检查与打包

- 核对两份插件 manifest 与市场条目版本/name 一致。用户要求升级版本时才修改版本，不顺手修其它代码。
- 在项目根运行 `python3 -B sync_plugin.py --check`。漂移时先检查源文件，只同步项目自己的副本。
- 运行 Node、Python、速率回归及脚本语法检查。测试失败先修复或报告阻塞，不能继续发布。
- 直接使用仓库根 `release_tool.py` 与同目录可信 `release_unpack.py`，本技能不保存脚本副本：

```bash
python3 -B release_tool.py build --root /absolute/project --repo OWNER/REPO --out /new/artifact-directory
python3 -B release_tool.py verify --zip /new/artifact-directory/zcode-token-usage-statusbar-vX.Y.Z.zip --manifest /new/artifact-directory/release-manifest.json --repo OWNER/REPO
python3 -B release_tool.py publish --root /absolute/project --zip /new/artifact-directory/zcode-token-usage-statusbar-vX.Y.Z.zip --manifest /new/artifact-directory/release-manifest.json --repo OWNER/REPO --notes-file /absolute/release-notes.md --dry-run
```

- 不覆盖已有未知资产目录。检查 JSON 输出、ZIP、SHA256、版本/tag/repository。发布包仅包含市场、许可证与插件运行所需白名单文件；不包含本项目发布技能、发布工具、用量数据、用户配置、凭据、缓存、锁或截图。
- `build` 另输出 `marketplace-release.json`，是渠道清单，不是第三个 Release 资产；根目录本地 `marketplace.json` 保持不变。
- 报告将发布的仓库、版本、目标 commit、tag、资产、更新说明及实际预演结果。检查预演 JSON 的 `notesFile`、`notes` 和创建命令的 `--notes-file`；说明修改后必须重新预演。源码未提交或 tag 未就绪时报告阻塞，不把 build 成功称为已发布。

## 正式发布门

- 仅在用户明确授权本次仓库与版本的对应动作后提交、推送 tag 或发布。创建/迁移技能不是发布授权。禁止 force push、移动/覆盖已有 tag 或覆盖已有 Release。
- 默认分支上需提交时先创建分支；仅暂存获准的发布相关文件，不使用 `git add .`。
- 所有发布文件须已提交，本地与远端正式 tag 指向该 HEAD。工具不会创建或推送 tag；缺少 tag 时仅处理获准的 tag 操作，不让 GitHub 从默认分支默默创建。
- 先执行带 `--notes-file` 的默认发布预演。正式获准后以同一说明再使用 `--publish --confirm OWNER/REPO/vX.Y.Z`。工具读取说明快照、建 draft、上传双资产、下载逐字节核验、检查 draft 正文并重查远端 commit，再转正式并核验正文/状态。失败保留 draft，不盲删重建。
- 发布后通过 `gh release view vX.Y.Z --repo OWNER/REPO --json url,body,isDraft,isPrerelease,tagName,assets` 确认正式状态与两个资产；将 `body` 与说明比较（仅允许 CRLF 与末尾空白差异），报告真实 URL。正文缺失或不一致不是验收成功。

## 修订已发布说明

- 用户明确要求补充/修订指定 Release 的说明即授权该正文编辑，不代表允许修改版本、tag、资产、渠道或其它 Release。
- 先读取 Release 的 `body`、状态、tag commit 和资产 ID/name/size/digest，保存快照；若已有实质说明，保留有效内容并只补充/修正本次范围。
- 根据已发布 tag 的提交生成说明，不能把 tag 之后的提交写成本版功能。执行 `gh release edit vX.Y.Z --repo OWNER/REPO --notes-file /absolute/release-notes.md`；不要调用 `release_tool.py publish`，不要删除、重建或重传资产。
- 重新读取 Release，比较正文、正式状态、tag commit 和资产元数据。只有正文按预期变化才算成功。

## 发布更新渠道清单

- 正式 Release 验收通过后，获得独立渠道提交/推送授权，再将生成清单作为 `marketplace.json` 发布到同一仓库明确 ref，推荐 `plugin-releases`。预演只展示动作。
- 在独立临时 clone/worktree 操作，不切换或清理脏开发工作区。先读取远端原清单，核对插件、版本与 ref，不倒退版本或覆盖不相干内容。已有分支从远端 tip 派生，新分支从已验证 tag 派生；仅提交清单。
- 正常推送，禁止强推。之后从远端读取并核对版本、完整 ZIP URL/hash/path 与本次资产；渠道未成功时不能声称远端更新可用。
- 新用户注册 `OWNER/REPO#plugin-releases`。已有注册不会自动切换，维护者须在原 ref 发布一致清单，或由用户明确选择迁移；不修改用户市场注册。

## 发布后合并源码 PR

- 正式 Release 正文与资产验收通过后，必须完成本次源码 PR 合并，不能把「Release 已发布、源码仅在发布分支」当作完整发版完成。渠道分支仅存市场清单，不作为源码 PR 的 head 或 base；补合并已发布版本时不重新打包或移动 tag。
- 用 `gh pr list --repo OWNER/REPO --state all --head HEAD_BRANCH --base BASE_BRANCH` 查找本次 PR；已有 open PR 则复用，已合并则验收后跳过，关闭未合并或不明确对应关系时先核对原因，不创建重复 PR。没有 PR 时用 `gh pr create --repo OWNER/REPO --head HEAD_BRANCH --base BASE_BRANCH --title ... --body-file ...` 创建，正文包含版本、Release 链接、修复范围和实际验证结果。
- 合并前读取 PR 的 `headRefOid`、`baseRefName`、`files`、`mergeable` 和 `statusCheckRollup`，核对 head 包含已验收 tag 的提交且 diff 仅为本次已审查改动。检查失败、冲突、待运行检查或分支内容变化时停止并修复/重新验证，不使用 `--admin` 绕过规则。无检查时按真实状态记录，仍须具备已执行的本地测试证据。
- 优先使用 merge commit 保留已发布提交历史：`gh pr merge NUMBER --repo OWNER/REPO --merge --match-head-commit VERIFIED_HEAD`。仓库不允许该方式时，依据仓库策略选择可用方式并核对主分支的实际文件；不要强推，不移动已发布 tag，不因合并重传资产，也不自动删除分支。
- 合并后用 `gh pr view NUMBER --repo OWNER/REPO --json state,mergedAt,mergeCommit,url` 确认 `MERGED`；重新读取远端 base tip，验证包含 merge commit，以及已发布提交的祖先关系（merge 方式）或等价文件内容。报告 PR URL、合并 commit 和 base。合并被阻止时明确标记「Release 已发布，PR 合并未完成」，不得宣称完整发版完成。
- 保留本地其它会话改动，远端合并不要求切换或清理脏工作区。若发布后增加技能/文档等必要收尾提交，应单独测试并明确它们位于 tag 之后，只进入 PR，不写成已发布包中的功能。

## 收尾

- 分别报告打包、提交/tag/推送、Release、渠道、更新端验证及源码 PR 合并状态。未执行就明确写未执行；完整发版须给出已合并 PR 的 URL 与验证结果。
- 不安装或覆盖用户缓存，不自动重启客户端。发布成功不等于用户已安装。
