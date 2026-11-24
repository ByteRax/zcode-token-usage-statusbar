# 子代理窗格回答末尾统计行（v458）

用户规格（2026-11-24）：子代理窗格（审查 A/B/C 这类 `sess_subagent_*` 会话的只读分栏）的回答结尾，也追加与主会话同款的确定性统计行（⚡ 速率/首字/输出/生成/累计/费用/时刻）。分两期一并实现：一期=完成态富文本注入；二期=占位行与会话均口径（结论：均由既有机制与回退白拿，无独立改动）。

## 背景与差距（2026-11-24 排查定案）

主会话统计行四环节链路 vs 子代理窗格：①数据 ✓（子会话 `model_usage` 行 `query_source='subagent'`，生成窗口有效）；②查库 ✗——`token_rate --current` 靠 prompt-submit hook 记录的提问时刻选轮，hook 只对用户发消息触发，子会话永远没有记录 → fail-closed 空输出；③请求方 ✗——det 链由 overlay 实例驱动，子代理窗格无实例（诊断 `insts` 只有 workspace-main）；④注入 ✗——同因。

**关键既有事实（本规格的地基，勿当新发明）**：
- `token_rate.scope_for` 对无 main_turn 行的会话**已有全量回退**（去掉 `query_source='main_turn'` 过滤）→ 子会话的会话均/累计/费用开箱即用。
- `token_rate` 身份三态 `explicitTurnId / promptTimeCompatibility / latestTurn`：不带 `--current` 即走 `latestTurn`（按 sid 取 `started_at` 最新的那一轮，**不判该轮是否结束**）；v458 补齐 `latest_turn_id` 同款回退（原硬过滤 `main_turn` 使子会话 latestTurn 恒 None，实现时实证的真实缺口）。
- det 扫描（03 分片 `scanDeterministicLines`）是**全文档** 500ms 定时节拍（`sharedTick`），实例归属只是后置过滤（`detOwnerOf` 按 `detRoot()` 包含关系认领）。
- 子代理窗格根带 `[data-session-id]="sess_subagent_*"`（宿主属性，实机验证过）；窗格内的轮容器与主分栏同构（`section[data-turn-id]` / `[data-v4-turn-unit]`）。
- 子代理速率槽位系统（v179）已有 `__zusageAcquireConversationStore` 租约路径：后台子会话可显式 acquire。

**取数身份的真库事实（2026-11-25 实测，本规格「按轮号取数」的依据）**：
- 页面轮容器的 `data-turn-id` 与用量库的 `model_usage.turn_id` **不是同一套 id**（主会话页面 20 个轮号与库内 30 个 turn_id 零命中）。
- 页面轮号就是宿主写在每条用量行上的 `model_usage.parent_user_message_id`（主会话 19 个命中、子代理会话 39360 行全有；全库 92020 行去重 4007 个轮号，长度全是 49、全部以 `msg` 开头、以 `-` 开头的 0 行）。同一会话内一个页面轮号只对应一个 `turn_id`（子代理会话实测无一对多；反过来一轮多行各带不同页面轮号是有的，所以先由轮号定 `turn_id`、再按 `turn_id` 取整轮）。
- `turn_usage` 的行在轮结束时才写：正在跑的轮没有行，已结束的轮有行且 `status` 只有 `completed / cancelled / error`（子代理会话 1493 轮里 1492 轮有行）。`model_usage` 只在请求结束时写行，库本身无法判断一轮是否还在进行。

## 产品规则

