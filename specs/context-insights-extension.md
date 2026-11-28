# 上下文洞察与上下文浏览器（ZCode Extension 融合方案）

将 `dsh-context` 的核心能力（**上下文洞察页面**、**Context 标签页**、**Context Stats**、**上下文浏览器**）移植融合到本项目，采用 **ZCode 原生 Extension（扩展进程 + 沙箱扩展视图）为主、客户端容量弹层与状态条联动为辅** 的双引擎架构。

> 本规格定义整体架构契约与 **阶段 1（Extension 底座 + 入口打通）** 实施细节；阶段 2–4 的数据查询与前端细节在对应阶段动工前补充细化。

---

## 1. 整体分期与目标

| 阶段 | 范围 | 核心交付 |
|---|---|---|
| **阶段 1（本期）** | Extension 底座与入口打通 | `plugin.json` 声明 `extension` 与 `slots`；`extension-main.cjs` 激活、焦点会话追踪、视图注册；容量弹层唤起 `context` 视图；`/context` 命令；空白/骨架沙箱视图联通 |
| **阶段 2** | Context 标签页核心（Stats + Current） | `zusage.py session-stats`（会话统计子命令）；Context Stats、Token Stats、Timing Stats、Current Context（11 类堆叠条） |
| **阶段 3** | 上下文浏览器与可选请求抓包 | `zusage.py session-browser`（分页/懒加载）；步骤时间线（含 Delta）；7 类可折叠浏览器；`engine-patch.cjs` 可选请求体抓包（默认关闭，SHA256 去重） |
| **阶段 4** | 上下文洞察页面（跨会话总览） | `zusage.py insights`（水位缓存）；KPI 栏、7 天双柱状图、8 周热力图、工具/技能/命令排行、会话卡片与 `sessions.openSession` 跳转 |

---

## 2. 视图与入口设计（2 视图 + 4 入口）

### 2.1 两个核心扩展视图

1. **`insights`（上下文洞察，`scope: "app"` 全局级）**
   - 独立侧栏视图（`ui://zcode-token-usage-statusbar/insights`），不依赖当前是否打开会话，承载跨会话总览。
2. **`context`（Context 标签页，会话级）**
   - 随焦点窗格会话自动切换的侧栏视图（`ui://zcode-token-usage-statusbar/context`），内部通过顶部分段切换聚合：Stats 概览、Timeline & Browser（上下文浏览器）、Events & Activity。

### 2.2 四个用户入口

| 入口 | 载体 | 目标视图 | 交互规则 |
|---|---|---|---|
| **左侧主导航「上下文洞察」** | 原生 `slots["nav.primary"]` | `insights` | App 级常驻。首次安装/启用时通过 `slots.update(..., { badge: "dot" })` 亮起未读小蓝点；用户打开一次 `insights` 视图后在 `ctx.extension.dataPath` 落盘标记并清除 `badge: null`。 |
| **「上下文容量」弹层按钮** | `overlay.js` 注入（`[data-slot="hover-card-content"]`） | `context`（当前窗格 `sessionId`） | 位于现有「压缩上下文」按钮旁，文案「上下文明细」/「Context details」。点击后经 `inject-main.cjs` 触发扩展进程调用 `ctx.views.open("context", { sessionId })`。 |
| **右侧边栏 `+` 新标签页** | 原生 `slots["sidePane.launcher"]` | `context` | 位于右侧面板启动页「扩展」分区，供原生习惯用户随时打开。 |
| **`/context` 斜杠命令** | `commands/context.md` | `context`（提示 + 引导） | 与现有 `/usage` 并列，输出当前上下文摘要并提示可在右侧面板查看完整视图。 |

**`⚙` 设置面板不放扩展入口（v494，用户决定）**：v492 曾在 `⚙` 设置面板顶部挂「当前会话明细」「全部会话洞察」两颗快捷按钮（`.zu-ext-quick`），按用户要求移除。设置面板不放这两个功能的入口，扩展入口以上表四项为准，不再新增。

---

## 3. 状态所有者与数据边界

