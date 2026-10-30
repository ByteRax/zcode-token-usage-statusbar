# 桌面浮层与展示口径规则

适用路径：`overlay.js`（及 `plugins/zcode-token-usage-statusbar/overlay.js` 副本）、`turn-stats.js`、`inject-main.cjs` 中与浮层交互的推送/热重载/Git 状态段、`tests/overlay-*.test.cjs`。Web 浮层 `web/overlay.js` 是独立实现，见 [web.md](web.md)。

改动浮层、tooltip、⚙ 面板、原生按钮增强、统计行或任何用户可见数字/文案前先读本文件；全局约定见根 [AGENTS.md](../../AGENTS.md) §4、§5。

## 1. 文件与版本契约

- `overlay.js` 顶部 `VERSION` 随**提交**递增，未提交的中间迭代不涨号；并行会话/工作树叠加时撞号须按合入顺序顺延改号并合并注释后再提交。版本注释是代际变更的唯一就地记录。
- 顶层常量（如 `SRC_FIELD_LABELS`、进度阶段表、签名缓存）必须在 `buildPanel` 等消费函数定义**之前**赋值，`var` 提升不会提升初始值，曾因时序在面板打开时崩溃。
- 浮层是注入宿主渲染进程的脚本：保留代际守卫（`__zusageDispose` 移除旧条再重注入）、幂等内容更新、tooltip 解绑与扫描清理；`rAF` 自调度必须在异常后继续下一帧；诊断对象原地更新，不替换闭包共享引用。
- 热重载：主桥每 2s stat 运行目录 `overlay.js`/`turn-stats.js` mtime（`config.hot_reload !== false`），变化即 cleanup + 重注入，`turn-stats.js` 先于 `overlay.js`。主进程新增推送字段时渲染端必须判空不渲染或整块隐藏——热文件可能先于冷文件部署，字段缺失是常态不是错误。
- 新增定时器、DOM/IPC 监听器要有明确归属，并验证热更新、导航、窗口关闭后停用；不能声称已有完整全局 dispose。

## 2. 挂载与几何

- 默认状态条优先挂输入卡片工具行之后，找不到工具行时才回退到 body 级 `position: fixed`；样式挂条内 `<style>`。药丸样式固定在所属输入卡片下方、按内容定宽并居中。几何避开输入框中心点命中检测，避免自遮挡闪烁；面板和 tooltip 挂 body。
- 默认样式卡内随卡片拉伸，悬浮回退锁定卡片实测宽；超宽时先隐藏「本轮」「会话累计」的缓存命中率（tooltip 仍可见），再以右缘渐隐兜底。药丸样式以输入卡及视口宽度约束，窄时条面横向滚动，聚焦条目应滚入可视区域；条面不换行。Web 宽度策略独立。
- ⚙ 通用的「状态条样式」持久化为 `zusage3.theme`（`default` / `pill` / `compact`，缺省与非法值回退 `default`），主题切换只写该键，同窗实例同步。药丸表面跟随所属输入卡的圆角、边框、背景以及 Highspeed/焦点状态；不改变数字单位、额度口径或工具栏 chip。
- **精简模式（compact，v146）**：条永久 `display:none` 但**保留 DOM**——chip 样式 `<style>` 与 ariaLive 都挂条内（`<style>` 隐藏仍全局生效），`heavy()` 每拍保条回 body 对抗 React 清子树（条丢=chip 样式全灭），`render()` 跳过条面重建但数据解析与 enhance 照跑；`track()` 早退只留诊断（`FATAL.mount.mode="compact"`）。速率 chip `.zu-tsb` 挂工具行前导区、git chip 左侧（git 在时插其前、不在时占其锚位=cua-entry 后方；两侧兜回收敛为 [锚][速率][git]，git 兜回容忍速率占相邻位防拉锯；判位用 nextElementSibling——nextSibling 会被文本节点打乱成每拍重插；前导区发现失败回落尾随区重置卡/额度组左侧），内容与条面速度 chip 同源，**无有效样本不渲染（用户拍板）**——代价是新会话首次请求前无设置入口；隐藏格数据收进速率 chip tooltip 的「状态条摘要」行（逐格开关 `state.show.*` 继续生效、子代理行点击开明细）+「打开设置」按钮（镜像齿轮开启分支）。已知限制：条隐藏后 ariaLive 不播报（`display:none` 后代），chip 仍有 aria-label。面板/子面板在精简下几何改锚输入卡/chip（条 rect 为 0）。
- 字体一律引用宿主令牌：字号 `calc(var(--ui-font-size, 14px) ± Npx)`，字族 `var(--font-mono, <旧硬编码栈>)`，用 font longhand 不用简写；`--ui-font-size` 由宿主设置页运行时写在 `html` 内联样式。配色走宿主 `--color-*` 变量自动适配亮暗，引用前确认令牌存在。**例外（2026-10-28 用户规格定稿）**：额度 chip `.zu-quota` 与上下文百分比 `.zu-ctxpct` 两处**显式同字体**：`calc(var(--text-ui-base,var(--ui-font-size,14px)) - 1px)` + 加粗 + `var(--font-mono,…)` + tabular-nums（宿主默认基准 14px 时为 13px）——不靠继承（工具栏容器字号偏小、与带 `text-ui-base` 的按钮不等值，实测两段字号不一致），`.pct` 半加粗废止。其余条目（git chip、⚙ 面板等）仍走宿主令牌。
- 幽灵判定 `inGhostSubtree` 只管聊天壳：宿主用 `opacity-0 + inert` 保持聊天视图挂载，`opacity < 0.1` 的祖先会被判死不挂条，布景/演示页不能用 opacity 隐藏挂靠卡片。
- ⚙ 设置面板结构（用户拍板）：ZCode 设置侧栏同款——左栏三组分区导航 + 右侧单分区显隐，激活项 `aria-current="page"`，选择持久化 `zusage3.sec`，面板窄于 620px 时导航收成 icon rail；高度在打开瞬间按内容自然高锁定，此后只收紧不放大（切分区不抖动，留白是预期）。配色全走宿主 `--color-*` 语义变量。

