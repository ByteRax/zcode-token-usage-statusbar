# Mobile relay 安装升级与待替换包

## 目标和边界

SessionStart、显式插件安装和独立安装在状态条已注入或安装成功后，幂等检查 mobile relay 补丁；插件链原有 renderer bridge 行为不变，独立安装不新增 renderer 补丁流程。远程无客户端、豁免和 dry-run 不执行补丁（卸载执行对称清理，见下）。补丁失败不改变状态条安装返回码；hook 的 stdout 保持协议 JSON。

卸载需要对称清理：主卸载（`patch_install.remove()`）只剥 loader 注入行，mobile relay 的 stash/uplink 是中段注入，必须由独立安装器与插件安装器在 `pi.remove()` 成功后调用 `remove_deployed(..., _locked=True)`，否则卸载会留下永久中段注入。清理必须在目标锁内先检查共享 TMP/sidecar：存在任一待替换操作时返回 `deferred` 让位，不读写既有待替换包；失败只报告，不把主卸载改成失败。

## 保守串行与状态

仅 mobile relay 路径在目标锁内检查 pending 并尝试就地补丁。只要存在待替换包或 sidecar（包括 install、remove、损坏、孤立或 publishing/Busy 状态），返回 `deferred`，不读取、合并、重发、修复或改写已有待替换包及 journal；唯一例外是进程被杀留下的无包空壳 journal（`cancelled`+`publishing` 且 TMP 不在），超龄后先回收再判定。锁不可用同样延后。无 pending 时允许就地替换；`os.replace` 被拒（Windows 客户端运行中持有 asar、杀毒扫描、受保护目录）时不再要求手动重跑：把已构建的 stage 经 `patch_install.publish_external_pending` 转存为待替换包（renderer 桥 v359 同款链；publish 自持目标锁，必须在 `pi._target_lock()` 之外调用，锁内调用会死锁），插件链先按 `entry_bytes_of(stage)` 预取入口指纹、转存成功后记录 `pending-install` 重启标记（指纹取不到宁缺勿假；独立链无 `restart_notice.py` 分发，不写标记，终端输出即用户提示），并 `launch_monitor` 拉起收尾监控，返回 `pending`——用户完全退出 ZCode 后自动收尾生效。publish 在锁内拒绝覆盖 remove 意图（PendingTmpError）；转存失败一律由 publish 负责清理 stage，调用方返回 `skipped-error`（publish 的 finally 在锁体内，锁获取超时等锁外前置失败的窗口由调用方兜底清理 stage）。已在位时只读检查，不创建 stage、清扫文件或重写整包。独立 `mobile_relay_patch.py apply` 是手动兜底通道，契约不变：replace-failed 只清理本次 stage 并返回 `deferred`，不发布 pending。

移除路径与安装共用同一把目标锁与同一份 stage 约定：只清理由本次调用创建的 `.mobile-relay-*` stage，绝不碰其他调用留下的同名文件；成功/absent 由调用方视为完成，`deferred` 或失败不是卸载失败。

**锁窗口纪律（锁外构建 + 短锁提交）**：`ensure_deployed` 的读档、变换与 stage 写盘全程在目标锁外完成（读 asar 不需要锁），目标锁只包「既有 pending 复查 + 发布前指纹重验 + `os.replace`」的亚秒级提交。构建期间目标被并发改写（另一进程收尾 pending、宿主重写 asar）时按提交前指纹不符整体重试一次，二次仍变按 `skipped-error` 报告。hook 链不再外层长持锁调 `_locked=True`：`_ensure_mobile_patch_safely` 只保留锁外快查（存在 pending 直接让位，省一次无谓构建），正确性由 ensure 短锁内的 pending 复查与 publish 端硬保证兜底。锁获取超时（`TimeoutError`，ensure 内部已转 `deferred` 返回）在 **hook 链**退避重试一次（首轮已耗时超 15s 不再重试，防顶破 SessionStart 60s 预算），仍超时才上报；独立 `install.py` 链为单次尝试。构建/取指纹阶段撞上并发发布窗口（`PendingTmpError`）与指纹重验同语义重试一轮。动机：多窗口并发 SessionStart 抢同一把锁、锁内重写 200MB+ asar 长达十几秒，实测（2026-11-21）每轮排定全部空转、提示退化为命令行指引。renderer 桥补装（`renderer_bridge.ensure_deployed`）同款锁窗口模式；present/skipped-unknown 的只读短路在锁外即返回，受保护目录的 `permission` 标记语义不变。独立 `apply` CLI 的「不消费既有 pending」保证同样下沉到短锁内复查。

插件链先按原有流程处理 renderer；若其产生 pending，mobile 延后至收尾后的下一次 SessionStart。首次注入自身 pending 时不叠补丁。转存出的 mobile pending 与主安装/桥 pending 生命周期一致：swap 时 `_replace_pending` 按该标记经 `publish_install` 记 `publishedAt`，下一次真正启动由 loader ack 销账。既有公共 journal、renderer 发布及其他调用方协议不变。

