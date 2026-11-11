# 测试与实机验证方法

适用路径：`tests/` 全部新增或修改、根级 `renderer_live_check.cjs`、任何"验证一下"的命令选择与实机验收操作。

测试命令、按改动范围选文件的对照表与真实 CLI 沙箱边界在根 [AGENTS.md](../../AGENTS.md) §6；本文件是方法论与替身/夹具陷阱。基础纪律：测试失败→定位根因→修复→重测，不得在红测上宣布完成；无法修复时如实报告。

## 1. 运行约定

- 仓库根运行；没有 build/lint/format。Node 回归以 VM/stub 为主，Python 回归用临时数据库、目录和夹具；`-B` 避免写 bytecode，需要时同时设 `PYTHONDONTWRITEBYTECODE=1`（不保证子进程不写）。
- Node 测试通配符依赖 shell 展开，Windows PowerShell 显式列文件；部分进程/平台测试按环境跳过，**必须报告**跳过。
- Python 测试必须在 git 工作树/worktree 里跑（git archive 副本会让部分用例报错）；新测试必须隔离 `os.environ`（宿主设了 `ZCODE_ASAR` 会真拉起宿主）且不依赖执行者的真实身份（root 下误报）。
- 共享文件改动后先跑测试再 `sync_plugin.py`（副本同步断言在漂移时会红），`--check` 只验语法/漂移不验行为。
- 全量基线不在活跃工作树后台串行跑：后跑的一段（启动晚几十秒）会读到中途已修改的中间态出假红（先例：「根已改、副本未 sync」窗口使 test_plugin_contract 假红，issue #248）；真基线另开干净临时检出单独跑，绿/红结论只对跑瞬间的树负责；基线进行中冻结对被测树的编辑（unittest discover 启动后仍逐模块 import，撞中间态文件报假失败）。

## 2. 隔离接缝与替身陷阱

- `ZCODE_USAGE_DB` 只隔离插件逐问脚本，不是根 `zusage.py` 的通用数据库隔离开关；根实现的新测试沿用夹具替换数据库入口，默认不执行真实查询。插件安装器测试接缝 `ZUSAGE_PLUGIN_RUNTIME` / `ZUSAGE_PLUGIN_ASAR` 可指向临时副本，不碰真机。
- Python sqlite 替身须同时支持可迭代与 `fetchone` 两种用法（列表子类化游标）。
- Python 公共测试夹具与单文件独立运行纪律：
  - 跨测试文件复用模块加载、asar 打包或快照字节缓存一律走 `tests/helpers/py_test_support.py`（提供 `load_module`、`make_asar`、`cached_plugin_runtime_bytes`、`cached_head_bytes`）。**禁止**在测试文件间写 `from test_xxx import ...` 裸同级导入（`python3 -m unittest tests/test_xxx.py` 单文件运行时 `tests/` 不在顶层 `sys.path`，会直接报 `ModuleNotFoundError`）。
  - 构造临时插件目录模拟 `RUNTIME_FILES` 时，写入 `.py` 文件的占位内容必须是合法 Python 语法（如 `# new package: ...` 注释），并在 `addCleanup` 中移除临时插入 `sys.path` 的目录并恢复 `sys.modules["patch_install"]`，防止 `overlay_install.load_patch_install()` 在单文件独立运行或跨模块时触发 `SyntaxError` 或向后续测试泄漏假模块。
  - 涉及真实 Node 验收子进程的同步测试（如 `test_plugin_upgrade.py`、`test_runtime_sync_guard.py`）优先复用 `cached_plugin_runtime_bytes` / `cached_head_bytes`，并在运行目录预置非核心未变更文件，只让核心冷热文件（`inject-main.cjs`、`overlay.js`、`plugin-updater.cjs`、`plugin-release.cjs`、`plugin-storage.cjs`）进入写入验收队列，避免单次测试重复拉起 20 次 Node 进程。
