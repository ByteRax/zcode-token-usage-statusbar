# 重置卡刷新节奏

## 范围与规则

- 背景（2026-11-25 用户实报截图「徽标 3、tooltip 只有 2 条未到期」）：徽标张数与倒计时读 `reset/status`（`RESET_TTL_MS` 2 分钟），tooltip 逐卡行读 `customer-package-reset/list?targetType=PERSONAL`。列表接口原先按独立的 10 分钟周期刷新；新发的卡落在两次列表刷新之间时，徽标先于明细更新，两边最长约 10 分钟对不上。
- 产品规则：个人链两个接口同一节奏。`RESET_LIST_TTL_MS = RESET_TTL_MS`，status 到期重查的同一轮必打列表，status 与 list 同一轮一起落库——徽标张数与 tooltip 未到期行来自同一轮数据。
- 对齐不变量：一轮结算只用同一个时刻写 `fetchedAt`、`nextAt` 与 `listFetchedAt`。于是「status 到期」恒推出「列表到期」。原先两次取时钟，tick 恰落在边界那一毫秒时列表会被跳过一轮。
- 状态所有者：`src/quota/05-scheduler-and-exports.cjs` 的 `tickReset`（个人链分支与结算段）；团队分支 list 即主链，不受本规则影响。
- 保持不变：
  - 尝试即计时：列表传输失败或形状变化同样写 `listFetchedAt`，本轮沿用上一轮 list，下一个 status 轮再试。
  - force（chip 点击 / 立即刷新）必打列表。
  - pokeReset 只唤醒 status。列表上次尝试未满 TTL 时该轮不打列表——新发卡后 2 分钟内悬停徽标，徽标仍可能先于明细更新，下一个 TTL 轮对齐。
  - status 自身的退避、冻结与 JWT 临期守卫不变。
- 代价：列表接口请求频率与 status 相同（原约每小时 6 次）。
- 不在控制范围：两个接口由不同后端提供。同一轮串行请求时若服务端列表滞后，本轮仍可能不一致，下一轮自愈。

## 验收

| 场景 | 预期 | 验证 |
| --- | --- | --- |
| status 到期重查 | 同一轮 status 与 list 各重打一次；恰等 TTL 边界即重打 | `tests/quota-client.test.cjs` 列表节奏与边界用例 |
| TTL 内 poke | status 重打、list 不重打，view 沿用上一轮 list | 同文件列表节奏用例 |
| 两端点新增一张卡 | 下一个 TTL 轮后，status 未过期卡全部出现在 list 未过期卡中 | 同文件徽标与明细对齐用例 |
| 列表 HTTP 失败 | 本轮沿用上一轮 list；TTL 内 poke 不重试；下一个 TTL 轮重试 | 同文件失败按尝试计时用例 |
| 时钟每次取值递增，tick 恰等于 nextAt | list 仍重打 | 同文件同一时刻基准用例 |
| force | status 与 list 都重打 | 同文件列表节奏用例 |
