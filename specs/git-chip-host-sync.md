# Git chip 与宿主原生胶囊对齐：刷新时机 + 点击唤起弹层（v420）

状态：已实现。覆盖两个行为变更：①Git 数据刷新时机从「10s 轮询 + 快照驱动 5s 节流重查」改为与宿主原生 Git 状态胶囊同款「fs watch + 60s 尾随防抖」；②chip 点击从「立即刷新」改为「优先唤起宿主原生胶囊弹层，缺胶囊回退立即刷新」。

## 0. 宿主原生事实（源码依据，镜像 /Users/hmey/Workspace/AI/ZCode v3.18.2）

- 防抖常量与语义：`packages/ui/src/hooks/useGitAutoRefresh.ts:15` `GIT_AUTO_REFRESH_DEBOUNCE_MS = 60_000`；`:110-121` `scheduleRefresh` 每个事件 clearTimeout 并重设 60s 计时器——**尾随防抖**，持续写文件期间一直顺延，静默满 60s 才刷新一次。
- 监听面：UI 侧 `lib/gitAutoRefresh.ts:25-67` `buildGitAutoRefreshWatchPaths`——workspacePath（**非 Linux 才 recursive**，Linux 禁递归防慢挂载阻塞 workspace Host）+ 服务侧 `gitCliRepo.ts:142-165` `buildAutoRefreshWatchPaths` 输出的 `--absolute-git-dir` 与 `--git-common-dir`（**恒递归**；linked worktree / separate git-dir 的元数据在主仓库侧也被覆盖；相对 commonDir 以 workspacePath resolve）。
- 失败策略：`useGitAutoRefresh.ts:146-157` watcher 创建失败仅 `logger.warn`，保留手动刷新与 Git 操作后刷新链，**不回退轮询**。
- 胶囊可见性：干净仓库（added+removed≤0）整个 Git 分区不渲染（`conversationStatusPanelModel.ts:144-179`）；胶囊本体不显示 ahead/behind（仅推送弹窗显示「领先/落后」）。

## 1. 刷新时机（feature 1）

数据链不变（渲染端 `publishGitPaths` → 主进程 `gitTick` + `git-refresh` 请求 → `__zusageGitState` 推回），只改触发时机：

- **inject-main.cjs**（冷文件）：
  - 移除 `GIT_TICK_MS = 10000` 轮询定时器。
  - 新增 fs watch 层：监听面 = 工作区目录（`process.platform !== "linux"` 时 recursive）+ `git rev-parse --absolute-git-dir --git-common-dir` 一次性解析的 .git 元数据目录（恒 recursive；相对结果按工作区 `path.resolve`；与工作区相同或重复去重）。多仓父目录（自身 notrepo）解析失败时只有工作区 watcher（递归时天然覆盖子仓 .git）。
  - 防抖：任一 watch 事件重置 60s 计时器（`GIT_WATCH_DEBOUNCE_MS = 60000`，与宿主同值同型），静默满 60s 跑一轮 `gitTick(false)` 全路径查询。
  - watcher 生命周期随 gitTick 的路径并集增删（窗口关闭/切换工作区即 close）；元数据解析+建 watcher 每路径一次，在途去重（`gitWatchResolving`），全失败的路径不登记、待后续 tick 触发重试。
  - watcher 创建失败仅记一次日志，不回退轮询（宿主同策略）；`shuttingDown` 时不再排程。**无自愈边界（v433 备注）**：路径自身的重试只来自其他路径事件/点击/路径集变化——单工作区且建档一次即失败（如瞬时 EMFILE）时没有独立重试定时器，与「不回退轮询」同为一意接受的取舍。运行期 watcher 错误（目录删除重建等）会把路径摘出登记表，由下一轮 tick 重建。
- **渲染端（01 分片）**：`publishGitPaths` 只在路径集变化时 `askGitRefresh(true)` 立即首查；取消「每次快照到达按 5s 节流重查」（原用途=模型刚改过文件，现由 fs watch 覆盖）。`askGitRefresh(force, done, path)` 函数签名与点击回退链原样保留。
- 保留不变：多窗路径并集去重查询、消失路径 notrepo 补推（`gitMissingNotified`）、失败保留 lastGood + stale 徽章、无提交仓库 diff 回退、多仓聚合。

