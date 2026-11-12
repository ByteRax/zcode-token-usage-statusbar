# 宿主适配：ZCode 与 WorkBuddy

本项目最初只读 ZCode 的用量库。v241 起把「数据源」抽象成**宿主（host）**，
`zusage.py` / `usage_mcp.py` / JSON 快照 / 主桥查询泵共用同一套出口，
换宿主只换适配层，不改上层调用方式。

本文说明 WorkBuddy 的接入方式、配置项、能力差异与验证方法。

---

## 1. 两个宿主的差别

| | ZCode（默认） | WorkBuddy |
|---|---|---|
| 用量库 | `~/.zcode/cli/db/db.sqlite` | `~/.workbuddy/workbuddy.db` |
| 数据粒度 | 逐请求（`model_usage`） | 上下文/window 在 `session_usage`（会话级），逐请求用量在会话正文 `projects/*/*.jsonl` 的 `providerData.rawUsage` |
| 上下文用量 | `last_request_input` | `session_usage.used` |
| 上下文窗口 | `context_window`（模型表/配置） | `session_usage.size` → `sessions.context_window` → 配置 |
| token 分项 | input/output/思考/缓存读写齐全 | 齐全（正文每次模型调用都记 `rawUsage`） |
| 生成速度 | 有（按请求耗时） | 近似值：响应时间 − 触发者时间（含思考/网络，不含工具执行） |
| 工具调用 | 有 | 有（`function_call` / `function_call_result` 计数与错误归属） |
| 预估费用 | 有（单价表） | **有**（同一单价表；价表未收录的模型如实标「不可得」），另有宿主的 **credit** |
| 子代理 / 会话分栏 | 有 | **无**（本地库无该维度） |

能力由 `zusage.HOST_CAPS` 声明，随快照的 `caps` 字段下发，
消费端按能力决定展示什么，**不会把「取不到的 0」当成真实值**。

---

## 2. 接入方式

三条出口共用同一个宿主判定，任选其一即可：

```bash
# 1) CLI（--host 可放在任意位置）
python zusage.py --host workbuddy now
python zusage.py --host workbuddy sessions 10
python zusage.py --host workbuddy json

# 2) MCP：token_usage(scope, host)
#    工具新增可选 host 参数，缺省跟随配置
{"name":"token_usage","arguments":{"scope":"today","host":"workbuddy"}}

# 3) JSON 快照 / 主桥查询泵
#    走配置或环境变量选宿主，无需改调用方命令行
```

`--host` 只影响本次进程（CLI 一次调用、MCP 一次请求），不写配置。

---

## 3. 配置项

`config.json`（与 `zusage.py` 同目录；标准安装下在运行目录）新增两项：

```json
{
  "host": "zcode",
  "hosts": {
    "zcode": { "db_path": "" },
    "workbuddy": { "db_path": "" }
  }
}
```

| 键 | 取值 | 说明 |
|---|---|---|
| `host` | `"zcode"` / `"workbuddy"` | 数据源宿主。**缺省跟随客户端构建**：ZCode 构建（默认安装）恒为 `zcode`，行为一字不变 |
| `host` | `"auto"` | 显式开启自动探测：ZCode 库存在即选 zcode；ZCode 库缺失且 WorkBuddy 库存在时选 workbuddy |
| `hosts.zcode.db_path` | 路径或 `""` | 覆盖 ZCode 库位置（多机/自定义安装；`~` 与 `%VAR%`/`$VAR` 会展开；建议写绝对路径）。查询链（CLI / MCP / 桌面快照）与逐问速率脚本 `token_rate.py`（状态条统计行、提问背景行）读的是同一个库 |
| `hosts.workbuddy.db_path` | 路径或 `""` | 覆盖 WorkBuddy 库位置，常用于 WSL/多用户/绿色版目录 |

环境变量（优先级高于配置）：

