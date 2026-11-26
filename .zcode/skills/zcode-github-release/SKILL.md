---
name: zcode-github-release
description: "仅为当前 zcode-token-usage-statusbar 项目发版：检查、打包、校验并发布 GitHub 正式 Release，发布验收后更新 plugin-releases / GitCode 渠道清单、创建并合并源码 PR，或补充/修订已发布 Release 的更新说明，并核对插件内更新日志的版本身份、渠道正文与兼容交付。支持在检查、打包验证、PR 素材核实与发布后多渠道只读验收阶段派发多路 subagent 提速（节奏按仓库的审查并发规格）。用户说「发版」「发布新版本」「创建 GitHub Release」「发布预演」「更新渠道清单」「补合并发布 PR」「改 Release 说明」时使用。调用本技能即按默认全链发版、不再逐项询问：补丁号升版、提交并打 tag 推送、GitHub Release 与 GitCode 镜像、plugin-releases 与 plugin-releases-gitcode 渠道清单、同一目标仓库的源码 PR 合并；用户调用时另有说明的（仅预演、仅发 Release、指定版本号等）以其为准。"
---

# 当前项目的 GitHub 正式 Release

## 确认项目、仓库与授权

- 本技能仅供所在仓库使用。以本技能目录向上三级得到项目根目录，验证该目录与 `git rev-parse --show-toplevel` 一致，且有 `marketplace.json`、`sync_plugin.py`、`release_tool.py`、`release_unpack.py` 和 `plugins/zcode-token-usage-statusbar/`。不要在其它项目或已安装插件缓存执行发布。
- 阅读 `AGENTS.md` §3（同步与冷文件）、§8（发布与外部操作边界），§8 指向的 [发布链规则](../../rules/install-release.md)（§6 更新器与渠道、§7 打包与发布），以及 [开发与发布](../../../docs/maintaining.md#发布插件)。检查 `git status`、当前分支与 `git remote -v`，保留未提交及其它会话改动。
- 发布目标 `owner/repo` 默认是 `fork` 远程指向的 ByteRax 仓库（用 `git remote get-url --push fork` 核对 GitHub 那条 URL），用户在调用时点名其它仓库时以其为准；`origin`（xhwxt 上游）只读，不默认选它，也不因另一仓库有权限就切换。用 `gh repo view OWNER/REPO --json viewerPermission,defaultBranchRef` 核验权限与默认分支；目标只读则报告阻塞。
- 仅正式三段版本 `X.Y.Z`、tag `vX.Y.Z`，不将截图托管 Release 或开发分支提交当作正式版本。版本号默认取最新正式 tag 的补丁号加一（`X.Y.Z` → `X.Y.(Z+1)`；最新正式 tag 以非预发布的 `vX.Y.Z` 为准，排除 `screenshots-*`），用户在调用时点名版本号或要涨次版本号、主版本号时以其为准。只改版本相关文件，不顺手修其它代码。合同细节见 [发布包合同](references/release-contract.md)。

## 授权梯度与执行顺序

| 阶段 | 动作 | 授权 |
|---|---|---|
| A | 在发布 worktree 里改版本号（不提交）、同步/语法/测试检查、`build`、`verify`、升级链验证、起草更新说明（可派发多路只读 subagent 加速核查与素材采集，节奏按审查并发规格） | 默认可做，只写独立 worktree 与临时目录 |
| B | 提交版本改动、打 tag、推送分支与 tag | 默认已授权（主 agent 串行执行） |
| C | `publish --dry-run` | 须先完成 B：preflight 要求相关文件已提交，且本地与远端 tag 都指向 HEAD |
| D | `publish --publish --confirm OWNER/REPO/vX.Y.Z --gitcode-repo tanranran/zcode-token-usage-statusbar` | 默认已授权（主 agent 串行执行）；GitCode Release 镜像在同一命令内、GitHub 验收后自动执行，无法拆到 D 之后 |
| E | `plugin-releases` / `plugin-releases-gitcode` 两个渠道分支的清单推送 | 默认已授权，两个分支都在内，且在 D 验收通过之后（主 agent 串行推送，可派发只读 subagent 回读核对，节奏按审查并发规格）。publish（D）结束时输出 `channelLag` 并在 stderr 亮滞后警告——用户调用时排除了 E 的，收尾报告必须如实转述该滞后，补推路径见 [发布后收尾](references/post-release.md#补推release-已发渠道清单未更新) |
| F | 源码 PR 创建与合并、GitCode 镜像 base 同步 | 默认已授权（主 agent 串行执行） |

- **默认全链 = B + D（含 GitCode Release 镜像）+ E + F**：用户调用本技能即是对这套默认动作的明确授权，不再就版本号、授权范围、GitCode 镜像、渠道清单逐项询问。用户调用时另有说明的以其为准，按说明缩小或替换对应一步：「仅发 Release」= B + D（含 GitCode 镜像，除非说明不同步）；排除了 E 就不做渠道推送，此时已注册市场渠道的用户收不到这个版本（v1.5.17 因此滞留 12 小时，issue #308），收尾报告第一行写「渠道清单未更新，注册用户暂收不到本版」并给出补推路径（见下「执行 D 之前」与[发布后收尾](references/post-release.md#补推release-已发渠道清单未更新)），不得把「E 未做」只记进记忆当待办。创建或修改技能本身不是发布授权，只有用户调用它才是。
- 新发布按以下顺序：确认目标提交与 PR 合并目标 → 在干净 worktree 核对日志消费者与来源，准备已有合同要求的随包日志 → 检查/打包/升级链验证与说明起草（阶段 A 多路 subagent 核查，节奏按审查并发规格）→ 完成外置发布说明 → 提交并过推 tag 闸门后推送（B）→ 带说明预演（C）→ 正式发布（D）→ 验收正文与资产 → 更新两个渠道清单并做更新端验证（E）→ 创建并合并源码 PR → 验收合并结果 → 同步 GitCode 镜像（F）。仅修订已有说明时跳到「修订已发布说明」，不重新发布或合并 PR。
- 用户只要求预演而 tag 尚未就绪：停在 A，报告「预演未执行；预期阻塞项：版本改动未提交、缺本地/远端 tag」，附 build/verify/升级链结果和 B 将执行的动作清单（要提交的文件、tag 名、推送目标）；不要为跑通预演自行打 tag 或推送。
- 完整正式发版默认包含发布后源码 PR 的创建与合并。合并目标是同一发布仓库的默认分支（通过 `gh repo view OWNER/REPO --json defaultBranchRef` 核实），仅包含已审查的本次发布提交；用户指定其它 base 时以其要求为准。默认全链之下，不在发布成功后再次询问这项收尾；仅预演、仅 Release、仅修改说明或用户明确禁止合并时不执行，也不延伸到上游仓库。
- 未经用户针对**该具体动作**的明确授权，禁止 force push、移动或删除已推送的 tag、覆盖或删除已有 Release；默认全链不蕴含这些。渠道分支另有一条更严的约束：任何授权都不允许对它强推，见下节。

## 渠道分支不变量（硬约束）

渠道分支（`plugin-releases`、`plugin-releases-gitcode`，GitHub 与 GitCode 两台主机）是全体市场渠道用户拿到新版本的唯一入口。宿主用 git 克隆物化市场，并按 `pull --ff-only` 跟进分支（实证：issue #497 里宿主市场克隆的 reflog）。维护者本机通常走本地源码市场、不经渠道，所以渠道坏了维护者自己看不到；用户侧原本只会看到「已是最新」（现在 GitHub Release 渠道安装时会报清单落后，market 与 GitCode 渠道会提示「更新渠道没有跟上最新发布」，但都只在用户点检查时出现，见 `specs/channel-lag-detection.md`）。issue #247、#308、#497 三次都是「已发版，但用户拿不到」：每次只修了当次的机制，下一次换一种方式再坏。所以下面三条是对任何会话、任何流程都成立的硬约束——发版、补推、调整分支形态，以及与发版无关的改动（安装提速之类）都包括在内；本技能其它段落与 `references/` 跟它们冲突时，以本节为准。

1. **只进不退**：分支 tip 只能从两台主机当前的远端 tip 快进。禁止孤儿提交、强推、换根、改写历史——**用户对「强推」的授权也不能豁免**：授权依据往往正是 AI 自己写的规格，而 #497 的那份规格把未经验证的宿主行为当成了事实。要改树里的文件（比如换成只放清单的精简树），就以远端 tip 为父做普通提交。推送被拒（非快进）就停下重读远端，不加 `-f`，也不加 `--force-with-lease`。`release_tool.py channel-commit` 缺省拒绝孤儿提交，`--orphan` 仅限首次创建全新分支。两台主机另设了硬保护：GitHub 上两个渠道分支禁强推、禁删除且管理员不豁免，GitCode 镜像整仓禁止强制推送——强推会被服务端拒绝；解除保护只能由用户明确授权，不得自行关闭。
2. **验收从用户的位置做**：任何对渠道分支的推送之后必须做「消费者验收」，清单内容一致不算数：① 两台主机 tip 相同；② 推送前记下的远端 tip 是新 tip 的祖先；③ 临时克隆停在旧 tip 上，`pull --ff-only` 能前进，且清单版本等于目标版本。命令见[发布后收尾·消费者验收](references/post-release.md#消费者验收渠道分支)。三项有一项没做或不过，不得写「渠道可更新」「用户会自动看到」。
3. **改「渠道怎么交付」先取证**：凡改动渠道分支的树形态、提交工具、分支布局，或在规格、规则、本技能里写下「宿主如何消费渠道」的说法，动手前必须拿到宿主消费机制的实证（宿主源码，或真实市场克隆的 reflog、日志），并在线上之外先通过第 2 条的验收再推送。从「首次下载能过」推断「已有克隆能跟上」不成立（#497 就是这样发生的）；没有实证的机制描述不得写进任何文档。

## 多 Subagent 派发策略（严守阶段授权边界）

发版涉及全套测试、代际台账、多历史 tag 升级链解包、日志消费者合同核对、大量合并 PR 的说明素材采集及多端回读验收，串行执行耗时且易占满主会话上下文。只读核查与验证环节派发 subagent，**派发节奏（逐路派发，还是在同一次工具调用里并发）按仓库的 [审查子代理并发 spec](../../../specs/review-agent-concurrency.md)**：默认模型（随主会话）的 subagent 一次只跑一路，同时跑多路会被模型服务排队，每步等几分钟，逐路反而更快；纯执行的活（全量测试、升级链解包、清单比对）交给 `review-runner`——固定用 GLM-5.3-FlashX 的项目代理，最多 2 路，可与默认模型的 subagent 同时跑，只执行、不裁决，它报的结果由主 agent 或核查它的 subagent 复核后才采信；只有 spec 的条件满足时才在同一轮工具调用里并发。单路上限、阻塞等待（`TaskOutput`，不用 `sleep`）与完成通知后的收尾，同样按该规格的「单路上限、等待与刹车」执行。同时遵守「**写操作与状态跃迁由主 agent 唯一串行控制**」的铁律：

1. **阶段 A 核查与素材采集**：
   主 agent 在干净的发布 worktree（`/abs/.worktrees/release-vX.Y.Z`）内改好三处 manifest 版本号、完成 `release_tool.py build` 与 `verify` 产出候选包后，按上面的节奏派发以下 3–4 路只读 subagent（子代理 4 拆分时总路数至多 5）：
   - **子代理 1（全量测试与静态检查路，交给 `review-runner`）**：针对发布 worktree（测试或编译检查一律带 `PYTHONDONTWRITEBYTECODE=1` 与 `python3 -B`，或先 `git clone --no-hardlinks` 到 `mktemp -d` 临时目录运行——克隆只含已提交内容，阶段 A 未提交的版本号与 `VERSION` 台账改动不在其内，须先把目标文件拷入克隆再测，否则测的是旧树；**绝不在发布 worktree 内留下未跟踪文件、`__pycache__` 或修改任何字节**，以免破坏阶段 B 的 `git status --porcelain` 空检查与确定性 ZIP 比对）运行 `sync_plugin.py --check`、`node --check overlay.js && node --check inject-main.cjs`、`node --test tests/*.test.cjs` 及 `python3 -B -m unittest discover -s tests -p 'test_*.py'`，汇总测试结果并区分环境基线红灯。
   - **子代理 2（代际台账、升级链与冷文件核查路；升级链解包的命令可交给 `review-runner` 跑，判定仍由这一路做）**：按 [发布前检查](references/pre-publish-checks.md) 执行 `overlay.js` 的 `VERSION` 台账严格递增校验、用历史正式 tag（`v1.4.0`、`v1.4.5`、`vLAST` 等）的 `release_unpack.py` 在独立临时目录校验新生成的候选 ZIP，并跑 `PREV_TAG..TARGET` 冷文件 diff 给出准确的「重启要求」判定结论。
   - **子代理 3（更新日志消费者与合同核查路）**：按 [更新日志交付](references/update-log-delivery.md) §1–§5 检查目标提交中 `plugin-release.cjs`、`plugin-updater.cjs`、`inject-main.cjs`、`overlay.js` 的日志消费实现、版本身份映射及对应单元测试覆盖情况。
   - **子代理 4（PR 素材采集与更新说明核实路）**：按 [更新说明规范](references/release-notes.md) 盘点 `PREV_TAG..TARGET` 的真实提交与合并 PR，批量读取各 PR 正文的「发版说明素材」块并对照提交 diff、测试和文档核实真伪（若跨度内 PR 较多，可再拆成 2 个子代理分片读取 PR），仅按「新功能 / 修复与改进」汇总无句号白话短句草稿；必要的重启、迁移与能力限制并入相关条目，核实证据另交工作记录，由主 agent 定稿 `release-notes.md`。
2. **阶段 D / E / F 发布后多端只读回读**：
   - 正式发布（D）或渠道推送（E）完成后，按上面的节奏派发只读验收 subagent（下载资产重跑升级链、比对清单这类纯执行交给 `review-runner`）：一路回读 GitHub Release 状态、正文并下载真实发布资产重跑历史解包器升级链验证；一路回读 GitCode 镜像 tag、Release 正文与资产一致性（默认镜像时）；一路在独立临时目录比对远端 `plugin-releases` / `plugin-releases-gitcode` 清单与本地生成清单的字节与 SHA256。
3. **严禁下放给任何 subagent 的写操作（红线）**：
   - 创建/删除 `.worktrees/` 目录、修改发布 worktree 内的文件、`git commit`、`git tag`、`git push`、`release_tool.py publish`（含 `--publish`）、`gh release edit/delete`、`gh pr create/merge` 等**一切改变本地发布状态或写远端的命令，严禁交给 subagent 执行**，必须由主 agent 在核实前置闸门后亲自串行执行（授权来自技能的默认全链或用户调用时的说明）。

## 隔离：在干净 worktree 里发版

`release_tool.py` 的 preflight 要求发布相关文件无未提交/未跟踪改动，`--root` 必须是 git 顶层目录，ZIP 取工作区字节且须与 HEAD 逐字节一致。主工作区常有并行会话的未提交改动，在那里既通不过 preflight，build/测试还会撞到写文件瞬态而假失败。因此在项目根执行下面**二选一**，阶段 A–D 的命令都在该 worktree 内执行，`--root` 写它的绝对路径（下文记作 `/abs/.worktrees/release-vX.Y.Z`）；阶段 E、F 的 worktree 操作与最后的清理回到项目根（相对路径 `.worktrees/…` 在发布 worktree 里会嵌套建在它里面）：

```bash
git fetch fork
git worktree add -b release/vX.Y.Z .worktrees/release-vX.Y.Z fork/main     # 常规：需要新建版本提交
git worktree add --detach .worktrees/release-vX.Y.Z <目标提交>              # 仅当目标提交已在默认分支上且已含正确版本号
```

- 常规路径在 worktree 里改两份 `plugin.json`（内容须一致）与 `marketplace.json` 的版本号，并递增 `src/mobile/00-meta.js` 的 `@version`。新脚本版本必须高于上一正式插件 tag 中的脚本版本及当前公开分发的脚本版本；若上一 tag 无脚本，以当前公开分发版本为准。脚本版本独立于插件，日常功能提交不构建、不提交两份脚本产物，也不升号。运行 `python3 sync_plugin.py` 同步桌面插件，再用 `python3 scripts/build_mobile_userscript.py` 单独重建正式版与调试版；改动留到阶段 B 一并提交。分离路径仅用于默认分支上的目标提交已满足上述版本与产物要求时；它没有本地分支，推送时只推 tag，源码 PR 阶段验收后跳过。
- 遇到 `line endings differ from HEAD`：不要照 `docs/maintaining.md` 旧段落执行 `git rm --cached -r -q . && git reset --hard`（`AGENTS.md` §8 明令不要），换一个全新 worktree 检出后重做。

## 检查与打包（阶段 A，可派发多 Subagent）

- **打包前先验渠道现状**：两个渠道分支各查一次——`git fetch fork <分支>` 与 `git fetch gitcode <分支>` 之后，两端 tip 相同、tip 有父提交、清单版本等于最新正式 Release 的版本。对不上说明渠道在上次发版之后被弄坏或一直没更新（#497 就是发版之后被改写）：先按[渠道分支不变量](#渠道分支不变量硬约束)修好并做消费者验收，再继续本次发版；不要把新版本叠在坏掉的渠道上。
- **打包前**读取 [更新日志交付](references/update-log-delivery.md)，核对目标提交的日志消费者与来源合同；若已支持随包日志，先完成日志内容、版本关联和副本同步再 build。仅外置 Release 正文可在验证结果齐备后定稿，不能据此在 build 后再补包内文件。
- 核对两份插件 manifest 与市场条目版本/name 一致。正式版与调试版 `@version` 都必须与脚本版本源一致，并满足上面的升号规则；`python3 scripts/build_mobile_userscript.py --check` 核对两份产物与发布源码一致，不能用桌面 `sync_plugin.py --check` 或脚本升号检查代替。若此后改了 overlay（含重排 `VERSION` 台账）或手机分片，必须重新构建并校验两份脚本。
- 直接使用仓库根 `release_tool.py` 与同目录可信 `release_unpack.py`，本技能不保存脚本副本。`build` 只读工作区文件，版本改动不必先提交：

```bash
python3 -B release_tool.py build --root /abs/.worktrees/release-vX.Y.Z --repo OWNER/REPO --out /new/artifact-directory
python3 -B release_tool.py verify --zip /new/artifact-directory/zcode-token-usage-statusbar-vX.Y.Z.zip --manifest /new/artifact-directory/release-manifest.json --repo OWNER/REPO
```

- 不覆盖已有未知资产目录。检查 JSON 输出、ZIP、SHA256、版本/tag/repository。发布包仅包含市场、许可证与插件运行所需白名单文件；不包含本项目发布技能、发布工具、用量数据、用户配置、凭据、缓存、锁或截图。`build` 另输出 `marketplace-release.json`，是渠道清单，不是第三个 Release 资产；根目录本地 `marketplace.json` 保持不变。
- **派发执行阶段 A 核查**：按上方「多 Subagent 派发策略」派发只读 subagent（默认模型逐路，`review-runner` 可同时跑），完成：
  1. `overlay.js` 的 `VERSION` 代际台账、升级链验证（用历史 tag 里的 `release_unpack.py` 校验新 ZIP，任何一版拒绝或取不到都不得发布）、重启要求判定（命令都在 [发布前检查](references/pre-publish-checks.md)）；并行工作各自递增会出现同号不同义或乱序（实证：两处 v92 各指不同功能；热修 `v99.1` 被插到台账最前面），发现就由主 agent 在 `src/overlay/06-instance-dom-and-styles.js` 按时间线重排后运行 `python3 sync_plugin.py` 重新生成根 `overlay.js` 与插件副本，再重新 build/verify。
  2. 全量测试与静态检查（可交给 `review-runner` 跑；出现环境基线之外的新失败时先修复，修不了就报告阻塞，不能继续发布；在 subagent 中运行时必须保证不往发布 worktree 写入任何字节或缓存）：

```bash
python3 -B sync_plugin.py --check
python3 -B scripts/build_mobile_userscript.py --check
node --check overlay.js && node --check inject-main.cjs
node --check zusage-mobile.user.js && node --check zusage-mobile.debug.user.js
node --test tests/*.test.cjs
python3 -B -m unittest discover -s tests -p 'test_*.py'
```

  漂移时先检查源文件，只同步项目自己的副本。红灯要先区分「环境基线」与「本次改动」：依赖本机已安装客户端的用例（如 `test_renderer_bridge` 读取真实 `app.asar` 的两个）会随客户端版本漂移变红，在未改动的目标提交上同样复现。环境基线红默认接受并继续发布，但要有对照证据：在目标提交的干净检出（不含版本号改动）上复跑同一测试文件，失败集逐例相同才算基线红；收尾报告逐例点名（用例名、所属文件、失败原因）。出现基线没有的新失败，或对照没有做成，才算发布阻塞。

## 生成更新说明

可由阶段 A 的只读 subagent 先完成提交/PR 扫描、冷文件 diff 核对与日志消费者合同核查，再由主 agent 汇总并写入最终说明文件：

- 先执行 [更新日志交付](references/update-log-delivery.md) 的消费者能力检查与来源映射：以目标提交中实际实现为准，未实现日志 UI 时只准备 Release 正文，不将设计计划写成已发布功能；已实现时检查其数据合同与适用回归。日志必须对应准确仓库、渠道和版本/提交，不用 latest 或同版本号猜测源码对应关系。不要为此擅自新增包内文件、第三个资产或修改发布 schema。
- 按 [更新说明规范](references/release-notes.md) 核实范围、对齐 ZCode 官方更新日志风格撰写短说明：只保留「新功能」「修复与改进」，空节省略，条数随本版改动体量自然呈现，每条一句白话（句末不加句号、不加粗前置标签）；必要的重启或迁移提醒并入相关条目，不附安装说明、验证或提交范围。未发布的渠道、未安装的客户端、仅夹具验证的平台必须如实区分。使用 Write 保存为新的 UTF-8 `release-notes.md`，放在独立资产目录或临时目录，不混入 ZIP 或修改用户现有文件；拒绝空正文和仅项目名/版本的一行占位，发布工具不会自动编造说明。
- 更新说明由主 agent 按上述规范起草、自检并定稿，直接用于预演与发布，不向用户征询「要不要改」；用户在调用时给了具体修改意见的，按意见修订并重新预演。发布之后用户要求补充或修订的，走「修订已发布说明」。

## 提交与 tag（阶段 B，默认已授权）

1. 提交本次发布需要的**全部**改动，仅暂存这些文件，不使用 `git add .`：三个 manifest、`src/mobile/00-meta.js` 和根目录 `zusage-mobile.user.js`、`zusage-mobile.debug.user.js`；若阶段 A 重排了 `VERSION` 台账，还有 `src/overlay/06-instance-dom-and-styles.js`、根 `overlay.js`、插件副本和断言该代际号的测试（这类改动先向用户确认）。提交信息沿用 `release: vX.Y.Z`。默认分支上需提交时先创建分支（常规路径已在 `release/vX.Y.Z`）。
2. **推 tag 之前的闸门**。已推送的 tag 不能移动，而 preflight 的多数检查要等 tag 推送后才第一次运行，所以先在本地把它们跑出来。命令都在发布 worktree 里执行：

   ```bash
   git status --porcelain --untracked-files=all          # 必须为空
   python3 -B scripts/build_mobile_userscript.py --check  # 必须通过，否则不打 tag
   R=$(mktemp -d)
   python3 -B release_tool.py build --root /abs/.worktrees/release-vX.Y.Z --repo OWNER/REPO --out "$R/recheck"
   cmp /new/artifact-directory/zcode-token-usage-statusbar-vX.Y.Z.zip "$R/recheck/zcode-token-usage-statusbar-vX.Y.Z.zip" && echo "ZIP 与重新构建的一致"   # build 是确定性的
   git ls-remote fork 'refs/tags/vX.Y.Z' 'refs/tags/vX.Y.Z^{}' | tail -n 1 | cut -f1   # 必须无输出（远端还没有这个 tag）；有输出就停，别往下走
   git tag vX.Y.Z                                        # 上一行确认无输出之后才执行；只打本地 tag，尚未推送
   python3 -B release_tool.py publish --root /abs/.worktrees/release-vX.Y.Z --zip /new/artifact-directory/zcode-token-usage-statusbar-vX.Y.Z.zip --manifest /new/artifact-directory/release-manifest.json --repo OWNER/REPO --notes-file /absolute/release-notes.md --dry-run
   gh api 'repos/OWNER/REPO/releases?per_page=100' --paginate --jq '.[] | select(.tag_name=="vX.Y.Z") | .tag_name'   # 必须无输出：没有同名 Release 或 draft
   ```

   上面 `git ls-remote` 的 stderr 有报错（网络、认证）说明没查成，不等于「远端没有这个 tag」，先修好再继续。预期这次 `--dry-run` **恰好**在查远端 tag 处失败（`gh api repos/OWNER/REPO/git/ref/tags/vX.Y.Z … Not Found (HTTP 404)`），这说明此前的检查（相关文件已提交且与 HEAD 逐字节一致、ZIP 等于当前源码、GitHub 远程匹配、本地 tag 指向 HEAD、gh 登录与推送权限）都通过了；`gh` 未登录或网络故障会在更早一步以别的错误停下，不会与这个 404 混淆。**只要报错不是这个 404，一律视为「没查成」，重试，不能当作通过**（`net/http: TLS handshake timeout`、`EOF` 这类瞬时错误在实测里出现过）。其它结果这样处理：
   - 更早失败（`dirty or untracked`、`ZIP is not the current repository source`、权限等）：修好、重新 build，再来一遍。本地 tag 需要重打时，先用上面的 `git ls-remote` 确认远端没有（无输出且 stderr 干净），再 `git tag -f vX.Y.Z`。
   - 远端已经有这个 tag，但指向的不是 HEAD（上面 `git ls-remote` 那行输出的 SHA 与 `git rev-parse HEAD` 不同，或预演报 `remote tag does not point to HEAD`）：停下来报告，不要 `git tag -f`、不要再推送——已推送的 tag 不能移动，处置见 [发布失败与回退](references/publish-failures.md#tag-或提交需要变更)。
   - 远端 tag 已经指向 HEAD（那行输出的 SHA 等于 `git rev-parse HEAD`），且还没有 Release（预演意外**完整通过**）：此前推送过。不要重推，报告用户，由用户决定直接进入阶段 C/D。
   - 已经有同名 Release 或 draft（预演报 `release already exists (including drafts)`；或者远端还没有 tag、预演在 404 处就停了，而上面最后一条 `gh api … releases` 有输出）：停下来报告，按 [发布失败与回退](references/publish-failures.md) 的「draft 残留」「已公开但核验不符」处理，不要重发。
   - 放弃发布（用户叫停，或闸门失败后放弃）：删掉这个本地 tag，`git tag -d vX.Y.Z`（仅限远端没有它的本地 tag）。
3. 推送（默认已授权）：常规路径 `git push fork release/vX.Y.Z vX.Y.Z`，分离路径只推 `git push fork vX.Y.Z`。工具不会创建或推送 tag，缺 tag 时 preflight 直接失败，不让 GitHub 从默认分支默默创建。`fork` 的双 push URL 会同时推到 GitCode 镜像，GitCode 段失败如实报告，不阻断 GitHub 侧；但本次要镜像 GitCode Release 时，tag 必须已经到达镜像，见阶段 D 的「GitCode tag 闸门」。
4. 万一推送后才发现要改提交，见 [发布失败与回退](references/publish-failures.md#tag-或提交需要变更)。

## 预演与正式发布（阶段 C、D）

- 默认镜像 GitCode：预演与正式发布都带 `--gitcode-repo tanranran/zcode-token-usage-statusbar`，用户调用时明确说不同步才去掉。推送 tag 之后、进入 D 之前，对已推送的 tag 执行带 `--notes-file` 与同一个 `--gitcode-repo` 的完整预演（就是上一节第 2 步代码块里那条 `publish … --dry-run` 再加 `--gitcode-repo`；预演不检查令牌、不写远端，但会把 GitCode 步骤算进计划）。用户只要预览时，报告里写明「未含正式发布」。预演仍联网只读 GitHub，不授予发布权限。这次应当完整通过（退出码 0）：检查 JSON 的 `notesFile`、`notes`、创建命令的 `--notes-file` 和 `gitcode` 步骤；说明修改后必须重新预演。报告将发布的仓库、版本、目标 commit、tag、资产、更新说明及实际预演结果；源码未提交或 tag 未就绪时报告阻塞，不把 build 成功称为已发布。
- 执行 D 之前不再向用户询问：E 与 GitCode 镜像都在默认全链内。只做一项核对——令牌。环境变量 `GITCODE_TOKEN` 未设置时（`test -n "$GITCODE_TOKEN" && echo 已设置`，不要回显令牌；`--dry-run` 不检查它），用 `git credential fill`（`protocol=https`、`host=gitcode.com`）取钥匙串里 gitcode 的 git 凭据 password 导出，做法见[发布后收尾·GitCode 渠道](references/post-release.md#gitcode-渠道)；令牌只经环境变量传给发布命令，不落盘、不进日志。取不到令牌就停下报告，由用户处理；不要去掉 `--gitcode-repo` 悄悄只发 GitHub。D 结束时 `publish` 输出的 `channelLag` 滞后警告属流程内常态（E 紧随其后），E 推送并回读一致后即消除；用户调用时排除了 E 的，收尾报告**第一行**写「渠道清单未更新，注册用户暂收不到本版」并给出补推路径（[发布后收尾·补推](references/post-release.md#补推release-已发渠道清单未更新)），不得只在末尾遗留项里一笔带过。
- **GitCode tag 闸门**（仅本次带 `--gitcode-repo` 时）：工具创建 GitCode Release 的请求只有 `tag_name`、`name`、`body` 三个字段，不带 `target_commitish`。GitCode 官方 API 文档（`docs.gitcode.com/docs/apis/post-api-v-5-repos-owner-repo-releases`）对 `target_commitish` 的描述原文是「分支名称或者commit SHA，如果tag不存在，需要新建tag则传入该参数，如果不传入该参数，则为默认分支的最新提交」。文档没有明说缺 tag 时是否会自动新建，按字面最坏的情况是据此建出一个指向错误提交的 tag（未实测）。所以执行 D 之前先确认 `gitcode` 远程就是 `--gitcode-repo` 指向的仓库，并且镜像上已有同一个 tag、指向发布提交。本项目历史上有附注 tag（v1.4.0、v1.4.1），所以同时查剥离后的 `^{}` 行并取最后一行（轻量 tag 只有一行，附注 tag 的最后一行才是提交）：

  ```bash
  git remote get-url gitcode                                                              # 须是 --gitcode-repo 指向的仓库
  git ls-remote gitcode 'refs/tags/vX.Y.Z' 'refs/tags/vX.Y.Z^{}' | tail -n 1 | cut -f1   # 镜像上该 tag 指向的提交
  git rev-parse 'vX.Y.Z^{commit}'                                                         # 必须与上一行相同
  ```

  第 1 条与 `--gitcode-repo` 指向的仓库不符：停下报告，不改 remote 配置、不补推。第 2 条的 stderr 有报错（远程缺失、网络或认证问题）：这是「无法核对」，不是「镜像缺 tag」，不执行 D、不补推，报告用户。第 2 条干净地输出为空（命令成功，镜像上确实没有这个 tag）：阶段 B 推送时 GitCode 段多半失败了，不执行 D，报告用户；补好 HTTPS 凭据后，**优先重跑阶段 B 步骤 3 的 `git push fork …`**（两段推送都幂等，只补缺的一端，不移动 tag；默认全链已含 B 的推送，用户调用时只授权了 D、tag 是用户自己或更早的会话推的，先问用户、等答复再推）。重跑仍补不上时再 `git push gitcode refs/tags/vX.Y.Z`，同样只补这一端。SHA 不同：镜像上已有同名却指向别处的 tag，不得移动，停下报告。
- 预演通过后，以同一说明执行 `--publish --confirm OWNER/REPO/vX.Y.Z --gitcode-repo tanranran/zcode-token-usage-statusbar`（默认全链已授权；用户调用时说明不同步 GitCode 的去掉 `--gitcode-repo`）。工具读取说明快照、建 draft、上传双资产、下载逐字节核验、检查 draft 正文并重查远端 commit，再转正式并核验正文/状态。同一命令会在 GitHub 验收后镜像 GitCode Release（需环境变量 `GITCODE_TOKEN`，缺失时 `--publish` 在创建 draft 之前就整体失败，见 [发布后收尾](references/post-release.md#gitcode-渠道)）。
- 失败保留现场，不盲删重建、不自行转正：draft 残留、已公开但核验不符等情形的处置见 [发布失败与回退](references/publish-failures.md)。
- 发布后通过 `gh release view vX.Y.Z --repo OWNER/REPO --json url,body,isDraft,isPrerelease,tagName,assets` 确认正式状态与两个资产；将 `body` 与说明比较（仅允许 CRLF 与末尾空白差异），报告真实 URL。正文缺失或不一致不是验收成功。GitCode 镜像完成后，还须按 [更新日志交付](references/update-log-delivery.md#5-发布前与发布后验证) 单独回读同 tag 的正文与提交（可派发只读 subagent 分别验收 GitHub Release 与 GitCode 镜像正文/资产，节奏按审查并发规格）；镜像工具资产验收不能代替正文验收。日志未就绪的渠道暂停清单推进，已完成的其它渠道分别报告。
- 用户要求替换已发布版本时，按 [发布失败与回退](references/publish-failures.md#要求替换已发布版本) 存快照后停止，逐步取得授权。

## 修订已发布说明

用户明确要求补充/修订指定 Release 的说明即授权该正文编辑，不代表允许修改版本、tag、资产、渠道或其它 Release。流程（快照 → 按已发布 tag 的提交撰写 → `gh release edit --notes-file` → 回读比较）见 [更新说明规范](references/release-notes.md#修订已发布说明)；不要调用 `release_tool.py publish`，不要删除、重建或重传资产。另按 [更新日志交付](references/update-log-delivery.md#6-修订与最终报告) 检查镜像、包内快照和缓存差异；只同步已授权的正文目的地，不因修订 GitHub 正文默认获得 GitCode 写权限。

## 发布更新渠道清单（阶段 E）

- 正式 Release 验收通过后，默认接着（默认全链已含本阶段，用户调用时排除 E 的才跳过）将生成清单作为 `marketplace.json` 发布到同一仓库明确 ref `plugin-releases`，GitCode 版清单发布到 `plugin-releases-gitcode`；预演只展示动作。
- 本阶段全程受[渠道分支不变量](#渠道分支不变量硬约束)约束，两个分支各走一遍下面的固定顺序：
  1. **记录旧 tip**：`git fetch fork <分支>` 与 `git fetch gitcode <分支>`，记下两台主机的 tip（消费者验收里的 `OLD`）。两端不同就先停下查清原因，不推。
  2. **核对清单**：只更新本插件、版本递增、清单里的 sha256 等于 Release 资产的 digest、URL 指向本次 Release。
  3. **生成提交**：`release_tool.py channel-commit --parent fork/<分支>`（或从远端 tip 派生独立 worktree 后提交），不从源码树提交；只在项目根操作，不切换或清理脏开发工作区。
  4. **普通推送**（不加任何 force）；被拒就回到第 1 步重读远端，不盲目重试。
  5. **消费者验收**（不变量第 2 条三项全做）：克隆地址用该渠道用户实际使用的地址——GitHub 渠道用 GitHub 仓库地址，GitCode 渠道用 GitCode 仓库地址。
- 渠道没通过消费者验收时不能声称远端更新可用，也不得在 issue 回复里写「会自动看到」。`fork` 的双 push URL 会同时推到 GitCode；渠道分支按设计直接推送，不开 PR。
- 新用户注册 `OWNER/REPO#plugin-releases`；已有注册不会自动切换，不修改用户市场注册。完整命令见 [发布后收尾](references/post-release.md)。
- 渠道分支只放 `marketplace.json` 与 `LICENSE`（刷新时下载最少）；调整树形态同样是以远端 tip 为父的普通提交，见[渠道分支精简](references/post-release.md#渠道分支精简)。

## 发布后合并源码 PR

- 阶段 F。正式 Release 正文与资产验收通过后，必须完成本次源码 PR 合并，不能把「Release 已发布、源码仅在发布分支」当作完整发版完成。渠道分支（整仓快照，但每次提交只改 `marketplace.json`）不作为源码 PR 的 head 或 base；补合并已发布版本时不重新打包或移动 tag。
- 用 `gh pr list --repo OWNER/REPO --state all --head HEAD_BRANCH --base BASE_BRANCH` 查找本次 PR；已有 open PR 则复用，已合并则验收后跳过，关闭未合并或不明确对应关系时先核对原因，不创建重复 PR。没有 PR 时用 `gh pr create --repo OWNER/REPO --head HEAD_BRANCH --base BASE_BRANCH --title ... --body-file ...` 创建，正文包含版本、Release 链接、修复范围和实际验证结果。
- 合并前读取 PR 的 `headRefOid`、`baseRefName`、`files`、`mergeable` 和 `statusCheckRollup`，核对 head 包含已验收 tag 的提交（`git merge-base --is-ancestor vX.Y.Z <headRefOid>`）且 diff 仅为本次已审查改动。检查失败、冲突、待运行检查或分支内容变化时停止并修复/重新验证，不使用 `--admin` 绕过规则。无检查时按真实状态记录，仍须具备已执行的本地测试证据。
- 优先使用 merge commit 保留已发布提交历史：`gh pr merge NUMBER --repo OWNER/REPO --merge --match-head-commit VERIFIED_HEAD`。仓库不允许该方式时，依据仓库策略选择可用方式并核对主分支的实际文件；不要强推，不移动已发布 tag，不因合并重传资产，也不自动删除分支（`release/vX.Y.Z` 发布分支是否清理由用户决定）。
- 合并后用 `gh pr view NUMBER --repo OWNER/REPO --json state,mergedAt,mergeCommit,url` 确认 `MERGED`；重新读取远端 base tip，验证包含 merge commit，以及已发布提交的祖先关系（merge 方式）或等价文件内容。报告 PR URL、合并 commit 和 base。合并被阻止时明确标记「Release 已发布，PR 合并未完成」，不得宣称完整发版完成。
- 镜像同步：`gh pr merge` 只作用于 GitHub，GitCode 镜像的 base 分支不会自动跟进。合并验收后 `git fetch fork`，再执行 `git push fork refs/remotes/fork/BASE_BRANCH:refs/heads/BASE_BRANCH`，把刚取到的远端 tip 同时推给两个镜像主机；不要用 `git push fork BASE_BRANCH`：本地 base 分支常落后于远端而被拒，而且用本地分支推送失败后，本地的 `fork/BASE_BRANCH` 引用可能被改写成镜像的旧位置，之后的推送会被 GitHub 判成非快进。所以推送前后都先 `git fetch fork`。回读 `git ls-remote gitcode BASE_BRANCH` 的 SHA 应等于合并后的 `fork/BASE_BRANCH`。镜像滞后不算发版失败，但收尾必须报告同步状态。
- 保留本地其它会话改动，远端合并不要求切换或清理脏工作区。若发布后增加技能/文档等必要收尾提交，应单独测试并明确它们位于 tag 之后，只进入 PR，不写成已发布包中的功能。

## 收尾

- 按 [更新日志交付](references/update-log-delivery.md#6-修订与最终报告) 分来源报告准确版本、正文来源与验收状态，区分「发布正文就绪」「渠道可更新」「插件内展示已验证」。消费者未实现或无真实宿主时明确标记不适用/未验证，不把发布成功称为日志功能已上线。
- 分别报告打包、升级链验证、提交/tag/推送、Release、渠道、更新端验证、源码 PR 合并及 GitCode 镜像 base 同步状态。未执行就明确写未执行；完整发版须给出已合并 PR 的 URL 与验证结果。渠道一项按分支列出：旧 tip → 新 tip、两端是否一致、快进验证、消费者模拟（旧克隆 `pull --ff-only` 后的清单版本）；完整发版以两个渠道分支的消费者验收全部通过为完成判据，任何一项没做就写「未验证」。发版之后若还要动渠道分支（任何会话、任何理由），同样受[渠道分支不变量](#渠道分支不变量硬约束)约束，推送后重做消费者验收。
- GitCode 段推送失败时，先看原因：凭据问题就补配凭据重推（重推范围不得超出本次已授权的动作，授权口径见阶段 D 的 GitCode tag 闸门）；被拒原因是非快进（镜像比 GitHub 多出提交、两边分叉）时不重推、不强推，报告现状请用户处理。都不据此重发或回滚 GitHub Release；要求 GitCode 渠道时报告 `--gitcode-repo` 的发布/上传/清单结果与 `plugin-releases-gitcode` 分支状态。全新 clone 没有双 push 配置，渠道推送只到 GitHub，需要镜像时显式加入推送目标（[双远程同步](../../../docs/maintaining.md#双远程同步)）。
- 回到项目根清理本次临时 worktree：`git worktree remove .worktrees/release-vX.Y.Z`（以及渠道 worktree）；删前确认发布提交已在远端或 tag 上，有未跟踪文件会被拒绝，先看是什么，不要直接 `--force`。不自动删除 `release/vX.Y.Z` 分支，是否清理由用户决定。
- 不安装或覆盖用户缓存，不自动重启客户端。发布成功不等于用户已安装。
