# 增强提示词按钮（模型 chip 左侧）

## 产品规则

- 会话输入框底部工具条、模型 chip（宿主 `[data-testid="chat-model-select-trigger"]`）左侧渲染一颗星芒按钮（`.zu-enhance`）；模型 chip 缺位时回退挂用量圆环（`chat-context-usage-trigger`）左侧，两者都缺不挂。Highspeed 锁定模型等宿主特殊分支下跟随锚点自然隐藏，不做额外猜测。
- 点击相位状态机：`idle` 点击发起增强；`enhancing`（loader-circle 旋转 + `aria-busy`）期间**再点 = 取消**（v344.1）：渲染端立即置 settled 丢弃迟到回包（不再应用结果）并恢复初始可点击态，同时经 `prompt-enhance-cancel`（载荷带在途 requestId，fire-and-forget）让主进程 abort 在途请求——`inject-main` 持有 requestId 到 AbortController 的在途表，`enhanceText` 接收外部 signal，取消返回 kind:"cancelled" 且不再重试，重试退避等待同样可被打断；该动作属主进程白名单，旧主进程吃 unknown 兜底回执，取消的「立即恢复+不应用结果」仍成立，仅「真中断网络请求」需重启加载新分支。- **会话切换（v344.3）**：发起时锚定会话身份（`enhanceSid = instSid || pickedSid`）。回填前先校验会话未变，变了则以「会话已切换，本次结果未应用」丢弃（区分于同会话内编辑导致的「草稿已变化」），**绝不把结果写进切换后的新会话草稿**——内容比对在两会话草稿恰好相同时会漏判，会话身份是权威闸。undo 窗口的基准校验同样并列会话校验：会话切换即收窗；undo 点击带同款守卫静默不回写。dispose/热更路径（`restoreEnhanceBtn(true)`）补发 `prompt-enhance-cancel` 中断在途请求止损额度；临时无锚只摘除 DOM、保持任务及超时；开关关闭则取消在途任务。

成功后进入 `undo` 相位 20 秒，再点恢复原文，超时或实例重渲染后回到 `idle`。undo 窗口的成立基准是**草稿仍为我们写入的增强文本**（`enhanceEnhanced`）：消息发送（提交流程清空草稿）、用户再编辑、输入框被外部改写任一发生时，render/heavy 对账点每拍校验并**自动提前收窗**回 `idle`（不依赖 20s 定时器，tooltip 不再滞留「撤销增强」误导）；undo 点击同样带基准守卫，基准不匹配时静默不回写（v344.2：修复「增强后发送消息，按钮滞留『撤回』且点击会把原文塞回已清空输入框」）。
- 增强 = 读取当前 composer 草稿全文（`__zcodeLexicalInputE2E.getText()`，`data-e2e-lexical-bridge === "ready"` 才可用）→ 主进程用当前会话模型对应凭据发起补全改写（Anthropic 流式聚合，其余非流式）→ 回填前核验会话身份和草稿全文，一致才 `setText()` 整体替换并重读确认。会话身份未知、输入桥不可用、草稿变化或写入未生效均不进入撤销态。空草稿不发请求。
- 模型归属：优先渲染端实时选择（`v4-model-config` 的 `data-provider`/`data-model`，与额度 chip 同链），缺省回退快照 `last.provider_id`/`model`。主进程只接受 `{providerId, modelId, text}` 三元组；凭据解析失败、无 key、协议不支持一律 fail-closed 回错误，绝不显示假成功。
- 增强 prompt 只改写不回答：语言跟随草稿（混合保持混合），~800 字符是软目标，长草稿以保真为先；保留代码/路径/命令/报错/数字/URL 及已有结构，不发明事实、技术栈或无关要求。用户草稿按 JSON 字符串序列化作素材，不能把此包装当成绝对的提示词注入防护；不新增无用标题或围栏，但保留原有代码围栏。仅正式答案字段可回填，只有思考内容、流错误、未完整结束的响应及清理后空文本均失败。仅发送当前草稿，不附会话历史、仓库文件或个人记忆。
- 开关 `enhance_enabled`（config.json 顶层扁平键）：缺省开，显式 `false` 关（与 `quota_enabled` 同语义）；主进程在动作入口 fail-closed 校验，渲染端按钮显隐与 ⚙ 面板开关真值跟随推送面 `enhanceEnabled`。

## 生命周期与失败契约

- 在途状态归实例，不归按钮 DOM：锚点临时消失只摘按钮，保留等待计时与 busy 相位；重新挂载继续显示同一任务。主动关开关、实例 dispose/热更或渲染端超时则置 settled、取消主进程请求并拒绝迟到回填。
- 主进程以窗口和 requestId 共同标识请求；同窗口重复 ID 静默拒绝（不能以相同 ID 回执消费原请求回调），窗口销毁只取消该窗口任务；结束清理必须校验条目身份，旧请求不能删除新请求。回填和撤销使用分栏可信 scope（会话、工作区、远端身份）再次核验；身份不可得时拒绝。支持宿主 editor state 序列化时，撤销恢复完整状态；草稿含结构化 mention 节点时拒绝增强（整体文本写入会丢失引用语义），不支持序列化且草稿含可识别引用时亦拒绝。
- 每次尝试的 30 秒覆盖请求及响应体读取，外部取消优先于超时；用户取消不重试，5xx、网络错误及超时最多重试一次并有可取消退避，4xx 和确定性解析错误不重试。失败或取消绝不返回部分结果；清理计时器、监听器及读取器。
- 流式响应须确认正常结束，不接受错误事件、截断或中断后的部分内容；允许尾行无换行和 UTF-8 跨块。Responses 多个最终文本块按顺序拼接；仅思考字段不算最终结果。

