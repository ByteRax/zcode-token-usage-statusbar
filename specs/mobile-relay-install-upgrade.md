# Mobile relay 安装升级与待替换包

## 目标和边界

SessionStart、显式插件安装和独立安装在状态条已注入或安装成功后，幂等检查 mobile relay 补丁；插件链原有 renderer bridge 行为不变，独立安装不新增 renderer 补丁流程。远程无客户端、豁免、卸载和 dry-run 不执行补丁。补丁失败不改变状态条安装返回码；hook 的 stdout 保持协议 JSON。

## 保守串行与状态

仅 mobile relay 路径在目标锁内检查 pending 并尝试就地补丁。只要存在待替换包或 sidecar（包括 install、remove、损坏、孤立或 publishing/Busy 状态），返回 `deferred`，不读取、合并、重发、修复或改写已有待替换包及 journal。锁不可用同样延后。无 pending 时允许就地替换；替换失败清理本次 stage 并返回 `deferred`，不发布 pending、不启动监控。已在位时只读检查，不创建 stage、清扫文件或重写整包。

插件链先按原有流程处理 renderer；若其产生 pending，mobile 延后至收尾后的下一次 SessionStart。首次注入自身 pending 时不叠补丁。mobile 返回 deferred 时必须报告尚未就绪，不暗示它已安排待替换：已有 pending 需先收尾，替换失败则需解除占用或权限问题后重试。既有公共 journal、renderer 发布及其他调用方协议不变。

独立 CLI 的 `apply` 同样须持目标锁检查所在目录的共享 TMP 与 sidecar（包含孤立、损坏和符号链接），冲突时返回 `deferred`，不改 asar 或已有文件。无冲突时不清扫其他调用留下的 stage；替换失败仅清理由本次创建的 stage。`ensure_deployed` 的既有调用及 `check`、`remove`、`rewrite` 契约不变。

SessionStart 的兼容性提示优先于手机中继未就绪提示：兼容性提示已存在时不覆盖；刚安装成功分支也先生成兼容性提示，再决定是否显示手机提示。

## 验收

- 已注入旧代 relay 的隔离 asar 可升级，现有注入尾缀保留；已经是当前代时不复制或重写整包。
- 无 pending 时就地替换；替换受阻返回 deferred 并清理 stage，不发布 pending 或启动监控。
- install、remove、损坏、孤立和 publishing/Busy 以及锁忙均不触碰已有包或 journal；renderer 原有发布、监控及失败清理回归不变。
- 首次注入 pending 时不叠补丁；收尾后的后续 SessionStart 才继续补装，明确提示 Windows 尚未就绪及可能需要后续重启。
- dry-run、豁免、无客户端不补丁，失败不改变安装返回码，hook stdout 不混入诊断。
- CLI apply 对 TMP、sidecar 和两者同时存在均在锁内拒绝，逐字节保留冲突文件及 asar；无冲突可正常补丁且不删除既有 stage。
- 已注入及刚安装成功两条 hook 分支在兼容性提示与手机中继未就绪同时发生时保留兼容性内容；无既有提示时仍报告手机中继未就绪。