| 状态 / 数据 | 唯一 Owner | 读取与同步方式 |
|---|---|---|
| 插件清单、静态插槽、视图声明 | ZCode Window Host (`extensions-service`) | 读 `.zcode-plugin/plugin.json` / `.claude-plugin/plugin.json` |
| 扩展运行态、蓝点已读状态 | 扩展进程 (`extension-main.cjs`) | 已读标记存 `path.join(ctx.extension.dataPath, "ui-state.json")` |
| 当前 11 类上下文构成 | ZCode CLI → Window Host | `ctx.context.get({ sessionId })` + `ctx.context.onDidChange` 推送修订号 |
| 屏幕焦点会话 / 草稿态 | ZCode Renderer → Window Host | `ctx.workbench.visibleSessions()` + `ctx.workbench.onDidChange` |
| 历史用量、耗时、工具调用、消息正文 | 本地 `db.sqlite`（只读） | 扩展进程按需调用包内 `zusage.py`（解释器与主桥同源：运行目录 `config.json` 的 `python_path` 优先，没有时按 hooks 的回退链；候选不可用不只是 ENOENT，详见 §4.2） |
| 弹层按钮唤起视图信号 | `overlay.js` → `inject-main.cjs` → 扩展进程 | 见 §4.2 跨进程唤起协议 |

### 关键约束
- **进程隔离**：ZCode 扩展进程运行在独立的 Electron `utilityProcess` 中，**不可**直接操作客户端 DOM，也**不修改** `app.asar`；`overlay.js` 运行在渲染进程，无法直接调用 `ctx.views.open`。两者通过运行目录 `~/.zcode/zcode-token-usage-statusbar/` 桥接。
- **沙箱页面自包含**：`extension-view-context.js` 与 `extension-view-insights.js` 必须为单文件自包含 HTML（内联 CSS/JS，通过 `window.zcode` MCP App 接口与扩展进程通信，主题色跟随 `hostContext` 变量，不加载外部 CDN）。这两个文件的**内容是 HTML**、只是文件名以 `.js` 结尾（见 §5.3），宿主按纯文本读取它们作为页面（`readViewEntry`），不是脚本。
- **无第三方运行时依赖**：扩展入口与构建保持零 npm 运行时依赖（CommonJS `extension-main.cjs` + 原生 Node 标准库），不要求用户安装 `node_modules`。

---

## 4. 接口与通信设计（阶段 1）

### 4.1 扩展视图（写法一：`ViewDefinition`）

扩展入口 `plugins/zcode-token-usage-statusbar/extension-main.cjs` 导出 `activate(ctx)` 与 `deactivate()`：
- 注册 `insights` 视图（`entry: "./extension-view-insights.js"`）：
  - 工具 `insights_ping` / `insights_snapshot`：返回 `{ status, locale, pluginVersion, ... }`。
  - 资源 `ui://zcode-token-usage-statusbar/insights/state`：变更信号。
  - `onDidOpen`：记录已打开标记并清除 `nav.primary` 蓝点。
- 注册 `context` 视图（`entry: "./extension-view-context.js"`）：
  - 工具 `context_snapshot`：返回 `{ status, sessionId, isDraft, locale, composition, stats, contextPaths }`；当 `composition` 存在时，扩展进程结合本地文件系统（会话工作区、`~/.zcode`、已装插件目录、宿主资源目录）为涉及路径的类别与条目解析并校验磁盘路径（`workspaceDir`、`categories`、`itemPaths`）。
  - 工具 `context_open_folder`：入参 `{ path: string }`；校验路径落在受信任根目录白名单（主目录、可见会话工作区、宿主资源目录）后，在系统文件管理器中定位文件所在目录或直接打开文件夹（禁止直接执行任何文件）。
  - 资源 `ui://zcode-token-usage-statusbar/context/state`：变更信号。
  - 订阅 `ctx.context.onDidChange` 与 `ctx.workbench.onDidChange`，命中当前打开的视图会话时调用 `view.notify(...)`。

### 4.2 容量弹层 → 唤起扩展视图链路

`overlay.js` 与扩展进程分属不同进程，采用**轻量文件信号（原子写 + `fs.watch`/防抖）**打通，兼容新旧 loader：

