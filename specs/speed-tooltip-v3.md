# 生成速度 Tooltip V3（模型级速度 · 统一多视图面板）

取代 V2 双 Tab 卡（v254-v298 线）。设计稿：`speed_tooltip_redesign_10_screens/`（10 场景）。优先级：数据真实 > 统一交互 > 视觉还原（PRD 2026-11-17）。

## 0. 范围与不变量

- V3 替换 `spdRebuildOr` 的 V2 产出：有 `speed_history` 帧时渲染 V3（`.zu-sv3-root`）；无轮表帧仍回退 V1 `speedCardHTML`（逐字保留）。V2 的 `spdAnalyze`/`spdChartHTML`/`spdLeftHTML`/`spdHeadHTML`/`speedCardV2HTML` 等 V2 专属函数随 V3 上线删除；`SPD_PORTAL`、`spdFitTip`（适配 V3）、`TPS_BANDS`/`tpsBand`、V1 图表链保留。
- 口径不变：速度恒 = Σ有效输出 ÷ Σ有效生成窗口（`usage_stats.row_gen_ms`，200ms–1h，main_turn 过滤，covers 特例），绝不逐轮/逐模型算术平均，绝不用「模型输出 ÷ 整轮耗时」充当模型速度。
- 不新增定时器/全局监听/IPC；交互全部走 tip 本体既有委托（pointerdown 先行、600ms 冻结、签名幂等重建、speedFollow/focusInTip 守卫、横滚记忆、SPD_PORTAL 悬停卡）。
- 禁止项（PRD 点名）：不新增「速度趋势/模型对比」独立 Tab、底部时间预览卡、常驻功能说明条；不用伪造模型级速度填充图表；不把 Token 占比当速度占比；不放大实时快照传输全部原始历史。

## 1. 数据契约（Python → 快照）

### 1.1 speed_history 扩展（向后兼容）

- `msl` 条目从 `[mIdx, out]` 扩为 `[mIdx, out, ms, n]`：ms=该模型在本轮的 Σ有效生成窗口（仅通过窗口过滤的行），n=该模型本轮已完成请求数。旧渲染器只读 `[0]/[1]`，不崩溃。
- 新增帧级可选键 `mkeys`：与 `mnames` 平行的数组，`mkeys[i] = provider_id + "\x1f" + model_id`（provider 缺失用空串）。缺席时渲染端退化为按名称识别身份。
- 渲染端判定「模型级速度可用」= 条目 length ≥ 4 且 ms > 0。

### 1.2 新顶层字段 `speed_days`（全历史按日聚合，解决 6000 轮截断）

- 快照签名新增 `include_speed_days=False` 形参；`serve` 与桌面一次性 `json`（`ZUSAGE_REMOTE_CHILD != 1` 且非 lean）开启；CLI 报表/MCP/远端子查询/手机 lean 一律不带。装配点仿 `all_projects`：`**({"speed_days": _speed_days_safe(con)} if include_speed_days else {})`。
- 结构：
  ```
  { v: 1, source: "local", start: <首日 local 00:00 epoch ms>,
    days: [ [out, ms, n, turns, capFlag, msl], ... ]   // 连续本地自然日；JS 端按 start 的日历日推进取第 i
                                                           // 天本地零点（禁止固定 864e5 步长——DST 日 23h/25h 会键系错位）
                                                           // 空日 = [0,0,0,0,0,0]
                                                           // out/ms = 当日有效段合计（分母分子完整精确）
                                                           // n = 当日已完成 main_turn 请求数；turns = 当日 distinct turn_id 数
                                                           // capFlag = 1 表示模型列表截断
                                                           // msl = 打平五元组序列 [mIdx,out,ms,n,tn, mIdx,...] ≤8 模型按 out 降序，
                                                           //        仅 out>0 入列；tn = 当日含该模型已完成行的 distinct 轮数
    mnames: [...], mkeys: [...]（同 1.1）,
    truncated: 0|1 }    // 存在早于 start 的已完成数据时置 1
  ```
