# 本地用量库路径：陈旧迁移目录仲裁（issue #294）

## 问题与证据

- 为 3.17.x 迁移用户保留的第 3 级解析：`setting.json` 的 `dataBaseDir`（或 `ZCODE_DATA_BASE_DIR`）指向目录下**存在** `.zcode/cli/db/db.sqlite` 即读迁移目录。当时判据是「该位置有库必为真实写入位」（#279 实测迁移用户库确实在迁移目录）。
- issue #294（Windows，engine 3.18.0，插件 1.5.16）证伪该假设：用户 `dataBaseDir` 指向 `D:\dev_software\ZCode_data`，其下库 2026-08-07 后再无写入（393KB、1 会话、7 条 model_usage），真实活跃库在 HOME（358MB、WAL 持续写入）。插件按存在性选中陈旧库：当前会话查不到进 `not_local`（状态条「不在本地库」）、「今日」恒 0、MCP「当前会话」回落到 8 月旧会话。
- 3.18.0 宿主 bundle 复核（2026-11-11，`glm/zcode.cjs`）：写库方（agent 进程）会话库链只认 env `ZCODE_SESSION_DB_PATH`/`ZCODE_SESSION_DB` → CLI config `storage.sessionDbPath` → 默认 `~/.zcode/cli/db/db.sqlite`（`getDefaultSessionDbPath` 硬编码 HOME，`getSessionDbPath` 仅做 `~` 展开），完全不消费 `dataBaseDir`；3.17.1 的 `localUsageEvidence`/`copyDataDirectory` 符号已不在 bundle（混淆轮换，语义未回归）。即 3.18.0 起 agent 恒写 HOME，迁移目录库一旦存在只可能陈旧。
- 结论：存在性不足以认定「真实写入位」；候选库与 HOME 库并存时必须按写入新鲜度仲裁。

## 产品规则（不变量）

> 代码注释与测试里的「§N」指本节「产品规则 N」；验收场景用「验收 N」。

1. **解析顺序不变**：env 双别名（键序取后，空值弃用整个来源）→ CLI config `storage.sessionDbPath` → 迁移目录候选 → HOME 默认库。仲裁只发生在第 3 级：候选库存在**且** HOME 默认库也存在时。
2. **写入新鲜度口径**：`max(mtime(db.sqlite), mtime(db.sqlite-wal))`；`-shm` 只读连接也会更新，不入仲裁。候选新鲜度 ≥ HOME 库才采纳候选，落后即回落 HOME 默认库（3.18.0 起写库方在 HOME，陈旧候选必是 #294 型历史遗留）。
3. **HOME 库不存在仍采纳候选**（#279 真迁移场景保留：那种用户的候选库才是被持续写入的一边，或全部数据只在迁移目录）。
4. **三处镜像同规**：`zusage.resolve_db_path`、`token_rate._default_db_path`、`inject-main.cjs resolveHostDbDir` 的仲裁行为一致；既有容错（BOM、损坏 JSON、相对值、空值、`~` 拒绝）逐字节不变。
5. **显式来源不经仲裁**：env 双别名与 CLI config 命中即返回——用户显式指定的库就是写库位，无歧义可仲裁。
6. **不引入数据层水位仲裁**：那需要在解析期打开两个库，`token_rate` 每轮新进程都要付开销，Node 侧还缺无依赖 SQLite 通道；mtime 口径已覆盖报告场景且三端可同步实现。代价是跨盘时钟漂移/文件系统时间戳粒度（FAT 2s）下可能误判，已知并接受——两库真实写入从来不会落在同一时间戳粒度内。

## 状态所有者与接口

- 仲裁为各镜像内联私有 helper（Python `_db_write_fresh` + 采纳判定，Node `dbWriteFreshMs` + `adoptsMigrationCandidate`），不进快照、不改 CLI/MCP/hook 输出契约。
- `DB_PATH`（Python 模块量）与 `DB_DIR`（Node 进程缓存）仍为一次解析随进程生效；运行期库位置变化仍依赖既有热重载/重启语义，不变。
- `hosts.zcode.db_path` 显式覆盖（docs/hosts.md）只在 zusage 查询链生效的现状不变；本仲裁修的是「默认解析」本身，修复后 #294 型场景不再需要该覆盖规避。

## 验收场景

1. 候选库与 HOME 库并存、候选更旧 → 读 HOME 默认库（#294 主场景；变异：去掉新鲜度比较该用例变红）。
2. 候选库与 HOME 库并存、候选更新（仅 `-wal` 更新也算）→ 读候选库（#279 两库并存）。
3. 候选库存在、HOME 库不存在 → 读候选库（既有行为回归）。
4. 候选仅 `-shm` 更新、db/-wal 更旧 → 视为陈旧，读 HOME 库（-shm 不入仲裁）。
5. 无 `dataBaseDir` / 候选不存在 / 显式 env、config 来源 → 与修复前逐字节一致。
6. 三处镜像在以上场景结果一致（Python 交叉一致性用例 + Node VM 切片用例）。
7. 显式来源不经仲裁（规则 5 锁定）：env `ZCODE_SESSION_DB_PATH` / CLI config `sessionDbPath` 指向比 HOME 默认库更旧的库时仍原样返回；三镜像 × 两级显式来源六格全部由用例锁定（变异：任一格误加仲裁必红——R2 实测补齐 token_rate × CLI config 格，由交叉一致性用例在「HOME 库已建且更新」执行点双杀）。

## 遗留（后续版本顺手）

- `src/overlay/07-instance-render-and-tips.js` 的 not_local 提示文案「宿主数据目录迁移 dataBaseDir 后由插件自动跟随」为无条件表述，未提陈旧迁移库回落例外；改它须升 `VERSION` 并重建产物，与本次修复成本不对称，本批不动（2026-11-11 审查 C 记录）。
- `tests/inject-db-dir.test.cjs` 的 statSync stub 对不存在的文件返回兜底 mtime 而非抛 ENOENT：现状所有用例时间戳为 1.7e9 量级、42 等价「极旧」，无掩护效应；未来若有依赖「缺失须抛错」的用例再收紧（2026-11-11 审查 B 记录，自评非必须）。