**deferred 提示文案与限频**：「尚未就绪」分支面向普通用户给免终端路径——在 ZCode 输入框运行 `/install-overlay` 重试排定，提示「已排定」后点状态条 ⚙ 的「重启 ZCode」按钮（quit-only + monitor 收尾后自动拉起，见 [relaunch-after-pending-asar.md](relaunch-after-pending-asar.md)）；命令行指引从会话提示中移除，仅保留在显式 `/install-overlay` 的 CLI 输出（高级段）与用户指南。同一 deferred 状态 24 小时内只提示一次（运行目录 `.mobile-deferred-notice.json` 记 `lastShownAt`，读写失败静默照发提示）。`pending`「已排定」与 bridge pending 等待文案不限频。

**推送开关门控会话提示**：`mobile_relay.enabled` 未开启（缺省；口径与主桥 `mobileEnabled()` 一致——仅 `mobile_relay` 对象内显式布尔 `true` 算开启，缺文件、损坏、非布尔或非对象均按未开启）时，三类手机补丁会话提示（已排定 / 等待自动补装 / 尚未就绪）在 SessionStart 一律静默：推送未开启的用户用不到该增强，不应因待替换包未收尾而每个会话被红字打扰；待重启需求仍由 ⚙ 齿轮红点（`pending-install` / `installed+asarPatch` 标记）承载。静默分支不读写 `.mobile-deferred-notice.json`，之后开启开关时提示不受此前静默影响。门控只作用于 SessionStart 会话文字：补丁安装、升级、让位与重启标记逻辑不变，显式 `/install-overlay` 与独立安装 CLI 的输出不变。

## 生效提示

mobile 补丁写入 asar 后，运行中的客户端仍用旧 bundle：
- 插件链（SessionStart hook 与显式 `overlay_install.py install`）在 mobile 返回 `patched` 且 `pi.client_running()` 为真时调用 `restart_notice.record_restart(runtime, {"state": "installed", "asarPatch": True})`。标记无 hashes、无 installation，下一次真正启动由 loader 按 `createdAt` 直接 ack 销账；`asarPatch` 让 `runtime_lock.ack_restart` 在热销账候选命中时（例如合并进来的 pending-sync hashes 已全部热加载）仍强制 `cleared=False`——asar 中段补丁只能随进程完全重启生效。就地写入路径不得改用 `pending-install`（它要求 installation/publishedAt，没有 swap 就永远无法销账）。合并已有 marker 时保留其他字段。
- 转存路径（返回 `pending`）在 publish 成功后记录 `pending-install` 标记（带 `installation.asar/entryHash`，与主安装同语义；仅插件链——独立链无 `restart_notice.py` 分发不写标记）：swap 时 `_replace_pending` 记 `publishedAt`，下次启动正常销账。两态标记不得混用：`installed+asarPatch` 只用于就地写入，`pending-install` 只用于转存。
- SessionStart 的 `_mobile_pending_notice` 先过推送开关门控（未开启一律静默，见上文），再按状态分流，提示必须可执行：`pending` 提示已排定、完全退出 ZCode 后自动完成替换，无需重试安装；`deferred` 且 detail 为 `existing pending operation` 或 `bridge pending` 时提示等待已有待替换操作收尾后自动补装，不给手动命令；其余 `deferred`（锁超时等）提示免终端重试路径（输入 `/install-overlay` 重试 → ⚙「重启 ZCode」，24h 限频）；独立命令 `mobile_relay_patch.py apply --asar <path>` 只出现在 CLI 输出（高级选项，需先完全退出后执行），不进会话提示。`skipped-error/unknown` 保持静默（显式 CLI 的失败自行打印）。多补丁链分轮收尾口径：渲染桥与手机中继补丁都改 asar、各自排 pending——一次完全退出只清当轮积压，重启后 SessionStart 再排的新一轮要再完全退出一次才收尾；用户报「已完全退出仍提示补丁未就绪」先按分轮收尾解释并引导再退一次，不误判为收尾失败或安装损坏。
- 独立安装与插件 CLI：`patched` 打印「已写入」确认（客户端运行中要求完全退出并重开后生效，未运行提示下次打开生效）；`pending` 打印已排定自动完成；`deferred` 按 detail 同上分流（独立 CLI 的 waiting 分支无 SessionStart hook，提示重跑安装补装而非「之后的会话自动补装」）；`pending`/`deferred`/`skipped-error` 分支不得输出「全部完成」式承诺。

独立 CLI 的 `apply` 同样须持目标锁检查所在目录的共享 TMP 与 sidecar（包含孤立、损坏和符号链接），冲突时返回 `deferred`，不改 asar 或已有文件。无冲突时不清扫其他调用留下的 stage；替换失败仅清理由本次创建的 stage。`ensure_deployed` 的既有调用及 `check`、`remove`、`rewrite` 契约不变（`remove_deployed` 新增可选 `_locked` 与 `ensure_deployed` 同语义）。

SessionStart 的兼容性提示优先于手机中继未就绪提示：兼容性提示已存在时不覆盖；刚安装成功分支也先生成兼容性提示，再决定是否显示手机提示。

## 验收

