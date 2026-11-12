# 宿主卡顿治理（流式 / 空闲 / 数据链）

用户反馈安装本插件后 ZCode 卡顿。本规格只治理**计算与推送频率**，不改变任何展示口径、数值、文案和交互。

## 证据（2026-11-10；CDP 采样 + Precise Coverage + Node/Python 微基准；本机 2.5GB 库、1388 轮历史）

- 流式生成时，`turn-stats.js` 的 `ingest` 在**宿主 store 通知链内同步执行**，每次通知对窗口内全部文本做 `Array.from(text).length`（整串拆数组）：单次 0.35ms（20 行）→ 2.2ms（60 行 / 20k 流式字符）→ 4.1ms（60k），并产生大量 GC（采样里 GC 占主线程 12%）。
- `updateLive` 快路径在每次心跳（100ms）与每次 store 通知都调 `buildLiveTip`，整张 V2 速度 tooltip 串重新生成，**无人悬停也生成**；其中 `spdUnpack` 每次全量解包整张轮表：1400 轮 1.3ms、6000 轮 5.3ms（占生成成本 95%）。覆盖率计数：部署前 `buildLiveTip` ≈ 20 次/s、`spdNum` ≈ 22 万次/s。
- 历史（非 live）会话的 `updateLive` 每个心跳都落到整条 `render()`：急切构建全部 tooltip 串并跑五个 enhance*（单次约 8~20ms）。
- 轮播主开关默认关闭，但 65ms 定时器仍在做遗留 DOM 还原的两次整文档查询（~30 次/s）。
- Python 常驻泵每帧：命中帧 ~200ms、未命中帧 700~1100ms，**两者每 ~3s 交替**（TTL 2s < 泵间隔）。流式期间 `model_usage` 实际恒定不变（宿主请求完成才一次性 INSERT），重算纯属浪费；耗时大头是 `_project_usage`（~150ms×多键）、`_speed_history`（~150ms）、今日三查询与全库 scan。
- 宿主窗口被遮挡/隐藏（`visibilityState=hidden`）时 Chromium 把定时器降到 ≈1Hz、rAF 停发：此状态下的度量会把前台成本低估约一个数量级，度量前必须先核对可见性。
- **长会话的桥读取（issue #309，2026-11-12；读码 + 本机 CDP 只读 + 离线基准，报告者 Windows 实测另计）**：宿主 store 窗口不是固定尾部 60 行——本机真实宿主里 4 个轮次的会话 `rows.window` 就有 374 行，报告者 2289 轮会话为 6868 行。静态桥 v2 的 `getState()` 每次返回**整窗深拷贝并冻结**（`zuSnapshot`；本机 CDP 实测同一包装连读两次引用不同，`sameRefOnReread:false`），成本随窗口线性增长：本机真实宿主 374 行 ≈ 1.0ms；离线用真实 `zuSnapshot` + `turn-stats.js` 合成 6867 行，拷贝 16–61ms（随每行字段数）+ `ingest` 6–8ms；报告者 86.55ms/次。而 100ms 心跳里 `bridgeTick` 健康检查与 `updateLive → subRunningList` **每拍各读一次**（无 stats 时「思考中」合成再读一次），每次 store 通知还有 `subscribeStore.update` 与 overlay 回调各读一次——v2 桥下 ≥20 次整窗拷贝/秒，6868 行窗口主线程被占满（报告者 frameP50 120ms，长任务 96–172ms 几乎全是 `TimerHandler:setInterval`；关闭 `answer_rate_line` 使桥解绑后 13ms、0 长任务）。v3 桥（按底层引用缓存）让两次心跳读取变成命中，但 1.5.17 用户与「已热更 overlay、尚未重启客户端」的窗口期仍是 v2 桥，且通知路径每次状态变化仍有一次整窗拷贝，所以 overlay 侧必须**与桥代际无关**地去掉冗余读取并给通知路径封顶。
- **修复前后对照（离线，真实 `turn-stats.js` + 真实 v2 `zuSnapshot` 深拷贝 + 真实定时器与时钟；6867 行 / 2289 轮；脚本不入库，口径见下）**：按 overlay 的消费方式建模——旧=心跳每拍读 store 2 次、每次通知读 2 次；新=心跳读 handle 记录（2s 回源 1 次）、每次通知读 1 次并受规则 12 预算约束。 空闲（仅心跳）整窗读取 19.5→0.3 次/s、拷贝耗时 293→7 ms/s；5Hz 流式 33.8→3.8 次/s、467→67 ms/s；**10Hz 流式 48.8→4.0 次/s、677→68 ms/s（≈6.8%，落在规则 12 的 ≤~10% 上界内）**，事件循环最大延迟 84→26 ms。 注意 `mainThreadBusyPct` 含基准进程自身构造数据与 GC 的开销，绝对值偏高，只看相对变化。**度量陷阱**：overlay VM 夹具把 `performance.now` 换成不随真实耗时前进的假时钟，夹具内 `subscribeStore` 测得的处理耗时恒为 0，规则 12 的预算永不触发——在夹具里直接统计读取次数会得到“修后仍每通知一读”的假象；预算只能用注入时钟的单测（`turn-stats.test.cjs`）或真实时钟的基准验证。 **本机真实宿主上未做修复后的实测**（本机无已注册的大窗口流式会话；报告者 Windows 环境的修后数据待其反馈）。

