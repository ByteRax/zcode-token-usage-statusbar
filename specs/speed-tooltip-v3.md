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
- v457（§25）新增轮级可选键 `tk`：与 `msl` 顺序对齐的每模型 Token 总消耗数组（输入+输出，含无效窗口行），第 k 项 = `msl[k]` 该模型本轮全部已完成行的 `input_tokens + output_tokens` 之和。仅在「本轮入列模型 ≥ 2」或「存在未入列模型（out=0 或超出 8 条帽）的 token」时携带；缺席 = 本轮恰一个入列模型且其 token 恰等于轮的 `i+o`（渲染端直接取轮级合计，省帧体积）。旧渲染器忽略未知键。

### 1.2 新顶层字段 `speed_days`（全历史按日聚合，解决 6000 轮截断）

- 快照签名新增 `include_speed_days=False` 形参；`serve` 与桌面一次性 `json`（`ZUSAGE_REMOTE_CHILD != 1` 且非 lean）开启；CLI 报表/MCP/远端子查询/手机 lean 一律不带。装配点仿 `all_projects`：`**({"speed_days": _speed_days_safe(con)} if include_speed_days else {})`。
- 结构：
  ```
  { v: 1, source: "local", start: <首日 local 00:00 epoch ms>,
    days: [ [out, ms, n, turns, capFlag, msl, tk], ... ]   // 连续本地自然日；JS 端按 start 的日历日推进取第 i
                                                           // 天本地零点（禁止固定 864e5 步长——DST 日 23h/25h 会键系错位）
                                                           // 空日 = [0,0,0,0,0,0]
                                                           // out/ms = 当日有效段合计（分母分子完整精确）
                                                           // n = 当日已完成 main_turn 请求数；turns = 当日 distinct turn_id 数
                                                           // capFlag = 1 表示模型列表截断
                                                           // msl = 打平五元组序列 [mIdx,out,ms,n,tn, mIdx,...] ≤8 模型按 out 降序，
                                                           //        仅 out>0 入列；tn = 当日含该模型已完成行的 distinct 轮数
                                                           //        （步长恒为 5，v457 起**不得**改——旧渲染端按 5 步长解析）
                                                           // tk = [tin, tout, m0tok, m1tok, ...]（v457 §25；仅非空日携带，旧渲染端读不到）
                                                           //        tin/tout = 当日全部已完成 main_turn 行的输入/输出合计（含无效窗口行）
                                                           //        mKtok = 与 msl 第 K 个五元组对齐的该模型当日 Token 总消耗（输入+输出）
                                                           //        每模型段非每日携带（§8 帧体积预算）：恰一个入列模型的日只带 [tin, tout]
                                                           //        （渲染端按契约取该模型 token=合计）；多模型日只带近 90 天，更早的只带合计
    mnames: [...], mkeys: [...]（同 1.1）,
    truncated: 0|1 }    // 存在早于 start 的已完成数据时置 1
  ```
- 上限 `_SPEED_DAYS_MAX_DAYS = 550`（截至今天，含今天）+ 每模型 `_SPEED_DAYS_MAX_MODELS = 8`；truncated 时渲染端明示「已截断 · 仅显示最近 N 天」。粒度恒「日」，不做周/月桶伪装（PRD 5.4 的粒度自适应以截断提示替代，属诚实降级）。
- 聚合实现：全表扫描已完成 main_turn 行（query_source 过滤同 `_speed_history`），逐行 `row_gen_ms(row, covers)` 判有效段，按本地日（`datetime.fromtimestamp` 本地时区，禁止固定毫秒数推自然日）累计。DST/月末/跨年由 Python 本地日历API保证。
- 缓存 `_speed_days_cached`/`_speed_days_safe`：完整镜像 `_speed_history_cached`/`_speed_history_safe`（独立 `_DAYS_CACHE`、dbkey+水位、TTL 2s、水位续用 20s、失败 50ms 重试 + ≤10min stale 回退）。

### 1.3 渲染端解包

- `spd3Unpack(h)`（轮表，WeakMap 引用缓存，逐字段校验、畸形整轮丢弃）与 `spd3UnpackDays(sd)`（日桶同纪律）。产出统一行模型：`{t, b, sid, pid, out, ms, i, o, n, c, cf, tok, models:[{key,name,pid,mid,o,ms,n,tn,tt}]}`（speed_days 行无 sid/pid/c；i/o 自 v457 起由日桶 `tk` 补齐，旧帧无 `tk` → i=o=0）。
- v457（§25）Token 字段：`tok` = 行内 Token 总消耗（输入+输出），未知为 `null`——轮表行取 `i+o`（>0 才算已知），日桶行取 `tk[0]+tk[1]`；模型分量 `tt` = 该模型在本行内的 Token 总消耗，取自 `tk`（轮表 `tk[k]` / 日桶 `tk[2+k]`，按 `msl` 原始下标对齐，无效条目跳过不错位），无 `tk` 的单模型轮表行取 `i+o`，其余 `null`。
- 每模型 key = `mkeys ? mkeys[i] : "n\x1f" + name`；name 缺失显示「未知模型」。

## 2. 模型身份与颜色

- 颜色 = 固定 10 色调色板 `SPD3_PALETTE`，`PALETTE[fnv1a(key) % 10]` 纯哈希取色：跨范围/跨时间 Tab/跨筛选稳定，与选择顺序和数据池无关（PRD 7.2）。冲突靠名称/悬停明细区分，不允许仅靠颜色识别。
- 调色板（深浅主题共用，QA 验证对比度）：#4ea1ff 蓝、#34d399 绿、#a78bfa 紫、#fbbf24 琥珀、#22d3ee 青、#f472b6 粉、#a3e635 黄绿、#fb923c 橙、#2dd4bf 青绿、#f87171 红。
- 速度色阶继续唯一来自 `TPS_BANDS`（热力格背景、悬停卡速度值、行数值档色），两套颜色语义不混用（PRD 7.3）。

## 3. 筛选状态机（spd3Filter）

- 实例状态 `spd3Sel.filt = {mode:"auto"|"sel", keys:[...]|null}`：auto=跟随数据池全部模型；sel=显式集合（可为空=明确空态，不假装全选）；三个动作 `toggle/only/all/reset`（reset→auto）。原地改属性，不整体换对象引用。
- 作用域=实例；会话切换与 speedSel 一同重置（07 分片 626-631 同点）。时间 Tab 切换保留筛选；新范围中无数据的选中模型保留选中并在 chips 标「无数据」。
- chips 条：常驻枚数 v387 定 3、v400 起按视口宽动态预算（§23，下限 3），装不下的收「+N」；弹出层（入口=「模型筛选」标签与 +N，§14.1）含搜索框/全选/清空/恢复默认，列表 >60 行只渲染搜索命中（轻量截断，不做完整虚拟化）。超长名 ellipsis + 悬停全文。
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
| week | 每日平均柱状图（7 日槽位，空日=空位不显 0，v392 起——恒折线在单有效日退化为孤立点） | 每模型折线 + 中性虚线「总体」（有真实数据才画）+ 缺失日断线（多模型专属形态保留，端点数值标签默认不画 §12.5） |
| month | 7 列日历热力（周日首列，4–6 行）速度色阶 | 同左 + 每格右上模型色点（≤3 + 「+N」），悬停日卡带每模型 轮次/均速 |
| all | 星期×周列日格热力（数据来自 speed_days） | 同左 + 模型色点 |

- 单模型判定：筛选后池内 distinct 模型 key 数 === 1（无数据模型不计）。
- Y 轴：统一整洁刻度阶梯（1/2/2.5/5/6/7.5×10^k，4/5 分割，沿用 V2 算法）；线性轴不截断真实速度；极端值允许压缩其余柱但必须在悬停卡给出真实值（不做断轴）。
- month/all 热力格状态必须可区分：未来日（遮罩）、空日（无记录灰）、有记录（速度色阶 color-mix）、今天（描边）、补位/邻月（更暗）。悬停一律给真实统计区间与粒度。
- all 视图数据源优先 `speed_days`（全历史）；字段缺席（旧 Python）回退轮表日桶并提示「仅统计最近可用轮次」；truncated 明示。session/project 范围的「全部」跨度不受 550 日界约束，hist 网格另设 110 列硬帽（超出取最近 110 列并在通知行披露）。历史长空档如实显示空日，不标「无请求日期」混淆——空=无数据。

## 6. 布局（920 宽基准；高 450，v393 起五形态统一，原 480 基准作废）

