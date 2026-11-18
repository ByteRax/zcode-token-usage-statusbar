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

1. **zusage、token_rate 与 inject-main 三端同源跟随覆盖**（而不是在文档里声明「覆盖只对 zusage 生效」）。理由：键的文档承诺是「覆盖 ZCode 库位置」而非「覆盖某条链的库位置」；不一致的症状静默且已在实机出现；代价仅是每轮新进程或监听去重时多读至多两个小 JSON；反向做法会让依赖该键的多机/自定义安装用户在逐问链或桌面实时推送去重链上失去该能力。
2. **优先级 `ZCODE_USAGE_DB`（仅 token_rate） > `hosts.zcode.db_path` > 默认解析**。理由见规则 2。
3. **三端全量收敛**：`zusage.py`（`zcode_db_path`）、`token_rate.py`（`_configured_db_path`）与 `inject-main.cjs`（`resolveConfiguredDbPath` → `dbFile()` / `dbDir()` / `dbStamp()` / `watchDb()`）全部对齐同一套两跳遮蔽、环境变量展开与容错规则，并由 `tests/test_token_rate_db_override.py` 的 19 场景三方交叉一致性矩阵与 `tests/inject-db-dir.test.cjs` 共同锁定。

## 产品规则（不变量）

> 代码注释与测试里的「规则 N」指本节；验收场景用「验收 N」。

1. **单一语义**：`hosts.zcode.db_path` 非空即 ZCode 用量库路径。zusage 查询链（CLI / MCP / 桌面快照）、token_rate 逐问链（`--turn --current`、prompt-submit 背景行、CLI 默认输出）与 `inject-main.cjs` 主桥监听/去重戳（`dbFile` / `dbDir` / `dbStamp`）读**同一个库**。
2. **token_rate 优先级**：`ZCODE_USAGE_DB` > `hosts.zcode.db_path` > 默认解析（`_default_db_path`：宿主 agent 会话库镜像序 + #294 仲裁）。
   - env 高于配置沿用 docs/hosts.md 既有约定（`ZUSAGE_WORKBUDDY_DB` > `hosts.workbuddy.db_path`）。
   - `ZCODE_USAGE_DB` 是插件逐问脚本的隔离接缝（测试 / 沙箱），不得被用户机器上的覆盖穿透；空串视为未设（沿用既有 `or` 语义）。
   - zusage 与 `inject-main.cjs` 仍**不**读 `ZCODE_USAGE_DB`（AGENTS.md §5 契约不变）。
3. **读取口径在 zusage、token_rate 与 inject-main 三端逐项同款**（`host_config()` + `zcode_db_path()` / `_configured_db_path()` / `resolveConfiguredDbPath()`）：
   - config.json 两跳：脚本同目录 → `~/.zcode/zcode-token-usage-statusbar/config.json`；按 UTF-8 读取（含 BOM 的文件三侧都按损坏忽略）。
   - `hosts` 下按宿主名先到者**整段胜出**：第一个含 `hosts.zcode` **对象**的文件决定结果，其 `db_path` 为空串 / 缺键也遮蔽第二跳（三端一致）；`hosts` 非对象、`hosts.zcode` 非对象的文件视同没有该项，继续下一跳。
   - 值须为非空（strip 后）字符串，经环境变量展开（`$VAR` / `${VAR}` / Windows `%VAR%`）+ `~` 展开，展开结果按宿主平台归一分隔符（Node `path.normalize` / Python `Path` 字符串化，模板字面量 `/` 混入 Windows 反斜杠展开值时三端同形）；**不检查存在性、不仲裁、不校验绝对性**（显式来源即写库位，同 specs/db-path-stale-arbitration.md 规则 5；相对路径按进程 cwd 解析，文档建议写绝对路径）。