## 产品规则（不变量）

> 编号约定：代码注释与测试里的「§N」指本节「产品规则 N」；验收场景用「验收 N」。

1. **展示不变**：tooltip / chip / 统计行的数值与格式逐字不变；悬停中 tooltip 仍 ≤100ms 跟手，打开瞬间内容必须是最新的（不得陈旧）。
2. **字符计数等价**：`ingest` 的字符数与原 `Array.from(text).length`（码点计数；高低代理对记 1，孤立代理项各记 1）逐值相同。
3. **轮表解包按引用缓存**：同一份 `speed_history` 对象重复 `spdUnpack` 只解包一次（WeakMap，随帧对象回收）；新帧是新对象自然失效；结果只读。
4. **未悬停不白建 tooltip**：实时速度 chip 所在格未悬停时，`updateLive` 不再每拍构建 tooltip 串，只记最新 view 并标失鲜（`__zuTipStale`）；`drawTip` 读取 `__tip` 前经 `liveTipRefresh` 补建；兜底每 1s 保鲜一次；悬停本格仍每拍构建并重画（v224 契约）；整条 `render` 重挂 `__tip` 时清失鲜标记。
5. **store 通知保持同步（廉价会话）**：store 驱动的 `updateLive` 在单次通知处理成本低时**不做合并/延迟**（曾试做 80ms 合并，测试与语义均依赖通知后同步更新状态条，已撤销；懒构建之后每次 `updateLive` 只剩微秒级工作，合并无必要）。**例外见规则 12**：该前提只对廉价会话成立——长会话每次通知含一次 O(window) 的桥拷贝与 `ingest`，仅当实测成本达到 `BUDGET_MIN_COST_MS` 才按成本自适应合并，其余会话行为逐字不变。
6. **空闲整条重渲染降频**：非 live 会话（`view` 为 null 且上一拍也非 live）且数据帧引用未变、距上次整条渲染不足 500ms 时，心跳不重复 `render`；数据帧变化、live↔非 live 切换、设置/主题变化（它们直接调 `render`）仍即时。
7. **轮播关闭态**：`rotatorCfg.enabled` 为假时，65ms 定时器的帧步降到 1s 一次（只剩遗留 DOM 还原）；开启或设置变更走 `rotatorMasterTick` 直调，不经此节流。
8. **model_usage 水位延长聚合缓存（Python）**：`_cached_agg`（scan / 今日三项）、`_cached_project`、`_speed_history_cached` 在 TTL(2s) 过期后，若水位 `(库身份, max(rowid))` 未变且距上次计算 <20s（`_WM_MAX_AGE_MS`），继续复用；水位一变（有新请求完成）立即重算。TTL 内行为不变；水位在**计算前**读取（计算期间的新写入只会使存下的水位偏旧→下次重算，安全方向）；内存库/桩连接/未带连接的调用取不到水位，退回纯 TTL。`_cached_agg` 保持 `(key, fn)` 二参签名，连接经 `_WmFn` 包装携带。
   **前提假设（宿主升级体检须复核）**：宿主只在请求结束时一次性插入终态行（completed/error/cancelled），不先写 `running` 再 UPDATE（宿主 `recordModelUsageFact` 与真库实测零 `running` 行）。水位对 in-place UPDATE、非尾行删除（含 session 级联删除）、尾行删除后 rowid 复用不可见——这些情形下陈旧上限即 `_WM_MAX_AGE_MS`；若宿主将来改成「先写 running 再 UPDATE」，「完成瞬间不陈旧」会退化为最多 20s。未加 `count(*)`：大表 O(n)（30 万行约 1ms，对比水位查询 ~7µs），且仍抓不到 in-place UPDATE。依赖 `session` 表的字段（会话名、项目名）与价表 12h 刷新带来的费用同样最长陈旧 20s，无 AGENTS 契约承诺它们实时。
   **降级结果**：`_speed_history_cached` 对空轮表（可能是 `session` 表读失败等降级的结果）不写水位，仍按 TTL 重试；`_today_detail` 内 `_scope_models_cost` 查询瞬时失败时的降级值（`cost: None`、`models: []`）目前不做同样处理——出现条件仅为瞬时失败（如库被锁），后果是今日费用/模型明细最长 20s 空白后自愈，与上述 20s 陈旧口径同类，已知并接受（不为此在签收后再改代码）。
