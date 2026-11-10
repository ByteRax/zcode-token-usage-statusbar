---
name: zcode-prd-to-spec
description: "面向 zcode-token-usage-statusbar 项目，将功能需求、UI 调整、统计口径或配置扩展转成基于当前源码的技术方案与验收标准，并按用户意图推进实现。用于「细化需求」「把 PRD 转成技术文档」「实现这个需求」「新增一个选项」等请求。兼容 ZCode、Claude Code、Codex：显式 plan 或只要方案时只读分析；普通会话按用户意图分流；要求实现时完成代码、适用检查及本地运行目录部署与热重载验证。"
---

# ZCode 需求转技术验收与实现

先查当前项目源码与规则，再澄清影响产品行为的歧义，建立可验证的技术方案与验收标准；按会话约束输出方案或完成闭环实现。保持单文件可用，不依赖额外安装的工具或固定客户端版本。

## 1. 确定目标与执行边界

1. 确认工作目录属于 `zcode-token-usage-statusbar`，记录分支/提交（若可用）及相关未提交差异。区分当前检出、其它工作树（`.worktrees/`）、仓库内插件副本、稳定运行目录（`~/.zcode/zcode-token-usage-statusbar/`）、宿主插件缓存和正式 Release。没有项目源码时，先询问路径或仓库及目标版本；可先给待核对的需求草案，不编造项目事实。
2. 读取当前环境实际提供的模式、权限和工具。宿主的只读/实现模式只在明确提供时采用；Claude Code、Codex 按各自会话约束执行，不从工具名、模型名或用户随口提及的「plan」推断已切换模式。
3. 按下表分流；宿主只读限制始终优先于实现请求：

| 当前约束与用户意图 | 执行动作 |
| --- | --- |
| 显式只读模式，或要求分析、方案、验收文档 | 只读检索并在对话输出方案；不改业务代码、不同步副本、不部署。仅在用户明确要求保存文档时按允许路径保存 |
| 普通会话且用户明确要求实现 | 需求清晰后直接实现、检查并完成适用的本地部署验证，不把文档作为任务终点 |
| 普通会话只要求细化需求 | 在对话中输出方案与验收标准，不把它理解为实现授权 |
| 意图仍无法判定 | 只询问「本次只出方案，还是同时实现」；等待期间继续不依赖答案的只读调查 |

沿用当前会话已确认的决定，不重复询问。实现任务默认包括目标明确且符合项目保护规则的本地运行目录部署与热重载；不自动扩大到远端部署、首次安装/注入、客户端退出或重启、提交、PR、合并、tag、Release 或渠道写入。这些操作按当前明确指令和项目规则处理，已有授权不重复索取：

- 若请求直接针对 GitHub Issue / PR 编号或链接处理闭环，转入或协同 `.zcode/skills/zcode-issue-pr-resolver`（外部输入须经 `triage.py` 净化与 `scan` 隐藏字符扫描）。
- 若实现后用户要求「review 然后合并」「审查后合并」或创建/合并 PR，衔接 `.zcode/skills/zcode-review-fix-merge`。
- 若用户要求打包、打 tag、发布 GitHub/GitCode Release 或更新渠道清单，衔接 `.zcode/skills/zcode-github-release`。

## 2. 建立最小源码证据

先读当前根 `AGENTS.md` 和宿主适用的指令，再按路径读取 `.zcode/rules/`。以下只是检索入口，以当前文件及规则索引为准；引用规则按主题定位章节、不依赖固定章节号，也不要求所有需求都读取全部规则：

