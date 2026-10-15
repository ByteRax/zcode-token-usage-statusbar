---
description: 显示 ZCode token 用量（当前会话/今日/近几天/按会话/按工作区/指定会话明细）
argument-hint: [current|now|today|week|days:N|sessions[:N]|models[:N]|session:<id前缀>|workspace:<目录关键词>]
---
查询 ZCode token 用量，把返回的报表原样整理后回复；用户要详细表格时用完整数值（带千分位），不要自行缩写。

取数顺序：

1. 优先调用 MCP 工具 `token_usage`（本插件 zcode-token-usage-statusbar 提供的 stdio server）。
2. 若该工具不可用（未启用/未注册），退回用 Bash 直接跑 CLI，插件根目录即本命令文件所在目录的上一级：
   `python3 "<插件根目录>/zusage.py" <子命令>`

参数规则（$ARGUMENTS），括号内为 CLI 子命令对照：

- 为空、"current" 或 "now" → scope=current（子命令 now）
- "today" → scope=today（子命令 today）
- "week" → scope=week（子命令 days 7）
- "days:N" 或 "近N天" → scope=days:N（N=天数；子命令 days N）；用户没给 N 就用 scope=week（子命令 days 7）
- "sessions" → scope=sessions，默认最近 10 个会话（子命令 sessions）；"sessions:N" 或 "最近N个会话" → scope=sessions:N（子命令 sessions N）
- "models" → scope=models，默认按模型统计近 7 天（子命令 models）；"models:N" 或 "按模型近N天" → scope=models:N（子命令 models N）
- "session:<会话id前缀>" → 原样传入（返回该会话总量+按模型+子代理明细）（子命令 session <前缀>）
- "workspace:<目录关键词>" → 原样传入（子命令 workspace <关键词>）；统计某个工作区/项目（如"XX 工作区/项目用了多少 token"）→ scope=workspace:<目录名子串>。用户用中文或简称称呼工作区时，先从需求推断实际目录名的特征子串（缩写式称呼可直接传，工具支持单词首字母缩写匹配）；未命中时工具会列出候选目录，照着换更准的子串重试
- 其他输入 → 原样作为 scope 传入 MCP；工具不可用时说明支持的参数，不把未知 scope 当成 CLI 子命令

CLI 回退必须按上面的对照转换：`current` / `now` 用 `now`，`week` 用 `days 7`，带冒号的 scope 拆成子命令和参数；CLI 不直接接受 `week`、`days:N` 等 scope 字符串。

用户附加要求：$ARGUMENTS
