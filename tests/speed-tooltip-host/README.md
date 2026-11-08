# speed-tooltip-host — 生成速度 Tooltip 真实 Electron 视觉/几何 QA harness

针对「生成速度 Tooltip」（`spdCardV2HTML` 一族）的**真实 Electron 渲染**验收工具：
不是 Headless Chromium，也不是静态设计稿——同一 renderer 里**原文注入运行目录 overlay.js**
（真实 IIFE、真实注入 CSS、真实状态条挂载），再用**同文件的纯函数块原文切片**装配 V2 整卡，
交互遵循生产同款「改 sel/hover 包 ⇒ 整卡纯函数重编」契约。

> 归属说明：本目录是 QA 专用独立工具，**不在 `sync_plugin.py` 分发清单**、不进发布包；
> `node --test tests/*.test.cjs` 的 glob 不会执行本目录。

## 运行

```bash
cd tests/speed-tooltip-host
npm init -y && npm i electron          # stock Electron（npmmirror 快）；不入库
ZU_OVERLAY=~/.zcode/zcode-token-usage-statusbar/overlay.js \
  ./node_modules/.bin/electron .       # 默认即标准运行目录，可省 ZU_OVERLAY
```

截图/几何日志输出到 `shots/`（gitignore）。`main.cjs` 末尾的链（chain）即场景清单，
按需增删；每步 `shot` 命名带版本前缀防止混版。

## 为什么不能直接用 ZCode 二进制

ZCode 是打包 Electron：`ZCode.app/Contents/MacOS/ZCode tests/speed-tooltip-host` 会**忽略
app 路径参数自启完整 ZCode**（打包应用不走 default_app）——不可当 generic Electron 用。
必须 npm 装 stock Electron + `app.setPath('userData', …)` 隔离 profile（勿触碰用户真实
userData）。

## 核心技巧（踩坑沉淀）

### 1. 生产原文切片装配，而非复刻

`main.cjs` 从运行目录 overlay.js 原文提取：

- `TPS_BANDS` 数组 + `tpsBand`/`tpsBandText`（花括号配平提取，`extractBraced`）；
- `var SPD_RANGES … /* SPD_V2_BLOCK_END */` 整个 SPD_V2 纯函数块；
- Portal / 档位说明浮层的宿主函数（`spdHoverPortalSync/Place/Hide`、
  `spdLegendTipShow/Hide/ScheduleHide`）。

页面里 `new Function('L', src)` 装配（`L` 由 harness 供给语言分支）。**QA 跑的是生产
原码**——样式、分析、定位避让算法与真实宿主逐字一致，杜绝「复刻实现与生产漂移」。

### 2. 真实注入提供真实 CSS 与状态条

`host.html` 用 `<script src="file://…/overlay.js">` 原文加载运行目录 overlay.js：
注入样式表（`.zu-sv-*`/`.tip` 等）、boot 清理链、状态条渲染全部真实。纯函数工厂的
`SPD_PORTAL`（`getPortal` 导出）经 `window.__setSPDPortal` 桥给 Portal 函数作用域。

### 3. 宿主形态：真实 ZCode composer 复刻（2026-11-08 起）

`host.html` 的输入区不再是简化占位，而是按宿主源码（`packages/ui/src` 的
`v4/ConversationComposer.tsx`、`prompt-editor/ChatPromptEditor.tsx`、`LexicalChatInput.tsx`、
`v4/ConversationTimeline.tsx`、`styles.css`）逐层复刻的真实 composer：

- DOM 属性/testid 与生产一致：`[data-testid="v4-composer"]`、`v4-composer-input`
  （`contenteditable` + `role=textbox`，命中 overlay `COMPOSER_SEL` 与 `composerCardOf`
  的 `chat-composer-input-surface ⊃ [data-composer-layout]` 识别链）、
  `group/toolbar` 工具行（`toolbarRowOf` 识别串）、`data-composer-leading-actions/`
  `leading-content`/`trailing-actions`（额度/Git chip 挂载点）、
  `chat-context-usage-trigger`（v93 原生按钮增强锚）、`v4-model-config` 隐藏锚
  （v98 额度选源观察对象）、`data-v4-composer-dock[-content]`、会话根
  `data-session-id`/`data-pane-id`。
- 主题为四套生产令牌原文：`zai-dark`（真机默认，`html.dark.theme-zai-dark`）、
  `zai-light`、classic `dark`/`light`（Tailwind 调色板 hex 换算，个别色近似）。
  `__zuScenario` 的 `theme:'dark'/'light'` 分别映射 zai-dark/zai-light（真机默认主题对），
  `'classic-dark'/'classic-light'` 可显式请求。
- 工具行按用户日常实态摆样：yolo「完全访问」警示橙、模型名 + 思考档位徽标（「最高」）、
  context 圆环（`ContextIcon` viewBox 24 r=10 strokeWidth=4）、禁用发送钮（空文本）。
