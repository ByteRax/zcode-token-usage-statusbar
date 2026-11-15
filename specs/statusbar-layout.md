# 状态栏项目排序、优先级与自动折叠

## 目标

默认状态条的七个项目可由用户自定义显示顺序与折叠优先级；空间不足时按优先级自动折叠整格进「···」菜单，宽窄变化稳定收敛，不改变统计口径与既有 tooltip 交互。

## 数据模型

- `zusage3.barOrder`：key 数组（`speed,turn,win,today,proj,tools,sub` 白名单）。归一化（`zuBarOrderNormalize`）：非数组/解析失败整体回缺省；非法 key 剔除、重复剔除、缺项按固定键序补尾（未来新增格不会被旧配置永久遗漏）。
- `zusage3.barPriority`：key→`high|normal|low`。归一化（`zuBarPriorityNormalize`）：非法值回落该 key 缺省、未知 key 丢弃。缺省按设计稿：速度/本轮=高、会话累计/今日合计/项目累计=普通、工具调用/子代理=低。
- 排序决定显示顺序；优先级决定空间不足时的折叠顺序。两字段独立，定向写（`persistBarOrder`/`persistBarPriority`，不搭全量 `persist()`，防跨窗口陈旧覆写）；storage 监听对两键归一化回读同步其它窗口。
- 既有用户无迁移成本：两键缺省时缺省序= v213 固定格序，`zusage3.show` 六格开关原样保留且继续由排序卡的显示开关写。

## 条面排序

- `html()` 每格带 `data-zu-key`（remote/not_local 徽标为 `system`）；渲染完成经 `zuBarSortItems` 按用户序重排，`system` 徽标恒置顶（按原始下标稳定），tooltip 串与 `.it` 下标对应关系不变。

## 自动折叠（仅 default 主题）

- 判定基于真实布局测量：`scrollWidth > clientWidth + 1`；不做字符数估算。
- 折叠序=`zuBarFoldOrder` 纯函数：低优先先折、同级按显示序靠右先折；`system` 与 `speed` 不参与折叠。`speed` 的「固定（始终显示）」指有有效速度数据时优先保留（无数据仍不渲染，绝不伪造 0 t/s），不是常显占位。
- 重算门控：宽度（bar.clientWidth）+ 字号/字族（getComputedStyle fontSize+fontFamily）+ 优先级签名 + `foldDirty`（重建/主题切换/优先级变更置位）。每帧另测一次溢出差 `ov = scrollWidth − clientWidth` 做双向触发：展开态 `ov>1` 触发折叠重算；折叠态 `ov ≤ 1−FOLD_HYS`（FOLD_HYS=24px）才触发回展尝试——迟滞带防数值刷新在阈值附近整格反复翻转。单向溢出探针是错的（「已折叠且刚好装下」直接变宽不经过溢出态，折叠集会冻结）。
- 折叠格 `data-zu-folded="1"` → `display:none`（CSS 属性选择器 + !important，React 不清理 data-*）；分隔线同步隐藏（首可见格前与相邻可见格间保留）。全折仍超宽由 `.zu-clip` 右缘渐隐兜底；「···」按钮与齿轮在 `.zu-main` 之外永不折叠。
- 居右对齐（`zusage3.barJust=end`）下首格被折叠时 `:first-child` 的 auto margin 失效，重算把 `data-zu-endlead` 挪到第一个可见格接管右聚拢。
- 折叠只影响显示：不写 `state.show`/localStorage；折叠集变化时关闭菜单并收起锚定在被折格/「···」按钮上的 tooltip（含折叠集清空后的零矩形锚）。

## 「···」菜单（body 级 `.zu-more-panel`，实例级闭包）

- 仅实际存在折叠项时显示（`data-zu-visible`），计数徽标=折叠格数；`aria-haspopup="menu"` + `aria-controls`。
- 菜单项=克隆格图标 + `ZU_BAR_TITLES` 格名 + 实时值（活格 textContent）。打开期间每帧原地同步值与 `__tip`（textContent/属性写，不 innerHTML、不抢焦点）；点击时从活格现取 `__tip`，不用打开瞬间快照。
- 点击行为：sub 项开子代理统一浮层（pinned；再点 ⋯ 关闭并归还焦点，对齐 `.zu-sub` re-click 契约）；其余项关闭菜单、焦点归还 ⋯ 按钮、弹该项目原有完整 tooltip（锚定 ⋯ 按钮）。
- 键盘：打开即焦点入首项；菜单内 ↑↓/Home/End 循环；Escape 在菜单内与焦点在 ⋯ 按钮上两条路径都关闭；外点（document pointerdown 捕获）关闭。tipOutsideDown 白名单与 boot 旧代清理串、`-webkit-app-region:no-drag` 联合规则均含 `.zu-more-panel`。
- 生命周期：`hideBar`（条隐藏/宿主模态/分栏切换）与 dispose 摘除；菜单开着时 mousemove 不另开条面 tooltip。

## 设置页排序卡（`.zu-layout-card` 单根嵌套卡）

- 行结构：SVG 拖拽手柄（勿用盲文字符）| 格图标（与条面同 path，两处需同步改）| 名称+两行说明（旧 settingRow 说明文案迁移保留）| 显示开关 | 优先级三段选择 | 上移/下移。speed 行无开关，显示「ⓘ 固定（始终显示）」徽标，优先级三段锁高禁用。
- 优先级控件=native radio 三段（`role=radiogroup`，方向键导航天然可用），选中态柔和主题底（color-mix brand）+ 内描边；change 走 `.zu-layout-prio` 委托。
- 拖拽：HTML5 DND 仅整行可拖，dragstart 排除 input/select/button；dragover 高亮 prevRow 记忆（命中行变化才摘/挂类），行间隙清残留高亮；drop 双向 splice 数学，鼠标拖放不还焦点。↑↓ 键盘排序：焦点跟移，落点同向按钮已禁用时回退同行可用控件；aria-live 播报「已移至第 N 位」。重置只还原 barOrder/barPriority 两键并回焦新按钮。
- 回填契约（v249 双回填）：syncPanel 同步三段选中态；行序与 `state.barOrder` 漂移（他实例已改）时整卡重建。跨窗口 storage 事件驱动同链同步。
- v66 分级收缩机制（先缩数字→藏次要→渐隐）整体退役：`shrink`/`fadeOn` 变量与死三目删除，窄宽行为由本折叠机制接管；`.zu-clip` 渐隐保留为全折仍超宽的兜底。

## 三主题兼容

- 折叠与菜单仅 default 档执行；非 default 档清折叠属性与 endlead、隐藏入口、关菜单、摘渐隐。pill 保留既有横滚/居中/表面跟随；compact 条 display:none 保留 DOM、chip 链不受影响；「六格全关自动切 compact」边缘触发路径不变。

## 验收

- 宽→窄→极窄→恢复全宽度扫描：折叠序按优先级、菜单数据保真、tooltip/子代理面板原有交互不回归；迟滞带内数值刷新不翻折。
- 设置页：拖拽/↑↓/三段优先级/重置/语言切换/深浅主题；大字号与窄面板不溢出。
- 持久化：重启/热重载/多分屏共享一致；跨窗口改排序不互覆。
- VM 行为测试锁纯函数（归一化/显示序/折叠序）、菜单项结构、拖拽 splice 数学、双向折叠触发器 token；真实浏览器夹具（pill-theme dual-theme）锁三主题往返与折叠恢复。
