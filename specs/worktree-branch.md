# Worktree 会话的 Git chip 路径修正与 worktree 标识

更新日期：2026-11-20
状态：本规格按 ZCode 源码（`/Users/smzdm/Projects/AI/ZCode`，docs/git/worktree.md §1.1/§2.1/§3.7/§6.3/§6.6.4）与插件当前检出源码写成，实现以本文为准。

## 背景与根因（ZCode 源码取证，2026-11-20）

ZCode 受管 worktree 的核心模型：**worktree 不是新 workspace，只是会话的 cwd**。目录布局固定为 `<dataBaseDir>/.zcode/worktrees/<4位小写hex bucket>/<源仓库名>`（`packages/shared/src/managed-worktree/layout.ts`），创建即 detached HEAD，会话 `directory` = worktree cwd 且创建后不变。

- ZCode 自家 Git 面板对 worktree 任务显式改用会话 cwd：`gitCwd = sessionCwd`（`packages/ui/src/v4/SessionPane.tsx:6710`），`sessionCwd = task.cwd ?? workspacePath`（`useTaskWorktreePlacement.ts:69`），并注明「worktree 任务是会话 cwd，缺省为 workspacePath（docs/git/worktree.md §3.7）」。
- 插件 Git chip 的数据链：渲染端把分栏 `workspacePath` 写进 `window.__zusageGitPaths`（`src/overlay/01-git-and-doc-tooltips.js` `publishGitPaths`），主进程每 10s 逐路径 `git -C <path> status --porcelain --branch` 后推回（`inject-main.cjs` git 轮询段）。分栏的 `workspacePath` 来自宿主 binding 的 `workspaceScope`（`WorkbenchPane.tsx` scope useMemo），对 worktree 会话它是**项目主目录**（宿主 §2.1：「名字带 workspace 的字段只表示归属」）。
- **缺口**：worktree 会话的 Git chip 查询与显示的是主 checkout 的分支/上游/改动计数——正是宿主 §3.7 警告的「按 cwd 工作的界面用了 workspace 路径」。chip 此刻展示的分支名与该会话实际工作的仓库无关。

## 目标

1. worktree 会话（本地、受管布局内）：Git chip 的查询路径与全部显示（分支/上游/ahead-behind/改动计数/进行中操作）落到 worktree 本身。
2. Git chip tooltip 增加「受管 worktree」区块：bucket 标识、根目录、起点（起点分支 ref，无 ref 显起点 SHA 短哈希，都没有显「当前 HEAD」——起点来自创建记录，不随后续切分支变化）。
3. 非 worktree 会话行为逐字节不变；远端 pane、手机 lean 帧、CLI/MCP stdout 契约不受影响。

## 数据契约

### Python（zusage.py → 快照顶层 `worktrees`）

- `snapshot()` 新增 `include_worktree=False` 参数，开启时顶层挂 `worktrees`；开关点与 `include_speed_history` 完全一致（serve 常驻 + legacySpawn 一次性 json 的桌面链；`lean:true` 与 `ZUSAGE_REMOTE_CHILD=1` 关闭）。WorkBuddy 分支在进入 zcode 逻辑前提前 return，不涉及。
- 形状：`{ "<sid>": {"cwd","root","bucket","name","ref","sha"} }`，只覆盖本帧 force_sid 中命中受管布局的会话；无命中时省略字段（不是空对象）。
  - `cwd`：会话 `session.directory`（realpath 归一，可能是 worktree 内的 monorepo 子目录，`root` ≠ `cwd` 属正常）。
  - `root`：`<managedRoot>/<bucket>/<name>`（realpath 归一）；`bucket`：4 位小写 hex；`name`：源仓库名。
  - `ref`/`sha`：会话首轮 `worktree_creation` timeline part 的 `worktreeCreation.ref`/`sha`（detached 默认创建时 `ref=null`，解析失败按缺失）。
- 受管判定只做纯路径布局匹配（前缀 + 两级结构 + bucket 形状），与宿主 `parseManagedWorktreePath` 同规则；不读 `.git`、不执行 git。目录已删除的 worktree 照常报告（realpath 宽容、part 记录仍在），交由渲染端/主进程自然降级。
- managedRoot 解析：`ZCODE_DATA_BASE_DIR` 优先，否则用户主目录，再接 `.zcode/worktrees`（与宿主 `resolveManagedWorktreeRoot` 一致）。
- 起点查询：`part_session_idx` 索引按 sid 取行，`data LIKE '%"timelineType":"worktree_creation"%'` 预滤后按 `time_created` 序在 Python 侧逐行 `json.loads` 校验，取第一条真正含 `worktreeCreation` 的（不依赖 SQLite JSON1；正文同字面量与损坏 JSON 行跳过继续，不遮蔽其后真实创建记录）。
- 进程内按 sid 缓存整条事实（cwd 创建后固定、ref/sha 落库后不变，属不可变事实）：**只有 session 行存在且 directory 非空**的 sid 才写缓存——已判定非受管写负缓存（None），行未落库/目录为空不写（下一帧自然重查）；缓存（含负条目）超 512 条整体清空。起点有「未决」态：`worktree_creation` part 实测比 session 行晚 ~1.2s 落库，首见帧可能缓存到空起点（ref/sha 同为 None），命中缓存也重查一次，拿到即转已决（sha 非空即已决，detached 默认形状 ref=null/sha=有值；全 detached 且无 part 记录的会话每帧一次该 sid 范围扫描，节流帧下可接受）。
- 缺列/查询异常：静默省略，不拖垮整帧（同 all_projects 口径）。

