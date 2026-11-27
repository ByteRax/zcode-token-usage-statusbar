# 测试与实机验证方法

适用路径：`tests/` 全部新增或修改、根级 `renderer_live_check.cjs`、任何"验证一下"的命令选择与实机验收操作。

测试命令、按改动范围选文件的对照表与真实 CLI 沙箱边界在根 [AGENTS.md](../../AGENTS.md) §6；本文件是方法论与替身/夹具陷阱。基础纪律：测试失败→定位根因→修复→重测，不得在红测上宣布完成；无法修复时如实报告。

## 1. 运行约定

- 仓库根运行；没有 build/lint/format。Node 回归以 VM/stub 为主，Python 回归用临时数据库、目录和夹具；`-B` 避免写 bytecode，需要时同时设 `PYTHONDONTWRITEBYTECODE=1`（不保证子进程不写）。
- Node 测试通配符依赖 shell 展开，Windows PowerShell 显式列文件；部分进程/平台测试按环境跳过，**必须报告**跳过。
- Windows 开发机（无独立 Node、无 `python3` 别名）的解释器调用：Node 一律 `ELECTRON_RUN_AS_NODE=1 "<宿主 ZCode.exe>"`（支持 `--test`/`--check`/`-e`；命令行参数 `--run-as-node` 会启动完整客户端实例，必须用环境变量；用 ZCode.exe 的副本充当 PATH 上的 `node` 时它同样只认这个变量——会清洗子进程环境的用例（如 `test_mobile_relay_patch` 的 `run_hook` 只透传 PATH / SystemRoot）拿不到它，替身会以客户端身份启动后静默退出，属替身造成的假红；`scripts/check_all.py` 与 `scripts/deploy_hot.py` 自己给 Node 子进程带上这个变量）；跑真实 Python 子进程的 Node 测试（如 `plugin-restart-boot`）须设 `ZUSAGE_TEST_PYTHON=python`（夹具缺省 `python3`，回退链同 hooks 的 `python3 → python → py -3`，缺别名环境即红）；`node --check` 对非 `.js` 后缀（含 `.tmp-*` 之类临时文件）抛 `ERR_UNKNOWN_FILE_EXTENSION`，语法预检前先落到 `.js` 后缀；node_repl 类 VM 内核会裁剪 `fetch`/`WebSocket` 全局——CDP/HTTP 探针写成独立 `.mjs` 用 Electron Node 跑。
- Windows + Git Bash 的路径与脚本传输陷阱：Python 进程把 `/tmp` 解析到 `<cwd 盘>:\tmp`（C 盘常无 `C:\tmp`，克隆到 C 盘跑测试会成批 `ENOENT` 假红——外部 PR 验证一律克隆到非 C 盘）；MSYS 会改写以 `/` 开头的参数（grep 模式 `'/tmp/…'` 静默 0 匹配，改写 `tmp/…`）与 `git <rev>:<path>` 的 ref:path 语法（加 `MSYS_NO_PATHCONV=1`）；Bash 工具的大段 heredoc 可能被截断或搅坏转义、中文经 stdin 管道按 ANSI 代码页双重编码、Python `Path.write_text` 默认把 LF 翻成 CRLF——给含中文/转义序列的文件做脚本化修改一律走「Write 工具写完整新块 → 脚本读 bytes 做单段精确替换（锚点全文唯一、断言命中 1 次）→ `write_bytes` → `ast.parse`/`node --check` + 计数对账」，不用 heredoc 内联中文字面量；`sync_plugin.py` 偶发 `WinError 1224`（杀软/索引瞬时内存映射插件副本）原样重试一次即过，非持久锁。
- Windows 上的三个测试陷阱：①**子进程输出解码**（宿主给工具子进程注入的 `PYTHONUTF8=1` 会掩盖这一条，判责要 `-u PYTHONUTF8 -u PYTHONIOENCODING` 再跑一遍）：测试侧 `subprocess.run(..., text=True)` 按本进程启动时的区域代码页解码，而产品入口（hook、`token_rate.py`、`zusage.py`、`overlay_install.py` 与 `patch_install.py` 的命令行）把 stdout 钉成 UTF-8（安装链命令行的契约见 `tests/test_cli_stdio_utf8.py`）——GBK 下读线程抛 `UnicodeDecodeError`、`stdout` 收成 `None`，输出含非 ASCII 的用例以 `TypeError`/`AttributeError` 的形态红。读这些子进程一律 `encoding="utf-8"`（严格解码，产品侧的钉子被改坏时才看得见；给子进程 env 补 `PYTHONUTF8` 救不了父进程的读线程）。②**quota 夹具的虚拟路径**：`/virtual/…` 不是跨平台绝对路径，`resolveQuotaPaths` 把 `credsPath`/`customCfgPath`/`builtinCfgPath` 过 `path.resolve`，win32 上成了 `<cwd 盘>:\virtual\…`，`readFile` 替身的字面量比较或 `endsWith('/…')` 认不出、凭据读成 null；比较前同样 `path.resolve`（POSIX 上是恒等）。显式传入的 `settingPath`/`secretsPath` 原样透传、保持字面量；省略 `secretsPath` 时它由已归一化的 `credsPath` 推导，同样要归一化。按 POSIX 形状写期望值的路径解析用例注入 `pathImpl: path.posix`，不要跟着平台走。③**Chrome 夹具的环境变量**：`overlay-pill-theme` 在 win32 不得覆写 `USERPROFILE`（夹具对 `HOME`/`USERPROFILE` 一并不覆写；单独覆写 `HOME` 不触发）：Chrome 在 Windows 上因此拒绝远程调试（已传 `--user-data-dir` 仍报 requires a non-default data directory），整个文件以「isolated Chrome did not start」失败，真实浏览器几何锁在 Windows 上零覆盖；隔离靠 `--user-data-dir` 与 `APPDATA`/`LOCALAPPDATA` 即可。
- Python 测试必须在 git 工作树/worktree 里跑（git archive 副本会让部分用例报错）；新测试必须隔离 `os.environ`（宿主设了 `ZCODE_ASAR` 会真拉起宿主）且不依赖执行者的真实身份（root 下误报）。
- 共享文件改动后先跑测试再 `sync_plugin.py`（副本同步断言在漂移时会红），`--check` 只验语法/漂移不验行为。
- 全量基线不在活跃工作树后台串行跑：后跑的一段（启动晚几十秒）会读到中途已修改的中间态出假红（先例：「根已改、副本未 sync」窗口使 test_plugin_contract 假红，issue #248）；真基线另开干净临时检出单独跑，绿/红结论只对跑瞬间的树负责；基线进行中冻结对被测树的编辑（unittest discover 启动后仍逐模块 import，撞中间态文件报假失败）。