1. **渲染端（`overlay.js`）**：用户点击弹层「上下文明细」时，通过既有主桥 IPC（`zusage:action` 新增白名单动作 `open-ext-view`，入参 `{ viewId: "context" | "insights", sessionId?: string }`）通知 `inject-main.cjs`。
2. **主进程（`inject-main.cjs`）**：校验本地窗口与 `viewId` 白名单后，向运行目录原子写入请求文件 `~/.zcode/zcode-token-usage-statusbar/ext-open-request.json`：
   ```json
   { "id": "<uuid>", "viewId": "context", "sessionId": "sess_...", "ts": 1700000000000 }
   ```
3. **扩展进程（`extension-main.cjs`）**：监听运行目录（`fs.watch` 配合 `ts` 与 `id` 去重，忽略启动前超过 15 秒的陈旧请求（`STALE_OPEN_REQ_MS`）；`fs.watch` 报 error 后不再派发事件，另有每 3 秒比对请求文件 mtime 的轮询兜底（异步 `stat`，watcher 缺席时顺带重建），激活时已在的请求文件不当成新请求：建监听之前同步读一次、把它的 `id` 记成已处理，`fs.watch` 与轮询两条路径一视同仁（macOS 的 `fs.watch` 会把建监听之前刚落盘的写入补发给新 watcher，只给轮询种 mtime 挡不住它），轮询另以它的 mtime 作种子——否则扩展进程在一次点击后 15 秒内重启会把那次打开重放一遍；请求里的 `sessionId` 过与工具入参同一道正则门 `^sess_[A-Za-z0-9_-]{1,120}$`，不过则不带会话打开），读到新请求后立即消费并调用：
   - `viewId === "context"`：`ctx.views.open("context", sessionId ? { sessionId } : undefined)`
   - `viewId === "insights"`：`ctx.views.open("insights", "app")`
4. **降级与兜底**：若扩展未激活或宿主不支持 `views.open`（旧版 ZCode），`overlay.js` 提示用户“请在 ZCode 4.0+ 中启用本插件扩展能力”，不抛未捕获异常。
5. **解释器定位（`runZusageCli`）**：与主桥 `readCfg()` 同源——运行目录 `config.json` 的 `python_path` 优先（安装与每次 SessionStart 都把 `sys.executable` 写回它，状态条与 hooks 走的就是它）；没有时先试主桥的平台默认（Windows 是 `python`、其它是 `python3`），再按 hooks 的回退链（`hooks/hooks.json` 在所有平台都是 `python3 → python → py -3`）补齐其余候选。候选「不可用」不只是 ENOENT：没有执行权限（EACCES）、路径不是目录（ENOTDIR）、`.cmd` / `.bat` 垫片不经 shell 执行（EINVAL）、Windows 上应用商店的 `python` 占位别名能启动但退出码 9009，都要让位给下一个候选（`execFile` 的错误对象上，子进程非零退出的退出码是数值型的 `code`，没有 `status` 字段）；全部候选不可用时错误里带上各候选的原因；脚本自身的非零退出如实报错、不换解释器重跑。子进程带 `-X utf8`（`zusage.py` 只把 stdout 钉成 UTF-8，回溯里的本地化文字否则按区域代码页写 stderr、读进视图是乱码）。扩展进程按标准运行目录 `~/.zcode/zcode-token-usage-statusbar` 定位请求文件与配置（环境变量 `ZUSAGE_PLUGIN_RUNTIME` 可覆盖，与安装器的同名测试接缝一致，宿主的扩展进程不会带它）；`--dev` 布局下主桥的运行目录是仓库根，唤起按钮无效，属开发者布局的已知边界。

---

## 5. 插件清单与分发链兼容性

### 5.1 `plugin.json` 新增字段（两份清单保持一致）

在 `.zcode-plugin/plugin.json` 与 `.claude-plugin/plugin.json` 中新增：
- `"extension"`：
  - `"engines": { "zcode": "^1.0.0" }`
  - `"main": "./extension-main.cjs"`
  - `"activationEvents": ["onAvailable"]`
  - `"contributes"`:
    - `"commands"`: `open-insights`、`open-context`
    - `"views"`: `insights`（`scope: "app"`，`icon: "bar-chart-2"`）、`context`（`icon: "pie-chart"`）