- VM 切片测试：优先使用公共提取助手 `tests/helpers/overlay-extract.cjs`——切 `overlay.js` 用 `readOverlaySource`、`readOverlayPart`、`sliceOverlay`、`getNamedSlice`（`NAMED_SLICES`），切 `inject-main.cjs` 用 `readInjectSource`、`sliceInject`、`getInjectSlice`（`INJECT_SLICES`），避免在各测试内重复手写 `indexOf`/`slice` 锚点查找；切片桩必须捕获 sandbox 对象（Node 域闭包看不到 vm 全局）；依赖源（stages 等）与预注入状态须在切片前拼接好；切片区间内不得引用区间外变量。`tests/overlay-port-patches.test.cjs` 等按源码切片计数断言的测试，改被切片源码时同步核对断言。
- 定时器卫生（防 Node 测试进程空等挂起）：生产代码与测试中的超时兜底定时器（如 `Promise.race` 的 fallback `setTimeout`、`AbortController` 的 `kill` 超时、`catalogPromise` 宽限期定时器）必须在结算后通过 `.finally(() => { if (typeof clearTimeout === "function") clearTimeout(timer); })` 立即清理（加 `typeof` 守卫以兼容仅提供 `setTimeout` 桩的极简 VM 沙箱），并对长周期兜底定时器调用 `timer.unref?.()`，防止断言结束后事件循环仍被悬空定时器挂住数秒至十余秒。
- stub Element：`hasAttribute/getAttribute` 对 `data-pane-id`/`data-session-id` 的特判走 pid/sid；`querySelector` 未注册选择器返回新建空元素而非 null；`className` setter 同步 classList；夹具 `createTextNode` 产物必须可被遍历（getAttribute/children 可用）。vm 跨上下文比较用 `[...arr]`/`{...obj}` 展开。跨 realm 另有两坑：Node 域 `Map` 过不了 vm 域 `instanceof Map`（registry 夹具一律在 vm 域内构造）；vm 域抛的 `TypeError` 过不了 Node 域 `assert.throws(…, TypeError)`，改用消息正则匹配。
- mock 断言：`execFile` 参数是整串 argv，用 join 后整串判断（`Array.includes` 匹配不到 `--cached`）；mock `executeJavaScript` 返回的 JSON 字符串会被 `Array.isArray` 判死，先解析。
- `tests/overlay-bridge.test.cjs` 的 `.zu-live` 替身每次 `querySelector` 都从 `innerHTML` 回放 class/text，整条重渲染后重新查询即反映新状态；但它按串回放而非事件式同步，持有旧引用不重查仍会陈旧——新增重渲染功能先确认断言走重新查询。

## 3. 假绿灯反模式

- `assert.match(source, …)` 源码字符串匹配冒充行为验证是假阳性；关键链路要行为级测试（VM 全链路 + fs 写入记录）。
- Python 用例落在 `if __name__ == "__main__":` 死区时 discover 不执行=假绿灯，跑完用 `-v` 确认测试名出现。
- 模拟渠道链路不能用插件 `fetchBytes` 拉 raw.githubusercontent（白名单不含；真实链路由宿主 CLI 拉）。
- asar 资产提取用 `patch_install.read_header/iter_files`，勿手写解包（头 12–16 字节 LE JSON 长度、数据基址 16+json_len 对齐、offset 相对基址）。
- 长期红的测试等于没有测试；断言按域拆分分开报错，不让一个失配域掩盖另一域的新回归。
- 同一契约串可能被多个测试文件分别断言（先例：一条 `.zu-git-sep` 样式规则锁三处）——改共享样式/协议串前先 `grep -rn "<串名>" tests/` 全量找锁定点，别只改先撞见的那处。

## 4. 实机验证