## 2. 隔离接缝与替身陷阱

- 进程内调用 `zusage.serve()` / `zusage.main(["serve"])` 的测试模块必须在 `setUpModule` 把 `token_pricing.start_refresh` 打成空操作（`zusage._pricing` 为 `None` 时跳过——按脚本直跑时它导不到 `token_pricing`）：serve 启动即按 TTL 拉新价表，否则默认回归会真实请求 models.dev 与汇率，并写出 `pricing-cache.json`（缓存目录随 `token_pricing.configure` 的查找走：脚本目录没有 `config.json` 时落在检出目录；装了插件的开发机上标准运行目录有配置，落的是真实运行目录的缓存）。真子进程的 serve 用例则把脚本拷进带 `pricing.fetch: false` 配置的临时运行目录（`tests/test_serve_stdio.py`）。
- `ZCODE_USAGE_DB` 只隔离插件逐问脚本，不是根 `zusage.py` 的通用数据库隔离开关；根实现的新测试沿用夹具替换数据库入口，默认不执行真实查询。插件安装器测试接缝 `ZUSAGE_PLUGIN_RUNTIME` / `ZUSAGE_PLUGIN_ASAR` 可指向临时副本，不碰真机。
- Python sqlite 替身须同时支持可迭代与 `fetchone` 两种用法（列表子类化游标）。
- Python 公共测试夹具与单文件独立运行纪律：
  - 跨测试文件复用模块加载、asar 打包或快照字节缓存一律走 `tests/helpers/py_test_support.py`（提供 `load_module`、`make_asar`、`cached_plugin_runtime_bytes`、`cached_head_bytes`）。**禁止**在测试文件间写 `from test_xxx import ...` 裸同级导入（`python3 -m unittest tests/test_xxx.py` 单文件运行时 `tests/` 不在顶层 `sys.path`，会直接报 `ModuleNotFoundError`）。
  - 构造临时插件目录模拟 `RUNTIME_FILES` 时，写入 `.py` 文件的占位内容必须是合法 Python 语法（如 `# new package: ...` 注释），并在 `addCleanup` 中移除临时插入 `sys.path` 的目录并恢复 `sys.modules["patch_install"]`，防止 `overlay_install.load_patch_install()` 在单文件独立运行或跨模块时触发 `SyntaxError` 或向后续测试泄漏假模块。
  - 涉及真实 Node 验收子进程的同步测试（如 `test_plugin_upgrade.py`、`test_runtime_sync_guard.py`）优先复用 `cached_plugin_runtime_bytes` / `cached_head_bytes`，并在运行目录预置非核心未变更文件，只让核心冷热文件（`inject-main.cjs`、`overlay.js`、`plugin-updater.cjs`、`plugin-release.cjs`、`plugin-storage.cjs`）进入写入验收队列，避免单次测试重复拉起 20 次 Node 进程。
