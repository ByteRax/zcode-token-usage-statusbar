# 发布后收尾：渠道清单、GitCode 渠道、更新端验证

前提都是正式 Release 的正文与资产已验收，渠道分支推送已获得独立授权。下面的命令在**项目根目录**执行（不是发布 worktree 内，相对路径 `.worktrees/…` 在发布 worktree 里会嵌套建在它里面）；每个渠道 worktree 的路径都带版本号，收尾时清理。

## 渠道清单（plugin-releases）

渠道清单是 `build` 输出的 `marketplace-release.json`（不是 Release 资产，也不在 ZIP 内）。用独立 worktree 操作，不碰脏的开发工作区：

```bash
git fetch fork plugin-releases
git worktree add --detach .worktrees/channel-vX.Y.Z fork/plugin-releases   # 分支已存在：从远端 tip 派生
git show fork/plugin-releases:marketplace.json                              # 先读远端原清单，核对插件、版本与 ref
```

只允许更新本插件且版本递增，不倒退版本、不覆盖不相干内容。**推送之前**先核对清单里的 sha256 等于 Release 资产的 digest（渠道是全体用户的更新入口，推错了再改就晚了）：

```bash
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["plugins"][0]["source"]["sha256"])' /new/artifact-directory/marketplace-release.json
gh release view vX.Y.Z --repo OWNER/REPO --json assets --jq '.assets[] | select(.name|endswith(".zip")) | .digest'   # 两者应相同，后者带 sha256: 前缀
```

写入并仅提交清单，然后推送：

```bash
cp /new/artifact-directory/marketplace-release.json .worktrees/channel-vX.Y.Z/marketplace.json
git -C .worktrees/channel-vX.Y.Z add marketplace.json
git -C .worktrees/channel-vX.Y.Z commit -m "chore: 更新渠道清单 X.Y.Z"
git -C .worktrees/channel-vX.Y.Z push fork HEAD:refs/heads/plugin-releases
```

- 推送写法：从 detached worktree 推送必须写 `HEAD:refs/heads/分支名`。写成 `git push fork plugin-releases` 推的是同名本地分支，它常落后于远端而被拒（non-fast-forward），没有同名本地分支则报 `src refspec ... does not match any`；目标分支不存在时写短名 `HEAD:分支名` 会报 `not a full refname`。
- 正常推送，禁止强推；被拒绝就重新读取远端并停止，不盲目重试。`fork` 的双 push URL 会同时推到 GitCode。渠道分支按设计直接推送，不开 PR。

回读核对，渠道未成功之前不能声称远端更新可用：

```bash
git fetch fork plugin-releases
git show fork/plugin-releases:marketplace.json | diff - /new/artifact-directory/marketplace-release.json && echo "清单一致"
```

新用户注册 `OWNER/REPO#plugin-releases`；已有注册追踪原 ref，不会自动切换，也不修改用户的市场注册。追踪源码路径清单的用户走 `market` 渠道，由宿主插件管理器按清单直接更新、不经发布包校验。

## GitCode 渠道

GitCode Release 的创建与上传属于发布动作，须在 D 阶段的授权语里点名 `--gitcode-repo` 与 GitCode 仓库，因为它和 GitHub 发布是**同一条命令**：`publish --publish` 追加 `--gitcode-repo tanranran/zcode-token-usage-statusbar`，并先设置环境变量 `GITCODE_TOKEN`（令牌走 query 参数，不落盘、不进日志）。缺该变量时 `--publish` 在创建 draft 之前就整体失败（`--dry-run` 不检查）。工具在 GitHub 发布验收后创建或复用同 tag 的 GitCode Release、上传同一字节的 ZIP 与 manifest、回读比对，并在资产目录生成 `marketplace-release-gitcode.json`。该清单形状同上，只是 `url` 指向 GitCode Release 资产；同样不上传、不入 ZIP。

把该清单发布为 `plugin-releases-gitcode` 分支根目录的 `marketplace.json`（这一步属于阶段 E，须另行授权），流程同上，区别有两点：

- 该分支两端都可能尚不存在，先确认：`git ls-remote fork 'refs/heads/plugin-releases-gitcode'`（只读 GitHub）与 `git ls-remote gitcode 'refs/heads/plugin-releases-gitcode'`（GitCode）。都不存在时没有可派生的分支，改从已验证的正式 tag 建 worktree：`git worktree add --detach .worktrees/channel-gitcode-vX.Y.Z vX.Y.Z`，推送写 `HEAD:refs/heads/plugin-releases-gitcode`。
- 该分支内容刻意与 `plugin-releases` 不同（指向 GitCode 资产 URL），不要互相覆盖。

回读两个渠道分支，核对版本、ZIP URL 与 hash；任一渠道未就绪都不得宣称该渠道可更新。这里的 `GITCODE_TOKEN` 是 API 令牌；`git push fork` 的 GitCode 段用的是 HTTPS 凭据（钥匙串），那一段失败不代表 GitHub 段失败，补配凭据后重推即可。详见 [GitCode 更新渠道](../../../../docs/maintaining.md#gitcode-更新渠道)。

## 更新端验证

对**真实发布的资产**重复升级链验证，并确认渠道清单与 Release 一致：

```bash
OUT=$(mktemp -d)
gh release download vX.Y.Z --repo OWNER/REPO -D "$OUT" -p 'zcode-token-usage-statusbar-vX.Y.Z.zip' -p 'release-manifest.json'
shasum -a 256 "$OUT"/*.zip      # 应等于渠道清单的 source.sha256
```

再把 `OUT` 作为输入，运行 `pre-publish-checks.md`「升级链验证」一节的同一个循环。没做就在收尾报告写「更新端验证未执行」，不要写成通过。

## 清理

`git worktree remove .worktrees/channel-vX.Y.Z`（以及 `channel-gitcode-vX.Y.Z`）；推送与回读都成功后再清。
