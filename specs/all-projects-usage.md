# 全部项目统计（项目累计 Tooltip 双范围）

状态：已实现（v331）。上游契约：`zusage._all_projects_usage` → 桌面快照顶层 `all_projects` → `buildProjectTipHTML` 双 Tab 渲染。

## 1. 背景与范围

项目累计 Tooltip 原先只有当前项目口径（`_project_usage`，身份=`session.project_id`+归一化目录）。本 spec 新增「全部项目」统计口径：**当前本地统计数据源中所有项目的累计**，含全局 KPI、按项目明细、按模型全局明细，与「当前项目」Tab 并存切换。

不扩展到：其它机器、其它宿主数据源、远端目标（远端分栏本来就没有项目格，全部项目 Tab 不可达）。与套餐额度链、本地 token 统计互相独立。

## 2. 数据链与门控

- `zusage._all_projects_usage(con)`：一次聚合产出 `{totals, projects, models}`（字段见 §4）。
- `zusage._all_projects_usage_safe(con)`：快照侧统一入口，捕获面与 `_speed_history_safe` 同款元组（sqlite3.Error/TypeError/ValueError/KeyError/IndexError/OverflowError/AttributeError）——查询失败、旧库缺列、无本地连接一律返回 None，失败只损失本帧该字段（水位缓存未命中下一帧自然重试），绝不拖垮整帧快照。
- `snapshot(..., include_all_projects=False)`：桌面快照链显式开启（`serve` 常驻 + `zusage json` 的 `ZUSAGE_REMOTE_CHILD != 1` 桌面帧，与 `include_speed_history` 同款门控），挂在快照顶层 `all_projects` 键。CLI 报表 / MCP / 远端子查询 stdout 契约**不带**该字段。
- 渲染端（`overlay.js`）只读 `state.data.all_projects`，缺字段显「全部项目统计暂不可用」，不借当前项目数据冒充。

## 3. 项目身份、归属与去重

- **归属单元=会话**：每条 completed `model_usage` 行经其 `session_id` 归属到唯一项目，全程只计一次。
- **根归属**：派生会话（`parent_id` 非空或 `sess_subagent` 前缀）沿 `parent_id` 链上行到根主会话，取根会话的项目身份（**跨代全收**——与「当前项目」Tab 的 `_project_usage` 只收主会话+直系一层不同，同项目数值在两 Tab 间可感知略有差异属口径差异非缺陷）；带环守卫（visited 集，仅保证终止——环是宿主数据损坏，归属可能错位但账本恒成立）与缺失父回退（父不在会话表按自身身份）。orphan 子代理（父缺失）按自身 project_id/directory 归属，不丢弃。
- **项目键**=`(project_id, _norm_path_key(directory))`，与 `_project_usage` 的 issue #248 语义一致：同 project_id 不同归一化目录（CJK slug 碰撞、worktree）是不同项目；同目录同 project_id 是同一项目。
- **未归属桶**：根会话 `project_id` 为空（**含带目录的**——目录不足以安全归属，宿主正常会话恒有 project_id）或 `model_usage.session_id` 不在会话表（会话已删）的请求，**全部并入单一** `unattributed: true` 伪项目条目（不按目录拆多桶，渲染端恒至多一行「未归属项目」），保证 `totals == Σ projects` 对账恒成立。绝不并入任何具名项目。
- **去重保证**：会话级 SQL `group by session_id` + Python 侧按会话归属分桶，天然无重复；同名 turn_id 跨会话各计一轮（同 `_project_usage` 口径）；failed/error 行不计（`status='completed'`）。

## 4. 聚合口径（与单项目卡逐项同源）

totals 字段名与 `project` 行完全一致（sessions/turns/requests/input/output/reasoning/cache_read/cache_write/total/tool_calls/retries/started/last_at/avg_duration_ms/avg_ttft_ms/duration_ms/avg_tps/name/models/cost_usd），另加 `projects` 列表：

