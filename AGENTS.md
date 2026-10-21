# 项目维护指南

面向在本仓库修改代码的 AI 助手。全文以**当前检出源码及测试**为依据，不把本地源码、其它工作树、插件缓存或正式 Release 当成同一版本。

## 1. 项目定位与环境

- 为 ZCode 显示模型速度、token 用量和上下文占比；数据来自本地 SQLite，不是供应商账单或套餐余额。
- 技术栈是 Python 标准库、原生 JavaScript、Electron 主进程 CommonJS，以及 Web 旁挂 HTTP 服务；不是 npm 前端工程。
- 桌面插件是**安装与查询渠道**，不是原生状态栏扩展：最终仍向客户端 `app.asar` 注入稳定运行目录的加载器。
- 独立安装器和插件共享注入/运行链；CLI、`/usage`、stdio MCP 可独立查询，纯 CLI 没有状态条 UI。
- Web 是单独部署方案，需要控制自托管 ZCode、nginx 和旁挂服务，不能用桌面安装器修改浏览器或官方托管网页。
- 用户运行要求：Python **3.8+**，包含标准库 `sqlite3`，无额外 Python 包；桌面主要支持 Windows/macOS，Linux 有路径与权限适配，但不等于所有发行版已实机验收。
- 桌面 `.cjs` 由客户端 Electron 的 Node 环境运行，不要求用户另装 npm 依赖；从 Git 克隆源码才需要 Git。
- 开发测试需要可运行 `node:test`、`node --check` 的 Node，以及 Python；根目录没有 `package.json`、`engines` 或统一 Node 最低版本声明，不虚构 build/lint/format 命令。
- Web 文档列出 Node 22.19+ / 24+、nginx、systemd；当前 sidecar 实际调用 Python 查询，不使用文档提及的 `node:sqlite`。该版本值是部署文档要求，不是已验证的代码最低门槛。
- Python 3.8 是兼容目标，不代表全仓已在 3.8 运行验证；新增语法/标准库 API 要检查最低版本，不能仅凭开发机较新解释器通过就宣布兼容。

## 2. 代码地图与调用边界

| 文件/目录 | 维护职责 |
|---|---|
| `zusage.py` | SQLite 查询库、CLI、桌面 JSON 快照、常驻 JSON 行查询与带身份的远端查询 |
| `usage_mcp.py` | stdio JSON-RPC MCP；调用 `zusage`，提供 `token_usage(scope)` |
| `plugins/zcode-token-usage-statusbar/token_rate.py` | 插件专有逐问速率、提问身份守卫与会话累计查询 |
| `overlay.js` | 桌面浮层、设置、tooltip、子代理明细及已入库速率展示 |
| `inject-main.cjs` | 主进程加载、窗口/工作区 IPC、查询泵、文件监听、快照推送和受限写操作 |
| `install.py` | 独立安装/卸载、运行文件、配置、独立 MCP 与 `/usage` 注册 |
| `patch_install.py` | asar 定位、注入/移除、自检、原子替换及待替换文件 |
| `install_monitor.py` | 重启提醒、加载诊断和 Windows 待替换收尾 |
| `plugin-updater.cjs` / `plugin-release.cjs` | 宿主插件更新调度、正式 GitHub Release 与渠道校验 |
| `plugin-storage.cjs` | 按宿主存储解析用户级插件库存/缓存，不假设固定 HOME |
| `quota-client.cjs` | 套餐额度客户端（主进程，冷文件）：解密宿主 OAuth 凭据（`enc:v1` AES-256-GCM 重写实现）直查 BigModel/Z.ai monitor 端点，归一化窗口/退避/冻结/epoch 竞态，凭据只在内存 |
| `runtime_lock.py` / `release_unpack.py` | 跨进程锁、配置事务/可信同步、安全 ZIP 解包 |
| `sync_plugin.py` / `release_tool.py` | 根源码副本同步；确定性发布包构建、校验、发布预演/发布 |
| `plugins/zcode-token-usage-statusbar/` | 两份 manifest、`.mcp.json`、命令、技能、hooks、专有安装/更新/提醒入口与共享副本 |
| `web/` | `boot.js`、独立 `overlay.js`、`zusage-sidecar.mjs`、`readonly-guard.py`、nginx/systemd 示例 |
| `tests/` / `docs/` | 隔离回归、宿主 CLI 沙箱/交互演示；使用、设计、维护及宣传资料 |