## 3. React 对抗与宿主 DOM 挂靠

- 三板斧：① 宿主元素上用 `data-zusage-*` 属性驱动 CSS（React 不清理非 props 属性；改 class 会被 className 整串重写抹掉）；② 静态几何用 CSS 覆盖 SVG presentation attribute；③ 动态 dasharray/pathLength 由 JS 写入并在 render 与 heavy（600ms）两处 reapply 兜住 React 重写。
- 要继承宿主 hover-card/原生交互的手动节点必须挂进 React trigger 元素**内部**末尾（宿主 children 为单元素时末尾手动节点不进 diff）；挂 wrapper 兄弟节点不触发 hover-card。React 提交可能挤位，每次对账 `if (el !== parent.lastChild) parent.appendChild(el)` 挪回。
- 原生上下文按钮增强（`data-testid="chat-context-usage-trigger"`）：环填充 + 四档色 `data-zusage-band` + 按钮内百分比；档位由 `ctxBandOf` 承载，随上下文窗口大小变化；数据缺失时 `restoreCtxButton` 还原原生形态。额度 chip 挂同一按钮左侧，沿用同一双 reapply/还原契约。
- 设置页是同窗口覆盖层：冒条排除标记必须用三层并集 `[data-testid="settings-page"], [data-settings-content-frame], [data-settings-panel-frame]`；权限面板不是 Radix dialog、渲染在 SessionPane 子树内，拦截点在 `inSettingsView` 派发处与 `track` 显隐处。新增排除调用点时注意 `tests/overlay-port-patches.test.cjs` 对源码切片的计数断言。
- 浮层打开外链走 preload 桥 `window.zcode.openExternal(url)`（系统默认浏览器），`window.open` 会被客户端内置浏览器接管，只作兜底。
- Radix hover-card / AlertDialog 无 forceMount、关即卸载：注入其中的 UI 必须 body `MutationObserver`（rAF 去抖）+ heavy（600ms）双触发重注入、DOM 存在性幂等（多实例安全）；插入锚用双类名指纹（如 `border-t` + `pt-2`），单类名会插错段；缺锚则容器尾 + 位置兜回。
- 「上下文容量」弹层内的压缩上下文按钮（用户拍板的最终形态）：主通道=沿触发元素 `__reactFiber$` 上行取宿主 `onSendCompressionCommand("/compact")` 直接调（不碰输入框草稿与发送键，流式中交引擎排队）；字面 `/compact` 经官方 E2E 输入桥 `__zcodeLexicalInputE2E` 仅作兜底，且流式中/草稿非空/发送键 disabled 三重门控全部前置到 setText 之前（拒绝不残留草稿；Lexical contenteditable 直写 DOM 不进 EditorState，该路径禁用）。提交函数必须在**弹框打开瞬间**解析并缓存目标会话与锚点几何——确认时弹层已被 Radix 卸载，重解析会退化为"离视口左上角最近"而把命令发进错误分栏。确认框 hint 必须保留：压缩摘要是非流式请求、通常 2–4 分钟无进度反馈，生成中发新消息会打断压缩（TURN_CANCELLED）；Enter 确认限定焦点在弹框内。

