# 发布失败与回退

`release_tool.py publish` 的核验失败都会停下并保留现场，不会自动清理。先汇报现状，处置由用户决定。下面这些动作各自需要用户针对**该具体动作**的明确授权，不能由「授权发版」推出：删除 Release 或 draft、移动或删除已推送的 tag、重新发布、手动转正、重推渠道清单。agent 汇报事实并给出可行的做法，但不替用户选择、不自行执行；移动已推送的 tag（需要 force push）不在主动提出的做法之内，只有用户自己提出时才讨论。

## draft 残留

任何一步让 `publish` 在转正前中断，都会留下 draft：`gh release upload` 失败、资产上传后的任何核验失败（draft 身份、正文、资产字节、远端 tag 变化）、`--draft=false` 失败、进程被打断。preflight 把 draft 也算作 `release already exists (including drafts)`，所以不能直接重跑。

1. 汇报现状：`gh release view vX.Y.Z --repo OWNER/REPO --json isDraft,body,assets,targetCommitish`。**`isDraft` 必须为 true 才继续本节；为 false 说明已经公开，转到下一节。**
2. 由用户决定：删除 draft 后重跑，还是手动转正。
3. 删除 draft 用 `gh release delete vX.Y.Z --repo OWNER/REPO --yes`。`--yes` 跳过确认，所以只在第 1 步确认了 `isDraft` 为 true 之后才执行：对已公开的 Release 它同样不再确认。**不要加 `--cleanup-tag`**，它会连远端 tag 一起删。只删 draft 不会动 tag。
4. 手动转正（用户决定转正时）：先逐项重做 `publish` 的核验，全部通过再转正。draft 无法通过 `/releases/tags/` 取到，`release_tool.py` 也是遍历 `/releases` 列表找 draft 的：
   - 恰好一个 draft，`prerelease` 为 false，资产名集合恰为 ZIP 与 `release-manifest.json`，两个资产 `state` 都是 `uploaded`：

     ```bash
     gh api 'repos/OWNER/REPO/releases?per_page=100' --paginate --jq '.[] | select(.tag_name=="vX.Y.Z") | "draft=\(.draft) prerelease=\(.prerelease)", (.assets[] | "  id=\(.id) name=\(.name) size=\(.size) state=\(.state)")'
     ```

   - 远端 tag 仍指向发布提交：`gh api repos/OWNER/REPO/commits/vX.Y.Z --jq .sha` 等于 `git rev-parse vX.Y.Z^{commit}`。
   - 正文与说明一致（只允许 CRLF 与末尾空白差异）：`gh release view vX.Y.Z --repo OWNER/REPO --json body --jq .body` 对比 `release-notes.md`。
   - 资产字节一致，对上面列出的每个 `id`：`gh api repos/OWNER/REPO/releases/assets/ID -H 'Accept: application/octet-stream' | cmp - <本地同名文件>`。
   - 转正命令与工具一致：`gh release edit vX.Y.Z --repo OWNER/REPO --draft=false --verify-tag`。转正后重新读取：非 draft、非 prerelease、资产不变、正文一致。

## 已公开但核验不符

两种情形 Release 都已是公开状态：转正之后 `publish` 报 `published release state/assets disagree` 或 `published release body disagrees; inspect release manually`；或者 GitHub 已经公开，随后 `--gitcode-repo` 的 GitCode 镜像步骤失败（此时不打印 plan）。

- 不重跑（preflight 会因 Release 已存在而拒绝），也不删除重发。
- 汇报 `gh release view vX.Y.Z --repo OWNER/REPO --json url,body,isDraft,assets` 的实际内容，明确区分「GitHub 已公开」与「GitCode 镜像失败」。前两种核验不符发生在镜像步骤之前，此时 GitCode 上还没有 Release。
- 正文不符：按 `release-notes.md`「修订已发布说明」用 `gh release edit --notes-file` 修订。资产不符：停下，由用户决策。
- GitCode 镜像失败：缺 `GITCODE_TOKEN` 不是原因（缺该变量时 `--publish` 在创建 draft 之前就整体失败）。能走到这一步的原因是令牌失效或权限不足（GitCode API 返回 401/403）、网络错误、资产下载主机不在白名单、回读字节不符。`release_tool.py` 没有单独重跑镜像的入口，补镜像的做法（直接调用 `gitcode_mirror`，或在 GitCode 手动建同 tag Release 并上传两个资产）由用户决定，不要为此删除 GitHub Release；无论哪种做法，都先按 SKILL.md「预演与正式发布」里的 GitCode tag 闸门确认镜像上已有同一个 tag 且指向发布提交（创建 Release 的请求不带 `target_commitish`；GitCode 文档写的是不传则取默认分支的最新提交，缺 tag 时可能据此建出指向错误提交的 tag，未实测）。

## tag 或提交需要变更

阶段 B 的闸门（本地 tag + `--dry-run`）本应拦住这类问题。万一 tag 已推送后才发现要改提交（例如相关文件未提交、行尾与 HEAD 不一致、副本漂移）：已推送的 tag 不许移动或删除。

- 停下来向用户说明，推荐升版本号，用新的提交与新 tag 重来。移动该 tag 需要 force push：只有用户自己明确要求并授权时才讨论和执行（见本文开头的授权要求），agent 不主动建议，更不要自行 `git tag -f` 后强推。
- 事前预防就是阶段 B 的闸门，不要省略。

## 要求替换已发布版本

本技能不覆盖已发布的 Release：`release_tool.py` 本身就拒绝已存在的 Release，而替换通常意味着移动 tag（先例 v1.5.0 的重发就移动了 tag）、删除并重建 Release、重推渠道清单，每一步都需要用户逐步授权。

1. 存快照：`gh release view vX.Y.Z --repo OWNER/REPO --json body,assets,tagName,targetCommitish,url > /tmp/release-vX.Y.Z-before.json`。
2. 说明对已下载旧资产的用户的影响（旧 ZIP 的 SHA256 与新渠道清单会不一致）。
3. 停止，等用户对每一步分别授权：删除 Release、移动 tag（用户已经提出替换，才把它列为待授权的一步；agent 仍不自行 `git tag -f` 或强推）、重新发布、重推渠道清单。