- 上限 `_SPEED_DAYS_MAX_DAYS = 550`（截至今天，含今天）+ 每模型 `_SPEED_DAYS_MAX_MODELS = 8`；truncated 时渲染端明示「已截断 · 仅显示最近 N 天」。粒度恒「日」，不做周/月桶伪装（PRD 5.4 的粒度自适应以截断提示替代，属诚实降级）。
- 聚合实现：全表扫描已完成 main_turn 行（query_source 过滤同 `_speed_history`），逐行 `row_gen_ms(row, covers)` 判有效段，按本地日（`datetime.fromtimestamp` 本地时区，禁止固定毫秒数推自然日）累计。DST/月末/跨年由 Python 本地日历API保证。
- 缓存 `_speed_days_cached`/`_speed_days_safe`：完整镜像 `_speed_history_cached`/`_speed_history_safe`（独立 `_DAYS_CACHE`、dbkey+水位、TTL 2s、水位续用 20s、失败 50ms 重试 + ≤10min stale 回退）。

### 1.3 渲染端解包

- `spd3Unpack(h)`（轮表，WeakMap 引用缓存，逐字段校验、畸形整轮丢弃）与 `spd3UnpackDays(sd)`（日桶同纪律）。产出统一行模型：`{t, b, sid, pid, out, ms, i, o, n, c, cf, models:[{key,name,pid,mid,o,ms,n,tn}]}`（speed_days 行无 sid/pid/i/o/c）。
- 每模型 key = `mkeys ? mkeys[i] : "n\x1f" + name`；name 缺失显示「未知模型」。

## 2. 模型身份与颜色

- 颜色 = 固定 10 色调色板 `SPD3_PALETTE`，`PALETTE[fnv1a(key) % 10]` 纯哈希取色：跨范围/跨时间 Tab/跨筛选稳定，与选择顺序和数据池无关（PRD 7.2）。冲突靠名称/悬停明细区分，不允许仅靠颜色识别。
- 调色板（深浅主题共用，QA 验证对比度）：#4ea1ff 蓝、#34d399 绿、#a78bfa 紫、#fbbf24 琥珀、#22d3ee 青、#f472b6 粉、#a3e635 黄绿、#fb923c 橙、#2dd4bf 青绿、#f87171 红。
- 速度色阶继续唯一来自 `TPS_BANDS`（热力格背景、悬停卡速度值、行数值档色），两套颜色语义不混用（PRD 7.3）。

## 3. 筛选状态机（spd3Filter）

- 实例状态 `spd3Sel.filt = {mode:"auto"|"sel", keys:[...]|null}`：auto=跟随数据池全部模型；sel=显式集合（可为空=明确空态，不假装全选）；三个动作 `toggle/only/all/reset`（reset→auto）。原地改属性，不整体换对象引用。
- 作用域=实例；会话切换与 speedSel 一同重置（07 分片 626-631 同点）。时间 Tab 切换保留筛选；新范围中无数据的选中模型保留选中并在 chips 标「无数据」。
- chips 条：默认最多显 6 枚 + 「+N」；≥9 模型出现搜索按钮，弹出层含搜索框/全选/清空/恢复默认，列表 >60 行只渲染搜索命中（轻量截断，不做完整虚拟化）。超长名 ellipsis + 悬停全文。
- 可达性：chips 是 button（aria-pressed），弹出层 Esc 关闭并归还焦点（打开时焦点移入搜索框），方向键在弹出层列表内移动；热力格/命中列 roving tabindex（每网格首格 0 其余 -1）+ 方向键移动（month 行主序 7 列、hist 列主序 7 行、命中列仅左右）。

## 4. 聚合管线（spd3Analyze，20 组合唯一入口）

顺序固定（PRD 4.2）：范围池 → 自然时间窗 → 最近 N 轮（`SPD_BARS_MAX=18`，沿用现值）→ 模型筛选 → 聚合。筛选只删分量不缩窗口：range=recent 时先取最近 18 轮窗口，再在窗口内按筛选分量重算（PRD 4.3，不向更早历史补轮）。

