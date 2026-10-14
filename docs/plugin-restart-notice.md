# 重新注入后的重启提醒（1.2.2）

日期：2026-10-13。

## 位置与文案

选择下一条助手最终回复正文的顶部，使用引用块：

> ⚠️ 状态条已自动安装/重新注入，需完全退出 ZCode（所有窗口）并重新打开后才能生效；仅刷新页面或重开会话无效。

原因：升级后状态条 loader 可能尚未运行，不能把提醒放在状态条设置里；当前宿主对 SessionStart `systemMessage` 没有用户可见展示消费路径。`hookSpecificOutput.additionalContext` 能进入模型上下文，所以通过该字段要求下一次回复展示提醒，UserPromptSubmit 保留该要求直到 loader 加载。

限制：这是模型回复提醒，不是客户端原生即时通知；需要产生下一条回复，并依赖模型遵从。本次未改动宿主 UI、未弹系统窗口、未自动重启客户端。

## 实现

- `plugins/zcode-token-usage-statusbar/restart_notice.py`：写入 `.plugin-restart-required` 标记，构造 SessionStart 提醒上下文。
- `overlay_install.py`：自动重新注入成功后返回提醒上下文；显式安装成功且原注入无效时记录标记并打印文案。失败不写“成功重启”提醒。
- `hooks/prompt-submit.py`：标记存在时在原速率上下文之前附带用户可见提醒指令，不改原统计行为。
- `inject-main.cjs`：主进程真正加载 loader 时清除标记；仅重开会话不会清除。
- `commands/install-overlay.md`：成功时最终回复第一行提醒。
- 两份插件 manifest 与 marketplace 版本统一为 1.2.2。

## 实际验证

- Node 回归 22 项通过，包含 loader 清理标记。
- Python 回归 85 项通过，新增 5 项重启提醒测试；微型 asar 重新注入成功输出额外断言 SessionStart 上下文和标记。
- 原逐问速率 12 项通过。
- `sync_plugin.py --check`、`node --check inject-main.cjs`、`git diff --check` 通过。
- 官方 `plugins validate` 在临时沙箱目录校验含提醒模块的包，返回 `ok=true,diagnostics=[]`。
- 宿主实际输出 schema 已查证：SessionStart 与 UserPromptSubmit 都允许 `additionalContext?: string`。仅清单校验不代表实际会话展示已验证。

测试全部使用临时文件/夹具，未更改已安装缓存、真实配置或 asar。119 项测试证明协议、触发和清除链路；真实升级后的助手展示仍待已安装插件更新后试用。源码当前 1.2.2，未提交、推送或发布。