| 需求涉及 | 规则入口 |
| --- | --- |
| 套餐额度、额度 chip、额度源、SCNet、`src/quota/*.cjs` / `quota-client.cjs`、`model-puller.cjs` 路径共源 | `.zcode/rules/quota.md` |
| 桌面浮层、统计行、tooltip、设置面板、双轨配置或展示口径（`src/overlay/*.js` / `overlay.js`） | `.zcode/rules/overlay-ui.md` |
| 安装、注入、同步、运行目录、更新器、`pending_zip_patch.py` 或发布链 | `.zcode/rules/install-release.md` |
| renderer 桥、窗口/分栏归属、远端查询 | `.zcode/rules/bridge-remote.md` |
| 宿主引擎 bundle 排查、自动压缩阈值、单请求 vs 本轮速率口径对照 | `.zcode/rules/host-engine.md` |
| 测试夹具、替身陷阱、数据库排查或实机验收 | `.zcode/rules/tests.md` |
| Git、分支、工作树或并行会话协作 | `.zcode/rules/repo-workflow.md` |
| 文档、本地化、宣传图（`docs/promo/`、`docs/tour/`） | `.zcode/rules/docs.md` |

规则不存在时检索当前等价说明；缺少会影响决策的关键契约才提问，不把缺文件等同于没有约束。

- **按链路追踪证据**：优先用 `rg` / `grep` 定位标识符及调用点，沿「输入/持久化 -> 生产者 -> 传输（IPC/JSON/stdout） -> 消费者 -> 展示/清理」追踪相关链路，读取已有测试及配置读取实现。仅查看需求相关字段，不倾倒凭据、个人数据库或完整诊断文件；**忽略 `.zcode/plans/` 下的历史过程方案草案，不将其当作现行代码契约依据**。
- **跨层并发只读探索（可选）**：当需求横跨多层（如同时涉及 `usage_stats.py` / `zusage.py` / `token_rate.py` / `token_pricing.py` 数据计算、`inject-main.cjs` 主桥 IPC、`src/quota/*.cjs`（`quota-client.cjs`）额度与 `src/overlay/*.js`（`overlay.js`）浮层）且宿主支持子代理时，可在同一轮并行派发只读 subagent 分片检索源码与既有测试，主会话汇总证据。
- **核实真实代码而非仅看模板**：核实实际配置键、默认值、枚举、IPC/JSON 字段、SQLite 类型、DOM 挂载、本地化入口、同步清单和测试命令。`config.example.json` 是模板，不能代替实际默认值逻辑（如 `readCfg()` 或各模块读取实现）。查宿主客户端行为时，以引擎 bundle（如 macOS `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`）为最高证据，检索 bundle 须加 `LC_ALL=C grep -a` 并同时查 kebab-case 与 camelCase。
- **标注可复核位置**：为关键结论标注可复核的 `文件:行号` 或符号；严格区分「已证实的现状」「拟新增的设计」「待确认」。新字段可以提出，但不得称为已有；未读取的文件不得引用虚构行号。
- **源码与文档冲突处置**：文档与源码不一致时，用源码、契约测试及必要的宿主证据解释现状，并修正本次涉及的文档。源码现状不自动否决用户要改变的产品行为；安全、身份或统计不变量的变更需单独判断。

## 3. 只澄清会改变结果的问题

检索后判断是否存在会改变默认行为、统计含义、持久化、兼容性或作用范围的真实分叉。默认值、单位、颜色口径、桌面/CLI/MCP 边界等能从明确需求或既有行为确定时直接沿用；变量名、代码组织等可逆实现选择自行处理，不为凑齐模板提问。

必须先提问澄清的情形：

- **同一需求存在多种对用户可见且无法从上下文判定的解释**：例如「显示剩余额度」究竟切换百分比、金额/次数还是两者，是否连同进度条方向与警戒色阶（`zu-qseg` 三档绿/黄/红阈值）含义一起改变；或新增设置项存放在窗口级 `localStorage`（`zusage3.*`）还是跨进程 `config.json`。
- **要求触及项目核心契约而未明确授权变更**：例如触及身份隔离、凭据只留内存、统计不重复计数（`input` 已含 `cache_read`、`output` 已含思考）、失败 fail-closed 等契约。此时给出契约证据、影响和可行替代，请用户拍板；不把既有明确决定再次当成未决问题。
- **无法定位关键源码目标或存在受保护冲突**：无法定位关键源码目标或协议，继续会改错对象。运行目录不明只阻止部署，不阻止独立的源码实现；完成只读定位后仍有目标歧义或受保护差异无法解决时，询问所缺信息或处理决定。