- 范围：recent=本会话最近 N 轮；session=本会话全部；project=当前项目（本会话所在 pid 的全部会话，v270 的「全部项目对比」语义废除——PRD 4.1 重定义；跨项目对比由项目累计卡 v331 承载）；all=全库。远端身份 + all → 降级本会话并提示（沿用 V2 fail-closed）。
- 时间：recent=无时间窗（N 轮即窗口）；today=本地今天；week=今天起往前含今天 7 个本地自然日；month=本月；all=无窗。月/周/日边界全用本地日历运算（spd3DayKey 等），不得减固定毫秒数。
- 输出 `an`：`{items, real, overall(+overall.models 含每模型 out/ms/n/tps), perModel, peak, low, latest, unit("turn"|"hour"|"day"), title, spanA, spanB, notice, truncated, pool, msAvail, days?}`。`msAvail=false`（池内所有 msl 条目均无 ms）= 降级模式。
- 峰值/最低/最新 = real items 的 max/min/最近完成；unit==="day" 时左卡标签用 最高日均/最低日均/最近日均，否则 峰值/最低/最新。

## 5. 五种时间视图（图表形态只随时间 Tab，范围只换数据池）

| 时间 | 单模型（筛选后池内 1 个模型） | 多模型 |
|---|---|---|
| recent | 柱状图，柱色=模型色 | 一轮一柱；单模型轮=模型色，多模型轮=中性灰「混合」，悬停给真实组成（禁止用主导模型色填满混合轮） |
| today | 小时柱状图（00:00–当前小时，空小时=空位不显 0） | 每模型一条小时折线（仅该模型该小时有有效分量处有点，缺口不插值）+ 悬停十字卡 |
| week | 每日折线+面积+端点标签，缺失日断线 | 每模型折线 + 中性虚线「总体」（有真实数据才画）+ 端点数值标签 |
| month | 7 列日历热力（周日首列，4–6 行）速度色阶 | 同左 + 每格右上模型色点（≤3 + 「+N」），悬停日卡带每模型 轮次/均速 |
| all | 星期×周列日格热力（数据来自 speed_days） | 同左 + 模型色点 |

- 单模型判定：筛选后池内 distinct 模型 key 数 === 1（无数据模型不计）。
- Y 轴：统一整洁刻度阶梯（1/2/2.5/5/6/7.5×10^k，4/5 分割，沿用 V2 算法）；线性轴不截断真实速度；极端值允许压缩其余柱但必须在悬停卡给出真实值（不做断轴）。
- month/all 热力格状态必须可区分：未来日（遮罩）、空日（无记录灰）、有记录（速度色阶 color-mix）、今天（描边）、补位/邻月（更暗）。悬停一律给真实统计区间与粒度。
- all 视图数据源优先 `speed_days`（全历史）；字段缺席（旧 Python）回退轮表日桶并提示「仅统计最近可用轮次」；truncated 明示。session/project 范围的「全部」跨度不受 550 日界约束，hist 网格另设 110 列硬帽（超出取最近 110 列并在通知行披露）。历史长空档如实显示空日，不标「无请求日期」混淆——空=无数据。

## 6. 布局（920×480 基准）

