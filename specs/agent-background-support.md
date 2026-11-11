# 智能体（agents）后台运行的状态同步规格

状态：已实现。宿主事实依据 3.18.x 源码；与 [workflow-support.md](workflow-support.md) 为姊妹特性（工作流 actor 与后台智能体的区分见彼处三向对比）。

## 1. 概念与数据事实

「智能体」= AgentProfile（`.zcode/agents/*.md` project/user 目录、内置 general-purpose/Explore、插件 agent）驱动的 Agent 工具子代理。**后台运行（`run_in_background` 或 profile `background:true`）不改变会话身份**：仍 `sess_subagent_agent_<uuid>`、`task_type='subagent_child'`、`query_source='subagent'`，与前台子代理在 DB 层完全同构——插件的子代理统计链（sub.list/明细/费用/今日/项目累计，v332 及之前口径）天然覆盖，零改动。

后台的差别只在生命周期面：注册 runtime task（`local_agent`）、父会话 subagent 行带 `backgrounded:true`、进行/完成态挂 wire `ConversationSnapshot.backgroundWorks`（数组，`kind` 闭集 `bash|subagent|workflow`，`status` 闭集 `running|resultPending|failed|cancelled`，`childSessionId` 可选）。

## 2. 口径（契约）

- 主格生成速度/会话均保持 main_turn 纯净：后台智能体（query_source='subagent'）不计入，与普通子代理一致。
- 实时估算槽位、行内 chip、子代理面板对后台智能体与前台子代理**无差别**呈现（`model_usage` 无后台列，展示等价）。

## 3. 窗口补给规则（核心修复）

插件的运行中子代理清单原以 turn-stats 透传的父会话 rows（尾部 60 行窗口）为唯一来源；后台智能体运行中用户继续对话会把启动行滚出窗口 → 槽位解绑、估算与「子代理运行中 ×N」计数丢失。规则：

- 消费侧（08 实例 updateLive）以桥 store 的 `snapshot.backgroundWorks` 补给：`kind==='subagent' && status==='running' && childSessionId` 的条目并入 `subRateTick` 输入集合（rows 行在前、补给追加、去重）。**槽位上限的取舍**：补给条目追加在尾部，`subRateTick` 仍从尾部取前 8（最新优先）——并发 >8 时后台智能体倾向优先获槽（它们正是滚出窗口、无法从会话流再获估算的那部分），会话流内仍有行内 chip 交代的前台子代理让位；该优先级是有意取舍。
- **主格合成态（v337）**：槽位存在（`subRate.slots` 有 want）而主会话自身无实时轮（stats 为空或已完成）时，`synthesizeBackgroundStats` 合成 `runningTool=Agent` 态，让速度格走既有子代理分支——槽位合计 3s 内有效显「子代理运行中 · 估 X t/s」×N，绑定中/思考期降级状态词，后台全部结束（槽位解绑）自动回落会话均。主会话自己的轮在跑时优先原 stats（v87 合成分支先行、工具/正文态不被覆盖）。
- `backgroundWorks` 是事件驱动 state 键、窗口无关；条目在结果投递后消失（status=`resultPending` 即已完成不计），由既有对账自然解绑槽位。
- `snapshot.subagents.running` 与 rows 同窗口派生，不作为补给源。

## 4. 状态面板速率 chip

宿主状态面板 Agents 分区行是后台智能体的主要运行态 UI：`[data-testid="v4-running-subagent-item"][data-child-session-id]`（e2e 锁定，`ConversationStatusPanel.tsx`）。规则：

- 行内注入 `.zu-substat` chip（不与 `.zu-subrate` 同类名，避免 subRate 开关的摘净选择器误伤状态面板）：槽位估算（3s 内）→「估 X t/s」；槽位在但无字符流 →「估算中…」；无槽位 → sub.list `tps_avg` 回填 →「X t/s」；全缺 →「运行中」。
- tooltip 复用 `subRowTipHTML` 数据包与 `subTip` 浮层，01 委托判定含 `.zu-substat`（零新增监听）。
- 开关：`state.show.subRate`（子代理速率族共用一个 ⚙ 开关）。
- 调用点=render 尾部 + heavy 600ms 对账，不上 100ms 心跳（热路径预算；数字延迟 ≤600ms）。
- 锚点为宿主 UI 内部 testid，漂移时查询零命中静默 no-op。

## 5. 验收场景

1. 派 `run_in_background` 后台智能体：状态面板行出现 `.zu-substat` 且估算跟手；子代理格计数含它。
2. 父会话继续对话把启动行滚出 60 行窗口：槽位、估算与计数不丢失（补给生效）；智能体完成后自动解绑。
3. ⚙ 关「子代理行内速率」：`.zu-substat` 摘净、tooltip 收起；重开自愈。
4. 完成后：子代理面板/费用明细含其用量（DB 链天然正确，无需迁移）。