- 顶层 `"slots"`：
  - `"nav.primary"`: `[{ "id": "insights", "icon": "bar-chart-2", "title": { "zh-CN": "上下文洞察", "en-US": "Context Insights" }, "target": { "view": "insights" } }]`
  - `"sidePane.launcher"`: `[{ "id": "open-context", "title": { "zh-CN": "上下文组成", "en-US": "Context" }, "target": { "view": "context" } }]`

> 兼容性说明：旧版 ZCode CLI 解析 `plugin.json` 时保留未知顶层键，不影响原有 MCP、Hooks、Commands 与 `overlay_install` 链路。

### 5.2 分发清单同步（6 处登记）

新增插件专属文件（属于 `PLUGIN_ONLY_FILES`，**不进** `overlay_install.py` / `install.py` 的 `RUNTIME_FILES`）：
- `extension-main.cjs`
- `extension-view-context.js`
- `extension-view-insights.js`
- `commands/context.md`

须同步登记到：
1. `sync_plugin.py` → `PLUGIN_ONLY_FILES`
2. `release_tool.py` → `SOURCES` / `NAMES`
3. `release_unpack.py` → `PLUGIN_FILES` / `ALLOWED_FILES`
4. `.zcode-plugin/plugin.json` → `packageLayout.files`
5. `.claude-plugin/plugin.json` → `packageLayout.files`
6. 跑通 `python3 sync_plugin.py --verify-manifests` 与 `tests/test_plugin_package.py`。

### 5.3 为什么入口与页面都放插件顶层（打包硬约束）

解开新安装包的是**用户机器上已经装着的旧版解包器**。现网各代解包器在清单声明了 `packageLayout` 时的放行规则（`release_unpack.py` 的 `layout_path`，≤1.4.5 旧代的宽松分支同款，由 `tests/test_release_tool.py::test_built_zip_satisfies_legacy_unpacker_contract` 冻结）：

- 插件根目录下的**顶层文件**只认 `[A-Za-z][A-Za-z0-9_-]*\.(py|cjs|js)`（`release_tool.py` / `install.py` / `sync_plugin.py` 除外）；
- 子目录只认 `hooks/*.py`、`commands/*.md` 与清单里逐个列出的 `skills/` 文件；
- 目录名放行 `hooks`、`commands`、`skills`、`skills/zcode-token-usage`。

所以 `extension/` 子目录、`.mjs`、`.html` 都会被旧解包器拒绝——照此打包，全部现有用户的自动更新会失败（曾两次事故，见 [.zcode/rules/install-release.md](../.zcode/rules/install-release.md)）。因此：

- 入口是顶层 **CommonJS** 的 `extension-main.cjs`（宿主 `registry.ts` 用 `import(pathToFileURL(main))` 加载并取 `activate` / `deactivate`，不限后缀；用 `.cjs` + `require` 是为了不依赖 Node 对无 `package.json` 的 `.js` 做 ESM 语法探测）。
- 两个视图页面是顶层 `extension-view-insights.js` / `extension-view-context.js`，**内容是 HTML**，文件头有一段 HTML 注释说明；宿主 `viewServer.ts::readViewEntry` 只要求 `entry` 是插件根目录内的文件并按文本读取，不限后缀，每次打开视图时重读。
- `release_unpack.py` 的放行规则**不需要也不应该**为新文件放宽：新布局下所有文件本来就在规则内。将来给扩展加文件时同样只能落在上述三种位置，改放行规则前先读那条契约测试。

改宿主版本后要复核这两处宿主行为（宿主 monorepo `packages/desktop/src/extension-host/registry.ts`、`viewServer.ts`）。

---

## 6. 阶段 1 验收场景

