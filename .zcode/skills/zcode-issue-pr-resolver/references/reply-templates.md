# 回复模板

先合并，后回复，再关闭。语言跟随提交者；英文提交者就把同样的结构译成英文，命令、文件名、字段名保留原文。风格可对照已关闭的 issue #40、#56 的回复：`gh issue view 56 --repo ByteRax/zcode-token-usage-statusbar --json comments --jq '.comments[].body'`。

## 选哪个模板

先用 `triage.py released <合并提交或已含修复的提交>` 判断发版状态，再按结论选：

| 情形 | 模板 |
|---|---|
| 修复已合入 main，`released` 报「未发版」 | A，用「未发版」版的「如何获取」 |
| 修复已随正式版发布，`released` 报「已发版」 | A，用「已发版」版的「如何获取」，先核对渠道清单 |
| 信息不足，需要提交者补充 | B |
| 重复、设计如此，或问题在 main 上早已修好、本次没有新增改动 | C；已修好的先 `released`，再按 A 的「如何获取」补一段 |
| 外部 PR 合并 | D；它修复的 issue 下另用 A |
| 外部 PR 不合并 | E |
| 有设计分叉，需要先征询提出者 | F |

## 命令

评论正文写进临时文件，不放进 worktree：

```bash
gh issue comment N --repo ByteRax/zcode-token-usage-statusbar --body-file /tmp/ztus-issue-N-reply.md
gh issue close N --repo ByteRax/zcode-token-usage-statusbar --reason completed        # 或 --reason "not planned" / --duplicate-of M
gh issue view N --repo ByteRax/zcode-token-usage-statusbar --json state,comments --jq '.state, .comments[-1].body'   # 回读状态、格式和链接
gh pr comment N --repo ByteRax/zcode-token-usage-statusbar --body-file /tmp/ztus-pr-N-reply.md        # 外部 PR
```

被合并的 PR 本身已自动关闭，无需再关；以「整合 PR」方式合入时才需要 `gh pr close N --repo ByteRax/zcode-token-usage-statusbar`。issue 若已随 PR 合并被自动关闭（PR 正文写了 `Fixes #N`），只发评论，不再 `close`。

## A 已修复

```markdown
感谢这份报告——<点名具体价值：定位到的根因 / 提供的日志 / 复现步骤>。

**根因**：<一两句>

**修复**（已合入 main，PR #<号>，提交 <7 位 SHA>）：
- <要点一>
- <要点二>

**如何获取**：<按下面两种情形二选一>

**注意**：本次改动涉及主进程文件（<文件名>），更新或安装后需要**完全退出 ZCode 再重启**（托盘退出，不是只关窗口）才会生效。

**验证范围**：<夹具或隔离测试覆盖了什么>。<没有在你的真实环境（<平台/路径/账号>）复现过——升级后如果仍有问题，请附上 `~/.zcode/zcode-token-usage-statusbar/diag-*.json`。>

<此 issue 先关闭 / 此 issue 已随该 PR 合并自动关闭>；如果升级后仍然复现，欢迎重新打开。
```

「如何获取」二选一：

- **未发版**：修复已在 main，但**尚未随正式版本发布**——当前正式版是 <vX.Y.Z>，不含此修复。
  - 等下个版本发布（推荐）：发布后在 ⚙ 面板点「检查更新」，或用宿主插件管理器更新。
  - 立即体验 main：`git clone https://github.com/ByteRax/zcode-token-usage-statusbar.git`，在 ZCode 里执行 `/plugin marketplace add /克隆目录的绝对路径` 后从本地市场安装；或直接运行一键安装器 `python install.py`（macOS 没有 `python` 命令时用 `python3`）。
- **已发版**：开头改成「已在 **<vX.Y.Z>** 修复并发布：<Release 链接>」。先只读核对渠道清单是否已指向该版本：

  ```bash
  gh api 'repos/ByteRax/zcode-token-usage-statusbar/contents/marketplace.json?ref=plugin-releases' --jq .content | base64 -d \
    | python3 -c 'import json,sys; e=json.load(sys.stdin)["plugins"][0]; print(e.get("version"), e["source"]["url"])'
  ```

  版本等于该 Release：写「在插件市场更新到该版本（已注册 `#plugin-releases` 渠道的会自动看到），然后完全退出 ZCode 再重新打开」。渠道落后：写「Release 已发布，更新渠道清单尚未同步，暂时在渠道里看不到；可先到 Release 页面下载，或等渠道更新」，不要说会自动更新。

不涉及主进程文件时删掉「注意」段；没有真实环境差异时删掉「验证范围」里的后半句，不要硬写。

## B 信息不足

```markdown
感谢反馈。目前还无法定位，需要补充：
1. <具体项：版本号 / 操作系统 / 哪份日志的哪几行 / 复现步骤>
2. <……>

补充后我会继续跟进，先保持 open。
```

追问要具体到文件路径和命令，不要写「请提供更多信息」。

## C 重复、设计如此、已修好

```markdown
感谢反馈。<理由：与 #M 是同一问题 / 已在 main 修复（提交 <SHA>，<未发版，或随 vX.Y.Z 发布>）/ 属于设计如此（依据：<AGENTS.md 条目或文档>）>。
<指向：重复项链接或修复提交>。先关闭；如果你的场景和上面不同，欢迎补充后重新打开。
```

重复用 `--duplicate-of M` 关闭，设计如此或不计划用 `--reason "not planned"`，已修复用 `--reason completed`。

「已在 main 修好」的变体：在上面的正文里写明修复提交，并补上 A 里的「如何获取」（未发版/已发版二选一，已发版先核对渠道清单）；涉及主进程冷文件时补「注意」重启那一段，验证范围按实际写。

## D 外部 PR 合并致谢

```markdown
感谢这个 PR——<点名具体价值：例如对客户端源码的逆向核对、实机验证、测试覆盖>。

我做了 review，发现并修复了 <N> 处问题（提交 <SHA>）：
1. <问题与修复>
2. <……>

合并方式：<merge commit，保留你的提交与署名 / 整合 PR #<号>（保留你的提交，在其上追加了修复）>。

<验证范围与已知残留，按实际写>
```

以「整合 PR」方式合入时，在原 PR 下写明合入的 PR 号与提交，保留其署名，然后 `gh pr close N --repo ByteRax/zcode-token-usage-statusbar`。

## E 外部 PR 不合并

方向不符、有安全问题或质量不足时，说明具体原因与可行的改法，礼貌致谢后再决定关闭还是保持开放等其修改，**这一步交给用户决定**，不替用户关闭。

```markdown
感谢提交。暂不合并，原因：<具体、可核对的原因，指到文件和行>。
如果要继续，建议：<可行的改法>。
```

涉及安全疑点时只陈述事实（哪一行做了什么），不做动机推测。

## F 设计分叉，征询提出者

需求有几种做法、取舍会影响范围时，不擅自选方案，也不合并；先在 issue 下征询，最终报告里请用户决策。

```markdown
感谢反馈。这个需求有几种做法，取舍会影响 <范围>，想先听听你的场景再动手：
1. <方案一>：<好处 / 代价>
2. <方案二>：<好处 / 代价>

我倾向 <某方案>，理由是 <……>。你更看重哪一点？回复后我继续跟进，先保持 open。
```
