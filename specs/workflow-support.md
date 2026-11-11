# 工作流（dwfrun-*）支持规格

状态：已实现（与代码同步维护）。宿主事实依据 3.18.x 源码（`/Users/smzdm/Projects/AI/ZCode`）实测核对，锚点为宿主 UI 内部 testid，无跨版本兼容承诺。

## 1. 背景与数据通道

ZCode 动态工作流（`CreateWorkflow`，run id `dwfrun-<uuid>`）派生的子代理会话：

- 会话 id `sess_dwf-<runId>-<siteId>@<ordinal>`（宿主 `mintActorSessionId`），`session.parent_id` = 父会话、`directory` = 父工作区、`session.task_type = 'workflow_child'`；`model_usage.query_source = 'workflow_child'`。
- **插件 API 侧拿不到运行态**：rows 订阅对 `sess_dwf-*` 被项目树关卡拒绝（辅助会话不入 task index）；`workflowRuns` 状态键不经任何插件能力下发。故数据只有两条通道：
  - **sqlite**：`model_usage` 按 ask 完成落库（含 `duration_ms`/`time_to_first_token_ms`，可算真实速率）；`dwf_actor` 表（`session_id`、`site_id`、`name`、`resolved_model`）提供 actor 显示名。
  - **DOM**：会话流 run 卡 `[data-testid="workflow-card"]` 携带 `data-workflow-run-id`/`data-workflow-run-status`/`data-workflow-card-state`；卡内药丸带 `[data-agent-status]`。`dwfrun-<uuid>` 无 `_`，宿主 sanitize 折叠恒等，可直接 `sess_dwf-<runId>` 前缀匹配。

## 2. 口径（契约）

- **工作流子代理数据 = 完成态**：每 ask 结算落库后经泵 WAL 监听自动刷新；ask 进行中 token/速率不涨。运行/空闲状态由 run 卡 DOM 属性实时承载。
- **主格速度保持 main_turn 纯净**（v181 会话均契约不变）：`workflow_child` 行不进会话均、本轮速度、今日均速/耗时均值。今日/项目/近 N 天的 token 与请求数**本就计入**（时间窗聚合无 query_source 过滤），保持不变。
- **子代理口径纳入**：sub.list/会话明细/费用/速率聚合的 `query_source` 门扩为 `IN ('subagent','workflow_child')`——工作流子代理与普通子代理同池展示，`sub_kind` 字段区分（`"workflow"`/`"agent"`/`""`）。

## 3. 统计链归类规则（zusage.py）

- `sess_dwf-` 前缀会话是**子代理类**：不进 recent 池 normal 分桶（防挤占主会话 top-6），进子代理分桶；`is_sub` 为 true。
- 项目累计：既有 `parent_id is null` 主会话判定 + 一层 `parent_id in (mains)` 收集已正确归并（token 全额、速率分量 main_turn 过滤），不改。
- 任务名：`_sub_agent_tasks` 对 sess_dwf 键从 `dwf_actor.name` 反查（表缺失 fail-closed 跳过），兜底链 title → sid 尾段不变。

## 4. run 卡 chip（渲染端）

- 锚点 `[data-testid="workflow-card"][data-workflow-run-id]`，chip 类 `.zu-wfrun`，插在卡状态行附近，`__zuSig` 幂等；不满足渲染条件（run 失败且无 ask 落库、宿主摘掉状态属性）时摘除旧 chip 不留「运行中」残留。
- chip 面 = token 合计 + 聚合速率（sub.list 该 run 前缀行的 tps_out/tps_gen 分量 Σout ÷ (Σgen/1000)，即各 actor `sub_gen` 加权；无有效段不显速率）；尚无任何结算但卡在运行时显「运行中」。**chip 面不设状态点**，run 状态在悬停提示的状态行承载（随数据推送实时刷新）。
- tooltip 复用 body 级 `subTip` 浮层与既有 mouseover/mouseout 委托（判定加 `.zu-wfrun`，不新增监听）：run 状态（sig 变化时刻的 DOM 快照）、token 合计、聚合速率（口径行注明完成态）、actor 明细表（名字/token/速率；会话流内药丸不带 session id，无法按 actor 对应状态，见 §1）。
- 开关：`state.show.wfChip`（随 `zusage3.show` 整包持久化，⚙「工作流卡汇总」，缺省开），只门控 chip 展示。

## 5. 明确不做

- 不放开 `turn-stats.js`/02 分片的 `sess_subagent_` acquire 前缀门（宿主若未来投行，sess_dwf 空转占槽风险）；工作流 actor 无流式估算。
- 不加底部工具条 chip、不动 `inject-main.cjs`/`renderer_bridge.py`；CLI/MCP stdout 不改结构（sub 行仅增量字段 tps_out/tps_gen 与 is_sub/sub_kind，旧消费端按缺字段容错）。

## 6. 验收场景

1. 父会话工作流 run 卡出现 chip：token 随各 actor ask 完成逐步增长；运行中状态点实时。
2. 悬停 chip：actor 明细（名字来自 dwf_actor.name）、口径行「已完成段加权平均；运行中部分完成后计入」。
3. ⚙ 关闭 wfChip：chip 摘净、tooltip 收起；重开自愈。
4. CLI `zusage.py` current/池不再把 sess_dwf 当主会话候选；`session:<sid>` 明细的子代理段含工作流 actor。
5. 无工作流数据/旧宿主（无 dwf_* 表）：功能静默缺席，零报错。