1. **清单与打包校验**：`python3 sync_plugin.py --verify-manifests` 与 `python3 sync_plugin.py --check` 退出码为 0；现有 `tests/test_plugin_package.py` 全过。
2. **原生 Extension 激活**：本地加载插件后，ZCode Extension Host 正常激活 `extension-main.cjs`，无 `invalid` / `incompatible` / `failed` 状态；左侧主导航「插件市场」下方出现「上下文洞察」且首次带蓝点；右侧边栏 `+` 启动页「扩展」分区出现「上下文组成」。
3. **蓝点消退**：点击左侧「上下文洞察」打开 `insights` 视图后，蓝点消失且重启后保持已读（读 `dataPath/ui-state.json`）。
4. **当前构成透传**：打开 `context` 视图后，草稿态与正式会话均能通过 `context_snapshot` 展示当前会话 ID、模型与 `ctx.context.get()` 返回的 11 类构成占位列表；切换焦点会话时视图自动跟随更新。
5. **容量弹层联动**：悬停底部上下文圆环出现「上下文明细」按钮；点击后通过 `inject-main.cjs` → `ext-open-request.json` → `ctx.views.open("context", { sessionId })` 成功打开并聚焦右侧 `context` 标签页；`⚙` 设置面板顶部不出现扩展快捷按钮。
6. **回归零破坏**：原有状态条、`overlay.js` 分项增强、压缩按钮、逐问速率行、MCP 与 Hooks 行为无退化。

---

## 7. 模型明细模块（2026-11-27 增补）

上下文洞察页（`extension-view-insights.js`）与 Context 标签页 Stats 分段（`extension-view-context.js`）各有一张「模型明细」表：列＝模型明细 / Token 用量 ↓ / 请求次数 / 平均速度 / 预估费用，按 tokens 降序、最多 12 行；费用列走 `fmtCost(usd, fx)`，无牌价模型费用计 0（图例口径与 7 天用量卡一致）。

- **数据契约**：`insights_json` 的 `topModels[]` 增补 `avgTps`；`session_stats_json` 顶层新增 `models[]`（`{model, provider, tokens, requests, avgTps, costUsd}`）。`kpi.perModelCost`（mid → cost 浮点）保留原形状不变。`avgTps = _rated_tps(Σout, Σgen_ms)`：仅累计 `output>0` 且生成窗口>0（`duration_ms − ttft_ms`，无 ttft 用全 dur）的行；无有效样本为 0，视图显「—」。
- **口径边界**：扩展视图的 avgTps 是行级加权，与所在页面 KPI 的全局 tps 同口径；比桌面 tooltip 模型明细的严格有效段口径（`usage_stats.row_gen_ms` 200ms–1h 窗口过滤、仅 main_turn）宽松，跨表对比以桌面为准。
- **视图插位**：洞察页全宽卡片位于 Token/Timing 双环卡之后、Row 3（活跃度/技能/工具/命令）之前；Stats 分段内位于 Token Stats 卡之后、Timing Stats 卡之前。两视图各自内联 `modelTableRows`（沙箱页面自包含，不共享脚本）。

---

## 8. 活跃度热力图 t/s 模式（2026-11-27 增补）

洞察页「活跃度」卡在 会话 / Token 之外新增 `t/s` 档位（`heatMode="tps"`）：逐日 `Σ输出 ÷ Σ生成窗口`（与 §7 均速同口径，仅累计 output>0 且窗口>0 的行），色阶沿用相对最大值分档，最快的一天最深；无样本日显空格，悬停显「日期: N t/s」或「—」。

- **数据契约**：`insights_json` 的 `heatmap[]`（56 格）每格增补 `avgTps`；热力窗口仍为 55 天回看（与 tokens/sessions 聚合同一循环，`heat_start_ms` 门）。
- **边界**：t/s 档位数值高低与用量多少无关（慢而大的一天在 Token 档最深、在 t/s 档可能很浅），属口径差异非缺陷；点格过滤会话列表（dayFilter）行为与另两档一致；dayFilter 按**本地自然日**筛（与热力图格子、`insights_json` 的日桶同口径——UTC+8 下本地 0–8 点更新的会话属于当天，不能按 `toISOString()` 的 UTC 日期算），`updatedAt` 非法的会话不匹配任何日筛选、也不打断渲染；会话卡片的项目名按两种分隔符取目录名（Windows 下会话目录是反斜杠路径）。

---

## 9. 会话卡起止时间（2026-11-27 增补）

洞察页「会话」卡片指标行在 总预估费用 下新增「起止时间」：`insights_json` 的 `sessions[]` 增补 `createdAt`（`session.time_created`）与 `endTime`（`session.time_updated`，视图端回退模型活动 `updatedAt`），毫秒时间戳；视图按本地时区格式化为 `YYYY-MM-DD HH:mm ~ HH:mm`（跨日补第二段日期），缺值显「—」。排序（最近更新/Token/Context）不受影响。

