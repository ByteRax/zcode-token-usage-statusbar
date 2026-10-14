# 本会话全部改动审查

## 结论

当前实现不建议直接发布。确认 **2 项 P1、10 项 P2、2 项 P3**，均保持未修复；本次仅执行只读审查、隔离复现并编写本报告，没有修改生产代码、现有测试、用户配置、官方缓存或真实 app.asar。

最高优先级是：SessionStart 绕过 Release 待恢复验收，以及语法检查失败的 TMP 仍可被 finalize 激活。这两项不是测试失败推测，而是使用当前真实模块和临时夹具复现。

## 范围与基线

- 基线：当前 `HEAD`（`bbfa0af`）与当前工作区差异，加本会话新增的未跟踪插件、更新器、发布工具、测试和项目技能。插件体系尚未提交，不能只看 `git diff`。
- 审查包含：默认自动更新、插件安装/客户端升级恢复、OS 锁、持久重启、TMP 安全收尾、Release 检测/下载/解包、发布工具与渠道清单、项目级技能迁移、主进程请求桥接、速率行/tooltip、manifest/分发/文档。
- `overlay.js` 与 `zusage.py` 的速率和 tooltip 改动包括并行会话写入的当前版本，作为当前交付整体审查，不归责为本次单独修改。
- `.idea/` 在会话开始前已经存在，不将其当作本会话引入问题。未审无关 web 模块和历史已提交 v63–v66 设计。
- 原计划并行审查的更新器、发布和安装子代理因服务过载重试后仍失败，已由主审实际阅读相应模块并执行复现；Release 下载/解包子审完成。没有将代理失败或历史绿结果当作审查完成证据。

## P1：发布前应修复

### R1 — SessionStart 可绕过 Release 安装结果/恢复验收

**位置：** `plugins/zcode-token-usage-statusbar/overlay_install.py:335–344`；对照 `plugin-updater.cjs:346–380`。

Node 更新器要求安装记录的版本、仓库/ref、URL、SHA256 与持久 `pendingRelease` 一致，否则不调用同步。但 SessionStart 首先无条件 `sync_runtime(runtime)`，既不读取 pendingRelease，也不等待 pendingPid 或验证当前缓存来源，然后才启动后台更新器。因此官方安装结果被 Node 拒绝后，新建/恢复会话仍可复制那个缓存中的代码，甚至覆盖阻止它同步的 updater。

**隔离结果：** 写入预期 `1.4.0` 的 pendingRelease，当前插件夹具版本为 `1.5.0`，执行真实 `run_hook()`：

```json
{"pendingReleaseExpectedVersion":"1.4.0","hookSynchronizedVersion":"1.5.0","wrongUpdaterCopied":true,"pendingSyncStillTrue":true}
```

**建议：** 在所有运行时同步入口共享恢复协调与来源验收；SessionStart 不应在待安装/验收失败时先复制缓存。验证范围必须包含 hook 与 Node 协作，不仅测试 Node 的 `sync` stub。

### R2 — 语法检查失败的 TMP 仍被收尾激活

**位置：** `patch_install.py:424–435, 438–477, 535–538`；卸载同类路径 `:598–601`。

`prepare_tmp` 在语法检查前发布 operation=install/remove 的可信 sidecar。后续语法自检失败只返回 False，不撤销 sidecar；`finalize_tmp` 重新检查的仅是结构/注入行，不再执行语法检查或确认“已通过验证”。用户按 `check` 提示运行 `--finalize`，或旧监控进程消费这份 TMP 时，可以激活明确未通过语法校验的包。

**隔离结果：** 临时 asar 的 TMP 包含注入行和 `const broken = ;`；语法检查判 False，真实 `finalize_tmp` 仍成功：

```json
{"syntaxCheckAccepted":false,"invalidTmpFinalized":true,"actualEntryContainsSyntaxError":true}
```

**建议：** 未通过所有校验的包不得标为可激活；失败时撤销操作意图，或在 finalize 中验证完整的校验状态/重新语法检查。增加“校验失败后手工及后台收尾”的回归。

## P2：正常使用或后续升级会触发

### R3 — 自己生成的孤立/半截 TMP 永久阻断重试

**位置：** `patch_install.py:405–435`。

