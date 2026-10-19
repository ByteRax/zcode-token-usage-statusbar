# 插件更新测试

## 自动回归

在仓库根目录运行，无第三方依赖，不操作真实插件库存：

```bash
node --test tests/*.test.cjs
python3 -B -m unittest discover -s tests -p 'test_*.py'
node --check overlay.js
node --check inject-main.cjs
python3 sync_plugin.py --check
```

覆盖自动更新默认开启、缺失字段/配置的默认行为、显式关闭跨重启保持、损坏/非布尔配置禁止自动执行、开启时按限频规则检测/安装、24 小时限频与跨重启保持、手动检测不安装、手动更新、错误与重试、禁用插件保护、固定动作与本地窗口信任边界、版本比较、原子同步、手改保护和旧会话防回滚。
另覆盖逐问速率行：`--current` 守卫（本会话提问时刻按会话记录，多窗口交替提问互不误吞；纯问答轮输出为空）、思考口径（分子 = output 已含思考不另加、含思考段窗口 = completed−started，据 raw_usage_json 裁决）、加权速率/首字/段数峰值/会话累计口径、⚙ 面板开关（`answer_rate_line` 关→不注入指令仍写状态、缺省/损坏/显式 true→开启）、hook 输出严格 JSON（`test_token_rate.py`）。
另覆盖浮层历史统计行：重启恢复的零输出或缺字段历史轮不误报不可用；tracker 记录滑出或换代后保留已有行；在途数据库富文本仍可替换占位，同轮容器重挂时已有缓存可恢复，回推在重挂前后到达均不重复查询（`overlay-bridge.test.cjs`）。无有效统计或缓存的历史轮不补造数据。

另覆盖客户端升级覆写后的真实微型 asar 重注入、非默认目标定位、无 loader 的独立更新启动、离线待同步恢复、跨进程锁和 Windows 无窗口收尾，以及仅运行时主进程文件更新时的重启提醒、SessionStart 诊断记录与写入失败时 stdout 协议保持。仅临时夹具作为写入目标，不修改真实配置、标记或 `app.asar`。

另覆盖真实多进程 OS 锁唯一持有者、EOF/父进程退出释放、同步交错防回滚、同版持续热修保护、安装提交后超时/孤儿安装进程协调、跨实例检查中关闭、持久重启哈希确认、相同源 mtime 的实际 loader/常驻 Python 热更新，以及 quiet/可见监控/`--finalize` 的来源/TMP 身份检查和短暂占用重试。测试只使用临时夹具，不操作真实客户端；Windows 分支测试不等同于 Windows 实机验收。

另覆盖正式 GitHub Release 筛选、分页、资产来源和 SHA256、目录/远端分流、自定义 storage 与官方 CLI 一致性（普通 list --json 顶层数组与 list --available 对象包络两种真实形状）、渠道清单一致性、安装前关闭/禁用/卸载、来源/ref 变化、安装提交结果错配持续阻止同步及离线恢复。安全解包检查完整源码白名单、JSON/资源引用、路径/符号链接、真实压缩流/CRC/大小边界；发布工具共享此校验器。发布只使用临时仓库和 gh stub，真实源码 build → verify → download → unpack 有闭环回归，不执行真实发布。

另覆盖 R1–R14 修复：真实 Node 验收器与 SessionStart/sync/install 入口联动、活安装 PID 和错误 Release 拒绝、跨版本部分写入恢复并保护真实热修；语法失败包不能被手工/quiet/可见收尾激活，独有 TMP 暂存与发布中断可重试；所有运行时配置写入口共享锁；仓库大小写、版本化非核心文件增删、字面 argv、重定向总超时取消；实际双语 tooltip 和热更新代际清理、真实并发 hooks、本问开始时间/轮次身份与旧 schema 降级、未完成同步提示不冒称安装成功。

## 远端路由与恢复回归

在仓库根目录可单独运行：

```bash
python3 -B -m unittest discover -s tests -p 'test_remote_targets.py'
node --test tests/inject-remote-recovery.test.cjs
```

这些测试使用临时客户端设置、数据库/传输夹具与隔离查询泵，不应访问真实 SSH 服务器、个人配置或真实客户端注入。覆盖自动连接适配、`auto` 与旧 `enabled` 开关独立、手动 `identity`/`identities` 绑定、多目标路由和独立 `today`/错误、失败与暂未找到会话的持续重试，以及统计查询链恢复。更新后的 JSON scope 协议与工作区身份隔离需配合全量自动回归检查，不能只凭脚本语法通过就宣称跨机验收成功。

Node 查询泵回归还覆盖首个成功/SSH 失败/error/null 响应后的实际定时续查、已有链连续错误与空响应、同 SID 切换身份免握手、同 SID 跨窗口/分栏 scope 隔离、晚加载/不可信/歧义身份默认关闭路由后由合法 IPC 恢复、配置与客户端设置变化打破去重、常驻进程错误/看门狗及单次查询只结算一次，以及彻底关闭后停止远端轮询、重新开启时恢复。不会替宿主执行真实 SSH 重连。

