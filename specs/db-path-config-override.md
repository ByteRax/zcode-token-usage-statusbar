# 本地用量库路径：`hosts.zcode.db_path` 显式覆盖的一致性（issue #314）

## 问题与证据

- `hosts.zcode.db_path` 是文档化的公开配置键（docs/hosts.md §3：「覆盖 ZCode 库位置（多机/自定义安装）」）。`zusage.zcode_db_path(cfg)`（经 `connect()` / `host_db_path()`，快照链、CLI、MCP 共用）读它；`token_rate.py` 的 `DB_PATH = ZCODE_USAGE_DB or _default_db_path()` 不读。
- token_rate 的消费者（均经模块量 `DB_PATH`）：
  1. 主桥 `queryTurnText`（`inject-main.cjs`，会话末尾回推确定性统计行）：`spawn(python, [token_rate.py, "--turn", "--current", "--session", sid])`，**不传 `ZCODE_USAGE_DB`**；
  2. `hooks/prompt-submit.py`：`import token_rate`，取 `query_latest` 注入「上一条回复」背景行，并经 `write_session_state` 记录提问时刻；
  3. CLI 手动排查（默认输出、`--json`）。
  这三条链读默认解析库，与 zusage 链读的覆盖库可能不是同一个。
- 现场反馈（issue #311，报告者陈述：Windows、engine 3.18.0、插件 1.5.16；机制经代码阅读与上面的消费者清单吻合，未在其环境复现）：报告者在运行目录 `config.json` 写了 `hosts.zcode.db_path` 指向活库，zusage 快照链/MCP 正常；token_rate 按默认解析选中陈旧迁移库（#294），逐问统计行恒显占位文案「⚡ 生成时长缺失，暂不显示速率」、prompt-submit 背景行恒为「暂无已完成的模型请求」。#294 的陈旧库仲裁修的是**默认解析本身**，不再需要该覆盖做规避；但覆盖键仍是公开能力。
- 结论：这不是某个默认解析的 bug，而是**同一配置键在两条链上语义不同**，且表现为静默错读（或占位文案）而不报错，用户难以自查。下一个把库放在非默认位置的用户（多机 / WSL / 自定义安装）会遇到同款「MCP 正常、统计行异常」。

## 决策记录

1. **token_rate 跟随覆盖**（而不是在文档里声明「覆盖只对 zusage 生效」）。理由：键的文档承诺是「覆盖 ZCode 库位置」而非「覆盖某条链的库位置」；不一致的症状静默且已在实机出现；代价仅是每轮新进程多读至多两个小 JSON；反向做法会让依赖该键的多机/自定义安装用户在逐问链上失去该能力。
2. **优先级 `ZCODE_USAGE_DB` > 覆盖 > 默认解析**。理由见规则 2。
3. **范围仅限 token_rate**（含经它的 hook 与主桥旁路）；`inject-main.cjs` 的库监听/去重戳同样不读覆盖，但它是唯一冷文件，另行评估（见「遗留」）。

## 产品规则（不变量）

> 代码注释与测试里的「规则 N」指本节；验收场景用「验收 N」。

1. **单一语义**：`hosts.zcode.db_path` 非空即 ZCode 用量库路径。zusage 查询链（CLI / MCP / 桌面快照）与 token_rate 逐问链（`--turn --current`、prompt-submit 背景行、CLI 默认输出）读**同一个库**。
2. **token_rate 优先级**：`ZCODE_USAGE_DB` > `hosts.zcode.db_path` > 默认解析（`_default_db_path`：宿主 agent 会话库镜像序 + #294 仲裁）。
   - env 高于配置沿用 docs/hosts.md 既有约定（`ZUSAGE_WORKBUDDY_DB` > `hosts.workbuddy.db_path`）。
   - `ZCODE_USAGE_DB` 是插件逐问脚本的隔离接缝（测试 / 沙箱），不得被用户机器上的覆盖穿透；空串视为未设（沿用既有 `or` 语义）。
   - zusage 仍**不**读 `ZCODE_USAGE_DB`（AGENTS.md §5 契约不变）。
3. **读取口径与 zusage 逐项同款**（`host_config()` + `zcode_db_path()`）：
   - config.json 两跳：脚本同目录 → `~/.zcode/zcode-token-usage-statusbar/config.json`；按 UTF-8 读取（含 BOM 的文件两侧都按损坏忽略）。
   - `hosts` 下按宿主名先到者**整段胜出**：第一个含 `hosts.zcode` **对象**的文件决定结果，其 `db_path` 为空串 / 缺键也遮蔽第二跳（与 zusage 现状一致，不顺手改）；`hosts` 非对象、`hosts.zcode` 非对象的文件视同没有该项，继续下一跳。
   - 值须为非空（strip 后）字符串，经 `os.path.expandvars` + `expanduser`；**不检查存在性、不仲裁、不校验绝对性**（显式来源即写库位，同 specs/db-path-stale-arbitration.md 规则 5；相对路径按进程 cwd 解析，与 zusage 同款，文档建议写绝对路径）。