repack 写 TMP 后，来源变化会在写 sidecar 之前抛错；首次生成还可能中途写失败。下次安装看到 TMP 已存在但 sidecar 缺失/指纹不匹配，按未知文件拒绝，无法恢复。安全拒绝未知历史 TMP 是正确的，但不能把本次自己生成且未发布的包也变成永久障碍。

**隔离结果：** repack 完成时模拟官方升级，第一次和升级结束后的第二次 `install()` 都 False，TMP=True、sidecar=False。另一个已有 sidecar 的半截 repack 场景，第二次 prepare 抛 `pending TMP no longer belongs to its sidecar`。

**建议：** 每次生成使用独有暂存文件，校验成功后才发布 TMP/sidecar；失败只清理本次拥有的临时产物。不要删除未证明归属的未知包。

### R4 — 部分同步失败后跨版本更新误判为本地热修

**位置：** `plugins/zcode-token-usage-statusbar/overlay_install.py:241–258, 273–279`。

文件先提交，hash 基线最后一次性提交。若中间记录失败，同版重试可通过“文件恰好等于源码”恢复；但下一次已经是更高版本时，这个由同步器写入的文件既不等于新源码，也不等于旧基线，于是被永久当作用户热修保留。

**隔离结果：** 1.0 基线 → 写入 1.1 overlay 后模拟 record 失败 → 直接同步 1.2：

```json
{"recordVersion":"1.2.0","preserved":["overlay.js"],"runtimeContent":"release1.1 overlay","userEverEditedFile":false}
```

**建议：** 持久保存待写目标 hashes/文件提交状态，恢复时区分同步器自己的部分提交与真实手改。当前测试只覆盖同一个包重试，未覆盖跨中间版本恢复。

### R5 — 配置读改写未共享锁，可能重新开启用户已关闭的自动更新

**位置：** `inject-main.cjs:415–425`、`plugins/zcode-token-usage-statusbar/overlay_install.py:296–310`、`plugin-updater.cjs:393–400`。

各路径虽然原子 rename，但读改写之间没有共用锁。独立 SessionStart/后台进程与主进程同时补配置/切换设置时，旧快照会覆盖其它键的新值。原子写保证 JSON 完整，不保证多键合并不丢失。

**隔离结果：** hook 读到 auto=true 后，模拟 UI 写入 auto=false，再让 hook 补 asar_path；最终 auto 又为 true。主进程速率开关的同样交错也可重现。

**建议：** 为运行时 config.json 的全部写入口使用同一读改写锁，锁内重读并仅更新本次键。测试应跨进程覆盖关闭自动更新与补安装配置的交错。

### R6 — GitHub 仓库大小写兼容性误拒绝

**位置：** `plugin-release.cjs:74–89, 112–118`。

GitHub owner/repo 身份不区分大小写，注册的 `byterax/...` 被允许，但 API 资产 URL/manifest 使用 `ByteRax/...` 时严格字符串比较拒绝。

**隔离结果：** 同一份合法 API 响应，规范名字选择 1.4.0，全部小写来源抛“GitHub Release 资产来源或大小无效”。

**建议：** 从可信 API 确定规范仓库身份，或只对 owner/repo 按大小写不敏感比较，贯穿 manifest/catalog/inventory。不要放宽 URL 主机、tag 或文件路径校验。

### R7 — 固定完整白名单无法自举文件集变化的新版本

**位置：** `plugin-release.cjs:138–140`；`release_unpack.py:28–45, 239–261`。

升级前用旧 runtime helper 验新版 ZIP，安装后才同步新版 helper。将新 helper 放入包里不能解决旧 helper 先拒绝的问题。任何合法运行文件增删都被旧完整白名单拒绝；“先发桥接版”也不能让错过桥接的用户自动恢复，因为检测总选最高正式版本。

**隔离结果：** 合法 1.4.1 包保持原 28 文件成功；新增 future-helper.py 并同步更新包内白名单被拒，删除 token_rate.py 并同步更新包内白名单也被拒，均未安装。

**建议：** 明确兼容引导合同/受约束的版本化布局，或实现候选选择与强制桥接机制。不能执行尚未验证的包内 helper。当前文档“同时升级校验器”没有实现可执行迁移路径。

### R8 — MCP 字面 argv 的路径验证在空白处截断

**位置：** `release_unpack.py:172–182`。

`${ZCODE_PLUGIN_ROOT}/usage_mcp.py nonexistent-suffix.py` 在 structured args 中是一个完整参数，但资源检查只验证空白前的 usage_mcp.py。因此非法文件路径仍能通过发布 verify/unpack。