---

## 10. 去假存真 + 质量面 + 浏览器补全 + 请求抓包（2026-11-27 增补）

### 10.1 实测取代估算

- **Token 统计（洞察页与 Stats 分段）**：主环是**实测五分** `tokenSplit`（缓存读取 / 缓存写入 / 未命中输入 / 模型思考 / 模型回复；缓存读写是 input 的子集，扣除后不重复计，五项之和恒等于总用量）。洞察页主/子切换时五分按来源桶现算（`split[mode]` 的 inp/out/cr/cw/reas）。原 8 分类（`tokenBreakdown`）降级为**默认折叠**的「8 分类构成（估算）」，数值带 `≈`，并用 `tokenBreakdownBasis` 标注依据：`ratio`=按固定比例；`capture`=system 与工具 schema 按抓包内容估算（见 §10.4）。
- **耗时统计**：只保留**实测三段**——首字等待 `ttftMs`、模型生成 `genMs`、工具执行 `toolRunsMs`。每行 `dur = ttft + gen`（无首字的行 gen=dur），三段之和恒等于总活跃时长（`tests/test_context_queries.py` 锁定）。按 token 比例推算的「思考/回复毫秒」与写死的「其他开销 2%」已移除，`timing.breakdown` 字段不再下发。
- **压缩事件**：改读真实 `type=compaction` part（带 `compactBoundary`）。会话级 `kpi.contextEvents.compact = max(真实 part 数, timeline 压缩事件数)`（后者是旧宿主没写 compaction part 时的兜底）。`compactions[]` 每行：时间、触发方式、是否自动、压缩前/后 token（`truePostCompactTokenCount` 优先）、摘要/保留消息数、`willRetrigger`。洞察页 `compactionHealth`：次数、下轮再压缩次数、平均缩减比例、最近一次。
- **浏览器消息头**：有用量行的 assistant 消息显示实测 `in X (cache Y%) · out Z`（来自 `model_usage`，经 `assistant_message_id` 关联）；分项 token 仍按字符估算，标注改为 `≈`。

### 10.2 质量与可靠性

- **错误与重试** `errors`：`failedAttempts`（带 `error_type` 的尝试）、`failed`（`status=error`）、`cancelled`、`retries`（Σ`retry_count`）、`byType`（按错误类型计数）。洞察页另有每日失败条（`daily[].errors` / `rateLimited`）。
- **工具质量** `toolQuality`：错误状态、非零退出（`nullif(exit_code,'')`，空串不算）、截断、只读占比、破坏性操作、耗时 P50/P95/均值。
- **主/子代理拆分**：`query_source` → `main`（`main_turn`）/ `sub`（`subagent`、`workflow_child`）/ `aux`（标题、压缩、校验等辅助请求）/ `all`。洞察页 `split`、`topModels[].bySource`、`daily[].mainTokens|subTokens|mainCostUsd|subCostUsd`；Stats 分段 `split`、`models[].bySource`。洞察页页头「全部请求 / 主会话 / 子代理」切换 KPI 行、日图、Token 五分与模型明细；分桶内没有工具耗时，切到主/子时只给调用次数（页面如实标注）。来源桶里的均速与所在页 KPI 同口径（Σ输出÷Σ生成窗口，分母含全部行）。

### 10.3 浏览器补全

