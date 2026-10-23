# 测试与实机验证方法

适用路径：`tests/` 全部新增或修改、根级 `renderer_live_check.cjs`、任何"验证一下"的命令选择与实机验收操作。

测试命令、按改动范围选文件的对照表与真实 CLI 沙箱边界在根 [AGENTS.md](../../AGENTS.md) §6；本文件是方法论与替身/夹具陷阱。基础纪律：测试失败→定位根因→修复→重测，不得在红测上宣布完成；无法修复时如实报告。

## 1. 运行约定

- 仓库根运行；没有 build/lint/format。Node 回归以 VM/stub 为主，Python 回归用临时数据库、目录和夹具；`-B` 避免写 bytecode，需要时同时设 `PYTHONDONTWRITEBYTECODE=1`（不保证子进程不写）。
- Node 测试通配符依赖 shell 展开，Windows PowerShell 显式列文件；部分进程/平台测试按环境跳过，**必须报告**跳过。
- Python 测试必须在 git 工作树/worktree 里跑（git archive 副本会让部分用例报错）；新测试必须隔离 `os.environ`（宿主设了 `ZCODE_ASAR` 会真拉起宿主）且不依赖执行者的真实身份（root 下误报）。
- 共享文件改动后先跑测试再 `sync_plugin.py`（副本同步断言在漂移时会红），`--check` 只验语法/漂移不验行为。

## 2. 隔离接缝与替身陷阱

- `ZCODE_USAGE_DB` 只隔离插件逐问脚本，不是根 `zusage.py` 的通用数据库隔离开关；根实现的新测试沿用夹具替换数据库入口，默认不执行真实查询。插件安装器测试接缝 `ZUSAGE_PLUGIN_RUNTIME` / `ZUSAGE_PLUGIN_ASAR` 可指向临时副本，不碰真机。
- Python sqlite 替身须同时支持可迭代与 `fetchone` 两种用法（列表子类化游标）。
- VM 切片测试：切片桩必须捕获 sandbox 对象（Node 域闭包看不到 vm 全局）；依赖源（stages 等）与预注入状态须在切片前拼接好；切片区间内不得引用区间外变量。`tests/overlay-port-patches.test.cjs` 等按源码切片计数断言的测试，改被切片源码时同步核对断言。
- stub Element：`hasAttribute/getAttribute` 对 `data-pane-id`/`data-session-id` 的特判走 pid/sid；`querySelector` 未注册选择器返回新建空元素而非 null；`className` setter 同步 classList；夹具 `createTextNode` 产物必须可被遍历（getAttribute/children 可用）。vm 跨上下文比较用 `[...arr]`/`{...obj}` 展开。
- mock 断言：`execFile` 参数是整串 argv，用 join 后整串判断（`Array.includes` 匹配不到 `--cached`）；mock `executeJavaScript` 返回的 JSON 字符串会被 `Array.isArray` 判死，先解析。
- `tests/overlay-bridge.test.cjs` 的 `.zu-live` 替身只被"原地改字"路径更新，整条重渲染（innerHTML 重写）后不同步——新增重渲染功能先检查该替身是否覆盖。

## 3. 假绿灯反模式

- `assert.match(source, …)` 源码字符串匹配冒充行为验证是假阳性；关键链路要行为级测试（VM 全链路 + fs 写入记录）。
- Python 用例落在 `if __name__ == "__main__":` 死区时 discover 不执行=假绿灯，跑完用 `-v` 确认测试名出现。
- 模拟渠道链路不能用插件 `fetchBytes` 拉 raw.githubusercontent（白名单不含；真实链路由宿主 CLI 拉）。
- asar 资产提取用 `patch_install.read_header/iter_files`，勿手写解包（头 12–16 字节 LE JSON 长度、数据基址 16+json_len 对齐、offset 相对基址）。
- 长期红的测试等于没有测试；断言按域拆分分开报错，不让一个失配域掩盖另一域的新回归。

## 4. 实机验证

- 第二实例配方：复制 .app 到临时目录 + ad-hoc `codesign --force --deep --sign -` + 官方开关（`ZCODE_DESKTOP_APPLICATION_NAME` / `_HOME_DIR` / `_USER_DATA_DIR` / `_SESSION_DATA_DIR`）指向独立临时目录 + 删 `Singleton*`；勿改 bundle 名/BundleID（签名陷阱）；不加开关会静默 exit 0。（根级 `renderer_live_check.cjs` 是桥加载检查脚本，其隔离手段是覆盖 HOME，与该配方不同源。）
- 热更新验证：改后部署到运行目录等 2s 热更（纪律见 [install-release.md](install-release.md)）；核对 `diag-0.json` 的 mount.anchorRect/barRect/version。diag 约每 15 次 payload 才落盘（可 `touch ~/.zcode/cli/db/db.sqlite` ×16、间隔 2s 强制刷）；空闲期数分钟不写 ≠ 热更失败；`pump.wants` 是 JSON 请求串，取 sids 须先解析。
- 悬停/hover-card 行为只能真实指针复现（合成事件驱不动 Electron hover 卡）；伪 DOM 事件只在真浏览器可见，VM/stub 测不出（见 [overlay-ui.md](overlay-ui.md)）。
- DB 排查口径：真库是 `~/.zcode/cli/db/db.sqlite`（`~/.zcode/db.sqlite` 是 0 字节勿用）；宿主请求完成才一次性 INSERT，运行中无行；`model_usage.started_at` 是毫秒；完整 session_id 形如 `session_`+长串（短 8 位不能当等值条件）；compact 请求行带 `query_source='compact'`（宿主库实测口径，仓库源码不产生该值）；桌面日志不记 compact 生命周期。"运行中全 0"先查桥绑定（diag `det.bridge bound`）再查库。
- zusage 逐行子查询的 select 列必须加 `m.` 表前缀（宿主 session 表未来同名列会 ambiguous，整会话快照静默降级为空快照）。
- 引擎/asar 排查：宿主行为以引擎主文件（macOS 桌面 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`）为最高证据，先 grep 生产函数再追消费链；grep bundle 必须 `LC_ALL=C grep -a`；超长行按关键词 offset 打上下文；引擎全文 0 命中 ≠ 字段不存在（解析器可能在别处，先例 `when_to_use`）。`plugin-commands-cli-smoke.py` 探测配方失配时修配方，不退回模拟 catalog。

## 5. 大功能合并前的对抗式审核

- 独立子代理只找真实缺陷：输出 [BLOCKER]/[MAJOR]/[MINOR] + file:line + 修复建议 + 可合并结论；修复后派**新轮次**（不复用同一代理）直到无 BLOCKER/MAJOR；多轮震荡则停下来报告。绿灯只证明"测过的东西对了"。
- 变异式审查最有效：故意把实现改坏，验证哪条测试会红；红了才说明测试真的覆盖。
- 文档中的数字（用例数、清单长度）由只读验证代理实测对账，不凭记忆写；更优做法是文档不写死会漂移的数字。