**隔离结果：** 完整合法包仅改该 MCP 参数，unpack=True，但实际 Python 以完整 argv 启动 exit=2，文件不存在。

**建议：** 对 args 数组使用完整字面参数验证，对 command 字符串使用符合真实协议的单独解析。不要将 shell token 规则应用于字面 argv。

### R9 — 英文速率 tooltip 显示 6 处 undefined

**位置：** `overlay.js:132–149`。

row 接口为 `(label, zhText, enText)`；首字/输出/生成/段峰/累计/采样行只传两个参数，第二个已经是 L 的结果。中文选择第二个参数正常，英文选择缺失的第三个。

**隔离结果：** 在 VM 中执行当前 tooltip 构建代码，English 生成 6 个 undefined，例如 `<b>TTFT</b><span>undefined`。

**建议：** 统一 row 接口并增加中英两种语言的实际生成断言；仅查存在英文字符串不足以发现此错误。

### R10 — overlay 热更新后已有统计行 tooltip 失效

**位置：** `overlay.js:170–190`，配合 `:30–40, 153–154`。

热更新清理旧 tooltip，却不清理消息节点的 zusageRateTip 标记和旧事件绑定。新扫描因标记而跳过，旧处理器又因 stale() 返回。只有随后新生成的节点可用。

**隔离结果：** 第一代绑定后切第二代：旧统计节点 dataset=1，悬停不填充新 tooltip；新节点悬停正常。

**建议：** 使用代际标记并替换监听器，或稳定的 document 级委托；清理旧 scroll/interval/节点 handler。增加真实代际切换测试。

### R11 — 多窗口提问状态映射仍有丢失更新

**位置：** `plugins/zcode-token-usage-statusbar/token_rate.py:54–80`。

prompts 每会话映射解决顺序交替，但多个 hook 进程仍在无锁读改写同一个文件。两个窗口同时提问时，最后写入覆盖另一个新会话，守卫退回全局时间，可能吞掉较早窗口的数据。

**隔离结果：** 两 hook 交错读取旧状态，B 写入后 A 提交旧快照；最终 prompts 仅有 A，B 丢失。现有测试按顺序调用两个 hook，不覆盖并发。

**建议：** 共享状态锁，或直接每会话独立状态文件；保留原子写但不要将其视作事务锁。

### R12 — --current 用完成时间判定，会误收上一轮延迟完成请求

**位置：** `plugins/zcode-token-usage-statusbar/token_rate.py:198–205, 245–252`。

旧轮请求在新提问前启动、提问后完成时，完成时间大于 promptTs，就被当作当前数据；当前 turn 一行也没有仍会输出旧轮统计。该条件可出现在前轮仍有在途请求、取消/队列切换期间，并非普通顺序完成轮次。

**隔离结果：** 数据库只有 old_turn，startedAt 在新 prompt 前、completedAt 在之后；`query_turn(..., current=True)` 返回 old_turn 且有 turn 数据。

**建议：** 用 hook/宿主的当前 turn 身份或请求开始时间边界确认本轮，并在状态缺失时明确降级。当前测试只覆盖旧轮已在提问前完成的情况。

## P3：边界与用户提示

### R13 — 重定向链总超时没有取消当前下载子请求

**位置：** `plugin-release.cjs:44–48, 69–72`。

父请求转发至 release-assets 后，父总时限只销毁旧 request；调用方已失败，子请求仍继续到自己的时限。子请求仍有 60 秒/大小限制，不是无界资源消耗。

**隔离事件/计时器结果：** 父超时触发后调用方拒绝，子 request destroyed=false，子 timer 仍存在。

**建议：** 整个链共享 deadline 和当前活动请求，失败统一取消。补父超时发生在重定向后的测试。

### R14 — 预写重启意图被提示成安装已成功

**位置：** `plugins/zcode-token-usage-statusbar/overlay_install.py:268–274`；`plugins/zcode-token-usage-statusbar/restart_notice.py:28–34`。

预写 marker 是避免漏提示的正确做法，但 marker 也会在文件写入失败时保留。reminder_context 不辨意图/成功状态，固定称“已成功完成注入”。

**隔离结果：** 首个运行时文件替换失败，marker=True、loaderExists=False，下一提醒仍声称安装成功。

**建议：** 文案区分待同步/安装失败与已生效待重启；marker 记录状态，不将存在等同成功。

