# Mobile relay 安装升级与待替换包

## 目标和边界

SessionStart、显式插件安装和独立安装在状态条已注入或安装成功后，幂等检查 mobile relay 补丁；插件链原有 renderer bridge 行为不变，独立安装不新增 renderer 补丁流程。远程无客户端、豁免和 dry-run 不执行补丁（卸载执行对称清理，见下）。补丁失败不改变状态条安装返回码；hook 的 stdout 保持协议 JSON。

卸载需要对称清理：主卸载（`patch_install.remove()`）只剥 loader 注入行，mobile relay 的 stash/uplink 是中段注入，必须由独立安装器与插件安装器在 `pi.remove()` 成功后调用 `remove_deployed(..., _locked=True)`，否则卸载会留下永久中段注入。清理必须在目标锁内先检查共享 TMP/sidecar：存在任一待替换操作时返回 `deferred` 让位，不读写既有待替换包；失败只报告，不把主卸载改成失败。

## 保守串行与状态

仅 mobile relay 路径在目标锁内检查 pending 并尝试就地补丁。只要存在待替换包或 sidecar（包括 install、remove、损坏、孤立或 publishing/Busy 状态），返回 `deferred`，不读取、合并、重发、修复或改写已有待替换包及 journal。锁不可用同样延后。无 pending 时允许就地替换；替换失败清理本次 stage 并返回 `deferred`，不发布 pending、不启动监控。已在位时只读检查，不创建 stage、清扫文件或重写整包。

移除路径与安装共用同一把目标锁与同一份 stage 约定：只清理由本次调用创建的 `.mobile-relay-*` stage，绝不碰其他调用留下的同名文件；成功/absent 由调用方视为完成，`deferred` 或失败不是卸载失败。

插件链先按原有流程处理 renderer；若其产生 pending，mobile 延后至收尾后的下一次 SessionStart。首次注入自身 pending 时不叠补丁。mobile 返回 deferred 时必须报告尚未就绪，不暗示它已安排待替换：已有 pending 需先收尾，替换失败则需解除占用或权限问题后重试。既有公共 journal、renderer 发布及其他调用方协议不变。

## 生效提示

mobile 补丁写入 asar 后，运行中的客户端仍用旧 bundle：
- 插件链（SessionStart hook 与显式 `overlay_install.py install`）在 mobile 返回 `patched` 且 `pi.client_running()` 为真时调用 `restart_notice.record_restart(runtime, {"state": "installed", "asarPatch": True})`。标记无 hashes、无 installation，下一次真正启动由 loader 按 `createdAt` 直接 ack 销账；`asarPatch` 让 `runtime_lock.ack_restart` 在热销账候选命中时（例如合并进来的 pending-sync hashes 已全部热加载）仍强制 `cleared=False`——asar 中段补丁只能随进程完全重启生效。不得改用 `pending-install`（它要求 installation/publishedAt，在 mobile 路径上永远无法销账）。合并已有 marker 时保留其他字段。
- SessionStart 的 `_mobile_pending_notice` 仍只对 `deferred` 提示，且提示必须可执行：完全退出 ZCode（含托盘/后台）后执行独立命令 `mobile_relay_patch.py apply --asar <path>` 或重跑 `install.py --asar <path>`；在运行中的客户端里重跑 `/install-overlay` 无法完成该补丁。
- 独立安装遇到 `patched` 时明确要求完全退出并重开 ZCode 后生效；遇到 `deferred` 时不得输出「全部完成」式承诺，改为上述完全退出 + 独立命令。

独立 CLI 的 `apply` 同样须持目标锁检查所在目录的共享 TMP 与 sidecar（包含孤立、损坏和符号链接），冲突时返回 `deferred`，不改 asar 或已有文件。无冲突时不清扫其他调用留下的 stage；替换失败仅清理由本次创建的 stage。`ensure_deployed` 的既有调用及 `check`、`remove`、`rewrite` 契约不变（`remove_deployed` 新增可选 `_locked` 与 `ensure_deployed` 同语义）。

SessionStart 的兼容性提示优先于手机中继未就绪提示：兼容性提示已存在时不覆盖；刚安装成功分支也先生成兼容性提示，再决定是否显示手机提示。

## 验收

- 已注入旧代 relay 的隔离 asar 可升级，现有注入尾缀保留；已经是当前代时不复制或重写整包。
- 无 pending 时就地替换；替换受阻返回 deferred 并清理 stage，不发布 pending 或启动监控。
- install、remove、损坏、孤立和 publishing/Busy 以及锁忙均不触碰已有包或 journal；renderer 原有发布、监控及失败清理回归不变。
- 首次注入 pending 时不叠补丁；收尾后的后续 SessionStart 才继续补装，明确提示手机中继补丁尚未就绪、需先完成待替换或解除占用/权限问题，不暗示已排定替换。
- dry-run、豁免、无客户端不补丁，失败不改变安装返回码，hook stdout 不混入诊断。
- 独立 `--remove` 与插件 `remove` 在 `pi.remove()` 成功后都清掉 stash/uplink：`check_deployed` 为 `absent`，原始前缀（含安装器尾缀剥离结果）逐字节还原；存在 pending 时清理让位并保留既有包。
- 替换失败只清理本次 stage，其他调用留下的 `.mobile-relay-*` 不受影响。
- mobile `patched` 且客户端运行中时写入 `state="installed"` + `asarPatch=True` 重启标记（无 hashes/installation）；pending-sync hashes 合并后热销账候选命中也不得清除该 marker，只有下一次真正启动（`createdAt` 早于 `loadedAt`）才按正常流程销账；`deferred` 文案含「完全退出」与独立命令，mobile 未就绪时不输出「全部完成」。
- CLI apply 对 TMP、sidecar 和两者同时存在均在锁内拒绝，逐字节保留冲突文件及 asar；无冲突可正常补丁且不删除既有 stage。
- 已注入及刚安装成功两条 hook 分支在兼容性提示与手机中继未就绪同时发生时保留兼容性内容；无既有提示且 mobile 返回 `deferred` 时仍报告手机中继未就绪，`skipped-error/unknown` 属可选增强不可用，SessionStart 保持静默。