每轮集中询问少量高影响问题，给出推荐选项及行为差异。等待期间继续独立的只读调查；有未决项时可输出已确定部分和带编号的问题，不给依赖未决答案的实现贴上「已确定」标签，也不先写相关代码。

## 4. 生成按需精简的技术验收文档

先以一句话说明用户要获得的行为，再按以下结构在对话中直接输出。小改动可合并段落；与需求无关的数据库、网络等条目省略或标为不适用，不机械扩展范围。实现任务可用简短计划和验收清单承载同样信息，无需先发送长文等待确认。

### 4.1 目标、现状与作用范围

- **需求编号与目标**：为需求分配 `R1...`，写明当前行为（附 `文件:行号`）、目标行为和必须保持的不变项。
- **改动落点与多端适用性**：列出改动文件及证据（若涉及 `overlay.js` 或 `quota-client.cjs`，标明对应的 `src/overlay/*.js` 或 `src/quota/*.cjs` 分片源码及拼接产物）、配置/协议生产者和消费者、共享清单（`sync_plugin.py`）归属、文档与本地化影响；分别判断桌面浮层、CLI、MCP 的适用性。

### 4.2 输入条件与数据契约

- **双轨配置契约（如涉及）**：
  - **窗口/渲染层 `localStorage`（`zusage3.*` 命名空间）**：用于纯前端 UI 偏好、显隐项、样式模式、单位进位、语言（`zusage3.lang`）等即时重绘生效、无需跨进程落盘的状态。
  - **跨进程 `config.json`**：用于主桥、常驻 Python、额度客户端共同消费的配置（如 `hot_reload`、`quota_enabled`、`plugin_auto_update`、`restart_notice`、`pricing.*`、`remote.*`、CLI `lang`）。
  - **三态与默认值方向**：写明键名、类型、枚举、默认值、生效范围、旧值迁移及失效策略。严格区分**缺字段（取默认）、非法类型（回退默认或忽略，不崩溃）、显式 `false`、合法 `0`**；注意本仓多处布尔开关采用「缺省开启、仅显式 `false` 才关闭（`!== false`）」（如 `quota_enabled`、`answer_rate_line`、`restart_notice`），而 `plugin_auto_update` 在损坏或非布尔值时严禁启动，禁止不查实现就随意用 `Boolean(v)` 或 `value || default`。
- **数据与协议输入**：列出所有输入字段（SQLite 表字段、主桥 IPC 请求/快照字段、DOM 属性或套餐额度源字段）、类型、单位、来源、身份、时间口径、可空性、缺省回退值及新旧生产者/消费者组合。必要时给最小 JSON 示例，不输出真实凭据。

### 4.3 业务规则与状态流转

- **计算与转换逻辑**：公式、舍入顺序、精度、零分母、超限/负值的既有处理。例如 `100 - pct` 仅适用于同一额度窗口的有效已用百分比，且档位色按原始值判定而非显示取整值；未知、错误或不适用不能参与计算，超限数据不擅自截断。
- **交互与多形态布局适配**：触发动作、状态流转、持久化、刷新链路和最终可观察结果；涉及浮层 UI 时分别检查**默认工具行后挂载、药丸样式（pill mode）、精简样式（compact，`.zu-tsb`/`.zu-ctxb` 挂 `[data-composer-trailing-actions]` 左侧且走实例自绘 tip）、窄窗收缩渐隐**、深浅主题、键盘操作与无障碍属性（`aria-*`）。
- **挂载还原与样式脱钩**：挂在原生上下文按钮（`data-testid="chat-context-usage-trigger"`）旁的额度 chip 与原生上下文按钮增强，须遵守 `render` + `heavy` 双 reapply 与卸载还原契约；额度分段统一走 `zu-qseg` 专属类（绿/黄/红三档视觉），与全局速度 `.ok` 类脱钩。
- **本地化与文案纪律**：不假设各端共用 `L(zh, en)` 或同一语言开关（桌面用 `zusage3.lang`，CLI 用配置 `lang`；`token_rate.py` 逐问速率行标签恒为中文）。宣传与功能文案禁用「实时」（实为入库后计算或字符增量估算）。

