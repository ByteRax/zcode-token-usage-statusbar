# 状态轮播：附加工作时长与悬停提示（v347）

用户规格（2026-11-14）：为状态轮播新增两个功能——①「是否在轮播文案后追加宿主自带『工作中 X 分 X 秒』时长文案」的开关（默认开启）；②鼠标悬停轮播文案时展示内容为「工作中 X 分 X 秒」的 tooltip。性能预算全部落在 [perf-lag-reduction.md](perf-lag-reduction.md) 规则 17，测试以 §17 引用。

## 背景与现状

- 状态轮播（v268 移植）唯一挂载点是消息流 loading 行（`[data-testid="chat-loading"]`）内的宿主 label：`syncChatMountSurface()`（`src/overlay/05-status-rotator-runtime.js`）每 65ms tick 重写其 `textContent`；`labelSource:"phrases"` 时宿主自带 `.font-mono` 耗时格被隐藏防双计时。
- 宿主原生「工作中 X 分 X 秒」文案显示在 turn group 折叠头（i18n 键 `chat.history.workingFor`，zh:5322 / en:5695）：节点在虚拟滚动容器内、无数值属性、生产构建无 window API，**读宿主 DOM 不可靠**；计时起点 `nowMs - turnHeader.startedAt`，1s interval 逐秒跳动。
- 插件 `collectRotatorLiveContext()` 已产出同源 `elapsedMs`（`activeStats.startedAt` 即宿主 turnHeader.startedAt，回退 `rotatorRuntime.turnStartedAt`）——自算即可与宿主数值逐秒一致。

## 产品规则

1. **开关① `appendWorkDuration`**：默认 `true`；存 `zusage3.rotator2` 整包（`loadRotatorConfig` 布尔守卫：显式 false 永久保留，缺省/类型错落回默认 true）。生效条件 = 轮播主开关 `enabled` 且 `labelSource:"phrases"` 且 label 命中——host 模式宿主耗时格本就显示，不重复追加。
2. **时长格式与宿主逐句对齐**（`packages/ui/src/v4/conversationWorkDuration.ts` `formatConversationWorkDuration`，3.18.2 app.asar 实测同款）：`totalSeconds = max(1, round(ms/1000))`；拆 天/时/分/秒，非零单位入列，`seconds > 0 || parts` 为空时补秒；`parts.slice(0, 2).join(" ")`；中文值与单位间插空格（`2 分 5 秒`），英文不插（`2m 5s`）。前缀 zh「工作中 」/ en「Working for 」，语言跟随 `zusage3.lang`（`L()`）。
3. **tooltip② 独立于开关①**：只要轮播接管 label（enabled 且 active 且 label 命中，两种 labelSource 均可）就挂 `data-tip` + `zu-rot-livetip` 类，纯 CSS `:hover::after{content:attr(data-tip)}`（先例 `.zu-rot-tipt`，宿主 stopPropagation 拦不住、零监听零解绑）；气泡向上弹（loading 行在消息流底部，向上弹入容器内容区），静态无动画、`pointer-events:none`。内容与开关①追加文本同串同缓存。
   - **v349 起气泡挂行容器（`[data-testid="chat-loading"]`）而非 label**：宿主 gradient label 自带 `filter:drop-shadow(rgba(255,0,85,.45) 0 0 6px)`（255,0,85=宿主渐变首色，shimmer 固有），filter 不继承但**作用整棵子树**——气泡作为 label 伪元素子盒被一起泛红光（用户实报「红色 shadow」）。挂行即脱离 filter 作用域；label 上 v348 旧代际 tip 属性/类每拍清退（防热重载双气泡），还原名单行级摘除。
   - **v348 修复与系统同款化（用户实报两连）**：①「悬停看不到时长」根因=宿主 gradient 文本 label 的 `-webkit-text-fill-color:transparent` 是**继承属性**，被伪元素继承后压过规则 `color` 使文字全透明（CDP computed 实证；pointer-events 实测 auto 排除禁点）——气泡必须显式重置 `-webkit-text-fill-color:var(--color-tooltip-foreground)`，未来任何自绘伪元素挂在宿主 gradient 文本节点上同款教训；②样式对齐宿主原生 TooltipContent 视格（asar 实证 `rounded-lg border-border bg-tooltip px-3 py-1.5 text-ui-sm`，**原生无阴影**，用户点名去阴影）：`--color-tooltip` 反色底 + `--color-tooltip-foreground` 文字 + `--color-border` 边框 + 8px 圆角 + `6px 12px` 内距 + 无 box-shadow。