9. 新增定时器/监听必须随实例 `dispose` 清理，热更新、导航、窗口关闭后停用（v328 批未新增定时器/监听；issue #309 批新增的条件性尾部定时器见规则 12）。
10. **心跳不读 store（issue #309）**：100ms 心跳路径（`bridgeTick` 健康检查、`updateLive` 内的 `subRunningList` 与「思考中」合成）不再直接调桥包装的 `getState()`，统一经 `handleSnapshot(h)` 读 handle 上的快照记录（`h.snap`/`h.snapAt`）。记录由通知回调写入（用 `subscribeStore` 传入的 state，零额外读取）；距上次更新超过 `SNAP_FRESH_MS`（2s）才回源 `getState()` 一次并回写——这次回源兼作 store 关闭/换代的探活（`getState()` 返回 null 或快照 `sessionId` 变 → 调用方按既有语义脱离重绑），探活延迟因此由 ≤0.1s 放宽到 ≤2s（`v88` 以前本就是 2s 心跳）；pane 切会话仍由 `handle.sid`/`sideKey` 与当前会话的比对**即时**重绑，不依赖探活。展示不变：宿主每次状态变更必通知（v3 桥缓存也以通知为失效点），记录与逐拍读取同样新鲜。与桥代际无关，v2/v3 均有效。
11. **每次通知只读一次**：`subscribeStore` 把本次已读的 state 作为参数传给 `changed(state)`，overlay 回调直接使用，不再二次 `getState()`（v2 桥下每读一次 = 一份整窗拷贝）。
12. **通知处理预算（仅对昂贵会话生效）**：`subscribeStore` 记录上一次通知处理（读 store + `ingest` + `changed`）的实测耗时 `cost`。`cost < BUDGET_MIN_COST_MS`（8ms）时行为与此前完全一致（每次通知同步处理）；`cost ≥ 8ms` 时，距上次处理结束不足 `min(BUDGET_MAX_GAP_MS(1000), cost × BUDGET_GAP_RATIO(9))` 的通知**合并**：只置 `pending`，并保证一个尾部 `setTimeout` 在间隔届满时处理**最新**状态（中间快照既不读也不 `ingest`；`ingest` 以 `seq` 单调，丢中间帧无副作用）。上界：插件通知处理占主线程 ≤ ~10%（`cost / (cost × (1 + 9))`），最长陈旧 ≤ 1s。尾部定时器归该订阅持有，`off()` 时清除，订阅关闭后即使已排队也不执行；`unref` 以免挂起 Node 测试进程。**已知后果**：昂贵会话（窗口 ≳ 2000 行）的实时 t/s 刷新由逐通知降为 ≤ ~1Hz；短于一个合并间隔（≤1s）就完成的轮次可能没被「实时观察到」（`observedLive=false`），按重绑时捞到已完成历史轮的既有口径处理（overlay-bridge 测试 ⑯/⑰）。一次性的 GC/JIT 尖峰可能让紧随其后的一次通知多等 ≤~0.3s，下一次处理测得小成本即恢复。
   **复审补充（A/E 两路独立审查）**：①丢中间帧对 `observedLive` **不严格无副作用**：昂贵会话里若某轮在一个合并间隔内开始并结束（命令秒回），尾部处理只看到已完成态，`seenIncomplete=false`，历史行可能显示「本轮统计不可用」；概率低（LLM 往返通常 >1s，且仅长会话触发），按已知取舍接受。②合并后每次处理后紧接的一次实时读数偏低（模拟：起步 1~2s 约 −30%，稳态约 −5%~−10%），`characterRate` 的 2s 窗口与 200ms 下限在 ≤1s 间隔下仍成立，常量不调。③子代理槽位回调同样遵守规则 11（v341）；同步处理分支会作废迟到的尾部定时器；全局 `setTimeout`/`clearTimeout` 缺席时 `arm` 失败退回同步处理，不留无人冲刷的 `pending`。④宿主 `snapshotTailWindowRows:60` 只截 wire/hydrate 快照，渲染端 reducer 增量只增不截（源码核对）——窗口可达数千行。