| 变量 | 说明 |
|---|---|
| `ZUSAGE_HOST` | 覆盖宿主，接受 `zcode` / `workbuddy`（别名 `wb`、`work-buddy`，大小写不敏感） |
| `ZUSAGE_WORKBUDDY_DB` | 覆盖 WorkBuddy 库路径 |
| `ZCODE_USAGE_DB` | 覆盖逐问速率脚本 `token_rate.py` 的库路径（仅它读取，`zusage.py` 不读；主要用作隔离测试的接缝） |

**判定优先级**：`--host` / MCP 参数 > `ZUSAGE_HOST` > `config.host`（`auto` 除外，见下）
> agent 跟随（`detect_agent`：ZCode 构建恒为 zcode，WorkBuddy 构建读 workbuddy）
> `config.host: "auto"` 按库存在性探测 > 默认 `zcode`。

为什么默认不是 `auto`：装了 WorkBuddy 的机器上，ZCode 用户已在用的状态栏、
`/usage`、MCP 查询不能被静默改指向另一个库。WorkBuddy 专用插件构建零配置即按
agent 跟随读 WorkBuddy 库（清单 `mcpServers.env` 的 `ZUSAGE_HOST=workbuddy` 又钉了一层）；
「按库存在性」的机器探测才需要显式 `auto`——该分支在 WorkBuddy 构建中被 agent 跟随遮蔽，
实际只有 ZCode 构建会走到。

---

## 4. WorkBuddy 口径

两路数据拼起来（`wb_usage.py` 解析正文，`zusage.wb_snapshot` 组装）：

1. `session_usage` → 当前上下文 `used` / 窗口 `size`；
2. `projects/<项目>/<sid>.jsonl` 的 `providerData.rawUsage` → 每次模型调用的
   `prompt_tokens / completion_tokens / reasoning_tokens / cached_tokens / credit`，
   以及 `function_call`（工具）、`message role=user`（轮次）。

关键定义：

- **请求** = 一次模型调用（request × step）。同一步会在 `reasoning` 与 `function_call`
  两条记录里重复出现，按 `request+step` 去重（取较大用量）。
- **轮** = 用户消息条数。
- **速度** = 该次调用的输出 tokens ÷（响应记录时间 − 触发它的记录时间）。
  触发者是用户消息或工具结果，所以工具执行时间天然不含在内；含思考与网络往返，
  属**近似值**，与 ZCode 的精确段计时不同口径。窗口 < 200ms 视为无效样本。
- **今日 / 项目累计**：跨会话文件聚合，按请求时间归属（不是按会话创建日）。
- **缓存命中率** = `cached_tokens` ÷ `prompt_tokens`。

### 预估费用

逐模型计价，公式与 ZCode 相同（`token_pricing.compute_group_cost`）：

```
(裸输入 × input + 缓存读 × cache_read + 缓存写 × cache_write + 输出 × output) / 1e6
```

- **模型名映射**：WorkBuddy 的 id 与价表条目名不总一致，走 `wb_usage.MODEL_ALIASES`
  显式映射（**不做通用模糊替换**，错配牌价比「不可得」更糟）。当前一条：
  `deepseek-v4.1-flash → deepseek-v4-1-flash-1017`——价表里唯一带 v4.1 的条目，
  官方 family 只到 v4，直接按 v4 计价会低估。新增别名时把依据写进那张表。
- **未收录模型不冒充**：`token_pricing.lookup_full` 落到 `default` 兜底均价时，
  `wb_usage.model_cost` 返回 `None`，报表/浮层写「不可得」；聚合层带
  `cost_partial=true` 与 `cost_unknown=[模型名…]`，总额只含已定价部分并注明范围。
- **币种**：快照顶层 `fx` 来自 `token_pricing.fx_view()`；有汇率显示 ¥，没有就老实显示 $。
- **能力位**：`caps.cost` 在价表模块存在时为 true，缺失时运行时回退为 false
  （`host_caps`）。

会话、本轮、今日、项目累计、每日、按模型、单会话详情都带费用；口径是「按牌价估算，
非账单」，与 ZCode 一致。

旧构建若没有 `wb_usage.py`（例如 ZCode 插件包），会自动退回「只有上下文 + credit」，
不报错、不伪造 0 值。

