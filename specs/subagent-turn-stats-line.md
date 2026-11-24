# 子代理窗格回答末尾统计行（v458）

用户规格（2026-11-24）：子代理窗格（审查 A/B/C 这类 `sess_subagent_*` 会话的只读分栏）的回答结尾，也追加与主会话同款的确定性统计行（⚡ 速率/首字/输出/生成/累计/费用/时刻）。分两期一并实现：一期=完成态富文本注入；二期=占位行与会话均口径（结论：均由既有机制与回退白拿，无独立改动）。

## 背景与差距（2026-11-24 排查定案）

主会话统计行四环节链路 vs 子代理窗格：①数据 ✓（子会话 `model_usage` 行 `query_source='subagent'`，生成窗口有效）；②查库 ✗——`token_rate --current` 靠 prompt-submit hook 记录的提问时刻选轮，hook 只对用户发消息触发，子会话永远没有记录 → fail-closed 空输出；③请求方 ✗——det 链由 overlay 实例驱动，子代理窗格无实例（诊断 `insts` 只有 workspace-main）；④注入 ✗——同因。

**关键既有事实（本规格的地基，勿当新发明）**：
- `token_rate.scope_for` 对无 main_turn 行的会话**已有全量回退**（去掉 `query_source='main_turn'` 过滤）→ 子会话的会话均/累计/费用开箱即用。
- `token_rate` 身份三态 `explicitTurnId / promptTimeCompatibility / latestTurn`：不带 `--current` 即走 `latestTurn`（按 sid 取最新已完成轮）；v458 补齐 `latest_turn_id` 同款回退（原硬过滤 `main_turn` 使子会话 latestTurn 恒 None，实现时实证的真实缺口）。
- det 扫描（03 分片 `scanDeterministicLines`）是**全文档** 500ms 定时节拍（`sharedTick`），实例归属只是后置过滤（`detOwnerOf` 按 `detRoot()` 包含关系认领）。
- 子代理窗格根带 `[data-session-id]="sess_subagent_*"`（宿主属性，实机验证过）；窗格内的轮容器与主分栏同构（`section[data-turn-id]` / `[data-v4-turn-unit]`）。
- 子代理速率槽位系统（v179）已有 `__zusageAcquireConversationStore` 租约路径：后台子会话可显式 acquire。

## 产品规则

