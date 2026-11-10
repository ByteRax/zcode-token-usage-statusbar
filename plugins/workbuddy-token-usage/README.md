# WorkBuddy 用量查询插件

只读查询 WorkBuddy 本地用量，提供 `token_usage` MCP 工具、`/usage` 命令与 `token-usage` 技能。
**不改客户端文件、不注入 asar**；牌价缓存按 12h 匿名同步（`pricing.fetch: false` 可关），无凭据上传。

浮层：本插件把 `overlay` 策略声明为 `cdp`——MCP 进程启动时会拉起 `wb-overlay.cjs`，
连客户端自带的 `--remote-debugging-port`（默认 9335，插件清单已设 `ZUSAGE_CDP_PORT`），在**输入卡内底部**注入一条状态条：
`● 本地库 ｜ ⚡t/s ｜ 本轮 ｜ 会话 ｜ 工具 ｜ 今日 ｜ 上下文% ｜ 项目 ｜ ⓘ ｜ ⚙`，
分段按输入框宽度均摊、2.5s 刷新；**每个分段悬停弹信息卡**（速度卡带最近 8 段柱状图、档位配色与统计口径），
ⓘ 点开完整详情，⚙ 打开状态条设置（显示哪些分段 / 排布均分·居左·居右 / 中文万·亿单位，
偏好存本机 localStorage）；超过 12s 没刷新状态条变灰（悬停卡不受影响）。不用可关：

```json
{ "agents": { "workbuddy": { "overlay": false } } }
```

手动排查：`node wb-overlay.cjs --once`（注入一次并打印数据）。

数据源两路：`~/.workbuddy/workbuddy.db` 的 `session_usage`（当前上下文 / 窗口），
以及会话正文 `projects/*/*.jsonl` 的 `providerData.rawUsage`（每次模型调用的
token / 缓存 / 思考 / credit，加上工具调用与轮次）。速度按响应窗口推算，属近似值；
费用按 models.dev 牌价逐模型估算（有汇率显示 ¥，否则 $），未收录模型标「不可得」；同一套查询库也可用 `host="zcode"` 读 ZCode 的逐请求用量。

## 安装

```bash
codebuddy plugin marketplace add <本目录>      # 或工作区里的 plugins/workbuddy-token-usage
codebuddy plugin install workbuddy-token-usage@workbuddy-token-usage
codebuddy plugin list                          # 确认已启用
```

客户端**正在运行**时 CLI 会抢不到固定端口（EADDRINUSE 127.0.0.1:63352），
改用本地登记脚本 `python scripts/install_workbuddy_plugin.py`（见 [docs/hosts.md](../../docs/hosts.md) §7）。

装完重启客户端，新建会话后即可用 `/usage` 或让 AI 调用 `token_usage`。

## 用起来

```bash
# CLI 直查（插件目录内）
python zusage.py host                # 自检：宿主、库位置、可用指标
python zusage.py now                 # 当前会话上下文 + credit
python zusage.py today
python zusage.py sessions 10
python zusage.py --host zcode today  # 临时查 ZCode 侧
```

MCP 侧：`token_usage(scope="current"|"today"|"days:N"|"sessions:N"|"models:N"|"session:<前缀>"|"workspace:<关键词>", host="workbuddy"|"zcode")`。

## 配置

默认读 `~/.workbuddy/workbuddy.db`。库在别处时用环境变量 `ZUSAGE_WORKBUDDY_DB`，
或在插件目录的 `config.json` 写：

```json
{ "host": "workbuddy", "hosts": { "workbuddy": { "db_path": "D:/other/workbuddy.db" } } }
```

宿主判定优先级：工具参数 `host` > `ZUSAGE_HOST`（本插件已在清单 `mcpServers.env` 设为 `workbuddy`）> `config.host` > agent 跟随（本构建读 WorkBuddy 库）。

## 文件

`usage_mcp.py`、`zusage.py`、`token_pricing.py` 是从仓库根同步的副本，
改了根源码后在仓库根运行 `python scripts/sync_workbuddy_plugin.py` 更新（`--check` 只校验）。

## 许可

MIT — [ByteRax/zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar)。
