# 宿主引擎事实与逆向排查规则

适用路径：排查宿主（ZCode 桌面/CLI）行为、写引擎补丁（`engine-patch.cjs`）、做渲染桥版本登记、对照宿主与插件的口径差异。

排查方法与 grep 配方在根 [AGENTS.md](../../AGENTS.md) §6 与 [tests.md](tests.md) §4「引擎/asar 排查」；本文件记录宿主引擎自身的长期事实与口径对照，版本号清单等易变事实不写。

## 1. 宿主代码形态与取证

- 桌面引擎是编译产物：macOS 桌面为 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`，混淆符号随版本轮换，无可编辑源码级文件；改宿主行为只能走 bundle 补丁（SHA 白名单优先 + `use strict` 后 prologue 注入，数值类改动可热生效；sha 未登记但桌面 build 前缀匹配登记条目时按锚点串全文件唯一命中兜底注入——结构验证替代指纹预检，混淆符号轮换即拒绝，契约见 install-release/engine-patch 侧）。引擎是否更新过以 `glm/.pre-acthreshold-*` 官方备份哈希对账为准，不按文件 mtime 判断（打补丁写盘会刷新 mtime）。
- 本机有宿主 monorepo 源码 `/Users/smzdm/Projects/AI/ZCode`（`apps/zcode-cli`）：system prompt sections 在 `packages/core/src/context/`（builder.ts 组装，契约文档 `docs/design/v2/loop/system-prompt-contract.md`）。审计 system prompt 或 grep bundle 找不到定义时，先查 monorepo 源码再回 bundle 定位。AGENTS.md 内容经 system-reminder 注入、**不进** system 块。

## 2. 宿主机制事实

- 侧栏 footer 营销横幅是宿主完整链路：10min 轮询 `/api/v1/marketing/touch` → 可信源 URL+SHA256 登记 → 安全下载解包 → 127.0.0.1 随机端口 loopback server → sandbox iframe（`zcode-cloud-hero-v1` 通道、5s ready 超时降级）。排查「侧栏横幅异常 / 莫名本机监听端口」按此链对账，不是异常进程；未来要在侧栏挂远程内容可复用该可信源模式。
- 宿主自更新：macOS 走 Squirrel.Mac 整包 move（sha512 在下载完成时与缓存复用轮由 `getValidCachedUpdateFile` 的 `hashFile` 对账各验一次，**安装拉流阶段不复验字节**），无 fuses、无 asar 哈希校验；Windows NSIS 验安装包签名。**改写 pending zip 结构性不可行（issue #298 定案）**：宿主 `autoInstallOnAppQuit=false`，下载完成时 MacUpdater 本地代理即把官方 Content-Length 固化（manifest size 或下载完成时 stat），Squirrel 在用户点「重启以更新」时经代理按该长度拉流——改写后的 zip 大小必然偏离（实测 3.18.0 +11.6MB），拉包截断即静默失败（仅 `~/.zcode/v2/logs/` 一行 warn + relaunch），restage 缓存命中反复复现；「安装阶段无字节复验」不等于「字节可改」。ShipIt 是目录级整包 rename，`/Applications/ZCode.app` 包内多余文件（锁/备份/改写的 zcode.cjs）不阻碍更新。
- 引擎 prologue 是**拼接的多段 hook**：阈值 hook（`PROLOGUE_BASE`，历史装机字节不可改）+ 抓包 hook（`CAPTURE_PROLOGUE`）。再加一段时沿用同款：`PROLOGUE = BASE + 新段`，旧代际 V1/V2 从 BASE 推导、不含新段；迁移判定里「旧串不残留」对「旧串是新串前缀」的段恒假，要改用前缀标记计数。往模板字符串里写 hook 代码时，代码里的换行转义必须写成 `\\n`（写 `\n` 会被模板提前解成真换行，生成非法 JS）——注入引擎的 prologue 坏一个字符，新会话进程全部起不来；改完先 `new vm.Script(PROLOGUE)` 再谈部署。
- 宿主**模型请求不一定走全局 `fetch`**（4.0.0 引擎包 `fetchHttpResponse`）：没配代理、没配自定义证书时走全局 `fetch(url, {body: Buffer, headers: Headers})`；配了代理或自定义证书时走 `node:http`/`node:https` 的 `request(...)` 再 `req.end(Buffer)`。要在网络层挂钩子必须两处都包，且请求体按 Buffer 处理——11-27 初版抓包 hook 只包 `fetch` 且只认字符串请求体，真机一条没记到，vm 沙箱用例全绿也没发现。给宿主行为写钩子/测试前，先从引擎包里读出真实调用形态（`LC_ALL=C grep -ao "函数名.\{0,N\}"`），测试夹具照抄这个写法，再加一条真实 Node 运行时向本地服务器发请求的用例。发请求的引擎是随客户端启动的常驻 Node 服务进程（`--utility-sub-type=node.mojom.NodeService`，不按会话新起）：改了引擎 prologue 之后，正在跑的客户端要**完全重启**才装上新 hook。
- 自动压缩阈值=窗口−min(maxOut,21K)−13K（200K→约 83%、1M→约 96.6%，非定值），无设置 UI/env/flag；详见 [用户指南](../../docs/user-guide.md)。
- 宿主「预装工具」（帮助面板管理，随宿主更新自动装齐）落 `~/.zcode/preinstalled-tools/production/`：`bin/*.exe` 全是同一通用 shim 壳按同名 `.shim` JSON（target/args/env）转发，env 硬化（`PYTHONNOUSERSITE=1`、`PIP_CONSTRAINT` 钉锁版本）；该目录不进注册表 PATH，由宿主给其拉起的会话进程注入，且不提供 `python.exe`/`python3.exe` 别名——不遮蔽系统 Python，本插件 hooks 的 `python3 → python → py -3` 探测链照常命中用户解释器，互不干扰。排查「Python 探测命中了谁」按此对账。插件自己的 MCP 入口 `zcode-python` 取自这里（ZCode 3.19.0 起；macOS 上是 sh 包装，`exec` 到 `tools/python/versions/<版本>/overlay/bin/python`），契约见 [install-release.md](install-release.md) §4。

## 3. 口径对照（用户报「插件与宿主显示不一致」先对表再查链）

- 宿主自身 tok/s 是**单请求完成态**读数：`output×1000÷(duration−first_content)`，无估算态、无轮内聚合；`first_content` 含工具产出增量且不落库。本项目轮速率=Σ有效输出÷Σ有效生成窗口（剔除工具等待、含思考 provider 特例、完成态为会话均）——两口径不同不是 bug。
- 宿主恢复历史轮 `outputTokens=0` 但 startedAt/endedAt 齐全；老会话里可见的历史统计行是模型时代贴在正文里的文本，不是宿主数据（展示规则见 [overlay-ui.md](overlay-ui.md)）。

## 4. 版本元数据与 issue 排查

- 用户 issue 不可复现时先做**版本考古**：从截图读版本号与文案/控件特征定位其运行版本，对照该版本行为，不用当前版本脑补；DevTools 里 `radio.click` 是恢复主题最稳的方式。
- 官网 changelog 页静态渲染仅最近约 8 条、无分页；逐版本元数据可查 `https://cdn-zcode.z.ai/zcode/electron/releases/<版本>/windows-x64/latest.yml`（含 releaseNotes 双语与发布时间）。
