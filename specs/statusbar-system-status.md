# 状态条系统状态（sysmon）：本机资源监控格

Issue #338。在既有「排序 → 优先级 → 自适应 → 自动折叠 → 更多菜单 → Tooltip」链上新增第 8 个一等显示格 `sysmon`，展示本机 CPU / 内存 / 磁盘实时水位，含预警变色与完整资源 Tooltip。禁止第三行状态条、禁止输入框外悬浮入口、禁止第二套排序/折叠/Tooltip 框架。

## 数据流与采样架构

- 链路：**本机采样器（主进程热模块 `sysmon-client.cjs`）→ 主进程统一调度与缓存 → `pushOnce` 同款信任门推 `window.__zusageSysmon(frame)` → 渲染端共享 `state.sysmon` → 条面格 / Tooltip / 折叠菜单 / 精简 chip**。
- 单例采样：主进程唯一采样器；多窗口、多分栏、多 Tooltip 共享同一份缓存，绝不为每个实例/Tooltip/设置页单独采样。
- 订阅制：渲染端按需经 pluginRequest `sysmon-sub {want, cfg, projectPath}` 声明兴趣（条面格可见、Tooltip 打开、设置页打开、精简 chip 挂载任一成立即 want；projectPath 供主进程定位项目卷）。主进程按 wc 记账（destroyed 清理 + sweep 兜底），want>0 才轮询；want→0 停表，最近一帧保留供回读（渲染端按 ts 判过期）。
- 刷新节奏：CPU/内存默认 5s（2s–60s 可配），磁盘默认 60s（30s–600s 可配），双定时器独立。配置由渲染端 `sysmon-sub` 携带、主进程校验 clamp 后运行时生效；不落 config.json（重启后由首个订阅窗口重发），渲染端持久化 `zusage3.sysmonCfg`。
- 监控范围恒为**运行 ZCode 的本机**：远端/不在本地库的 scope 不渲染格（`!d.remote && !d.not_local` 门控），不把本机指标冒充远端。本期不做远端资源采集。

## 帧协议（`__zusageSysmon(frame)`）

```json
{
  "v": 1, "ts": 1700000000000,
  "cpu":  { "state": "ok", "pct": 23.4, "cores": 8, "load": [1.28, 1.11, 0.98] },
  "mem":  { "state": "ok", "total": 17179869184, "used": 10952166604, "avail": 6227702580,
            "pct": 63.8, "wired": 2254857830, "swap_total": 1073741824, "swap_used": 644245094 },
  "disk": { "state": "ok", "vols": [
    { "id": "/", "name": "Macintosh HD", "mount": "/", "role": "system", "total": 549755813888, "used": 348966092800, "avail": 200746721088, "free_pct": 36.5 },
    { "id": "/System/Volumes/Data", "name": "Data", "mount": "/System/Volumes/Data", "role": "project", "total": 1099511627776, "used": 794568949760, "avail": 304942678016, "free_pct": 27.7 } ] }
}
```

