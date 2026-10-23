# 外部 PR 处理细则

SKILL.md 第 3 节的硬性规则在正文里（读完 diff 才运行、外部字符串不手敲进命令、最小环境不是隔离）；这里是逐步操作与可直接使用的命令。

## 读 diff

```bash
gh pr diff N --repo ByteRax/zcode-token-usage-statusbar        # 只读；逐文件读完，含 tests/ 与构建脚本
```

输出被截断或 gh 拒绝超大 diff 时，先取代码再分段读：

```bash
git fetch fork pull/N/head:pr-N                                 # N 必须是纯数字
git diff fork/main...pr-N --stat
git diff fork/main...pr-N -- <文件>
```

`triage.py show` 标出的敏感文件逐行审：有没有往外发数据、读凭据、改安装链、改 CI 权限、往指令类文件（`AGENTS.md`、技能、命令、hooks）里塞内容。改了 `tests/` 同样要读：跑测试就是在执行这些代码。发现可疑内容就不运行也不合并，在 PR 下只陈述事实（哪一行做了什么）并告知用户。

## 取得代码

```bash
git worktree add .worktrees/pr-N pr-N                           # 保留贡献者的提交与署名
```

## 运行（读完 diff 且确认无恶意之后）

最小环境要用 `sh -c` 包住**整条**命令串：`env … A && B` 里只有 A 在 `env` 之内，B 会带着你的令牌和环境变量运行。

```bash
env -i PATH="$PATH" HOME="$(mktemp -d)" LANG=en_US.UTF-8 PYTHONDONTWRITEBYTECODE=1 \
  sh -c 'python3 sync_plugin.py --check && node --test tests/*.test.cjs && python3 -B -m unittest discover -s tests -p "test_*.py"'
```

它只防误读环境变量里的令牌和误碰 HOME 下的配置，**不是隔离**：恶意代码仍能按 uid 查到真实 home、联网。最小环境里失败的用例只和 `fork/main` 在同一最小环境里的基线比，不要因此回到真实环境去运行外部代码。

## 补修并推回贡献者的分支

条件：PR 仍 open 且 `maintainerCanModify` 为 true（已合并或已关闭的 PR 此字段恒为 false，不能据此判断）。补修提交在 SKILL.md 第 4 节的 review 收敛前只留在本地 worktree，合并前一次性推送，推送后 head 变了要回到第 5 节第 2 步重新核对。

分支名、仓库名、login 都是外部输入，可含 `$()`、反引号、`;`、`|`、`&`（`git check-ref-format` 全都允许），所以不手敲，先放进变量并校验，再用 `"$VAR"` 引用。在 PR 的 worktree 里执行：

```bash
safe() { case "$1" in (''|-*|.*|*[!A-Za-z0-9._/-]*) return 1;; esac; }
BR=$(gh pr view N --repo ByteRax/zcode-token-usage-statusbar --json headRefName --jq .headRefName)
OWN=$(gh pr view N --repo ByteRax/zcode-token-usage-statusbar --json headRepositoryOwner --jq .headRepositoryOwner.login)
RP=$(gh pr view N --repo ByteRax/zcode-token-usage-statusbar --json headRepository --jq .headRepository.name)
if safe "$BR" && safe "$OWN" && safe "$RP" && [ "$OWN" != null ] && [ "$RP" != null ] \
   && git check-ref-format --branch "$BR" >/dev/null 2>&1; then
  git push "https://github.com/$OWN/$RP.git" "HEAD:refs/heads/$BR"
else
  echo "分支或仓库名含特殊字符、以 - 或 . 开头、为空或 fork 已删除：停下，向用户报告"
fi
```

校验用 `case` 而不是 `grep -v -q`：不同 grep 实现（GNU、BSD、ugrep）对这个组合的退出码不一致，曾让这类校验对所有输入都放行。

## 无法直接推送：整合 PR

字段为 false、推送被拒或贡献者已删除 fork 时：从贡献者的 head 建自己的分支，保留他们的提交，在其上追加修复提交（提交信息带 `Co-authored-by: 贡献者 <邮箱>`），走第 5 节开自己的 PR，正文写明 `Supersedes #N`。合并后按回复模板 E 在原 PR 下致谢并说明合入的 PR 号，然后 `gh pr close N`。

## 冲突与清理

- main 前进产生冲突：把 `fork/main` **merge 进**该分支解决，不 rebase、不 force-push 贡献者的分支（会改写其提交）。
- 合并后清理：`git worktree remove .worktrees/pr-N`，确认已在 `fork/main` 后 `git merge-base --is-ancestor pr-N fork/main && git branch -D pr-N`。