### 4.4 边界情况与生命周期

- **空数据与极限值**：新会话无记录、`0` 值、`100%` 满额/耗尽、超大数值（万/亿进位）、窄窗挤压、旧版本快照缺字段向后兼容（热文件 `overlay.js` 先于主进程子模块或冷文件 `inject-main.cjs` 生效时对新增字段判空降级）。
- **并发与生命周期**：快速连续切换、连发提问未入库（`started_at >= prompt_ts` 严格过滤无容差）、多窗口并发写配置锁、迟到异步响应（epoch/SID 守卫丢弃过期载荷）、分栏身份切换、热重载/导航/窗口关闭后的监听器与定时器清理（超时兜底定时器须在 `.finally()` 清理并 `.unref()`），以及重复注入幂等（`window.__zusageGen` 代际守卫，`rAF` 自调度异常保护，原地更新诊断对象不替换闭包引用）。
- **跨平台兼容**：Python 3.8 语法与标准库下限、Windows（缺 `python3` 别名、Microsoft Store 存根退出码 49、PowerShell UTF-16LE `EncodedCommand` 引号转义）与 macOS（Squirrel `pending_zip_patch.py`、`/var` 符号链接与 `--runtime` 禁 `Path.resolve()`、探测 `/Applications/ZCode.app` 捕获 `OSError`/`PermissionError`）/ Linux 路径及进程差异。

### 4.5 异常处理与按域隔离（Fail-Closed）

- **统计与费用数据域**：保留当前 `input + output` 口径，不把已包含的 `cache_read` / 思考 token 再次相加；`zusage.py` 与 `token_rate.py` 的公共速率/窗口计算统一收口在 `usage_stats.py`，预估费用由 `token_pricing.py` 按同一口径生产 `cost_usd`/`fx`；各时间窗口（自然日闭区间 vs 滚动窗口）与三处速度口径（前端生成中字符增量估速、状态条完成态会话加权均 `avg_tps` vs 最近一轮、`turn-stats.js` 回答末尾本轮有效段加权速率）按各自生产链核对，不跨域强行统一公式。`zusage.py` 子查询列须带 `m.` 表前缀防同名列歧义降级。
- **会话与远端统计域**：按本窗口实际 `SessionPane` 节点的可靠 SID 与 `workspaceIdentity` 匹配（`data-zusage-scope-*` 属性，注意 `"draft"` 预热态）；无桥且本窗无任何远端证据（`remote_evidence === false`）时才按本地显示，有远端证据或身份不在可信 workspace IPC / 与 tasks 矛盾 / 过期载荷时一律 fail-closed，不得借本地、其它窗口或其它分栏数据。最近成功值只复用到同一可信身份并标记过期。
- **套餐额度域**：按账号/供应商/来源（含 `family:<providerId>` 复合源，经 `adapterOf(id)` 与 `rememberProvider` 维护）及有效窗口判定；解密失败、`no_plan`、`parse_error` 一律 fail-closed，**绝不伪造或显示 `0%`**。真实零额度（如 DeepSeek 合法零余额）、未知、无套餐、团队套餐「暂不支持」、未配置/暂不支持（chip 中性灰提示，仅 `disabled` 隐藏）、保留旧值且标 `stale` 应可区分。凭据变化与 401/403 冻结/退避按 `src/quota/`（`quota-client.cjs`）现有状态机执行。不把远端统计的隔离规则机械套到账号额度（SSH 远端分栏按当前契约直接显示同账号本地额度）。
- **诊断与配置事务安全**：诊断沿用 stderr 或 `diag-*.json` 并脱敏，凭据只在内存（`quota-secrets.json` 0600 write-only，下发状态 `apiKey` 恒空）；CLI 普通报表、JSON 快照、hook JSON、MCP stdio 各守原契约，机器协议 stdout 绝不混入日志或提示。配置更新沿用 `runtime_lock.py` 锁内重读、合并和同目录原子替换，保留未知键及用户设置；损坏或非对象配置不默默重建。