本检出包含 `usage_stats.py`、`turn-stats.js`、`renderer_bridge.py`、`renderer_live_check.cjs` 与根目录 `token_rate.py`；不要从其它工作树补出本检出不存在的架构。

关键调用链：
- 桌面入口以绝对 `file://` 动态 `import` 引入 `inject-main.cjs`；主桥调用 Python，监听数据库及 WAL 变化，按窗口推送快照给 `overlay.js`。
- 渲染端通过宿主会话/工作区 IPC 与本项目 scope 上报维持窗口和分栏身份；查询请求为 `{sids, scopes: [{sid, workspaceIdentity}]}`，响应 `recent` 携带 `workspace_identity`。
- 工作区/任务 IPC、活动 SID IPC 与配置/更新写操作的校验不同；不能概括全部桥接同等可信，写操作保留本地窗口验证和固定动作白名单。
- MCP 与 CLI 使用查询库；插件 `.mcp.json` 直接启动包内 `usage_mcp.py`，不是统一 `run.py` 入口。
- `hooks/session-start.py` 负责运行文件同步、更新/自动安装及提醒；`hooks/prompt-submit.py` 记录本会话提问时间并提供统计指令，速率查询使用包内 `token_rate.py`。
- 专有入口是 `overlay_install.py`、`plugin_auto_update.py`、`restart_notice.py` 等；改变 hook 返回值应检查宿主 CLI 契约，不以手工执行代替自然事件验收。

## 3. 源文件、副本与正在运行的文件

- `sync_plugin.py` 的 `FILES` 是共享分发清单，根目录是源：
  `usage_mcp.py`、`zusage.py`、`patch_install.py`、`install_monitor.py`、`inject-main.cjs`、`plugin-updater.cjs`、`plugin-release.cjs`、`plugin-storage.cjs`、`quota-client.cjs`、`release_unpack.py`、`runtime_lock.py`、`overlay.js`。
- 共享文件先改根源码，再同步插件副本；清单外的插件入口、hooks、命令、技能和 manifest **不是生成文件**，应直接维护。
- `web/overlay.js` 是独立实现，不在插件同步清单内；不能直接复制根浮层覆盖 Web。共享语义变化要分别评估，保留 Web 的挂载、接口与布局差异。
- 共享文件修改后在仓库根运行：

```bash
python3 sync_plugin.py
python3 sync_plugin.py --check
```

- 上述命令只同步**仓库插件副本**，不更新宿主安装缓存或稳定运行目录。
- 标准运行目录是 `~/.zcode/zcode-token-usage-statusbar/`；插件缓存由宿主管理且可能自定义。`--dev` 可让独立安装直接引用仓库，不能移动该仓库。
- 本地市场仍依赖登记的来源目录，不自动 `git pull`；不要一概建议安装后删除 clone。
- **插件到稳定运行目录的同步**有 hash 基线/mtime 热修保护；根 `install.py` 的运行文件复制是直接覆盖，不能承诺同等保护。首次注入、路径变化、`inject-main.cjs`、`quota-client.cjs` 或 updater/release/storage 主进程文件变更需完全退出并重启；可热更新文件也须确认实际加载路径。

## 4. 开发与兼容性约定