- 头部（~50px）：左「生成速度」标题；右两组带标签 Tab：范围（最近/会话/项目/全部）+ 时间（最近/今天/近7天/本月/全部），低对比选中态沿用 `.zu-sv-tab` 视觉契约。
- 筛选条（~36px）：漏斗+「模型筛选」dim 标签 | 模型 chips | 右侧「已选 N/M」+ 搜索按钮。
- 主区：左摘要卡 ~250px + 右图表卡自适应（920 内 ~650px）；高度预算 480 内完成，超出视口按 spdFitTip 机制钳制/缩放，不允许整卡纵向滚动（图表区可横滚）。
- 左卡单模型态：标题（随时间 Tab）→ 主数字+档位胶囊 → 模型行（色点+全名+「唯一模型」）→ 「本期统计」组标题（请求轮次=overall.turns / 当前模型 / 覆盖范围单值随时间 Tab：最近N轮/今天/近7天/本月/全部历史）→ 峰值/最低/最新（unit=day 时切日均标签）。多模型态：「已选 N 个模型 · M 轮」→ 档位胶囊 → **所选模型分布 · 按请求数**（堆叠条+表格：模型/均速 t/s/占比；占比=该模型已完成请求数占比，恰好 100%；设计稿的「按请求轮次」废用——单轮多模型会超 100%，PRD §10 禁止）→ 峰值/最低/最新。
- 降级模式（msAvail=false）：多模型态隐藏「均速」列、图表退化为不依赖模型速度的形态（热力/柱仍画整轮值），notice 明示「该历史数据缺少模型级生成耗时，暂无法按模型比较速度」；身份/Token 分布照常展示。
- 右图表卡：标题（设计稿五命名：最近 N 轮 · 生成速度 / 今天 · 按小时生成速度 / 近 7 天 · 每日平均速度 / 本月 · 日均生成速度 / 全部 · 历史生成速度）+ t/s 徽章 + 档位说明入口（复用 `spdLegendTip` 链）+ 右端统计区间；热力视图底部左「较低/较高」渐变图例（取 TPS_BANDS 两端色）、右「颜色标记代表模型」（多模型）或「<模型名> · 单模型」。
- 通知行（仅在有内容时渲染，单行 dim，非常驻说明条）：远端降级 / speed_days 截断（「已截断 · 仅显示最近 N 天」）/ 轮表 6000 截断（「历史较长，仅统计最近可用轮次」）/ 无 speed_days 的 all（「仅统计最近可用轮次」）/ 模型级耗时缺失（判定用未筛选原始池——筛选到单模型不得抑制披露）/ 「已选 N 个模型中 M 个在当前范围无数据」。降级帧被筛选到单模型时整轮混合速度不得冠以该模型名（行 models 置空走中性色）。

## 7. 交互与生命周期

- 全部交互控件挂 tip 本体委托：Tab/筛选 chips/弹出层按钮走 pointerdown 先行 + click 兜底（v263 契约）；柱/格 hover 走 `zuSpeedChartPick` 同款闭包重编；弹出层内 mouseover 保活；Esc 分层（弹出层→卡）。筛选变化重置 hover；横滚记忆键扩展为 `range|period|filterSig`。
- 键盘：柱/格可聚焦 + aria-label；热力格 roving tabindex（每网格首格 0 其余 -1）+ 方向键移动（month 行主序 7 列：右+1/下+7；hist 列主序 7 行：下+1/右+7；命中列仅左右 ±1）；Tab 顺序=范围→时间→chips→搜索→图表。`prefers-reduced-motion` 无新增动画。
- i18n：全部文案走 `SPD_L`；动态内容（模型名/项目名）一律 spdEsc 转义；模型 key 不进 className。
- 快照帧更新：悬停中不整卡重绘（既有冻结守卫）；弹出层打开时数据刷新只更新计数不关闭弹出层。

## 8. 性能预算

- 解包/聚合结果按「帧对象引用 + sel 签名」memo（WeakMap），签名=range|period|filter|sid|pid；帧未变+签名未变不重算。
- 禁止在 100ms 心跳/通知热路径新增每拍解包或聚合（复用 spdUnpack 纪律）；speed_days 解包同样 WeakMap 缓存。
- 目标（2026-11-17 红队实测修订）：6000 轮池单签名重算 ≤ 8ms（project|all 首算实测 10.9ms 为已知超预算档；memo 命中 <0.02ms）；首开 ≤ 50ms（recent 档实测 20-26ms；all 档悬停每拍串 ≤260KB 由 wire 串 memo 抑制为相位变化时才重建）；speed_days 快照增量 ≤ 100KiB（打平+cap8 + 快照序列化紧凑分隔符后满帧实测 81-96KiB 按值域；对照 speed_history 160KB 同级先例）。memo 形态=WeakMap<帧, Map<签名,结果>> 每帧上限 8（单槽互踢是红队 BLOCKER，已废）。