### 渲染端（src/overlay/）

- `window.__zusageUpdate`：本帧带 `worktrees` 对象时捕获到模块级 `lastWorktrees`（外层 IIFE 闭包变量，与 speed 粘性同位）；捕获先于尾部 render 循环，同帧 `refreshWants → publishGitPaths` 即可用上。
- `publishGitPaths`：本地 pane（scope 有 `workspacePath` 且 identity 为空）若 `lastWorktrees` 命中本 pane sid，则发布 `wt.cwd` 替代 `workspacePath`。路径集变化触发既有 `askGitRefresh(changed)` 立即首查。
- `gitChipView`：同规则覆写显示路径；view 携带 `wt` 供 tooltip 用。chip 上分支名/HEAD、↑↓、改动计数全部来自 worktree 的实时 git 查询，不加新段、不缩写（四级响应式 v383 形态不动）。
- tooltip（`gitTipHTML` 单仓路径）：`view.wt` 在场时追加两行——「受管 Worktree」= `<bucket> · <root 根目录路径>`（root 末段即源仓库名，name 不再单列）；「起点」= `ref`，无则 `sha` 前 7 位，都无则「当前 HEAD」；全部用户数据过 `gitEsc`。multi 聚合路径不加区块（worktree cwd 恒为单仓，多仓触发即说明未覆写）。
- 分支名不在 Python 读：主进程 `git status --porcelain --branch` 已按覆写路径实时给出（detached → chip 显 `HEAD`，与 ZCode 自家 chip 一致）；tooltip「目录」行随之显示 worktree cwd。

## 边界与降级

| 场景 | 行为 |
|---|---|
| worktree 目录已被删除 | 覆写路径声明后 `gitPathOk` 失败，主进程对该路径**补推一次** `{ok:false, reason:"notrepo"}`（按「窗口×路径」去重，多窗声明同路径各推各的；目录在该窗口恢复即解除、再次消失重新通知）→ `gitViewFor` 对 notrepo 恒 null → chip 摘除；删除发生在首查前则从无数据，同样不挂载。**不回退主 checkout 显示**（显示错误仓库比不显示更糟），任务本体按宿主规则只读。此修复同时覆盖普通工作区目录被删的既有残留（基线行为：曾查过的路径被静默滤除后 chip 永久显示最后成功态） |
| 远端 pane / 草稿 / 无 scope | 不覆写（identity 非空或无 sid，与现有 chip 隐藏条件一致） |
| 非受管路径（用户自建 worktree、主 checkout） | `worktrees` 无条目，发布与显示路径同现状 |
| 旧 Python 快照（无 `worktrees` 字段） | 新装载/重启后渲染端判空回退现状；**运行中** Python 降级（renderer 不重启）时 `lastWorktrees` 沿用最后一份映射——worktree 仍在则查询仍正确，已删除则按上行摘除，均不回退主 checkout |
| session 行未落库 / directory 为空 | 不写负缓存（与「已判定非受管」分开），下一帧自然重查——新会话 pane 先于数据落库出现时 chip 不缺席 |
| worktree 会话在分屏多开 | 每个 pane 按 sid 各自命中，互不借用 |
| mobile relay / 远端子查询 / CLI / MCP | `lean`/`ZUSAGE_REMOTE_CHILD` 门控不带字段，stdout 契约不变 |

## 验收场景

| ID | 场景 | 预期 |
|---|---|---|
| WTB-01 | 打开受管 worktree 会话 | chip 分支/↑↓/计数为 worktree 实时值（detached 显 HEAD）；tooltip「目录」= worktree cwd，另有受管 Worktree 与起点两行 |
| WTB-02 | 普通项目会话 | 无 `worktrees` 条目，chip 数据链与显示同现状 |
| WTB-03 | worktree 目录被删 | chip 隐藏，不显示主 checkout 状态 |
| WTB-04 | 起点 ref 有 / 无 / 缺 part | tooltip 起点分别 = ref / sha 前 7 位 / 「当前 HEAD」 |
| WTB-05 | 手机 lean 帧、`ZUSAGE_REMOTE_CHILD=1`、CLI/MCP | 快照无 `worktrees` 字段 |
| WTB-06 | 分支名/路径含 HTML 特殊字符 | tooltip 全部经 `gitEsc` |
| WTB-07 | 会话在 worktree 中切分支 | chip 与 tooltip 分支随下次 git 查询更新（10s 周期或点击刷新）；「起点」保持创建记录不变 |
| WTB-08 | 同 worktree 多会话 / 同目录 fork 子会话 | 均按各自 sid 命中同一 `{cwd, root, bucket}` |
