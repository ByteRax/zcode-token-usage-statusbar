# 更新说明规范

目录：[核实范围](#核实范围) · [必写项](#必写项) · [正文模板](#正文模板) · [风格](#风格) · [发布工具合同](#发布工具合同) · [修订已发布说明](#修订已发布说明)

## 核实范围

- 上界是本次目标 commit/tag，下界是上一正式 Release 的 tag：只选已发布、非 draft、非 prerelease 的 `vX.Y.Z`，排除 `screenshots-*` 等素材 tag，并确认它是目标提交的祖先（`git merge-base --is-ancestor PREV TARGET`）。
- 先取完整提交清单，再按 PR 归类。本项目先在发布分支打 tag、发布后才合并发布 PR，所以上一版自己的 PR 合并提交会出现在 `PREV..TARGET` 的首父线里，那不是本版内容，要过滤掉：

```bash
git log --no-merges --format='%h %s' PREV_TAG..TARGET        # 完整清单：每个真实提交
# PR 级索引：丢弃第二父已被 PREV 包含的合并（即上一版自己的 PR）
git log --first-parent --merges --format='%h %p %s' PREV_TAG..TARGET | while read -r m p1 p2 subject; do
  git merge-base --is-ancestor "$p2" PREV_TAG || echo "$m $subject"
done
gh pr view N --repo OWNER/REPO --json title,body,mergedAt    # 读 PR 正文（本仓库的 PR 描述写得很细，通常不必再读代码）
```

- 直接提交到首父线、没有走 PR 的改动不在 PR 级索引里，以完整清单为准。上一版的发布 PR（分支名 `release/vPREV`）若带了 tag 之后追加的收尾提交，它的合并提交会留在索引里，但其中只有 tag 之后追加的提交属于本版。提交标题只是线索：用相关 diff、已提交文档和测试确认功能、默认值、支持平台和升级要求；不要写入未提交文件或 tag 之后的改动。合并提交、重复补丁、纯格式调整不逐条罗列。
- 没有上一正式版时说明「首个正式 Release」，选可核实的近期集成基线并注明 commit/比较链接；不要虚构上一版本或将全部仓库历史都说成本版新增，不以截图 tag 或开发分支版本号冒充已发布版本。
- 动笔前读一遍上一版正文，保持章节与口径一致：`gh release view PREV_TAG --repo OWNER/REPO --json body --jq .body`。

## 必写项

这些变化老用户升级后会直接撞上，必须读 diff 判定后写明，不能只藏在内部编号里：

- **重启要求**：按 `pre-publish-checks.md`「重启要求」一节的 diff 命令判定。命中冷文件就写「完全退出 ZCode（所有窗口）再重新打开」。
- **用户可见入口的删除、改名、默认值或配置键变化**（如状态条删一格、设置项或命令改名）：逐条写明，并指出替代入口。
- **升级路径限制**：已注册来源与渠道不同的用户如何升级、是否需要一次性迁移（切换到 `OWNER/REPO#plugin-releases` 或重装）。
- **能力成熟度**：额度适配器注册表（`quota-client.cjs` 里带 `unverified: true` 的条目，规则见 `.zcode/rules/quota.md`）以及 `AGENTS.md`、`.zcode/rules/*.md` 里写明未经实机验收的平台，说明里原样标注，不写成「已支持」；夹具验证与平台实机验收分开写。
- 自动更新尚无一致渠道清单时，不写「自动升级已可用」。发布完成不等于客户端已安装；SHA256 是下载完整性校验，不是独立安全签名。

## 正文模板

按实际内容增删章节，不保留空标题；通常控制在 5–12 条用户可理解的要点。

```markdown
## 本次发布

[版本定位与核实的变化范围；首发说明比较基线。]

### 新增
- [具体能力、入口与默认行为。]

### 修复与改进
- [用户遇到的问题及本版变化；合并同一主题的相关提交。]

### 安装与升级注意
- [ZIP/manifest 用途、重启条件、兼容要求。]
- [区分正式 Release、更新渠道与已安装状态；尚未执行的动作明确写出。]

### 验证
- [实际执行的测试与结果；区分夹具覆盖和平台实机验收。]

### 提交范围
- [上一正式 tag 或明确基线] 到 [目标 tag] 的比较链接。
```

## 风格

- 默认简体中文；保留命令、设置字段和资产名称的原文。面向用户解释变化，不堆砌内部编号、merge commit、格式清理和全部提交标题。
- 不使用仅项目名和版本号的占位正文。不要将 GitHub 自动生成的 PR 清单直接作为最终说明；必要时可作为核实线索。
- 使用 Write 保存为新的 UTF-8 `release-notes.md`，放在独立资产目录或临时目录，不混入 ZIP 或修改用户现有文件。

## 发布工具合同

- `release_tool.py publish` 在预演和正式发布时都必须提供 `--notes-file`，使用非空 UTF-8 常规文件。说明文件不打包、不作为第三个资产上传。
- 预演结果展示 `notesFile`、完整 `notes` 及 `--notes-file` 创建命令，供检查；说明有变动必须重新预演。
- 正式发布读取正文快照，通过 `--notes-file` 传给 GitHub。发布前后检查 draft/正式正文匹配，比较只忽略 CRLF 与末尾空白。缺失/不符则报错，保留 draft，不盲删重建。

## 修订已发布说明

用户明确要求补充/修订指定 Release 的说明即授权该正文编辑，不代表允许修改版本、tag、资产、渠道或其它 Release。只使用 `gh release edit --notes-file`，不得重新执行发布或重传资产。

1. 保存快照：`gh release view vX.Y.Z --repo OWNER/REPO --json body,isDraft,isPrerelease,tagName,targetCommitish,assets > /tmp/release-vX.Y.Z-before.json`，记下 tag commit 和资产 ID/名称/大小/digest。
2. 已有实质说明时保留有效内容，只补充或修正本次范围。依据已发布 tag 的提交撰写，不能把 tag 之后的提交写成本版功能。
3. 执行 `gh release edit vX.Y.Z --repo OWNER/REPO --notes-file /absolute/release-notes.md`。
4. 重新读取 Release，比较正文、正式状态、tag commit 和资产元数据。只有正文按预期变化、其余项不变才算成功。