- 容量一律原始字节；单位格式化只在展示层。未知/不支持值显式缺省（`null` 或字段缺席）或 `state` 降级，**绝不用 0 冒充**。
- `state` 枚举：`loading`（首次采样不足）/ `ok` / `error`（采集失败）/ `unavailable`（平台不支持）。三指标各自独立，单项失败不拖垮其余；`stale` 与 `disabled` 由渲染端按 `ts` 年龄与本地开关推导，不进帧。
- CPU：`pct` 为整机使用率（`os.cpus()` tick 差分，Σ(Δtotal−Δidle)/Δtotal×100，跨核汇总；Δtotal≤0 保持 `loading`）；`cores`=逻辑核心数；`load`=1/5/15 分钟负载（`os.loadavg()`，win32 恒 `null` 不伪造）。首帧差分未成立时 `state:"loading"`。
- 内存口径：Linux `/proc/meminfo`（used = MemTotal − MemAvailable，含 SwapTotal/SwapFree）；macOS `vm_stat` 页数×pagesize（used = active + wired + compressor occupied，对齐活动监视器主口径；avail = free + inactive + speculative；wired 单列；Swap 走 `sysctl vm.swapusage`）；Windows `os.totalmem()/os.freemem()`（GlobalMemoryStatusEx），wired/swap 恒 null（字段缺席即隐藏，不显示假值）。
- 磁盘：卷集 = 系统卷 + 当前本地项目卷（主进程从窗口工作区路径取，缺省退系统卷）+ 可可靠识别的其他本地固定卷（上限 8，按 `statfs` 设备去重）。容量经 `fs.statfs`（Node ≥18.15，宿主 Node 24 实测可用）；卷枚举 Linux 解析 `/proc/self/mounts`（真实文件系统白名单、排除 tmpfs/overlay/squashfs 等）、macOS `df -klP`（仅本地卷）、Windows 盘符经 `fs.promises.statfs` 逐盘探测（带超时防断连网络盘阻塞）。`role:"project"` 标注项目卷（Tooltip 突出行）；同名同设备卷去重。禁止递归扫描目录算占用。
- APFS 共享容器（v357）：macOS firmlink 下 `/`（系统快照卷）与 `/System/Volumes/Data` 共享同一 APFS 容器空间，`statfs` 对两者返回相同容量。仅当两卷同时入选且设备名同 `diskN` 前缀（`/dev/disk3s1s1` 与 `/dev/disk3s5` → `disk3`）时，两卷标 `container:"disk3"` 并随卷下发 `dev`（枚举源设备名）。**容量相同不作为判据**（不同盘可能巧合相等）；外置卷之间无法与「非 APFS 多分区盘」区分，保守不标——前端对无 `container` 的卷恒展示各自真实容量，不擅自合并。Linux/Windows 无该字段。

## 渲染端模型

- `zusage3.sysmonCfg`（JSON，定向写 + storage 跨窗同步，`normalizeSysmonCfg` clamp 校验）：
  `{ metrics:{cpu,mem,disk}, format:"auto|full|compact|minimal", intervalMs, diskIntervalMs, warnColors, projectVol, systemVol, thresholds:{cpuWarn:80, cpuCrit:90, memWarn:85, memCrit:90, diskFreeWarn:15, diskFreeCrit:10} }`。
  阈值边界**含等号**：CPU/内存 ≥warn→预警、≥crit→危险；磁盘可用率 ≤warn→预警、≤crit→危险。默认值即上表（设计稿的 >80/>90 是说明性示例，实现统一为含边界）。
- 排序接入：`ZU_BAR_KEYS` 加 `"sysmon"`（缺省序补尾）；`ZU_BAR_PRIORITY_DEFAULT.sysmon = "low"`；`ZU_BAR_TITLES.sysmon = ["系统状态", "System status"]`；`state.show.sysmon` 缺省 **0（关）**——首次启用需用户在排序卡打开，不覆盖老用户；旧配置缺项由 `zuBarOrderNormalize` 自动补尾。排序/优先级与资源健康度是两套独立状态（high/normal/low 只决定折叠竞争；normal/warning/critical 只决定颜色），互不复用字段。
- 严重度：渲染端纯函数 `sysSeverity(cfg, frame)` 逐指标判定（error/stale/disabled 不参与综合），综合取 `critical > warning > normal`。
- 条面格 face 三态格式（`data-zu-key="sysmon"`）：
  - full：`[显示器] CPU 23% | MEM 10.2/16G | DISK 187G`
  - compact：`[显示器] CPU 23% | MEM 64% | DISK 187G`
  - minimal：`23% | 64% | 187G`（仅一项开启时保留指标名 `[显示器] CPU 23%`）
  - `format:"auto"` 随窄宽档位：shrink 0→full、1→compact、2→minimal；档位切换由窄宽状态机钩子驱动重绘（250ms 节流+迟滞既有纪律，无新探针）。显式 full/compact/minimal 不自动改写；空间不足仍走既有折叠链。DISK 值=主卷（project 优先，退 system）可用空间；内存 full=已用/总量、compact/minimal=百分比。CPU 差分未成立显 `--`；关闭的指标整段不渲染；全部关闭不渲染格。