- 头部（~50px）：左「生成速度」标题；右两组带标签 Tab：范围（最近/会话/项目/全部）+ 时间（最近/今天/近7天/本月/全部），低对比选中态沿用 `.zu-sv-tab` 视觉契约。
- 筛选条（~36px）：漏斗+「模型筛选」dim 标签 | 模型 chips | 右侧「已选 N/M」+ 搜索按钮。
- 主区：左摘要卡 ~250px + 右图表卡自适应（920 内 ~650px）；高度预算 450 内完成（v393 起五形态统一），超出视口按 spdFitTip 机制钳制/缩放，不允许整卡纵向滚动（图表区可横滚）。
- 左卡单模型态：标题（随时间 Tab）→ 主数字+档位胶囊 → 模型行（色点+全名+「唯一模型」）→ 「本期统计」组标题（请求轮次=overall.turns / 当前模型 / 覆盖范围单值随时间 Tab：最近N轮/今天/近7天/本月/全部历史）→ 峰值/最低/最新（unit=day 时切日均标签）。多模型态：「已选 N 个模型 · M 轮」→ 档位胶囊 → **所选模型分布 · 按请求数**（堆叠条+表格：模型/均速 t/s/占比；占比=该模型已完成请求数占比，恰好 100%；设计稿的「按请求轮次」废用——单轮多模型会超 100%，PRD §10 禁止）→ 峰值/最低/最新。
- 降级模式（msAvail=false）：多模型态隐藏「均速」列、图表退化为不依赖模型速度的形态（热力/柱仍画整轮值），notice 明示「该历史数据缺少模型级生成耗时，暂无法按模型比较速度」；身份/Token 分布照常展示。降级帧叠加模型筛选时，左卡如实显示整轮值主数字与真实轮数（「请求轮次」kv，不拼 count），主数字带 title 点明「整轮值…含未选中的模型」，不出空态、不伪造「请求轮次 0 轮」；today/week 日行在降级帧下照常出图（v445）。
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
- 目标（2026-11-17 红队实测修订）：6000 轮池单签名重算 ≤ 8ms（project|all 首算实测 10.9ms 为已知超预算档；memo 命中 <0.02ms）；首开 ≤ 50ms（recent 档实测 20-26ms；all 档悬停每拍串 ≤260KB 由 wire 串 memo 抑制为相位变化时才重建）；speed_days 快照增量 ≤ 100KiB（打平+cap8 + 快照序列化紧凑分隔符后满帧实测 81-96KiB 按值域；对照 speed_history 160KB 同级先例；v457 起合计段可使贴近上限的帧略超，见下条）。memo 形态=WeakMap<帧, Map<签名,结果>> 每帧上限 8（单槽互踢是红队 BLOCKER，已废）。
- v457 日桶第 7 位 `tk` 的体积（2026-11-24 合成 550 日满帧实测，紧凑分隔符）：当日输入/输出合计恒带约 +7.7KiB；每模型 token 若不分窗全带，最坏（8 模型/日）86.2→124.9KiB 超预算，故只给多模型日的最近 `_SPEED_DAYS_TK_DAYS = 90` 天携带（单模型日由合计推导、零增量）。改前→改后：1 模型/日 20.5→28.0KiB、2 模型 29.7→38.4、4 模型 49.6→60.1、8 模型 86.2→99.8KiB。合计段是刚性增量，旧帧本身按值域逼近 96KiB 的库会略超 100KiB——属已登记的已知超支，不靠截合计换预算（未筛选的 token 行依赖它）。

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

实测截图：多模型左卡「已选 N 个模型 · M 轮」直接接档位胶囊，均速大数字消失。修复：多模型分支结构 = 标题行 → **主数字（overall.v）+ t/s** → 档位胶囊 → 「本期有效 N 个模型 · M 轮」（+ 无数据已选提示）→ 分布（堆叠条 + div Grid 网格表恒全量展开、容器内滚；v394 起「查看全部」折叠按钮退役，见 §15.4）→ 峰/低/新。任何模型数（1/2/7/20/部分无数据/全部无数据）主数字恒在；无数据显示 `—` 不隐藏区块。

### 11.4 空状态（四）

`an.real` 为空时 view 接管渲染居中空态：主布局不变（左卡 —/0/—，图表区居中提示），**原因行按 `an.emptyReason` 区分**（session 无历史 / 筛选空集 / 时间窗无请求 / 已选模型无数据 / 数据未加载 / 旧快照无模型级统计 / 查询失败——按池构成判定，不千篇一律「尝试更长时间范围」），动作按钮真实生效：`[清除模型筛选]`（仅显式筛选时出现）`[查看全部时间]`（period≠all 时）→ `data-sv3-act="clear-filter"|"all-time"`，两链（06/01）委托接入：clear-filter=spd3FilterAll+重建；all-time=speedSel.period="all"+重建。

### 11.5 语义与文案

- 模型数量三语义：可选 Y（池全部）/ 已选 X（filt）/ **本期有效 N**（perModel.length）；计数行与 chips 计数统一「已选 X/Y · 本期有效 N」；「唯一模型」只用于真单模型池。
- live 徽标已移除（v415，用户裁定）：标题行只留常驻统计（ltitle+count），「实时估算中」与思考/工具等 statusText 临时态不再展示——速度含义恒为统计口径，不被实时相位词污染；wire memo 键随之去 live.statusText（实时态变化不再触发整卡重拼）。
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

- `min-height:480px` 废除，改**离散档位**（渲染端纯函数按 an 计算，写入 root 内联 min-height + `data-h-tier`）。
  **v393（§17）起五形态统一 450**：empty / recent / today / week / month / all 全部恒 450（历史档位 empty 320、recent 340/360/390→400、month 430/450/470、all 380/420/460 全部废除）。矮视口（窗口高 < 档位+16px）下 CSS min-height 胜过 maxHeight 钳制，root 保持档位高、内容经 tip 基类内滚可达——与 v387 的 min(480,100vh-16) 自钳不同，为记录在案的有意取舍。
- 档位离散保证稳定：hover/快照刷新不改变 tier；时间 Tab 切换允许跳档（v392 后 recent/today/week 三档同高不跳）；模型展开不撑高（分布表内滚上限不变）。
- root 高度语义=`min-height`（内容可超出）；左卡与图表卡等高由 flex stretch 承担，但**内部内容自然流、禁止 margin-top:auto 推底**（§12.2）；图表绘图区独立固定高（charts 自身参数），不随卡拉伸。

### 12.2 左卡自然内容流（P0）

单/多模型统一顺序：标题→主数字→档位→模型行/计数行→本期统计→**分隔线（固定间距）**→峰/低/新。各段固定 margin（8/10px 节奏），消除大弹性空白；「当前模型」行与模型 Chip 完全同名时去重（替换为 有效输出 Token 或省略）；多模型分布表改 CSS Grid 三列 `minmax(0,1fr) 固定 固定`（数字列右对齐、名称 ellipsis+hover 全名、供应商副标保留），**根除横向滚动**（实测 23px）。

### 12.3 柱图密度分档（P0）

- `bars` 容器 `max-width:min(100%, calc(槽数×最大柱心距))` + `margin:0 auto`：n=1→视觉居中；n≤3 maxPitch≈120px（居中分组，禁止两柱顶到两端）；4≤n≤8→多数视口满幅均衡（140px 上限在窄 plot 下对 n=4 触发居中，无害）；n>8→紧凑满幅。柱宽密度三档（18/14/10）保留。
- wrap 幻影：`.zu-sv3-chart .zu-sc-plot` 的 `width:100%` 改 `width:auto`（block+margin-left:30 自动填剩余），溢出 30px 根除；**禁止仅隐藏滚动条**。

### 12.4 筛选栏单行（P1）

`.zu-sv3-fbar{flex-wrap:nowrap}`：chips 区 `flex:1 1 auto;min-width:0;overflow:hidden`（视觉收纳），计数与搜索 `flex:0 0 auto;white-space:nowrap`；长名 Chip ellipsis+hover 全名（已有）。任何模型数下 fbar 高度恒一行。**v400 起（§23）常驻 chips 预算由视口感知动态化，「3」降级为 VM/无 window/窄窗的回退下限，不再是固定常驻数。**

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

## 13. v389 图表弹性高与折线交互批（2026-11-18，第四轮）

真机诊断定案：折线 hover 委托链完好（合成 mouseover 逐 hit 验证 portal shown、无数据日不吸附、tier 生效 rootH 493≥400）——「无提示」观感真因=无数据日零反馈 + 信息卡字段不足；图表底部空白真因=plot 固定 216 不随左卡拉伸（today gap 49 / all gap 127px）。

### 13.1 plot 弹性高（P0）

- `.zu-sv3-chart .zu-sc-plot{height:216px}` 改 `flex:1;min-height:200px;max-height:300px`（吸收左卡/档位拉伸；卡内容少时 200 保底，主体高时最多 300）。
- 折线 SVG 全部 **y 坐标百分比化**（svg `height="100%"`、y=百分比、圆点/线宽 px；hit rect height 100%）；面积 path、grid 线、X 轴带同步。柱图 DOM 槽天然 height:100% 已自适应。
- X 轴标签行高度独立固定（16px），最后一行标签距卡内边界 ≤28px（PRD §2.4）。

### 13.2 折线 hover 完整化（P0）

- **真因（真机 ：hover 链实证，2026-11-18）**：`.zu-sc-grid`/`.zu-sc-gutter`（Y 网格/沟槽，position:absolute）按 CSS 绘制顺序压在**非定位的折线 svg** 之上——真实鼠标 hit-testing 恒命中 grid，`.zu-sv3-hit` 收不到 mouseover（合成 dispatchEvent 绕过 hit-testing，历轮真机/harness hover 验证全被它骗过）。修复=grid/gutter `pointer-events:none`（纯装饰）+ `.zu-sv3-svg{position:relative}`（回到定位层）。

