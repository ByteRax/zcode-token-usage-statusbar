# Windows 手动安装（可见监控）的收尾存活

## 背景

`/install-overlay`（及 `install.py` / `overlay_install.py install`）在 Windows 上必然从运行中的 ZCode 内部执行（agent 工具会话）。此时 `app.asar` 被客户端占用，`os.replace` 以 `[WinError 5]` 拒绝——这是**预期行为**，不是安装故障；设计上由监控进程等 ZCode 完全退出后用 `--finalize` 路径完成替换。

issue #208 已证实：agent/插件宿主的 Job 常不允许 `CREATE_BREAKAWAY_FROM_JOB`，树内监控随宿主回收被杀，待收尾包搁浅。#208 只给**静默监控**（SessionStart 自动安装）加了 WMI 脱离通道；**可见监控**（手动命令、`CREATE_NEW_CONSOLE`）仍只有"breakaway → 被拒则树内回退"，被拒时监控窗口会在用户退出 ZCode 的瞬间一并消失，用户看到的结果就是"每次手动安装都替换失败、状态条始终不出现"。

## 产品规则

1. **可见监控 breakaway 被拒时不得留树内监控**：`launch_monitor` 可见分支（Windows）先只尝试 breakaway 拉起；被拒（`OSError`）后改走与静默分支同款的 WMI 脱离通道（pythonw + `--quiet`，父进程 WmiPrvSE），不再启动注定被宿主回收的树内可见监控。
2. **逐级回退不变**：WMI 不可用（`ZUSAGE_MONITOR_NO_WMI`、无 pythonw、创建失败）时，最后一级回退仍是原树内可见监控（含 #208 的 stderr 留痕），行为不劣化。
3. **文案如实**：改走后台静默监控时，向 stdout 说明"没有监控窗口、也无需保持任何窗口，完全退出 ZCode 后会自动完成替换"；同目标已有监控持锁而未新拉起时，说明"已有监控在值守"，不再让用户找一个根本不存在的窗口。这两条文案**只在可见（非静默）模式输出**——静默模式服务 hook，机器协议 stdout 不夹文本。
4. **静默分支行为逐字不变**：WMI 调用参数（解释器、argv、`--quiet` 尾参）、环境开关语义与 #208 一致，重构只抽出共用函数。
5. 运行中替换失败的提示在 Windows 上点明原因（运行中的 ZCode 会锁定 `app.asar`，属预期，待退出后自动完成），避免被转述成"安装失败"。

## 状态所有者与接口

- `patch_install.py`：`_spawn_detached(..., fallback=True)` 新增 `fallback` 参数（False 时 breakaway 被拒直接抛 `OSError`，由调用方决定降级）；新增 `_spawn_survivor_monitor(epoch)` 返回 WMI PID 或 `None`；`launch_monitor` 可见分支按规则 1~3 编排。
- 监控进程 `install_monitor.py`、实例锁、sidecar 协议不变。

## 验收场景

1. Windows + 可见模式 + breakaway 被拒 + WMI 可用：只调一次 `_spawn_via_wmi`（argv 含 `--quiet`），不再 `Popen` 树内回退，stdout 含"没有监控窗口、也无需保持任何窗口"说明（与实现逐字一致）。
2. 同上但 WMI 不可用：回退到树内 `Popen`（普通标志），stderr 含 `issue #208`。
3. Windows + 可见模式 + breakaway 成功：只 `Popen` 一次，不调 WMI。
4. 实例锁被持有 + 可见模式：不拉起，stdout 含"已有监控在值守"；静默模式同场景 stdout 为空。
5. 静默模式既有用例（`tests/test_quiet_monitor.py`）全部不变通过。

## 限制

WMI 脱离与 breakaway 被拒的真实行为只能在 Windows 实机验证；仓库测试以 mock 锁定编排逻辑。
