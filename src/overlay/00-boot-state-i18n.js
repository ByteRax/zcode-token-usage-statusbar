/* ZCode token 用量状态条 v58（渲染进程注入，自包含 IIFE）。
 * 形态：输入框视觉卡片正下方的悬浮胶囊条 —— 给卡片加 margin-bottom 上移让位，
 *       条 fixed 悬浮在卡片边框外、窗口底边上的空带里，rAF 每帧跟随，
 *       左右两缘都与卡片对齐（宽=卡片实测宽；内容超宽先藏「本轮/会话累计」
 *       的缓存命中率，仍装不下右缘渐隐）。
 *       （条不能放在输入框中心点所在矩形内：命中检测自遮挡 = 周期性闪烁，v12-v14 实测。）
 * 视觉（v28）：半透明胶囊底 + 组间 │ 分隔 + 上下文微进度条（三档色）+ 子代理呼吸灯；
 *       条面只放主数值，明细进 hover title。
 * 视觉（v54 重写）：玻璃拟态胶囊（blur+内高光+分层投影）、发丝分隔线替代 │ 字符、
 *       条目悬浮底色提示可交互、行内 SVG 线性图标、tabular 数字、exc 呼吸闪烁、
 *       面板/tooltip/气泡统一圆角玻璃系；行为机制（tooltip 生命周期/遮挡豁免/面板互斥）零改动。
 * 主题（v58）：配色全量跟随客户端主题 —— 颜色一律 var(--color-*, 兜底值) 引用客户端语义
 *       变量（<html> 的 .dark 类翻转整套值，zai-light/zai-dark 特殊主题同样适配），
 *       MutationObserver 观察该类同步 .zu-light（仅剩阴影/光晕程度性差异）。
 * 字体（v64 定 mono；v315 起条/chip/tooltip 切 var(--font-sans, 旧硬编码栈兜底)，⚙ 设置
 *       域仍 mono）：字族/字号跟随客户端（macOS sans 解析为 SF Pro+苹方，mono 解析为
 *       SF Mono，均含中文回退）；字号一律
 *       var(--ui-font-size, 14px) 按应用 text-ui 档位加减偏移（设置页「界面字号」
 *       运行时写 <html> 内联 --ui-font-size，改动实时联动），不再硬编码 px。
 * 数据：主进程泵推 window.__zusageUpdate；显示项可在 ⚙ 面板配置（localStorage 持久化）。
 * 分屏（v61.1）：协调器每 600ms 扫描可见输入框，按 pane（data-pane-id）派发实例——
 *       一个 pane 一条，各自显示 composer 祖先链 data-session-id 指向的会话；
 *       各 pane 会话 id 汇总挂 window.__zusageWantSids 交泵强制拉取（旧泵忽略）。
 * 当前会话（v34）：泵按窗口注入 payload.mine（客户端渲染端经 IPC 向主进程上报的焦点会话 id，
 *       可为空串）；overlay 优先显示 mine 对应的池条目，池里还没有（新会话没数据）就显示
 *       零值 —— 绝不回退到"别的会话"的数字（多窗口共享 localStorage 时旧启发式必错，实测）。
 *       mine 缺失（辅助窗口/旧泵）才走 localStorage 键启发式 pickCurrent。
 * 热更新：主进程 mtime 检测 + new Function 语法校验后重注入；代际守卫防旧实例打架。
 * 原生按钮增强（v92）：输入框工具行的原生上下文按钮（chat-context-usage-trigger）
 *       环填充改状态条 cbar 同款（r9/描边3/圆帽/四档色/超限闪烁），百分比数值挂在
 *       trigger 按钮内（环右侧，悬停自动享受原生 hover 效果与「上下文容量」面板）——
 *       档位口径沿用原状态条上下文格的 ctxBandOf（v93 起该格已删，口径唯一承载处）；仅注入
 *       data-* 属性与末尾追加节点（React 不清理），React 数据更新重写 dasharray 由
 *       render/heavy 双 reapply 兜回；cw 缺失还原原生形态。
 * Git 状态 chip（v124）：挂在工具行左侧操作区，电脑操作关闭时仍保留位置；样式移植
 *       cc-pretty-statusline 的 git 段：⎇ 分支 ↑领先 ↓落后 (+插入行 -删除行 ?未跟踪文件)。
 *       数据由主进程旁路 git 查询按工作区路径推送（window.__zusageGitState），渲染端把各 pane
 *       的本地路径写 window.__zusageGitPaths 供主进程取并集；远端 pane / 非仓库 / 无 git 不挂载。
 * 诊断：异常与挂载信息写 window.__zusageDiag，由主进程泵取回写 diag-<n>.json。 */