## 4.1 上下文与 credit 的取数细节

### 上下文占比

`used / size`（当前上下文已用 ÷ 窗口容量），与 ZCode 的
`last_request_input / context_window` 同义。`size` 为空时依次回退
`sessions.context_window`、配置 `context_window`；回退值以 `context_auto` 标记。

### credit

优先用正文里每次模型调用自带的 `rawUsage.credit` 求和（逐请求口径，最准）；
正文不可用时回退 `session_usage.credit_json`（`{计价条目 id: credit}`，一轮一条，
进行中的一轮会累积在同一键，所以「条目数」≠ 请求数）。损坏 JSON、非数值条目一律跳过。

### 不可得的指标

只有**个别未收录模型**的费用不可得（价表无对应条目；`caps.cost` 仍为 true，
模型明细逐条标「不可得」、聚合注明范围）；token 分项、生成速度、工具调用、
缓存命中率都已从正文补全。

## 5. 验证

```bash
# 自检：当前宿主、判定来源、两个库的位置与用量记录数、可用指标
python zusage.py host

# 指定宿主查询（不写配置也能验证）
python zusage.py --host workbuddy now
python zusage.py --host workbuddy today
python zusage.py --host workbuddy sessions 5
python zusage.py --host workbuddy json | python -m json.tool | head -20

# 确认 ZCode 侧没变
python zusage.py now
python zusage.py host            # 应显示 zcode 为当前宿主
```

`host` 子命令的输出形如：

```text
■ 宿主 ZCode（zcode；判定来源：默认值）
  zcode      C:\Users\<你>\.zcode\cli\db\db.sqlite         15925 条用量记录  ← 当前
  workbuddy  C:\Users\<你>\.workbuddy\workbuddy.db          86 条用量记录
  可用指标 tokens, tps, tools, cost, context, transcript；不可用 credits
```

MCP 侧验证：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"token_usage","arguments":{"scope":"today","host":"workbuddy"}}}' \
  | python usage_mcp.py