- **无数据日出卡**：空槽 hover → 「M/D（周X）· 无有效速度记录」轻卡（不再静默）；进行日/已结束日区间文案沿 §11.5。
- 有数据日卡字段增强：综合日均（档位色大字）→ 模型明细（色点+名+供应商副标+均速+请求数，>6 行截断+「另有 N 个模型」）→ 有效轮次/有效输出 → 预估费用（o.fmtMoney，缺失「暂无估价」）。
- 两级 hover：列级（既有）+ **线级**——line path `pointer-events:stroke`，mouseover 给该模型线加高亮类（自身加粗/其余降透明），mouseout 还原；模型身份=颜色+卡内名称双识别。
- 键盘：hit 列已有 tabindex+方向键（v387）；aria-label 补「无数据」明示。

### 13.3 多模型折线视觉层级（P0）

- 三层：综合虚线（中性灰、dasharray 既有）< 模型实线（1.8px、模型色）< hover 高亮；模型 >4 时第 3 条起透明度 .6（排序按 out 降序，前 2 全不透明）。
- 稀疏规则不变：缺失日断线（分段 path）、单点不连线、无假点。

### 13.4 hist ≤7 天紧凑日卡（P1）

- 日历覆盖跨度 ≤7 自然日（按首末数据日+自然日覆盖算，非有数据日数）→ **day-cards 形态**：横排日期卡（日期+周几+日均速度+模型点 ≤3+`+N`，速度色阶底、今天描边），flex 居中分布；hover 日卡=spd3DayCardHTML 既有。**v395 起（§18.2）空日不再渲染「无记录」文字**（只留日号低对比底，aria 保留「无有效速度记录」）；阈值口径以 §18 四档为准（本节 7 天边界与 §18 一致，8-35 天周列描述已被 §18 取代）。
- 8-35 天=既有周列×星期行（≤14 列已居中）；>35 天不变（月聚合阈值 26 周既有）。
- 覆盖跨度判定用 an.items 首末日日历差，**不受筛选影响跳变**（覆盖=池时间轴，着色=筛选）。

### 13.5 左卡 Footer 与分布条对齐（P1）

- `.zu-sv3-stats` 恢复 `margin-top:auto`（Footer 语义：内容少时贴底、多模型内容多时自然紧贴，卡 padding-bottom ≥12 保证呼吸）——推翻 v388 §12.2 的"禁 auto"（第三轮断层实为分布表缺失时的推底空腔，Grid 化后左卡内容密度已足够）。
- 分布条对齐：dbar 与标题/表格同左右缘（统一容器 padding，误差 ≤2px）；dbar 加 role="img"+aria-label（各模型名:占比）；段 hover title=名+请求数+占比。

### 13.6 today 提示（P1）

- today 单模型柱图 head sub「有效 X 个小时」（X=非空桶数，X<轴长时）。

### 13.7 验收

- harness：today/week 的 plot 高度∈[200,300] 且 plot 底距卡底 ≤28px；折线 hit hover 出卡（合成 mouseover）含无数据日「无记录」卡；day-cards 形态（≤7 天夹具）与周网格（8+ 天）分发断言；dbar 左右缘与标题/表对齐 ≤2px。
- 真机：week 有数据日/无数据日 hover 各一实测。

## 14. v390 筛选入口统一与 hist 日历式批（2026-11-18，第五轮）

真机/源码诊断：①fpop `position:absolute;right:10px;bottom:10px` 锚定**卡右下角**（搜索按钮在顶部栏——距离远实锤）；②`+N`（.zu-sv3-chip-more）是纯 span 不可点；③dbar 19 段碎片化 + `min-width:2px` 下限使 Σ宽>100% 触发 flex 收缩、比例失真；④hist 37 天=周列式 6 列（64px 帽+居中）两侧大空白。

### 14.1 筛选入口统一（P0）

- **方案 A**：删除右侧放大镜按钮（.zu-sv3-fsearch 整链退役——含 01/06 委托、CSS、测试）；入口=`+N` button 与「模型筛选」标签 button（.zu-sv3-fopen，data-sv3-fopen），同一面板/同一状态/同一关闭行为。
- `+N` 与 fopen 均为真 button：aria-expanded（随 pop.open）、aria-haspopup、pointer/键盘（既有 pointerdown 委托白名单扩展）、Hover 反馈。
- fpop 定位改**锚定筛选栏正下方**：`top` 对齐 fbar 底 +8px（fbar 单行高稳定）、右缘对齐 `right:10px`、宽度 340px；卡内空间恒够（卡高 ≥320）无需翻转；`bottom:10px` 废除。
- 打开时焦点入搜索框（既有）；Esc/外点关闭（既有）；关闭焦点归还「模型筛选」标签（DOM 首个 fopen 入口；+N 打开时亦归还该合法入口）。

### 14.2 dbar 轨道契约 + Top6+其他（P0/P1）

- 轨道：`display:flex;align-items:stretch;height:8px;overflow:hidden;border-radius:4px;gap:0`；子段 `display:block;height:100%;align-self:stretch;flex-shrink:0;min-width:0;margin:0;padding:0;border:0;border-radius:0`——**废除 min-width:2px**（19 段碎片化与比例失真根源）。
- **Top6+其他**：shareSorted 前 6 段 + 「其他模型」中性灰段（占其余请求合计，严格按原始计数差）；段数 ≤7 无碎片。
- 极小占比显示 `<0.1%`（表格与 title 同步），不显 0%。
- 降级帧（二元组 `msl`、无请求数，合计为 0）：占比无从计算——分布条整条不画、表格占比列与筛选弹层行尾计数显「—」，不把「未知」显示成 `<0.1%` 或 0（v445）。
- dbar aria 简化为概况（「模型分布：N 个模型，前 6 占 X%」），完整数据由下方表格承载；段 title 保留（名+请求数+占比）。
- 分布表同步：默认 4 行含其他段行？——其他段不入明细表（表仍列真实模型全量）；仅条聚合。

### 14.3 hist 密度选择器（P0）

按覆盖跨度（an.axisA/axisB 日历差，不受筛选影响）分四档：
- **≤7 天**：day-cards（v389 既有 .zu3-dc）。
- **8–42 天**：**七列日历式**（新 .zu3-cal）：横向 7 列周日首、纵向自然周、完整覆盖跨度（含跨月/补位），格=日号+日均速度+模型点 ≤3+`+N`，速度色阶底/今天描边/空日灰/未来不渲染；月首列带月标记；hover 走既有日卡。与 month 组件同构复用（span 代替当月）。
- **43–90 天**：周列贡献式（既有 .zu3-hh，列帽 64px）与日历式按行数自动选择（自然周数 ≤8 用日历式防纵挤，否则周列式）。
- **>90 天**：周列式；周列 >26 既有月聚合（粒度文案同步）。
- 色阶/模型点/今天描边/空日语义全形态一致（tpsBand 唯一来源不变）。
- 日历式行数驱动卡高档位（已接线：R≤5→380、R6-7→420、R8→460；周列式 >56 天按日桶数 420/460）。

### 14.4 验收

- harness/VM：跨度 37 天→zu3-cal（7 列、行数=ceil、两侧无大空白=网格宽≥容器 85%）；8/42 边界；43-90 按周数选档；>90 周列式/月聚合不变；fpop top 锚定串断言；+N button 化（aria-expanded/键盘）；dbar 无 min-width、Top6+其他占比和=100%、`<0.1%` 显示。
- 真机：37 天场景截图（消除两侧空白）、+N 点击开面板、fpop 紧贴筛选栏。

## 15. v391 左卡精简、图表边框与柱标统一批（2026-11-18，第六轮）

源码/真机根因：①charts 分片 4 处内层 `<div class="zu-speed-chart zu-sv3-chart">` 注入在外层同名卡（`[data-sv3-chart]`）内，`.zu-sv3-root .zu-sv3-chart` 的边框+padding 规则对两层都命中——绘图区外多一层边框+双重 10/12px padding（柱/折线视图；热力视图内层类 zu-sv-chart 不命中故无此问题）；②左卡「本期统计」组标题与「覆盖范围」kv 冗余（标题行已含范围语义「最近 N 轮平均速度」）；③柱标显隐 `valEvery=ceil(n/8)`：9–12 根隔 2 显 1（违背 1–12 全显），>24 抽样步长与可视宽无关；④hist 日历/月历行 `minmax(0,1fr)` 无高帽——2–3 行短跨度格被拉成巨高（巨大空白网格）、day-card 垂直无帽；⑤「查看全部」左对齐。

### 15.1 左卡精简（P0）

- 删除空态与单模型态的「本期统计」组标题（`.zu-sv3-cov-h` 整链退役，含 CSS 规则）；删除单模型态「覆盖范围」kv 及其 covLbl 死代码（范围语义由标题行承载）。
- 保留：主数字/档位胶囊/模型摘要/请求轮次/有效输出（真单池）或当前模型（非真单池）/峰值/最低/最新；空态保留请求轮次 0/有效模型 0。
- 主数字恒在不随模型数变化（§11.3 契约保持）；删后无效空白由 stats `margin-top:auto` Footer 既有机制吸收。

### 15.2 图表重复边框（P0）

- 边框+圆角+padding 规则收窄到外层卡：`.zu-sv3-root .zu-sv3-chart[data-sv3-chart]{…}`（charts 分片内层内容盒不带该属性，不再命中）。
- **热力内层双框（审查 M1）**：热力/月历内层根类 `zu-sv-chart` 命中 06 分片 V2 基础规则（无 `.zu-sv-root` 作用域全文档生效）→ 外层 V3 边框内再镶一圈 1px+24px 水平内距；heat 分片补作用域中和 `.zu-sv3-root .zu-sv-chart{border:0;padding:0;border-radius:0}`（flex 列链仍由 V2 规则承担）。
- 验收：柱/折线/热力全形态绘图区外只有一层边框、一层 padding；无内容裁剪/新滚动条（tip.scrollWidth==clientWidth 不变）。