1. **伪 owner 观察器（03 分片 `zuSubDetPanes`）**：以 sid 为键为每个打开的子代理窗格建观察器，实现 det 链的 owner 接口——`getSid`/`getScope`/`detRoot`（窗格根，断连返 null）/`statsFor`（自有 tracker）/`isCurrentTurn`（快照最后 turnHeader）/`bridgeInfo`（诊断）。`pid = "subagent-pane:<sid>"`（不得以 `selection-side-chat:` 开头——detOwnerToken/zuRichIdentity 对该前缀有侧聊特判）。
2. **身份取窗格自身（`zuSubDetPaneScope(root)`，不借本地实例的身份）**：桥写在会话根上的 scope 属性（`data-zusage-scope-version="1"` 与 `workspace-path` / `workspace-identity` / `remote-session-id`，`renderer_bridge.py` 的 `pane_attributes`，与 `readPaneScope` 同一来源）标为**远端或带工作区身份**的窗格一律不认领——本地与 SSH 远端分栏同窗时，远端子代理窗格若借本地身份会去查本地库（issue #40 的 fail-closed）。校验范围比 `readPaneScope` 少一项：**不核对 paneId**（观察器没有宿主 pane 身份可比；这些属性与 `data-session-id` 写在同一节点上，读到的就是窗格自己的）。桥缺席（表外宿主 / 补装失败）时的退路：仅当本窗口**每一个** overlay 实例的 scope 都是已验证的本地 scope、且同属一个工作区时才认领（用其 workspacePath）；有远端实例、任何一个实例 scope 不明、实例分属多个本地工作区（分不清窗格属于哪一个）或没有任何实例，都不认领。退路只看得见 overlay 实例，没有实例的远端分栏识别不了（见已知限制）。
3. **生命周期**：观察器在 `sharedTick`（既有 500ms 节拍，**零新增定时器**）里维持/清理——发现走 `detOwnerOf` 的无归属回退（零新增文档级查询）；清理=根断连、订阅回调收到别的会话的快照（store 换代成别的会话）即整观察器撤除、主开关关闭、换代清理；store 失效（`getState()` 返 null）本身不触发回调（`subscribeStore` 只在 tracker 吃进快照时才调回调），观察器冻结不重绑，见已知限制。store 获取：`zuTryBindStore(sid, 窗格 scope)` 按本地键**精确**直绑（不带 `want` 会命中同 sid 的远端 store），失败走 `zuAcquireSubStore(sid, 窗格 scope)`（租约 refcount，dispose 时 off 释放）；获取失败 2s 后重试（同 subSlotReset 纪律）。`TURN_STATS.subscribeStore` 会同步先跑一次回调（它只在 tracker 吃进快照时才调回调：首帧是空快照时回调不触发，观察器照常入册等后续帧），而首绑时这一拍观察器尚未入册：首跑推的是**别的会话**的快照时按**绑定失败**处理——刚拿到的订阅、租约与 tracker 当场放掉，观察器留在册 2s 后重试，不带着别的会话的 store 入册；订阅时抛异常、拿不到退订函数同样处理。绑定过程**永不抛**（它跑在扫描与 sharedTick 两条周期路径上，抛了会打断主会话的扫描）。绑不上时的 2 秒重试每次都会让桥注册表做一轮快照拷贝（`zuTryBindStore` 调 `diag()`），与子代理速率槽位的重试同一纪律；同时开着多个一直绑不上的窗格时开销叠加（未量测）。
4. **detOwnerOf 接入**：观察器在实例列表之后按同一套包含规则认领（`subRoot.contains(box)`）；`detSeenKey`/`detStatsFor` 自动一致。窗格根与实例 root 不嵌套（子代理窗格是独立 SessionPane）。
5. **门控扩展（02 分片，`zuSubDetHasOwner` 跨片调用、调用方 typeof 守卫）**：`zuFlushRichTextWants` 的 noInst 门、isCurrentTurn 门与 `__zusageDeliverTurnText` 的 stale 门对「观察器仍在册」的 owner 放行（切片测试只装载 02 无 03 时守卫为 false 走原行为）。isCurrentTurn 门对观察器放行的理由：存量轮没有 tracker 记录，`activeTid` 判不了它；「只发窗格最后一轮」的限定改由收集端的纯 DOM 判据承担（规则 7）。其余门（`zuRichIdentity` 本地 scope 校验、`noSid`、24 次尝试上限、miss/stale 记账、15s 超时）对观察器与实例同纪律。
6. **按页面轮号取数（主桥 inject-main.cjs 是唯一冷文件；token_rate.py 根与插件副本同源）**：观察器 owner 的富文本请求带 `turnRef`（窗格里这一轮的 `data-turn-id`）。子代理 sid 的形状约束是 `^sess_subagent_[A-Za-z0-9_-]{1,72}$`，渲染端（`zuSubDetEnsure`，不匹配就不建观察器）与主桥同一边界。主桥 `queryTurnText` 对该形状的 sid 且 `turnRef` 合法（`^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$`，两端同一条规则）时走 `token_rate --turn --turn-ref <轮号> --session <sid>`；轮号格式两端同一条规则：首字符不能是 `-`，只许字母、数字、下划线、连字符，至多 80 字符（Python 用 `fullmatch`，不放过结尾换行）；首字符禁 `-` 是因为命令行按「--名字 值」解析，以 `-` 开头的值会被当成另一个开关（`--json` 还会同时被当成输出开关），真库轮号恒为 `msg_` 开头所以无损。格式不合法的轮号按 fail-closed 处理。`token_rate` 先由轮号定 `turn_id`（该会话内必须恰好一轮，`turn_id_for_ref`），再要求 `turn_usage` 已有该轮终态行（`turn_ended`：`status` 为 completed / cancelled / error，宿主若改成轮开始就写行则同样判未结束），两条都满足才按 `turn_id` 取整轮；否则空输出（`--json` 下未结束的轮带 `turnPending:true`），渲染端按既有节奏重试。`--turn-ref` 与 `--current` / `--turn-id` 同给、或 `--turn-ref` 后面没有值，都按 fail-closed 处理（空输出，不落到「最新一轮」）。**不这么做的后果**（审查实证）：按会话取「最新一轮」分不清窗格里这一行属于哪一轮——该轮还在进行或库还没追上时「最新一轮」是上一轮，上一轮的富文本会被挂到这一轮下面并永久缓存；进行中的轮还会取到半截统计。取消或出错的轮只要 `turn_usage` 有终态行就照常出数（已结束，不是只在跑）。没有 `turnRef` 的子代理 sid（旧渲染端不发子代理请求）与 `sess_dwf-*` 等其余 sid 一律维持 `--current` 口径。
7. **注入与占位（既有机制 + 存量轮旁路）**：tracker 有完成记录的轮走既有路径——先插 tracker 简化文案占位（`zuFinalText`，含「token/s(本轮)」标记，`isRateLine` 防模型复读双行），富文本到达后覆盖；进行中的轮不发请求、不插行；真实零输出轮明示「本轮统计不可用」（v74）；压缩轮不插（v230）；模型切换 marker 不撤行。**存量轮旁路（2026-11-24 用户实证反馈后）**：观察器绑定前已完成、tracker 无记录的窗格轮（典型是轮头已滑出 60 行窗口的长轮）走「纯富文本轮」：缓存命中直接插行；未命中且该 box 是窗格最后一轮（`zuSubDetIsLastTurnBox` 纯 DOM 判据，按已渲染的轮容器算，见已知限制）才发请求，**不插占位**——空回执不写缓存，轮没结束、库没追上或旧主桥在位时永不插行，绝不显示误导性的「本轮统计不可用」。富文本到达后下一拍插行，后续拍次由 v86 keep 分支自维持。窗格里同一轮有多个容器（嵌套单元或宿主重复渲染）时取到的都是这一轮的整轮统计，同 owner 内按 tid 去重（v174），不拆分、不重复插行。旁路的代价：每个还没拿到富文本的存量轮容器，每拍（500ms）会对窗格根做一次 `querySelectorAll("[data-turn-id]")` 子树查询（窗格级，不是文档级），24 次上限用完之后仍然每拍执行。主会话实例不受影响（`zuSubDetHasOwner` 判否走原路径）。
8. **会话均口径（二期结论：无独立改动）**：行内会话均来自 token_rate 自身聚合，`scope_for` 全量回退已覆盖子会话；zusage `_sess_rate` 的 `avg_tps=0` 结构性零值（滤 `subagent` 行）**不在本行链路上**、现无消费方受害，维持现状并在必要时另行立项。
9. **命令行直接查子会话（不经过渲染端）**：`token_rate.py --turn --session <子会话>` 走 latestTurn，`latest_turn_id` 对无 main_turn 行的会话回退「除压缩请求外的全部行」（宿主给压缩行的 `turn_id` 独立时不会被选成最新一轮；`query_source` 为空的行照常参与）；「有没有 main_turn 行」的探测只看被查询的会话，探测失败时保持 `main_turn` 过滤（宁可查不到也不放宽）。回退**只在不带提问时刻的查询上生效**：`--current` 路径（prompt_ts 非空）的选轮与改动前一致，仍只认 main_turn——没有 main_turn 行的会话即使带着提问状态记录也是空输出（主会话有 main_turn 行，本就不触发回退）；`--current` 空结果的原因分类（`--json` 的 `currentTurnUnavailableReason`）同样关掉回退，`--current` 路径的输出与改动前一致。
10. **诊断**：`FATAL.det.sub = { panes, bound, retrying }`（窗格数 / 已绑定 store 数 / 等重试数）；回推失败仍走既有 `det.rt` 桶。
11. **清理**：`cleanupDeterministic`（dispose/热更换代）与主开关关闭那一拍（`scanDeterministicLines` 的关闭分支）都调用 `zuSubDetDisposeAll()`，释放全部租约并清注册表；行节点在窗格 DOM 内随窗格生死，不跨窗格持有。
12. **远端与身份**：只认本地子会话（规则 2）；`zuRichIdentity` 对观察器与实例同门（scope.sid===sid、identity/remoteSessionId 空才发证）。