- VM 切片测试：优先使用公共提取助手 `tests/helpers/overlay-extract.cjs`——切 `overlay.js` 用 `readOverlaySource`、`readOverlayPart`、`sliceOverlay`、`getNamedSlice`（`NAMED_SLICES`），切 `inject-main.cjs` 用 `readInjectSource`、`sliceInject`、`getInjectSlice`（`INJECT_SLICES`），避免在各测试内重复手写 `indexOf`/`slice` 锚点查找；切片桩必须捕获 sandbox 对象（Node 域闭包看不到 vm 全局）；依赖源（stages 等）与预注入状态须在切片前拼接好；切片区间内不得引用区间外变量。`tests/overlay-port-patches.test.cjs` 等按源码切片计数断言的测试，改被切片源码时同步核对断言。
- VM 切片 ctx 的同名桩会掩盖真实页面错误：给 ctx 注入与源码同名变量（如 `panel`/`gear`）后用例断言的是桩调用，而真实页面里该名字越出作用域只会抛 `ReferenceError` 且被事件分发语义吞掉（`.click()` 不上抛、仅 `window.error` 可见）——测试全绿但功能静默失效。harness 只注入真实作用域存在的名字，排查「点击没反应」先从 harness 删桩，再挂 CDP `window.error` 钩子派发点击取证。配套的分片作用域契约：`01-*` 等文档级壳层代码只有 IIFE 级名字（`state`/`instances`/`enhanceTip` 等），`panel`/`gear`/`activateSettingsSec`/`syncPanel` 等是 `spawnInstance` 闭包私有；壳层要回调实例功能走入口 DOM 钩子模式（先例 `chip.__zuOpenSub`、`b.__zuOpenEnhSettings`：实例侧把闭包函数挂到入口元素、壳层沿入口元素分发；复用旧节点时每拍刷新钩子并在函数体内做 inactive 自卫），并对该路径加源码级断言锁防复发。
- 定时器卫生（防 Node 测试进程空等挂起）：生产代码与测试中的超时兜底定时器（如 `Promise.race` 的 fallback `setTimeout`、`AbortController` 的 `kill` 超时、`catalogPromise` 宽限期定时器）必须在结算后通过 `.finally(() => { if (typeof clearTimeout === "function") clearTimeout(timer); })` 立即清理（加 `typeof` 守卫以兼容仅提供 `setTimeout` 桩的极简 VM 沙箱），并对长周期兜底定时器调用 `timer.unref?.()`，防止断言结束后事件循环仍被悬空定时器挂住数秒至十余秒。
- 整链夹具的两个吞错陷阱（issue #452 review 实证）：①VM 沙箱必须暴露夹具的 `Element` 类——缺它时产品代码里 `el instanceof Element` 抛 ReferenceError，被 `track` 这类带外层 catch 的循环吞掉，迟滞计时根本不起而用例照样通过；涉及 `track` 几何段的用例收尾断言 `__zusageDiag.trackErr` 为空（`assertTrackClean`）。②断言时间边界（节流、迟滞、保持期）的用例必须先 `fakeClock` 再跑首帧——首帧之后才冻结，两者只要差 1ms 边界就翻转，冷启动或负载下会偶发红；既有「某帧之后几何结果变了」的用例在 `track` 空闲门（规格规则 19）下要在断言帧前推进假时钟满一个节奏，否则帧被门控跳过、守卫改坏了也不红。推进量不要恰好等于节奏常量（余量为 0，常量一改就悄悄回到假绿）：要么留余量，要么在同一帧断言几何段确实执行了。
- stub Element：`hasAttribute/getAttribute` 对 `data-pane-id`/`data-session-id` 的特判走 pid/sid；`querySelector` 未注册选择器返回新建空元素而非 null；`className` setter 同步 classList；夹具 `createTextNode` 产物必须可被遍历（getAttribute/children 可用）。vm 跨上下文比较用 `[...arr]`/`{...obj}` 展开。跨 realm 另有两坑：Node 域 `Map` 过不了 vm 域 `instanceof Map`（registry 夹具一律在 vm 域内构造）；vm 域抛的 `TypeError` 过不了 Node 域 `assert.throws(…, TypeError)`，改用消息正则匹配。
- mock 断言：`execFile` 参数是整串 argv，用 join 后整串判断（`Array.includes` 匹配不到 `--cached`）；mock `executeJavaScript` 返回的 JSON 字符串会被 `Array.isArray` 判死，先解析。
- `tests/overlay-bridge.test.cjs` 的 `.zu-live` 替身每次 `querySelector` 都从 `innerHTML` 回放 class/text，整条重渲染后重新查询即反映新状态；但它按串回放而非事件式同步，持有旧引用不重查仍会陈旧——新增重渲染功能先确认断言走重新查询。
- 整文件 vm 加载 `inject-main.cjs` 的夹具（`inject-git-status` / `inject-git-multi` / `inject-remote-recovery` / `inject-main-lifecycle`）：窗口 URL 与 `process.resourcesPath` 必须是同盘、带盘符的原生绝对路径——`FX = process.platform === "win32" ? path.resolve(path.sep, "fixture") : "/fixture"`，URL 用 `pathToFileURL(path.join(FX, "resources", "index.html")).href`。无盘符的 `file:///fixture/...` 在 win32 被 `fileURLToPath` 拒绝，宿主页门（`trustedSender` / `isLocalHostPage` / `pollPluginRequests`）catch 后一律判外部页：整套用例在 Windows 恒红，却对不上任何产品缺陷（2026-11-28 定性：三套件 64 例全是夹具）。mock fs 入口先把反斜杠折成正斜杠、去掉盘符再比 POSIX 夹具键；期望值用 `path.join` / `path.resolve` 构造；argv 只在分发处归一化。不要把沙箱的 `path` 换成 `path.posix`——那等于让产品跑在 POSIX 语义下，Windows 分支重新归零。
- 两个 Windows 清理与跳过的陷阱：①`fs.rmSync(dir, { recursive: true })` 会把 junction 当目录、顺着它删目标内容，清到悬空处半途放弃、每次在 `%TEMP%` 留一份残骸——清理含 junction / 目录符号链接的目录先 `fs.unlinkSync(link)` 摘链接再递归（链接变量别声明在 `try` 块内，`finally` 看不见块级 `const`，摘除会静默失败）；测试用的链接目标也要留在临时目录内。②`node:test` 的 `skip` 不要写 `cond || ""`：空串时用例体照跑，失败却计为 SKIP（假绿）；要么给非空原因，要么写 `cond && "原因"`。

