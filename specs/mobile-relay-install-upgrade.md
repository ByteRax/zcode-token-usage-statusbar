# Mobile relay 安装升级与待替换包

## 目标和边界

SessionStart、显式插件安装和独立安装在状态条已注入或安装成功后，幂等检查 mobile relay 补丁；插件链原有 renderer bridge 行为不变，独立安装不新增 renderer 补丁流程。远程无客户端、豁免和 dry-run 不执行补丁（卸载执行对称清理，见下）。补丁失败不改变状态条安装返回码；hook 的 stdout 保持协议 JSON。

卸载需要对称清理：主卸载（`patch_install.remove()`）只剥 loader 注入行，mobile relay 的 stash/uplink 是中段注入，必须由独立安装器与插件安装器在 `pi.remove()` 成功后调用 `remove_deployed(..., _locked=True)`，否则卸载会留下永久中段注入。清理必须在目标锁内先检查共享 TMP/sidecar：存在任一待替换操作时返回 `deferred` 让位，不读写既有待替换包；失败只报告，不把主卸载改成失败。

## 保守串行与状态

仅 mobile relay 路径在目标锁内检查 pending 并尝试就地补丁。只要存在待替换包或 sidecar（包括 install、remove、损坏、孤立或 publishing/Busy 状态），返回 `deferred`，不读取、合并、重发、修复或改写已有待替换包及 journal。锁不可用同样延后。无 pending 时允许就地替换；`os.replace` 被拒（Windows 客户端运行中持有 asar、杀毒扫描、受保护目录）时不再要求手动重跑：把已构建的 stage 经 `patch_install.publish_external_pending` 转存为待替换包（renderer 桥 v359 同款链；publish 自持目标锁，必须在 `pi._target_lock()` 之外调用，锁内调用会死锁），插件链先按 `entry_bytes_of(stage)` 预取入口指纹、转存成功后记录 `pending-install` 重启标记（指纹取不到宁缺勿假；独立链无 `restart_notice.py` 分发，不写标记，终端输出即用户提示），并 `launch_monitor` 拉起收尾监控，返回 `pending`——用户完全退出 ZCode 后自动收尾生效。publish 在锁内拒绝覆盖 remove 意图（PendingTmpError）；转存失败一律由 publish 负责清理 stage，调用方返回 `skipped-error`（publish 的 finally 在锁体内，锁获取超时等锁外前置失败的窗口由调用方兜底清理 stage）。已在位时只读检查，不创建 stage、清扫文件或重写整包。独立 `mobile_relay_patch.py apply` 是手动兜底通道，契约不变：replace-failed 只清理本次 stage 并返回 `deferred`，不发布 pending。

移除路径与安装共用同一把目标锁与同一份 stage 约定：只清理由本次调用创建的 `.mobile-relay-*` stage，绝不碰其他调用留下的同名文件；成功/absent 由调用方视为完成，`deferred` 或失败不是卸载失败。

插件链先按原有流程处理 renderer；若其产生 pending，mobile 延后至收尾后的下一次 SessionStart。首次注入自身 pending 时不叠补丁。转存出的 mobile pending 与主安装/桥 pending 生命周期一致：swap 时 `_replace_pending` 按该标记经 `publish_install` 记 `publishedAt`，下一次真正启动由 loader ack 销账。既有公共 journal、renderer 发布及其他调用方协议不变。

## 生效提示