### 4.6 验收标准与对应表

将原始需求中模糊的形容词（如「快速」「友好」「鲁棒」「实时」）转化为可观察、可验证的具体状态或指标：

| 验收编号/需求 | Given：前置条件 | When：操作/输入 | Then：可观察结果 | 验证方法与位置 |
| --- | --- | --- | --- | --- |
| AC1 / R1 | 明确初始数据、配置与身份 | 一个可复现动作 | 确切数值、文案、DOM/协议状态 | 已有或拟新增用例/实机步骤 |

- 按需求覆盖正常、缺字段/非法值、零值/耗尽、身份变化、快速操作、旧版本兼容和热重载场景；不为无关场景增加冗余测试。每项需求至少对应一条验收，标明自动化测试与实机验收各自能证明什么。
- **严禁虚构性能时限**：数值时限必须来自明确产品要求、当前源码实现（如主桥 mtime 轮询：`hot_reload:true` 时 2000ms、缺省 5000ms；额度退避阶梯 30s -> 2min -> 10min）或实测。没有依据时写可观察的完成条件及测量办法，不凭空承诺「1 帧」「2 秒内必生效」；轮询间隔不等于端到端完成上限。

## 5. 实现与验证闭环

仅在实现分支执行；方案分支在输出文档及必要未决问题后结束。

1. **保护基线与并行会话隔离**：
   - 动手前核对 `git status`、相关未提交改动和副本差异，保留用户及其它并行会话的修改，严禁使用 `git checkout --` / `git reset --hard` 抹掉他人改动；按 `.zcode/rules/repo-workflow.md` 先 `git fetch fork` 比对 `fork/main`。
   - 若主工作树存在其它并行会话正在修改的共享文件、或本次改动较大/需独立提交，优先按 `.zcode/rules/repo-workflow.md` 在项目根创建独立工作树（`git worktree add .worktrees/<名> -b <分支> fork/main`）隔离开发。
   - 只实现本次需求范围，不顺手重构、不引入无关依赖。
   - 若新增或改名分发文件，必须同步 `.zcode/rules/install-release.md` 的「分发文件登记」小节列出的完整登记链（`sync_plugin.py` 的 `FILES`、`release_tool.py`、`release_unpack.py` 的 `PLUGIN_FILES`、`overlay_install.py` 与 `install.py` 的 `RUNTIME_FILES`、`overlay_install.py` 的 `cold_files`、`restart_notice.py` 的 hashes 白名单、两份 `plugin.json` 的 `packageLayout.files` 及 `tests/test_plugin_package.py` 等契约测试；`python3 sync_plugin.py --verify-manifests` 会自动校验这 6 处清单的一致性）。