### 15.3 hist 密度阈值对齐 + 日历行高帽（P0）

- 阈值按 PRD 档位表（布局判断依据=axis 日历跨度，不按有效数据天数裁剪）：**≤6 天** day-cards（.zu3-dc）；**7–60 天** 七列日历式（.zu3-cal，连续日历热力图）；**>60 天** 周列贡献式（.zu3-hh；周列 >26 既有月聚合）。`SPD3_HIST_CAL_MAX_DAYS=60`、`SPD3_HIST_CAL_WEEKS` 分支删除（行高帽落地后 9–10 行日历不再纵挤）。**v395 起阈值经 §18 四档重构：DC=7 / 紧凑日历≤21 / CAL=63 / >63 贡献热力，本节 6/60 阈值由 §18 取代**（行高帽 CSS 与本节一致继续生效，紧凑档 56px 行高帽见 §18.2）。
- 日历/月历行高帽：`.zu3-hm-grid` 加 `max-height:calc(var(--zu-hm-rows,5)*84px)`（flex:1 增长封顶 → 行高 ≤84px），wrap 加 `justify-content:center`（周头+网格作为整组垂直居中，列对齐保持）——2–3 行短跨度不再拉成巨格、剩余空间上下均分；大跨度（行多）仍填满可用高。
- day-card 加 `max-height:150px`：≤6 天历史卡片成组居中、不再整卡拉高成巨卡。
- 高度档连带：all 档 cover≤60 判定与 heat 分派同轴口径（两端日零点归一+今天钳制）；R9-10 的 57–60 天从 420 档升 460 档（行高帽下每行 ≥30px 可读）。
- 本月完整自然月日历/空日灰格/未来遮罩/axis 时间轴判定全部不变。

### 15.4 「查看全部」按钮退役、分布表恒展开（P1，v394 用户裁定）

用户实测指令：去除 `<button class="zu-sv3-more" data-sv3-more>查看全部 N 个模型</button>`——默认即展开态，模型列表可滚动。

- 分布表（`.zu-sv3-dwrap > .zu-sv3-dtab`）恒渲染 `shareSorted` 全量行（不再 `slice(0,4)`），表容器既有 `max-height:150px;overflow-y:auto` 承担大量模型行的滚动；主 Tooltip 高度不被撑高。
- `spd3LeftHTML` 第三参 `expanded` 删除（签名 `(an, live, poolSingle, fmtTok)`），`DEF_ROWS`/`shown`/`more` 变量与返回串中的 `more` 一并删除；wire memo tail 移除 expanded 项，ctx 不再传 `expanded`。
- 两链（06 `spd3Activate`/01 `tpsSpd3Activate`）`closest` 白名单移除 `[data-sv3-more]`，`else if` 展开切换分支删除；`mousedown` 阻断名单中的 `.zu-sv3-more` 属**槽位卡「另有 N 个模型」行**（charts 分片无作用域规则），与本按钮无关，保留。
- `speedSel` 初始化与会话切换复位删除 `expanded:false`；view 分片 `.zu-sv3-more` 作用域 CSS 整段删除。
- 验收：VM 断言两链白名单不含 `data-sv3-more`；多模型分布行数=表头+全部模型行、DOM 无 `data-sv3-more`/`zu-sv3-more`；a11y 不再有展开态按钮；dwrap 恒 `max-height:150px;overflow-y:auto`；真机 20 模型默认全量行渲染且容器可滚。

### 15.5 柱状图数值标签统一（P0）

估宽 `estW=字符数×6+2`（v399：`字符数×6` 已贴近 10px tabular 字体实宽（约 5.9px/字符，含 letter-spacing:-.1px），旧 `+8` 是叠加的双重留白——10px 字体 "117.0" 实宽≈30px、18 柱槽宽≈34.4px 本可容纳，却因 30+8=38>34.4 被误判让位，致「项目/全部」Tab 18 柱只剩峰/低/新 2 个读数；`+2` 仅留极小呼吸）；槽宽 `slotW=estPlotW/n`；estPlotW 视口感知（`window.innerWidth` 可用时 clamp(180, 620)，VM/无 window 回退 620），窄窗下抽样步长随真实可视宽收缩。n>24 抽样步长 `ceil((maxLblW+8)/slotW)` 的 `+8` 是采样位间距裕度（maxLblW 本身不含留白），与此估宽无关、不变。三档确定性规则：

- **n ≤ 12**：全部非空柱显值；`estW > slotW` 的非关键柱让位（碰撞避让）。
- **13 ≤ n ≤ 24**：全部尝试显值，让位规则同上；**峰值/最低/最新恒显**（碰撞时优先保留），其余确定性隐藏。标准视口 18 柱（槽宽≈34.4px、estW≈32px）常规值应全部显出，不再整片让位；更密的 24 柱（槽宽≈25.8px）仍让位避免相邻标签重叠。
- **n > 24**：按可用空间自动抽样 `step=ceil((maxLblW+8)/slotW)`（≥2，`step×slotW ≥ maxLblW+8` 保证采样位间距不重叠），`c%step===0` 显值（抽样位不再叠加 fits 门槛——窄槽下叠加会全部让位、抽样失去意义）；关键值恒显；Hover 查看完整值。
- **0 值柱（非空 vv=0）不显「0.0」**（v391 起，无意义读数；v390 曾显）。
- 悬停柱恒显值（空槽/0 值槽悬停不触发抑制）；若其自身让位（estW>slotW）则临时隐藏左右邻已显的非关键标签（峰值/最低/最新恒显优先，不被抑制；确定性、收起即恢复）——悬停态常规位不重叠。
- 首末柱防裁切：仅当 `estW > slotW` 时首柱标签 `align-self:flex-start`、末柱 `flex-end` 钉在槽内（不越出 plot 触发横滚）。
- 统一样式：同字号/同色/顶部间距（.zu-sc-val 既有类共享，cur 加粗保留）。
- Hover 卡补「生成耗时」行（`item.ms>0` 显示；ms<100 显「<0.1秒」绝不显 0.0；降级帧 ms=0 整行省略，绝不造 0）——时间/模型/速度/Token/耗时/费用六要素齐（柱悬停卡与 today 槽位卡两处同款）。
- 柱高、数据、Hover 定位链零改动；X 轴时间标签稀疏规则（xThin）不动。

### 15.6 验收

- VM/单测：柱标 n=1/2/7/12/18/24/30/90 显隐集合断言（关键值在场、采样确定性、悬停邻让位、首末钉边类）；左卡三态不含「本期统计/覆盖范围」；边框单层（源码串断言 + harness computed 核对）；cal 阈值 7/60 边界与行高帽 CSS；>60 周列/月聚合不变；dc 1–2 天帽；hover 耗时行（有 ms 显、无 ms 省）。
- 真机：五视图截图对账（边框单层、柱标不重叠不裁切、短历史居中、分布表全量展开+容器内滚、无「查看全部」按钮）。

## 16. v392 用户反馈批（2026-11-18，第七轮）

真机截图反馈两项，均裁定为缺陷而非设计：

### 16.1 近 7 天单有效日无柱状图（P1）

- 真因：`spd3WeekHTML` 恒走折线（v384 spec §5 原设计「week=每日折线」），单有效日时折线退化为孤立点+端标签——无柱可看；而 today 单模型恒柱状，形态不对称。
- 裁定：week **单模型**改每日平均柱状（7 日槽位、空日=空位不显 0、覆盖提示「有效 X/7 天」与折线共用），与 today 单模型对称；**多模型保留折线+面积+总体虚线**（spec §5 多模型专属设计不动——总体线/分段面积只在多模型折线有意义）。单模型判定与 today 同源（`perModel.length===1`）。
- 实现落点：`spd3WeekHTML` 加单模型分支（复用 today 单模型的 `spd3BarsFrame+spd3BarCols+spd3PortalFor` 组合，slots 直接作 items——空槽轻卡/悬停链复用既有委托）。注意 slots 是**日桶**：`spd3PortalFor` 的 slotDay 必须传 `true`（区间/轻卡按 §11.5 日桶口径、大字=综合日均）；v392 移植时误带了 today 分支的 `false`，v416 修正并由单模型周视图悬停断言锁定。

### 16.2 范围切换 tooltip 高度跳变（P1）

- 真因：`spd3HeightTier` recent 三档 340/360/390 vs today/week 恒 400——「最近↔今天↔近 7 天」切换高度跳 60px。
- 裁定：recent **恒 400**（三档废除），三常用范围同高；month/all 热力/日历形态档位不动（内容结构不同）。plot 弹性（§13.1 200..300）吸收增量，柱图槽位 `height:100%` 自适应。
- §12.1 档位表已同步；`data-h-tier` recent 单档命名 `recent`。

### 16.3 验收

- VM/单测：week 单模型柱状断言（7 槽列+单柱+空槽透明+覆盖提示），多模型折线断言原样保留；recent 档位断言改恒 400（三旧档删除）。
- 真机：近 7 天单模型视图出柱（空日空位）、三范围切换高度目测恒定。

## 17. v393 五形态统一高（2026-11-19，第八轮，真机反馈）

