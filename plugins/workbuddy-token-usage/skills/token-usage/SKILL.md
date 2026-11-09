---
name: token-usage
description: 查询本地 token 用量与 credit（WorkBuddy 读 ~/.workbuddy/workbuddy.db 的会话级上下文与 credit；ZCode 读逐请求 model_usage）。当用户问「今天用了多少 / 当前上下文多大 / 这个会话花了多少 credit / 哪个模型用得多 / 某个项目用了多少」时使用。
---

# Token 用量查询

数据只读本地 SQLite，不联网。默认宿主由插件清单的 `ZUSAGE_HOST` 决定（WorkBuddy 构建预置为 `workbuddy`）。

## 怎么查

1. 优先调用 MCP 工具 `token_usage`（server 键 `zusage`）：
   - `scope`：`current`（默认）/ `today` / `week` / `days:N` / `sessions[:N]` / `models[:N]` /
     `session:<id前缀>` / `workspace:<目录关键词>`
   - `host`：留空跟随配置；`zcode` 可查 ZCode 的逐请求用量（含速度与预估费用）
2. 工具不可用时用 Bash 跑插件内 CLI（插件根目录 = 本技能目录的上一级）：

```bash
python "<插件根>/zusage.py" now          # 当前会话
python "<插件根>/zusage.py" today
python "<插件根>/zusage.py" sessions 10
python "<插件根>/zusage.py" --host zcode today
python "<插件根>/zusage.py" host         # 自检：宿主、库位置、可用指标
```

Windows 上 `python3` 可能不存在，依次改用 `python`、`py -3`。

## 口径（回答时必须如实转述）

- 上下文 = 当前已用 ÷ 窗口容量（来自 `session_usage`）；token / 缓存 / 思考 / credit / 工具调用 / 轮次来自会话正文的逐次调用记录。
- 速度是**近似值**：输出 tokens ÷（响应时间 − 触发者时间），含思考与网络，不含工具执行。
- **预估费用**按 models.dev 牌价逐模型估算；价表未收录的模型写「不可得」并注明范围，不要用兜底均价或 0 冒充。
- 今日/项目按请求时间跨会话聚合；credit 是宿主计费口径，不是账单。
- 两个宿主都提供 input/output/缓存/思考、速度与预估费用，差别只在数据源。
