# 项目菜单「在 Finder 中打开」（v486）

宿主项目侧栏两处菜单（项目行右键 contextmenu、项目行内「…」dropdown）各注入一枚「在 Finder 中打开」菜单项，点击在系统文件管理器打开对应项目根目录。2026-11-26 用户规格，行为语义经确认：打开目录本身（非「访达中定位选中」、非应用内文件浏览）；首版直调主进程 open-path，后按用户提示完全参照宿主任务右键菜单原生的「在 Finder 中打开」实现，改为**纯渲染端直调宿主 preload 桥**，inject-main.cjs 零改动。

## 数据链（与宿主任务菜单同通道）

- 渲染端直调 `window.zcode.openInFileManager(path)`（preload index.cjs 暴露，IPC `zcode:open-in-file-manager`，回执 `{success, error?}`；宿主任务菜单「在 Finder 中打开」经 `openInEditor('finder'/'explorer', path)` 与 `openInFileManager(path)` 三段回退，本地目录场景二者等价）。真机 4.0.0 实证：`window.zcode` 桥对象在场、`openInFileManager` 为函数。
- 文案跟随宿主三平台措辞（appHeader.openInFinder / openInFileExplorer / openInFileManager，按 navigator.userAgent 平台分支）：mac「在 Finder 中打开」/ win「在文件资源管理器中打开」/ 其它「在文件管理器中打开」，英文 Open in Finder / Open in File Explorer / Open in File Manager。
- 回执失败（目录已删等）菜单项静默，`FATAL.openPathErr.n` 计数，不弹错误 UI；回执为 null/undefined（宿主未来改 fire-and-forget）视为打开已发起、不计失败。

## 注入规则

- **右键菜单**：宿主 `nB({actions})` 为每个根目录渲染一枚 `virtual-project-context-files-N`（「查看文件 · <路径>」）。在每个 files 项之后插入一枚对应路径的注入项；路径取该项 `textContent` 中首个 `" · "` 之后的路径形态段（`/`、`~` 开头、盘符 `X:\` 或 `X:/`、Windows 原生 UNC `\\server\share\…`、长路径前缀 `\\?\C:\…`——网络共享做根的本地项目同样出项），解析失败 fail-closed 跳过。
- **「…」下拉**：宿主下拉 actions 无 files 项，路径取自行组件 props。链路：菜单 content 的 `aria-labelledby` → 触发按钮 id → `closest('[data-testid="virtual-project-row"]')` → React fiber 上溯（≤48 层，实测行元素 36 层）取 `memoizedProps.project.roots[].rootPath`（SOt 层 `paths` 字符串数组为备选形态），取**首根**（与宿主行内「查看文件」按钮 `M[0]?.run()` 同语义）；任一环节取不到 fail-closed 不注入，不猜路径。
- **本地/远程甄别（fail-closed）**：宿主把 `data-project-host` 烙在项目行外层 section（真机本地恒 `"local"`）。右键菜单的来源行经 document 捕获阶段监听记录（ContextMenuContent 不回指触发行；记录自右键按下起 8 秒内有效）：右键按下（`pointerdown`，button 2）即记录——任何平台都早于菜单挂载；`contextmenu` 再记录一次并补排一次扫描（幂等）。`contextmenu` 的派发时机各平台不同（macOS / Linux 在按下时、Windows 在松开时），菜单何时打开取决于宿主 Radix 的版本：4.0.0 引擎包实证当前宿主在 `contextmenu` 里才开菜单；宿主一旦换成按下即开的版本，Windows 上就是「菜单先挂载、扫描先跑、`contextmenu` 后到」，只靠 `contextmenu` 记录会断链。松开时指针落在刚弹出的菜单里，落在菜单内的 `contextmenu` 不动记录，其余右键清掉旧记录。下拉经 labelledby 链取行；`data-project-host !== "local"` 或属性缺席（宿主改版）一律不注入——远程项目在本地打开无意义。
- 菜单项外观克隆同菜单既有项（默认克隆 `virtual-project-worktrees`），剥 `data-testid`/`data-radix-collection-item`/`id`/`data-orientation`，换 lucide folder-open 图标，挂 `data-zusage-open-folder="1"` 标记幂等。
- 点击：`stopPropagation` + 直调桥 + 向菜单派发 Escape（Radix DismissableLayer 关闭宿主菜单）。
- 悬停高亮（与原生菜单项一致）：Radix 的高亮（`data-highlighted` → `data-[highlighted]:bg-menu-hover`）只分发给 collection 成员，注入项已剥成员标记——mouseenter 自挂 `data-highlighted` 补齐 hover 效果，并把同菜单宿主项上的残留高亮清掉（指针从宿主项直接移到非成员时 Radix 的 pointermove 找不到成员、原高亮不撤）；mouseleave 摘除自身属性。方向键导航不覆盖注入项（非成员不参与 Radix 键盘集合），悬停是唯一高亮路径，属已知取舍。

## 所有者、回收与热更

- 渲染端唯一新增：`src/overlay/05-project-open-folder.js`（外层闭包，不进 spawnInstance——菜单是文档级对象，与 pane 实例无关）；inject-main.cjs、快照协议、Python 零改动。
- 门控：`window.zcode.openInFileManager` 非函数（宿主旧版/桥缺失）时整链不注入（扫描级前置，渲染端自证，无能力标记协议）。
- 观察：MutationObserver 只挂 `document.body` **直属子节点**（Radix portal 容器都在 body 直属层；聊天流式变更都在应用根子树内，不触发本观察器，不进热路径），rAF 去抖扫描；注入热重载后立即 `zuOpfScan()` 一次（跨重注入存活的已开菜单补注入）。
- 回收：03 分片 `disposeOverlay` 增 `zuOpfDispose()`（typeof 守卫，切片沙箱兼容）：observer disconnect + 取消在途 rAF + 摘除 contextmenu / pointerdown 捕获监听 + 清记录。
- 菜单项是宿主 React DOM 内的手动节点，弹层关闭即随宿主整体卸载，无需摘除路径；不新增 body 级浮层根，不涉 no-drag/modalOpen 四处登记。
- 已知边界：菜单打开期间宿主重建 items 列表会摘掉注入项，本观察器不重扫（body childList 不变）；Radix 菜单打开中重建属罕见路径，实机观察到再加自愈。

## 验收场景

1. 本地项目右键菜单出现「在 Finder 中打开」，真实点击后访达打开该项目目录、菜单关闭。
2. 本地项目「…」下拉出现同款，同上。
3. 多根项目：右键菜单每个「查看文件」项后各一枚，路径一一对应（真机 smzdm-harmony 3 根实证）。
4. 远程/设备项目（`data-project-host` 非 local）：两类菜单都不注入。
5. 宿主旧版（无 `window.zcode.openInFileManager`）：不注入，其余不变。
6. 非 `virtual-project-*` 的其它 Radix 菜单零扰动。
7. 重复扫描/已注入菜单再扫描不重复插入。
8. 回执 success:false：无 UI 报错，diag 计数递增。
9. 悬停注入项：高亮底色与原生项一致；从宿主项移入时宿主项高亮撤掉（同菜单同时只有一个高亮）；移出后注入项高亮撤掉。