- 保持修改聚焦，沿用现有原生代码与注释密度；不为统一风格引入框架、依赖或大规模重构。
- `.js` 浮层是注入浏览器的脚本；`.cjs` 是 CommonJS。客户端入口可能是 ESM，注入行必须动态 `import`，不能直接 `require`；Web sidecar `.mjs` 是 Node ESM，`boot.js` 是浏览器脚本。
- Python 路径使用 `Path`/已有定位逻辑；`python`、`python3`、`python_path` 与宿主实际可执行命令要区分，Windows 不保证有 `python3` 别名。插件 hooks.json 是 command+shell 回退链 `python3 → python → py -3`（POSIX sh 与 Windows `%ComSpec%`=cmd.exe 都支持 `||`，宿主丢弃成功 hook 的 stderr 诊断）；`.mcp.json` 仍固定 `python3`——宿主对 stdio MCP 按 `shell:false` 直接 spawn 无回退通道，macOS CLT 只有 `python3`，不能整体改名。桌面主桥 `readCfg()` 的 `python_path` 缺省与空值一律归一为平台默认（win32=`python`，其它=`python3`），三个 spawn 点直接读它；注入/安装时会把 `sys.executable` 绝对路径写回配置并在每次 SessionStart 刷新。改这两处前先对当前客户端版本引擎核对 process/command 两种 hook 类型的 schema 与展开语义。
- 保留带空格路径、Unicode、引号与平台进程行为的测试。POSIX shell 用既有 `shlex` 引用；Windows PowerShell 的 UTF-16LE `EncodedCommand` 路径不能简化为裸引号。
- Windows 进程查询沿用 `subprocess` argv 与相应解码，不让 Git Bash 转换 `/FI` 等开关；asar 被占用的收尾必须由宿主以外的监控进程执行，不能依赖 ZCode 自己的定时任务。
- 配置只合并需要的键，不整体覆盖 `config.json`；保留未知键、用户显式关闭与个人路径。插件配置事务在锁内重读、合并，再同目录原子替换；损坏或非对象配置不能被默默重建。
- `config.example.json` 是模板，不可原样执行占位的 Python/SSH 路径。缺字段默认值、非布尔异常值与显式 `false` 不能混为一谈，各开关应读相应实现。
- 自动安装：缺文件/缺字段默认开启，显式 `false` 保留；`ZUSAGE_PLUGIN_AUTO_INSTALL=1/0` 优先配置，但不能越过 `.plugin-overlay-optout`，无环境覆盖时异常配置不开启。
- `plugin_auto_update` 与自动安装是独立开关；损坏或非布尔更新配置不能启动自动更新。
- CLI 普通报表、JSON 快照、hook JSON、MCP stdio 各有输出契约：机器协议的 stdout 不夹日志、安装提示或调试文本；诊断走已有 stderr/诊断文件路径。
- 常驻查询是一请求一行 JSON 的协议；MCP 是 JSON-RPC，不可混用两者消息形状。增字段需兼容生产者、消费者与测试夹具。
- 维护要求：新增定时器、文件/IPC/DOM 监听器、子进程要有明确归属，验证热更新、导航、窗口关闭后的停用，不能声称当前已有完整全局 dispose。
- 保留浮层代际守卫、幂等内容更新、tooltip 解绑/扫描清理；`rAF` 自调度必须异常后续帧，诊断对象原地更新，不替换闭包共享引用。
- 桌面浮层保持 body 级 fixed、样式挂在条内，不进入 React 布局流；几何避开输入框中心点命中检测，避免自遮挡闪烁。条宽跟随卡片并分级收缩，Web 布局另验。
- 配置/更新/安装锁跨 Python 与 Node；OS advisory 锁文件永久保留，不通过删锁文件解锁。更新租约/所有者与旧锁恢复是另一层协议，保留各自规则，不把冲突当成功，也不删运行目录绕过并发或热修保护。
- `.gitattributes` 固定 LF。发现 CRLF 或未提交改动时先保留数据，用干净的独立工作树验证；禁止用强制 reset/clean/重新检出解决问题而丢失用户修改。

## 5. 必须保持的行为契约

### 统计与速率