- 总用量=Σ`computed_total_tokens`；输入=Σ`input_tokens`（已含 cache_read）、输出=Σ`output_tokens`（已含思考），不重复相加。
- 缓存命中率=Σcache_read / Σinput；「含缓存」显示值=Σ`cache_read` 原值（命中率分子同口径）。
- 平均耗时/平均延迟：>0 样本均值（`duration_ms>0` / `time_to_first_token_ms>0`），非各项目均值再平均。
- 总耗时=Σ`duration_ms`（全部 completed 行）。
- 平均输出速度=Σ有效输出 ÷ Σ有效生成窗口（`_row_gen_ms` + `_turn_rate` 分量按会话累加，跨项目可加和）；`_provider_first_token_covers` 同源。
- 预估费用：按 (model_id, provider_id) 分组经 `token_pricing.merge_model_costs` 计价；全局与各项目分组同源拆分，价表缺失/失败整体 None；未知价不冒充 0。
- 模型明细：`{model, requests, total, cost_usd, rates?}` 按 total 降序，模型名大小写归一（`_canon_model_name`）。
- `projects` 条目：`{name, directory, unattributed?, total, requests, cost_usd}`，total 降序（同值按名称、目录二级键稳定排序）；`name`=目录末段（正反斜杠归一），未归属桶无 name；列表上限 500 条，超出置 `projects_truncated: true` 并附 `projects_total`（截断前真实项目数，明细表提示用；totals 仍为全量真值）。
- 时间范围：全部有效行 min(started_at) → max(completed_at)。

## 5. 缓存与性能

- 复用 `_cached_project`（库文件身份键 + `(“__all_projects__”,)` 键 + `_AGG_TTL_MS` 2s TTL + `_wm_alive` 水位续用）：仅新请求落库（水位变化）或超 `_WM_MAX_AGE_MS`（20s）才重算；内存库不缓存就地聚合。
- 实测量级（2026-11-11，真实 2.6GB 库 6.2 万请求行）：全量聚合 ~212ms/次、载荷 ~6KB（16 项目 48 模型组）；水位未变帧零开销。
- 四条有界 SQL（会话表全扫、会话级分组、会话×模型×provider 分组、速率行扫描）+ Python 分桶，无 N+1。

## 6. 渲染契约（项目累计 Tooltip）

- 头部：标题「项目累计」+ 右侧双 Tab `[当前项目][全部项目]`（role=tablist/tab、aria-selected、键盘可操作）；**删除**「全部请求 · 含子代理」胶囊与独立范围行。当前项目名（pname）仅当前项目模式显示。
- Tab 态：实例级 `projTipScope`（"cur"|"all"），归属键变化（pickedSid/项目变化）重置为 cur；数据刷新不重置。切换走 pointerdown 委托同步重建（v276 纪律：禁 rAF），click 兜底键盘 Enter；`.zu-pj-tab` 进入 mousedown preventDefault 名单与 1.2s 硬保活覆盖。
- 当前项目模式：结构不变（四行 KPI → 模型明细 → 时间范围），**新增**输入格「含缓存 XX」辅助行（`cache_read` 原值，次级灰、同「含思考」层级）；不渲染项目明细。
- 全部项目模式：同款四行 KPI（数据源=`all_projects` totals）→ **项目明细表**（模型明细之前，分隔线隔开）→ 模型明细（全局）→ 时间范围（全局起止）。当前项目名不显示。
- 项目明细表：四列（**首列即分区名「项目明细」**——v331 用户规格：独立标题行删除，分区名并入首列表头；左对齐 ellipsis+title 全名/目录、Token 用量↓、请求次数、预估费用右对齐），复用 `.zu-pj-table`；默认前 5，「查看全部 N 个项目」/「收起」展开态独立于模型明细（`projTipProjExpanded` ≠ `projTipExpanded`）；≥500 截断时表格上方出右对齐注记行（`.zu-pj-mnote`，仅截断时渲染）。空列表显「暂无项目数据」，不渲染空表头。
- 模型明细表：同规格——首列 th=「模型明细」，独立标题行删除；「工具调用 N 次 · 重试 N 次」注记保留为右对齐 note 行（有值才渲染，无值的「按用量排序」占位一并删除）。
- 数据缺失（旧主进程/旧 Python 帧）：全部项目 Tab 可点，卡片显示「全部项目统计暂不可用」中性提示，当前项目模式不受影响。**统计卡家族「悬停中不重画」契约适用**：悬停中数据到达不会自动翻新该卡（render 只更新格上 `__tip` 串，可见卡重画仅 pill 主题 mousemove 与接管分支承担），收起重开即见新数据；tipSig 幂等只作用于下一次 drawTip。
- 输入格「含缓存」两模式同规则：`cache_read>0` 才渲染，不反推、不重复计入。
- 费用链复用 v202：`state.cost` 关时 KPI 费用格与两表费用列整体不渲染；fxq 计价范围气泡在全部项目模式读全局 models 上下文。

## 7. 测试锁定

- Python：`tests/test_all_projects_usage.py`（归属/去重/碰撞/未归属/口径/缓存/门控），夹具沿 `test_project_usage.py`。
- Node：`tests/overlay-project-tip.test.cjs` 扩展（双 Tab、含缓存、项目明细、独立展开、缺数据降级、转义、费用门控）；`overlay-tooltip-span.test.cjs` 的胶囊断言随契约更新。
