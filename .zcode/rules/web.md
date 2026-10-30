# Web 旁挂部署规则

适用路径：`web/`（`boot.js`、独立 `overlay.js`、`zusage-sidecar.mjs`、`readonly-guard.py`、`nginx.conf.example`、`zusage-sidecar.service`、两份 README）。

Web 是单独部署方案，与桌面链独立；不是 npm 前端工程。

## 1. 实现边界

- `web/overlay.js` 是**独立实现**，不在 `sync_plugin.py` 同步清单内；不能直接复制根浮层覆盖 Web，也不能把 Web 的挂载/接口/布局差异"统一"掉——共享语义变化要分别评估两边（布局与显示项刻意分化：Web 窄屏一行式、宽屏与桌面逐项同款、显示项各存一套配置，以 web README 口径为准）。根浮层细则见 [overlay-ui.md](overlay-ui.md)，多数展示口径规则不适用。
- Web 有独立的 `remote:ssh:` 身份白名单（多服务器路由，sid → workspaceIdentity）。
- **精简模式（v95，与桌面 v146 同期、独立实现）**：`zusage3.theme` 为 Web 首个主题键，仅 `default`/`compact` 两档（无药丸），非法值回退 default；设置面板通用区用 `.zu-settings-langs` 同款视觉放 radio。条永久 `display:none` 保留 DOM（样式/自绘 tip 基建随条），`heavy()` 保条、`track()` 早退；`.zu-tsb` 速率与 `.zu-ctxb` 上下文 chip 挂 `group/toolbar` 的 `[data-composer-trailing-actions]` 左侧（锚缺失退行尾，位置每拍兜回，无有效速率样本不渲染）。chips 在条外：悬停由 document mousemove 的 chip 分支接进**实例自绘 tip**（摘要行受逐格开关控制、子代理行点击开明细、「打开设置」按钮走齿轮开启分支）；面板/子面板精简下锚输入卡/chip。Web 无 git/额度/重置卡链（sidecar 无凭据），精简模式不扩这些边界。
- Web 无 `turn-text` 消费链（sidecar 只 spawn `readonly-guard.py`）：回答末尾恒为简化占位行、无 ⏱ 采样时刻——改桌面统计行格式不得声称 Web 同步变化。
- 用户可见文案跟随宿主语言；同样引用 `--font-mono`/`--ui-font-size` 令牌（带硬编码回退），但布局与显示项配置和桌面独立。

## 2. 部署契约

- 文档列出 Node 22.19+ / 24+、nginx、systemd；sidecar 实际调用 Python 查询（`zusage`），不使用文档提及的 `node:sqlite`——该版本值是部署文档要求，不是已验证的代码门槛。
- 默认 loopback sidecar 向本机 ZCode 校验设备 Cookie；保留 nginx 认证、静态白名单和 systemd 只读限制，不直接暴露公网。
- `readonly-guard.py` 不改写已含 `mode=rw` 的 URI，不能把包装器当无条件只读安全边界。
- 需要 ZCode 的桌面安装器/注入链不适用于 Web；不能用桌面安装器修改浏览器或官方托管网页。控制自托管 ZCode、nginx 和旁挂服务是部署者的责任。

## 3. 验证

- 静态语法检查（不启动服务）：`node --check web/boot.js`、`node --check web/overlay.js`、`node --check web/zusage-sidecar.mjs`。
- 当前回归未覆盖 Web 端到端：授权的旁挂/认证/浏览器验收不可省略，不能拿桌面测试替代。