已知边界（有意接受，与宿主一致）：fs watch 失效的卷（个别网络挂载）上 chip 只剩路径集变化/点击回退两条刷新链；持续写文件期间防抖持续顺延，chip 数字可能在活动停止后最多 60s 才更新——这正是宿主胶囊的节奏。多仓父目录在 Linux 上非递归 watch 覆盖不到子仓内容变更（macOS/Windows 不受影响）。

## 2. 点击唤起原生胶囊弹层（feature 2）

- chip 点击（含 Enter/Space 键盘路径）优先在 **pane 节点（`wantedEl`，即 SessionPane 根）内**查 `[data-status-capsule="git"]` 且可见（`getClientRects().length > 0`）：
  - 命中：`hideGitTip()` 后向胶囊派发 `pointerdown → mousedown → pointerup → mouseup → click` 合成事件序列（`bubbles`，坐标=胶囊中心，button 0），由宿主 Radix 打开原生弹层；**不发起 git-refresh、不进 busy**（与原生胶囊点击只开面板的语义一致）。pointer 系在 `PointerEvent` 缺席时退化为 `MouseEvent`，全程 try 包裹。
  - 未命中：干净仓库宿主不渲染胶囊、旧宿主无该结构（`querySelector` 落空）、胶囊隐藏（rects 空）——回退**原有立即刷新链**，busy/请求回执（`__zusagePluginResult`）/scope 迁移取消保护全保留。
- 多仓父目录场景宿主无胶囊（胶囊只在 workspace 自身是仓库时存在），恒走刷新回退。
- **弹层定位迁移（v422）**：Radix 弹层默认锚在原生胶囊（位置写 wrapper 内联 `transform`，强改会被其定位引擎覆盖）。chip 触发开层后，对 popper wrapper（`[data-status-capsule-content="git"]` 的 wrapper 祖先）设置独立 `translate` 属性——与内联 `transform` 叠乘、Radix 不写该属性、无覆盖拉锯——把弹层迁到 chip 正上方（水平居中于 chip、底缘距 chip 顶 8px、左右/顶缘按视口钳 8px）。0–800ms 五档重试等 Radix 挂载完成，令牌去重防连点竞争；胶囊自身点击（非 chip 路径）不做迁移；Radix 后续重算 `transform`（窗口 resize 等）时 translate 偏移仍叠加生效但**不重算**——尺寸/位置变化后需关开一次刷新偏移，视觉箭头仍指向胶囊位置，均属已知外观差异。
- aria 不变：aria-label 仍播状态；chip 不是弹层 trigger，不声明 `aria-expanded`/`aria-controls`。

## 3. 验收场景

1. 工作区改文件后静默，≤60s chip 数字更新；持续写文件期间不刷新（防抖顺延）——与宿主胶囊节奏一致。
2. `git checkout` 切分支（.git/HEAD 变化）→ 60s 内 chip 分支名更新。
3. 脏仓库点击 chip → 宿主原生弹层打开（`aria-expanded=true`）、无 `git-refresh` 请求、chip 不 busy；干净仓库点击 → busy 旋转 + 立即刷新。
4. 旧宿主（无 `data-status-capsule`）点击 chip → 行为与 v419 完全一致（立即刷新）。
5. 新窗/切工作区（路径集变化）→ 立即首查并建档/撤 watcher；路径离开并集后旧 watcher 关闭。
6. fs.watch 抛错（权限/EMFILE）→ 查询与推送不受影响，日志一条告警，不崩溃不轮询。
7. worktree 会话：watch 的是覆写后的真实 cwd 与其 .git 元数据（v407 链不回退）。

## 4. 测试与部署

- `tests/inject-git-status.test.cjs`：轮询移除断言、watcher 注册/去重/相对 commonDir resolve/关闭、60s 防抖尾随重置、Linux 非递归、watch 失败非致命。
- `tests/overlay-git-chip.test.cjs`：点击命中胶囊（合成事件序列、零刷新请求）、胶囊缺失回退刷新、路径集变化首查/快照不再重查。
- 部署：`overlay.js`（01/06/11 分片）热文件；`inject-main.cjs` **冷文件**，需完全重启 ZCode 生效。