## 状态所有者与接口

- 渲染进程拥有全部实例级节流状态（`liveTipBuiltAt`、`idleRenderData/At`）与失鲜标记（`__zuTipView`/`__zuTipStale`，挂在 `.it` 格元素上）；均为实例闭包变量/元素私有属性，随实例销毁，不进 `localStorage`、不进快照。
- `turn-stats.js` 的 `createTracker` 公共接口不变（`ingest/get/clear/dispose`）；行字符数缓存归 tracker 的 turn 持有（`turn.counts`：rowId → `{text, n}`，以文本相等校验），随行移出窗口、turn 删除、`clear/dispose` 释放。
- Python 水位缓存状态（`_AGG_WM/_PROJ_WM/_SPEED_WM`）与对应缓存同生命周期、同上限、同清空；不进快照、不改 CLI/MCP/`/usage` 输出契约；`speed_history` 帧字段、协议与大小不变。
- **桥快照记录（issue #309）**：渲染进程的主桥 handle 持有 `snap`/`snapAt`，仅由 overlay 的通知回调与 `handleSnapshot` 回源写入，`bridgeDetach` 时释放引用；不进 `localStorage`、不进快照、不跨 pane（每个 handle 一份）。`subscribeStore(store, tracker, changed, options?)` 的预算状态（`pending`/尾部定时器/`lastCost`/`lastEnd`）是该订阅的闭包私有状态；`options.now/setTimeout/clearTimeout` 仅为测试注入缝（缺省 `performance.now` 与全局定时器）。`changed(state)` 新增参数向后兼容（既有无参回调不受影响）。
- 本批全部为热文件：`overlay.js`、`turn-stats.js`（主桥 mtime 轮询整体重注入）、`zusage.py`（mtime 变化后常驻 Python 自动重启）；**不涉及冷文件 `inject-main.cjs`**，无需重启客户端。issue #309 批同样只动 `turn-stats.js` 与 `overlay.js`（`src/overlay/` 分片）：**不改桥模板与 `BRIDGE_GEN`**（静态桥在宿主 asar 里，属冷路径）。

## 验收场景