真实宿主 schema 回归检查本窗口会话节点的 SID、paneId、身份协议与字段一致性：无历史/无分组的远端主标签页可按当前节点路由；其它窗口删除本地记录、覆写或删除同远端工作区 last-session 均不能改变本窗绑定；本地与远端同 SID、节点身份切换/撤销、脱离 DOM、未知协议、可信 workspace IPC 与 tasks 否决均保持来源隔离，迟到远端载荷不会重新点亮已撤销身份。renderer 补丁回归覆盖 3.15.3/3.16.1 属性映射、旧补丁原子升级、重复安装幂等、卸载还原、缺失/重复锚点、内容篡改与未知版本拒绝；真实归档只读预验输出到临时目录，不修改客户端。

文档与配置还需检查：`config.example.json` 及 Markdown 的 JSON 代码块能解析，手动多服务器例子含身份，README 本地链接/锚点有效，`README.md` 与 `README.zh-CN.md` 一致，中英文远端发布范围与限制一致。

**验收边界**：夹具结果不等于 Windows/macOS 桌面、多服务器或各种 SSH 认证方式的实机验收。源码 `main` 尚未发正式 Release；真实使用需更新本机安装副本、完全退出重启，并手工在 SSH 远端部署同版本查询脚本。插件不会自动登录、解密复用宿主密码/加密私钥、安装远端脚本或替宿主自动重连 SSH；自恢复仅指统计查询链持续重试及宿主重连后续查。partial 远端 IPC 不等于当前主 pane 归属；身份未知或归属歧义时不推断，主标签页路由未经实机验收前不能宣称生效。桌面 JSON 链支持不代表 MCP/回答速率自动跨机，纯 CLI 无状态条 UI。

另覆盖宿主插件契约：市场条目的中英本地化及 Release 渠道保留、统计命令路径/会话的 POSIX 参数引用、Windows PowerShell 编码调用的字面参数、短 MCP 服务键与钩子 matcher/超时；SessionStart 两层异常路径、卸载豁免和探测权限失败、安装未完成和正常重启提示均检查有效的 `additionalContext` 通道（`test_plugin_contract.py`、`test_session_start_channels.py`）。Windows 原生 CMD/Git Bash 执行测试仅在相应环境运行，macOS 会明确跳过；编码结构校验不代表 Windows 实机验收。

## 宿主真实 CLI 集成（macOS）

```bash
python3 -B tests/plugin-cli-smoke.py
python3 -B tests/plugin-commands-cli-smoke.py
```

需要已安装 `/Applications/ZCode.app` 和 macOS 自带 `sandbox-exec`。脚本在临时 HOME/cwd 下建立无 hook/MCP 的最小市场，运行官方添加、安装、检测及更新命令，验证 1.0.0 升为 1.1.0 的安装记录与缓存，并测试真正的 `createUpdater` 及独立 `--auto` 子进程入口。独立入口仅附带固定 JSON 输出的同步夹具脚本，不包含真实注入器。网络、临时目录外写入、读取真实 HOME/仓库/asar 均被沙箱拒绝。临时目录会自动删除。

`plugin-commands-cli-smoke.py` 使用真实客户端 CLI 和临时 bundle 副本，验证三个裸名命令的 list/inspect、实际协议命令目录与纯文本参数展开，旧插件前缀名明确 not-found；还验证旧聊天安装/更新子命令只返回 Usage，以及短 MCP 服务键对应的模型工具名。只复制清单、命令和被测分派代码，不复制或运行 hook/安装器；不启动模型、NDJSON 会话或 UI，因此不是界面端到端测试。bundle 结构改变时会明确失败，不退回模拟实现。

## 设置面板交互

```bash
node tests/plugin-update-demo.cjs
```

访问 <http://127.0.0.1:8799/>。页面载入真实 `overlay.js` 和更新器，市场响应、安装记录、配置和同步报告使用临时测试数据。不会更新真实插件。

1. 点 ⚙，确认自动更新默认已勾选（夹具未运行定时 tick）、检查更新可用、立即更新不可用。
2. 先关闭自动更新，确认配置记录 `false`；点检查更新，确认检测到 1.1.0，当前仍为 1.0.0。
3. 点立即更新，确认当前变为 1.1.0，出现重启及保留热修文件提示。
4. 开启自动更新，确认配置保存；关闭后仍可手动检测。
5. 点模拟网络失败，再手动检测，确认失败原因可见且按钮恢复可用；恢复网络后可重试。
6. 切换 English，确认更新文案、开关和版本状态保持。

`/evidence` 是只读测试动作日志，包含调用的固定 CLI 参数、临时配置与当前状态。结束时 Ctrl+C 清理临时目录。

生产环境的初次升级仍由用户在“设置 → 插件管理”完成；源码/清单更新不等同于已安装插件升级。1.4.0 的 GitHub 来源检测正式 Release 并核对发布渠道 ZIP/hash，不能回退开发分支；本地目录市场只检查本地代码，不执行 git pull。