```

回归测试：

```bash
python -B -m unittest tests.test_hosts_workbuddy -v   # 宿主适配回归
python -B -m unittest discover -s tests -p 'test_*.py' # 全量
python3 sync_plugin.py --check                        # 插件副本一致性
```

---

## 6. 启动策略：按 agent 分流

同一份代码被两个客户端安装，**启动时按 agent 选策略**，ZCode 的原机制不动：

| agent | 浮层 | MCP / 命令 | 逐问速率行 | 插件更新器 |
|---|---|---|---|---|
| `zcode` | `asar`：`inject-main.cjs` + `overlay.js`（原机制，一字未改） | 有 | 有（依赖渲染桥） | 有 |
| `workbuddy` | `cdp`：`wb-overlay.cjs` 连 `--remote-debugging-port`，在**输入卡内底部**注入整行状态条（本地库状态 / 上下文% / 已用÷窗口 / 会话 credit / 今日，右侧 ⓘ 详情与 ⚙ 设置；卡不存在才退回右下角） | 有 | 无（无渲染桥） | 无 |
| `cli` | 无 | 有 | 无 | 无 |

判定（`zusage.detect_agent`）：`ZUSAGE_AGENT` > `CODEBUDDY_PLUGIN_ROOT`（WorkBuddy）/
`ZCODE_PLUGIN_ROOT`（ZCode）> 插件目录里的 manifest 目录（`.codebuddy-plugin` /
`.zcode-plugin`）> 默认 `zcode`。**不看 `CLIENT_INFO_PLATFORM` 这类客户端指纹**——
它会被子进程继承，在 WorkBuddy 终端里跑 ZCode 那份会误判。

启动点分工：
- WorkBuddy 没有 hook 通道，浮层由 **MCP 进程启动时**拉起（`start_agent_overlay()`），
  单实例靠临时目录锁文件；Windows 先试 WMI（脱离宿主进程树），失败退回 detached。
- ZCode 仍由 `hooks/session-start.py` 负责；该 hook 在非 ZCode agent 下**第一行就静默退出**，
  绝不碰 asar。`hooks/prompt-submit.py` 同样按 agent 门禁。

关闭浮层（例如不想让它连调试端口）：

```json
{ "agents": { "workbuddy": { "overlay": false } } }
```

取值：`false`/`"off"` 关闭，`"cdp"` 显式指定，`true` 用策略表默认值。

手动启动/排查（客户端已在跑时）：

```bash
node "<插件目录>/wb-overlay.cjs" --once      # 注入一次并打印数据，退出
node "<插件目录>/wb-overlay.cjs"             # 常驻（Ctrl+C 退出）
```

注入位置与视觉（对着 ZCode 状态条做的）：

- 宿主 DOM：`.cr-input-container`（输入卡，column flex、24px 圆角、`rgb(31,31,31)`）
  → 它的最后一个子元素就是状态条；工具行 `.cr-input-toolbar` 在其上，
  卡片高度按内容增长且底边锚定，不会把胶囊挤出屏幕。
- 分段：`● 本地库 | ⚡ t/s | 本轮 tokens·次数 | 会话 轮·请求 | 工具·错误 | 今日 tokens·请求 |
  ◷ 上下文% | 项目累计 | ⓘ ⚙`
  分隔线用 `border-left`，整行上方一条内嵌 1px 分隔线，颜色全部用 `rgba(255,255,255,.xx)` 跟随主题。
- **悬停信息卡**：每个分段悬停弹一张卡，位置随分段居中、贴状态条上方，放不下自动翻到下方并夹进视口。
  卡片挂在 `body`（fixed），不会被输入卡的层叠上下文/工具栏遮挡。
  · 速度卡照 ZCode 的悬浮说明做：左侧当前读数 + 档位 chip + 峰值/最低/最新，
    右侧最近 8 段柱状图（按 ZCode 同一套 10 档配色），下方颜色对照与统计口径/时间范围；
    同分钟内的多段横轴改用「相对秒」，避免 8 个柱子都标成 `22:32`。
  · 其余分段统一三段式（对齐 ZCode）：
    ① KPI 格（三格：总用量 / 请求次数或速度 / 预估费用），
    ② 投入产出两列（输入 + 绿色缓存命中率、输出 + 含思考），
    ③ 明细表或第二排 KPI（本轮：平均耗时 / 生成耗时 / 工具数；会话与项目：模型明细表；
      今日：输入/输出/重试 + 缓存率；工具：调用总数/错误 + 工具表含累计耗时）。
    页脚：时间范围 + 口径说明。
  · 数据来源：工具累计耗时 = 调用记录 → 结果记录；本轮工具数按「最后一条用户消息之后」
    统计；项目模型明细为跨会话合并；重试次数宿主不记录，显示「—」而不是假的 0。
- **防闪烁**：注入器每 2.5s 调一次页面脚本，脚本用 `PAGE_VERSION` 判定——
  版本一致且节点还在时直接复用（**不能每 tick 销毁重建**，那会每 2.5s 闪一下；
  这是实际踩过的 bug）。版本变化才重建，热更下一次 tick 生效。
- **被宿主冲掉后自愈**：WorkBuddy 的 React 重渲染会移除非它创建的节点。页面脚本挂
  `MutationObserver`，下一帧把状态条贴回卡片；顺序用 flex `order:9999` 固定，
  不反复搬节点（反复 appendChild 会打断悬停）。
- 数据超过 12s 没刷新 → 状态条内容降为 45% 不透明度、状态点转灰；**悬停卡保持不透明**（否则字看不清）。
- ⓘ 点开完整详情浮层（会话/模型/上下文/会话累计/今日/口径说明）；⚙ 打开状态条设置
  （显示分段 / 排布均分·居左·居右 / 中文万·亿单位，存 localStorage）；点别处或 Esc 关闭，
  两个浮层互斥；打开时自动收起悬停卡。

## 7. 在 WorkBuddy 客户端里安装（可选）

ZCode 的插件包带 asar 注入链，**不能**直接装进 WorkBuddy（hooks 会去改 ZCode 的程序文件）。
因此仓库另带一个 WorkBuddy 专用构建 `plugins/workbuddy-token-usage/`，只含 MCP + `/usage`：

```text
plugins/workbuddy-token-usage/
  marketplace.json                 # 市场清单（给人看/CLI 用，与下面那份逐字节一致）
  .codebuddy-plugin/
    marketplace.json               # ★ 客户端真正读的市场清单：只在 <市场目录>/.codebuddy-plugin/ 下找
    plugin.json                    # 插件清单（mcpServers 内联，命令用 ${CODEBUDDY_PLUGIN_ROOT}）
  commands/usage.md                # /usage 命令
  skills/token-usage/SKILL.md      # 技能入口（插件面板/斜杠菜单里可见）
  usage_mcp.py / zusage.py / wb_usage.py / usage_stats.py / token_pricing.py / wb-overlay.cjs
                                   # 运行时副本（根源码同步生成）
