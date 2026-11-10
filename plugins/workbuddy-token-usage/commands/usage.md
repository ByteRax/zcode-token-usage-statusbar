---
description: 查询 WorkBuddy 本地 token 用量（上下文占比 / credit / 会话 / 模型 / 工作区）
argument-hint: "[today|week|days:N|sessions|models|session:<id前缀>|workspace:<子串>]"
---
查询本地用量并整理成报表回复。数据只读，来自本地 SQLite（WorkBuddy 用 `~/.workbuddy/workbuddy.db`）。

取数顺序：

1. 优先调用本插件提供的 MCP 工具 `token_usage`（stdio server 键 `zusage`，工具名以实际注册的 `mcp__*__token_usage` 为准）。
2. 若该工具不可用（未启用 / 未注册），退回用 Bash 直接跑插件内的 CLI，插件根目录 = 本命令文件所在目录的上一级：
   `python "<插件根目录>/zusage.py" <子命令>`（Windows 上 `python3` 可能不存在，依次改用 `python`、`py -3`）

参数规则（$ARGUMENTS），括号内为 CLI 子命令对照：

- 为空或 "now" → scope="current"（子命令 now）
- "today" → scope="today"（子命令 today）
- "week" → scope="days:7"；"近N天" → scope="days:N"（子命令 days N）
- "sessions" → scope="sessions"；"最近N个会话" → scope="sessions:N"（子命令 sessions N）
- "models" → scope="models"；"按模型近N天" → scope="models:N"（子命令 models N）
- "session:<会话id前缀>" → 原样传入（子命令 session <前缀>）
- 工作区/项目用量（如"XX 项目用了多少"）→ scope="workspace:<目录名子串>"；未命中时工具会列出候选目录，换更准的子串重试（子命令 workspace <关键词>）
- 明确要查 **ZCode** 的用量 → 额外传 host="zcode"（CLI 加 `--host zcode`）；其余情况不传 host，默认按配置走 WorkBuddy
- 其他输入 → 原样作为 scope 传入

口径说明（必须如实转述，不要自行补数）：

- WorkBuddy 的口径：上下文来自 `session_usage`；token / 缓存 / 思考 / credit / 工具调用 / 轮次来自会话正文的逐次调用记录（`providerData.rawUsage`）；预估费用按 models.dev 牌价逐模型估算（有汇率显示 ¥，否则 $）。价表未收录的模型报表会写「不可得」并注明范围，不要用兜底均价或 0 冒充。
- 上下文占比 = 当前上下文已用 ÷ 窗口容量；credit 是宿主计费口径，不是账单。
- 两个宿主现在都提供 input/output/缓存/思考、速度与预估费用；差别只在数据源（ZCode 读 model_usage，WorkBuddy 读会话正文）。

用户附加要求：$ARGUMENTS
