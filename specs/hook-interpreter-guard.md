# hook 解释器版本门

## 范围与规则

- 背景（issue #454）：`hooks.json` 的 `python3 → python → py -3` 是 command+shell 静态回退链，只认各候选的退出码。PATH 里的 `python` 低于 3.8 时能解析脚本并跑到第一个 3.8+ API 才抛错，`session-start.py` 的兜底把异常转成「自检失败（已忽略）」后以 0 退出——链在此终止，后面的 `py -3` 轮不到，自动安装与待收尾整条链失效。
- 产品规则：本库要求 Python 3.8+。回退链上任何低于 3.8 的解释器都不得被选中，无论它排在链上哪一位。`hooks.json` 命令串与候选顺序不变。
- 状态所有者：版本门内联在 `hooks/session-start.py` 与 `hooks/prompt-submit.py` 入口（hooks 文件在两份 manifest 逐文件登记，不新增共享模块）。
- 接口契约（hook 侧）：
  - 守卫位于读 stdin、计算 `PLUGIN_ROOT` 与任何 3.8+ 语法/API 之前，自身保持 3.7 可解析。旧解释器不消费 hook 入参，下一候选拿到的 stdin 与宿主写入一致。
  - 不达标时向 stderr 写一行 ASCII 诊断（`[zusage-plugin] Python x.y is too old; zusage needs 3.8+`），退出码固定 `9`。退出码不得为 `0`（链在此终止）或 `2`（宿主语义 = 阻断）。
  - 宿主侧语义：链尾退出码非 0 非 2 时按单个 hook 失败处理，fail-open，不阻断会话与提问。「本机只有旧 Python」由「自检失败（已忽略）」文字变为 hook 摘要里的失败状态；失败原因只在 stderr（引擎日志与事件载荷），界面不展开 stderr，只有退出码 2 的阻断才显示原因文字。SSH/WSL 远端主机上只有旧 Python 时同理：hook 由静默 no-op 变为失败状态，同样不阻断。
  - 下限本身放行：恰为 3.8 的解释器不得被让位。
- 接口契约（MCP 侧）：MCP 由宿主预置 `zcode-python` 直接启动 `usage_mcp.py`，版本下限由宿主入口保证，插件不再做解释器探测（`mcp-launch.cjs` 已移除）。
- `python_path` 不参与解释器发现：hook 由宿主 shell 按命令名解析解释器，没有「先读配置再选解释器」的执行点。`python_path` 仍是安装后的记录（安装与每次 SessionStart 写回 `sys.executable`，主桥与更新器消费）。
- 生效方式：hooks 在插件链从插件目录（缓存）运行，不属于运行目录文件；hooks 在下一次会话启动/提问读新文件。

## 验收

| 场景 | 预期 | 验证 |
| --- | --- | --- |
| 旧解释器运行任一 hook 入口 | 读 stdin 前退出：退出码 9、stdout 为空、stderr 一行诊断，hook 主体未执行。链尾停在这个退出码时宿主 fail-open | `tests/test_hook_interpreter_guard.py` 入口用例（子进程伪装解释器版本，跨平台） |
| 恰为下限的解释器（3.8.0） | 守卫放行，hook 主体正常运行 | 同文件下限用例（阈值被收紧时变红） |
| 真实 `hooks.json` 命令串：`python3` 缺失、`python` 为旧版、`py -3` 可用（#454 报告机形态） | 旧候选让位，链落到 `py -3`；`py -3` 收到的 stdin 与写入一致；stdout 不含「自检失败」 | 同文件链路用例：临时假解释器 + `/bin/sh -c <hooks.json 原命令串>`（Windows 跳过；`||` 命令串本身由 `tests/test_plugin_contract.py` 锁定） |
| 达标解释器 | 守卫无副作用 | 既有 SessionStart 与 prompt-submit 回归不变 |