- **最新在前 + 游标翻页**：默认 `order=desc` 取最新 80 条；「加载更早的消息」带 `before`（上一页最老一条的 `{s: sequence, t: time_created, id}`，与 `ORDER BY` 同键做行值比较）取更老一页，流式新增不会让已加载页错位；会话或逐轮切换时清掉已加载页并丢弃迟到载荷。「回到最新」回到首页。
- **steps 限幅**：`session_stats_json` 的 `steps[]` 只下发**最后 1000 条**（`kpi.steps` 仍是总步数，`step` 序号不重编），防超长会话的响应撑破扩展进程 `runZusageCli` 的 16MB `maxBuffer`；`session_stats_json` 的 `tokenBreakdown` 估算口径：「用户消息」=用户角色消息的正文字符数 ÷4（按 `message.data.role` 区分，助手正文不计入）；「技能注入」=Skill 工具输出字符 ÷4；「工具调用」=工具入参与输出字符 ÷4；「模型思考」「模型回复」是实测值（`reasoning_tokens` 与 `output − reasoning`），不按字符估。
- **逐轮视图**：`turns[]` 来自 `turn_usage`（轮结束才写，进行中的轮不在内；只下发最后 200 轮，`n` 是会话里的绝对轮序；缺列的旧库按写入序、字段按 0/空）。Stats 分段逐轮表点击一行 → 只看该轮消息、时间正序；窗口 = 该轮用户消息（`user_message_id` 定位，取不到用 `started_at`）到下一轮用户消息之前。
- **筛选片**：全部 / Thinking / Tools / Answer / 用户 / 文件 / 命令 / 事件（工具 part 带 `cat=file|command`；压缩与 timeline part 属「事件」）。
- **CLI 胶水**：`zusage.py session-browser <sid> '<json>'`——选项以**单个 JSON 位置参数**传入（`limit`/`offset`/`turnId`/`before`），必须排在旧的 `_cli_count` 位置参数解析**之前**判断，否则 JSON 串会被当成非法数字以退出码 2 拒掉（`tests/test_context_queries.py` 用真实子进程锁定）。扩展侧 `browserOptions()` 负责钳值与拒绝畸形入参（游标 `before.s` 必须是有限数字或非空数字串——`Number(null)`/`Number("")` 会变成 0，不能当游标；查询函数自身也把 `limit` 钳在 1~300）。

### 10.4 请求抓包（默认关闭）

- **开关**：运行目录 `req-capture.json` 的 `enabled === true`。Context 标签页浏览器分段的「启用抓包 / 关闭抓包」按钮经 `context_capture_set` 工具原子写入；`context_snapshot.capture.enabled` 回读。文件缺失、损坏或非布尔 true 一律按关闭；`writeCaptureConfig` 同样只把布尔 `true` 写成开启。
- **写入端**：`engine-patch.cjs` 的 prologue 现为两段——阈值 hook（`PROLOGUE_BASE`，字节不变）+ 抓包 hook（`CAPTURE_PROLOGUE`）。宿主发模型请求有**两条路**（4.0.0 引擎包 `fetchHttpResponse`）：① 没配代理、没配自定义证书 → 全局 `fetch(url, {body: Buffer, headers: Headers, ...})`；② 配了代理或自定义证书 → `node:http`/`node:https` 的 `request({method, headers, ...}, cb)` 再 `req.end(Buffer)`。所以抓包 hook 包两处：`globalThis.fetch`（请求体接受字符串、Buffer、TypedArray、ArrayBuffer）与 `node:http(s).request`（在返回的请求对象上包 `end` 收请求体）。只认 POST 且带 `x-zcode-trace-id` 归因头的请求（宿主只给模型请求加这组头），配置 5 秒内最多重读一次（改 JSON 即生效，已带这段 hook 的会话进程不用重启；只有在引擎迁移、装上这段 hook **之前**启动的会话进程抓不到）。只落 system 与工具 schema（SHA256 去重存 `req-capture/blobs/`，上限 300 个）与消息条数/字符数到 `req-capture/requests.jsonl`（超 512KB 只留最近 300 行）；**不落消息正文、请求头或任何凭据**。落盘文件与目录权限固定为文件 `0600`、目录 `0700`（system prompt 可能含项目规则/记忆，共享机器上不给其它本机账户读；已存在的旧文件不回改权限）。请求体的解析、哈希与落盘经 `setImmediate`（`unref`）排到请求发出之后，不占请求关键路径；消息条数 ≥2 万时不估字符数，`messageChars` 写 `null`（消费端不读该字段）。`requests.jsonl` 的滚动是读-改-写，多个引擎子进程同时抓包时理论上可能互相覆盖丢行（已知并接受：记录只用于展示）。任何一步出错都静默放行原请求。
- **归并到会话**（`zusage._read_req_capture`）：请求头只带 trace id（一次运行一个，父子会话可能共享；`x-request-id` 是随机 UUID，对不上库里的行），所以按「本会话 `model_usage` 的 trace 集合 + 会话类型头（主会话认 `main`、子会话认 `subagent`）」归并。**这是近似归并**——同 trace 的兄弟子代理分不开，消费端标「按 trace 归并」。按会话落盘的 `<会话id>.jsonl` 形态仍全量读。
- **迁移与还原**：已装阈值 hook 的机器按 `PROLOGUE_BASE` 逐字节命中后原位换装完整 prologue。`PROLOGUE_BASE` 是新版的前缀，迁移校验不能用「旧串不残留」判定（恒 `verify_failed`），改为「前缀标记恰好出现一次 + 完整本体在位」；V1/V2 旧代际仍按旧串不残留判。开发机上装过的上一版抓包 hook 按 `PROLOGUE_CAP_V2`（= `PROLOGUE_BASE + CAPTURE_PROLOGUE_V2`，上一版文本逐字节保留）迁移与还原，它含 BASE，须排在 BASE 之前匹配；各版抓包 hook 都没有随任何版本发布，再改抓包段时把「当前正在用的旧版」滚动成这个常量即可。
- **验证边界**：hook 行为由 `tests/engine-patch.test.cjs` 锁定——vm 沙箱用例（默认关闭不落盘、开启后一行一请求、去重、不落正文、非模型请求跳过、开关免重启、滚动与封顶、两种宿主调用形态、BASE 与初版抓包装机的迁移与还原），外加一条**真实 Node 运行时**用例：子进程跑真实 prologue，按宿主两种写法向本地服务器发请求（临时 HOME），断言请求原样到达、两条各记一条、正文不落盘。引擎包改版后先复核 `fetchHttpResponse` 的调用形态再改 hook。**真机验收（2026-11-27 22:10，ZCode 4.0.0 / macOS）**：重启后首条请求即记到，归因头在真实流量中存在（`sessionType=main`、`querySource=main_turn`），按 trace 归并到本会话命中，`tokenBreakdownBasis=capture`；落盘形状=`system` 为 3 个 text 块（约 8.1 KB）、`tools` 为 11 个工具（`name`/`description`/`input_schema`，约 19.7 KB）；落盘文件中无 `x-api-key`/`Bearer`/`cookie`/`api_key`。代理/自定义证书那条 `node:http(s)` 路径只有真实 Node 本地服务器用例覆盖，未在真机代理环境验证。