- 已注入旧代 relay 的隔离 asar 可升级，现有注入尾缀保留；已经是当前代时不复制或重写整包。
- 无 pending 时就地替换；`os.replace` 被拒时 stage 经 publish 转存为待替换包（`pending`，TMP+META 在位、operation=install、目标 asar 字节不变、无 `.mobile-relay-*` 残留），写入带 stage 入口指纹的 `pending-install` 标记并拉起监控；finalize 后补丁落位。转存失败（含 remove 冲突）返回 `skipped-error`，stage 由 publish 清理，不落地半发布状态。publish 在 journal 落定后以普通异常失败（rename 被拒、终版写入失败）时由 `patch_install._publish_pending` 自行回滚到发布前——不留 sidecar 或半发布包，本链据此在占用解除后的下一次 SessionStart 重新排定，而不是被残留 journal 永久判成「已有待替换操作」。`KeyboardInterrupt` 等硬中断同样回滚；只有进程被杀（SIGKILL）留下的无包空壳 journal 会残留，超龄（`STALE_STAGE_SECONDS`）后由 `patch_install.reclaim_stale_journal` 回收，本链判定 `deferred` 之前先做这一步。rename 后已有旧 pending 的现场保留 journal，交下一次发布认领重发。
- install、remove、损坏、孤立和 publishing/Busy 以及锁忙均不触碰已有包或 journal；renderer 原有发布、监控及失败清理回归不变。
- 首次注入 pending 时不叠补丁；bridge pending 时 mobile 延后至收尾后的下一次 SessionStart，推送开关开启时提示等待自动收尾补装、不出现手动命令文案（未开启时静默，见下方门控条）。
- 推送开关开启时的提示分流：`pending`=已排定自动完成（无需重试）；`existing pending operation`/`bridge pending`=等待自动补装（无手动命令）；其余 `deferred`=免终端重试路径（`/install-overlay` → ⚙「重启 ZCode」，24h 限频；独立命令只出现在 CLI 输出）；`patched` CLI 打印已写入确认（运行中=要求完全重启）；`skipped-error/unknown` SessionStart 静默。
- 推送开关门控：`mobile_relay.enabled` 未开启（缺文件、缺键、`false`、非布尔、非对象、损坏 JSON）时 `pending`、`existing pending operation`、`bridge pending` 与其余 `deferred` 均不写 `systemMessage`/`hookSpecificOutput`，也不落 `.mobile-deferred-notice.json`；显式 `true` 时分流提示照旧。配置解析口径同主桥 `readCfg()`（`fs.readFileSync … utf8` + `JSON.parse`）：别处的非法 UTF-8 字节按替换字符解码、配置仍有效；`NaN`/`Infinity` 字面量或 UTF-8 BOM 使 `JSON.parse` 抛出、整份配置按损坏处理（视为未开启）；顶层 `__proto__` 键的原型链怪癖不对齐。其余已知差异不改（清单不承诺穷尽，都只影响会话提示、不改补丁安装、让位与标记）。解析差异：Python 侧 `json.loads` 受解释器的整数位数上限与递归深度上限保护，超长整数或超深嵌套会抛错、判未开启，主桥 `JSON.parse` 接受、判开启，阈值随解释器版本与设置变化（本机 3.8 / 3.12 / 3.13 默认整数上限均为 4300 位）——只在手工写入异常配置时出现，方向是门控多静默。缓存差异：主桥按文件 mtime 缓存配置、到下次读取才生效，门控每次直读，两者可能短暂不一致（内容变了而 mtime 未变时主桥会一直沿用旧值），只影响会话提示与推送是否同步。真实 hook 链（客户端锁 asar → 桥补装转存 pending → 手机补丁按 `bridge pending` 让位）在未开启时已注入与刚安装成功两条分支都整条静默，开启后提示等待自动补装；已注入分支的 asar 待替换与 ⚙ 红点标记不受门控影响；刚安装成功分支在未开启时同样照常补手机补丁（就地写入且客户端运行中仍写 `installed`+`asarPatch` 标记），只是不发会话文字。
- dry-run、豁免、无客户端不补丁，失败不改变安装返回码，hook stdout 不混入诊断。
- 独立 `--remove` 与插件 `remove` 在 `pi.remove()` 成功后都清掉 stash/uplink：`check_deployed` 为 `absent`，原始前缀（含安装器尾缀剥离结果）逐字节还原；存在 pending 时清理让位并保留既有包。
- mobile `patched` 且客户端运行中时写入 `state="installed"` + `asarPatch=True` 重启标记（无 hashes/installation）；pending-sync hashes 合并后热销账候选命中也不得清除该 marker，只有下一次真正启动（`createdAt` 早于 `loadedAt`）才按正常流程销账；两态标记不混用；mobile 未就绪（其余 deferred/skipped-error）时不输出「全部完成」。
- 独立 `apply` 对 TMP、sidecar 和两者同时存在均在锁内拒绝，逐字节保留冲突文件及 asar；无冲突可正常补丁且不删除既有 stage；其 replace-failed 仅清理本次 stage 返回 `deferred`。
- 已注入及刚安装成功两条 hook 分支在兼容性提示与手机中继提示同时发生时保留兼容性内容。