1. **伪 owner 观察器（03 分片 `zuSubDetPanes`）**：以 sid 为键为每个打开的子代理窗格建观察器，实现 det 链的 owner 接口——`getSid`/`getScope`（借存活实例的已验证本地 scope，workspacePath 同工作区、sid 换成子会话、identity/remoteSessionId 置空）/`detRoot`（窗格根，断连返 null）/`statsFor`（自有 tracker）/`isCurrentTurn`（快照最后 turnHeader）/'`bridgeInfo`（诊断）。`pid = "subagent-pane:<sid>"`（不得以 `selection-side-chat:` 开头——detOwnerToken/zuRichIdentity 对该前缀有侧聊特判）。
2. **生命周期**：观察器在 `sharedTick`（既有 500ms 节拍，**零新增定时器**）里发现/维持/清理——发现=窗格根在且含轮容器且未建；清理=根断连、tracker/store 换代（subscription 回调 sessionId 不符即置 dead）或主开关关闭。store 获取 `zuTryBindStore(sid)` 失败走 `zuAcquireSubStore(sid, {workspacePath})`（租约 refcount，dispose 时 off 释放）；获取失败 2s 后重试（同 subSlotReset 纪律）。远端会话的子代理不获取（`zuAcquireSubStore` 自拒）→ `statsFor` 恒 null → 不出行（既有 `!stats.complete` 门），远端不回归。
3. **detOwnerOf 接入**：观察器列表在实例列表之后按同一套包含/歧义规则认领（`best.contains` 链）；`detSeenKey`/`detStatsFor` 自动一致。watcher 的 root 与实例 root 不可能嵌套（子代理窗格是独立 SessionPane）。
4. **门控扩展（02 分片，两处各加一个 typeof 守卫的跨片调用）**：`zuFlushRichTextWants` 的 noInst 门与 `__zusageDeliverTurnText` 的 stale 门在 `instances.indexOf(owner) < 0` 之外放行「观察器仍在册」的 owner（`zuSubDetHasOwner(owner)`，03 分片函数声明提升可跨片调用；切片测试只装载 02 无 03 时守卫为 false 走原行为）。其余门（`zuRichIdentity` 本地 scope 校验、`isCurrentTurn` 只追活跃轮、`noSid`、24 次尝试上限、miss/stale 记账）一律不动——子代理行与主会话行同纪律。
5. **主桥（inject-main.cjs，唯一冷文件）**：`queryTurnText` 对 `sess_subagent_*` 前缀 sid **去掉 `--current`**（走 latestTurn），其余参数（cn/forceKmb/cost、15s 超时、原因标签）不变；`sess_dwf-*` 不在子代理前缀内自然排除。归属安全性：`--current` 严格门防的是同会话连发选错轮；子代理窗格 sid=窗格身份，最新完成轮即窗格最后一轮，无歧义。**Python 配套（token_rate.py，根与插件副本同源）**：`latest_turn_id` 对无 main_turn 行的会话回退全量行（与 `scope_for` 同语义、同会话内过滤），`--current` 路径不受影响（主会话有 main_turn 行不触发回退；prompt_ts 过滤仍只在显式传入时叠加）。
6. **注入与占位（既有机制白拿 + v458 补强）**：完成态先插 tracker 简化文案占位（`zuFinalText`，含「token/s(本轮)」标记，`isRateLine` 防模型复读双行），富文本到达后覆盖；真实零输出轮明示「本轮统计不可用」（v74）；历史轮/压缩轮/未观测轮不插（v86/v230）；主开关 `state.rateLine` 关闭时全量撤除（既有行为，覆盖子代理窗格）。**存量轮补强（2026-11-24 用户实证反馈后）**：观察器绑定前已完成的窗格轮，tracker 无记录会被 v86 未观测轮门挡死（实测 `turn-text` 零发出）——观察器 owner 对 `!stats` 轮走「纯富文本轮」旁路：缓存命中直接插行；未命中且该 box 是窗格最后一轮（`zuSubDetIsLastTurnBox` 纯 DOM 判据，不依赖快照 turnHeader）才发 latestTurn 查询，**不插占位**——deliver 空回执不写缓存，旧主桥降级时永不插行，绝不显示误导性的「本轮统计不可用」；富文本到达后下一拍插行，后续拍次由 v86 keep 分支自维持。02 分片 flush 的 `isCurrentTurn` 门对观察器 owner 短路（最后一轮判据在收集端；冷窗格快照无 turnHeader 时该门恒 false 不可用）。主会话实例不受任何影响（`zuSubDetHasOwner` 判否走原门）。
7. **会话均口径（二期结论：无独立改动）**：行内会话均来自 token_rate 自身聚合，`scope_for` 全量回退已覆盖子会话；选轮依赖的 `latest_turn_id` 回退见规则 5；zusage `_sess_rate` 的 `avg_tps=0` 结构性零值（滤 `subagent` 行）**不在本行链路上**、现无消费方受害，维持现状并在必要时另行立项。
8. **诊断**：`FATAL.det` 增加 `sub` 段（窗格数/已绑定数/租约失败重试数），回推失败仍走既有 `det.rt` 桶（watcher owner 的请求入队后与实例行同管道）。
9. **清理**：`cleanupDeterministic`（dispose/热更换代）释放全部观察器租约并清注册表；行节点在窗格 DOM 内随窗格生死，不跨窗格持有。
10. **远端与身份**：仅本地子会话（借到的 scope 无 remoteSessionId）；`zuRichIdentity` 对 watcher 的校验与实例同门（scope.sid===sid、identity/remoteSessionId 空才发证）。

## 验收场景

1. 打开运行中/已完成的子代理窗格 → 观察器建立（diag `sub.panes` 计数），完成轮末尾出现统计行（先占位后富文本），格式与主会话行一致；**观察器绑定前已完成的存量最后一轮**（tracker 无记录）经纯富文本轮旁路在富文本到达后出行，主桥未重启（仍带 --current）时该轮无行、不出「不可用」误导行（降级不破损）。
2. 子代理再跑新一轮 → 新轮完成追加新行，旧行保留（richKey 含 tid 不互踩）。
3. 关闭窗格/窗格被宿主回收 → 观察器释放租约（diag `sub` 归零）、行随窗格 DOM 消亡。
4. 远端会话的子代理 → 不绑定不出行，无报错。
5. 主开关关闭 → 子代理窗格统计行与主会话行一并撤除。
6. 冷文件：inject-main.cjs 旧版在位时，观察器照常发请求、主桥按 `--current` 查子会话返回空（empty 桶），行停留在 tracker 占位文案——降级不破损；完全重启后富文本到位。
7. Python：`token_rate.py --turn --session <子会话>`（无 --current）走 latestTurn（`latest_turn_id` 全量回退）+ `scope_for` 全量回退，行非空且会话均非 0（夹具库断言）；同会话带 `--current` 仍空输出（fail-closed 不回归）。