用户五张真机截图对账（最近/今天/近 7 天/本月/全部）：高度 320..470 五档在范围间跳变（§16 只统一了三柱状视图，空态/月历/历史仍是离散档）。

### 17.1 裁定

- **五形态统一 450**（empty/recent/today/week/month/all 全部恒 450）：任意范围切换高度恒定，空态同高。450 取旧 month-r5 档——6 行月历经 v391 行高帽自适应（84px 帽、行数多时行内分配）在 450 内可读；all 周列式 R9-10 每行 ≥30px 可读（v391 判据）沿用。
- **plot 300 上限同步废除**（v389 §13.1 的 max-height:300px）：统一 450 后柱/折线绘图区吃满卡内剩余（典型 ≈370..400），X 标签带恒贴底、plot-bottom-gap ≤28px 断言保留；min-height 200 保底不变。
- `data-h-tier` 保留 period/empty 语义（诊断用）。
- **root 内联从 `min-height` 改 `height`**（§17 第二批，同轮实测定案）：root 是 auto 高 flex 列容器，`min-height` 只抬下限——内容 flex-basis 计算仍把 root 撑过档位（实测 all 日历式 6 行 492>450，撑高者=左卡/图表 stretch 假象；对照实验：隐去左卡 root 即回 450、压行数无效）。固定 `height` 后内部 `min-height:0` 收缩链生效恒等于档位。语义取舍（记录在案）：内容真超高（极端 `--ui-font-size`）时 root 内裁剪（主链自然高 ≤360 可容纳；分布表展开由 dwrap 内滚上限吸收；矮视口仍由 tip 基类 maxHeight 钳制+内滚），「内容可撑高」语义废除。

### 17.2 验收

- VM/单测：spd3HeightTier 单档断言（五形态+empty 全 450，旧行数/日桶档断言删除）；charts plot CSS 串断言（无 max-height）；harness ⑧ min-height 恒 450±10、⑩ plot ≥200 无上限。
- 真机：五 Tab 切换高度目测恒定（用户验收）。

## 18. v395 V6 全部 Tab 自适应可视化（2026-11-19，第九轮）

真机两场景（12 天/单模型/稀疏、39 天/20 模型/高密度）深审。核心：**同一个「全部」Tab 按真实历史跨度自动选布局，不机械按有效天数判跨度、不删无记录日、不重复「无记录」文字**。

### 18.1 统一布局选择（复用既有组件，不复制统计系统）

- `spd3SelectHistoryLayout(input)`（heat 分片）：输入 `{spanDays, activeDays}`（实现只消费这两字段；single/meta/start/end/todayStart/truncTxt 由构建方经 axis3 直接携带给各布局构建器，不进本函数），输出 `{mode, dense, sub}`，`mode ∈ daycards|cal|hh`。四档按**自然日跨度 spanDays**（非 activeDays）：**1–7 日卡** / **8–21 紧凑日历** / **22–63 完整日历** / **>63 贡献热力**（>26 周月聚合既有不变）；常量 `SPD3_HIST_DC_MAX_DAYS=7`、`SPD3_HIST_DENSE_MAX_DAYS=21`、`SPD3_HIST_CAL_MAX_DAYS=63`。
- `spanDays = round((axis末日零点 − axis首日零点)/864e5)+1`，轴取未筛选原始池 `an.axisA/axisB`（旧帧退化 spanA/spanB、再退化 items 首日），末日恒钳今天——与 v389/v391 同口径，**跨布局不跳轴、筛选不改形态**。`activeDays = byDay 有值日数`（仅用于 `dense` 元信息与 sub 文案披露，绝不用来缩短时间轴）。
- 两档日历共用 `spd3CalHTML`，`dense` 参数只影响 CSS 类（`zu3-cal-dense`）与副题；贡献热力/月聚合/日卡构建器零改动。
- 禁止项守门：无数据日照画低对比灰格（保留日期语义，禁止项 2/3），只是不再重复文字（§18.2）；日卡 ≤6→1–7 边界扩展但单卡聚焦不变。

### 18.2 无数据日文字噪声消除（场景 A/B 共同痛点）

- `spd3CalHTML`：空日格从 `zu3-cnone`"无记录" 改为空值占位（`.zu3-v` 不渲染文字），只保留日号 + 低对比底（`.zu-hm-void` 既有）+ 今天描边；`aria-label` 仍由 `spd3CellAria(ds,null)` 表达「无记录」（无障碍不丢语义），Hover 无数据日仍不出卡（既有约定）——避免整日历重复文字。
- `spd3DayCardsHTML`：空日卡 `zu3-dcnone`"无记录" 同步去除，只保留日期/星期 + 低对比底；单卡聚焦无数据走独立空态（`first===Infinity` 既有分支），不画一排灰卡冒充统计。
- 场景 A：8–21 天紧凑日历完整铺 12 个自然日，有数据日色阶+高对比，无数据日低调，一眼分辨活跃日；场景 B：22–63 天完整日历 7 列跨月，模型点 ≤3+`+N`（spd3DotsHTML 既有），多模型汇总与颜色口径不变。

### 18.3 边界与不变项

- 阈值以 spanDays 为准（axis 未筛选池），activeDays 只做密度披露：`activeDays/spanDays` 低时副题标「活跃 X/共 Y 天」，不伪造也不删日。
- **固定高 450 不变**（§17 用户裁定）：本批只调形态选择与空日呈现，不改 root 高度、不恢复「查看全部」按钮（v394 裁定）、不动速度口径/模型色阶/筛选/双 Tab 语义/其它 Tab。
- 色阶、模型点、Hover 卡、a11y、方向键委托、截断披露全部复用既有契约零改动。

### 18.4 验收

- VM：四档阈值 1/7/8/21/22/39/63/64/90 形态断言（阈值边界更新，7 天→daycards、61/63→cal、64→hh），spanDays 用 axis 不用 activeDays（稀疏 39 天只有 2 天有数据仍 cal），空日格无「无记录」文字但 aria 保留；两档日历共用构建器断言。
- harness：新增/调整几何断言覆盖空日无文字噪声、短历史居中、跨月 39 天 7 列；真机截图对照两场景（稀疏 12 天单模型、39 天 20 模型）。

## 19. v396 单模型左卡同构分布块（2026-11-19，用户裁定）

用户实测：单模型时左卡只显示一行 `.zu-sv3-model`（色点+模型名），信息密度与多模型不一致。裁定：单模型改为**与多模型同构的分布块**（本期有效计数 + 分布标题 + dbar 分布条 + dwrap 明细表），不再显示单行 model 行。

### 19.1 结构（单模型=models.length===1）

- 标题行 → 主数字 → 档位胶囊 → `.zu-sv3-count`（SVG cube + 「本期有效 1 个模型 · N 轮」）→ `.zu-sv3-dist-h` → `.zu-sv3-dbar`（1 段=该模型 100%，title=名+请求数+占比）→ `.zu-sv3-dwrap`（表头+1 行：模型/均速/占比）→ `有效输出` kv → 峰/低/新 stats。
- **去掉「请求轮次」kv**：count 行已含轮数，避免重复（用户裁定）；**保留「有效输出」kv**（fmtTok 缺席时整行省略，不虚构格式化值——沿用 §12.2 既有纪律，poolSingle 去重语义随之取消）。
- 单模型 dbar 恒 1 段 100%、无「其他」段（shareSorted 长度=1，Top6 分支天然满足）；msAvail=false 两列变体同多模型。
- 不再使用 `.zu-sv3-model` 单行（该 CSS 规则保留服务其它潜在调用，若全仓无引用则清理）；`spd3LeftHTML` 的 `expanded`/折叠链早已退役（v394），本批不恢复。

### 19.2 不变项与验收

- 速度口径、模型色阶（单模型分布条=该模型哈希色）、模型筛选、双 Tab、固定高 450、日期热力四档（§18）全部不变；仅左卡单模型分支呈现。
- VM：单模型五 period 标题、主数字恒在、含 count+dist-h+dbar+1 行表、无 `.zu-sv3-model`/「请求轮次」、有「有效输出」（fmtTok 在场）；多模型用例原样保持。

## 20. v397 分布表滚动条外移与表格增宽（2026-11-19，用户裁定）

用户实测：模型分布表 12 行滚动时，滚动条挤占表格内容宽度，数字列偏窄；要求「滚动条再往右侧偏移点，增大表格宽度」。

### 20.1 实现

- `.zu-sv3-dwrap` 加 `margin-right:-8px`：容器向右扩 8px（吃掉左卡右 padding 12px 中的 8px，距卡片边框仍余 4px），滚动条随之右移、表格内容区净增 8px。
- 滚动条改细：`scrollbar-width:thin` + `scrollbar-color:var(--color-border,rgba(128,128,128,.45)) transparent`（Chromium 121+），并双写 `::-webkit-scrollbar{width:6px}`/thumb/track 回退（旧宿主 Windows 经典滚动条约 17px 挤占表格，细条再省约 9px）。
- 内滚契约不变：`max-height:150px;overflow-y:auto` 保留，行/容器仍不写 overflow-x（Grid 保证无横向溢出）；`dist-no-hscroll` 与 ⑯ 几何断言口径不变。

### 20.2 不变项与验收