- 第二实例配方：复制 .app 到临时目录 + ad-hoc `codesign --force --deep --sign -` + 官方开关（`ZCODE_DESKTOP_APPLICATION_NAME` / `_HOME_DIR` / `_USER_DATA_DIR` / `_SESSION_DATA_DIR`）指向独立临时目录 + 删 `Singleton*`；勿改 bundle 名/BundleID（签名陷阱）；不加开关会静默 exit 0。（根级 `renderer_live_check.cjs` 是桥加载检查脚本，其隔离手段是覆盖 HOME，与该配方不同源。）
- 热更新验证：改后部署到运行目录等热更（缺省 5s；`hot_reload:true` 2s。纪律见 [install-release.md](install-release.md)）；核对 `diag-0.json` 的 mount.anchorRect/barRect/version。diag 约每 15 次 payload 才落盘（可 `touch ~/.zcode/cli/db/db.sqlite` ×16、间隔 2s 强制刷）；空闲期数分钟不写 ≠ 热更失败；`pump.wants` 是 JSON 请求串，取 sids 须先解析。diag 的 `time` 从部署同一秒跳变才是重挂载实证；`version` 是浮层 VERSION 常量快照——忘升号会误读为「未生效」（VERSION 锁测试须同步升号），且提交代际与运行时 version 可不一致；重注入后首条落盘可能是旧实例的写入竞态，判版本等下一条；version/time 在 diag 顶层、不在 `d.mount.*` 下（结构随版本变，读错键误判）。拿不到渲染端运行时又无 CDP 时，可给 diag 加探针字段 → 部署热文件 → 等泵落盘 → 读 diag 实测，比逆向渲染 bundle 快且准。
- 悬停/hover-card 行为只能真实指针复现（合成事件驱不动 Electron hover 卡）；伪 DOM 事件只在真浏览器可见，VM/stub 测不出（见 [overlay-ui.md](overlay-ui.md)）。
- 真机桌面调试优先 CDP 模式：本机注入链已在 `inject-main.cjs` 顶层 `appendSwitch("remote-debugging-port","9229")` 强制开启（冷文件，完全重启一次后常驻；端口只绑 loopback）。`curl 127.0.0.1:9229/json/list` 列 targets，`Page.captureScreenshot` 免 TCC 屏幕录制授权截真实宿主窗口（解决 hover 卡/浮层实机取证），`Runtime.evaluate` 直接读 renderer 诊断对象与 `globalThis.ZUsageTurnStats`。连接前核实实际监听端口：与开发实例同跑时后启动方静默放弃绑定。本注入不在时（其它机器/正式包未部署本插件）回退带 `--remote-debugging-port` CLI 参数冷启动；`requestSingleInstanceLock` 会吞参数，必须先完全退出。
- 桌面宿主不可用时的 UI 验收 harness：ZCode 打包二进制会忽略 app 路径参数自启，不可当 generic Electron 拉起自选页面；用 stock electron + 隔离 userData，同页 `<script>` 注入运行目录 overlay.js（真实 CSS/状态条），main 进程从 overlay.js 同文件提取纯函数切片（TPS_BANDS、SPD_V2 等）`new Function` 装配（生产原码非复刻）。假 composer 锚点必须带 textarea/[contenteditable]；浅色主题 harness 须自补宿主语义变量（--color-tooltip/--color-popover 等）；每截图步前鼠标归中性区防残留 hover 卡；macOS TCC 录屏授权弹窗会阻真实宿主截图（CDP 截图可绕，见上条）。
- DB 排查口径：真库是 `~/.zcode/cli/db/db.sqlite`（`~/.zcode/db.sqlite` 是 0 字节勿用；3.17.x 实测迁移后库在 `<dataBaseDir>/.zcode/cli/db/db.sqlite`（该处有库才读；issue #294 起两库并存按 db.sqlite/-wal 最新 mtime 仲裁，陈旧候选回落 HOME——迁移目录有库而插件读 HOME 时先核对此语义，见 specs/db-path-stale-arbitration.md）；宿主桌面引导证据链（v3.17.1 localUsageEvidence）镜像解析默认落 HOME 库（agent 实际写位与之一致），env `ZCODE_SESSION_DB_PATH`/`ZCODE_SESSION_DB` 与 config `storage.sessionDbPath` 优先——用量链 zusage/token_rate/dbDir 三处镜像同序）；宿主请求完成才一次性 INSERT，运行中无行；`model_usage.started_at` 是毫秒；完整 session_id 形如 `session_`+长串（短 8 位不能当等值条件）；compact 请求行带 `query_source='compact'`（宿主库实测口径，仓库源码不产生该值）；桌面日志不记 compact 生命周期。"运行中全 0"先查桥绑定（diag `det.bridge bound`）再查库。
- zusage 逐行子查询的 select 列必须加 `m.` 表前缀（宿主 session 表未来同名列会 ambiguous，整会话快照静默降级为空快照）。
- 引擎/asar 排查：宿主行为以引擎主文件（macOS 桌面 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`）为最高证据，先 grep 生产函数再追消费链；grep bundle 必须 `LC_ALL=C grep -a`；超长行按关键词 offset 打上下文；引擎全文 0 命中 ≠ 字段不存在（解析器可能在别处，先例 `when_to_use`）。`plugin-commands-cli-smoke.py` 探测配方失配时修配方，不退回模拟 catalog。本机有宿主 monorepo 源码（`/Users/smzdm/Projects/AI/ZCode`，system prompt sections 在 `apps/zcode-cli/packages/core/src/context/`、builder.ts 组装）时优先 grep 源码对照再回 bundle 定位；bundle 是编译产物、无可编辑源码级文件，AGENTS.md 内容经 system-reminder 注入、不进 system 块。

## 5. 大功能合并前的对抗式审核

- 独立子代理只找真实缺陷：输出 [BLOCKER]/[MAJOR]/[MINOR] + file:line + 修复建议 + 可合并结论；修复后派**新轮次**（不复用同一代理）直到无 BLOCKER/MAJOR；多轮震荡则停下来报告。绿灯只证明"测过的东西对了"。
- 变异式审查最有效：故意把实现改坏，验证哪条测试会红；红了才说明测试真的覆盖。
- 文档中的数字（用例数、清单长度）由只读验证代理实测对账，不凭记忆写；更优做法是文档不写死会漂移的数字。
