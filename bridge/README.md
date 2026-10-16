# bridge：新版 ZCode（3.15.3+）数据源桥接

## 问题

ZCode 桌面端 3.15.3 起重构了数据层，**不再写 `~/.zcode/cli/db/db.sqlite`**（旧版聚合库）：
新版安装目录 `app.asar` 全文检索 `db.sqlite` 0 命中，`cli/db` 仅出现在备份路径白名单里。
每次请求的原始用量改为实时落在 CLI 侧逐会话文件：

```
~/.zcode/cli/rollout/model-io-sess_<会话id>.jsonl
```

而插件（悬浮状态条 / `/usage` / MCP）只读旧库，于是所有项恒为 0。
上游同类报告：xhwxt 仓库 issue #19「最新3.15.3版本失效」（关闭时未附修复）。

## 方案

`db_bridge.py` 是一个零依赖的 Python 守护进程（仅标准库），把 model-io jsonl
增量同步进插件期望的 `db.sqlite`，不修改插件与 ZCode 本体：

- 每 2s 轮询 rollout 目录，按文件 offset 增量读取（state.json 断点续传，进程幂等）；
- 解析每条记录的 usage / turnId / toolCalls / attempt，写入 `model_usage`、
  `turn_usage`、`tool_usage`、`session`（表结构按 `zusage.py` 的查询逆向，含
  `sess_subagent_*` 前缀与 `query_source='subagent'` 口径）；
- 子代理的 parent / cwd / 任务名取自 `~/.zcode/cli/agents/<父会话>/agent_x/metadata.json`；
- `part` 表建空壳，保证 `_sub_agent_tasks` 查询不报错（任务名回退子会话标题）；
- 写入幂等：`(session_id, request_id, attempt)` 唯一索引 + `insert or ignore`，
  重复导入不产生脏数据；`turn_usage` 按触发的轮从 `model_usage` 重算。

首次运行会把损坏/残留的旧库挪为 `db.sqlite.corrupt-bak` 后重建；若旧库可用则直接续写。

## 使用

```bash
# 前台运行（观察日志）
python bridge/db_bridge.py

# 常驻：登录自启（Windows）
# 在启动文件夹放一个 .vbs：
#   CreateObject("WScript.Shell").Run """<pythonw 路径>"" ""<仓库>/bridge/db_bridge.py""", 0, False
```

成功判据：`python zusage.py now` 能看到非零用量；悬浮条 2s 内跟随刷新。

## 已知限制

- model-io 记录不含首字时间：`time_to_first_token_ms` 恒 0，生成速率分母退化为总耗时；
- 工具执行耗时无来源：`tool_usage.duration_ms` 为 0（次数与错误数口径不受影响）；
- rollout 总量可能很大（实测单机 26GB）：超过 64MB 的历史文件仅导入尾部 64MB
  （行对齐），窗口外的古老请求不进库；增量阶段不受影响；
- 请求完成才落 jsonl 行，状态条天然滞后约一问；
- 休眠的旧会话标题可能显示为 `<system-reminder>` 开头（其首条用户消息即提醒块），
  会话再次活跃后自愈。