2. **先复现关键行为并避开测试替身陷阱**：
   - 缺陷修复尽可能增加会在旧实现失败的隔离回归（先红后绿）；新功能验证可观察行为。纯文案/样式等低影响修改按风险验证，不强求为每次变更写测试。
   - 沿用现有测试接缝（见 `.zcode/rules/tests.md` 的「隔离接缝与替身陷阱」「假绿灯反模式」两节）：
     - 避免用 `assert.match(source, ...)` 源码字符串匹配冒充行为验证；
     - Node VM 切片测试优先复用 `tests/helpers/overlay-extract.cjs`（`getNamedSlice`/`sliceOverlay` 切 `overlay.js`，`getInjectSlice`/`sliceInject` 切 `inject-main.cjs`），避免手写脆弱的 `indexOf`/`slice`；
     - Python 测试跨文件共享夹具一律从 `tests/helpers/py_test_support.py` 导入（`load_module`、`make_asar`、`cached_plugin_runtime_bytes`、`cached_head_bytes`），禁止 `from test_xxx import ...` 裸同级导入导致单文件独立运行失败；
     - 生产代码与测试中的超时兜底定时器必须在结算后通过 `.finally(() => { if (typeof clearTimeout === "function") clearTimeout(timer); })` 清理并调用 `timer.unref?.()`，防止挂住 Node 事件循环；
     - 注意 `ZCODE_USAGE_DB` 仅隔离插件逐问脚本 `token_rate.py`，测根 `zusage.py` 须用夹具替换数据库入口；
     - 修改 `overlay.js` 时注意 `tests/overlay-port-patches.test.cjs` 等源码切片测试的上下文依赖，以及 `tests/overlay-bridge.test.cjs` 中 `.zu-live` 替身每次 `querySelector` 从 `innerHTML` 回放 class/text、持有旧引用不重查仍会陈旧的接缝；
     - Python 新增测试方法勿落在 `if __name__ == "__main__":` 之后，跑完用 `-v` 确认新用例名实际被收集执行；
     - 修改 `commands/*.md` 或 `skills/*/SKILL.md` 的 frontmatter 时，遵循 `tests/test_command_frontmatter.py` 与 `tests/test_plugin_package.py` 白名单及契约断言。
3. **修改权威源码**：
   - 共享文件先改根源码：其中 `overlay.js` 必须改 `src/overlay/00..12.js` 分片（`VERSION` 在 `src/overlay/06-instance-dom-and-styles.js`），`quota-client.cjs` 必须改 `src/quota/00..05.cjs` 分片，`zusage.py` 与 `token_rate.py` 共用的计算逻辑改 `usage_stats.py`；插件专有入口（hooks、commands、manifest、`overlay_install.py` 等）直接改本体。
   - 保持 Python 3.8+ / Node / Electron 兼容目标并说明实际验证版本；开发机较新解释器通过不等于已验证所有平台或 Python 最低版本。
4. **先定向检查，再安全同步副本**：
   - **同步前必查并行污染**：`python3 sync_plugin.py` 会先运行 `scripts/build_overlay.py` 与 `scripts/build_quota.py` 拼接生成根 `overlay.js` 和 `quota-client.cjs`，再扫描全部 `FILES` 清单同步至插件目录并执行 `--verify-manifests`；执行前先确认根目录下其它共享文件没有并行会话未完成、未验证的改动，防止把他人半成品一并扫进插件副本和运行目录。确认安全后执行 `python3 sync_plugin.py` 与 `python3 sync_plugin.py --check`，再运行语法检查与契约回归。
5. **检查版本台账、文档与宣传图**：
   - 按当前 `.zcode/rules/overlay-ui.md` 在 `src/overlay/06-instance-dom-and-styles.js` 维护 `overlay.js` 的 `VERSION` 代际台账（随提交递增，注释与声明同步，号段不要求连续；并行撞号按合入顺序顺延改号并合并注释后再执行 `python3 sync_plugin.py` 与提交）；未提交的中间迭代不反复涨号，未获提交授权不为涨号自行提交。
   - 配置、默认值、协议或可见行为变化时同步 `config.example.json`、三语 `README`、`docs/user-guide.md` 及插件文档，保持各自适用范围；文档中不写死会漂移的用例数或清单长度。
   - 若改动影响浮层挂载、外观、单位或面板结构，按 `.zcode/rules/docs.md` 检查是否需重拍 `docs/promo/` 与 `docs/tour/`（`shoot.py` 自检 `problems:[]` 清零），且绝不改名或移动冻结路径 `docs/promo/icon.webp`。
