# 项目检查目录

用于选择扫描入口，不是每轮必跑清单，也不是预先认定的缺陷列表。路径均相对仓库根；先核实当前文件和符号，再沿根 `AGENTS.md` 的规则与测试索引展开。文件、数量、版本和测试通过数以本次检出为准，不在此维护副本。

| 风险域 | 源码与检查入口 | 重点判断 |
| --- | --- | --- |
| 统计、计费与缓存 | `usage_stats.py`、`zusage.py`、`token_rate.py`、`token_pricing.py`；`test_usage_watermark_cache.py`、`test_token_rate.py` 等 | 计算是否重复计数，速度／时间窗口是否按各自契约，缓存是否带库与身份且正确失效，未知是否被误当零 |
| 额度与凭据 | `src/quota/`、`model-puller.cjs`；`quota-source-lifecycle.test.cjs`、`quota-paths.test.cjs` | 来源撤销、epoch、凭据变化和退避；迟到响应、密文降级、域白名单；不通过真实请求试错，不把账户额度和 token 统计互推 |
| UI、主桥与生命周期 | `src/overlay/`、`turn-stats.js`、`inject-main.cjs` 的 `hotReloadMainModules`；`plugin-hot-swap.test.cjs`、`overlay-*` | 状态所有者、重复注入与销毁、在途请求、监听器清理、配置显式关闭；源码能力、安装清单分类与当前进程实际能力分别核对 |
| 分栏与远端隔离 | `renderer_bridge.py`、`inject-main.cjs`、`zusage.py`；`test_remote_targets.py`、`inject-remote-recovery.test.cjs` | SID 与 workspace identity、可信节点、过期载荷、失败时是否借用其他目标；远端单文件承诺与本地多文件部署区分 |
| 构建、安装与分发 | `scripts/build_overlay.py`、`scripts/build_quota.py`、`sync_plugin.py`、`install.py`、插件专有安装入口、`release_unpack.py` | 权威分片到产物的漂移、各渠道文件集合、实际依赖闭包、可信同步、锁及安全解包；不要求不同渠道清单完全相同 |
| WorkBuddy 独立链 | `zusage.py` 的 `HOST_CAPS`／`resolve_host`、`wb_usage.py`、`wb-overlay.cjs`、`scripts/sync_workbuddy_plugin.py`；`test_hosts_workbuddy.py`、`test_wb_usage.py` | agent 与 host 区分、能力降级、页面脚本代际及独立副本；不套用 ZCode 的 asar 或发布清单 |
| 性能与资源 | `zusage.py` 的缓存／常驻连接、`inject-main.cjs` 的查询泵；`test_serve_conn_reuse.py`、`specs/perf-lag-reduction.md` | 冷帧与命中帧分开、慢帧冷却、请求／进程退出、内存增长；性能判断需同条件前后测量，不用代码行数或测试耗时替代 |
| 测试有效性与维护漂移 | `tests/helpers/`、`tests/README.md`、对应 spec／域规则／文档 | 测试能否独立运行、替身是否真的覆盖契约、是否只有字符串断言、规则是否过时；重复与大文件仅作线索，不自动清扫全仓 |

## 原分包专项如何使用

- **浮层分片**：核查拼接器和闭包／初始化顺序，再判断拆片是否有收益。纯结构调整优先保持生成代码不变；边界注释等变化需说明并核对，文本 diff 不等于 AST 证明。
- **主进程与 Python 热更**：查真实导入和进程链，不机械监听所有 `.py`；区分常驻、一次性、MCP 和远端进程。清单中的 `COLD_FILES` 不能单独证明当前 loader 无法热换。
- **单文件兼容**：按承诺的运行入口在隔离目录验证缺少可选模块的情况。`zusage.py` 与 `token_rate.py` 不自动具有相同远端契约，不用宽泛异常捕获掩盖模块内部错误。
- **跨端同源性**：比较有共同契约的计算，不抹平有意的产品差异。当前不存在的 `web/overlay.js` 等入口不恢复、不凭记忆审计。
- **依赖闭包**：先查现有校验能力，区分标准库、本地必需、可选和动态依赖；静态解析未覆盖的形式要报告，不自称完整证明。

## 验证选择与成本

- 日常巡检先用已核实的只读入口，如 `python3 scripts/build_overlay.py --check`、`python3 scripts/build_quota.py --check`、`python3 sync_plugin.py --check` 或 `--verify-manifests`；确认实现和环境无额外副作用，并设置 `PYTHONDONTWRITEBYTECODE=1`。这些检查只证明各自覆盖的语法／漂移／清单，不证明产品行为。
- 对疑点按根规则选择最少必要的隔离测试，逐项报告命令与覆盖；不是所有扫描都要跑全量。扩大到跨模块修复或全面回归时才考虑 Node／Python 全套，冻结被测树编辑并保留失败、跳过与耗时。
- 真实 CLI、安装器、账号接口和客户端操作不是默认巡检命令。测试夹具与临时目录也要核实隔离，不依赖真实 HOME、数据库或安装路径；不要为了测试安装依赖或更改系统配置。
- UI 必须按用户的内置浏览器优先约束执行目标交互并核对错误／请求；模拟页面不能代替实际宿主热更。没有通道时报告证据边界，不以静态检查宣称行为通过。
- 与变更相关的生命周期按风险覆盖连续热换、在途请求、失败保留、销毁后清理、关闭热更；构建／分发变化需补真实产物的隔离加载验证，避免只测源码切片。