- 数据口径、模型色阶、筛选、固定高 450、四种历史布局、其它 Tooltip 全部不变；仅分布表容器盒模型与滚动条外观。
- VM：dwrap CSS 串含 `margin-right:-8px` + `scrollbar-width:thin` + webkit 6px 回退；harness 全链零 GEOMETRY_FAILURE；真机多模型 12 行滚动截图确认表格变宽、无横向溢出。

## 21. v398 无滚动条时恒定保留右侧边界间距（2026-11-19，用户裁定）

用户实测：仅 2 个模型（表不滚动）时，分布表右缘紧贴卡片边界、占比列数字几乎贴边；要求「右侧没有滚动条时，还是要预留出距离边界的距离」。

### 21.1 实现

- `.zu-sv3-dwrap` 加 `scrollbar-gutter:stable`：滚动条槽位恒定预留——有滚动条时是 6px 细条，无滚动条时是等宽 6px 空白；表格内容右缘距卡片边框恒 = 4px（负 margin 余量）+ 6px（槽位）= 10px，两种状态一致、不随模型数跳动。
- 保留 v397 的 `margin:6px -8px 0 0`（表格净宽 +8px）与细滚动条双写（scrollbar-width:thin + webkit 6px 回退）；`scrollbar-gutter:stable` 与 `-webkit-scrollbar{width:6px}` 在 Chromium 下预留宽度同为 6px，无冲突。
- 内滚契约 `max-height:150px;overflow-y:auto` 不变；行/容器仍无 overflow-x。

### 21.2 不变项与验收

- 数据口径、模型色阶、筛选、固定高 450、四档历史布局、单模型同构分布块、其它 Tooltip 全部不变。
- VM：dwrap CSS 串含 `scrollbar-gutter:stable`；harness 零 GEOMETRY_FAILURE（含 dist-no-hscroll）；真机 2 模型（不滚动）与 20 模型（滚动）两态截图对比——表格右缘距边界间距一致，无贴边、无横向溢出。

## 22. v399 柱状图常规柱数值显示（2026-11-19，用户截图裁定）

用户实测：「项目」和「全部」范围、时间=最近、18 根柱的截图里，只有峰值/最低/最新 2 根柱顶有数值，其余柱为空。这与「每根非空柱都应尽量带读数」的预期不符。

### 22.1 根因与实现

- 根因：`spd3BarCols` 的 `fits(t)=t.length*6+8<=slotW` 中 `+8` 叠加在 `length*6`（已贴近 10px tabular 字体实宽）之上构成双重留白；标准视口 18 柱槽宽≈34.4px、estW("117.0")=38px>34.4，13–24 档常规位被整片让位，只剩恒显的峰/低/新。
- 实现：`fits` 留白 `+8 → +2`（estW≈32px≤34.4），18 柱常规值全部显出；`length*6` 已贴近实宽，`+2` 仅极小呼吸，不引入相邻标签重叠（相邻槽中心距=slotW≈34.4px>5 字符标签实宽≈30px）。
- **覆盖边界**：「全显」限于 ≤5 字符读数（<1000 t/s，用户截图 GLM 常规档）；6 字符读数（≥1000 t/s，如 "1234.5" estW=38>34.4）因标签实宽≈35px 超过槽中心距，碰撞避让仍让位、仅关键位显值——这是物理约束下的正确行为（不让位必重叠），超出本次仅调估宽的范围；若需高速区间全显须另引入 plot 加宽/横滚机制，本批不做。
- n>24 抽样步长的 `ceil((maxLblW+8)/slotW)` 不变（采样位间距裕度，语义不同）；24 柱（slotW≈25.8px，estW≈32>25.8）仍走碰撞让位，仅关键位显值；窄窗 560px（est=208、16 柱 slotW=13）仍仅关键位在场。

### 22.2 不变项与验收

- 速度口径、柱高、数据、颜色规则、悬停卡、X 轴标签稀疏、历史四档、分布表、其它 Tooltip 全不变；仅调整常规位数值的估宽判定。
- VM：翻转 n=18「仅 2 柱显值」旧断言为「18 柱全显」；补 6 字符读数（≥1000 t/s）守卫断言——让位仅剩关键位，锁定高速档碰撞避让为设计预期；n=24 让位仅关键位、n=30 步长抽样+钉边、窄窗仅关键位三条回归断言原样保持；悬停恒显与邻抑制在此密度下仍成立。
- 真机：项目/全部 Tab 18 柱截图确认常规柱顶均有数值（截图值域 <1000 t/s）、无重叠、无裁切。

## 23. v400 筛选条 chips 动态预算（2026-11-19，用户截图裁定）

用户实测：模型筛选条在 chips（3 枚 + 「+8」）与右侧计数「已选 11/11 · 本期有效 11」之间留有大片空白（宽屏约 500-700px），空间未利用。

### 23.1 根因与实现

- 根因：v387 §12.4 把常驻 chips 预算硬编码为 3 枚（VM 时代保守值）；而 chips 区 CSS 本就是 `flex:1 1 auto + overflow:hidden`，宽屏下空间被白白空置。
- 实现：`spd3FilterBarHTML` 内 MAX 动态化——视口感知估宽（与 §15.5 `spd3PlotEstW` 同哲学）。基数=根宽帽 `min(vw−60, 920)`（§11.1 宽度链，root 即 fbar 实际容器、自身无边框）；`avail = min(vw−60, 920) − 22（fbar padding 20+border 2） − 14（漏斗） − 18（三段 gap） − 36（+N 预留） − (visW(「模型筛选」标签)+6) − (visW(count)+16)`，其中 `visW(s)=逐字符 (charCodeAt>0x2E7F ? 11 : 6)`（CJK≈11px、ASCII≈6px，贴近 fbar 全线 11px=14−3 实字宽；en 文案全 ASCII 估宽偏保守）。逐枚累加 `chipW = min(visW(名), 137) + 33（padding 18+border 2+dot 8+dot gap 5）+ 4（gap）`（missing chip 额外 +36「无数据」标记；137=chip max-width 170 扣 dot/padding/border），装不下即止；MAX=装得下的枚数，clamp [3, 池大小]。
- 回退：VM/无 `window` → MAX=3，v387 行为与全部既有测试保持不变；估宽偏差由既有 CSS 兜底（chip `max-width:170px` 省略、chips overflow:hidden、flex shrink + chip-name ellipsis），+N `flex:0 0 auto` 且恒预留，不参与收缩、不被裁。
- 已知限制：visW 常数按默认字号 11px 定标；用户调大 `--ui-font-size` 时文字实宽变大、估宽系统性低估，溢出由 chip flex-shrink 吸收（同上兜底链），不裁 +N、不换行。基数按**全窗** `min(vw−60, 920)` 估——tooltip 所在容器被分栏压窄（root `max-width:100%` 生效、容器窄于视口帽）时系统性高估，溢出同样由收缩链吸收；收缩容量耗尽的极端窄容器下尾部 +N 可被 `overflow:hidden` 裁切，但「模型筛选」标签恒在场（同为 data-sv3-fopen 入口），弹出层可达、不会产生数据错误。预算在构建时读一次视口宽，tooltip 打开期间调窗宽不重算（与高度档位/plot 估宽同款构建时模式，下一次整卡重编按新宽生效）。
- 恒单行契约不变（§12.4 双层 nowrap，v400 起该节「常驻 3」由本节动态化取代）；chips 池排序（out 降序）、弹出层、fcount「已选 X/Y · 本期有效 N」语义零改动。

### 23.2 不变项与验收

- 速度口径、左卡、图表、历史四档、分布表、弹出层交互、其它 Tooltip 全不变；仅筛选条常驻 chips 枚数由视口宽驱动。
- VM：既有「3 枚 + +N」断言原样保持（无 window 回退）；新增视口分支断言——`innerWidth=1200` 显著多显 chips 且 +N 数字相应减少、`innerWidth=560` 仍 3 枚。
- 真机：宽屏筛选条截图确认 chips 增多、+N 与计数无重叠、无换行、无裁切异常。

## 24. v402 左卡计数行并入标题行（2026-11-20，用户裁定）

用户指定：把左卡 `.zu-sv3-count`（cube 图标 + 模型数/轮数）从主数字下方独立行移到标题 `.zu-sv3-ltitle`（如「历史平均速度」）后面同一行；文案「本期有效 N 个模型 · M 轮」去掉「本期有效」前缀，变为「N 个模型 · M 轮」（en 同步去 "active"）。

### 24.1 实现与布局

- `spd3LeftHTML`：count div 移入 `.zu-sv3-title-row`，顺序 = ltitle → count → live 徽标（live 徽标保持最后，临时态不挤占常驻统计位；该徽标已随 v415 移除，现行标题行顺序为 ltitle → count，见 §11.5）；主数字下方原 count 位不再渲染（主数字 → 档位胶囊 → 分布标题的间距由 `.zu-sv3-dist-h` 自带 `margin-top:10px` 承接）。
- 文案：`SPD_L(N + " 个模型 · " + M + " 轮", N + " models · " + M + " turns")`；语义限定（哪些算「有效」）由 miss 提示与 §19 分布口径承载，不再在计数行重复。
- CSS：`.zu-sv3-count` 去 `margin-top:8px`（在标题行内），其余布局原样（flex wrap 保留——selMissing 的 `.zu-sv3-count-miss` 提示 `flex:1 1 100%` 仍在 count 块内换行到第二行）；count 的 `<span>` 加 `white-space:nowrap`（短文案不折行，极端窄时由 ltitle 的 ellipsis 让位承担）。
- 空态分支无 count（既有），标题行结构不变。