- 预警视觉（`warnColors` 开，默认开）：warning=柔和黄、critical=柔和红，仅染数值/图标不染整条背景；**图标随状态切换**（warning/critical 用警告三角 SVG 替代显示器图标），色弱可辨；无高频闪烁、无声音、无系统通知。恢复即还原，迟滞在采样确认层（连续 2 拍进预警才亮、回落后 1 拍还原不拖）。
- Tooltip（`\x01` 结构化串走通用 `__tip` 链，440px，`.zu-sys-tip` 作用域；v357 紧凑重构）：
  - 标题区：显示器图标 +「系统状态」+「本机」低对比标签；右上时钟图标 + `5s · 60s`（按实际 cfg 动态，title 带完整说明；时钟是纯说明不是按钮）。
  - CPU 区（Grid：标签列 | 主数值 | 右侧辅助）：主数值=使用率百分比；右侧=核数；Load 1m/5m/15m 恒两位小数进 sub 行（不支持平台整行隐藏）；loading 显「采集中…」。
  - 内存区：主数值=已用/总量（与 pct 同口径），右侧=百分比；Wired / Swap 进 sub 行（有值才渲染；`swap_used` 为有效 0 时显 `Swap 0G`，null 不渲染）。
  - 磁盘区：区头右侧显当前主卷角色（「当前：系统卷/项目卷」），**不再单独渲染挂载点行**；表 = 卷 | 总量 | 已用 | 可用，当前监控卷轻背景+左 2px 强调线，长名省略 title 全文，>6 卷内部滚动（max-height 钳制）。带 `container` 的卷：同容器首行带「APFS 共享」徽记、次行容量区显「共享容器空间」（不重复数值、不相加）；无 `container` 的卷恒显各自真实容量。
  - 图例：正常/预警/危险三色点一行 + ⓘ 按钮（`data-zu-sys-th`，点击切换内联展开区 `data-zu-sys-thexp`：三行阈值表动态读 cfg、关系非法标红、warnColors 关时注明「颜色提示已关闭」）。展开态跨重建保留（tip `__zuSysExp`），关闭即复位。
  - 数据更新：Tooltip 打开期间随帧原地重建（签名幂等），保留磁盘表滚动位；从「···」菜单打开锚定 ⋯ 按钮（既有链，Escape/外点/滚动态不变）。
- 折叠与菜单：`sysmon` 参与自动折叠（`zuBarFoldOrder` 天然纳入，system/speed 的 rank=-1 末位序不扩）与「···」菜单（`ZU_BAR_TITLES` 提供格名，图标克隆活格，实时值原地同步）——零菜单代码改动。
- 精简模式（compact 主题）：条面隐藏，工具行新增 `.zu-sysm` chip（紧随 git chip 之后，`format:"auto"` 在此解析为 compact 面；thresholds 变色同样生效）；挂载复用 git/速率 chip 的「锚点→防双挂→nextElementSibling 判位→签名幂等→双 reapply→restore」模板，git 兜回判位容忍 sysmon 相邻（同 tps 先例）；Tooltip 走独立 body 级 `zusage-sysmon-tip`（复用 gitTip 链模式）。空间极端不足时保留 chip 本体（图标+值），不做第三行。
- pill 主题：格面按 compact face 渲染（pill 无窄宽状态机）。

## 设置页