- 消息流为背景占位（非复刻对象），仅营造「有历史会话」真实感。

### 4. live 实时数据链（2026-11-08）：真实当前会话，可对照复现

链首的 `live-*` 场景不再用夹具：`main.cjs` 起生产同款 **`zusage.py serve` 常驻泵**
（inject-main v8 同款 stdin 空行请求 / stdout 一行 JSON 快照行协议，serve 随
harness 退出 stdin EOF 自清理），拉**真实当前会话**（数据库最近活跃会话，通常就是
正在跑的这个 ZCode 会话）快照并推给页面：

- 泵帧直推 overlay `__zusageUpdate`（`payload.mine=会话 SID`，生产泵 v34 语义）——
  状态条、今日、工具计数全部为跑链瞬间的真实值；
- 页面包装层缓存真实轮表/`__zuLiveSid`，V2 卡 `sel.sid` 联动真实会话，并把复刻
  composer 的会话根 `data-session-id` 同步为真实 SID（归属链真实）；
- 数据模式互斥：`step.live`/`fixture:'live'` 为 live，其余步骤锁定 `fixture`
  模式并丢弃在途真实帧——确定性夹具基线不被污染；
- `liveWait` 步骤在挂卡状态下每 2s 收帧（如 8s 实时观察），验证状态条随会话更新；
- 环境：`ZU_ZUSAGE`（默认运行目录 `~/.zcode/zcode-token-usage-statusbar/zusage.py`）、
  `ZU_PYTHON`（默认 `python3`）。serve 拉起的价表同步线程随进程退出；
- 当前会话轮数不足时 V2 卡呈真实稀疏形态（非回归；边界场景仍由夹具链覆盖）。

### 5. 夹具纪律

- 轮表是 **delta 编码**：`spdUnpack` 累加还原——首轮 `t` 给绝对时刻、后续给增量，
  `b`（生成起点）给绝对值；弄反会被正确过滤成「0 桶假象」。
- 全部数值/时刻显式表驱动（`FIXTURES`），**禁止随机数**（Goal 约束：不制造随机数据）。
- payload 需 `session.avg_tps>0` + `mine` + `last.tps` 才能让速度格/浮层亮起。

### 6. 交互走真实输入事件

`webContents.sendInputEvent('mouseMove'/'mouseDown'/'mouseUp')` 在页面坐标系打真实
输入（非合成 DOM 事件）：

- 每步开始先把鼠标归中性区——**上一步残留的悬停会污染下一步**（误出 hover 卡）。
- 悬停目标用 `getBoundingClientRect` 中心；横向滚动场景先 `wrap.scrollLeft = scrollWidth`
  再悬停目标柱（测试「滚到最右的柱」边界）。

### 7. 几何断言优先于截图

`window.__zuDiag()` 返回 rect（tip/左卡/图表列/wrap/portal/legend）、
`portalInView/portalOnTop/legendInView/legendOnTop/bands/cur` 等：
「浮层完整在视口内」「Portal 显示时必须是 body 最后一个元素节点（同 z 层树序压过晚挂
tip，B1 教训）」「当前档高亮随夹具变化」这类契约用**测量**判定，截图只做人眼终审。

### 8. 测量口径

「用户所见左缘」= **tip 容器外缘**（border-box，`#zu-spd-replica` 自身），
不是 `.zu-sv-root` 内容盒（差 padding 13px 会误报 aligned=False）。

### 9. 已知坑位速查

| 症状 | 原因 |
|---|---|
| 改了源码 QA 无变化 | harness 读**运行目录**文件——先部署再跑 |
| 窄窗 aligned=False | `min(800,vw-24)` 放不下时右缘钳边优先于 dock 对齐（正确取舍） |
| 浮层没开 | 提取函数引用的模块级变量（如 `spdLegendHideTimer`）要一并进 eval 作用域 |
| 前一步 hover 卡残留 | 步前鼠标归中性区 |

## 场景链说明

`main.cjs` 内建四组链（可自由增删）：

- 基础 10 场景：recent16 深浅/en/窄窗、today 稀疏+聚焦、完整时间轴、项目×近7天、
  单日单柱、全库×本月、柱 hover 五字段卡；
- 链 G（几何）：5 Tab × 1~30 桶宽度稳定性（tipW 恒定）+ 首柱/末柱/滚后末柱 hover；
- 链 L（v282/v283）：档位说明浮层开/关/浅色/窄窗 + 柱体互斥 + dock/.it 对齐。

每步 `runChain` 依次：场景注入 → 整卡装配 → （可选）真实点击 Tab/聚焦切换/滚动 →
（可选）柱 hover → `__zuDiag` 测量 → `capturePage` 截图。断言在链外由日志脚本判定，
`ISSUES/BAD` 计数非零即红。