### 24.2 不变项与验收

- 速度口径、分布表、筛选条 fcount「已选 X/Y · 本期有效 N」（筛选条计数不动，仍带「本期有效」）、固定高 450、其它 Tooltip 全不变。
- VM：左卡 count 断言翻转（「本期有效 N 个模型」→「N 个模型」+ 位置在 title-row 内）；en 断言 "active models" → "models"；筛选条 fcount 断言原样保持。
- 真机：左卡标题行截图确认 count 与标题同行、主数字下方无残留空行。

### 24.3 v403 追加裁定：去图标与量词（2026-11-20）

- 删除 count 的 cube 图标（`SPD3_SVG_CUBE` 常量与 `.zu-sv3-count svg` CSS 一并删除——count 为其唯一消费者）；「N 个模型 · M 轮」→「N 模型 · M 轮」（en "N models · M turns" 本就无量词，不变）。
- VM：左卡 count 断言「个模型」→「模型」同步翻转；其余同 §24.2。

### 24.4 v404 追加裁定：前缀分隔符（2026-11-20）

- count span 前加「 · 」引导（` · N 模型 · M 轮`，en 同 ` · N models · M turns`）——与标题间视觉分隔。
- VM：count 断言补「· 」前缀；其余同 §24.2/§24.3。

## 25. v457 热力图 token 行与数值贴右（2026-11-24，用户裁定）

代际号说明：本批开工时 main 为 v450、原立账 v451；并行线本地已占 v451–v456，按合入顺序顺延为 v457（文内规则名随代际号写 v457）。

用户实报（本月日历与全部历史日历截图）：格内只有日均速度，看不出当天用了多少 token；数值靠左、格底留白。裁定两项：①速度下方显示当日 **Token 总消耗（输入+输出）**——与柱状图悬停卡「Token 总消耗」同口径（用户在「总消耗 / 有效输出」中选总消耗）；放不下时适当缩小速度字号；②数值贴右——仅速度与 token 两行，日期仍在左上、模型色点仍在右上，左卡分布表不动（用户裁定）。

### 25.1 数据契约

见 §1.1（轮级 `tk`）与 §1.2（日桶第 7 位 `tk`）。设计约束：

- 旧渲染端读新帧：轮表 `tk` 是未知键、日桶第 7 位按下标读不到——均被忽略，不误读。日桶 `msl` 打平步长恒为 5，**不得**改成 7 步长（旧渲染端会按 5 步长错位解析）。
- 新渲染端读旧帧：轮表行自 v253 起带 `i/o`，单模型轮 `tok = i+o`；多模型轮无 `tk` → 各模型 `tt` 未知；日桶行无 `tk` → `tok = null`、`i = o = 0`。未知的桶不出 token 行（绝不估数）。
- 日桶行（`spd3UnpackDaysRaw`）：`tok = tin + tout`（未筛选恒精确，与近 90 天窗口无关），`i/o = tin/tout`；合计段任一值非法（畸形帧）→ 该行 `tok = null`、`i = o = 0`，每模型段照常读——不把非法值当 0 后显示一个被低估的合计。轮表行（`spd3UnpackRaw`）同理：`i` / `o` 任一缺失或非法 → `tok = null`、不由它推导单模型 `tt`（行上的 `i` / `o` 字段沿用既有口径，缺席记 0）；生产端自 v253 起恒成对写出 `i` / `o`，此判定只是防线。每模型 `tt`——`tk` 只含合计且恰一个入列模型 → 取合计（这类日在筛选下只有全选或整行剔除两态，推导值不参与显示）；`tk` 带每模型段 → 按条目序号取（越界=未知）；多模型日的 `tk` 只含合计（早于近 90 天，§8）→ 各模型 `tt` 未知。
- 模型筛选（§4 部分选中分支）：`tok` = 选中模型 `tt` 之和；任一选中模型 `tt` 未知 → 该行 `tok = null`。整行全选沿用行级合计（含未入列模型的 token）。降级分支（无模型级窗口，`models` 清空）在筛选下 `tok = null`。
- 聚合 `spd3Aggregate`：`tok` = 桶内各行 `tok` 之和，任一行未知（或空桶）→ `null`。`tok` 不参与任何速度计算。
- 月桶（`spd3MonthBuckets`）：`tok` = 当月各日桶之和，任一日未知 → `null`。

### 25.2 渲染与布局