## 3. 假绿灯反模式

- `assert.match(source, …)` 源码字符串匹配冒充行为验证是假阳性；关键链路要行为级测试（VM 全链路 + fs 写入记录）。
- 复合判定的负向用例要让目标守卫以外的前置条件全部成立，只改变目标条件；否则用例可能因其他条件失败而假绿。适用时用变异验证确认移除该守卫会使测试变红。
- Python 用例落在 `if __name__ == "__main__":` 死区时 discover 不执行=假绿灯，跑完用 `-v` 确认测试名出现。反过来的死区同样假绿：中段的 `__main__` 块让 discover 照常收全、按脚本直跑却只执行它之前的用例（`tests/test_test_file_layout.py` 守住「定义了 TestCase 的测试模块恰好一个 `__main__` 守卫、且是文件最后一条语句」——没有守卫时按脚本跑是退出码 0 的空跑，同样假绿）。
- 模拟渠道链路不能用插件 `fetchBytes` 拉 raw.githubusercontent（白名单不含；真实链路由宿主 CLI 拉）。
- asar 资产提取用 `patch_install.read_header/iter_files`，勿手写解包（头 12–16 字节 LE JSON 长度、数据基址 16+json_len 对齐、offset 相对基址）。
- 长期红的测试等于没有测试；断言按域拆分分开报错，不让一个失配域掩盖另一域的新回归。
- 同一契约串可能被多个测试文件分别断言（先例：一条 `.zu-git-sep` 样式规则锁三处）——改共享样式/协议串前先 `grep -rn "<串名>" tests/` 全量找锁定点，别只改先撞见的那处。spawn 参数同理：argv 形状锁散在多个测试文件（如 `inject-git-multi` 的期望数组），改 spawn argv 必须全仓 grep 期望数组随批同步，漏一处即确定性新红。
- 依赖本机环境的测试（`skipUnless(真机存在)`、读已安装客户端）不算守卫：同一不变量必须有不依赖本机状态的隔离等价测试，变异验证也要在「真机不可用」条件下再跑一遍。先例：桥遗留代际识别曾只被「本机 asar 里恰好部署着旧桥」的真机测试守着，本机桥一升级（SessionStart 自动打桥）它就不再覆盖，去掉 V1/V2 识别、误改遗留模板正文的变异全部通过（`BridgeGenerationTests` 补上）。报告「skipped=N」时说出是哪几个、跳过原因，以及它们让哪个平台/路径零覆盖。
- 环境性既有失败与回归定责：本机存在一批与代码改动无关的既有失败（真实 Chrome 无头夹具族、Electron fs shim 对伪 asar 路径的 `ENOTDIR` 族、POSIX 专属断言族等；具体名单随版本演进，不在此维护）——先跑 HEAD 干净基线（`git worktree add --detach` 双树同跑，失败集合逐一相同即非本次改动引入）再定责，交付如实披露为既有环境失败。外部 PR 基于旧 main 时，PR 分支上会红一堆 main 已修的测试——判责以「fork/main 干净基线 + 模拟合并树（fork/main merge 该 PR 后的树；GitHub mergeable=CLEAN 时即合并后 main 的精确预览）」两侧为准，PR 分支单独跑出的红不算它的问题。连真实 CDP/实机前提的测试存在抖动（单跑红、全量绿），复跑定责勿一次定红。浏览器夹具的 `getComputedStyle` 序列化值同样随版本漂移（曾实证新版 Chrome 把 `flex-start` 序列化为 `flow-start`，overlay 源码并无该值——overlay-pill-theme 族红先排除序列化漂移再定责）。