(function () {
  if (window.__zusageOverlay) return;
  /* 代际守卫保底；正常热更新先主动释放上一代资源。 */
  if (window.__zusageDispose) window.__zusageDispose();
  window.__zusageOverlay = true;
  var disposed = false, coordinatorTimer = 0, bootTimer = 0;
  /* 只有远控接收端在注入前显式开启；帧内字段不能改变普通桌面的身份选择。 */
  var mobileMode = window.__zusageMobileMode === true, mobileBinding = "";
  var MY_GEN = (window.__zusageGen = (window.__zusageGen || 0) + 1);
  function stale() { return disposed || MY_GEN !== window.__zusageGen; }
  if (window.__zusageRateCleanup) window.__zusageRateCleanup();

  /* v291：代际号进 diag——重注入取证不再依赖偶发的计数字段归零（FATAL.gen 严格
   * 递增 = 新代际首帧实证，与 window.__zusageGen 同源；单例守卫下每代恰执行一次） */
  var FATAL = (window.__zusageDiag = { gen: MY_GEN });
  /* v349（issue #342，规则 18）：单拍成本测量——performance.now 单调且亚毫秒精度，缺位
   * （个别 eval 切片/旧夹具）回退 Date.now。仅规则 18 的回源退避与 tick 降频门使用。 */
  function perfMs() {
    return (typeof performance !== "undefined" && performance && typeof performance.now === "function") ? performance.now() : Date.now();
  }
  /* v179 子代理槽位定位诊断（随泵写 diag-*.json）：字段原地更新，对象挂模块级——
   * 多实例（分屏/辅助对话）各自身上都有 subRateTick，实例级声明会互相覆盖且
   * dispose 后残留冻结值（v180 review）；字段在最近一次 reconcile 的槽位分布，
   * acqFn=桥是否已提供 acquire 访问器（0=桥还是 v1，运行期估算必然缺席）。 */
  var SUBRATE_DIAG = FATAL.subRate = { want: 0, bound: 0, rate: 0, think: 0, calib: 0, noStore: 0, acqFn: 0, t: 0 };
  /* 多实例（v61.1）：热更新时泵只按 id 清 0 号条，其余实例的 DOM（条/tip/气泡/面板）
   * 在新代码启动时按类名统一自清；旧实例闭包靠 stale() 罢工。
   * 确定性历史行（[data-zusage-deterministic]，挂在消息流 turn 容器末尾）一并自清。
   * v80：面板（.zusage-panel）挂 body 不随条走，清理选择器单列。 */
  try {
    document.querySelectorAll(".zusage-root,.zusage-tip-root,.zusage-exc,.zusage-rate-tip,.zusage-quota-tip,.zu-quota,.zu-git,.zu-tsb,.zu-compact-btn,.zu-ac-info,.zu-ac-hint,.zu-compact-dlg,.zu-rot-pk-dlg,.zusage-git-tip,.zusage-panel,.zu-mp-host,.zu-mp-ov,[data-zusage-deterministic],[data-zusage-loading-status],.zu-more-panel,.zu-subrate,.zu-wfrun,.zu-substat,.zu-enhance,.zu-sysm,.zusage-sysmon-tip").forEach(function (el) { el.remove(); });
  } catch (e) { }

  try {
    document.querySelectorAll("[data-zu-pad],[data-zu-old-pad]").forEach(function (el) {
      el.style.paddingBottom = el.dataset.zuPad || el.dataset.zuOldPad || "";
      delete el.dataset.zuPad;
      delete el.dataset.zuOldPad;
    });
    document.querySelectorAll("[data-zu-cardpad]").forEach(function (el) {
      el.style.marginBottom = el.dataset.zuCardPad || "";
      delete el.dataset.zuCardPad;
    });
  } catch (e) { }

  /* ---------- 共享状态（多实例一致）：显示项/语言/上下文覆盖/最近一次数据 ---------- */
  var LS = { show: "zusage3.show", devKeepTip: "zusage3.devKeepTip", ctxOv: "zusage3.ctxOv", lang: "zusage3.lang", cnNum: "zusage3.cnNum", sec: "zusage3.sec", rstCdh: "zusage3.rstCdh", projPath: "zusage3.projPath", theme: "zusage3.theme", ctxEnh: "zusage3.ctxEnh", cmdkW: "zusage3.cmdkW", updSeen: "zusage3.updSeen", forceKmb: "zusage3.forceKmb", ctxCpt: "zusage3.ctxCpt", cost: "zusage3.cost", barJust: "zusage3.barJust", barOrder: "zusage3.barOrder", barPriority: "zusage3.barPriority", autoCompact: "zusage3.autoCompact", tipClick: "zusage3.tipClick", quotaRemain: "zusage3.quotaRemain", sysmonCfg: "zusage3.sysmonCfg" };
  /* 状态条排序与优先级只作用于条面八个项目，不改变工具行 Git/额度等宿主按钮。 */
  var ZU_BAR_KEYS = ["speed", "turn", "win", "today", "proj", "tools", "sub", "sysmon"];
  /* 缺省优先级按「状态栏显示升级」设计稿：速度/本轮=高、会话/今日/项目=普通、工具/子代理=低。
   * 只影响未持久化用户；已写入 zusage3.barPriority 的存量值经 zuBarPriorityNormalize 原样保留。
   * sysmon（v356，issue #338）缺省低：系统状态默认关闭（state.show.sysmon=0），老用户排序
   * 经 zuBarOrderNormalize 自动补尾，打开后才按用户自己的优先级参与折叠竞争。 */
  var ZU_BAR_PRIORITY_DEFAULT = {
    speed: "high", turn: "high", win: "normal", today: "normal",
    proj: "normal", tools: "low", sub: "low", sysmon: "low"
  };
  /* 格名双语表：设置页排序卡与「···」折叠菜单共用同一事实源（键序即缺省显示序，v213 契约）。 */
  var ZU_BAR_TITLES = {
    speed: ["生成速度", "Generation speed"], turn: ["本轮", "Current turn"],
    win: ["会话累计", "Session total"], today: ["今日合计", "Today's total"],
    proj: ["项目累计", "Project total"], tools: ["工具调用", "Tool calls"],
    sub: ["子代理", "Sub-agents"], sysmon: ["系统状态", "System status"]
  };
  function zuBarOrderNormalize(raw) {
    var seen = Object.create(null), result = [];
    if (Array.isArray(raw)) raw.forEach(function (key) {
      if (ZU_BAR_KEYS.indexOf(key) >= 0 && !seen[key]) { seen[key] = true; result.push(key); }
    });
    ZU_BAR_KEYS.forEach(function (key) { if (!seen[key]) result.push(key); });
    return result;
  }
  function zuBarPriorityNormalize(raw) {
    var value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    var result = {};
    ZU_BAR_KEYS.forEach(function (key) {
      var v = value[key];
      result[key] = v === "high" || v === "normal" || v === "low" ? v : ZU_BAR_PRIORITY_DEFAULT[key];
    });
    return result;
  }
  function zuBarSortItems(rows, order) {
    var rank = Object.create(null);
    (order || ZU_BAR_KEYS).forEach(function (key, i) { rank[key] = i; });
    return rows.slice().sort(function (a, b) {
      var fixedA = ZU_BAR_KEYS.indexOf(a.key) < 0, fixedB = ZU_BAR_KEYS.indexOf(b.key) < 0;
      if (fixedA !== fixedB) return fixedA ? -1 : 1;
      if (fixedA) return a.index - b.index;
      return (rank[a.key] === undefined ? 999 : rank[a.key]) -
        (rank[b.key] === undefined ? 999 : rank[b.key]);
    });
  }
  /* 折叠顺序（纯函数，供 VM 测试）：低优先先收、同级按显示序靠右先收；system（远端/未归属
   * 徽标）与 speed（设计稿「固定」语义：有有效数据时优先保留，不是伪造 0）rank=-1 排为
   * 最后候选——极端挤压、普通候选收尽仍溢出时照样折叠，并非豁免。 */
  function zuBarFoldOrder(keys, priorities) {
    var ranks = { low: 2, normal: 1, high: 0 }, p = priorities || {};
    return keys.map(function (key, i) {
      var rank = (key === "system" || key === "speed") ? -1 :
        (ranks[p[key]] === undefined ? 1 : ranks[p[key]]);
      return { key: key, i: i, rank: rank };
    }).sort(function (a, b) { return b.rank - a.rank || b.i - a.i; });
  }

  /* ---------- v356 系统状态（issue #338 / specs/statusbar-system-status.md）：纯展示层。
   * 数据链=主进程 sysmon-client.cjs 采样 → __zusageSysmon 帧 → sysFrame 共享帧；本段只做
   * 配置归一、阈值判定、格式化与 chip 面/排序注册。阈值边界含等号（CPU/内存 ≥warn、
   * 磁盘可用 ≤warn），与主进程 sysmon-client.normalizeSysmonConfig 语义对齐。 */
  var SYSMON_ICONS = {
    monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M9 21h6m-3-4v4"/>',
    warn: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 9.8v4.7m0 3h.01"/>',
    /* v369 Tooltip 指标行图标（lucide 同款 path，stroke 1.8 currentColor，容器见 .zu-sys-mico） */
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>' +
      '<path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
    mem: '<path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"/><path d="M2 15h20"/>' +
      '<path d="M6 18v2m4-2v2m4-2v2m4-2v2"/><path d="M7 11V9m5 2V9m5 2V9"/>',
    db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>'
  };
  /* 指标行图标 SVG（v369）：统一属性模板，纯装饰。 */
  function sysMicoSvg(icon) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icon + "</svg>";
  }
  var sysFrame = null;   // 最近一帧系统资源数据（__zusageSysmon 写入，格面/tooltip/菜单共享）
  /* 防抖快照（review M2）：sysSeveritySmoothed 的计数按「采样拍」推进而非按「调用」——
   * 帧入口每帧只推一次并落地快照；face/tip 等多次消费只读快照（缺快照回退瞬时判定不推进），
   * 否则每拍 ≥2 次消费会让「连续 2 拍确认」退化成 1 拍即亮。 */
  var sysSevSnapshot = null;
  function normalizeSysmonCfg(raw) {
    var c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    function bool(v, dflt) { return v === 0 || v === false ? false : v === 1 || v === true ? true : dflt; }
    function clamp(v, lo, hi, dflt) {
      var n = Math.floor(Number(v));
      return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    }
    var th = c.thresholds && typeof c.thresholds === "object" && !Array.isArray(c.thresholds) ? c.thresholds : {};
    return {
      metrics: {
        cpu: bool(c.metrics && c.metrics.cpu, true),
        mem: bool(c.metrics && c.metrics.mem, true),
        disk: bool(c.metrics && c.metrics.disk, true)
      },
      format: ["auto", "full", "compact", "minimal"].indexOf(c.format) >= 0 ? c.format : "auto",
      intervalMs: clamp(c.intervalMs, 2000, 60000, 5000),
      diskIntervalMs: clamp(c.diskIntervalMs, 30000, 600000, 60000),
      warnColors: bool(c.warnColors, true),
      projectVol: bool(c.projectVol, true),
      systemVol: bool(c.systemVol, true),
      thresholds: {
        cpuWarn: clamp(th.cpuWarn, 1, 100, 80), cpuCrit: clamp(th.cpuCrit, 1, 100, 90),
        memWarn: clamp(th.memWarn, 1, 100, 85), memCrit: clamp(th.memCrit, 1, 100, 90),
        diskFreeWarn: clamp(th.diskFreeWarn, 0, 100, 15), diskFreeCrit: clamp(th.diskFreeCrit, 0, 100, 10)
      }
    };
  }
  function loadSysmonCfg() { try { return normalizeSysmonCfg(JSON.parse(ls(LS.sysmonCfg, "null"))); } catch (e) { return normalizeSysmonCfg(null); } }
  function persistSysmonCfg() { lsSet(LS.sysmonCfg, JSON.stringify(state.sysmonCfg)); }
  /* 主卷挑选：项目卷优先（DISK 值=其可用空间），退系统卷、其余卷、首卷。 */
  function sysVolPick(vols) {
    if (!Array.isArray(vols)) return null;
    var proj = null, sys = null, other = null;
    for (var i = 0; i < vols.length; i++) {
      var v = vols[i];
      if (!v || typeof v !== "object") continue;
      if (v.role === "project" && !proj) proj = v;
      else if (v.role === "system" && !sys) sys = v;
      else if (v.role === "other" && !other) other = v;
    }
    return proj || sys || other || (vols[0] && typeof vols[0] === "object" ? vols[0] : null);
  }
  /* 阈值判定（纯函数，VM 测试锁含等号边界）：error/stale/disabled 不参与综合（不冒充正常也不冒充危险）。 */
  function sysSeverityOf(cfg, frame) {
    var th = cfg.thresholds, out = { cpu: "normal", mem: "normal", disk: "normal" };
    var rank = { normal: 0, warning: 1, critical: 2 };
    if (cfg.metrics.cpu && frame && frame.cpu && frame.cpu.state === "ok" && typeof frame.cpu.pct === "number") {
      out.cpu = frame.cpu.pct >= th.cpuCrit ? "critical" : frame.cpu.pct >= th.cpuWarn ? "warning" : "normal";
    }
    if (cfg.metrics.mem && frame && frame.mem && frame.mem.state === "ok" && typeof frame.mem.pct === "number") {
      out.mem = frame.mem.pct >= th.memCrit ? "critical" : frame.mem.pct >= th.memWarn ? "warning" : "normal";
    }
    if (cfg.metrics.disk && frame && frame.disk && frame.disk.state === "ok" && Array.isArray(frame.disk.vols)) {
      var vol = sysVolPick(frame.disk.vols);
      if (vol && typeof vol.free_pct === "number") {
        out.disk = vol.free_pct <= th.diskFreeCrit ? "critical" : vol.free_pct <= th.diskFreeWarn ? "warning" : "normal";
      }
    }
    out.overall = (rank[out.cpu] >= rank[out.mem] && rank[out.cpu] >= rank[out.disk]) ? out.cpu :
      (rank[out.mem] >= rank[out.disk] ? out.mem : out.disk);
    return out;
  }
  /* 防抖（spec §7.3）：预警需连续 2 拍确认才亮（CPU 短抖不闪黄），危险立即生效不被防抖掩盖，
   * 回落 1 拍即还原。计数器是模块级共享状态（原地更新，多实例同帧同判定）。 */
  var SYS_LEVEL_RANK = { normal: 0, warning: 1, critical: 2 };
  var sysLevelState = {};
  function sysSeveritySmoothed(cfg, frame) {
    var sev = sysSeverityOf(cfg, frame), out = { cpu: "normal", mem: "normal", disk: "normal" };
    ["cpu", "mem", "disk"].forEach(function (k) {
      var s = sysLevelState[k] || (sysLevelState[k] = { level: "normal", hits: 0 });
      var target = sev[k];
      if (SYS_LEVEL_RANK[target] > SYS_LEVEL_RANK[s.level]) {
        s.hits++;
        if (target === "critical" || s.hits >= 2) { s.level = target; s.hits = 0; }
      } else if (target !== s.level) { s.level = target; s.hits = 0; }
      else s.hits = 0;
      out[k] = s.level;
    });
    out.overall = (SYS_LEVEL_RANK[out.cpu] >= SYS_LEVEL_RANK[out.mem] && SYS_LEVEL_RANK[out.cpu] >= SYS_LEVEL_RANK[out.disk])
      ? out.cpu : (SYS_LEVEL_RANK[out.mem] >= SYS_LEVEL_RANK[out.disk] ? out.mem : out.disk);
    return out;
  }
  /* 数据过期：want 摘除（采样暂停）后旧帧保留展示但标灰；阈值取两侧间隔的较保守者。 */
  function sysIsStale(frame, cfg, now) {
    if (!frame || typeof frame.ts !== "number") return true;
    var maxAge = Math.max(3 * Math.max(cfg.intervalMs, cfg.diskIntervalMs), 20000);
    return (now || Date.now()) - frame.ts > maxAge;
  }
  function sysFmtBytes(b) {
    if (typeof b !== "number" || !isFinite(b) || b < 0) return "";
    var tb = 1024 * 1024 * 1024 * 1024, gb = 1024 * 1024 * 1024, mb = 1024 * 1024;
    function t1(n) { return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10); }
    if (b >= tb) return t1(b / tb) + "T";
    if (b >= gb) return t1(b / gb) + "G";
    if (b >= mb) return t1(b / mb) + "M";
    return Math.max(0, Math.round(b / 1024)) + "K";
  }
  /* chip 面（纯函数，html() 与原地刷新共用同一产出）：format 解析由调用方完成
   * （auto→窄宽档位映射在 07/11 接线层），本函数只认 full/compact/minimal。 */
  function sysmonFaceHtml(cfg, frame, format, now) {
    format = ["full", "compact", "minimal"].indexOf(format) >= 0 ? format : "full";
    var m = cfg.metrics;
    var nOn = (m.cpu ? 1 : 0) + (m.mem ? 1 : 0) + (m.disk ? 1 : 0);
    if (!nOn) return "";
    var sev = (sysSevSnapshot && frame === sysFrame) ? sysSevSnapshot : sysSeverityOf(cfg, frame);   // 快照缺失/异帧（预览、测试）回退瞬时判定，不推进防抖计数
    var stale = sysIsStale(frame, cfg, now);
    var loadCls = stale ? " zu-sys-stale" : "";
    function sevCls(key) {
      if (!cfg.warnColors || sev[key] === "normal") return "";
      return " zu-sys-" + (sev[key] === "critical" ? "crit" : "warn");
    }
    var iconPath = (cfg.warnColors && (sev.overall === "critical" || sev.overall === "warning")) ? SYSMON_ICONS.warn : SYSMON_ICONS.monitor;
    var html = '<svg class="ico zu-sys-ico' + (cfg.warnColors && sev.overall !== "normal" ? " zu-sys-" + (sev.overall === "critical" ? "crit" : "warn") : "") +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + iconPath + "</svg>";
    var segs = [];
    function seg(label, value, key) {
      var hideLabel = format === "minimal" && nOn > 1;
      /* 值/标签挂 .v/.dim 基础类继承 .it 既有样式；zu-sys-* 只承载结构布局与预警色 */
      return '<span class="zu-sys-seg' + loadCls + '"><span class="dim zu-sys-k"' + (hideLabel ? ' hidden' : '') + ">" + label +
        '</span><span class="v zu-sys-v' + sevCls(key) + '">' + value + "</span></span>";
    }
    if (m.cpu) {
      var cpu = frame && frame.cpu;
      segs.push(seg("CPU", cpu && cpu.state === "ok" && typeof cpu.pct === "number" ? Math.round(cpu.pct) + "%" : "—", "cpu"));
    }
    if (m.mem) {
      var mem = frame && frame.mem, memV = "—";
      if (mem && mem.state === "ok" && typeof mem.used === "number" && typeof mem.total === "number" && mem.total > 0) {
        memV = format === "full" ? sysFmtBytes(mem.used) + "/" + sysFmtBytes(mem.total) : Math.round(mem.pct) + "%";
      }
      segs.push(seg("MEM", memV, "mem"));
    }
    if (m.disk) {
      var vol = frame && frame.disk && frame.disk.state === "ok" ? sysVolPick(frame.disk.vols) : null;
      segs.push(seg("DISK", vol && typeof vol.avail === "number" && vol.avail >= 0 ? sysFmtBytes(vol.avail) : "—", "disk"));
    }
    return html + segs.join('<span class="zu-sys-sep" aria-hidden="true">|</span>');
  }
  /* 设置卡真实预览（v362，06 buildPanel 与 07 sysmonApplyFace 共用同一产出）：
   * 面跟随显示格式（auto 以 full 演示），全关显空状态，无帧显「采集中」尾注——
   * 不用演示数字冒充（spec §设置页）。 */
  function sysmonPreviewHtml(cfg, frame, now) {
    var nOn = (cfg.metrics.cpu ? 1 : 0) + (cfg.metrics.mem ? 1 : 0) + (cfg.metrics.disk ? 1 : 0);
    if (!nOn) return '<span class="zu-sys-dim">' + L("全部指标已关闭", "All metrics off") + "</span>";
    var face = sysmonFaceHtml(cfg, frame, cfg.format === "auto" ? "full" : cfg.format, now);
    if (!frame) face += '<span class="zu-sys-dim">' + L(" · 采集中…", " · sampling…") + "</span>";
    return face;
  }
  /* 订阅意愿（渲染端 → 主进程 pluginRequest sysmon-sub）：格可见/格 tooltip/设置页/精简 chip
   * 任一成立即 want；签名（want|cfg|projectPath）不变不重发。api.sysmonInterested 由 12 分片
   * 逐实例上报（含本机 projectPath，供主进程定位项目卷）。 */
  var sysmonSubSent = "";
  function sysSevCls(key, sev, cfg) {
    if (!cfg.warnColors || !sev || sev[key] === "normal") return "";
    return " zu-sys-" + (sev[key] === "critical" ? "crit" : "warn");
  }
  /* 完整资源 Tooltip（模块级：条面格通用链与精简 chip 的 body 级浮层共用同一产出；
   * 本地 esc 与 07 分片 ttEsc 同式——07 在实例闭包内，模块级不可达，buildLiveTip 内联
   * escHtml 同款先例）。v362 紧凑重构：三区改「标签列 | 主数值 | 右侧辅助」Grid，磁盘区
   * 去重复挂载点行（主卷角色并入区头右侧），APFS 共享容器卷不重复容量（同容器首行带
   * 徽记、后续行显「共享容器空间」），阈值明细从图例行（冗长全文）收进 ⓘ 展开，
   * 刷新说明换时钟图标（纯说明非按钮）。样式随内容内联 <style>（统计卡 statCompactStyle
   * 同款模式），选择器全部 zu-sys-* 前缀不污染共享 .tip/.rt-* 规则。 */
  var SYS_TIP_CSS = "<style>" +
    ".zu-sys-tip{width:440px;max-width:calc(100vw - 24px);box-sizing:border-box;font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:calc(var(--ui-font-size, 14px) - 1px);line-height:1.5}" +
    ".zu-sys-head{display:flex;align-items:center;gap:7px}" +
    ".zu-sys-head>svg{width:16px;height:16px;flex:0 0 auto}" +
    ".zu-sys-head b{font-size:calc(var(--ui-font-size, 14px) + 2px)}" +
    ".zu-sys-local{font-style:normal;color:var(--color-foreground-subtle,#a1a1a1);border:1px solid var(--color-border,rgba(255,255,255,.12));border-radius:4px;font-size:calc(var(--ui-font-size, 14px) - 4px);line-height:15px;padding:0 5px}" +
    ".zu-sys-refresh{margin-left:auto;display:inline-flex;align-items:center;gap:4px;color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size, 14px) - 3px);white-space:nowrap;font-variant-numeric:tabular-nums}" +
    ".zu-sys-refresh svg{width:11px;height:11px}" +
    ".zu-sys-sec{padding:8px 0 7px;border-top:1px solid var(--color-border,rgba(255,255,255,.08))}" +
    /* v369 指标行图标区：[图标容器][标签] 跨主数值/sub 两行居中，主数值列左缘竖分隔线 */
    ".zu-sys-grid{display:grid;grid-template-columns:auto minmax(0,1fr) auto;column-gap:12px;align-items:baseline}" +
    ".zu-sys-lead{grid-row:1/3;align-self:center;display:flex;align-items:center;gap:8px}" +
    ".zu-sys-mico{width:28px;height:28px;border-radius:7px;background:color-mix(in srgb, var(--color-foreground,#fff) 6%, transparent);display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;color:var(--color-foreground-subtle,#a1a1a1)}" +
    ".zu-sys-mico svg{width:15px;height:15px}" +
    /* .zu-sys-k 是格面 seg() 共享类（基础 -2px 不动条面），Tooltip 内 13px 走作用域覆写 */
    ".zu-sys-k{color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size, 14px) - 2px);white-space:nowrap}" +
    ".zu-sys-tip .zu-sys-k{font-size:calc(var(--ui-font-size, 14px) - 1px)}" +
    ".zu-sys-val{min-width:0;border-left:1px solid var(--color-border,rgba(255,255,255,.12));padding-left:12px}" +
    ".zu-sys-big{font-size:calc(var(--ui-font-size, 14px) + 4px);font-weight:600;font-variant-numeric:tabular-nums}" +
    ".zu-sys-dim{color:var(--color-foreground-subtle,#a1a1a1);font-style:normal}" +
    ".zu-sys-side{color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size, 14px) - 1px);font-variant-numeric:tabular-nums;justify-self:end}" +
    ".zu-sys-sub{grid-column:2/-1;border-left:1px solid var(--color-border,rgba(255,255,255,.12));padding-left:12px;padding-top:3px;color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size, 14px) - 2px);font-variant-numeric:tabular-nums}" +
    ".zu-sys-sub b{color:var(--color-foreground,#fff);font-weight:600}" +
    ".zu-sys-dhead{display:flex;align-items:center;justify-content:space-between;gap:10px}" +
    ".zu-sys-dhead>.zu-sys-dim{flex:1 1 auto}" +   // 非 ok 态说明文字左对齐（space-between 会把「采集中…」推到最右）
    ".zu-sys-dcur{color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size, 14px) - 2px)}" +
    ".zu-sys-vols{margin-top:5px;max-height:176px;overflow-y:auto;font-variant-numeric:tabular-nums;border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:8px;padding:3px}" +
    ".zu-sys-vr{display:grid;grid-template-columns:minmax(0,1fr) 52px 52px 56px;gap:6px;padding:3px 6px;border-radius:5px;font-size:calc(var(--ui-font-size, 14px) - 2px);align-items:baseline}" +
    ".zu-sys-vr>span:not(:first-child){text-align:right}" +
    ".zu-sys-vh{color:var(--color-foreground-subtle,#a1a1a1);border-bottom:1px solid var(--color-border,rgba(255,255,255,.08));border-radius:0;padding-bottom:4px;margin-bottom:4px}" +
    ".zu-sys-vrowon{background:color-mix(in srgb, var(--color-brand,#57c8ff) 8%, transparent)}" +
    ".zu-sys-vname{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".zu-sys-vmount{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size, 14px) - 3px)}" +
    ".zu-sys-vbadge{display:inline-block;font-style:normal;color:var(--color-foreground-subtle,#a1a1a1);border:1px solid var(--color-border,rgba(255,255,255,.12));border-radius:4px;font-size:calc(var(--ui-font-size, 14px) - 4px);line-height:14px;padding:0 4px;margin-left:4px;vertical-align:1px;white-space:nowrap}" +
    ".zu-sys-vshare{grid-column:2/-1;text-align:right;color:var(--color-foreground-subtle,#a1a1a1)}" +
    ".zu-sys-legend{display:flex;flex-wrap:wrap;align-items:center;gap:3px 12px;padding-top:8px;border-top:1px solid var(--color-border,rgba(255,255,255,.08));font-size:calc(var(--ui-font-size, 14px) - 2px);color:var(--color-foreground-subtle,#a1a1a1)}" +
    ".zu-sys-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:#3fb950}" +
    ".zu-sys-dot-w{background:#d29922}.zu-sys-dot-c{background:#f85149}" +
    ".zu-sys-legend.nocolor .zu-sys-dot{background:var(--color-foreground-subtle,#a1a1a1)}" +
    ".zu-sys-lg-on{color:var(--color-foreground,#fff)}" +
    ".zu-sys-lg-off{font-size:calc(var(--ui-font-size, 14px) - 3px)}" +
    ".zu-sys-thbtn{margin-left:auto;display:inline-flex;align-items:center;gap:3px;background:none;border:0;color:var(--color-foreground-subtle,#a1a1a1);font-family:inherit;font-size:calc(var(--ui-font-size, 14px) - 2px);cursor:pointer;padding:1px 4px;border-radius:4px}" +
    ".zu-sys-thbtn:hover{color:var(--color-foreground,#fff);background:var(--color-hover,rgba(255,255,255,.07))}" +
    ".zu-sys-thbtn:focus-visible{outline:2px solid var(--color-input-border-focused,var(--color-brand,#57c8ff));outline-offset:1px}" +
    ".zu-sys-thbtn svg{width:11px;height:11px}" +
    ".zu-sys-thexp{margin-top:7px;padding:7px 10px 8px;border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:7px;font-variant-numeric:tabular-nums}" +
    /* v369 阈值表按行分容器：表头行带底线；右对齐只作用数值列（旧扁平 grid 的
     * :not(:first-child) 会把数据行的指标名也右对齐） */
    ".zu-sys-tht{font-size:calc(var(--ui-font-size, 14px) - 2px)}" +
    ".zu-sys-tht-h,.zu-sys-tht-r{display:grid;grid-template-columns:minmax(0,1fr) 56px 56px;column-gap:12px;align-items:baseline}" +
    ".zu-sys-tht-h{color:var(--color-foreground-subtle,#a1a1a1);border-bottom:1px solid var(--color-border,rgba(255,255,255,.08));padding-bottom:4px}" +
    ".zu-sys-tht-h>span:not(:first-child){text-align:right}" +
    ".zu-sys-tht-r{padding:3px 0}" +
    ".zu-sys-tht-r>span:not(:first-child){text-align:right}" +
    ".zu-sys-thbad{color:#f85149;font-weight:600}" +
    ".zu-sys-thnote{margin-top:5px;color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size, 14px) - 3px)}" +
    ".zu-sys-tip .zu-sys-big.zu-sys-warn{color:#d29922}" +
    ".zu-sys-tip .zu-sys-big.zu-sys-crit{color:#f85149}" +
    ".zu-sys-note{margin-top:7px;font-size:calc(var(--ui-font-size, 14px) - 2px);color:#d29922}" +
    /* 悬停解释气泡（v364）：纯 CSS :hover，零事件链（不碰全量 tip click/mousedown 委托）；
     * 宿主 .tip 容器 overflow:auto，气泡向下弹留在内容区内、不触发滚动区域；帧重建后 :hover 实时重算，气泡不丢。 */
    ".zu-sys-hint{position:relative;cursor:help;border-bottom:1px dotted var(--color-border,rgba(255,255,255,.3))}" +
    ".zu-sys-hint:hover{border-bottom-color:transparent}" +
    ".zu-sys-hintpop{display:none;position:absolute;left:0;top:calc(100% + 7px);z-index:2;width:300px;white-space:normal;padding:7px 9px;border:1px solid var(--color-popover-border,var(--color-border,rgba(255,255,255,.12)));border-radius:7px;background:var(--color-tooltip,#171717);box-shadow:0 6px 18px rgba(0,0,0,.45);font-size:calc(var(--ui-font-size, 14px) - 3px);line-height:1.5;color:var(--color-foreground-subtle,#b8b8b8);cursor:default;font-weight:400}" +
    ".zu-sys-hint:hover .zu-sys-hintpop{display:block}" +
    "</style>";
  /* 阈值关系校验（v362，06 设置卡初始提示与 09 change 校验共用同一判定）：
   * CPU/内存 warn<crit、磁盘 warn>crit；返回问题文案数组（空=合法）。 */
  function sysThresholdIssues(cfg) {
    var th = cfg.thresholds, out = [];
    if (th.cpuWarn >= th.cpuCrit) out.push(L("CPU：预警阈值需小于危险阈值", "CPU: warn threshold must be below crit"));
    if (th.memWarn >= th.memCrit) out.push(L("内存：预警阈值需小于危险阈值", "Memory: warn threshold must be below crit"));
    if (th.diskFreeWarn <= th.diskFreeCrit) out.push(L("磁盘可用率：预警阈值需大于危险阈值", "Disk free: warn threshold must be above crit"));
    return out;
  }
  /* 阈值明细表（ⓘ 展开区内容；阈值动态读取 cfg，不写死示例值）。关系非法的阈值
   * 标红提示（CPU/内存 warn<crit、磁盘 warn>crit），不改写配置——展示层反馈。
   * v369 按行分容器：表头行带底线（.zu-sys-tht-h），数据行指标名左对齐、数值列右对齐。 */
  function sysThresholdTableHtml(cfg) {
    var th = cfg.thresholds;
    function row(name, wk, ck, needLt) {
      var bad = needLt ? th[wk] >= th[ck] : th[wk] <= th[ck];
      var op = needLt ? "≥" : "≤";
      return '<div class="zu-sys-tht-r" role="row"><span role="rowheader">' + name + "</span>" +
        '<span role="cell"' + (bad ? ' class="zu-sys-thbad"' : "") + ">" + op + th[wk] + "%</span>" +
        '<span role="cell"' + (bad ? ' class="zu-sys-thbad"' : "") + ">" + op + th[ck] + "%</span></div>";
    }
    return '<div class="zu-sys-tht" role="table">' +
      '<div class="zu-sys-tht-h" role="row">' +
      '<span role="columnheader">' + L("指标", "Metric") + '</span>' +
      '<span role="columnheader">' + L("预警", "Warn") + '</span>' +
      '<span role="columnheader">' + L("危险", "Crit") + "</span></div>" +
      row("CPU", "cpuWarn", "cpuCrit", true) +
      row(L("内存", "Memory"), "memWarn", "memCrit", true) +
      row(L("磁盘可用", "Disk free"), "diskFreeWarn", "diskFreeCrit", false) +
      '</div><div class="zu-sys-thnote">' +
      L("CPU/内存按使用率（达到即触发），磁盘按可用空间占比。", "CPU/memory by usage (at or above), disk by free-space ratio.") +
      (cfg.warnColors ? "" : L("颜色提示已关闭：达到阈值不再变色。", "Color hints are off: no color change at thresholds.")) +
      "</div>";
  }
  function sysmonTipHtml(cfg, frame, now) {
    function sEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function sAttr(s) { return sEsc(s).replace(/"/g, "&quot;"); }
    var sev = (sysSevSnapshot && frame === sysFrame) ? sysSevSnapshot : sysSeverityOf(cfg, frame);   // 同 face：只读防抖快照
    var stale = sysIsStale(frame, cfg, now);
    var refreshTitle = L("CPU/内存每 ", "CPU/mem every ") + Math.round(cfg.intervalMs / 1000) + "s · " +
      L("磁盘每 ", "disk every ") + Math.round(cfg.diskIntervalMs / 1000) + "s";
    var s = SYS_TIP_CSS + '<div class="zu-sys-tip">' +
      '<div class="zu-sys-head">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + SYSMON_ICONS.monitor + "</svg>" +
      "<b>" + L("系统状态", "System status") + "</b>" +
      '<i class="zu-sys-local">' + L("本机", "Local") + "</i>" +
      '<span class="zu-sys-refresh" title="' + sAttr(refreshTitle) + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>' +
      Math.round(cfg.intervalMs / 1000) + "s · " + Math.round(cfg.diskIntervalMs / 1000) + "s</span></div>";
    function secNote(st) {
      if (!st) return L("采集中…", "sampling…");
      if (st.state === "loading") return L("采集中…", "sampling…");
      if (st.state === "error") return L("采集失败", "sampling failed") + (st.err ? "（" + sEsc(String(st.err).slice(0, 80)) + "）" : "");
      if (st.state === "unavailable") return L("本平台不支持", "unavailable on this platform");
      return "";
    }
    /* Load 恒两位小数（1.90 / 2.09 / 2.34），位数统一避免列宽跳动；无效值显 —。 */
    function f2(n) { return typeof n === "number" && isFinite(n) ? n.toFixed(2) : "—"; }
    if (cfg.metrics.cpu) {
      var cpu = frame && frame.cpu, cpuVal, cpuSide = "", cpuSub = "";
      if (cpu && cpu.state === "ok" && typeof cpu.pct === "number") {
        cpuVal = '<b class="zu-sys-big' + sysSevCls("cpu", sev, cfg) + '">' + Math.round(cpu.pct) + "%</b>";
        cpuSide = (cpu.cores || "—") + L(" 核", " cores");
        if (Array.isArray(cpu.load)) cpuSub = '<span class="zu-sys-hint">Load 1m/5m/15m <b>' + cpu.load.map(f2).join(" / ") + "</b>" +
          '<span class="zu-sys-hintpop">' + L("过去 1/5/15 分钟的平均负载：正在运行加等待 CPU（含不可中断 I/O）的任务数。低于 CPU 核心数为舒适，持续高于核心数说明算力吃紧。", "Running plus waiting-for-CPU tasks (incl. uninterruptible I/O), averaged over 1/5/15 min. Below the core count is comfortable; consistently above it means CPU-starved.") + "</span></span>";
      } else cpuVal = '<span class="zu-sys-dim">' + secNote(cpu) + "</span>";
      s += '<div class="zu-sys-sec zu-sys-grid">' +
        '<span class="zu-sys-lead"><span class="zu-sys-mico">' + sysMicoSvg(SYSMON_ICONS.cpu) + '</span><span class="zu-sys-k">CPU</span></span>' +
        '<span class="zu-sys-val">' + cpuVal + "</span>" +
        (cpuSide ? '<span class="zu-sys-side">' + cpuSide + "</span>" : "") +
        (cpuSub ? '<span class="zu-sys-sub">' + cpuSub + "</span>" : "") + "</div>";
    }
    if (cfg.metrics.mem) {
      var mem = frame && frame.mem, memVal, memSide = "", memSub = "";
      if (mem && mem.state === "ok" && typeof mem.used === "number" && typeof mem.total === "number" && mem.total > 0) {
        memVal = '<b class="zu-sys-big' + sysSevCls("mem", sev, cfg) + '">' + sysFmtBytes(mem.used) + '</b> <span class="zu-sys-dim">/ ' + sysFmtBytes(mem.total) + "</span>";
        memSide = Math.round(mem.pct) + "%";
        var sub = [];
        if (typeof mem.wired === "number" && mem.wired > 0) sub.push('<span class="zu-sys-hint">Wired ' + sysFmtBytes(mem.wired) +
          '<span class="zu-sys-hintpop">' + L("固定驻留在物理内存、不可换出到磁盘的部分（内核与关键数据结构）。", "Memory pinned in physical RAM that can never be swapped out (kernel and critical data).") + "</span></span>");
        if (typeof mem.swap_used === "number" && mem.swap_used >= 0) {
          sub.push('<span class="zu-sys-hint">Swap ' + sysFmtBytes(mem.swap_used) + (typeof mem.swap_total === "number" && mem.swap_total > 0 ? " / " + sysFmtBytes(mem.swap_total) : "") +
            '<span class="zu-sys-hintpop">' + L("物理内存不足时换出到磁盘的部分；0 表示尚未使用。", "Memory spilled to disk when RAM runs short; 0 means none is in use.") + "</span></span>");
        }
        if (sub.length) memSub = sub.join('<span class="zu-sys-dim"> · </span>');
      } else memVal = '<span class="zu-sys-dim">' + secNote(mem) + "</span>";
      s += '<div class="zu-sys-sec zu-sys-grid">' +
        '<span class="zu-sys-lead"><span class="zu-sys-mico">' + sysMicoSvg(SYSMON_ICONS.mem) + '</span><span class="zu-sys-k">' + L("内存", "Memory") + "</span></span>" +
        '<span class="zu-sys-val">' + memVal + "</span>" +
        (memSide ? '<span class="zu-sys-side">' + memSide + "</span>" : "") +
        (memSub ? '<span class="zu-sys-sub">' + memSub + "</span>" : "") + "</div>";
    }
    if (cfg.metrics.disk) {
      var disk = frame && frame.disk;
      s += '<div class="zu-sys-sec"><div class="zu-sys-dhead"><span class="zu-sys-lead"><span class="zu-sys-mico">' +
        sysMicoSvg(SYSMON_ICONS.db) + '</span><span class="zu-sys-k">' + L("磁盘", "Disk") + "</span></span>";
      if (disk && disk.state === "ok" && Array.isArray(disk.vols) && disk.vols.length) {
        var cur = sysVolPick(disk.vols);
        var curRole = cur ? (cur.role === "project" ? L("项目卷", "Project") : cur.role === "system" ? L("系统卷", "System") : L("卷", "Volume")) : "—";
        s += '<span class="zu-sys-dcur">' + L("当前：", "current: ") + sEsc(curRole) + "</span></div>";
        s += '<div class="zu-sys-vols" role="table"><div class="zu-sys-vr zu-sys-vh" role="row">' +
          '<span role="columnheader">' + L("卷", "Volume") + "</span>" +
          '<span role="columnheader">' + L("总量", "Total") + "</span>" +
          '<span role="columnheader">' + L("已用", "Used") + "</span>" +
          '<span role="columnheader">' + L("可用", "Free") + "</span></div>";
        var seenC = {};
        disk.vols.forEach(function (v) {
          if (!v || typeof v !== "object") return;
          var isCur = cur && v === cur;
          var role = v.role === "project" ? L("项目卷", "Project") : v.role === "system" ? L("系统卷", "System") : L("卷", "Volume");
          var nameTxt = v.name ? (v.role === "other" ? v.name : role + " " + v.name) : role;   // v369：other 角色裸卷名（「卷 Data」是噪音，设计稿只显 Data）
          var isFollower = v.container && seenC[v.container];   // 同容器第二行起不重复容量（容器统计同源，两行相同数值会误导「磁盘翻倍」）
          var badge = (v.container && !isFollower) ? '<i class="zu-sys-vbadge">' + L("APFS 共享", "APFS shared") + "</i>" : "";   // 徽记只挂首行（review C2：次行已有「共享容器空间」说明，双徽记冗余）
          if (v.container && !seenC[v.container]) seenC[v.container] = 1;
          s += '<div class="zu-sys-vr' + (isCur ? " zu-sys-vrowon" : "") + '" role="row"' +
            ' title="' + sAttr(nameTxt + (v.mount ? " · " + v.mount : "") + (v.container ? " · APFS " + L("与同容器卷共享空间", "shares container space") : "")) + '">' +
            '<span role="cell"><span class="zu-sys-vname">' + sEsc(nameTxt) + badge + '</span><span class="zu-sys-vmount">' + sEsc(v.mount || "") + "</span></span>";
          if (isFollower) {
            s += '<span class="zu-sys-vshare" role="cell">' + L("共享容器空间", "shares container") + "</span></div>";
          } else {
            s += "<span>" + (typeof v.total === "number" ? sysFmtBytes(v.total) : "—") + "</span>" +
              "<span>" + (typeof v.used === "number" ? sysFmtBytes(v.used) : "—") + "</span>" +
              "<span>" + (typeof v.avail === "number" ? sysFmtBytes(v.avail) : "—") + "</span></div>";
          }
        });
        s += "</div>";
      } else {
        s += '<span class="zu-sys-dim">' + secNote(disk) + "</span></div>";
      }
      s += "</div>";
    }
    /* 图例（v362 精简）：三色点一行 + ⓘ 阈值说明（明细收进展开区，动态读 cfg）。
     * warnColors 关：点转中性灰并注明，避免误以为仍会变色；当前综合档文字提亮。 */
    s += '<div class="zu-sys-legend' + (cfg.warnColors ? "" : " nocolor") + '">' +
      "<span><i class=\"zu-sys-dot\"></i>" + L("正常", "OK") + "</span>" +
      '<span' + (sev.overall === "warning" ? ' class="zu-sys-lg-on"' : "") + '><i class="zu-sys-dot zu-sys-dot-w"></i>' + L("预警", "Warn") + "</span>" +
      '<span' + (sev.overall === "critical" ? ' class="zu-sys-lg-on"' : "") + '><i class="zu-sys-dot zu-sys-dot-c"></i>' + L("危险", "Crit") + "</span>" +
      (cfg.warnColors ? "" : '<span class="zu-sys-lg-off">' + L("颜色提示已关闭", "Color hints off") + "</span>") +
      '<button type="button" class="zu-sys-thbtn" data-zu-sys-th aria-expanded="false" title="' +
      sAttr(L("查看预警/危险阈值", "View warn/crit thresholds")) + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2.9-1.2 1.8"/><path d="M12 16.8h.01"/></svg>' +
      L("阈值", "Thresholds") + '</button></div>' +
      '<div class="zu-sys-thexp" data-zu-sys-thexp hidden>' + sysThresholdTableHtml(cfg) + "</div>";
    if (stale && frame) s += '<div class="zu-sys-note">' + L("数据已过期 · 采样暂停中", "Data stale · sampling paused") + "</div>";
    return s + "</div>";
  }
  function sysmonWantRecalc(force) {
    var want = false, projectPath = "";
    for (var i = 0; i < instances.length; i++) {
      try {
        var r = instances[i] && instances[i].sysmonInterested && instances[i].sysmonInterested();
        if (r && r.want) {
          want = true;
          if (!projectPath && r.projectPath) projectPath = r.projectPath;
        }
      } catch (e) { }
    }
    var sig;
    try { sig = (want ? 1 : 0) + "|" + JSON.stringify(state.sysmonCfg) + "|" + projectPath; } catch (e) { return; }
    if (!force && sig === sysmonSubSent) return;
    sysmonSubSent = sig;
    if (typeof pluginRequest === "function" && !stale()) {
      pluginRequest("sysmon-sub", { want: want, cfg: state.sysmonCfg, projectPath: projectPath });
    }
  }

  var state = {
    show: { win: 1, turn: 1, today: 1, sub: 1, tools: 1, git: 1, proj: 1, subRate: 1, wfChip: 1, sysmon: 0 },   // git：工具行 Git 状态 chip（v96，默认开）；proj：项目累计格（v159，默认开；与 zusage3.projPath 弹窗路径开关无关）；subRate：Agent 行内子代理速率 chip（v178，默认开；只门控行内展示，槽位估算与主 chip 合计不受影响）；wfChip：工作流 run 卡汇总 chip（v332，默认开；specs/workflow-support.md）；sysmon：系统状态格（v356，issue #338，默认关——保持状态栏精简，排序卡里打开）
    ctxOv: "", data: null,
    lang: "zh", theme: "default", pluginUpdate: window.__zusagePluginState || null,
    /* v226 默认样式水平对齐：between|start|end（均分/居左/居右），仅默认档生效；药丸恒 flex-start */
    barJust: "between",
    barOrder: ZU_BAR_KEYS.slice(),
    barPriority: zuBarPriorityNormalize(null),
    /* v356 系统状态配置（刷新/格式/磁盘目标/阈值）：独立可校验模型，定向持久化
     * zusage3.sysmonCfg（不搭全量 persist），storage 跨窗同步见 06 分片监听器。 */
    sysmonCfg: normalizeSysmonCfg(null),
    /* 万/亿单位开关：缺省开启，仅显式 "0" 关闭；只在中文界面展示并生效（英文始终 K/M/B） */
    cnNum: 1,
    /* v136 编辑项目弹窗完整路径开关：缺省开启，仅显式 "0" 关闭；纯展示偏好存 localStorage */
    projPath: 1,
    /* v156 原生上下文按钮增强开关（环填充/档位色/百分比）：缺省开启，仅显式 "0" 关闭；
       纯渲染端展示偏好存 localStorage，不涉及主进程查询；重置卡徽标不受此开关影响 */
    ctxEnh: 1,
    /* v200 「上下文容量」弹层内「压缩上下文」按钮开关（issue #174）：缺省开启，仅显式
       "0" 关闭；纯渲染端展示偏好存 localStorage；自动压缩阈值行不受影响（v179 独立开关） */
    ctxCpt: 1,
    /* v202 预估费用行开关：缺省开启，仅显式 "0" 关闭；纯渲染端展示偏好存 localStorage，
       只门控四格 tooltip 与模型明细/紧凑摘要里的费用行（计算与同步在 zusage.py 侧） */
    cost: 1,
    /* v146 宿主命令中心（⌘K 搜索弹框）加宽开关：缺省开启，仅显式 "0" 关闭；纯展示偏好存 localStorage */
    cmdkW: 1,
    /* v173 强制 K/M/B 单位：缺省关闭，仅显式 "1" 开启；开启后 token 数量（条面/tooltip/
       回答末尾统计行）一律 K/M/B，不受界面语言与「中文单位」开关影响；独立持久化 */
    forceKmb: 0,
    /* v249 悬浮窗口激活方式：缺省关=悬停立即显示（v246 原语义），仅显式 "1" 开启「点击
       激活」；纯渲染端展示偏好存 localStorage，不进 config.json、不涉及主进程。常被滑过
       误触的用户可开开关，点击才打开统计卡/子代理面板（issue 用户反馈）。 */
    tipClick: 0,
    devKeepTip: 0,
    /* v251 套餐额度显示口径：缺省关=已用%（v96 起原语义），仅显式 "1" 开启「剩余额度」
       （剩余%=100−已用%，同一窗口池补数）；chip 面与 tooltip 窗口行/Key 总额度行/其他源
       摘要行跟随，档位色恒按已用原始值判定（quota.md 契约）；纯渲染端展示偏好存 localStorage */
    quotaRemain: 0,
    /* v99 设置面板当前分区（非法值在 buildPanel 回退首分区，不在这里校验） */
    settingsSec: "display",
    /* 逐问速率行开关：真值在运行时 config.json 的 answer_rate_line（主进程随插件状态推送
       rateLine 字段），渲染端只做展示与请求转发；缺省开启 */
    rateLine: !(window.__zusagePluginState && window.__zusagePluginState.rateLine === false),
    /* 套餐额度开关：真值在 config.json 的 quota_enabled（主进程据此决定是否解密凭据
       联网查询，并随插件状态推送 quotaEnabled）；缺省开启，仅显式 false 关闭（v111） */
    quotaEnabled: !(window.__zusagePluginState && window.__zusagePluginState.quotaEnabled === false),
    /* v344 增强提示词按钮开关：真值在 config.json 的 enhance_enabled（主进程动作入口
       fail-closed 校验，并随插件状态推送 enhanceEnabled）；缺省开启，仅显式 false 关闭 */
    enhanceEnabled: !(window.__zusagePluginState && window.__zusagePluginState.enhanceEnabled === false),
    /* 移动端推送只认主进程配置与能力的显式 true，缺字段的旧 loader 保持关闭；
       pending 仅保存本窗口各 pane 共享的待确认勾选，不进 localStorage。 */
    mobileRelayEnabled: !!(window.__zusagePluginState && window.__zusagePluginState.mobileRelayEnabled === true),
    mobileRelaySupported: !!(window.__zusagePluginState && window.__zusagePluginState.mobileRelaySupported === true),
    mobileRelayPending: null,
    /* v135 重置卡徽标开关：真值在 config.json 的 reset_badge_enabled（主进程推送
       resetBadgeEnabled）；独立于 quota_enabled（额度关时仍查询 reset/status）。缺省开启 */
    resetBadge: !(window.__zusagePluginState && window.__zusagePluginState.resetBadgeEnabled === false),
    /* v159 重启提醒开关（issue #139）：真值在 config.json 的 restart_notice（主进程推送
       restartNotice）；只静默会话内提醒条，CLI 与故障提示不受控。缺省开启 */
    restartNotice: !(window.__zusagePluginState && window.__zusagePluginState.restartNotice === false),
    /* v179 自动压缩阈值注入：真值由主进程推送 enginePatch（补丁状态+阈值配置）；
       null=主进程补丁模块未加载（旧主进程，需完全重启） */
    enginePatch: (window.__zusagePluginState && window.__zusagePluginState.enginePatch) || null,
    /* 重置卡倒计时阈值（小时）：剩余时间短于该值才在徽标上显示倒计时；纯展示偏好存 localStorage */
    resetCdh: 24,
    /* 阶段 3 多源配置列表（id/label/enabled/keyConfigured/status...，主进程 sourcesConfig 推送） */
    quotaSources: (window.__zusagePluginState && Array.isArray(window.__zusagePluginState.quotaSources)
      ? window.__zusagePluginState.quotaSources : []),
  };
  /* ---------- i18n（v57）：L(中文, English) 内联双语文案，语言存 localStorage ---------- */
  function L(zh, en) { return state.lang === "en" ? en : zh; }
  /* 万/亿单位是否生效：状态条 fmt()、占位统计行与 turn-text 请求共用同一判定 */
  function cnUnits() { return state.lang !== "en" && !!state.cnNum; }
  function ls(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  /* v136 项目完整路径开关（纯展示）：CSS 规则在条样式表内，由 <html> 的 data-zusage-pp
   * 门控——属性一写全文档即时生效/摘除，多实例共享同一属性天然一致；开关关闭或插件整体
   * 移除后属性没有样式引用即无作用，不需要 dispose 清理。 */
  function applyProjPath() {
    try {
      if (state.projPath) document.documentElement.setAttribute("data-zusage-pp", "1");
      else document.documentElement.removeAttribute("data-zusage-pp");
    } catch (e) { }
  }
  /* v146 命令中心加宽开关（纯展示）：与 v136 同款 <html> 属性门控——CSS 规则在条样式表
   * 内由 data-zusage-cmdk 开关，属性一写全文档即时生效/摘除，多实例共享同一属性天然
   * 一致，无 DOM 注入与 dispose 负担。 */
  function applyCmdkW() {
    try {
      if (state.cmdkW) document.documentElement.setAttribute("data-zusage-cmdk", "1");
      else document.documentElement.removeAttribute("data-zusage-cmdk");
    } catch (e) { }
  }
  /* v137 点击源文件夹行 → 系统文件管理器打开该目录（mac Finder / Windows 资源管理器）：
   * 主通道 window.zcode.openInFileManager（客户端主进程 Windows shell.openPath、macOS
   * open <dir> 带 -a Finder 与 shell.openPath 双回退，raw path 免 URL 编码）；旧主进程
   * 依次降级 openExternalFile、openExternal(file:)（客户端白名单放行 file:，落到同一个
   * shell.openPath）。远程项目的编辑器带「在此设备上寻找已有项目」提示（testid
   * virtual-project-existing 仅 remote 渲染），据此排除——远端路径在本机资源管理器无意义；
   * fixedFolder 行（break-all）本就不在增强选择器内。多个 pane 实例会对同一次点击重复
   * 委托，500ms 同路径去重。 */
  function projFileUrl(p) {
    var norm = String(p).replace(/\\/g, "/");
    if (/^\/\//.test(norm)) return "file:" + norm.split("/").map(encodeURIComponent).join("/");
    return "file:///" + norm.replace(/^\/+/, "").split("/").map(function (s) {
      return /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s);   // 盘符冒号不编码（file:///C:/…）
    }).join("/");
  }
  function openProjFolder(p) {
    try {
      var zc = window.zcode;
      /* openInFileManager/openExternalFile 是 ipcRenderer.invoke：旧主进程无 handler 时
       * 异步 reject 成 unhandled rejection，挂空 catch 静默（openExternal 是 send 无此问题） */
      if (zc && typeof zc.openInFileManager === "function") { var r1 = zc.openInFileManager(p); if (r1 && typeof r1.catch === "function") r1.catch(function () { }); return; }
      if (zc && typeof zc.openExternalFile === "function") { var r2 = zc.openExternalFile(p); if (r2 && typeof r2.catch === "function") r2.catch(function () { }); return; }
      if (zc && typeof zc.openExternal === "function") zc.openExternal(projFileUrl(p));
    } catch (e) { }
  }
  var projOpenAt = 0, projOpenPath = "";
  function onProjRowClick(e) {
    if (!state.projPath || e.button) return;
    var el = e.target && e.target.closest ? e.target.closest('[data-testid=virtual-project-root-name].truncate') : null;
    if (!el || !el.getAttribute) return;
    var p = el.getAttribute("title") || "";
    if (!p) return;
    try {
      if (document.querySelector('[data-testid=virtual-project-existing]')) return;
    } catch (e2) { }
    var now = Date.now();
    if (p === projOpenPath && now - projOpenAt < 500) return;
    projOpenAt = now;
    projOpenPath = p;
    openProjFolder(p);
  }
  try {
    var s0 = JSON.parse(ls(LS.show, "null"));
    if (s0 && typeof s0 === "object") {
      for (var k0 in state.show) if (k0 in s0) state.show[k0] = s0[k0] ? 1 : 0;
    }
    try { state.barOrder = zuBarOrderNormalize(JSON.parse(ls(LS.barOrder, "null"))); } catch (eOrder) { state.barOrder = ZU_BAR_KEYS.slice(); }
    try { state.barPriority = zuBarPriorityNormalize(JSON.parse(ls(LS.barPriority, "null"))); } catch (ePriority) { state.barPriority = zuBarPriorityNormalize(null); }
    state.sysmonCfg = loadSysmonCfg();   // v356：损坏/缺字段经归一化回缺省，不重建对象引用
    state.ctxOv = ls(LS.ctxOv, "");
    if (ls(LS.lang, "") === "en") state.lang = "en";
    if (ls(LS.cnNum, "") === "0") state.cnNum = 0;
    if (ls(LS.projPath, "") === "0") state.projPath = 0;
    if (ls(LS.ctxEnh, "") === "0") state.ctxEnh = 0;
    if (ls(LS.ctxCpt, "") === "0") state.ctxCpt = 0;
    if (ls(LS.cost, "") === "0") state.cost = 0;
    if (ls(LS.cmdkW, "") === "0") state.cmdkW = 0;
    if (ls(LS.forceKmb, "") === "1") state.forceKmb = 1;
    if (ls(LS.tipClick, "") === "1") state.tipClick = 1;
    if (ls(LS.devKeepTip, "") === "1") state.devKeepTip = 1;
    if (ls(LS.quotaRemain, "") === "1") state.quotaRemain = 1;
    var cdh0 = parseInt(ls(LS.rstCdh, ""), 10);
    if (cdh0 >= 1 && cdh0 <= 24 * 7) state.resetCdh = cdh0;
    var s1 = ls(LS.sec, "");
    if (s1) state.settingsSec = s1;
  } catch (e) { }
  var theme0 = ls(LS.theme, "");
  if (theme0 === "pill" || theme0 === "compact") state.theme = theme0;   // v146：精简为第三档（隐藏条、信息上工具行）
  var just0 = ls(LS.barJust, "");
  if (just0 === "start" || just0 === "end") state.barJust = just0;   // v226：非法值回退 between（基线 space-between）
  applyProjPath();   // v136：初载即按开关挂 <html> 属性（样式随首实例出现，属性先行无作用）
  applyCmdkW();   // v146：同款初载挂属性
  function persist() {
    lsSet(LS.show, JSON.stringify(state.show));
    lsSet(LS.ctxOv, state.ctxOv);
    lsSet(LS.lang, state.lang);
    lsSet(LS.cnNum, state.cnNum ? "1" : "0");
    lsSet(LS.projPath, state.projPath ? "1" : "0");
    lsSet(LS.ctxEnh, state.ctxEnh ? "1" : "0");
    lsSet(LS.ctxCpt, state.ctxCpt ? "1" : "0");
    lsSet(LS.cost, state.cost ? "1" : "0");
    lsSet(LS.cmdkW, state.cmdkW ? "1" : "0");
    lsSet(LS.tipClick, state.tipClick ? "1" : "0");
    lsSet(LS.quotaRemain, state.quotaRemain ? "1" : "0");
    lsSet(LS.devKeepTip, state.devKeepTip ? "1" : "0");
    lsSet(LS.rstCdh, String(state.resetCdh));
    lsSet(LS.sec, state.settingsSec);
  }
  /* 排序/优先级走定向写、不搭车全量 persist()：窗口 A 改排序、窗口 B 改其它设置时，
   * B 的 persist() 不得用自己陈旧的内存布局覆盖 A 刚写入的值（跨窗口互覆，review P1；
   * 配套：12 分片 storage 监听对两键做归一化回读同步）。 */
  function persistBarOrder() { lsSet(LS.barOrder, JSON.stringify(state.barOrder)); }
  function persistBarPriority() { lsSet(LS.barPriority, JSON.stringify(state.barPriority)); }

  /* ---------- 多实例注册表（v61.1）：每个分屏 pane 一个条实例 ---------- */
  var instances = [];   // spawnInstance 返回的 api：{pid, attach, render, ...}
  var nextSlot = 0;     // 实例序号；0 号保留兼容 id（#zusage-bar，泵热更新按它清理）
  /* v268：粘性升级 window 级跨代际——热重载/重启后新实例直接继承上一代轮表。
   * v255 的代际内粘性在新代际首帧恰逢 serve 空闲回收/重启窗口（帧缺 speed_history）时
   * 为空，速度 Tooltip 闪回旧版整卡（用户实报「现在变成老版本了」；本地 json 链实测
   * 1268 轮/197 会话产出正常，serve pid 数分钟内 8576→11362 证实频繁回收重启）。
   * 轮表是历史统计，分钟级陈旧可接受（v257 同取舍），下一帧成功即覆盖。 */
  var lastSpeedHistory = (typeof window !== "undefined" && window.__zusageSpdSticky) || null;
  if (mobileMode) lastSpeedHistory = null;
  /* v384：speed_days（全历史日桶）同款粘性——旧 Python/serve 重启窗口缺帧时兜底，
   * 语义与轮表粘性一致（历史统计分钟级陈旧可接受），下一帧成功即覆盖。逐帧独立
   * 捕获/回填（M3/S10：不挂在缺轮表分支，否则正常帧永不更新）。 */
  var lastSpeedDays = (typeof window !== "undefined" && window.__zusageSpdDaysSticky) || null;
  if (mobileMode) lastSpeedDays = null;
  /* 受管 worktree 会话事实（specs/worktree-branch.md）：sid → {cwd, root, bucket, name, ref, sha}。
   * 快照桌面链字段，进程生命周期内不可变（cwd 创建后固定、ref/sha 落库后不变），不粘性回填——
   * 缺帧沿用自己的上一份；publishGitPaths/gitChipView 用 cwd 覆写 Git chip 的查询与显示路径。 */
  var lastWorktrees = (typeof window !== "undefined" && window.__zusageWorktrees) || null;
  if (mobileMode) lastWorktrees = null;
  function renderAll(rebuildPanels) {
    if (rateTipFor) showRateTip(rateTipFor);
    for (var i = 0; i < instances.length; i++) {
      if (rebuildPanels) instances[i].rebuild();   // 语言切换等文案重建（各实例面板独立 DOM）
      if (state.data) instances[i].render(state.data);
    }
  }
  function setBarTheme(theme) {
    state.theme = theme === "pill" ? "pill" : theme === "compact" ? "compact" : "default";   // v146：+精简档
    lsSet(LS.theme, state.theme);
    for (var i = 0; i < instances.length; i++) instances[i].applyBarTheme();
  }
  /* v226 六格显示开关（本轮/会话累计/项目累计/工具调用/今日合计/子代理）全部关闭时自动转精简：
   * 边缘触发（只在「变得全关」那一拍切档，手动改回默认不立即翻回）；zusage3.autoCompact 记录
   * 来源主题（default|pill），重开任一格即恢复；用户在面板手动改档即清标记解除自动干预 */
  var SHOW_CELLS = ["turn", "win", "proj", "tools", "today", "sub"];
  function cellsAllOff() {
    for (var i = 0; i < SHOW_CELLS.length; i++) if (state.show[SHOW_CELLS[i]]) return false;
    return true;
  }
  function autoCompactOnShow(k, on) {
    if (SHOW_CELLS.indexOf(k) < 0) return;   // git/subRate 不在条面，不参与判定
    var from = ls(LS.autoCompact, "");
    if (!on && cellsAllOff() && (state.theme === "default" || state.theme === "pill")) {
      lsSet(LS.autoCompact, state.theme);
      setBarTheme("compact");
    } else if (on && state.theme === "compact" && (from === "default" || from === "pill")) {
      lsSet(LS.autoCompact, "");
      setBarTheme(from);   // 恢复进入精简前的样式（默认或药丸）
    } else if (on && from && state.theme !== "compact") {
      lsSet(LS.autoCompact, "");   // 残留标记防御清理（主题已被手动改走）
    }
  }
  /* v226 默认样式水平对齐：between 即基线 space-between（不挂类），start/end 挂类改分布 */
  function setBarJust(v) {
    state.barJust = v === "start" || v === "end" ? v : "between";
    lsSet(LS.barJust, state.barJust);
    for (var j = 0; j < instances.length; j++) instances[j].applyBarTheme();
  }
  var remoteCache = {};
  var remoteTodayCache = {};
  /* 小容量缓存写入：超限按插入序淘汰最旧键（长会话/多目标防无界增长，2026-10-24 审计） */
  function capPut(map, key, val, cap) {
    map[key] = val;
    var ks = Object.keys(map);
    if (ks.length > cap) delete map[ks[0]];
  }
  /* v84（issue #30）：渲染端当下读到的主叶工作台归属（refreshWants 每轮刷新）。泵推送的
   * scope_bindings 取自上一轮收集，主叶身份刚切换/撤销时旧绑定可能随迟到的远端响应到达；
   * sessionFor 以此做守卫，不让旧代际绑定重新点亮远端视图。 */
  var mainScopeNow = { sid: "", identity: "" };
  /* 移动帧已经由中继按目标裁剪；不经桌面 scope/最近会话启发式再猜一次归属。 */
  function mobileContext(d, sid) {
    var m = d && d.mobile, out = { taskId: "", binding: "", scopeKind: "", state: "waiting", row: null };
    if (!m || typeof m !== "object" || Array.isArray(m)) return out;
    var id = /^[A-Za-z0-9_-]{1,128}$/;
    out.taskId = typeof m.taskId === "string" && id.test(m.taskId) ? m.taskId : "";
    out.binding = typeof m.binding === "string" && id.test(m.binding) ? m.binding : "";
    out.scopeKind = m.scopeKind === "local" || m.scopeKind === "remote" ? m.scopeKind : "";
    out.state = ["ready", "waiting", "unavailable", "upgrade"].indexOf(m.state) >= 0 ? m.state : "unavailable";
    if (sid && sid !== out.taskId) { out.state = "waiting"; return out; }
    if (out.state !== "ready") return out;
    var rows = d.recent, row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (d.error || !out.taskId || !out.binding || !out.scopeKind || d.mine !== out.taskId ||
        !d.session || d.session.sid !== out.taskId || !row || row.sid !== out.taskId ||
        row.workspace_identity !== undefined || row.remote_target !== undefined ||
        (out.scopeKind === "remote" ? row.remote !== true : !!row.remote) || row.remote_error || row.remote_missing) {
      out.state = "unavailable";
      return out;
    }
    out.row = row;
    return out;
  }
  function sessionFor(d, sid, pid) {
    var binding = d.scope_bindings || {};
    // 空 identity 是显式本地绑定；真实 pane 缺绑定时也不能继承同 sid 的远端。
    var identity = Object.prototype.hasOwnProperty.call(binding, pid) ? binding[pid]
      : (pid === "auto" && Object.prototype.hasOwnProperty.call(binding, sid) ? binding[sid] : "");
    var current;
    if (pid !== "auto") {
      current = window.__zusagePaneScopes && window.__zusagePaneScopes[pid];
      var instanceScope;
      for (var n = 0; n < instances.length; n++) {
        if (instances[n].pid !== pid || !instances[n].getScope) continue;
        var scope = instances[n].getScope();
        instanceScope = scope;
        current = scope || { sid: sid };
        break;
      }
      if (String(pid).indexOf("selection-side-chat:") === 0 &&
          (!instanceScope || instanceScope.sid !== sid || instanceScope.identity !== "" || instanceScope.remoteSessionId !== "")) return null;
      if (current) {
        /* issue #40：无桥的客户端 refreshWants 只写 {sid}（拿不到身份），泵对同一
         * pane 只能查本地；但只有本窗完全没有远端证据（remote_evidence === false）
         * 才按本地身份匹配，否则本地会话仍会被误杀或误亮。泵绑定非空（远端）而渲染
         * 端看不到身份时保持 fail-closed，不借同 sid 的本地快照。 */
        var hasIdentity = Object.prototype.hasOwnProperty.call(current, "identity");
        var currentIdentity = hasIdentity ? current.identity : "";
        if (current.sid !== sid || currentIdentity !== identity) return null;
        if (!hasIdentity && d.remote_evidence !== false) return null;
      }
    }
    if (!current && pid === "workspace-main" && typeof mainScopeNow !== "undefined" && mainScopeNow && mainScopeNow.known === false) return null;
    /* v84（issue #30）主叶迟到载荷守卫。typeof 兼容测试夹具按源码片段抽取运行（无模块级声明）：
     * 夹具里 mainScopeNow 由 refreshWants 赋值成为全局；生产环境恒有模块级声明。 */
    if (!current && pid === "workspace-main" && identity &&
        (typeof mainScopeNow === "undefined" || !mainScopeNow ||
         mainScopeNow.sid !== sid || mainScopeNow.identity !== identity)) identity = "";
    var recent = d.recent || [], found = null;
    for (var i = 0; i < recent.length; i++) {
      var r = recent[i];
      if (r.sid === sid && (r.workspace_identity || "") === identity) { found = r; break; }
    }
    if (!identity) return found;
    var target = found && found.remote_target || "";
    var key = JSON.stringify([sid, identity, target]);
    if (found && found.remote && !found.remote_error && !found.remote_missing) {
      if (target) {
        remoteCache[key] = found;   // 上限淘汰最旧键（切片测试纪律：本函数不自引用区间外符号）
        var rks = Object.keys(remoteCache);
        if (rks.length > 64) delete remoteCache[rks[0]];
      }
      return found;
    }
    // 只复用同目标的成功快照；identity 改指其它目标或目标未知时不能继承旧源数据。
    if (target && remoteCache[key]) return Object.assign({}, remoteCache[key], {
      remote_error: (found && found.remote_error) || "remote data unavailable; showing last successful snapshot",
      remote_missing: true, remote_stale: true,
    });
    return found || { sid: sid, workspace_identity: identity, remote: true, remote_missing: true };
  }
  window.__zusageUpdate = function (d) {
    var isMobile = typeof mobileMode !== "undefined" && mobileMode;
    if (stale() || !d || (d.error && !isMobile)) return;
    /* 移动帧按 target/binding/scopeKind 隔离：换目标时清远端缓存，不复用上一目标的快照。
     * 轮表在移动启动时已置空且移动路径不会写入（setter 受 !isMobile 守卫），无需逐帧清。 */
    if (isMobile) {
      var mc = mobileContext(d, ""), keyMobile = JSON.stringify([mc.taskId, mc.binding, mc.scopeKind]);
      if (keyMobile !== mobileBinding) {
        mobileBinding = keyMobile;
        Object.keys(remoteCache).forEach(function (k) { delete remoteCache[k]; });
        Object.keys(remoteTodayCache).forEach(function (k) { delete remoteTodayCache[k]; });
      }
      FATAL.spdFrame = { t: Date.now(), has: mc.row && d.speed_history ? 1 : 0, sticky: 0, turns: 0 };
    }
    /* v384（M3/S10 修复）：speed_days 粘性逐帧独立执行，不再挂在「缺轮表」分支——
     * 正常帧恒有 speed_history，原位会让捕获/回填在主路径死代码化（speed_days 单独
     * 瞬时失败时既不回填也不更新）。语义：新帧有 days 即捕获+写 window；缺 days
     * （None）回填粘性；days 在场但空/畸形不粘不回填（与轮表空帧不粘同口径）。 */
    if (!isMobile) {
      if (d.speed_days && d.speed_days.days && d.speed_days.days.length) {
        lastSpeedDays = d.speed_days;
        try { window.__zusageSpdDaysSticky = lastSpeedDays; } catch (_) { }
      } else if (!d.speed_days && typeof lastSpeedDays !== "undefined" && lastSpeedDays) {
        d.speed_days = lastSpeedDays;
      }
    }
    /* v255：粘性统一轮表。常驻 serve 重启/空闲回收时主进程会回退到一次性 json，
     * 那一帧可能缺 speed_history；沿用本代最近一份有界轮表，速度 Tooltip 不再
     * 在 V2 与旧版整卡之间闪回。首帧尚无轮表（旧 Python/查询失败）才回退旧布局。 */
    if (!isMobile && d.speed_history && d.speed_history.turns && d.speed_history.turns.length) {
      lastSpeedHistory = d.speed_history;
      try { window.__zusageSpdSticky = lastSpeedHistory; } catch (_) { }
      /* v257 帧级诊断 + v384 sd 分量：has/sticky/turns=轮表链，sd=本帧（含粘性回填后）
       * speed_days 在场与否——M3/S10 修复前该链无诊断分量，分支错位不可见。 */
      FATAL.spdFrame = { t: Date.now(), has: 1, sticky: 0, turns: d.speed_history.turns.length,
        sd: d.speed_days ? 1 : 0 };
    } else if (!isMobile) {
      var stickyHit = !d.speed_history && typeof lastSpeedHistory !== "undefined" && lastSpeedHistory;
      if (stickyHit) d.speed_history = lastSpeedHistory;
      /* v257 帧级诊断：缺字段/None 帧记 0，粘性补帧记 1——再出现象时 diag 直接可定位是
       * 数据链缺帧还是粘性未建立，不再靠截图反推。原地更新不替换对象（FATAL 共享引用）。 */
      FATAL.spdFrame = { t: Date.now(), has: 0, sticky: stickyHit ? 1 : 0, turns: 0,
        sd: d.speed_days ? 1 : 0 };
    }
    if (!isMobile && d.remote_today) for (var key in d.remote_today) {
      if (d.remote_today[key] && typeof d.remote_today[key] === "object") {
        remoteTodayCache[key] = d.remote_today[key];
        var tks = Object.keys(remoteTodayCache);
        if (tks.length > 64) delete remoteTodayCache[tks[0]];
      }
    }
    /* 受管 worktree 事实（specs/worktree-branch.md）：先于尾部 render 循环捕获，同帧
     * refreshWants → publishGitPaths 即可用新映射覆写 Git chip 查询路径；缺帧沿用上一份。 */
    if (!isMobile && d.worktrees && typeof d.worktrees === "object") {
      lastWorktrees = d.worktrees;
      try { window.__zusageWorktrees = d.worktrees; } catch (_) { }
    }
    state.data = d;
    for (var i = 0; i < instances.length; i++) {
      try { instances[i].render(d); } catch (e) { FATAL.updateErr = String((e && e.stack) || e); }
    }
  };
  window.__zusageSysmon = function (frame) {
    /* v356 系统状态帧入口（主进程 sysmon-client 推送，pushOnce 同款信任门）：更新共享帧 +
     * 逐实例原地刷新格面/tooltip（不整条 render，5s 节奏远轻于泵帧）。旧冷主进程不推帧：
     * 格渲染 loading 态（—），无轮询无报错，字段缺失是常态不是错误。 */
    if (stale() || !frame || typeof frame !== "object" || !frame.cpu || !frame.mem || !frame.disk) return;
    sysFrame = frame;
    sysSevSnapshot = sysSeveritySmoothed(state.sysmonCfg, frame);   // 每采样拍推进一次防抖（消费端只读快照）
    var f = FATAL.sysFrame || (FATAL.sysFrame = { t: 0, has: 0, want: 0 });
    f.t = Date.now();
    f.has = 1;
    f.want = (typeof sysmonSubSent === "string" && sysmonSubSent.charAt(0) === "1") ? 1 : 0;   // v356 review：want 分量写实（订阅意愿签名首位）
    for (var i = 0; i < instances.length; i++) {
      try { if (instances[i].sysmonTick) instances[i].sysmonTick(); } catch (e) { FATAL.sysTickErr = String((e && e.stack) || e); }
    }
  };
  window.__zusagePluginRequests = [];
  var pluginRequestSeq = 0, pluginRequestCallbacks = {};
  function pluginRequest(action, extra, done) {
    var o = { action: action };
    if (extra !== undefined) {
      if (extra && typeof extra === "object") Object.assign(o, extra);
      else o.enabled = extra;
    }
    if (typeof done === "function") {
      var pending = Object.keys(pluginRequestCallbacks);
      if (pending.length >= 32) delete pluginRequestCallbacks[pending[0]];
      o.requestId = "zusage-" + MY_GEN + "-" + (++pluginRequestSeq);
      pluginRequestCallbacks[o.requestId] = done;
    }
    window.__zusagePluginRequests.push(o);
    return o.requestId || "";
  }
  function forgetPluginRequest(id) { if (id) delete pluginRequestCallbacks[id]; }
  window.__zusagePluginResult = function (result) {
    if (!result || typeof result.id !== "string") return;
    var done = pluginRequestCallbacks[result.id];
    if (!done) return;
    delete pluginRequestCallbacks[result.id];
    try { done(result); } catch (e) { FATAL.pluginResultErr = "result handler failed"; }
  };