6. **失败即定位、重测与可选对抗式自审**：
   - 区分本次引入、环境基线失败（如依赖本机已安装客户端 `app.asar` 的用例随客户端升级变红）、平台跳过与环境受阻。修复本次缺陷，不删断言、跳过关键用例或吞异常换绿灯。
   - 跨模块或复杂状态机改动完成后，若环境支持子代理，可派发独立只读 subagent 在临时克隆目录（`mktemp -d`）做变异式测试审查（故意改坏新逻辑验证测试是否变红）与契约复核；写操作统一由主会话收口。

基础命令示例仅在当前仓库存在、解释器与 shell 支持时采用；最终以当前项目规则和文件为准：

```bash
# 确认根目录下其它共享文件无并行未验证改动后，先拼接 src/ 分片并同步副本与校验清单：
python3 sync_plugin.py
python3 sync_plugin.py --check
node --check overlay.js
node --check inject-main.cjs
node --test tests/*.test.cjs
python3 -B -m unittest discover -s tests -p 'test_*.py'
```

这是检查工具箱，不是所有需求一律执行的脚本顺序。检查本次其它 `.js/.cjs/.py` 改动（如 `turn-stats.js`、`quota-client.cjs`、`model-puller.cjs`、`engine-patch.cjs`、`plugin-updater.cjs`），不能只查上列两文件。跑 Python 测试带 `-B` 与 `PYTHONDONTWRITEBYTECODE=1`。Windows 不假定 `python3` 别名或 shell 通配符展开；选择已核实解释器并显式列出测试文件。项目没有统一 build/lint 命令时不虚构命令。纯文档不触发安装、部署或发布。

自动化测试用临时数据库、目录及隔离环境（如 `ZUSAGE_PLUGIN_RUNTIME` / `ZUSAGE_PLUGIN_ASAR`），不接触个人数据库（真库默认 `~/.zcode/cli/db/db.sqlite`，跟随宿主 dataBaseDir 迁移；注意 `~/.zcode/db.sqlite` 为 0 字节空文件勿误用）或真实插件库存；真实宿主 CLI/模型测试可能联网及消耗额度，按当前指令与项目规则另行处理。报告实际命令、结果及跳过原因，不把语法检查或 stub 测试当作 Electron 实机验收。

## 6. 默认完成本地部署与热重载验证

实现任务在适用检查通过后主动执行本节，不等待用户再次要求。只修改文档、测试或素材时不部署；远端、MCP 的生效流程按各自规则处理，不套用桌面热重载。

