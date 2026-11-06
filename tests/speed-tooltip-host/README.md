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

### 3. 锚点检测要求真实输入元素

overlay 的 composer 锚点扫描要求 `textarea/[contenteditable]/[role=textbox]/.ProseMirror`
等（`COMPOSER_SEL`）。占位 composer **必须包含 `<textarea>`**，且带
`data-session-id`（会话归属）与 `.conversation-bottom-dock-transition`（v282/283 dock
对齐锚）才有完整几何。宿主语义变量（`--color-tooltip/--color-popover/...`）在浅色场景
由 harness 页按浅色值补齐——生产由 ZCode `<html>` 提供。

### 4. 夹具纪律

- 轮表是 **delta 编码**：`spdUnpack` 累加还原——首轮 `t` 给绝对时刻、后续给增量，
  `b`（生成起点）给绝对值；弄反会被正确过滤成「0 桶假象」。
- 全部数值/时刻显式表驱动（`FIXTURES`），**禁止随机数**（Goal 约束：不制造随机数据）。
- payload 需 `session.avg_tps>0` + `mine` + `last.tps` 才能让速度格/浮层亮起。

### 5. 交互走真实输入事件

`webContents.sendInputEvent('mouseMove'/'mouseDown'/'mouseUp')` 在页面坐标系打真实
输入（非合成 DOM 事件）：

- 每步开始先把鼠标归中性区——**上一步残留的悬停会污染下一步**（误出 hover 卡）。
- 悬停目标用 `getBoundingClientRect` 中心；横向滚动场景先 `wrap.scrollLeft = scrollWidth`
  再悬停目标柱（测试「滚到最右的柱」边界）。

### 6. 几何断言优先于截图

`window.__zuDiag()` 返回 rect（tip/左卡/图表列/wrap/portal/legend）、
`portalInView/portalOnTop/legendInView/legendOnTop/bands/cur` 等：
「浮层完整在视口内」「Portal 显示时必须是 body 最后一个元素节点（同 z 层树序压过晚挂
tip，B1 教训）」「当前档高亮随夹具变化」这类契约用**测量**判定，截图只做人眼终审。

### 7. 测量口径

「用户所见左缘」= **tip 容器外缘**（border-box，`#zu-spd-replica` 自身），
不是 `.zu-sv-root` 内容盒（差 padding 13px 会误报 aligned=False）。

### 8. 已知坑位速查

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
- 链 L（v281/v282）：档位说明浮层开/关/浅色/窄窗 + 柱体互斥 + dock/.it 对齐。

每步 `runChain` 依次：场景注入 → 整卡装配 → （可选）真实点击 Tab/聚焦切换/滚动 →
（可选）柱 hover → `__zuDiag` 测量 → `capturePage` 截图。断言在链外由日志脚本判定，
`ISSUES/BAD` 计数非零即红。