- 排序卡自动出现「系统状态」行（barOrderSettingsHtml 数据驱动）：显示器图标（与条面同 path）、说明「实时监控本机 CPU、内存和磁盘资源」、显示开关、高/普通/低三段、↑↓、拖拽。
- 排序卡下方「系统状态配置」卡（v357 Grid 重构）：分组小节标题（监控指标/显示方式/采样频率/磁盘监控范围）+ 分隔线 + 阈值预警区。显示内容三开关（checkbox 显式 `order:0` 抵消通用 `order:2`，开关在文字前）、显示格式四选（短文案：自动适配（推荐）/完整/紧凑/极简，auto 的示例说明放帮助行）、刷新间隔两数字输入（56×28px 显式边框/背景，固定单位后缀「秒」，change 后回填 clamp 生效值）、磁盘目标两开关（项目卷/系统卷，注明可同开与去重）、颜色提示开关（阈值区标题行右侧）与阈值三列表（指标 | 预警阈值 | 危险阈值，固定「%」后缀）。
- 阈值关系校验（`sysThresholdIssues`）：CPU/内存 warn<crit、磁盘 warn>crit；非法候选**不写入不悄悄交换**——回填原生效值 + 行内红字（`.zu-syscfg-therr`）+ 输入框红边；LS 遗留非法组合初始即提示；syncPanel 同步后重算。
- 真实数据预览（`sysmonPreviewHtml` 共享函数，06 buildPanel 与 07 帧驱动同一产出）：跟随显示格式（auto 以 full 演示）、随指标开关联动、全关显空状态、无帧显「—」+「采集中」尾注，不用演示数字冒充；原地刷新不重建整卡（输入焦点保持）。
- 双回填：buildPanel 重建回填 + syncPanel 值回填；事件走 panel 级 change/click 委托新分支；`zusage3.sysmonCfg` 变更 → 定向持久化 + storage 广播 + `sysmonWantRecalc()` 重发订阅。

## 兼容与生命周期

- 旧用户：`zusage3.barOrder/barPriority` 缺 sysmon 时归一化补尾，已有相对顺序不动；`state.show.sysmon` 缺省关，开/关不删 cfg，重开恢复选择。
- 旧冷主进程（无 `__zusageSysmon` 注入）：帧不到达，格渲染 `--`（loading 态），无轮询无报错；热文件先行部署字段缺失是常态。
- 采样器缺席自愈（v358）：`sysmon-sub` 到达而 `sysmon-client.cjs` 未部署（运行目录缺文件）或热换未到时，回执 `ok:false` 但 want 仍记入 `sysmonSubs`，最近一次 want 请求的 cfg/projectPath 留档回放；热模块补上（热换重建实例）后按现存订阅自动采样补帧，格自愈，不依赖用户再开关或重开窗口。`hasProjectPath=false` 的请求不回放 projectPath（保留既有值），避免误清项目卷标注。
- 生命周期：采样器定时器只随订阅存在；窗口 destroyed 记账清理；插件热重载后渲染端重发订阅；`hot_reload:false`/旧 loader 回退重启生效（inject-main.cjs 与 sysmon-client.cjs 首次接线为冷变更）。
- 诊断：`FATAL.sysFrame = {t, has, want}` 原地更新；主进程不新增诊断文件。

## 验收

- VM 切片：cfg 归一化 clamp、severity 含等号边界、face 三格式×auto 档位映射、帧 handler 状态写入与 tick 触发、远端门控、stale 推导、字节格式化、排序卡行出现；采样器缺席时 `sysmon-sub` 记账 + `ok:false`、热换重建回放 cfg/projectPath、want=false 摘订阅（inject 切片）。
- 采样器单测（注入 os/fs 替身）：CPU 差分数学与 loading 首帧、三平台内存口径解析、磁盘枚举去重/上限/role 标注、订阅启停定时器、want=0 停采。
- 真实 Electron（speed-tooltip-host harness 加 SYS 链 + 真机 CDP）：排序卡截图、宽屏完整、中等宽度折叠（sysmon 高优先级存活）、极窄「···」菜单、预警红色态、精简模式 chip、完整 Tooltip、浅色主题、数据不可用态。
- 回归：既有排序/折叠/设置/菜单/font-fit/port-patches 测试全绿；`build_overlay --check`、`sync_plugin --check` 通过。