1. `ingest` 对含 emoji、孤立代理项、中英混排的文本得到与 `Array.from` 相同的字符数；同一行文本未变时命中缓存；文本变化时重算；行移出窗口后缓存释放；热路径不再对字符串调用 `Array.from`（变异：换回旧实现该守卫测试变红）。
2. `updateLive` 快路径：未悬停且距上次构建 <1s → 不调 `buildLiveTip`、`__tip` 标记失鲜；满 1s 保鲜；悬停本格 → 每拍构建并重画；`drawTip` 读取失鲜格前先补建（顺序锁）；补建异常不外溢。
3. `spdUnpack` 同一 `speed_history` 引用重复调用只解包一次；新引用/轮数变化重算；结果与未缓存实现逐字段一致。
4. 空闲会话：同一数据帧下 500ms 内的心跳不 `render`；数据帧引用变化即渲染；满 500ms 兜底渲染；live→非 live 切换即渲染；view 非空的结构切换不受节流。
5. 轮播关闭态帧步按 1s 节流；开启后恢复 65ms 节奏。
6. 水位缓存：TTL 过期且水位未变 → 复用；新请求完成（水位变）→ 立即重算；超过 `_WM_MAX_AGE_MS` → 兜底重算；TTL 内不碰库；内存库/无连接纯 TTL；计算期间并发写入强制下一帧重算（变异：把水位读取挪到计算之后/让水位缓存恒失效，对应测试变红）；缓存字典有界。
7. 真库对比（只读，隔离 HOME，同一请求 1.5s 节奏）：旧版逐帧 190↔900ms 交替（均值 474ms），新版稳定 ~200ms、仅每 20s 兜底重算一次（均值 268ms）。
8. 根产物 `overlay.js` / `turn-stats.js` / `zusage.py` 与 ZCode 插件副本、WorkBuddy 插件副本一致；`python3 sync_plugin.py --check`、`scripts/sync_workbuddy_plugin.py --check` 通过。
9. **心跳读次数（规则 10）**：绑定后连续 N 个心跳（无推送、记录新鲜）→ `getState` 调用 0 次；记录陈旧（>`SNAP_FRESH_MS`）后的首个心跳回源恰好 1 次并刷新记录，之后又回到 0 次；陈旧后 store 已失效（`getState` → null）→ 该心跳即脱离并重绑到替换 store；pane 切会话不等探活、同一心跳即重绑（变异：把 `handleSnapshot` 换回直接 `getState()` 或让记录恒新鲜，对应测试变红）。用「每次读都是整窗拷贝」的计数桩复现症状路径，不依赖计时。
10. **每通知读一次（规则 11）**：一次 store 推送使 overlay 路径总计只调 1 次 `getState`（含 `updateLive` 内 `subRunningList`/「思考中」合成）；`subscribeStore` 把读到的同一 state 对象传给 `changed`。
11. **预算（规则 12）**：廉价（`cost < 8ms`）→ 连发 N 次通知同步处理 N 次；昂贵 → 间隔内通知合并为一次尾部处理、尾部处理的是最新状态、只排一个定时器、间隔届满后的下一次通知恢复同步；`off()` 清定时器且已排队的不执行；`dispose` 后 `timers.size === 0`；尾部处理中 `getState` 抛错不外溢；`cost` 恰为阈值 / 间隔恰为上界的边界值各有用例。

## 未做（已评估，留作后续）

- 桥层面的结构共享：让 `zuSnapshot` 按宿主对象身份复用未变子树的冻结副本，把单次拷贝由 O(window) 降到 O(changed)。前提是宿主 store 对行做不可变更新（就地改行文本会让缓存给出陈旧副本），尚未在宿主 bundle 里核实；并且要改桥模板、升 `BRIDGE_GEN`、走冷路径重打 asar 与全量重启。规则 10–12 已把插件侧的代价封顶，不阻塞本批。
- `tracker.ingest` 自身对窗口 O(window)（6867 行约 6–8ms）：由规则 12 的预算封顶，未改算法。
- 通知频率的实测：本机无流式中的已注册会话，没能直接量宿主 store 的通知速率；规则 12 的 ≤10% 上界不依赖该速率。
- 主进程冷文件 `inject-main.cjs`：`speed_history` 按指纹去重推送（本机每窗口每 ≥1.5s 约 312KB，其中 241KB 为 `speed_history`）；`gitTick` 窗口失焦门控 + 结果不变退避 + 子仓库枚举改异步（本机 17k 文件仓库每 10s 仅 0.15~0.3s，Windows 上更重）；同窗最多 3 次重复注入 1.5MB 脚本前加探针。均需完全重启才生效。
- 渲染端：逐帧 `track()` 的几何读取按 pill 以外 150ms 节流；`hcObserver`/quota observer 缩小观察范围（依赖 Radix portal 假设，需先验证）；`heavy` 与协调器 tick 的双倍频率。前台实测前不动。
- Python 命中帧基线 ~200ms：子代理 `_scope_models_cost` N+1（48 次 ≈ 56ms）、5 个完整会话快照、`_provider_fallback` 无缓存（~18ms）、`_sub_agent_tasks` 按 part 全量重扫。
- hooks：`SessionStart` 每次对 373MB `app.asar` 全量 SHA256（~135ms，仅发布前才需要，可改廉价 stat 戳）；`UserPromptSubmit` 为 `detect_agent` 整体 `import zusage`（~37ms）。hook 读插件缓存副本，需发版后生效。