4. **容错**：文件缺失 / 不可读 / 损坏 / 非对象 / 类型异常一律视为未配置，逐级回落，**不抛异常、不拖垮统计链**。`DB_PATH` 在导入期求值，而 prompt-submit / session-start 两个 hook 在同一个 `try` 里 `import token_rate` 并调用 `write_session_state`——导入期抛异常会连带丢掉提问时刻状态，使 `--current` 守卫整轮 fail-closed，所以 token_rate 侧对覆盖值的任何解析异常（含 `~user` 无法展开）都按未配置处理。zusage 对同一病态值会在查询期抛 `RuntimeError`（实测：`zcode_db_path()` / `connect()` 直接抛出，而 `connect()` 的调用点只捕获 `sqlite3.Error`，兜不住它），是 zusage 既有的边角，不在本规格范围（有意的唯一差异，见验收 6 与「遗留」）。覆盖指向**不存在**的库不是异常：按「库缺失」降级（`open_db()` 返回 None → 「暂无已完成的模型请求」/ 空输出），**不回落默认库**——显式配置的错误应可见，不被静默掩盖。
5. **覆盖在默认解析之上，不并入它**：`_default_db_path` 继续与 `zusage.resolve_db_path` 同源镜像宿主链（三处镜像及其交叉一致性用例不变）；覆盖层对应 zusage 的 `zcode_db_path`（模块级 `DB_PATH` 之上那一层）。
6. **只作用于 ZCode 宿主语义**：不读 `hosts.workbuddy.db_path`；token_rate 不适用 WorkBuddy（docs/hosts.md §8）。
7. **解析时机**：模块导入时一次（`DB_PATH`），随进程生效；token_rate 每轮新进程，配置改动对下一轮生效，不引入缓存 / 监听。`ZCODE_USAGE_DB` 已设时**短路、不读任何 config**：保持隔离接缝零额外 I/O，且让现有以 `ZCODE_USAGE_DB` 隔离的测试不碰执行者的真实配置。

## 状态所有者与接口

- 配置所有者：用户的 `config.json`（只读，插件不写该键）。
- 解析所有者：zusage `zcode_db_path()`（Python 查询链）与 token_rate `_configured_db_path()`（逐问链，内联同款）。token_rate 单独部署不 import zusage，改动两处同步，同 `_default_db_path` 的既有模式。
- 消费者（经 token_rate 模块量 `DB_PATH`，自动跟随，无需各自改动）：主桥 `queryTurnText`、`hooks/prompt-submit.py`（`query_latest`）、CLI 默认输出。
- 不进快照，不改 CLI / MCP / hook 输出契约；不新增配置键。

## 验收场景

1. **症状路径（CLI 子进程）**：覆盖指向含数据的库 X、默认解析无库 → 无 `ZCODE_USAGE_DB` 的 `token_rate.py` 默认输出与 `--turn --current` 读到 X 的数据；对照组（去掉覆盖）输出「暂无已完成的模型请求」/ 空——证明用例对该症状有判别力。
2. **优先级**：`ZCODE_USAGE_DB` 与覆盖并存 → env 胜；`ZCODE_USAGE_DB` 为空串 → 视为未设，覆盖生效。
3. **回落**：`db_path` 为空串 / 缺键 / 全空白 / 非字符串；`hosts.zcode` 缺失或非对象；`hosts` 非对象；两跳文件均缺失 → 与修复前逐字节一致（默认解析）。
4. **两跳与遮蔽**：脚本同目录有覆盖 → 胜过数据目录；仅数据目录有 → 采纳；脚本同目录有 `hosts.zcode` 对象但 `db_path` 为空 → 遮蔽数据目录的值；脚本同目录 `hosts` 里无 `zcode`（或 `zcode` 非对象）→ 继续第二跳。
5. **展开**：`~` 与环境变量展开（POSIX `$VAR`，Windows `%VAR%`）与 zusage 一致；覆盖指向不存在的库 → 按库缺失降级且不回落默认库。
6. **容错**：损坏 JSON / 非对象顶层 / BOM / 不可读 → 视为未配置，不抛异常；`~nouser/…` 这类无法展开的值 → token_rate 视为未配置且导入不抛（有意与 zusage 不同，规则 4）。
7. **交叉一致性**：对同一份 config 夹具，`zusage.zcode_db_path()` 与 `token_rate._configured_db_path()` 结果相同（覆盖验收 3–5 的各场景，扣除 env 与病态值）。
8. **短路与隔离**：`ZCODE_USAGE_DB` 已设时，导入 token_rate 不读取任何 `config.json`（规则 7）。
9. **不回归**：`tests/test_db_path_resolution.py`（含 `_default_db_path` ↔ `zusage.resolve_db_path` 交叉一致性）与既有 token_rate 用例不改、全绿。

## 遗留（本规格范围外）

- `inject-main.cjs` 的 `dbDir()` / `dbStamp()` / `watchDb()`（Node 主桥的库活动监听与「无新写入不拉」去重戳）同样不读覆盖，仍按默认解析目录。**以下为代码阅读推断，未做运行态验证**：覆盖库与默认库不在同一目录时，① `fs.watch` 监听的是默认目录，覆盖库写入不触发 300ms 去抖拉取；② `maybeSpawn` 以 `dbStamp()` 去重——默认库存在且静止时，`st === lastStamp` 会抑制重拉（wants / config / setting 变化仍可触发），默认库不存在时 `st = 0` 不去重，刷新退化为 `heartbeat_ms`（缺省 30s）心跳。受影响的是桌面推送的**时效**，快照**内容**仍读覆盖库（zusage 侧一致）。
- 不在本批处理的原因：`inject-main.cjs` 是唯一冷文件（须完全退出重启才生效）；Node 侧需自实现 `expandvars` 语义；`dbStamp()` 写死 `db.sqlite*` 文件名，覆盖指向任意文件名时需改为按实际文件名取戳。需单独规格与评估。
- `zusage.zcode_db_path()` 对无法展开的 `~user` 值抛 `RuntimeError`，其 `connect()` 调用点（`snapshot`、常驻 `serve` 的重开分支、CLI `main`）只捕获 `sqlite3.Error`（已实测抛出，调用点由代码阅读确认；未对常驻进程做运行态验证）。病态配置才触发的既有边角；本批不改 zusage 以保持其行为不变，如需收敛应另开议题，让 `zcode_db_path` 与 token_rate 一样把展开失败当未配置。