## 9. 测试矩阵（最低集）

- Python：msl 四元组/旧二元组兼容、mkeys 生成、speed_days 日聚合（跨日/空日/DST 月末/截断探针/上限）、门控矩阵（serve/desktop json 带，远端/lean/CLI 不带）、缓存水位。
- JS core：spd3Unpack 新旧帧、spd3Analyze 20 组合、加权≠算术平均（PRD 16.4 的 A=100/1s、B=100/10s 用例：A 100 t/s、B 10 t/s、综合 ≈18.2）、混合轮识别、筛选窗口固定、远端降级、降级模式。
- JS view/charts/heat：结构锁、单/多模型切换、五图表形态分发、日历数学（闰二月/年末/DST）、截断提示、i18n、转义、a11y 属性。
- 回归：V1 链（overlay-speed-chart、tps-band、tps-chip）不动必须保持绿；v255 粘性测试适配 spd3；speed-tooltip-host QA harness 场景扩展（10 场景截图）。

## 10. 交付与部署

- VERSION → v384（06 分片台账 + substat 版本锁测试同步）。AGENTS §2 代码地图、build_overlay.py 头注释、本 spec 与 speed-tooltip-adaptive-layout.md（标注 V2 尺寸段落被 V3 取代）同步。
- 热文件：`overlay.js` + `zusage.py`（运行目录原子替换 + mtime 触发热重载/常驻重启）；`inject-main.cjs` 不动（零冷文件）。
- 真机验收：CDP 截图 10 场景（5 时间 × 单/多模型）+ 深浅主题 + 键盘路径；headless 仅作回归不替代。

## 11. v387 实机修复批（UI/UX 深审，2026-11-18；VERSION → v387）

依据真机 CDP 实测（默认主题主链、视口 1527×957）+ 用户 7 张截图。根因均已实测钉死，禁止凭 padding/margin/overflow 掩盖。

### 11.1 宽度链（P0-01/P0-02 外层）

实测：tip 计算样式 border-box、宽 920、padding 10px 13px + border 1px → 内容区 892px < 根节点 920px → 根节点右缘越出 tip 外缘 14px，头部 Tab 组被裁（filtRight 1453 > tipRight 1439）；compact 链（cssText border-box + padding 10px 14px）同病 30px。

修复（唯一权威方案）：
- 释放规则改 `box-sizing:border-box!important;width:min(952px,calc(100vw - 24px))!important;max-width:calc(100vw - 24px)!important` → 两链内容区 ≥922 ≥ 根 920。
- 根宽改 `min(920px,calc(100vw - 60px))` + `max-width:100%`（窄窗时根 ≤ tip 内容区，不反向撑大）。
- 根容器禁止 overflow:hidden 掩盖；验收=任一视口下 tip.scrollWidth==clientWidth 且筛选行右缘 ≤ tip 内容右缘。

### 11.2 图表满幅（P0-04/3.1/5.2）

实测：`.zu-sc-wrap` scrollWidth 636 > clientWidth 606（幻影溢出 30px）；柱组 flex-start 固定 pitch（24px）致 8 柱挤左半幅；折线 SVG 固定宽 n*PITCH+12（min 240）致 7 日线压缩左侧。

修复：
- 柱图（recent/today 单模型）改**槽位满幅**：柱组 flex 容器 width:100%，每槽 flex:1 1 0 + min-width:0，柱宽按密度 18/14/10px 居中；spacer 机制删除。X 标签每槽显示，槽宽不足时隔槽（首末恒显）。
- 折线（today 多模型/week）SVG 改 `width:100%` + **百分比 x 坐标**（y 用 px；无 viewBox 缩放，线宽/圆点 px 不失真）；hit 列与网格线同步 %。空槽保留位置（无数据日不插值不造假点）。
- 数值标签策略：n≤8 全显；>8 时 峰值/最低/最新/悬停优先 + 密度抽稀，标签估宽（字符数×~6px）超槽宽让位；折线仅端标签+避让 ≥12px（保留现机制）。