mobile 补丁写入 asar 后，运行中的客户端仍用旧 bundle：
- 插件链（SessionStart hook 与显式 `overlay_install.py install`）在 mobile 返回 `patched` 且 `pi.client_running()` 为真时调用 `restart_notice.record_restart(runtime, {"state": "installed", "asarPatch": True})`。标记无 hashes、无 installation，下一次真正启动由 loader 按 `createdAt` 直接 ack 销账；`asarPatch` 让 `runtime_lock.ack_restart` 在热销账候选命中时（例如合并进来的 pending-sync hashes 已全部热加载）仍强制 `cleared=False`——asar 中段补丁只能随进程完全重启生效。就地写入路径不得改用 `pending-install`（它要求 installation/publishedAt，没有 swap 就永远无法销账）。合并已有 marker 时保留其他字段。
- 转存路径（返回 `pending`）在 publish 成功后记录 `pending-install` 标记（带 `installation.asar/entryHash`，与主安装同语义；仅插件链——独立链无 `restart_notice.py` 分发不写标记）：swap 时 `_replace_pending` 记 `publishedAt`，下次启动正常销账。两态标记不得混用：`installed+asarPatch` 只用于就地写入，`pending-install` 只用于转存。
- SessionStart 的 `_mobile_pending_notice` 按状态分流，提示必须可执行：`pending` 提示已排定、完全退出 ZCode 后自动完成替换，无需重试安装；`deferred` 且 detail 为 `existing pending operation` 或 `bridge pending` 时提示等待已有待替换操作收尾后自动补装，不给手动命令；其余 `deferred`（锁超时等）才提示完全退出（含托盘/后台）后执行独立命令 `mobile_relay_patch.py apply --asar <path>` 或重跑安装——在运行中的客户端里重跑 `/install-overlay` 无法完成该补丁。`skipped-error/unknown` 保持静默（显式 CLI 的失败自行打印）。多补丁链分轮收尾口径：渲染桥与手机中继补丁都改 asar、各自排 pending——一次完全退出只清当轮积压，重启后 SessionStart 再排的新一轮要再完全退出一次才收尾；用户报「已完全退出仍提示补丁未就绪」先按分轮收尾解释并引导再退一次，不误判为收尾失败或安装损坏。
- 独立安装与插件 CLI：`patched` 打印「已写入」确认（客户端运行中要求完全退出并重开后生效，未运行提示下次打开生效）；`pending` 打印已排定自动完成；`deferred` 按 detail 同上分流（独立 CLI 的 waiting 分支无 SessionStart hook，提示重跑安装补装而非「之后的会话自动补装」）；`pending`/`deferred`/`skipped-error` 分支不得输出「全部完成」式承诺。

独立 CLI 的 `apply` 同样须持目标锁检查所在目录的共享 TMP 与 sidecar（包含孤立、损坏和符号链接），冲突时返回 `deferred`，不改 asar 或已有文件。无冲突时不清扫其他调用留下的 stage；替换失败仅清理由本次创建的 stage。`ensure_deployed` 的既有调用及 `check`、`remove`、`rewrite` 契约不变（`remove_deployed` 新增可选 `_locked` 与 `ensure_deployed` 同语义）。

SessionStart 的兼容性提示优先于手机中继未就绪提示：兼容性提示已存在时不覆盖；刚安装成功分支也先生成兼容性提示，再决定是否显示手机提示。

## 验收

- 已注入旧代 relay 的隔离 asar 可升级，现有注入尾缀保留；已经是当前代时不复制或重写整包。
- 无 pending 时就地替换；`os.replace` 被拒时 stage 经 publish 转存为待替换包（`pending`，TMP+META 在位、operation=install、目标 asar 字节不变、无 `.mobile-relay-*` 残留），写入带 stage 入口指纹的 `pending-install` 标记并拉起监控；finalize 后补丁落位。转存失败（含 remove 冲突）返回 `skipped-error`，stage 由 publish 清理，不落地半发布状态。
- install、remove、损坏、孤立和 publishing/Busy 以及锁忙均不触碰已有包或 journal；renderer 原有发布、监控及失败清理回归不变。
- 首次注入 pending 时不叠补丁；bridge pending 时 mobile 延后至收尾后的下一次 SessionStart，提示等待自动收尾补装、不出现手动命令文案。
- 提示分流：`pending`=已排定自动完成（无需重试）；`existing pending operation`/`bridge pending`=等待自动补装（无手动命令）；其余 `deferred`=完全退出+独立命令；`patched` CLI 打印已写入确认（运行中=要求完全重启）；`skipped-error/unknown` SessionStart 静默。
- dry-run、豁免、无客户端不补丁，失败不改变安装返回码，hook stdout 不混入诊断。
- 独立 `--remove` 与插件 `remove` 在 `pi.remove()` 成功后都清掉 stash/uplink：`check_deployed` 为 `absent`，原始前缀（含安装器尾缀剥离结果）逐字节还原；存在 pending 时清理让位并保留既有包。
- mobile `patched` 且客户端运行中时写入 `state="installed"` + `asarPatch=True` 重启标记（无 hashes/installation）；pending-sync hashes 合并后热销账候选命中也不得清除该 marker，只有下一次真正启动（`createdAt` 早于 `loadedAt`）才按正常流程销账；两态标记不混用；mobile 未就绪（其余 deferred/skipped-error）时不输出「全部完成」。
- 独立 `apply` 对 TMP、sidecar 和两者同时存在均在锁内拒绝，逐字节保留冲突文件及 asar；无冲突可正常补丁且不删除既有 stage；其 replace-failed 仅清理本次 stage 返回 `deferred`。
- 已注入及刚安装成功两条 hook 分支在兼容性提示与手机中继提示同时发生时保留兼容性内容。