- 总 token = input + output；input 已含 cache_read，output 已含思考，不能再次相加。缓存命中率为 cache_read / input；轮数用 distinct turn_id，不依赖覆盖不全的 `turn_usage`。
- 速度不是逐字流式读数，主要在请求完成入库后更新。普通请求生成耗时为 completed_at − first_token_at；上报思考或 Claude 请求使用 completed_at − started_at，TTFT 与生成窗口不是同一指标。
- 状态条向前检查最近 20 条请求，取最近有效速度样本；根实现缺首字即拒绝，插件速率对思考/Claude 仍允许 started_at 回退，两者不完全同款。不能用总耗时硬算普通请求速度，也不能把无效样本视作真实 0 t/s。
- 插件逐问速率只聚合本轮有效段，按 Σoutput / Σ生成耗时加权，段间工具等待不计；近 5 请求均值/峰值不是本轮加权值，不能互相替代。
- `--current` 依赖本会话提问状态及 3 秒时间容差，目标是防止旧轮充数；容差内连发且新轮未入库仍有误选边界，不能宣称零歧义。尚未入库的最终正文不在采样内，首段 TTFT、有效段速率和会话累计保持各自口径。
- 上下文占比取最近完成请求 input / 上下文窗口，不是会话累计或历史峰值；压缩后可以回落。子代理按父子关系关联，不按派发时间最近邻猜任务名。
- CLI/MCP `current` 选择数据库最近活跃会话，不保证是屏幕焦点；30 分钟阈值用于 active/idle 判断，不限制只选这段时间内的会话。
- 今日、`days`、`week` 按本地自然日，`models` 从当前时刻滚动回溯；日界线查询采用闭区间，零点存在相邻日重复计入边界。改时间过滤先核对各查询，不擅自统一窗口。

### 套餐额度（v96 起）

- 额度是**账号级套餐池**口径（BigModel/Z.ai 个人编码套餐），不是单模型独享；chip/tooltip 不得出现"模型独享额度"语义。数据来自主进程 quota 字段（`quota-client.cjs` 解密宿主 OAuth 凭据直查 `bigmodel.cn|api.z.ai /api/monitor/usage/quota/limit`），与本地 token 统计是两条链，互不推导。BigModel 另随额度并行拉 `/api/biz/subscription/list` 取订阅元数据（version/productName/valid，tooltip「套餐」行；白名单字段，订单/协议号绝不保留；多条生效订阅或端点失败 → plan 置 null 整行不显示，不拖累额度状态机；zai 暂不拉）。
- 开关真值是 config.json 的 `quota_enabled`（缺省关，只认显式 true）：主进程据此决定是否解密与联网，⚙ 勾选经 pluginRequest 写入并回推。凭据只在内存，发往的域白名单硬编码（bigmodel.cn/api.z.ai），token/请求头绝不进日志、diag 或 config；env `ZCODE_BIGMODEL_USAGE_API_KEY` 优先于宿主凭据。
- 窗口归一化只认 unit 显式分类（3=5h、6=周；未知丢弃留痕），不能按 nextResetTime 排序代替（周期末尾周窗更早重置会标反两桶）；`percentage` 是整数已用%，有绝对量时用 currentValue/usage 自算；TIME_LIMIT(unit=5) 是内置工具期，折叠为 tooltip 行。无套餐是业务信封（"不存在coding plan"）而非 401，须停轮询。
- 401/403 与无套餐冻结到凭据指纹变化：主进程 fs.watch credentials.json（宿主刷新 token 即解冻）；JWT exp 临期不发请求等宿主刷新。失败保留最近成功值并标 stale；解密失败/no_plan/parse_error 一律 fail-closed，绝不显示 0%。
- 显示门控：会话首个完成的 `main_turn`（快照 `last.provider_id`，zusage 已滤辅助请求污染）出现前，chip 跟随快照顶层 `provider_fallback`（全局最近 account:* 请求，消除切模型到首请求完成之间的空窗）；会话最新请求是自定义 provider 时隐藏内置套餐额度。团队套餐显示"暂不支持"。自定义 provider 走余额探测（读宿主 provider_config.json 的 baseUrl+key：官方域名直连 DeepSeek/OpenRouter/SiliconFlow 余额端点，非官方域单轮探测 OpenAI legacy billing；hard_limit≥1e8 视为按量后付无固定池），识别不了的网关隐藏；中转 key/baseUrl 指纹变化解冻 auth_failed。SSH 远端分栏直接显示本地额度——宿主 provisioning 把桌面凭据强制同步覆盖到远端，远端会话与本地同账号（架构事实，宿主改语义需复核）。chip 挂原生上下文按钮左侧（wrapper 内前插），与 v92 按钮增强同款双 reapply/还原契约。
- 额度只进桌面快照链；MCP、CLI、`/usage` stdout 契约不加字段。Web 端不做（sidecar 无凭据）。