## 4. 实机验证

- 第二实例配方：复制 .app 到临时目录 + ad-hoc `codesign --force --deep --sign -` + 官方开关（`ZCODE_DESKTOP_APPLICATION_NAME` / `_HOME_DIR` / `_USER_DATA_DIR` / `_SESSION_DATA_DIR`）指向独立临时目录 + 删 `Singleton*`；勿改 bundle 名/BundleID（签名陷阱）；不加开关会静默 exit 0。（根级 `renderer_live_check.cjs` 是桥加载检查脚本，其隔离手段是覆盖 HOME，与该配方不同源。）
- 热更新验证：改后部署到运行目录等热更（缺省 5s；`hot_reload:true` 2s。纪律见 [install-release.md](install-release.md)）；核对 `diag-0.json` 的 mount.anchorRect/barRect/version。diag 约每 15 次 payload 才落盘（可 `touch ~/.zcode/cli/db/db.sqlite` ×16、间隔 2s 强制刷）；空闲期数分钟不写 ≠ 热更失败；`pump.wants` 是 JSON 请求串，取 sids 须先解析。diag 的 `time` 从部署同一秒跳变才是重挂载实证；`version` 是浮层 VERSION 常量快照——忘升号会误读为「未生效」（VERSION 锁测试须同步升号：`overlay-notes`/`overlay-substat`/`overlay-subagent-row` 三处以精确正则锁 `var VERSION = "vNNN";`，每升一代必红 3 例，属维护锁非回归），且提交代际与运行时 version 可不一致；重注入后首条落盘可能是旧实例的写入竞态，判版本等下一条；diag 是滚动分片，判读遍历全部 `diag-*.json` 找 mtime 最新、gen 递增者——固定盯 diag-0 可能撞上失活窗口槽位，某分片长期不更新也可能是该面板实例已冻结（先怀疑实例冻结而非部署失败）；gen 计数在宿主重启后重新起算，跨重启比较无意义，version 翻转为新 VERSION 才是重注入硬证据；version/time 在 diag 顶层、不在 `d.mount.*` 下（结构随版本变，读错键误判）。拿不到渲染端运行时又无 CDP 时，可给 diag 加探针字段 → 部署热文件 → 等泵落盘 → 读 diag 实测，比逆向渲染 bundle 快且准。
- 悬停/hover-card 行为只能真实指针复现（合成事件驱不动 Electron hover 卡）；伪 DOM 事件只在真浏览器可见，VM/stub 测不出（见 [overlay-ui.md](overlay-ui.md)）。
- 真机桌面调试优先 CDP 模式：本机注入链已在 `inject-main.cjs` 顶层 `appendSwitch("remote-debugging-port","9229")` 强制开启（冷文件，完全重启一次后常驻；端口只绑 loopback）。`curl 127.0.0.1:9229/json/list` 列 targets，`Page.captureScreenshot` 免 TCC 屏幕录制授权截真实宿主窗口（解决 hover 卡/浮层实机取证），`Runtime.evaluate` 直接读 renderer 诊断对象与 `globalThis.ZUsageTurnStats`。连接前核实实际监听端口：与开发实例同跑时后启动方静默放弃绑定。活体验收以 DOM 实测为 ground truth：`__zusageConversationDiagnostics()` 返回的是会话库诊断（`{keys,sessions}`）不是 FATAL 容器，diag `FATAL.*` 键缺席≠无帧（有写入门控与刷写节流），chip/状态条是否出数以 DOM 文本为准；主进程模块行为可免 UI 验证——页面里 spy 包装 `window.__zusagePluginResult`（保存原函数→记录→透传）并向 `window.__zusagePluginRequests` 直推 `{action, requestId, …}`，按 requestId 轮询截获回执（回执按回显匹配，requestId 任意串均可）；`__zusageDiag.coordErr` 是 spawn 链异常的现成观测点；注入脚本行号用 CDP `Debugger.enable`+`getScriptSource`（inline script 取 len 最大者）拉源码对回，按 V8 偏移用函数定义行倒推会自相矛盾。本注入不在时（其它机器/正式包未部署本插件）回退带 `--remote-debugging-port` CLI 参数冷启动；`requestSingleInstanceLock` 会吞参数，必须先完全退出。
- 桌面宿主不可用时的 UI 验收 harness：ZCode 打包二进制会忽略 app 路径参数自启，不可当 generic Electron 拉起自选页面；用 stock electron + 隔离 userData，同页 `<script>` 注入运行目录 overlay.js（真实 CSS/状态条），main 进程从 overlay.js 同文件提取纯函数切片（TPS_BANDS、SPD_V2 等）`new Function` 装配（生产原码非复刻）。假 composer 锚点必须带 textarea/[contenteditable]；浅色主题 harness 须自补宿主语义变量（--color-tooltip/--color-popover 等）；每截图步前鼠标归中性区防残留 hover 卡；macOS TCC 录屏授权弹窗会阻真实宿主截图（CDP 截图可绕，见上条）。纯视觉/字体/布局验证优先用 ZCode 内置浏览器（与宿主同 Chromium 渲染管线、即开即用；独立 Chrome 无头夹具曾在 Windows 上因覆写 `USERPROFILE` 被 Chrome 拒开调试口而整文件恒红，夹具已修，见 §1 的三个陷阱）：本地 `python -m http.server` 起探针页 → 内置浏览器打开 → `canvas measureText`/`getComputedStyle` 量化 + 截图目测，验证完关标签停 server；像素级观感用截屏按列聚簇量墨迹/空隙、同图原生行定目标，不靠度量公式估算（hinting/AA 使实测偏离字体度量）。
- DB 排查口径：真库是 `~/.zcode/cli/db/db.sqlite`（`~/.zcode/db.sqlite` 是 0 字节勿用；3.17.x 实测迁移后库在 `<dataBaseDir>/.zcode/cli/db/db.sqlite`（该处有库才读；issue #294 起两库并存按 db.sqlite/-wal 最新 mtime 仲裁，陈旧候选回落 HOME——迁移目录有库而插件读 HOME 时先核对此语义，见 specs/db-path-stale-arbitration.md）；宿主桌面引导证据链（v3.17.1 localUsageEvidence）镜像解析默认落 HOME 库（agent 实际写位与之一致），env `ZCODE_SESSION_DB_PATH`/`ZCODE_SESSION_DB` 与 config `storage.sessionDbPath` 优先——用量链 zusage/token_rate/dbDir 三处镜像同序）；宿主请求完成才一次性 INSERT，运行中无行；`model_usage.started_at` 是毫秒；完整 session_id 形如 `session_`+长串（短 8 位不能当等值条件）；compact 请求行带 `query_source='compact'`（宿主库实测口径，仓库源码不产生该值）；桌面日志不记 compact 生命周期。"运行中全 0"先查桥绑定（diag `det.bridge bound`）再查库。
- zusage 逐行子查询的 select 列必须加 `m.` 表前缀（宿主 session 表未来同名列会 ambiguous，整会话快照静默降级为空快照）。
- 引擎/asar 排查：宿主行为以引擎主文件（macOS 桌面 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`）为最高证据，先 grep 生产函数再追消费链；grep bundle 必须 `LC_ALL=C grep -a`；超长行按关键词 offset 打上下文；引擎全文 0 命中 ≠ 字段不存在（解析器可能在别处，先例 `when_to_use`）。`plugin-commands-cli-smoke.py` 探测配方失配时修配方，不退回模拟 catalog。本机有宿主 monorepo 源码（`/Users/smzdm/Projects/AI/ZCode`，system prompt sections 在 `apps/zcode-cli/packages/core/src/context/`、builder.ts 组装）时优先 grep 源码对照再回 bundle 定位；bundle 是编译产物、无可编辑源码级文件，AGENTS.md 内容经 system-reminder 注入、不进 system 块。

## 5. 大功能合并前的对抗式审核

- 独立子代理只找真实缺陷：输出 [BLOCKER]/[MAJOR]/[MINOR] + file:line + 修复建议 + 可合并结论；修复后派**新轮次**（不复用同一代理）直到无 BLOCKER/MAJOR；多轮震荡则停下来报告。绿灯只证明"测过的东西对了"。
- 变异式审查最有效：故意把实现改坏，验证哪条测试会红；红了才说明测试真的覆盖。会修改被测文件的多个审查任务须串行或使用各自独立副本，不能共享工作树并发，否则可能读到彼此的瞬时变异态；纯只读审查不受此限。
- 克隆只含**已提交**内容：变异验证前先提交新用例，并在克隆里先跑一次**未变异**基线、确认新用例名/计数出现且绿，否则跑的是旧测试，会得出「变异未被杀死」的假结论（2026-11-03、2026-11-12 两次复发）。变异脚本显式指定每个子进程的 cwd 并断言它是克隆目录，不靠 shell 链。
- 全量基线不与编辑并行：基线要么在编辑前跑完，要么另开 `git worktree add --detach` 的干净检出跑（`git stash` 栈是跨 worktree 共享的，并行会话在场时别用 push/pop 造「干净基线」）。
- 文档中的数字（用例数、清单长度）由只读验证代理实测对账，不凭记忆写；更优做法是文档不写死会漂移的数字。

## 6. 交付前防返工六道门禁（由近一月 Bug / 回滚 / 重复修改沉淀）

每次提交或发起 PR Review 前，必须逐条核对以下六类高频复发根因（自动化门禁见 `tests/test_plugin_package.py` 的 `AntiReworkContractTests`）：

1. **多端共源语义矩阵门禁（防「同逻辑改 A 漏 B」）**：
   - 本地数据库路径解析（`zusage.py`、`token_rate.py`、`inject-main.cjs` 三端，含 `dataBaseDir` 新鲜度仲裁与 `hosts.zcode.db_path` 显式覆盖）改动任一处，必须同步三端并运行 `tests/test_db_path_resolution.py`、`tests/test_token_rate_db_override.py` 与 `tests/inject-db-dir.test.cjs` 的三方交叉一致性矩阵。
   - 宿主凭据与供应商配置读取（`src/quota/` 与 `src/puller/` 共用 `resolveHostQuotaPaths`、个人规则与内置 `zcode-builtin.json` `templateRules` 合并、`builtin:*` 归一化）改动任一处，必须核对两侧是否同步受影响。
   - 速率与窗口聚合（`usage_stats.py`）禁止在 `zusage.py` 或 `token_rate.py` 私自复制公式分支。
2. **宿主与平台机制先证伪门禁（防「想当然假设导致整特性回滚」）**：
   - 触及客户端更新/打包链（如 Squirrel `MacUpdater` 固定 `Content-Length` 代理流）、Chromium 后台/遮挡窗口调度（被遮挡窗口 `requestAnimationFrame` 会无限期暂停，浮层交互/Tab 切换严禁依赖 `rAF` 合并）、或状态栏自适应宽度测量（离屏克隆探针必须剥除 `data-zu-folded` 并将 `sysmon` `auto` 面固定为最宽 `full` 态，防测量值与档位切换构成正反馈震荡环）时，先在宿主 bundle 或实机验证物理机制，不凭假设上线。
3. **Windows 沙箱与子进程铁律门禁（防跨平台死锁与弹窗闪烁）**：
   - 运行与安装链 Python 模块严禁直接调用标准库 `tempfile.mkstemp` / `tempfile.mkdtemp` / `NamedTemporaryFile` / `TemporaryDirectory`（Windows 受保护目录上 `os.access` 看不见 ACL 会重试 `2^31-1` 次导致永久挂起，一律走 `runtime_lock.bounded_mkstemp` / `bounded_tempdir`，由 `AntiReworkContractTests` 静态 AST 守护）。
   - 运行期拉起子进程在 Windows 下必须带 `CREATE_NO_WINDOW`（`_win_no_window()`），防止每轮闪烁控制台黑框。
   - 文件 `mtime` 比较测试与热重载用例不得假设亚毫秒级时钟精度（Windows 文件系统时钟粒度约 15.6ms，测试中构造先后时间戳须显式偏移 `>= 0.05s` 或直接 `os.utime`）。
4. **浮层 DOM 生命周期与豁免对称门禁（防「开新弹窗关掉设置面板」与热更残留）**：
   - 新增挂 `document.body` 的顶层浮层或模态框，必须**四处同步登记**：① CSS 加 `-webkit-app-region: no-drag`；② `src/overlay/00-boot-state-i18n.js` 启动自清选择器；③ `src/overlay/10-instance-subpanel-and-composer.js` 的 `isOwnOverlay()` 与 `OWN_LAYER_SEL`（`modalOpen()` 豁免）；④ `src/overlay/12-instance-mount-and-boot.js` 的 `dispose()`（由 `AntiReworkContractTests` 自动校验对称性）。
   - 悬停卡/浮层内的可点击控件必须在 `pointerdown` 响应（配合 `mousedown` `stopPropagation` + `preventDefault`），禁止仅绑 `click` 被宿主失焦或 100ms 流式重绘吞掉点击。
5. **热路径复杂度与定时器卫生门禁（防流式卡顿与 `node:test` 挂起）**：
   - 100ms `updateLive`、`turn-stats.js ingest` 与每帧 `track` 内严禁调 `bridge.handle.store.getState()`（一律读已缓存的 `handleSnapshot`）或做全表/全历史重算。
   - 所有 `Promise.race` / `AbortController` 的超时兜底 `setTimeout` 必须在 `.finally()` 中 `clearTimeout` 并调用 `timer.unref?.()`。
6. **分片正本与工作树净空门禁（防构建产物回退与 VERSION 台账撞车）**：
   - 严禁直接手改根级生成产物 `overlay.js`、`quota-client.cjs`、`model-puller.cjs`（正本分别在 `src/overlay/`、`src/quota/`、`src/puller/`）；运行 `python3 sync_plugin.py` 前必须确认当前工作树无其它并行会话的半成品修改，同步后跑 `ReleaseLedgerTests` 与 `sync_plugin.py --check`。