### 11.3 多模型主数字（P0-03）

实测截图：多模型左卡「已选 N 个模型 · M 轮」直接接档位胶囊，均速大数字消失。修复：多模型分支结构 = 标题行 → **主数字（overall.v）+ t/s** → 档位胶囊 → 「本期有效 N 个模型 · M 轮」（+ 无数据已选提示）→ 分布（≤4 行 + 查看全部）→ 峰/低/新。任何模型数（1/2/7/20/部分无数据/全部无数据）主数字恒在；无数据显示 `—` 不隐藏区块。

### 11.4 空状态（四）

`an.real` 为空时 view 接管渲染居中空态：主布局不变（左卡 —/0/—，图表区居中提示），**原因行按 `an.emptyReason` 区分**（session 无历史 / 筛选空集 / 时间窗无请求 / 已选模型无数据 / 数据未加载 / 旧快照无模型级统计 / 查询失败——按池构成判定，不千篇一律「尝试更长时间范围」），动作按钮真实生效：`[清除模型筛选]`（仅显式筛选时出现）`[查看全部时间]`（period≠all 时）→ `data-sv3-act="clear-filter"|"all-time"`，两链（06/01）委托接入：clear-filter=spd3FilterAll+重建；all-time=speedSel.period="all"+重建。

### 11.5 语义与文案

- 模型数量三语义：可选 Y（池全部）/ 已选 X（filt）/ **本期有效 N**（perModel.length）；计数行与 chips 计数统一「已选 X/Y · 本期有效 N」；「唯一模型」只用于真单模型池。
- live 徽标：估算态措辞改「实时估算中」（历史均速含义不被污染），非估算实时态（思考/工具）透传不变。
- 同名不同供应商（同 name 异 key）：分布表/chips 名称右侧加供应商副标（pid 尾段），hover title=全 provider/model；不合并身份。
- 标题 📈 换自包含 SVG 折线图标（currentColor，随主题）。
- 今天/进行中日桶 hover 区间：「YYYY/M/D · 00:00 – 截至 HH:mm」；已结束日「YYYY/M/D · 全天」——core 对 today 及跨今天的桶 item.b 钳到 now。
- 热力底部「较低/较高」双色图例移除（PRD 6.3 禁止替代档位体系；完整档位说明已有标题旁 ⓘ hover 承载）。

### 11.6 月历/历史热力（6.2/7.2）

- month：`grid-template-rows:repeat(var(--zu-hm-rows),minmax(0,1fr))` 行高自适应填满可用高（4/5/6 周均无底部大空白）。
- hist：列宽帽 `minmax(34px,64px)`（去 1fr 拉伸，短跨度不再异常宽格）；cols>26 时**按日历月聚合**（月格=当月加权 tps，列头 YYYY/MM，hover 月卡给「N 天有记录/综合均速/请求数」），550 日 ≤19 列无横滚；副题标「按月聚合」。

### 11.7 验收断言（新增，PRD 14.2）

harness/VM 布局断言：920 标准下 tip.scrollWidth==clientWidth、`.zu-sv-filter` 右缘 ≤ tip 内容右缘、图表绘图区宽 ≥ 容器 85%、柱顶标签无碰撞（估宽判定）、Popover 在视口内、月历底边空白 ≤ 1 行格高。真机截图七场景前后对比存档。

## 12. v388 自适应高度与密度分档批（2026-11-18，第三轮）

依据真机 DOM 逐层量测（PRD §2.2 诊断法）。四大根因实测：①wrap 幻影溢出 30px=`.zu-sv3-chart .zu-sc-plot` 同时 `margin-left:30px`（Y gutter 预留）+`width:100%`（相对 wrap 内容宽）→ plot 右缘 636>606；②多模型分布表溢出 23px（tableSW 232>CW 209）；③筛选栏 ≥10 模型换行两行（fbarH 65px）；④root min-height 恒 480px 与内容脱钩（rootH 543 视图间不变）。

### 12.1 高度自适应档位（P0）