### 10.5 过渡期：页面与扩展进程版本不一致

扩展进程（Electron utilityProcess）在生命周期内只加载一次 `extension-main.cjs`，而沙箱视图的 HTML 每次打开重读——插件更新后会出现「新页面 + 旧扩展进程」。旧进程不认 `turnId` / `before`，也没有 `context_capture_set`。视图按**对端行为**识别而不是按版本号：带 `before` 请求回来的最老一条没变 → `pagingStale`（不重复追加同一页）；逐轮请求回来的 `turnId` 不是所请求的轮 → `turnStale`（不拿普通页冒充）；抓包开关调用失败或无 `ok` → toast 提示。三种情况都提示「重启 ZCode 后生效」，换会话或换轮时复位。判定前先验证最基本的事实：页面能拿到数据说明工具通道本身是通的。

### 10.6 审查遗留（已知限制）

- **快捷入口的「fiber 直开」未按插件名收窄匹配**（`src/overlay/11-instance-toolbar-chips.js`）：弹层按钮先用 `[data-extension-item$="/insights"]` 找导航项、从其属性推出插件 id，再沿 React fiber 取宿主 `onOpenTab` 直开视图。若别的扩展也有 id 为 `insights` 的视图，可能取到别人的插件 id，且此时 `openedDirect=true` 不再走 `open-ext-view` 文件链回退，按钮会静默无效。修法是只认属性里含本插件名 `zcode-token-usage-statusbar@` 的导航项；该改动属于点击交互路径，须在真实页面走一遍完整点击后才能交付（本轮未做桌面验收，故未改）。
- 代理/自定义证书那条 `node:http(s)` 抓包路径只有真实 Node 本地服务器用例覆盖。
- **指向受信根之外的「文件」符号链接仍可在文件管理器里定位**（`revealOrOpenFolder` 只对目录换真实路径并复查）：文件管理器只是选中并高亮根内的那个链接条目，不读取目标内容；而文件级链接在工程里很常见（链接进来的配置、资源），一律拦截会误伤，故保持现状。