## 已知限制（都是 fail-closed：不出行，不出错行）

- 存量轮（tracker 无记录的轮）走旁路时按轮键计 24 次请求上限（约 12 秒，与既有路径共用同一份计数）：这期间轮没结束或库没追上，就不再请求，该轮不出行。落到这里的有：轮头已滑出快照窗口的长轮；观察器始终绑不上 store 时（旧桥没有 acquire，或注册表里没有这个会话）的全部轮。上限被旁路耗尽后，即使 tracker 记录后来到位，这一轮也停在简化占位、不再请求富文本。
- `turn_usage` 缺行的轮（真库 1493 轮里 1 轮）或库没有 `parent_user_message_id` 列 / `turn_usage` 表：不出行。
- store 中途失效而窗格根还在时，观察器不会重绑（tracker 冻结）：失效之后才开始的轮次经存量轮旁路仍按轮号出正确的行；失效瞬间正在跑的那一轮不行——它的 tracker 记录冻结在「进行中」，既进不了旁路也没有完成记录，窗格根卸载或热更新之前永不出行。
- 同一个子代理会话同时开两个窗格：观察器按 sid 幂等，只跟先发现的根；另一个根里的轮容器无归属，不出行。
- 宿主重挂窗格根后观察器重建，已缓存的富文本随 owner 令牌失效：有 tracker 记录的轮重新占位、重新请求；存量轮不插占位，只重新请求，富文本到达后才出行。
- 存量轮的请求拿到空回执（当时轮没结束或库没追上），之后窗格里出现了新一轮：它不再是最后一轮，不会再被请求，该轮不出行（富文本若在这之后才到，仍只插在它自己下面，数字是它自己的）。
- 窗格内容是虚拟列表时，「窗格最后一轮」按**已渲染**的轮容器判定（规则 7）：真正的最后一轮被滚出 DOM、或最新几轮还没渲染出来时，判据会落到已渲染的最后一个轮容器上——那一轮（存量轮）也会被请求、出自己的行，数字是它自己的，不会出现别的轮的数字；滚回来之后新成为最后一轮的轮容器照常处理。
- 桥缺席且同窗口里有「没有 overlay 实例的远端分栏」时，退路可能把远端子代理窗格当本地处理：本地库没有该会话，不出行；桥在位时（规则 2 主路径）不受影响。