- 值组：`tok` 已知时格内速度为 `<span class="zu3-vwrap"><span class="zu3-v">…</span><span class="zu3-tk">…</span></span>`；未知时保持原裸 `<span class="zu3-v">`（结构零变化）。token 文本经 `o.fmtTok`（跟随万/亿开关，缺席回退原值），格内不带单位——含义由悬停卡与 aria 说明。接入五形态：本月日历、全部历史日历（含紧凑档）、周列热力、月列（月合计）、≤7 天日卡。
- 窄列紧凑写法：周列/月列格内容宽只有约 28–58px，放不下「1234.57万」这类写法，token 文本经 `spd3TokCompact` 取紧凑形态——带小数时只保留到合计 4 位数字（`1234.57万`→`1234万`、`123.45万`→`123.4万`；`12.34万`、`1.23亿`、`18.23M` 不变），只裁小数位、不改量级。日历格、日卡、悬停卡与 aria 一律全文。窄到放不下时整行隐藏（见下表），不出被裁切的半截数字。
- 贴右：裸 `.zu3-v` 加 `align-self:flex-end`；`.zu3-vwrap` 在日号下方剩余空间垂直居中、列内右对齐（`margin:auto 0` + `align-items:flex-end`），周列格贴底、日卡沿 space-between 贴底——与改前裸速度值的位置规则逐形态一致。
- 按格高分档（CSS 容器查询，条件按格的**内容盒**计高宽 = 格盒减内距）。日历格 `.zu3-hm-grid .zu-hm-cell`（容器名 `zu3hc`；本月/全部日历含紧凑档共用）与周列/月列格 `.zu3-hh-grid .zu-hm-cell`（容器名 `zu3hw`）各设 `container-type:size`：这些格所在的网格行列轨道恒为 `minmax(0,1fr)`/固定上下限，格尺寸由轨道确定、与内容无关，尺寸包含不改变布局。日卡 `.zu3-dc-grid` 的行高由内容撑出，**不得**设尺寸包含。缩字只作用于带 token 行的值组（`.zu3-vwrap` 内），无 token 的格观感不变；档位只改子元素字号/显隐，不得改容器自身的盒（防查询抖动）。

  | 容器 | 内容盒条件 | 处理 |
  |---|---|---|
  | 日历格 | 高 > 39px，宽 ≥ 49.5px | 原字号（本月 9px / 全部日历 12px），token 8px（全部日历 9px） |
  | 日历格 | 26.5px ≤ 高 ≤ 39px，宽 ≥ 39.5px | token 7px |
  | 日历格 | 26.5px ≤ 高 ≤ 33px，宽 ≥ 36.8px | 另缩速度：本月 9→8px、全部日历 12→10px；token 6.5px |
  | 日历格 | 39.5px ≤ 宽 < 49.5px（高 > 33px；更矮的格已落在上面两档） | token 7px；速度字号仍按高度档 |
  | 日历格 | 36.8px ≤ 宽 < 39.5px（高在上述三档内） | token 6.5px；速度字号仍按高度档 |
  | 周列/月列格 | 高 > 25px，宽 ≥ 30px | 速度 9px，token 7px |
  | 周列/月列格 | 21.5px ≤ 高 ≤ 25px，宽 ≥ 30px | 速度 8px，token 6.5px |
  | 周列/月列格 | 28px ≤ 宽 < 30px（高在上述两档内） | token 6.5px；速度字号仍按高度档 |
  | 周列/月列格 | 26px ≤ 宽 < 28px（高在上述两档内） | token 6px；速度字号仍按高度档 |
  | 两者 | 日历格高 < 26.5px、周列/月列格高 < 21.5px、日历格宽 < 36.8px，或周列/月列格宽 < 26px | 隐藏 token 行（速度恒保留、不缩字） |

  周列/月列格没有日号行（头部只有 ≤6px 的模型点），速度缩字线比日历格低 8px（33 → 25px），隐藏线低 5px（26.5 → 21.5px）。阈值来源=真实 Electron 夹具实测（2026-11-24，`tests/speed-tooltip-host` 的 host.html + 临时几何探针，非入库测试）：默认窗宽、`--ui-font-size: 14` 下本月日历格内容高 59.7 / 45.4 / 35.8 / 29.0（4/5/6/7 行），全部日历 40.4 / 31.6 / 25.4（5/6/7 行），周列 29.8×34.6，月列 250.9×36.4（这批窄列的列数与图表内容宽未记录，测量条件与下一条 11-25 批次不同）；深/浅主题、窄窗（560）、英文、大数字（亿级）与 `--ui-font-size: 17/20` 同批跑过。各档速度与 token 两行均不溢出、不压日号与色点，速度与 token 右缘到格内容右缘距离为 0——这一句只对日历与日卡成立，周列/月列窄格在首版 30px 隐藏线下 token 行本是隐藏态，窄列的显示与阈值以下一条的实测为准；最小上下间隙 0.98px（`--ui-font-size: 20` 的 5 行全部日历）。本月日历至多 6 行，token 恒可显示；全部日历在 7 行上下临界（夹具里 7 行内容高 25.4 隐藏、真实数据下 7 行因头部单行内容高 29 落缩字档），8 行起必隐藏；窄窗日历（格宽约 29px）隐藏 token。改阈值须同步 `overlay-speed-v3-heat` 的样式串断言与 `.zcode/rules/overlay-ui.md`。
  - **周列/月列的宽度线（2026-11-25 合并前审查修正）**：首版把两种容器的隐藏线都定在宽 < 30px，而周列/月列在常见历史长度下本来就比 30px 窄——真实 Electron 夹具实测（默认窗宽 1240）：周列 ≤15 列内容宽 ≥ 31.7px；**≥16 列（历史约 106 天起）网格横向滚动、列宽被 34px 下限钉住，内容宽恒 28.2px**；月列 17 / 18 / 19 列内容宽 28.4 / 26.3 / 24.4px。按 30px 线这些格的 token 行全部被藏（首版校准只量到 14 列，没发现）。紧凑写法的自然宽按夹具字体实测（`system-ui` + PingFang，tabular-nums，字重 500）：`123.4万` / `12.34万` / `1.234亿` / `10.96亿`（4 位数字带小数点）在 7px / 6.5px / 6px 下为 28.4 / 26.5 / 24.5px，`1234万` 为 26.0 / 24.2 / 22.4px。所以周列/月列的宽度线按「每档留 ≥1.4px 余量」定为：≥ 30px 用 7px；28–30px 用 6.5px；26–28px 用 6px；< 26px 才隐藏（首版修正曾想用 6px 一档盖到 24px，实测差 0.1~0.2px 被裁成 `123.5…` 丢单位，作废）。修正后实测（默认窗宽 1240）：周列 16 列（112 天）112/112 格显示、周列 22 列（150 天）150/150、上限 26 列（178 天）178/178，同为 6.5px（≥16 列起列宽被 34px 下限钉住，内容宽与列数无关；180 天起切月列，7 列、内容宽 58px）；月列 17 列（500 天）17/17，6.5px；月列 18 列（540 天）18/18，6px；均无裁切。**仍隐藏**：月列 19 列（550 日窗口的首日落到第 19 个自然月时；内容宽 24.4px < 最宽写法在 6px 下的 24.5px）；窄窗（560）周列格内容高只有 16px、月列 19 列内容宽 12.2px。日历格的宽度线见下一条。
  - **边界不留缝（2026-11-25 合并前审查实测修正）**：隐藏条件与窄列档的上界一律写范围查询——`(width < 26px)` / `(width < 30px)` / `(height < 26.5px)` / `(height < 21.5px)`，与缩字档的下界 N 互补。首版与首版修正稿都写成 `max-width:N-0.1px`，在 N 下方留了约 0.1px 的缝：落在缝里的格既不隐藏也不缩字，token 按原字号显示后被裁成省略号（真实 Electron 夹具复现五处——首版的三处：日历格宽 29.95px、日历格高 26.45px、周列格高 21.45px；修正稿新增宽度线后的两处：周列格宽 25.95px、月列格宽 27.95px）。不能用 `N-0.0001px` 去补：引擎对 `max-`/`min-` 的比较有约 1/64px 的容差，`max-width:25.9999px` 会连 26px 的格一起隐藏。范围写法在 ZCode 4.0.0（Electron 44 / Chrome 152）与夹具 Electron 45 上行为一致（同一张边界矩阵）：N 以下恒隐藏、N 起不隐藏，无缝隙；缩字档的下界会提前约 2/128px 为真，这段与隐藏规则重叠，由排在后面的隐藏规则胜出（真实样式表按 1/128px 步长细扫 26 / 28 / 30px 宽与 21.5 / 26.5px 高五条线，全程无省略号）。
  - **日历格的宽度线（2026-11-25 合并前复审修正）**：日历格用全文写法，「1234.57万」在 9 / 8 / 7 / 6.5px 下的自然宽为 47.8 / 42.8 / 37.8 / 35.3px（同上夹具字体；`1234.57M` 窄约 0.9px），首版「宽 < 30px 隐藏」一条线偏低——真实 Electron 夹具实测，窄窗下 token 行显示后被裁成省略号：窗宽 620（内容盒 30.0×29.2px、6.5px 字号，`1469.1万` 自然宽 30.9px）、窗宽 620 与 640 的 4 行日历（30.0 / 32.9×36.5px、7px，33.1px）、窗宽 700 的 4 行日历（41.4×45.7px、9px，41.8px）。按同一余量规则改为分档：≥ 49.5px 跟随高度档字号；39.5–49.5px 降到 7px；36.8–39.5px 降到 6.5px；< 36.8px 隐藏；两档高度缩字的宽度下限同步改为 36.8px（token 已隐藏时不缩速度）。修正后实测（窗宽 600–920 × 4–7 行，长 token 文本）无裁切：窗宽 600–660 隐藏，680 起 6.5px，700–740 为 7px，760 起高格回到 9px。阈值按夹具字体（`system-ui` + PingFang）标定，其它字体（如 Windows 的微软雅黑）字宽不同，未实测。
- 悬停卡：日卡/月卡加「Token 总消耗」行（`.zu-sv3-ctok`，数值一行不折），仅当 `i+o === tok`（未筛选、拆分可信）时附次行小字「输入 a · 输出 b」；筛选后只显合计。aria：格/月补「消耗 X token」（全文写法）。

### 25.3 不变项与验收

- 速度口径、档位色、五形态布局选择、左卡、柱/折线图、日期与色点位置全不变。
- VM：五形态 token 行文本（含 fmtTok 桩与缺席两态）、窄列紧凑写法、旧帧不出行、日桶单模型日合计推导与近 90 天窗口外的未知、筛选部分选中重算与未知即不出行、样式串含贴右与分档规则（含「日卡格不设尺寸容器」负向锁）、aria 与悬停卡；变异——筛选错算 / 未知估数 / 任一形态漏接，均须被杀死。
- Python：`tk` 产出规则（多模型 / 单模型省略 / 未入列模型 / 8 条帽对齐）、日桶 tin/tout 含无效窗口行、每模型段近 90 天窗口（窗口内多模型日带、窗口外只留合计、单入列模型的日恒只留合计）、空日仍 6 个 0。
- 帧体积：合成 550 日满帧改前/改后实测记入 §8（不分窗全带最坏 124.9KiB 超预算，是设 90 天窗口的依据）。
- 真机：本月与全部日历截图确认两行贴右、不溢出、不压日号/色点；7 行本月日历与 6 行全部日历缩档后仍可读（夹具实测见 §25.2）。真实数据复核（2026-11-24，本机真实快照经 `zusage.py serve` 只读拉取、在夹具页用本批构建渲染，**未部署到运行目录**）：本月 5 行落原档；全部日历同为 7 行（44 天）时格高随头部行数变化——头部单行时内容高 29 落缩字档显示、夹具里头部占高时内容高 25.4 则隐藏，判据是实际内容盒而非行数；所有有数据格都出 token 行，数值与库内当日 `input+output` 合计逐日一致（如 11-12 为 4.27亿、11-23 为 7.36亿）。这次复核时本机历史约 44 天，周列只有约 7 列、落在宽格区，**没有覆盖窄列**。真实客户端上的截图验收待部署后另记。
- 变异自查（2026-11-24，首版 `bf389b0` 时点，临时脚本，非入库测试；不含修复提交）：50 个单点变异——取数 11、数据层 10、渲染 29（筛选错算、未知估数、五形态各自漏接、对齐/顺序/阈值/贴右/aria/悬停卡）——49 个被断言击杀、0 个崩溃型击杀，存活 1 个是故意设置的等价改写对照。
- 合并前审查与修复后的补测（2026-11-25）：三路独立复审（Python 契约 / 渲染端 / 测试有效性）针对首版共做 121 个单点变异，存活项对应的测试缺口与 1 个渲染端 MAJOR（周列/月列窄格的 token 行被 30px 隐藏线整行藏掉）已在修复提交处理。修复后的真实 Electron 夹具实测（默认窗宽 1240）：周列 16 / 22 / 26 列（112 / 150 / 178 天）全部显示、6.5px、无裁切；月列 17 / 18 列显示（6.5 / 6px）、19 列隐藏；窄窗（560）周列格内容高 16px，隐藏；全部日历 4–8 行的显示 / 缩字 / 隐藏与 §25.2 表一致；边界探针在 N 下方 1/128px 处隐藏、N 处进档，全程无省略号。日历格宽度线分档后，窗宽 600–920 × 4–7 行（长 token 文本）无裁切（分档前 4 个场景被裁）。变异复核共 53 个单点变异（CSS 档位的条件 / 块体字号 / 源序 / 隐藏写法、日行与轮表行的合计严格判定、每模型段对齐、筛选多选、五处 aria 转义、英文文案、Python 帽 / 未入列 / 常量），52 个被断言击杀，存活 1 个是等价变异（`ml` 已滤掉 out=0 模型）。第二轮测试有效性复审针对修复提交做 76 个变异（58 杀 / 18 存活），存活项对应的缺口（输出合计非法、每模型段非法、无效条目占号、其余四处 aria 转义、月格 aria 英文、块体字号）已在跟进提交补锁。**周列/月列窄列与窄窗日历的真实数据复核尚未做**（本机真实快照的历史长度不够；窄窗只有合成夹具）。