## 状态所有者与接口

- 渲染端（`src/overlay/11-instance-toolbar-chips.js` 实例闭包）拥有按钮 DOM、相位、busy/undo 定时器与草稿快照；实例 dispose / 关开关 / 锚点消失一律摘除节点，新代清扫选择器含 `.zu-enhance`。
- 主进程 `model-puller.cjs` 拥有凭据解析与 LLM 调用（`enhanceText`）：套餐源（`PLAN_SOURCES`，issue #336 起覆盖宿主 6 个套餐 id：bigmodel/zai 的 individual/team/start-plan）与 api-key 型自定义供应商（`provider_config.json` 的 `access.apiKey`/`api.baseUrl`/`api.type`）两路；三协议（anthropic-messages / openai-chat-completions / openai-responses）。宿主旧形 `builtin:*` 套餐 id 经 `planAliasId` 在拉模型/写入/探测/增强四入口归一为 `account:*`。套餐源鉴权默认**优先宿主对话同款** `v2/config.json` 的 `builtin:<plan>` provider `options.apiKey`（同目录并置文件，宿主 anthropic 端点 `/api/anthropic` + stream:true 实测正常），缺失/`enc:` 密文时回退 credentials.json OAuth token——**OAuth token 直连 messages 端点被网关以 500「网络错误 code 1234」拒绝**（2026-11-13 实测，stream 真/假、有无 UA 均复现），不得改回；例外与限制（issue #336，2026-11-14 实测定案）：`account:bigmodel-start-plan` 的推理与 coding plan **同走 `open.bigmodel.cn/api/anthropic`**，凭据=宿主在 bigmodel 账号下发放的**项目 API key**（名字 `zcode-api-key`、`usageScene=CODING_PLAN`、`id.secret` 形态，宿主已写入 v2 config 的 `builtin:bigmodel-coding-plan` 条目；本机 x-api-key/raw/Bearer 三头形实测 200）。此前按旧 config 注释打 `zcode.z.ai` + 会话 JWT 是双重错误（网关错+凭据错 → WAF 3012/401）；`zcode.z.ai` 仅承载计费（`billing/balance`，`zcodejwttoken`+`X-Device-Mid`）。`account:zai-start-plan` 走 api.z.ai anthropic + OAuth，端点未实测（无 zai 测试账号）。纯 start-plan（无 coding plan config 条目）账号回落 OAuth 会被 500 拒，需 GLr 项目密钥发放流程（未实现前诚实报 auth）。zai 团队与个人共享宿主同一 builtin 凭据条目，列表按同条目只列首档防重复行（credKey 兜底方向可能列出未开通套餐的假行，属已知取舍）。anthropic 协议走 SSE 流式聚合（`content_block_delta` 累积）；5xx/超时/网络类失败自动重试一次（1.2s 退避、单次 30s、总预算 ≈61s 留渲染端 75s 兜底内），凭据/路径/协议类不重试。凭据只在主进程内存与目标供应商请求中使用，不落盘、不进日志、不回传。
- 通道：渲染端 `pluginRequest("prompt-enhance", {providerId, modelId, text}, done)` / `pluginRequest("enhance", enabled, done)`，沿用 `__zusagePluginRequests` 轮询协议与 `__zusagePluginResult` 回执；主进程 `inject-main.cjs` 白名单分支校验形状（providerId ≤160、model ≤200、text 1..20000 字符）后分派。旧主进程不认识动作时回执 `unknown action`，渲染端按错误相位提示，不挂起。
- 配置开关经 `updateConfig` 原子事务写 `enhance_enabled`，保留未知键与用户显式值；⚙ 面板开关乐观更新，失败回执后回滚勾选态。
- 本功能是用户主动触发的生成式调用，会向当前供应商发送草稿文本并消耗额度；不启动后台周期调用，不影响统计/额度/MCP 查询协议，stdout 契约不变。

## 验收场景

1. 输入草稿点按钮：按钮转旋转态，回包后草稿被增强文本整体替换，20 秒内按钮变撤销态、点击恢复原文。
2. 增强期间继续编辑草稿：回包后不覆盖，按钮短暂警示态提示冲突，原文保留。
3. 空草稿点击：不发起请求，警示态提示「先输入内容」。
4. `enhance_enabled: false`：按钮不渲染；动作仍被主进程拒绝（双保险）。
5. 无凭据供应商（如未配置 key 的 custom）：回执 fail-closed 错误，警示态显示原因，绝不静默成功。