## 验收场景

1. 打开运行中/已完成的子代理窗格 → 观察器建立（diag `sub.panes` 计数），tracker 有完成记录的轮末尾出现统计行（先占位后富文本），格式与主会话行一致；进行中的轮不出行。
2. 观察器绑定前已完成的存量最后一轮（tracker 无记录）经纯富文本轮旁路在富文本到达后出行；非最后一轮的存量轮不发请求、不出行（「最后一轮」按已渲染的轮容器算）；富文本到达前不插任何行。
3. 取数只认这一轮：两轮的窗格里，请求带最后一轮的页面轮号；该轮没有 `turn_usage` 行（进行中）或该行状态不是终态、轮号在库里对不上或对上多轮、主桥未重启（仍按 `--current` 查子会话）时都是空回执，不写缓存、任何轮都不插行，也不出现上一轮的数字。
4. 子代理再跑新一轮 → 新轮完成追加新行，旧行保留（richKey 含 tid 不互踩）。
5. 关闭窗格/窗格被宿主回收 → 观察器释放租约（diag `sub` 归零）、行随窗格 DOM 消亡。
6. 远端或带工作区身份的子代理窗格 → 不认领、不绑 store、不取租约、不出行；桥缺席时，同窗口只要有远端实例、scope 不明的实例、分属多个本地工作区的实例或没有任何实例，就不认领（没有 overlay 实例的远端分栏识别不了，见已知限制）。
7. 主开关关闭 → 子代理窗格统计行与主会话行一并撤除，观察器租约与订阅一并释放；开关重开后重新发现。
8. 主会话实例不受影响：`zuSubDetHasOwner` 只对注册表里的观察器为真；实例的历史轮照旧被 `isCurrentTurn` 门拦下（不发请求、记 `notCur`），实例 root 里没有 tracker 记录的存量轮不走观察器旁路（不发请求、不插行）。
9. 换代清理（热更新 / dispose）→ 在册观察器的租约全部释放。
10. 冷文件：inject-main.cjs 旧版在位时，观察器照常发请求，旧主桥忽略 `turnRef`、按 `--current` 查子会话返回空（empty 桶），有 tracker 记录的轮停在占位文案、存量轮无行——降级不破损；完全重启后富文本到位。
11. Python：`--turn --turn-ref <轮号> --session <子会话>` 只出该轮的行（会话均/累计走 `scope_for` 全量回退，非 0），取消或出错的轮只要有终态行照常出数；`--turn-ref` 后面没有值、轮号以 `-` 开头（库里真有这样一个已结束的轮也不出数）、与 `--current` / `--turn-id` 同给、库文件不存在、`turn_usage` 有行但状态不是终态，都是空输出；没有 main_turn 行的会话带提问状态查 `--current --json`，原因字段与改动前一致（`missingTurnIdentity`）；`--turn --session <子会话>` 走 latestTurn（回退排除压缩行）；`--current` 对子会话仍空输出；有 main_turn 行的会话即使有更晚的非 main_turn 行也只认 main_turn，探测失败同样只认 main_turn。