```

> 踩坑记录：客户端解析市场清单时按 `['.codebuddy-plugin','.workbuddy-plugin','.claude-plugin']`
> 依次找 `marketplace.json`，**只放根目录会读不到**——表现为插件已启用却不生效，
> 日志报 `plugin not found in marketplace`，且该插件的 MCP server 不会注册。

装法（两种等价，任选）：

```bash
# 1) WorkBuddy 自带 CLI（客户端未运行时最稳）
codebuddy plugin marketplace add D:/work/zcode-token-usage-statusbar/plugins/workbuddy-token-usage
codebuddy plugin install workbuddy-token-usage@workbuddy-token-usage
codebuddy plugin list

# 2) 客户端正在运行时 CLI 会抢不到固定端口（EADDRINUSE 127.0.0.1:63352），改用本地登记脚本
python scripts/install_workbuddy_plugin.py            # 装/更新（先备份三份状态文件）
python scripts/install_workbuddy_plugin.py --check    # 只校验
python scripts/install_workbuddy_plugin.py --uninstall
```

装完**完全退出并重开 WorkBuddy**，新会话里即可用 `/usage` 或让模型调用 `token_usage`。
插件清单里把 `ZUSAGE_HOST=workbuddy` 写进了 MCP 的 `env`，所以默认读 WorkBuddy 库；
要查 ZCode 时在调用里传 `host="zcode"`。

WorkBuddy 构建不进 ZCode 的发布链（`release_tool.py`/市场清单不打包它），
经上面任一入口安装即可；分发渠道就是本仓库的这份目录。

改了 `usage_mcp.py` / `zusage.py` / `token_pricing.py` 之后：

```bash
python scripts/sync_workbuddy_plugin.py     # 更新插件副本
python scripts/install_workbuddy_plugin.py  # 重新部署到 WorkBuddy 缓存
```

## 8. 已知边界

- **状态条浮层注入仍只针对 ZCode**（`app.asar` 注入、渲染桥、窗口 IPC 都是 ZCode 客户端契约）。
  WorkBuddy 侧的接入面是 CLI / MCP / JSON 快照，不改动 WorkBuddy 客户端文件。
- 快照顶层的 `host`、`caps`、以及 WorkBuddy 行的 `credits` / `credit_entries` / `cwd` / `status` / `model`
  是新增字段；旧消费端读到未列出的键会忽略，缺字段仍按既有默认值降级。
- 远程（SSH/WSL/Docker）查询链路仍是 ZCode 语义：它转发的是 `zusage.py json`，
  若远端也要读 WorkBuddy 数据，需在远端写同样的 `host` 配置。
- 逐问速率行（`token_rate.py`）依赖逐请求 token 与耗时，WorkBuddy 不适用。
- 桌面主桥（`inject-main.cjs`）监听库文件变化、判断「有无新写入」时仍按默认解析目录，不跟随
  `hosts.zcode.db_path`：库放在非默认位置时，快照内容读的是覆盖库，但覆盖库的写入不会触发状态条
  刷新，新数据可能要等到切换会话等其它刷新时机才显示。详见
  [specs/db-path-config-override.md](../specs/db-path-config-override.md)「遗留」。