### 窗口、分栏与远端

- 状态条以本窗口/分栏 SID 为准，匹配不到的新会话显示零值，不借全局最近会话。隔离键包括 `workspaceIdentity`，同 SID 不代表同服务器数据。
- 主标签页（`workspace-main`）及各分栏的归属只取本窗口实际 SessionPane 节点：`renderer_bridge.py` 按已登记版本、原始资产 SHA256 与唯一 JSX 锚点写入 React 管理的 `data-zusage-scope-version=1`、workspacePath、workspaceIdentity、remoteSessionId、paneId，与原 `data-session-id` 同节点同步更新。共享 last-session、pane-layout、workbench-groups 与 conversation registry 保活历史不构成当前归属证据。读取须校验协议、字段、SID、paneId 与节点存活；明确本地 identity 为空可查本地；无桥/读不到身份且本窗无任何远端证据（`remote_evidence === false`）时按本地记录显示；有远端证据或泵绑定为远端时 fail-closed，不借同 SID 本地快照或其它 pane 远端数据（issue #40）。身份不在本窗可信 workspace IPC 或与 tasks 矛盾时不放行远端；当前节点改变或撤销后迟到载荷丢弃。当前登记客户端为 3.15.3/3.16.1/3.16.2；表内版本资产哈希漂移仍拒绝，表外版本先走 derive_target 严格推导（唯一锚点、注册表/key/topic 绑定、store 形状与 import 目标），校验不过拒绝补丁并降级为 DB 轮询。旧 conversation-only 补丁须升级安装并完全重启，不启用共享记录回退。
- 远端 scope 必须有可靠当前身份。明确绑定身份的分栏与上述当前节点主绑定可路由；归属未知或歧义时 fail-closed，不猜服务器。
- 桌面 JSON 请求中的 `scopes: []` 禁止旧单通道 fallback。旧 CLI SID/逗号列表兼容行为不能扩大为桌面身份推断。
- `remote.auto` 与 `remote.enabled` 独立；彻底关闭需两者为 false。手动目标通过 `identity`/`identities` 绑定并覆盖同身份自动目标，标签不作身份。
- 各目标分别维护 today、错误、缓存与恢复；失败不借本地/其它目标总量，保留同身份最近成功快照并标记过期。null/error 不等于成功，也不应清空最近成功显示。
- 保留持续退避重试、超时/并发预算、配置与连接变化心跳；统计链恢复不等于插件替宿主重连 SSH。
- 远端只需手工部署匹配的 `zusage.py`、Python 和数据库读取权限，通道必须免交互。不能解密复用宿主密码/私钥口令，不自动部署或登录；递归防护不可去除。
- 远端支持限桌面 JSON 查询链；MCP、`/usage`、逐问速率不自动跨机，Web 单独部署。详情见 [远程会话](docs/user-guide.md#远程会话)。

### 安装、数据保护与网络

- 卸载只移除本项目注入，不用旧 asar 备份回滚客户端版本；未注入时移除可成功，但读不到目标不能假装已卸载。
- 插件卸载浮层保留 `.plugin-overlay-optout` 阻止自动重注入和安装提醒，但不关闭运行文件同步/插件更新；仅卸载宿主插件也不保证旧主进程引用/浮层消失。
- 自动安装/修复可能受权限、事件触发、宿主结构影响；成功后仍需重启。不替用户自行重启，不用强制提权掩盖失败；sudo 提示必须保留目标用户 HOME/PATH 和用户产物归属。
- 配置、数据库、诊断、本地热修不是发布素材；可信同步保护用户改动，解包保留路径穿越、链接、重复项和文件集限制。
- 本地统计只读数据库，不上传用量；远端查询使用配置/宿主连接通道，插件更新另行联网下载代码，不能笼统宣称整个插件“不联网”。
- Web 默认 loopback sidecar 向本机 ZCode 校验设备 Cookie；保留 nginx 认证、静态白名单和 systemd 只读限制，不直接暴露公网。`readonly-guard.py` 不改写已含 `mode=rw` 的 URI，不能把包装器当无条件只读安全边界。

### 命令、技能与元数据

- 官方插件文档不等于引擎实现：frontmatter/manifest 新增字段前，先在目标客户端版本引擎源码核对所有暴露通道（桌面 `/` 补全、终端 CLI、非交互）的实际语义再入库。实证先例：`disable-noninteractive: true` 在 3.16.2 被解析为 `disableNonInteractive` 并从桌面协议补全整体排除，而文档只写「非交互禁用」，曾致 `/install-overlay`、`/uninstall-overlay` 桌面失联。
- 插件 `commands/*.md` 的 frontmatter 白名单仅 `description`、`argument-hint`，由 `test_command_frontmatter.py` 守护；`skills/*/SKILL.md`、`hooks/hooks.json`、`.mcp.json` 同样不加未验证字段。放宽白名单前须先补引擎语义证据并更新该测试。
- 手敲完整命令与桌面补全是两条通道：执行路径（parse/load/expand）无字段过滤，补全缺失先查引擎 `listProtocolSlashCommands` 的过滤条件，不要先怀疑安装或重装插件。

## 6. 测试与验证

在仓库根运行；没有构建、lint 或格式化脚本。基础命令：

```bash
node --test tests/*.test.cjs
python3 -B -m unittest discover -s tests -p 'test_*.py'
node --check overlay.js
node --check inject-main.cjs
python3 sync_plugin.py --check
```

- Node 回归以 VM/stub 为主；Python 回归使用临时数据库、目录和夹具。`-B` 避免主解释器写 bytecode，不保证子进程不写；需要时同时设 `PYTHONDONTWRITEBYTECODE=1`。
- `ZCODE_USAGE_DB` 只隔离插件逐问脚本，不能当根 `zusage.py` 的通用数据库隔离开关；新测试沿用夹具替换数据库入口，默认不执行真实查询。
- 首两条是自动化回归，`--check` 是语法/漂移检查，不等于行为验证；无需因仅修改文档而跑安装/发布。
- Node 测试通配符命令适用于会展开 glob 的 shell；Windows PowerShell 请显式列出匹配文件，不能假设 Unix shell 展开行为。部分进程/平台测试会按环境跳过，必须报告。
- 定向 Python 示例：`python3 -B -m unittest discover -s tests -p 'test_token_rate.py'`；Node 示例：`node --test tests/overlay-rate.test.cjs`。范围扩大时再运行上面的全套命令。

| 改动范围 | 验证选择（文件位于 `tests/`） |
|---|---|
| 统计/速率 | `test_token_rate.py`、`test_statusbar_rate.py`、`overlay-rate.test.cjs`；更改共享 JSON 时加入远端及插件契约回归 |
| 套餐额度 | `quota-client.test.cjs`（解密/归一化/状态机/竞态）、`overlay-quota-chip.test.cjs`（挂载/门控/还原）；真实 monitor 响应、凭据刷新解冻与 chip 实机挂载需桌面验收 |
| 浮层/主桥 | `overlay-*.test.cjs`、`plugin-loader.test.cjs`、`plugin-restart-boot.test.cjs`；语法检查，布局/多窗口需桌面验收 |
| SSH 路由 | `test_remote_targets.py`、`inject-remote-recovery.test.cjs`、`overlay-remote-scope.test.cjs`；实机身份/重连与认证另验 |
| 安装/更新/锁/解包 | `test_install_discovery.py`、`test_plugin_sudo_install.py`、`test_pending_asar.py`、`test_config_transactions.py`、`test_runtime_sync_guard.py`、`test_release*.py` 及 `plugin-*.test.cjs`、`runtime-lock.test.cjs` |
| 插件命令/hooks/MCP | `test_command_frontmatter.py`、`test_plugin_contract.py`、`test_plugin_package.py`、`test_plugin_runtime.py`、`test_session_start_channels.py`、`test_restart_notice.py`；共享文件同时同步并检查漂移 |
| Web | 下列语法检查；当前回归未覆盖 Web 端到端，需授权的旁挂/认证/浏览器验收，不能拿桌面测试替代 |
| 文档/本地化 | 路径、相对链接/锚点、JSON 示例、双语对应与 manifest 一致性；涉及默认值/协议时加对应契约测试 |

Web 安全静态检查，不启动服务：

```bash
node --check web/boot.js
node --check web/overlay.js
node --check web/zusage-sidecar.mjs
```

宿主真实 CLI 沙箱测试和交互演示见 [测试说明](tests/README.md)。它们使用真实 ZCode、认证和模型，可能联网/消耗 token，不属于默认纯隔离测试；测试对象必须指向自有临时 HOME、插件库存与夹具。
真实桌面安装会改客户端文件；默认回归不得接触个人数据库、配置、真实插件库存或客户端。语法通过、手工 hook 成功、Windows 收尾夹具通过均不能替代自然 SessionStart/重启/多窗口/远端实机证据。

宿主行为排查与客户端升级体检：

- 查宿主行为以引擎主文件（macOS 桌面为 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`）为最高证据，先 grep 数据的生产函数再追消费链；kebab-case 字段要同时搜 camelCase（如 `disable-noninteractive`→`disableNonInteractive`）。bundle 混淆符号随版本轮换，`plugin-commands-cli-smoke.py` 探测配方失配时修配方，不得退回模拟 catalog。
- 客户端升级后按六项体检：状态条可见（桥指纹登记）、`python3 -B tests/plugin-commands-cli-smoke.py` 通过命令 catalog 断言、技能列表含 `zcode-token-usage`、MCP `token_usage` 可调、SessionStart 同步与逐问速率行出现、tooltip/设置面板正常。
- 回归断言按域拆分、分开报错：真实行为回归（catalog、协议、打包文件集）优先于文档断言；长期红的测试等于没有测试，不得让一个失配域掩盖另一域的新回归。

## 7. 文档、本地化与已知差异

- `README.md` 与 `README.zh-CN.md` 保持一致；`README.en.md` 在功能、限制、安装、发布范围上对应。Web 两份 README 同步维护；英文可链接中文详细文档，但要标明语言。
- 用户可见文案沿用现有字典/语言分支：桌面浮层独立保存 `zusage3.lang` 并跟随 `--font-mono`/`--ui-font-size`，CLI 使用配置 `lang`，Web 跟随宿主语言且布局/字体独立；不能假设共用开关。市场条目保留 `description_i18n`，不为改显示名擅改 slug、市场名、命令或配置键。
- 配置键、默认值、协议、兼容性变更时更新 `config.example.json`、相关 README、[用户指南](docs/user-guide.md)、插件 README/命令/hooks/技能；设计或发布链变化同时检查维护/设计文档。
- JSON 示例不得含注释，路径占位须说明替换；检查仓库相对链接、标题锚点及示例能否解析。
- 当前文档有已知滞后：README 与用户指南的正式自动安装范围不同；README 命名空间命令说明与用户指南裸命令不同；设计笔记的“空闲零进程”、`current` 窗口及“最近一次速度”与常驻/回查实现不完全一致。
- 安装命令文档的 `sudo python install.py` 不适用于仅含插件子树的缓存；Web 文档的 `node:sqlite` 理由和安全文档的全局“不联网”也不匹配当前实现。修改对应领域时结合源码/契约测试核对，不顺手改业务逻辑或宣称正式渠道已有 main 功能。

## 8. 发布与外部操作边界

先读 [开发与发布](docs/maintaining.md#发布插件)、[仓库发布技能](.zcode/skills/zcode-github-release/SKILL.md)及其引用文档，不复制旧操作而跳过校验。

- 本地同步 ≠ 打包 ≠ 校验 ≠ 发布预演 ≠ 提交/tag/Release/渠道推送；源码改版、正式渠道发布、用户安装副本升级是不同步骤。
- 两份 `.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json` 与根 `marketplace.json` 的插件身份/版本须一致；正式渠道清单是生成的 `marketplace-release.json`，不要覆盖源码市场入口。
- `release_tool.py build` 的输出目录须尚不存在，包只含枚举分发文件；`verify` 校验身份、文件集、SHA256 与安全解包，参数示例见维护文档。
- `publish --dry-run` 不是离线检查：仍有 GitHub 只读 preflight，要求已提交源码、本地/远端 tag 与目标提交一致、Release 不存在及非空 UTF-8 更新说明。预演不授予正式发布权限。
- 更新渠道由 `readChannel` 按注册来源**和市场缓存清单**共同判定：清单为 zip 源的 GitHub/GitCode 来源是 Release 渠道，更新来自已注册来源对应的正式 Release，ZIP、manifest、版本一致，安装后由 `verifyCommittedRelease` 复核宿主安装记录；清单为源码路径的仓库来源判为 `market` 渠道，与本地目录来源同链，由宿主插件管理器按清单直接更新，不经发布包校验。原「市场清单必须与 Release 一致」的安装前校验门（`validateCatalog`）已按维护者决定移除，不要重新加回。不静默切换用户市场来源，不启用被禁用插件。
- `--publish`/`--confirm` 是工具安全门，不是用户授权的替代。提交、推送、tag、创建 Release、渠道写入均按**当前明确授权**执行，本指南不授予持续发布权限。
- 实际目标仓库先检查 `git remote -v`，不要混用 fork/上游；源码/渠道 branch、tag、Release 必须分别确认。
- `fork` 配置双 push URL：`git push fork` 同时推送 GitHub（ByteRax）与 GitCode 镜像（gitcode.com/tanranran/zcode-token-usage-statusbar）；`gitcode` 远程仅用于单独核对或恢复，`origin` 仍只读。GitCode 同时承载国内更新渠道：`plugin-releases-gitcode` 分支清单 + 同 tag Release 资产，由 `release_tool.py publish --gitcode-repo`（需 `GITCODE_TOKEN`）在 GitHub 发布验收后生成，见[双远程同步](docs/maintaining.md#双远程同步)。更新器的 GitHub/GitCode 双渠道校验（`plugin-release.cjs` 的 flavor 分支、`sameAssetUrl` 主机模式、`fetchBytes` 白名单）必须一起改并有测试锁定。GitCode 段推送认证（HTTPS 访问令牌）未配置时该段失败属预期，不代表 GitHub 段失败。
- 维护文档旧 CRLF 修复步骤含破坏性重新检出命令，**不要执行**；保存已有修改，用独立工作树/新检出验证字节。也不要把安装 `--dry-run` 概括为完全无本地副作用。

## 9. 完成标准

交付简要说明：
- 改了什么以及原因；有哪些行为/兼容范围保持不变。
- 实际执行的检查与结果；跳过/未执行的检查及原因，不隐去失败或平台跳过。
- 是否已同步插件副本；是否更新安装缓存/稳定运行文件；是否需要重开会话或完全重启客户端。
- 尚存限制与需要实机验证的部分。只有相应日志、测试、加载诊断或正式渠道证据齐全，才能宣称功能正常、安装成功、远端恢复或发布完成。