## 4. tooltip 与监听预算

- Chrome 在悬停链重算时会向 `documentElement` 补发**伪 mouseleave**（格内 flex 空隙、tooltip 子元素间必发）。边界判定用 `document.querySelectorAll(":hover")` 的最深元素甄别：最深为 null/body/documentElement/IFRAME/WEBVIEW 才真离开，否则忽略交回 mousemove 流。`relatedTarget` 与坐标 `elementFromPoint` 方案已实测否决。伪事件只在真浏览器出现，VM/stub 测不出，改悬停边界必须 Playwright 实测（见 [tests.md](tests.md)）。
- 滚动收起分层：`hideTipsOnScroll` 只收消息流内随滚动移位的 rateTip；quotaTip/gitTip 挂在固定的 composer 工具行，滚动豁免；chip 随宿主 React 重建而 detach（无 mouseleave）时由扫描 tick 的 `isConnected` 健康检查兜底收起。
- 监听预算：浮层 tooltip 共用**单个** scroll 监听，新增浮层不得再加 scroll/resize 监听；每个 tooltip 有解绑路径。
- 凡「周期对账 + innerHTML 重写」的浮层（gitTip/quotaTip/chip）必须走内容签名幂等（`__zuTipSig`/`__zuSig`，签名不变跳过重建），否则滚动拖拽被打断；数据真变时保留 scrollTop 后一次性重建。
- 自绘 tooltip 走 rateTip 同款独立浮层模式；标题与 ⚙ 面板开关标签是两套措辞，文档按两套区分。

## 5. 展示口径（写文档、解释浮层的唯一依据）