4. **容错**：文件缺失 / 不可读 / 损坏 / 非对象 / 类型异常一律视为未配置，逐级回落，**不抛异常、不拖垮统计链**。覆盖指向**不存在**的库不是异常：按「库缺失」降级（`open_db()` 返回 None → 「暂无已完成的模型请求」/ 空输出；`inject-main.cjs` 的 `dbStamp()` 对该自定义库文件名及其 `-wal`/`-shm` 计戳为 `0`），**不回落默认库**——显式配置的错误应可见，不被静默掩盖。
5. **覆盖在默认解析之上，不并入它**：`_default_db_path` 与 `resolveHostDbDir` 继续与 `zusage.resolve_db_path` 同源镜像宿主链（三处镜像及其交叉一致性用例不变）；覆盖层叠在默认解析之上。
6. **只作用于 ZCode 宿主语义**：不读 `hosts.workbuddy.db_path`；token_rate 不适用 WorkBuddy（docs/hosts.md §8）。
7. **解析时机**：token_rate 在模块导入时求值一次（`DB_PATH`），`ZCODE_USAGE_DB` 已设时**短路、不读任何 config**；`inject-main.cjs` 在首次调用 `dbFile()` / `dbDir()` 时求值一次并缓存至模块级 `DB_FILE` / `DB_DIR`（与 `resolveHostDbDir` 一样随主进程生命周期生效，运行期修改 `hosts.zcode.db_path` 需重启客户端），`dbStamp()` 与 `watchDb()` 按 `dbFile()` 解析出的实际库文件名（如 `custom.db`、`custom.db-wal`、`custom.db-shm`）监听并计算最新 `mtimeMs` 去重戳。

## 状态所有者与接口

- 配置所有者：用户的 `config.json`（只读，插件不写该键）。
- 解析所有者：zusage `zcode_db_path()`（Python 查询链）、token_rate `_configured_db_path()`（逐问链，内联同款）与 `inject-main.cjs` `resolveConfiguredDbPath()`（主桥监听与去重戳，内联同款）。三处改动必须同步。
- 消费者：zusage 快照/CLI/MCP、主桥 `queryTurnText`、`hooks/prompt-submit.py`（`query_latest`）、token_rate CLI 默认输出，以及主桥 `watchDb` / `dbStamp`。
- 不进快照，不改 CLI / MCP / hook 输出契约；不新增配置键。

## 验收场景

1. **症状路径（CLI 子进程）**：覆盖指向含数据的库 X、默认解析无库 → 无 `ZCODE_USAGE_DB` 的 `token_rate.py` 默认输出与 `--turn --current` 读到 X 的数据；对照组（去掉覆盖）输出「暂无已完成的模型请求」/ 空——证明用例对该症状有判别力。
2. **优先级**：`ZCODE_USAGE_DB` 与覆盖并存 → env 胜；`ZCODE_USAGE_DB` 为空串 → 视为未设，覆盖生效。
3. **回落**：`db_path` 为空串 / 缺键 / 全空白 / 非字符串；`hosts.zcode` 缺失或非对象；`hosts` 非对象；两跳文件均缺失 → 与修复前逐字节一致（默认解析）。
4. **两跳与遮蔽**：脚本同目录有覆盖 → 胜过数据目录；仅数据目录有 → 采纳；脚本同目录有 `hosts.zcode` 对象但 `db_path` 为空 → 遮蔽数据目录的值；脚本同目录 `hosts` 里无 `zcode`（或 `zcode` 非对象）→ 继续第二跳。
5. **展开**：`~` 与环境变量展开（POSIX `$VAR`/`${VAR}`，Windows `%VAR%`）三端一致；覆盖指向不存在的库 → 按库缺失降级且不回落默认库。
6. **容错**：损坏 JSON / 非对象顶层 / BOM / 不可读 → 视为未配置，不抛异常；`~nouser/…` 这类无法展开的值 → 视为未配置或保留原串且不抛未捕获异常。
7. **三方交叉一致性**：对同一份 19 场景 config 夹具矩阵，`zusage.zcode_db_path()`、`token_rate._configured_db_path()` 与 `inject-main.cjs` `resolveConfiguredDbPath()` 结果逐项相同（由 `tests/test_token_rate_db_override.py` 的 `NodeMainBridgeParityTest.test_node_inject_main_matches_python_across_all_scenarios` 锁定）。
8. **主桥自定义文件名去重戳**：当 `hosts.zcode.db_path` 指向自定义文件名（如 `/tmp/custom-usage.sqlite`）时，`inject-main.cjs` 的 `dbDir()` 返回其父目录，`dbStamp()` 精确读取 `custom-usage.sqlite` 及其 `-wal`/`-shm` 的最新 `mtimeMs`（由 `tests/inject-db-dir.test.cjs` 锁定）。
9. **短路与隔离**：`ZCODE_USAGE_DB` 已设时，导入 token_rate 不读取任何 `config.json`（规则 7）。
10. **不回归**：`tests/test_db_path_resolution.py`、`tests/test_token_rate_db_override.py` 与 `tests/inject-db-dir.test.cjs` 全绿。