1. **定位真实加载目标**：结合客户端 `app.asar` 注入行引用、客户端进程与来源基线确认实际加载的 `inject-main.cjs` 路径（通常为 `~/.zcode/zcode-token-usage-statusbar/`），区分根源码、插件缓存与稳定运行目录。`--dev` 开发模式已直接加载当前源码时不重复复制。尊重显式 `hot_reload:false`，不擅自改配置开关。
2. **比较并保护运行目录差异**：部署前先 diff 运行目录文件、来源基线和本次变更，识别运行目录热修、较新版本与其它并行会话写入（运行时可能领先当前工作树，直接覆盖会导致静默降级）。只部署本次已验证文件；遇 `preserved`、来源身份不符或无法安全合并时停止相关文件部署并说明阻碍。严禁整目录覆盖、借重装绕过保护或删除锁文件。
3. **备份与原子替换写入**：按 `.zcode/rules/install-release.md` 先将受影响运行文件备份为 `.pre-<原因>-<时间戳>`，经同目录临时文件、适用语法检查（如 `node --check`）后原子替换（`mv` / `os.replace`），保留权限并确保 mtime 更新以触发文件监听。`overlay_install.py sync` 是全名单同步、无单文件参数，仅在来源身份匹配且全部待同步差异都属于本次已验证范围时使用。
4. **按热/冷清单判断生效方式**：
   - **渲染端与常驻 Python 热文件**：`overlay.js`、`turn-stats.js` 部署到实际加载目录后由主桥按 mtime 轮询（`hot_reload:true` 时 2s、缺省 5s）自动重注入；`zusage.py` 由主桥发现变化后自动重启常驻 Python 子进程（注意：若单独修改被导入的 `usage_stats.py` 或 `token_pricing.py` 等子模块，主桥仅监听 `zusage.py` mtime，需连带更新 `zusage.py` mtime 或确认常驻 Python / MCP 子进程已重启）。
   - **主进程热换子模块（v258+）与冷文件**：六个主进程子模块（`quota-client.cjs`、`model-puller.cjs`、`plugin-updater.cjs`、`plugin-release.cjs`、`plugin-storage.cjs`、`engine-patch.cjs`）在新版 loader（含 `hotReloadMainModules`）下部署后下一个热 tick 内自动热换并经 `_hotLoadedAt` 销账 marker；旧版 loader 下仍需重启。`inject-main.cjs`、`pending_zip_patch.py`，以及首次注入、加载路径或 `renderer_bridge.py` 宿主 asar 补丁变化，恒为冷文件，须先确认已安全部署到实际加载目录，再向用户报告待完全退出并重启 ZCode，不自行退出或重启客户端，也不把未部署文件交给用户靠重启解决；MCP 已导入模块另按对应 MCP 进程重启判断。
5. **收集运行证据**：部署热文件前记录基线，在实际轮询周期后核对同一 renderer 未导航、未刷新时的 `window.__zusageGen` 递增（或常驻 Python 进程 PID 更替及启动日志），随后复测目标行为与新增控制台错误。注意：**文件 hash 一致只证明已落盘；单条触发日志、刷新页面或可能滞后数分钟的 `diag-*.json`（约每 15 次拉取才落盘，`diag-0.json` 为非活跃窗口）均不能单独证明热重载成功**。
6. **验证真实 UI**：优先连接实际运行的 ZCode/Electron 窗口或项目认可的宿主通道，tooltip/悬停卡使用真实指针验证。外部无头 Chromium、VM/stub 只能证明各自覆盖的逻辑，不能代替宿主的真实 DOM 布局、交互和热重载证据。

没有客户端或可用通道时，完成能做的检查并如实标记「未部署」「未触发」或「未验证」及原因。仍有安全的只读定位手段时继续调查，不以「尚未确认路径」草率结束，也不为了获得证据擅自启动新实例、登录或产生真实模型调用。

## 7. 按证据交付

简要说明目标行为、关键改动、已完成验收、失败/跳过/待验证项。方案任务列出源码依据、确定方案及剩余问题；实现任务附文件位置和实际检查结果。若实现偏离原方案，先更新验收清单，不能只改代码不改判据。

涉及部署时逐文件或按同状态文件组报告：

| 文件/组件 | 源码与插件副本 | 运行目录部署 | 运行生效证据 | 后续动作 |
| --- | --- | --- | --- | --- |
| 实际改动文件 | 已同步 / 不适用 / 受阻 | 已部署 / 直接加载 / 未部署 | 热更及目标行为已验证 / 未验证 / 冷文件待重启 | 具体阻碍或必要操作 |

只有对应证据齐全，才声称该层完成。自动化通过、文件同步、部署成功、热重载成功和功能验收通过分别判断；存在未决契约、关键失败或实机证据缺口时，不宣称「全部通过」。若后续进入 PR 审查合并（`zcode-review-fix-merge`）或正式发版（`zcode-github-release`），可将第 4.6 节验收结果与本节冷/热文件生效结论直接转化为 PR 的「发版说明素材」块。