- `min-height:480px` 废除，改**离散档位**（渲染端纯函数按 an 计算，写入 root 内联 min-height + `data-h-tier`）：
  empty→320 / recent n≤3→340、n≤8→360、n≤18→390 / today→400 / week→400 / month rows≤4→430、5→450、6→470 / all 按**有数据日桶数** ≤56→380、≤112→420、else→460（px，实现允许 ±10 按盒模型校准）。矮视口（窗口高 < 档位+16px）下 CSS min-height 胜过 maxHeight 钳制，root 保持档位高、内容经 tip 基类内滚可达——与 v387 的 min(480,100vh-16) 自钳不同，为记录在案的有意取舍。
- 档位离散保证稳定：hover/快照刷新不改变 tier；时间 Tab 切换允许跳档；模型展开不撑高（分布表内滚上限不变）。
- root 高度语义=`min-height`（内容可超出）；左卡与图表卡等高由 flex stretch 承担，但**内部内容自然流、禁止 margin-top:auto 推底**（§12.2）；图表绘图区独立固定高（charts 自身参数），不随卡拉伸。

### 12.2 左卡自然内容流（P0）

单/多模型统一顺序：标题→主数字→档位→模型行/计数行→本期统计→**分隔线（固定间距）**→峰/低/新。各段固定 margin（8/10px 节奏），消除大弹性空白；「当前模型」行与模型 Chip 完全同名时去重（替换为 有效输出 Token 或省略）；多模型分布表改 CSS Grid 三列 `minmax(0,1fr) 固定 固定`（数字列右对齐、名称 ellipsis+hover 全名、供应商副标保留），**根除横向滚动**（实测 23px）。

### 12.3 柱图密度分档（P0）

- `bars` 容器 `max-width:min(100%, calc(槽数×最大柱心距))` + `margin:0 auto`：n=1→视觉居中；n≤3 maxPitch≈120px（居中分组，禁止两柱顶到两端）；4≤n≤8→多数视口满幅均衡（140px 上限在窄 plot 下对 n=4 触发居中，无害）；n>8→紧凑满幅。柱宽密度三档（18/14/10）保留。
- wrap 幻影：`.zu-sv3-chart .zu-sc-plot` 的 `width:100%` 改 `width:auto`（block+margin-left:30 自动填剩余），溢出 30px 根除；**禁止仅隐藏滚动条**。

### 12.4 筛选栏单行（P1）

`.zu-sv3-fbar{flex-wrap:nowrap}`：chips 区 `flex:1 1 auto;min-width:0;overflow:hidden`（视觉收纳），常驻 chips 预算降为 3（+N 收纳），计数与搜索 `flex:0 0 auto;white-space:nowrap`；长名 Chip ellipsis+hover 全名（已有）。任何模型数下 fbar 高度恒一行。

### 12.5 折线与覆盖提示（P1）

- today/week 绘图区高度降为紧凑档（≈200px 实测校准），卡高随档位自适应后不再有大空白。
- today/week **多模型端数值标签默认不画**（多线右缘堆叠实测重叠；today 同批适用）；单模型保留端标签。全模型数值经悬停十字卡。
- week 覆盖提示：有效 X/7 天（head sub 轻量文案，数据来自 an.real.length）。

### 12.6 热力密度（P1）

- hist 短历史（列数≤14）：网格整体水平居中（数据左→右语义保留在列序内）；列宽帽 64px 不变；卡高档位下格高自然收敛。
- month：行高随 --zu-hm-rows 分配（1fr 既有）× 卡高档位；进行中日格与空日强度差已存在，复核不回归。

### 12.7 验收断言

- harness 追加：**柱/折线图表作用域内** wrap scrollWidth==clientWidth（heat 长历史设计内横滚不在此列）；分布表无横向溢出；fbar 高度 ≤44px（单行）；root 带 data-h-tier 且 min-height∈[300,480]；柱组居中分组由 charts VM 断言覆盖（n≤3 max-width 档位内联在产物）。
- 真机：2 轮/18 轮/多模型 10+/月/全部短历史 截图前后对比。