4. **对账与还原**：span 判位 `label.nextElementSibling` 类名比较（零查询、不缓存节点引用）；开关关/host 模式/label 未命中时 span 存在才摘除；`restoreChatLoadingRow` 名单并入既有选择器串并摘 `data-tip`/类（带 hasAttribute/contains 前置判断）；`zuRotatorDisposeAll` 经 `restoreAllChatLoadingRows` 自动覆盖。
5. **性能**：零新增定时器/监听/文档级查询，DOM 写入按整型秒门控（每行至多 1 次写/秒），tick 路径零布局读取——细则见 [perf-lag-reduction.md](perf-lag-reduction.md) 规则 17。
6. **⚙ 底部预览卡不联动**本功能（预览定时器不新增写流）；设置分区新增 checkbox `.zu-rot-append-duration`（第一卡，启用行之后），回填/写回走既有 `zuRotatorSyncPanel`/`zuRotatorPanelChange` 尾缀统一保存链。

## 宿主版本兼容（3.18 系及以后，用户规格 2026-11-14）

- **接触面清单（零新增版本敏感选择器，全部复用既有契约）**：label/pixelGrid 命中走 `chatLoadingLabelOf`/`chatLoadingPixelGridOf` 既有双选择器（v330：`.zcode-loading-label` 旧结构优先、`span.animated-gradient-text` 新结构兜底，3.17.x 与 3.18.0+ 双兼容）；span 判位 `label.nextElementSibling` 纯 DOM 序、类名无关——任意版本只要 label 命中即工作；`data-tip`/`zu-rot-livetip` 挂行容器 `[data-testid="chat-loading"]`（见产品规则 3 的 v349 filter 作用域记录），同命中守卫。
- **3.18.0 / 3.18.1 / 3.18.2 三版本同构实证**：渲染桥 HOST_TARGETS 逐一登记三版本 styles 资产指纹（适配批 07856f2=3.18.1、6c3fdba=3.18.2 均未触及 loading 行结构——若结构有变必然产生适配批）；本机 3.18.2 app.asar 渲染层实搜命中 `animated-gradient-text`×9、`data-chat-loading-icon`×1、`chat-loading`×4、`turnHeader`×37。轮起点 `turnHeader.startedAt` 在 3.16.2 镜像与 3.18.2 bundle 双证在场。
- **任意未来版本的降级行为（均 fail-safe）**：label 类再改名 → `if (label)` 守卫下 span/tip 均不挂，与既有「label 未命中保耗时格」降级同款；loading 行 testid 变化 → 轮播整体不激活（既有行为），已挂行由 `[data-zusage-rotator-slot]` 标记兜底清理；宿主改写/重建 label 节点 → 每拍 nextElementSibling 判位 O(1) 自愈（不缓存节点引用）；**已知接受边界**：宿主若在 label 与 span 之间插入新兄弟节点，判位失配会新建第二个 span（旧 span 冻结在最后写入值），残留至本轮结束、主开关关闭或还原时经选择器串统一清零——3.18 loading 行三子节点结构静态，触发需宿主结构性变更，接受；`turnHeader.startedAt` 协议缺失 → 既有回退链（首观测起算），时长数值仍产出。
- 本机实测基线为 3.18.2；3.18.0/3.18.1 由适配批历史与指纹登记间接证明，后续新客户端版本按既有升级体检流程（AGENTS §6 六项体检）复核 loading 行结构即可，本功能无额外体检项。

## 验收场景

1. 默认值：新配置 `appendWorkDuration === true`；LS 显式 `false` 保留；脏值（非布尔）回 true。
2. 格式化全档位：125000ms→`2 分 5 秒`；42000ms→`42 秒`；3780000ms→`1 时 3 分`；60000ms→`1 分`（秒 0 且有高位单位不入列）；跨天取前两段；en `125000ms`→`Working for 2m 5s`；500ms→`1 秒`/`1s` 下限。
3. 挂载：phrases+开关开 → label 后兄弟 `.zu-rotator-elapsed`、内容逐秒更新、行容器带 `zu-rot-livetip` 类与 `data-tip`；开关关或 host 模式 → span 摘除、tooltip 仍在（host 模式）；label 未命中 → 两者都不挂。
4. 还原：`restoreChatLoadingRow` / 关闭主开关 / `zuRotatorDisposeAll` 后无残留 span、label 无 `data-tip` 与 `zu-rot-livetip`（无原生 title）。
5. 面板：checkbox 存在、`zuRotatorSyncPanel` 回填、change 写回并保存（既有尾缀链触发 masterTick 即时生效）。
6. 性能（perf-lag §17 / 验收 12）：同一秒内连续 tick → textContent/data-tip/classList 零写入；秒跨变首个 tick → 恰各 1 次；`document.querySelectorAll` 调用计数不增；主开关关闭态 1s 节流不变。
7. 实机：追加文案与宿主 turn 折叠头「工作中」数值逐秒一致；悬停出气泡不被消息流容器裁剪；开关切换即时生效；中英文跟随。