- 格顺序：生成速度 → 本轮 → 会话累计 → 工具调用 → 今日合计 → 子智能体 → ⚙。状态条**没有**「上下文容量」格，该口径唯一承载处是原生上下文按钮增强；子智能体格始终展示（零值显 0，运行指示按 30 秒内有子代理请求点亮）。
- 本轮格的 requests 是模型请求「次」不是轮数；chip 上的时长是**最近一次请求耗时**（`last.duration_ms`），tooltip 才并列单次/首字/轮总三项。本轮与「最近一段」是轮级与段级两个口径。
- 生成速度两态：渲染桥命中时，生成中显示**字符增量估算**（`characterRate ÷ charsPerToken`，比例用上一完成轮自校准），该轮完成后切换为真实 tok/s（输出含思考 ÷ 生成时长，来自 renderer store，不走 DB）；无桥回退 DB `last.tps`，按段完成刷新。档位（2026-10-27 用户规格，桌面 v127 / web v94）：`TPS_BANDS` 是阈值/类名/文案唯一事实源，按**原始速度值**分档（含下限不含上限）——<40 低速红 / 40–70 一般黄 / 70–150 流畅绿沿用原三档类名与实测色，150 起蓝紫系新类 zu-teal/zu-sky/zu-azure/zu-violet/zu-purple/zu-magenta，≥2000 Ultra 静态蓝紫渐变 + ✦ 星点（`::before content:"✦"/""` 替代文本为空 AT 静音、不占 textContent；`@supports` 外纯紫回退；`.zu-light` 组同名覆盖浅色渐变）。**估算态与完成态同表分档**（原「估算态不分档」已废止）；负数/NaN/±Infinity 一律中性 dim 或回退 DB，DB 回退分支对负数/非有限值不渲染整枚 chip。tooltip 档位行动态显示「名称 · lo–hi t/s」，用于消解 `toFixed(1)` 舍入边界歧义（199.96 显示 "200.0" 但仍落 150–200 档，以悬停档位为准）；另加静态「颜色对照」图例行（`tpsBandLegend`，十档数值↔颜色升序一览，档位类与条面同源、tip 自带 `.zu-light` 随主题切换，纯静态字符串免转义）。
- 万/亿中文单位：默认开（localStorage `zusage3.cnNum` 仅显式 `"0"` 关）、`lang !== "en"` 才生效；≥1e8 亿、≥1e4 万，<1 万状态栏原样、统计行千分位（两处刻意不同）；K/M 加 B 档 ≥1e9；数字与单位间无空格（「58.25万」）。统计行跟随开关，仅「关闭退回 k」需重启（主桥严格 `req.cn === 0` 才传 `--no-cn-units`）；切换后已缓存富文本行保持旧格式。
- 时间文案用户偏好：中文自然单位词、数字与单位/时间段之间全部紧邻「3分10秒」（小时用「时」；桌面 v125/web v92 用户拍板去除全部空格），英文数字与单位紧邻、时段间留空格「3m 10s」（桌面 v126/web v93）；回答末尾采样时刻用中文全格式日期时间（单位词为年/月/日/点/分/秒，数字不补零）。工具动词耗时 `·12.3s`、turn-stats 占位行、tooltip `fmtTime` HH:MM:SS、上轮行/CLI `format_line` 是各自独立契约，改格式前先确认作用域。
- 四格 tooltip 时间范围行格式恒为 `YYYY-MM-DD HH:MM - YYYY-MM-DD HH:MM`（精确到分、无秒、不分当天/跨日、缺一侧用 "—"）；起=首个请求 `started_at`、止=最后 `completed_at`。
- 子代理速率：「估 X t/s」是运行中字符增量估算（`zuTryBindStore` 绑子代理 store，多槽位上限 8、槽位级 2s 节流、3 秒未刷新过期回退状态词）；「均 X t/s」是已完成段加权平均（口径同 `_turn_rate`）；文案「子代理运行中」（用户拍板），并行 ≥2 时加 `×N`。
- 重启后历史轮：宿主恢复的历史轮 `outputTokens=0` 但 `observedLive=false`，不得判「不可用」——首次 `!statsOk && !observedLive` 不插行；已插的非 observedLive 行保留原文；仅亲历的真实零输出轮明示。历史轮无统计行是既有限制（DB `turn_id` 与渲染器 `turnId` 不互通）。`isRateLine` 会把正文里含「token/s(本轮)」的引用示例当作模型行而跳过插行。

## 6. Git 状态 chip

- 数据链：渲染端 `publishGitPaths()` → 主进程 `gitTick`（10s，各窗路径并集）+ `git-refresh`（点击立即执行；快照驱动的重查有 5s 节流）→ `gitState` 推回。命令 `git -C <p> status --porcelain --branch` + `diff HEAD --shortstat`，env `GIT_OPTIONAL_LOCKS=0`、`LC_ALL=C`、`GIT_TERMINAL_PROMPT=0`；无提交仓库 `diff HEAD` 退 128 属预期。
- 口径：notrepo/nogit/远端 pane 不挂载；失败保留 lastGood 并以文字徽章标 stale（不用透明度）；多仓只看直接子目录、不查行数、有上限、恰 1 子仓回退单仓、失败仓不拖垮聚合；`?N` 是未跟踪条目数（目录折叠计 1）；单位词走 `L()`。
- 计数缩写（v128，用户规格 2026-10-28）：chip 与 tooltip 的行数、porcelain 条目、↑↓、冲突计数 <1万原值；≥1万 中文（`cnUnits` 判定，cnNum 关闭与英文同为 k/M/B）万/亿、英文 k/M/B。k 门槛刻意抬到 1万（9999 内原值，与 token `fmt()` 的 K≥1000 是两套口径），小写 k、至多两位小数去尾零、数字与单位紧邻。`gitNum`/`unit2` 在文件级 git 区段，不与实例内 `cnUnit` 共用（`fmt..sec` 源码切片被测试整段求值）；仓库个数（多仓「N 个仓库」等）与 aria 播报（`gitChipAria`）保持原值。

## 7. 验证

- 回归：`tests/overlay-*.test.cjs`（VM/stub 切片），改动后先跑测试再 `sync_plugin.py`（副本同步断言在漂移时会红）。VM 切片纪律与 stub 坑见 [tests.md](tests.md)。
- 悬停/hover-card/伪事件行为只能真实指针复现，合成事件驱不动 Electron hover 卡；布局与多窗口需桌面验收。热部署与 diag 判读见 [install-release.md](install-release.md)。