## 验证结果与未覆盖边界

重新运行当前实际工作区，而非引用旧计数：

- `node --test tests/*.test.cjs`：**151/151 通过**。
- `python3 -B -m unittest discover -s tests -p 'test_*.py'`：**222/222 通过**。重复 ZIP 条目测试会生成预期 warning，不是失败。
- `python3 -B tests/plugin-cli-smoke.py`：ok=True，临时目录已清理；macOS 沙箱拒绝真实 HOME/仓库/asar、网络和外部写入。
- `node --check`：loader、overlay、updater、Release、storage 均通过。
- 根及插件 19 个 Python 源文件：Python 3.8 AST 语法通过；不是在真实 Python 3.8 上执行全部流程。
- `sync_plugin.py --check`：副本一致。`git diff --check`：通过。
- 两 plugin manifest 内容相同、市场版本一致为 1.4.0。
- 发布工具 NAMES 与安全 helper ALLOWED 完全一致，28 文件；双次源码包构建字节一致，无项目技能或发布工具。
- 正式 publish 默认预演被脏工作区安全阻止；未执行真实 tag、push 或 Release。
- 项目技能格式有效，位于 `.zcode/skills/zcode-github-release/`；全局目录/包和插件发布技能不存在；仅该技能在 Git 忽略规则中放行。

通过的测试不覆盖本报告的问题。尤其：Node 错误提交测试用 sync stub，并未证明 SessionStart 不会复制同一缓存；TMP 测试没有“语法失败再 finalize”及孤立 TMP 重试；runtime 测试只覆盖同包部分恢复；速率测试是顺序 hooks；tooltip 没有实际双语生成/代际重绑测试。

仍未做的产品验收：真实公网 Release 下载与官方 URL ZIP 安装、Windows 真机收尾、新项目技能的客户端 discovery 实际刷新、完整 GUI 更新过程中关闭操作。当前 host 真实安装仍属此前 1.2.3，不能以源码 1.4.0 或隔离 CLI 升级代替真实部署。

## 需求到证据清单

| 本会话需求/改动 | 实际审查证据 | 结论 |
|---|---|---|
| 自动更新默认开、显式 false 保持 | config/readConfig、auto bootstrap、Node/Python 回归、配置交错复现 | 单入口行为通过，R5 可覆盖关闭选择 |
| 设置面板检测/手动更新/检查期间关闭 | loader poll 固定动作、window URL 检查、updater 状态、相关回归 | 核心通过，完整 GUI 中途关闭未实测 |
| 客户端升级自动重注入与重启提醒 | run_hook/patch/monitor/marker 实际代码、微型 asar 复现、CLI smoke | R2/R3/R14；Windows 真机未验 |
| OS 锁、基线、失败恢复 | runtime_lock、sync_runtime、永久 inode/父退出回归、跨版本复现 | 锁和同包恢复通过，R4/R5/R11 未覆盖 |
| GitHub 指定仓库 Release 检测下载 | readChannel/checkRelease/manifest/source/URL、真实 ZIP 夹具 | R1/R6/R7/R8/R13；不切 fork 的单一路径已验证 |
| 真实安装后与退出恢复身份校验 | verifyReleaseCommit、pendingRelease/PID、Node 72 项、hook 复现 | Node 守卫通过，但 hook 绕过 R1 |
| 发布工具与渠道流程 | build/verify/preflight/draft/upload/download/edit、tool 30 项 | 未发现额外已确认发布安全门缺陷；公网/渠道 push 未执行 |
| 当前项目专用 skill | 文件/格式/路径/Git忽略/全局删除/插件白名单真实检查 | 符合项目限定；客户端重新发现未实测 |
| 速率行与 tooltip 并行改动 | token_rate/loader/overlay 当前 diff、VM/DB/状态交错复现 | R9–R12；思考时长估算口径需保持文案一致 |
| 版本、源码同步、许可证、文档 | 两 manifests/market 1.4.0、NAMES、LICENSE、sync check、当前报告 | 静态一致；测试绿不等于无缺陷 |

## 推荐处理顺序

先修 R1/R2，再处理 R3/R4/R5 与 Release 的 R6/R7/R8；随后补 tooltip 和本问状态的 R9–R12，最后处理 R13/R14。每项应先补对应失败回归，再修改并重跑全量；本次未执行任何修复。
